import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelPickerView, optionText, switchModel } from "./ModelPicker";
import { modelGardenUrl, runVertexLogin, VertexView } from "./Settings";
import { runStages } from "./CutTab";
import { BackendError, createBackend } from "../api/backend";
import { mockTransport } from "../api/mock";
import type { LoginStatus, ModelEntry, ModelListing } from "../api/types";

const m = (id: string, label: string, provider: ModelEntry["provider"], state: ModelEntry["state"] = "ok", message = "Ready",
  price: ModelEntry["price"] = { input: 4, output: 20 }): ModelEntry => ({
  id, label, provider, state, message, price, usd_per_minute: 0.011,
  group: provider === "anthropic" ? "Claude (Anthropic key)" : provider === "vertex" ? "Claude (Google Cloud)" : "Gemini",
});
const LISTING: ModelListing = {
  selected: "gemini:gemini-3.8-flash",
  models: [
    m("anthropic:claude-opus-5-5", "Claude Opus 5.5 (Anthropic)", "anthropic", "blocked", "Workspace limit reached until 1 Nov"),
    m("vertex:claude-opus-5-5", "Claude Opus 5.5 (Google Cloud)", "vertex", "setup", "Enable in Model Garden"),
    m("vertex:claude-haiku-5-5", "Claude Haiku 5.5 (Google Cloud)", "vertex", "ok", "Enabled", { input: 0.1, output: 0.5 }),
    m("gemini:gemini-3.8-flash", "Gemini 3.8 Flash", "gemini", "ok", "Ready", { input: 0.75, output: 3.75 }),
    m("gemini:gemini-3.1-pro-preview", "Gemini 3.1 Pro", "gemini", "setup", "price unknown", null),
  ],
  vertex: { project: "agent-georg", region: "global", adc: true, quota_project: "agent-georg" },
};
const picker = (l: ModelListing, extra: { busy?: boolean; error?: string | null } = {}) => renderToStaticMarkup(
  <ModelPickerView listing={l} busy={extra.busy ?? false} error={extra.error ?? null} onPick={() => {}} onRefresh={() => {}} />);

