import { describe, it, expect } from "vitest";
import { keptSpansSource, reviewSummary } from "./review";
import { parseClipName } from "./prompt";
import { formatTimecode, formatDuration } from "./timecode";
import { backendPaths, parseRuntimePointer } from "./paths";
import { ensureBackend } from "./lifecycle";
import type { Health, SequenceCut } from "../api/types";

const cut = (start: number, end: number, reason = "filler"): SequenceCut => ({
  start, end, text: "x", reason, start_seq_s: start, end_seq_s: end,
});

describe("keptSpansSource — mirrors backend trim.kept_spans", () => {
  const clip = { in_s: 10, out_s: 14 };
  it("is the complement of the checked cuts, in source time", () => {
    const cuts = [cut(0.5, 0.8), cut(2.0, 2.2)];
    expect(keptSpansSource(cuts, [true, true], clip)).toEqual([
      { start: 10, end: 10.5 }, { start: 10.8, end: 12 }, { start: 12.2, end: 14 },
    ]);
  });
  it("unticked cuts stay in the clip", () => {
    const cuts = [cut(0.5, 0.8), cut(2.0, 2.2)];
    expect(keptSpansSource(cuts, [false, true], clip)).toEqual([{ start: 10, end: 12 }, { start: 12.2, end: 14 }]);
  });
  it("clamps cuts past the clip edges and never emits zero-length spans", () => {
    expect(keptSpansSource([cut(0, 0.3), cut(3.5, 4.5)], [true, true], clip)).toEqual([{ start: 10.3, end: 13.5 }]);
  });
  it("keeps everything when nothing is ticked", () => {
    expect(keptSpansSource([cut(1, 2)], [false], clip)).toEqual([{ start: 10, end: 14 }]);
  });
});

describe("reviewSummary", () => {
  it("adds up only the ticked cuts and gives the resulting duration", () => {
    const s = reviewSummary([cut(0.5, 0.8), cut(2.0, 2.2), cut(3.0, 3.5)], [true, false, true], 4);
    expect(s.count).toBe(2);
    expect(s.reclaimedS).toBeCloseTo(0.8);
    expect(s.resultS).toBeCloseTo(3.2);
    expect(s.keepsNothing).toBe(false);
  });
  it("flags a selection that would remove the whole clip", () => {
    expect(reviewSummary([cut(0, 4)], [true], 4).keepsNothing).toBe(true);
  });
  it("overlapping cuts are not double-counted", () => {
    expect(reviewSummary([cut(0, 2), cut(1, 3)], [true, true], 4).reclaimedS).toBeCloseTo(3);
  });
});

describe("parseClipName", () => {
  it.each([
    ["trim the clip named interview_take3", "interview_take3"],
    ["Trim the clip named \"interview take 3.mp4\"", "interview take 3.mp4"],
    ["trim interview_take3", "interview_take3"],
    ["interview_take3", "interview_take3"],
    ["  clip named   A-cam 02  ", "A-cam 02"],
  ])("%s → %s", (input, name) => {
    expect(parseClipName(input)).toBe(name);
  });
  it("empty or instruction-only input has no clip name (use the selected clip)", () => {
    expect(parseClipName("")).toBeNull();
    expect(parseClipName("trim it")).toBeNull();
    expect(parseClipName("tighten this")).toBeNull();
  });
});

describe("timecode", () => {
  it("formats non-drop-frame timecode at 23.976", () => {
    expect(formatTimecode(4.3, 23.976)).toBe("00:00:04:07");
    expect(formatTimecode(3661.5, 25)).toBe("01:01:01:12");
  });
  it("formats durations as m:ss.s", () => {
    expect(formatDuration(252.4)).toBe("4:12.4");
    expect(formatDuration(51.2)).toBe("0:51.2");
    expect(formatDuration(59.96)).toBe("1:00.0");
  });
});

