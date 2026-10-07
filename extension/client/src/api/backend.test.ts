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
    const f = fake(200, { words: [], cuts: [], kept_spans_source: [], stt_device: "cuda", cut_fraction: 0, warning: null });
    const api = createBackend({ transport: f.transport, token: () => "tok" });
    await api.trim({ media_path: "C:/a.mp4", in_s: 0, out_s: 5, clip_start_s: 0, prompt: "" });
    expect(f.seen[0]).toMatchObject({ method: "POST", path: "/trim" });
    expect(JSON.parse(f.seen[0].body!)).toMatchObject({ media_path: "C:/a.mp4", out_s: 5 });
    expect(f.seen[0].headers["Content-Type"]).toBe("application/json");
  });

  it("turns the backend's error detail into a readable message with the status", async () => {
    const api = createBackend({
      transport: fake(502, { detail: "Anthropic API error 400: Your credit balance is too low." }).transport,
      token: () => "tok",
    });
    const err = await api.trim({ media_path: "x", in_s: 0, out_s: 1, clip_start_s: 0, prompt: "" }).catch((e) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect(err.status).toBe(502);
    expect(err.message).toContain("credit balance is too low");
  });

  it("the monthly AI limit (402) comes through as the backend's own message", async () => {
    const detail = "This run could cost up to $0.06, and this month's AI spend is $1.97 of the $2.00 limit. " +
      "Raise GENIUSCUT_MONTHLY_LIMIT_USD to continue.";
    const api = createBackend({ transport: fake(402, { detail }).transport, token: () => "tok" });
    const err = await api.trim({ media_path: "x", in_s: 0, out_s: 1, clip_start_s: 0, prompt: "" }).catch((e) => e);
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
      .trim({ media_path: "a", in_s: 0, out_s: 1, clip_start_s: 0, prompt: "" });
    expect(f.seen[0].timeoutMs).toBe(2 * 60 * 60_000);
  });
});
