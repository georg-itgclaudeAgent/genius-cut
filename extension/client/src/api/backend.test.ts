import { describe, it, expect } from "vitest";
import { BackendError, createBackend, type Transport, type TransportRequest } from "./backend";

function fake(status: number, body: unknown) {
  const seen: TransportRequest[] = [];
  const transport: Transport = async (req) => {
    seen.push(req);
    return { status, body: typeof body === "string" ? body : JSON.stringify(body) };
  };
  return { transport, seen };
}

describe("backend client", () => {
  it("sends the bearer token on protected routes, not on /health", async () => {
    const f = fake(200, { status: "ok", version: "0.1.0", stt_device: "cuda" });
    const api = createBackend({ transport: f.transport, token: () => "tok" });
    await api.health();
    await api.library();
    expect(f.seen[0].headers.Authorization).toBeUndefined();
    expect(f.seen[1].headers.Authorization).toBe("Bearer tok");
  });

  it("posts the trim request as JSON", async () => {
    const f = fake(200, { words: [], cuts: [], kept_spans_source: [], kept_spans: [], stt_device: "cuda", cut_fraction: 0, warning: null });
    const api = createBackend({ transport: f.transport, token: () => "tok" });
    await api.trim({ duration_s: 5, range_start_seq_s: 0, audio: [{ media_path: "C:/a.mp4", in_s: 0, offset_s: 0, duration_s: 5 }], prompt: "" });
    expect(f.seen[0]).toMatchObject({ method: "POST", path: "/trim" });
    expect(JSON.parse(f.seen[0].body!)).toMatchObject({ duration_s: 5, audio: [{ media_path: "C:/a.mp4", in_s: 0, offset_s: 0, duration_s: 5 }] });
    expect(f.seen[0].headers["Content-Type"]).toBe("application/json");
  });

  it("passes the agent run's id with a handed-over trim, so its spend is that run's (one run in Usage)", async () => {
    const f = fake(200, { words: [], cuts: [], kept_spans_source: [], kept_spans: [], stt_device: "cuda", cut_fraction: 0, warning: null });
    const api = createBackend({ transport: f.transport, token: () => "tok" });
    const req = { duration_s: 5, range_start_seq_s: 0, audio: [{ media_path: "C:/a.mp4", in_s: 0, offset_s: 0, duration_s: 5 }], prompt: "" };
    await api.trim(req, "run-7");
    await api.trim(req);
    expect(JSON.parse(f.seen[0].body!)).toMatchObject({ ...req, run_id: "run-7" });
    expect(JSON.parse(f.seen[1].body!)).not.toHaveProperty("run_id");
  });

  it("turns the backend's error detail into a readable message with the status", async () => {
    const api = createBackend({
      transport: fake(502, { detail: "Anthropic API error 400: Your credit balance is too low." }).transport,
      token: () => "tok",
    });
    const err = await api.trim({ duration_s: 1, range_start_seq_s: 0, audio: [{ media_path: "x", in_s: 0, offset_s: 0, duration_s: 5 }], prompt: "" }).catch((e) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect(err.status).toBe(502);
    expect(err.message).toContain("credit balance is too low");
  });

  it("the monthly AI limit (402) comes through as the backend's own message", async () => {
    const detail = "This run could cost up to $0.06, and this month's AI spend is $1.97 of the $2.00 limit. " +
      "Raise GENIUSCUT_MONTHLY_LIMIT_USD to continue.";
    const api = createBackend({ transport: fake(402, { detail }).transport, token: () => "tok" });
    const err = await api.trim({ duration_s: 1, range_start_seq_s: 0, audio: [{ media_path: "x", in_s: 0, offset_s: 0, duration_s: 5 }], prompt: "" }).catch((e) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect(err.status).toBe(402);
    expect(err.message).toBe(detail);
  });

  it("validation errors (422 with a list) still read as one sentence", async () => {
    const api = createBackend({
      transport: fake(422, { detail: [{ msg: "Value error, out_s (3.0) must be after in_s (9.0)" }] }).transport,
      token: () => "tok",
    });
    const err = await api.library().catch((e) => e);
    expect(err.message).toContain("out_s (3.0) must be after in_s (9.0)");
  });

  it("a non-JSON failure keeps the status", async () => {
    const api = createBackend({ transport: fake(500, "Internal Server Error").transport, token: () => "tok" });
    const err = await api.library().catch((e) => e);
    expect(err.status).toBe(500);
    expect(err.message).toContain("Internal Server Error");
  });
});

describe("trim timeout", () => {
  it("waits up to 2 hours: a 90-minute clip takes longer than 10 minutes to transcribe", async () => {
    const f = fake(200, {});
    await createBackend({ transport: f.transport, token: () => "tok" })
      .trim({ duration_s: 1, range_start_seq_s: 0, audio: [{ media_path: "a", in_s: 0, offset_s: 0, duration_s: 5 }], prompt: "" });
    expect(f.seen[0].timeoutMs).toBe(2 * 60 * 60_000);
  });
});

describe("transcript jobs (the assistant)", () => {
  it("posts the audio range to /transcript and long-polls GET /transcript/{id}?wait=", async () => {
    const f = fake(200, { id: "j1", status: "running", progress: 0.2 });
    const api = createBackend({ transport: f.transport, token: () => "tok" });
    const req = { duration_s: 5, range_start_seq_s: 100, audio: [{ media_path: "C:/a.mp4", in_s: 0, offset_s: 0, duration_s: 5 }] };
    expect(await api.transcript(req)).toEqual({ id: "j1", status: "running", progress: 0.2 });
    expect(f.seen[0]).toMatchObject({ method: "POST", path: "/transcript" });
    expect(JSON.parse(f.seen[0].body!)).toEqual(req);
    await api.transcriptJob("j1", 60);
    expect(f.seen[1]).toMatchObject({ method: "GET", path: "/transcript/j1?wait=60" });
    expect(f.seen[1].headers.Authorization).toBe("Bearer tok");
    // The long poll holds up to 60 s: the request must outlive it.
    expect(f.seen[1].timeoutMs!).toBeGreaterThan(60_000);
  });
});

describe("setup, settings and usage (the Setup page and Settings)", () => {
  const SRC = { project: "my-proj-1", secret: "ANTHROPIC_API_KEY", version: "latest" };

  it("reads and saves the settings: GET and PUT /settings with the token", async () => {
    const f = fake(200, { anthropic_key: SRC, monthly_limit_usd: 20, setup_complete: true });
    const api = createBackend({ transport: f.transport, token: () => "tok" });
    expect(await api.settings()).toMatchObject({ setup_complete: true });
    await api.saveSettings({ anthropic_key: SRC, monthly_limit_usd: 100, setup_complete: true });
    expect(f.seen[0]).toMatchObject({ method: "GET", path: "/settings" });
    expect(f.seen[1]).toMatchObject({ method: "PUT", path: "/settings" });
    expect(JSON.parse(f.seen[1].body!)).toEqual({ anthropic_key: SRC, monthly_limit_usd: 100, setup_complete: true });
    expect(f.seen.every((r) => r.headers.Authorization === "Bearer tok")).toBe(true);
  });

  it("tests a key source: POST /settings/test-key {anthropic_key}, allowing for gcloud and one Anthropic call", async () => {
    const f = fake(200, { ok: true, message: "Connected" });
    const api = createBackend({ transport: f.transport, token: () => "tok" });
    expect(await api.testKey(SRC)).toEqual({ ok: true, message: "Connected" });
    expect(f.seen[0]).toMatchObject({ method: "POST", path: "/settings/test-key" });
    expect(JSON.parse(f.seen[0].body!)).toEqual({ anthropic_key: SRC });
    expect(f.seen[0].timeoutMs!).toBeGreaterThanOrEqual(120_000);
  });

  it("calls the gcloud setup routes, with the project and secret escaped in the query", async () => {
    const f = fake(200, {});
    const api = createBackend({ transport: f.transport, token: () => "tok" });
    await api.gcloud();
    await api.startLogin();
    await api.loginStatus();
    await api.projects();
    await api.secrets("my-proj-1");
    await api.versions("my-proj-1", "A&B");
    expect(f.seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /setup/gcloud", "POST /setup/login", "GET /setup/login", "GET /setup/projects",
      "GET /setup/secrets?project=my-proj-1", "GET /setup/versions?project=my-proj-1&secret=A%26B"]);
    expect(f.seen.every((r) => r.headers.Authorization === "Bearer tok")).toBe(true);
    // gcloud can take a while (it has a 60 s timeout on the backend).
    expect(f.seen[3].timeoutMs!).toBeGreaterThan(60_000);
  });

  it("reads the month's usage: GET /usage", async () => {
    const f = fake(200, { month_usd: 1, limit_usd: 20, limit_tier: 20, resets_on: "2026-11-01", run_count: 0, runs: [] });
    const api = createBackend({ transport: f.transport, token: () => "tok" });
    expect(await api.usage()).toMatchObject({ resets_on: "2026-11-01" });
    expect(f.seen[0]).toMatchObject({ method: "GET", path: "/usage" });
  });
});

describe("agent runs (the in-panel assistant)", () => {
  const STEP = { run_id: "r1", state: "plan", tool_calls: [], text: "1. Add a marker", message: null, reason: null,
    cost: { model: "claude-opus-5-5", input_tokens: 1, output_tokens: 1, usd: 0.01, month_usd: 1, limit_usd: 20 } };

  it("starts, posts results, approves and cancels a run, each step allowed 5 minutes", async () => {
    const f = fake(200, STEP);
    const api = createBackend({ transport: f.transport, token: () => "tok" });
    expect(await api.agentStart({ instruction: "add a marker", selection: { clipIds: ["V1@0#n"] }, sequence: { sequenceId: "s" } })).toEqual(STEP);
    await api.agentResults("r1", [{ tool_use_id: "t1", content: "{}", is_error: false }]);
    await api.agentApprove("r1");
    await api.agentCancel("r/1");
    expect(f.seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /agent/runs", "POST /agent/runs/r1/results", "POST /agent/runs/r1/approve", "DELETE /agent/runs/r%2F1"]);
    expect(JSON.parse(f.seen[0].body!)).toEqual({ instruction: "add a marker", selection: { clipIds: ["V1@0#n"] }, sequence: { sequenceId: "s" } });
    expect(JSON.parse(f.seen[1].body!)).toEqual({ results: [{ tool_use_id: "t1", content: "{}", is_error: false }] });
    expect(f.seen.slice(0, 3).every((r) => r.timeoutMs === 5 * 60_000)).toBe(true);
    expect(f.seen.every((r) => r.headers.Authorization === "Bearer tok")).toBe(true);
  });

  it("a lost run is a 404 with the backend's words", async () => {
    const api = createBackend({ transport: fake(404, { detail: "This run was lost; send the instruction again." }).transport, token: () => "tok" });
    const err = await api.agentApprove("gone").catch((e) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect([err.status, err.message]).toEqual([404, "This run was lost; send the instruction again."]);
  });
});
