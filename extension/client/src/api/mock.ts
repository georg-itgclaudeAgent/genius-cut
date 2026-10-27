/**
 * Sample data for running the panel in a browser (`npm run dev`), outside Premiere.
 * The transcript is from the committed synthetic fixture; the cuts are illustrative,
 * not produced by the AI, and the costs are plausible, not billed. The panel shows a "Sample data" banner in this mode.
 */
import { API_VERSION } from "../lib/lifecycle";
import type { Transport } from "./backend";
import type { Host } from "./host";
import type {
  AiStatus, GraphicsStatus, Health, Library, ModelEntry, ModelListing, RunCost, SequenceCut, Settings, Snapshot, SnapshotItem, Span, StyleExample, TrimResponse, Usage, Word,
} from "./types";

const W = (w: string, start: number, end: number): Word => ({ w, start, end });
const WORDS: Word[] = [
  W("So,", 0.0, 0.26), W("um,", 0.4, 0.62), W("the", 0.8, 0.9), W("thing", 0.9, 1.1), W("about", 1.1, 1.3),
  W("Google", 1.3, 1.62), W("Workspace", 1.62, 2.2), W("is,", 2.2, 2.42), W("uh,", 2.7, 2.92), W("most", 3.24, 3.46),
  W("resellers", 3.46, 4.06), W("get", 4.06, 4.2), W("the", 4.2, 4.3), W("licensing", 4.3, 4.86), W("wrong.", 4.86, 5.3),
  W("You", 6.0, 6.12), W("know,", 6.12, 6.44), W("they,", 6.8, 7.1), W("they", 7.34, 7.56), W("sell", 7.56, 7.86),
  W("the", 7.86, 7.96), W("wrong", 7.96, 8.3), W("plan.", 8.3, 8.8),
];

const START_S = 95.5, DURATION_S = 9.2;
const T = (s: number) => String(s * 254016000000);
const angle = (kind: "video" | "audio", trackIndex: number, name: string, inS: number, effects: string[] = []): SnapshotItem => ({
  kind, trackIndex, label: (kind === "video" ? "V" : "A") + (trackIndex + 1), startTicks: T(START_S), endTicks: T(START_S + DURATION_S),
  name, mediaPath: `D:/Footage/EP114/${name}`, inS, outS: inS + DURATION_S, speed: 1, effects,
});
const SNAPSHOT: Snapshot = {
  found: true, sequenceId: "sample-sequence", startTicks: T(START_S), endTicks: T(START_S + DURATION_S),
  startS: START_S, durationS: DURATION_S, fps: 23.976,
  video: [angle("video", 0, "wide.mov", 12, ["Lumetri Color"]), angle("video", 1, "close.mov", 14), angle("video", 2, "screen.mov", 5)],
  audio: [angle("audio", 0, "wide.mov", 12), angle("audio", 1, "lav.wav", 3)],
  problems: [],
};

function cutsFor(startS: number): SequenceCut[] {
  const c = (a: number, b: number, reason: string): SequenceCut => {
    const ws = WORDS.slice(a, b + 1);
    const start = ws[0].start, end = ws[ws.length - 1].end;
    return { start, end, text: ws.map((w) => w.w).join(" "), reason, start_seq_s: startS + start, end_seq_s: startS + end };
  };
  return [c(0, 1, "filler"), c(8, 8, "filler"), c(15, 16, "filler"), c(17, 17, "repeat")];
}

let library: StyleExample[] = [{
  id: "2026-09-28-client-testimonial", created: "2026-09-28T14:02:00+08:00", source_clip: "client_testimonial_A.mp4",
  raw_words: WORDS.slice(0, 8), final_text: "The thing about Google Workspace is",
  removed_spans: [{ start: 0, end: 0.62, text: "So, um,", reason: "edited out" }],
}];
let summary: string | null = null;

// The picker's 12 models with sample states (catalog.py's list and prices): the Anthropic key is capped, Vertex isn't
// signed in until "Sign in" (then only Haiku is enabled), Gemini works. Gemini 3.7 Flash is selected at first.
const GROUP = { anthropic: "Claude (Anthropic key)", vertex: "Claude (Google Cloud)", gemini: "Gemini" } as const;
const CLAUDE: [string, string, number, number][] = [["claude-opus-5-5", "Claude Opus 5.5", 4, 20], ["claude-sonnet-5-5", "Claude Sonnet 5.5", 2, 10],
  ["claude-haiku-5-5", "Claude Haiku 5.5", 0.1, 0.5], ["claude-fable-5-1", "Claude Fable 5.1", 10, 50]];
const GEMINI: [string, string, number, number][] = [["gemini-3.8-flash", "Gemini 3.8 Flash", 0.75, 3.75], ["gemini-3.7-flash", "Gemini 3.7 Flash", 0.75, 3.75],
  ["gemini-3.5-flash", "Gemini 3.5 Flash", 1.5, 9], ["gemini-3.1-pro-preview", "Gemini 3.1 Pro", 2, 12]];
