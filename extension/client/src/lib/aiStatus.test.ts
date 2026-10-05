import { describe, it, expect } from "vitest";
import { afterTrimRefresh, watchAiStatus } from "./aiStatus";
import type { AiStatus, Health } from "../api/types";

const ai = (month_usd: number, limit_usd = 2): AiStatus =>
  ({ provider: "gemini", model: "gemini-3.7-flash", month_usd, limit_usd, usd_per_minute: 0.002 });
const health = (a?: AiStatus): Health => ({ status: "ok", version: "0.1.0", stt_device: "cuda", ai: a });
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(responses: Array<Health | Error>) {
  const seen: AiStatus[] = [];
  let calls = 0;
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
  const w = watchAiStatus({
    fetchHealth: async () => {
      const r = responses[Math.min(calls++, responses.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    },
    onAi: (a) => seen.push(a), win, doc,
  });
  return { w, seen, win, doc, calls: () => calls };
}

describe("watchAiStatus", () => {
  it("refresh() reads /health and reports the fresh month and limit", async () => {
    const s = setup([health(ai(0.31, 5))]);
    await s.w.refresh();
    expect(s.seen).toEqual([ai(0.31, 5)]);
  });
  it("refreshes when the panel regains focus", async () => {
    const s = setup([health(ai(0.2))]);
    s.win.dispatchEvent(new Event("focus"));
    await flush();
    expect(s.seen).toEqual([ai(0.2)]);
  });
  it("refreshes when the panel becomes visible, not when it's hidden", async () => {
    const s = setup([health(ai(0.2))]);
    s.doc.visibilityState = "hidden";
    s.doc.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(s.calls()).toBe(0);
    s.doc.visibilityState = "visible";
    s.doc.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(s.seen).toEqual([ai(0.2)]);
  });
  it("ignores a failed or ai-less /health", async () => {
    const s = setup([new Error("backend down"), health(undefined)]);
    await s.w.refresh();
    await s.w.refresh();
    expect(s.seen).toEqual([]);
  });
  it("stop() removes the listeners and drops replies still in flight", async () => {
    const s = setup([health(ai(0.2))]);
    const pending = s.w.refresh();
    s.w.stop();
    await pending;
    s.win.dispatchEvent(new Event("focus"));
    await flush();
    expect(s.seen).toEqual([]);
    expect(s.calls()).toBe(1);
  });
});

describe("afterTrimRefresh", () => {
  it("refreshes after a successful trim and returns its result", async () => {
    const order: string[] = [];
    const out = await afterTrimRefresh(async () => { order.push("trim"); return 7; }, async () => { order.push("refresh"); });
    expect(out).toBe(7);
    expect(order).toEqual(["trim", "refresh"]);
  });
  it("refreshes after a failed trim too (a cut-off reply was still paid for) and rethrows", async () => {
    const order: string[] = [];
    const err = await afterTrimRefresh(async () => { order.push("trim"); throw new Error("402 limit"); },
      async () => { order.push("refresh"); }).catch((e) => e);
    expect(err.message).toBe("402 limit");
    expect(order).toEqual(["trim", "refresh"]);
  });
});