describe("the model picker", () => {
  it("names each model with its price per million tokens", () => {
    expect(optionText(LISTING.models[0])).toBe("Claude Opus 5.5 (Anthropic) — $4/$20 per MTok");
    expect(optionText(LISTING.models[2])).toBe("Claude Haiku 5.5 (Google Cloud) — $0.10/$0.50 per MTok");
    expect(optionText(LISTING.models[3])).toBe("Gemini 3.8 Flash — $0.75/$3.75 per MTok");
    expect(optionText(LISTING.models[4])).toBe("Gemini 3.1 Pro — price unknown");
  });

  it("groups the models, selects the saved one, and lists blocked/setup ones greyed (not selectable) with the reason", () => {
    const html = picker(LISTING);
    expect(html).toContain('aria-label="AI model"');
    const groups = [...html.matchAll(/<optgroup label="([^"]+)"/g)].map((g) => g[1]);
    expect(groups).toEqual(["Claude (Anthropic key)", "Claude (Google Cloud)", "Gemini"]);
    expect(html).toMatch(/<option value="gemini:gemini-3.8-flash" selected="">Gemini 3.8 Flash/);
    expect(html).toMatch(/<option value="anthropic:claude-opus-5-5" disabled="">Claude Opus 5.5 \(Anthropic\) — \$4\/\$20 per MTok · Workspace limit reached until 1 Nov/);
    expect(html).toMatch(/<option value="vertex:claude-opus-5-5" disabled="">/);
    expect(html).toMatch(/<option value="vertex:claude-haiku-5-5">/);
    expect(html).toMatch(/<button[^>]*title="Check the models again"[^>]*>↻<\/button>/);
    // the selected model works: no reason line
    expect(html).not.toContain("model-why");
  });

  it("says why when the selected model is blocked", () => {
    const html = picker({ ...LISTING, selected: "anthropic:claude-opus-5-5" });
    expect(html).toMatch(/class="model-why"[^>]*>Claude Opus 5.5 \(Anthropic\): Workspace limit reached until 1 Nov/);
  });

  it("while switching or re-checking the select and refresh wait; an error shows", () => {
    const html = picker(LISTING, { busy: true, error: "No route" });
    expect(html).toMatch(/<select[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>↻<\/button>/);
    expect(html).toContain("No route");
  });

  it("switching saves the model, then re-reads the list and the health (so the cost line follows)", async () => {
    const seen: string[] = [];
    const api = {
      setModel: async (id: string) => { seen.push(`set ${id}`); return {} as any; },
      models: async (refresh?: boolean) => { seen.push(`models ${!!refresh}`); return { ...LISTING, selected: "vertex:claude-haiku-5-5" }; },
    };
    const l = await switchModel(api, "vertex:claude-haiku-5-5", async () => { seen.push("health"); });
    expect(seen).toEqual(["set vertex:claude-haiku-5-5", "models false", "health"]);
    expect(l.selected).toBe("vertex:claude-haiku-5-5");
  });

  it("the run's stages name the selected model", () => {
    expect(runStages("Gemini 3.8 Flash")).toEqual({ plans: "Gemini 3.8 Flash reads the timeline and plans", acts: "Gemini 3.8 Flash makes the changes" });
    expect(runStages(null).plans).toBe("Claude reads the timeline and plans");
  });
});

describe("Settings: Claude via Google Cloud (Vertex)", () => {
  const vertex = (l: ModelListing, extra: { login?: LoginStatus | null; busy?: boolean } = {}) => renderToStaticMarkup(
    <VertexView listing={l} project={l.vertex.project} region={l.vertex.region} login={extra.login ?? null} busy={extra.busy ?? false}
      error={null} saved={false} onProject={() => {}} onRegion={() => {}} onSave={() => {}} onSignIn={() => {}} openUrl={() => {}} />);

  it("shows the sign-in, quota project, project and region, and each Claude model's state with the Model Garden link", () => {
    const html = vertex(LISTING);
    expect(html).toContain("Claude via Google Cloud (Vertex)");
    expect(html).toContain("Signed in (Application Default Credentials)");
    expect(html).toContain("Quota project");
    expect(html).toContain("agent-georg");
    expect(html).toMatch(/aria-label="Vertex project"[^>]*value="agent-georg"|value="agent-georg"[^>]*aria-label="Vertex project"/);
    expect(html).toMatch(/aria-label="Vertex region"[^>]*value="global"|value="global"[^>]*aria-label="Vertex region"/);
    expect(html).toContain("Claude Haiku 5.5");
    expect(html).toContain("Enabled");
    expect(html).toMatch(/<button[^>]*>Enable in Model Garden<\/button>/);
    expect(html).not.toContain("Gemini 3.8 Flash"); // only the Vertex models
    expect(modelGardenUrl("agent-georg")).toBe("https://console.cloud.google.com/vertex-ai/model-garden?project=agent-georg");
  });

  it("without Application Default Credentials: says so and offers Sign in; while it runs, the button waits", () => {
    const off = { ...LISTING, vertex: { ...LISTING.vertex, adc: false, quota_project: null } };
    const html = vertex(off);
    expect(html).toContain("Not signed in");
    expect(html).toMatch(/Quota project.*not set/s);
    expect(html).toMatch(/<button[^>]*>Sign in<\/button>/);
    const running = vertex(off, { login: { state: "running", message: "Opening the browser" } });
    expect(running).toMatch(/<button[^>]*disabled=""[^>]*>Signing in…<\/button>/);
    expect(running).toContain("Opening the browser");
    expect(vertex(off, { login: { state: "failed", message: "gcloud timed out" } })).toContain("gcloud timed out");
  });

  it("Sign in starts the job for the project, then polls every 2 s until it's no longer running", async () => {
    const seen: string[] = [], slept: number[] = [];
    const states: LoginStatus[] = [{ state: "running", message: "a" }, { state: "running", message: "b" }, { state: "done", message: "Signed in." }];
    const api = {
      vertexLogin: async (project?: string) => { seen.push(`start ${project}`); return { state: "running" as const, message: "" }; },
      vertexLoginStatus: async () => { seen.push("status"); return states.shift()!; },
    };
    const shown: string[] = [];
    const last = await runVertexLogin(api, "agent-georg", (s) => shown.push(s.state), async (ms) => { slept.push(ms); });
    expect(seen).toEqual(["start agent-georg", "status", "status", "status"]);
    expect(slept).toEqual([2000, 2000, 2000]);
    expect(shown).toEqual(["running", "running", "done"]);
    expect(last.state).toBe("done");
  });

  it("a sign-in already running (409) is polled, not an error", async () => {
    const api = {
      vertexLogin: async (): Promise<LoginStatus> => { throw new BackendError("A sign-in is already running.", 409); },
      vertexLoginStatus: async () => ({ state: "done" as const, message: "" }),
    };
    expect((await runVertexLogin(api, "agent-georg", () => {}, async () => {})).state).toBe("done");
  });
});

describe("backend client and sample data: models", () => {
  it("reads /models (refresh=1 re-checks), switches with PUT /settings/model, and runs the Vertex sign-in", async () => {
    const seen: { method: string; path: string; body?: string }[] = [];
    const api = createBackend({ token: () => "t", transport: async (req) => { seen.push(req); return { status: 200, body: "{}" }; } });
    await api.models(); await api.models(true); await api.setModel("gemini:gemini-3.8-flash");
    await api.vertexLogin("agent-georg"); await api.vertexLoginStatus();
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /models", "GET /models?refresh=1", "PUT /settings/model",
      "POST /setup/vertex-login", "GET /setup/vertex-login"]);
    expect(JSON.parse(seen[2].body!)).toEqual({ model: "gemini:gemini-3.8-flash" });
    expect(JSON.parse(seen[3].body!)).toEqual({ project: "agent-georg" });
  });

  it("the sample backend lists the 12 models with sample states, and a switch changes the health's model", async () => {
    const api = createBackend({ transport: mockTransport, token: () => "sample" });
    const l = await api.models();
    expect(l.models).toHaveLength(12);
    expect(new Set(l.models.map((x) => x.group))).toEqual(new Set(["Claude (Anthropic key)", "Claude (Google Cloud)", "Gemini"]));
    expect(l.models.some((x) => x.state === "blocked")).toBe(true);
    expect(l.models.some((x) => x.state === "setup")).toBe(true);
    const before = l.selected;
    await api.setModel("gemini:gemini-3.8-flash");
    expect((await api.models()).selected).toBe("gemini:gemini-3.8-flash");
    expect((await api.health()).ai).toMatchObject({ model_id: "gemini:gemini-3.8-flash", label: "Gemini 3.8 Flash", provider: "gemini" });
    expect((await api.settings()).model).toBe("gemini:gemini-3.8-flash");
    await expect(api.setModel("nope:x")).rejects.toThrow();
    // PUT /settings merges: a limit change keeps the model
    await api.saveSettings({ monthly_limit_usd: 20 });
    expect((await api.settings()).model).toBe("gemini:gemini-3.8-flash");
    await api.setModel(before);
  });
});
