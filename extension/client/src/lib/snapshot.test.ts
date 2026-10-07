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
  it("sends the range and the chosen audio sources", () => {
    expect(trimRequestFor(three, three.audio, "trim it")).toEqual({
      duration_s: 647.4, range_start_seq_s: 95.5, audio: [{ media_path: "D:/wide.mov", in_s: 10 }], prompt: "trim it" });
  });
});