let vertexSignedIn = false;
function sampleModels(): ModelEntry[] {
  const entry = (provider: ModelEntry["provider"], [model, name, input, output]: [string, string, number, number]): ModelEntry => {
    const [state, message]: [ModelEntry["state"], string] = provider === "anthropic" ? ["blocked", "Workspace limit reached until 1 Nov"]
      : provider === "gemini" ? ["ok", "Ready"]
      : !vertexSignedIn ? ["setup", "Sign in to Google Cloud for Vertex in Settings."]
      : model === "claude-haiku-5-5" ? ["ok", "Enabled"] : ["setup", "Enable in Model Garden"];
    return { id: `${provider}:${model}`, provider, group: GROUP[provider], price: { input, output }, state, message,
      label: provider === "gemini" ? name : `${name} (${provider === "anthropic" ? "Anthropic" : "Google Cloud"})`,
      usd_per_minute: (input * 1500 + output * 230) / 1e6 };
  };
  return [...CLAUDE.map((c) => entry("anthropic", c)), ...CLAUDE.map((c) => entry("vertex", c)), ...GEMINI.map((g) => entry("gemini", g))];
}
const selectedModel = () => { const all = sampleModels(); return all.find((x) => x.id === settings.model) ?? all.find((x) => x.id === "gemini:gemini-3.7-flash")!; };
const listing = (): ModelListing => ({ selected: settings.model, models: sampleModels(),
  vertex: { ...settings.vertex, adc: vertexSignedIn, quota_project: vertexSignedIn ? settings.vertex.project : null } });

