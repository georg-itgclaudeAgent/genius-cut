import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CutTab } from "./CutTab";
import { CutReview } from "./CutReview";
import { mockTransport } from "../api/mock";
import type { ClipInfo, Health, TrimResponse } from "../api/types";

const HEALTH: Health = {
  status: "ok", version: "0.1.0", stt_device: "cuda",
  ai: { provider: "gemini", model: "gemini-3.7-flash", month_usd: 0.08, limit_usd: 2, usd_per_minute: 0.003 },
};

const cutTab = (health: Health | null) => renderToStaticMarkup(<CutTab health={health} ready onTrimmed={() => {}} />);
const analyseButton = (html: string) => html.match(/<button[^>]*type="submit"[^>]*>Analyse<\/button>/)![0];

describe("CutTab cost estimate", () => {
  it("shows the estimate and the month under the Analyse button", () => {
    const html = cutTab(HEALTH);
    expect(html).toContain("Est. ~$0.03 per 10 min of clip · This month $0.08 of $2.00");
    expect(html).not.toContain("Monthly AI limit reached");
    expect(analyseButton(html)).not.toContain("disabled");
  });
  it("warns and disables Analyse when the month's limit is reached", () => {
    const html = cutTab({ ...HEALTH, ai: { ...HEALTH.ai!, month_usd: 2 } });
    expect(html).toMatch(/class="cost-est warn"[^>]*>Monthly AI limit reached/);
    expect(analyseButton(html)).toContain("disabled");
  });
  it("is hidden when the backend doesn't report AI spend", () => {
    const { ai: _, ...old } = HEALTH;
    const html = cutTab(old);
    expect(html).not.toContain("cost-est");
    expect(analyseButton(html)).not.toContain("disabled");
  });
});

const CLIP: ClipInfo = {
  found: true, name: "take.mp4", mediaPath: "C:/take.mp4", trackIndex: 0, startTicks: "0", inS: 0, outS: 10, startS: 0,
  fps: 25, matchCount: 1, selectedUsed: true, speed: 1, effects: [],
};
const RES: TrimResponse = {
  words: [], kept_spans_source: [], stt_device: "cuda", cut_fraction: 0.1, warning: null,
  cuts: [{ start: 1, end: 2, text: "um", reason: "filler", start_seq_s: 1, end_seq_s: 2 }],
  cost: { model: "gemini-3.7-flash", input_tokens: 7100, output_tokens: 4200, usd: 0.03, month_usd: 0.11, limit_usd: 2 },
};
const review = (res: TrimResponse) => renderToStaticMarkup(
  <CutReview clip={CLIP} res={res} checked={res.cuts.map(() => true)} busy={false}
    onToggle={() => {}} onToggleAll={() => {}} onApply={() => {}} onDiscard={() => {}} />);

describe("CutReview cost line", () => {
  it("shows what the run cost and a month meter", () => {
    const html = review(RES);
    expect(html).toContain("This run: $0.03 (Gemini 3.7 Flash · 7.1k in / 4.2k out) · Month: $0.11 of $2.00");
    expect(html).toMatch(/class="meter"[^>]*role="meter"/);
    expect(html).toContain("width:5.5%");
    expect(html).not.toContain("meter hot");
  });
  it("turns the meter coral at 80% of the limit", () => {
    expect(review({ ...RES, cost: { ...RES.cost!, month_usd: 1.6 } })).toContain("meter hot");
  });
  it("shows the cost even when there was nothing to cut", () => {
    expect(review({ ...RES, cuts: [] })).toContain("This run: $0.03");
  });
  it("shows nothing for a backend that doesn't report cost", () => {
    const { cost: _, ...old } = RES;
    expect(review(old)).not.toContain("This run");
  });
});

describe("sample data", () => {
  it("reports AI spend in /health and a cost on /trim, so the preview shows the UI", async () => {
    const health = JSON.parse((await mockTransport({ method: "GET", path: "/health", headers: {} })).body) as Health;
    expect(health.ai).toMatchObject({ provider: "gemini", model: "gemini-3.7-flash", limit_usd: 2 });
    expect(health.ai!.usd_per_minute).toBeGreaterThan(0);
    expect(health.ai!.month_usd).toBeGreaterThan(0);
    const trim = JSON.parse((await mockTransport({ method: "POST", path: "/trim", headers: {}, body: "{}" })).body) as TrimResponse;
    expect(trim.cost).toMatchObject({ model: "gemini-3.7-flash", limit_usd: 2 });
    expect(trim.cost!.usd).toBeGreaterThan(0);
    expect(trim.cost!.input_tokens).toBeGreaterThan(0);
    expect(trim.cost!.month_usd).toBeGreaterThan(health.ai!.month_usd!);
  }, 10_000);
});
