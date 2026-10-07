import { describe, it, expect } from "vitest";
import { snapshotSummary, effectsByClip, audioChoice, trimRequestFor, audioKey } from "./snapshot";
import type { Snapshot, SnapshotItem } from "../api/types";

const item = (kind: "video" | "audio", t: number, name: string, inS: number, effects: string[] = []): SnapshotItem => ({
  kind, trackIndex: t, label: (kind === "video" ? "V" : "A") + (t + 1), startTicks: "0", endTicks: "1", name,
  mediaPath: `D:/${name}`, inS, outS: inS + 647.4, speed: 1, effects });
const snap = (video: SnapshotItem[], audio: SnapshotItem[]): Snapshot => ({ found: true, sequenceId: "seq-1",
  startTicks: "0", endTicks: "1", startS: 95.5, durationS: 647.4, fps: 30, video, audio, problems: [] });
const three = snap([item("video", 0, "wide.mov", 10, ["Lumetri Color"]), item("video", 1, "close.mov", 12), item("video", 2, "screen.mov", 5, ["Lumetri Color"])],
                   [item("audio", 0, "wide.mov", 10)]);

describe("snapshotSummary", () => {
  // formatDuration is m:ss.s, the format the Target clip row already uses.
  it("one clip reads like before", () => {
    expect(snapshotSummary(snap([item("video", 0, "wide.mov", 10)], [item("audio", 0, "wide.mov", 10)]))).toBe("wide.mov · V1 · 10:47.4");
  });
  it("several clips list the tracks", () => {
    expect(snapshotSummary(three)).toBe("3 video clips (V1, V2, V3) + 1 audio (A1) · 10:47.4");
  });
  it("one video clip with several audio clips says so", () => {
    const one = snap([item("video", 0, "wide.mov", 10)], [item("audio", 0, "wide.mov", 10), item("audio", 1, "lav.wav", 3)]);
    expect(snapshotSummary(one)).toBe("wide.mov · V1 + 2 audio (A1, A2) · 10:47.4");
  });
});

describe("effectsByClip", () => {
  it("names effects per clip", () => {
    expect(effectsByClip(three)).toEqual(["V1: Lumetri Color", "V3: Lumetri Color"]);
  });
});

describe("audioChoice", () => {
  it("uses the only audio clip", () => {
    expect(audioChoice(three, null)).toEqual({ kind: "use", sources: [three.audio[0]] });
  });
  it("always asks when there are several, preselecting the remembered choice if it's still there", () => {
    const two = snap(three.video, [item("audio", 0, "mic1.wav", 3), item("audio", 1, "mic2.wav", 7.5)]);
    expect(audioChoice(two, null)).toEqual({ kind: "ask", preselect: null });
    expect(audioChoice(two, audioKey(two.audio[1]))).toEqual({ kind: "ask", preselect: audioKey(two.audio[1]) });
    expect(audioChoice(two, "mix")).toEqual({ kind: "ask", preselect: "mix" });
    expect(audioChoice(two, "A3:gone.wav")).toEqual({ kind: "ask", preselect: null }); // a remembered clip that's no longer there
  });
});

describe("trimRequestFor", () => {
  const T = 254016000000;
  it("sends the range and the chosen audio sources", () => {
    const a = { ...three.audio[0], startTicks: String(95.5 * T), endTicks: String(742.9 * T) };
    expect(trimRequestFor(three, [a], "trim it")).toEqual({
      duration_s: 647.4, range_start_seq_s: 95.5, audio: [{ media_path: "D:/wide.mov", in_s: 10, offset_s: 0, duration_s: 647.4 }], prompt: "trim it" });
  });

  it("each source covers its overlap with the range, placed at its offset", () => {
    const a = { ...item("audio", 0, "mic.wav", 50), startTicks: String(99 * T), endTicks: String(111 * T) };
    const b = { ...item("audio", 1, "lav.wav", 7), startTicks: String(103 * T), endTicks: String(108 * T) };
    const s = { ...snap([item("video", 0, "A.mov", 10)], [a, b]), startS: 100, durationS: 10 };
    expect(trimRequestFor(s, [a, b], "x").audio).toEqual([
      { media_path: "D:/mic.wav", in_s: 51, offset_s: 0, duration_s: 10 },
      { media_path: "D:/lav.wav", in_s: 7, offset_s: 3, duration_s: 5 },
    ]);
  });
});