describe("backendPaths", () => {
  it("dev layout: backend sits next to the extension folder", () => {
    const p = backendPaths("C:/src/genius-cut/extension", (x) => x === "C:/src/genius-cut/backend/server.py", undefined);
    expect(p).toEqual({
      python: "C:/src/genius-cut/backend/.venv/Scripts/python.exe",
      server: "C:/src/genius-cut/backend/server.py",
      cwd: "C:/src/genius-cut/backend",
    });
  });
  it("installed layout: backend bundled inside the extension", () => {
    const p = backendPaths("C:/Users/x/AppData/Roaming/Adobe/CEP/extensions/com.attract.genius-cut",
      (x) => x.endsWith("com.attract.genius-cut/backend/server.py"), undefined);
    expect(p).toMatchObject({ server: "C:/Users/x/AppData/Roaming/Adobe/CEP/extensions/com.attract.genius-cut/backend/server.py" });
  });
  it("no backend anywhere → null", () => {
    expect(backendPaths("C:/nowhere/extension", () => false, undefined)).toBeNull();
  });
  it("installed layout with the runtime: python comes from runtime.json", () => {
    const root = "C:/Users/x/AppData/Roaming/Adobe/CEP/extensions/com.attract.genius-cut";
    const py = "C:/Users/x/AppData/Local/itGenius/genius-cut/runtime/1.0.0/python.exe";
    expect(backendPaths(root, (p) => p.endsWith("/backend/server.py"), py)).toEqual({
      python: py, server: `${root}/backend/server.py`, cwd: `${root}/backend`,
    });
  });
  it("installed layout without a runtime asks for setup instead of guessing a venv", () => {
    const root = "C:/Users/x/AppData/Roaming/Adobe/CEP/extensions/com.attract.genius-cut";
    expect(backendPaths(root, (p) => p.endsWith("/backend/server.py"), null)).toEqual({ needsSetup: true });
  });
  it("dev layout ignores the runtime pointer", () => {
    expect(backendPaths("C:/src/genius-cut/extension", (x) => x === "C:/src/genius-cut/backend/server.py", null))
      .toEqual({
        python: "C:/src/genius-cut/backend/.venv/Scripts/python.exe",
        server: "C:/src/genius-cut/backend/server.py",
        cwd: "C:/src/genius-cut/backend",
      });
  });
});

describe("parseRuntimePointer", () => {
  it("returns the python path", () => {
    expect(parseRuntimePointer('{"version":"1.0.0","flavour":"cpu","python":"C:\\\\r\\\\python.exe"}')).toBe("C:\\r\\python.exe");
  });
  it("treats malformed, empty or python-less files as no runtime", () => {
    for (const t of ["", "not json", "null", "[]", '{"version":"1"}', '{"python":5}', '{"python":""}'])
      expect(parseRuntimePointer(t)).toBeNull();
  });
});

describe("ensureBackend", () => {
  const ready: Health = { status: "ok", version: "0.1.0", stt_device: "cuda" };
  it("reuses a backend that already answers, without spawning", async () => {
    let spawned = 0;
    const r = await ensureBackend({ health: async () => ready, spawn: () => { spawned++; }, sleep: async () => {} });
    expect(r).toEqual({ kind: "ready", health: ready });
    expect(spawned).toBe(0);
  });
  it("spawns once when nothing answers, then polls until it does", async () => {
    let calls = 0, spawned = 0;
    const r = await ensureBackend({
      health: async () => { calls++; if (calls < 4) throw new Error("ECONNREFUSED"); return ready; },
      spawn: () => { spawned++; }, sleep: async () => {},
    });
    expect(r.kind).toBe("ready");
    expect(spawned).toBe(1);
  });
  it("reports a still-loading model as starting, not ready", async () => {
    const r = await ensureBackend({ health: async () => ({ ...ready, stt_device: "loading" }), spawn: () => {}, sleep: async () => {} });
    expect(r.kind).toBe("starting");
  });
  it("gives a readable failure after the retry budget", async () => {
    const r = await ensureBackend({
      health: async () => { throw new Error("ECONNREFUSED"); }, spawn: () => {}, sleep: async () => {}, attempts: 5,
    });
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.message).toMatch(/didn't start/);
  });
  it("a spawn error is a failure with its message", async () => {
    const r = await ensureBackend({
      health: async () => { throw new Error("ECONNREFUSED"); },
      spawn: () => { throw new Error("python.exe not found"); }, sleep: async () => {},
    });
    expect(r).toEqual({ kind: "failed", message: expect.stringContaining("python.exe not found") });
  });
  it("a setup-needed spawn error surfaces its exact message", async () => {
    const msg = "Genius Cut needs a one-time setup. Open Genius Installer Manager and click Finish setup.";
    const r = await ensureBackend({
      health: async () => { throw new Error("ECONNREFUSED"); },
      spawn: () => { throw Object.assign(new Error(msg), { needsSetup: true }); }, sleep: async () => {},
    });
    expect(r).toEqual({ kind: "failed", message: msg });
  });
  it("a load error from /health is a failure, not a spinner", async () => {
    const r = await ensureBackend({
      health: async (): Promise<Health> => ({ status: "error", version: "0.1.0", stt_device: "failed", error: "disk full" }),
      spawn: () => {}, sleep: async () => {},
    });
    expect(r).toEqual({ kind: "failed", message: expect.stringContaining("disk full") });
  });
});