// The month grows with each sample run, at the selected model's rates.
let monthUsd = 0.08;
const aiStatus = (): AiStatus => {
  const m = selectedModel();
  return { provider: m.provider, model_id: m.id, label: m.label, month_usd: monthUsd, limit_usd: 2, usd_per_minute: m.usd_per_minute };
};
function sampleCost(input_tokens: number, output_tokens: number): RunCost {
  const m = selectedModel();
  const usd = (input_tokens * m.price!.input + output_tokens * m.price!.output) / 1e6;
  monthUsd += usd;
  return { model: m.id, label: m.label, provider: m.provider, input_tokens, output_tokens, usd, month_usd: monthUsd, limit_usd: 2 };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
let bootedAt = Date.now();

export const mockTransport: Transport = async (req) => {
  const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
  if (req.path === "/health") {
    const health: Health = { status: "ok", version: "0.1.0", api: API_VERSION, stt_device: Date.now() - bootedAt < 1500 ? "loading" : "cuda",
      ai: aiStatus() };
    return ok(health);
  }
  if (req.path === "/trim") {
    await delay(1800);
    const body = JSON.parse(req.body || "{}");
    const cuts = cutsFor(body.range_start_seq_s ?? START_S);
    const kept: Span[] = [];
    let cursor = 0;
    for (const c of cuts) { if (c.start > cursor) kept.push({ start: cursor, end: c.start }); cursor = c.end; }
    if (cursor < DURATION_S) kept.push({ start: cursor, end: DURATION_S });
    const response: TrimResponse = {
      words: WORDS, cuts, kept_spans_source: [], kept_spans: kept, stt_device: "cuda",
      cut_fraction: 0, warning: null, cost: sampleCost(12053, 2661),
    };
    return ok(response);
  }
  if (req.path === "/library" && req.method === "GET") return ok({ examples: library, summary } satisfies Library);
  if (req.path === "/library/examples") {
    const b = JSON.parse(req.body || "{}");
    const ex: StyleExample = {
      id: `sample-${library.length + 1}`, created: new Date().toISOString(), source_clip: b.source_clip,
      raw_words: b.raw_words, final_text: b.final_text, removed_spans: [],
    };
    library = [ex, ...library];
    return ok(ex);
  }
  if (req.path === "/library/summarize") {
    await delay(900);
    summary = "- Cut filler words (um, uh, you know) at the start of an answer.\n- Keep product names intact.";
    return ok({ summary, cost: sampleCost(2400, 900) });
  }
  // Settings and the Setup page's listings (the sample panel never gates on Setup).
  const path = req.path.split("?")[0];
  // An instruction run: the sample model hands every instruction to the trim review.
  if (path === "/agent/runs" && req.method === "POST") {
    await delay(700);
    const b = JSON.parse(req.body || "{}");
    return ok({ run_id: "sample-run", state: "tool_calls", text: "", message: null, reason: null, cost: sampleCost(1800, 120), graphics: [],
      tool_calls: [{ id: "tu-sample", name: "propose_filler_cuts", input: { instructions: String(b.instruction || "trim the fillers") } }] });
  }
  if (path.startsWith("/agent/runs/") && req.method === "DELETE") return ok({ ok: true });
  if (path.startsWith("/agent/runs/")) return { status: 404, body: JSON.stringify({ detail: "This run was lost; send the instruction again." }) };
  // Graphics: never set up on sample data; "Set up graphics" finishes at once without installing anything.
  if (path === "/graphics/setup" && req.method === "POST") { graphicsSetupRan = true; return { status: 202, body: JSON.stringify({ state: "running", message: "Starting" }) }; }
  if (path === "/graphics/status") {
    const status: GraphicsStatus = { ready: false, message: "Sample data: graphics aren't set up.",
      node: { ok: false, path: null, version: null }, cli: { ok: false, path: null, version: null }, chrome: { ok: false, path: null },
      ffmpeg: { ok: false, path: null }, setup: graphicsSetupRan ? { state: "done", message: "Sample data: nothing was installed." } : { state: "idle", message: "" } };
    return ok(status);
  }
  if (path === "/settings" && req.method === "PUT") {
    const b = JSON.parse(req.body || "{}");
    settings = { ...settings, ...b, setup_complete: settings.setup_complete, vertex: { ...settings.vertex, ...(b.vertex ?? {}) } };
    return ok(settings);
  }
  if (path === "/settings/model") {
    const id = JSON.parse(req.body || "{}").model;
    if (!sampleModels().some((x) => x.id === id)) return { status: 422, body: JSON.stringify({ detail: `Unknown model: ${id}` }) };
    settings = { ...settings, model: id };
    return ok(settings);
  }
  if (path === "/models") { if (req.path.includes("refresh=1")) await delay(400); return ok(listing()); }
  if (path === "/setup/vertex-login" && req.method === "POST") {
    vertexSignedIn = true;
    return { status: 202, body: JSON.stringify({ state: "running", message: "Sample data: nothing is signed in." }) };
  }
  if (path === "/setup/vertex-login") return ok({ state: vertexSignedIn ? "done" : "idle", message: vertexSignedIn ? "Sample data: nothing was signed in." : "" });
  if (path === "/settings") return ok(settings);
  if (path === "/settings/test-key") { await delay(600); return ok({ ok: true, message: "Sample data: no key was read." }); }
  if (path === "/setup/gcloud") return ok({ installed: true, path: null, version: "520.0.0", account: "editor@example.com" });
  if (path === "/setup/login") return ok({ state: "done", message: "Signed in." });
  if (path === "/setup/projects") return ok({ projects: [{ id: "sample-project", name: "Sample project" }] });
  if (path === "/setup/secrets") return ok({ secrets: ["ANTHROPIC_API_KEY"] });
  if (path === "/setup/versions") return ok({ versions: [{ version: "1", state: "enabled" }] });
  if (path === "/usage") {
    const now = new Date(), next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const usage: Usage = { month_usd: monthUsd, limit_usd: settings.monthly_limit_usd, limit_tier: settings.monthly_limit_usd,
      resets_on: next.toISOString().slice(0, 10), run_count: 1, runs: [{ at: now.toISOString(), kind: "trim", model: "gemini:gemini-3.7-flash", label: "Gemini 3.7 Flash", provider: "gemini", usd: 0.02 }] };
    return ok(usage);
  }
  return { status: 404, body: JSON.stringify({ detail: `No mock for ${req.path}` }) };
};

let graphicsSetupRan = false;

let settings: Settings = { anthropic_key: { project: "sample-project", secret: "ANTHROPIC_API_KEY", version: "latest" },
  monthly_limit_usd: 20, setup_complete: true, model: "gemini:gemini-3.7-flash", vertex: { project: "sample-project", region: "global" } };

export const mockHost: Host = {
  async snapshotSelection() { await delay(300); return SNAPSHOT; },
  async applyCuts(snap, removed) {
    await delay(1200);
    const gone = removed.reduce((a, s) => a + (s.end - s.start), 0);
    const expected = snap.durationS - gone;
    return { ok: true, appliedCount: removed.length, clipCount: snap.video.length + snap.audio.length, expectedDuration: expected, actualDuration: expected,
      trailingGapS: gone, crossfades: removed.length * snap.audio.length };
  },
  async closeGap() { await delay(300); },
  async restore() { await delay(500); },
};

/** The tool table's host side on sample data: get_sequence lists the sample clips, all selected; nothing is edited. */
export async function mockCallHost(fn: string, _args: unknown): Promise<any> {
  if (fn !== "gcutToolGetSequence") throw new Error("Sample data: nothing on a timeline is changed.");
  const clips = [...SNAPSHOT.video, ...SNAPSHOT.audio].map((x) => ({
    id: `${x.label}@${x.startTicks}#sample-${x.label}`, track: x.label, name: x.name, startS: START_S, endS: START_S + DURATION_S,
    inS: x.inS, source: x.mediaPath, selected: true, enabled: true, effects: x.effects, speed: 1 }));
  return { sequenceId: SNAPSHOT.sequenceId, name: "Sample sequence", fps: SNAPSHOT.fps, durationS: 600, tracks: [], markers: [],
    clips, selection: clips.map((c) => c.id) };
}

export function resetMockBoot() { bootedAt = Date.now(); }
