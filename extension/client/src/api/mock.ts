/**
 * Sample data for running the panel in a browser (`npm run dev`), outside Premiere.
 * The transcript is from the committed synthetic fixture; the cuts are illustrative,
 * not produced by the AI, and the costs are plausible, not billed. The panel shows a "Sample data" banner in this mode.
 */
import type { Transport } from "./backend";
import type { Host } from "./host";
import type { AiStatus, Health, Library, RunCost, SequenceCut, Snapshot, SnapshotItem, Span, StyleExample, TrimResponse, Word } from "./types";

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
  audio: [angle("audio", 0, "wide.mov", 12)],
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

// Gemini 3.7 Flash rates (0.75 / 3.75 USD per 1M tokens); the month grows with each sample run.
const MODEL = "gemini-3.7-flash";
let monthUsd = 0.08;
const aiStatus = (): AiStatus =>
  ({ provider: "gemini", model: MODEL, month_usd: monthUsd, limit_usd: 2, usd_per_minute: 0.002 });
function sampleCost(input_tokens: number, output_tokens: number): RunCost {
  const usd = (input_tokens * 0.75 + output_tokens * 3.75) / 1e6;
  monthUsd += usd;
  return { model: MODEL, input_tokens, output_tokens, usd, month_usd: monthUsd, limit_usd: 2 };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
let bootedAt = Date.now();

export const mockTransport: Transport = async (req) => {
  const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
  if (req.path === "/health") {
    const health: Health = { status: "ok", version: "0.1.0", stt_device: Date.now() - bootedAt < 1500 ? "loading" : "cuda",
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
  return { status: 404, body: JSON.stringify({ detail: `No mock for ${req.path}` }) };
};

export const mockHost: Host = {
  async snapshotSelection() { await delay(300); return SNAPSHOT; },
  async applyCuts(snap, spans) {
    await delay(1200);
    const expected = spans.reduce((a, s) => a + (s.end - s.start), 0);
    return { ok: true, appliedCount: spans.length, clipCount: 4, expectedDuration: expected, actualDuration: expected,
      trailingGapS: snap.durationS - expected };
  },
  async closeGap() { await delay(300); },
  async restore() { await delay(500); },
};

export function resetMockBoot() { bootedAt = Date.now(); }
