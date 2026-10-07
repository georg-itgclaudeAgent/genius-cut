import { describe, it, expect } from "vitest";
import { cepHost, HostUnavailable } from "./host";
import type { Snapshot } from "./types";

const SNAP: Snapshot = {
  found: true, sequenceId: "seq-1", startTicks: "100", endTicks: "900", startS: 95.5, durationS: 10, fps: 30,
  video: [{ kind: "video", trackIndex: 0, label: "V1", startTicks: "100", endTicks: "900", name: "wide.mov",
    mediaPath: "D:/wide.mov", inS: 10, outS: 20, speed: 1, effects: [] }],
  audio: [{ kind: "audio", trackIndex: 2, label: "A3", startTicks: "100", endTicks: "900", name: "mic.wav",
    mediaPath: "D:/mic.wav", inS: 10, outS: 20, speed: 1, effects: [] }],
  problems: [],
};

/** The ExtendScript call's argument, undoing the double JSON quoting. */
function argOf(script: string, fn: string): unknown {
  const arg = script.slice(script.indexOf(`${fn}(`, 30) + fn.length + 1, script.lastIndexOf(") :"));
  return JSON.parse(JSON.parse(arg));
}

describe("cepHost", () => {
  it("a missing gcut* function (Phase C not installed) is HostUnavailable", async () => {
    const host = cepHost(async () => "__GCUT_MISSING__");
    await expect(host.snapshotSelection("take3")).rejects.toBeInstanceOf(HostUnavailable);
  });

  it("the host's Error: convention becomes a plain error", async () => {
    const host = cepHost(async () => "Error: No active sequence");
    await expect(host.snapshotSelection(null)).rejects.toThrow("No active sequence");
  });

  it("parses the JSON the host returns", async () => {
    const host = cepHost(async () => JSON.stringify({ found: false, message: "Nothing selected." }));
    await expect(host.snapshotSelection("take3")).resolves.toMatchObject({ found: false, message: "Nothing selected." });
  });

  it("quotes clip names safely into the ExtendScript call", async () => {
    let script = "";
    const host = cepHost(async (s) => { script = s; return "{}"; });
    await host.snapshotSelection('he said "cut"\\ok');
    expect(script).toMatch(/^typeof gcutSnapshotSelection === "function"/);
    expect(argOf(script, "gcutSnapshotSelection")).toBe('he said "cut"\\ok');
  });

  it("no name goes to the host as an empty string", async () => {
    let script = "";
    await cepHost(async (s) => { script = s; return "{}"; }).snapshotSelection(null);
    expect(argOf(script, "gcutSnapshotSelection")).toBe("");
  });

  it("applyCuts sends the range, every clip's track and the spans", async () => {
    let script = "";
    const host = cepHost(async (s) => { script = s; return JSON.stringify({ ok: true, appliedCount: 2, clipCount: 2 }); });
    const spans = [{ start: 0, end: 1 }, { start: 2, end: 5 }];
    await expect(host.applyCuts(SNAP, spans)).resolves.toMatchObject({ ok: true, clipCount: 2 });
    expect(argOf(script, "gcutApplyCutsMulti")).toEqual({
      sequenceId: "seq-1", startTicks: "100", endTicks: "900", spans,
      items: [
        { kind: "video", trackIndex: 0, startTicks: "100", endTicks: "900" },
        { kind: "audio", trackIndex: 2, startTicks: "100", endTicks: "900" },
      ],
    });
  });

  it("restore and closeGap send the range start", async () => {
    const scripts: string[] = [];
    const host = cepHost(async (s) => { scripts.push(s); return JSON.stringify({ ok: true }); });
    await host.restore(SNAP);
    await host.closeGap(SNAP);
    expect(argOf(scripts[0], "gcutRestoreMulti")).toEqual({ startTicks: "100" });
    expect(argOf(scripts[1], "gcutCloseGapMulti")).toEqual({ startTicks: "100" });
  });

  it("restore throws the host's message when it refuses", async () => {
    const host = cepHost(async () => JSON.stringify({ ok: false, message: "The original is gone." }));
    await expect(host.restore(SNAP)).rejects.toThrow("The original is gone.");
  });

  it("closeGap throws the host's message when it refuses", async () => {
    const host = cepHost(async () => JSON.stringify({ ok: false, movedCount: 0, message: "A clip on A3 didn't move as expected." }));
    await expect(host.closeGap(SNAP)).rejects.toThrow("A clip on A3 didn't move as expected.");
  });
});
