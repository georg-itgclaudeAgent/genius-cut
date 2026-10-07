import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AudioPicker } from "./AudioPicker";
import { offersRestore } from "./CutTab";
import { mockHost } from "../api/mock";
import { audioChoice, audioKey } from "../lib/snapshot";
import type { Snapshot, SnapshotItem } from "../api/types";

const item = (kind: "video" | "audio", t: number, name: string): SnapshotItem => ({
  kind, trackIndex: t, label: (kind === "video" ? "V" : "A") + (t + 1), startTicks: "0", endTicks: "1", name,
  mediaPath: `D:/${name}`, inS: 0, outS: 10, speed: 1, effects: [] });
const SNAP: Snapshot = { found: true, sequenceId: "s", startTicks: "0", endTicks: "1", startS: 0, durationS: 10, fps: 25,
  video: [item("video", 0, "wide.mov")], audio: [item("audio", 0, "wide.mov"), item("audio", 1, "lav.wav")], problems: [] };
const picker = (preselect: string | null) => renderToStaticMarkup(
  <AudioPicker snap={SNAP} preselect={preselect} onPick={() => {}} onCancel={() => {}} />);
const buttons = (html: string) => html.match(/<button[^>]*>.*?<\/button>/g)!;

describe("AudioPicker", () => {
  it("marks the remembered option as last used, and only that one", () => {
    const b = buttons(picker(audioKey(SNAP.audio[1])));
    expect(b.filter((x) => x.includes("Last used"))).toHaveLength(1);
    expect(b.find((x) => x.includes("lav.wav"))).toMatch(/class="btn btn-p"[^>]*>.*Last used/);
    expect(b.find((x) => x.includes("A1 · wide.mov"))).toContain('class="btn btn-g"');
  });
  it("can preselect Mix all", () => {
    expect(buttons(picker("mix")).find((x) => x.includes("Mix all"))).toMatch(/btn-p.*Last used/);
  });
  it("marks nothing without a remembered choice", () => {
    const html = picker(null);
    expect(html).not.toContain("Last used");
    expect(html).not.toContain("btn-p");
  });
});

describe("Restore original after a failed Apply", () => {
  const failed = { ok: false, appliedCount: 0, clipCount: 0, expectedDuration: 0, actualDuration: 0, trailingGapS: 0 };
  it("is offered only when the host couldn't put the clips back mid-rebuild", () => {
    expect(offersRestore({ ...failed, rolledBack: false })).toBe(true);
    expect(offersRestore({ ...failed, rolledBack: true })).toBe(false);
  });
  it("is never offered for a refusal thrown before anything changed", () => {
    expect(offersRestore(new Error("V2's clip changed since Analyse. Analyse again."))).toBe(false);
    expect(offersRestore(new Error("V3 is locked. Unlock it to apply."))).toBe(false);
  });
});

describe("sample data", () => {
  it("has two audio clips under the angles, so the preview shows the audio picker", async () => {
    const snap = await mockHost.snapshotSelection(null) as Snapshot;
    expect(snap.audio.map((a) => [a.label, a.name])).toEqual([["A1", "wide.mov"], ["A2", "lav.wav"]]);
    expect(snap.video).toHaveLength(3);
    expect(audioChoice(snap, null)).toEqual({ kind: "ask", preselect: null });
  });
});
