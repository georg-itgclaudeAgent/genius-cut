/**
 * Runs the real ExtendScript host (extension/host/index.jsx) in a Node sandbox against a
 * simulated Premiere object model. The sandbox has NO native JSON, like ExtendScript.
 *
 * This proves the host's logic against our model of the Premiere API, not against Premiere
 * itself: Checkpoint B checks the real thing. The model is deliberately NOT kind:
 *   - overwriteClip really overwrites: it trims, splits or removes whatever it lands on;
 *   - placements snap to the sequence frame grid;
 *   - behaviours the docs don't pin down are switches (setInPoint units, where linked audio
 *     lands, whether remove/move also act on linked partners, locked tracks, in > out).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import vm from "vm";

const TICKS = 254016000000;
// 25 fps: the scene's whole-second positions are on the frame grid, as real clips always are.
const FPS = 25;
const TPF = TICKS / FPS;
const HOST_SRC = readFileSync(resolve(__dirname, "../../host/index.jsx"), "utf8");

class Time {
  t = 0;
  get seconds() { return this.t / TICKS; }
  set seconds(s: number) { this.t = Math.round(s * TICKS); }
  get ticks() { return String(this.t); }
  set ticks(v: string) { this.t = Number(v); }
  static s(sec: number) { const x = new Time(); x.seconds = sec; return x; }
  static k(ticks: number) { const x = new Time(); x.t = ticks; return x; }
}

type Unit = "seconds" | "ticks";
const snap = (ticks: number) => Math.round(ticks / TPF) * TPF;

class ProjectItem {
  inS = 0; outS: number;
  rejectInAfterOut = false;
  /** Real Premiere (Checkpoint B, 2026-10-05) rounds set in/out points DOWN to the media's frame grid. */
  floorToFrames = false;
  mediaFps = FPS;
  constructor(public name: string, public nodeId: string, public durationS: number, public unit: Unit = "seconds", public hasAudio = true) {
    this.outS = durationS;
  }
  getMediaPath() { return `D:/Footage/${this.name}`; }
  getFootageInterpretation() { return { frameRate: this.mediaFps }; }
  private toSeconds(v: any) {
    const s = this.unit === "seconds" ? Number(v) : Number(v) / TICKS;
    return this.floorToFrames ? Math.floor(s * this.mediaFps) / this.mediaFps : s;
  }
  setInPoint(v: any, _m: number) {
    const s = this.toSeconds(v);
    if (this.rejectInAfterOut && s >= this.outS) throw new Error("In point after out point");
    this.inS = s; return 0;
  }
  setOutPoint(v: any, _m: number) {
    const s = this.toSeconds(v);
    if (this.rejectInAfterOut && s <= this.inS) throw new Error("Out point before in point");
    this.outS = s; return 0;
  }
  getInPoint() { return Time.s(this.inS); }
  getOutPoint() { return Time.s(this.outS); }
}

class TrackItem {
  start: Time; end: Time; inPoint: Time; outPoint: Time;
  selected = false; speed = 1; reversed = 0;
  linked: TrackItem[] = [];
  components: any;
  constructor(public track: Track, public projectItem: ProjectItem, startT: number, inS: number, durT: number, public mediaType: string) {
    this.start = Time.k(startT); this.end = Time.k(startT + durT);
    this.inPoint = Time.s(inS); this.outPoint = Time.s(inS + durT / TICKS);
    const names = mediaType === "Video" ? ["Opacity", "Motion"] : ["Volume", "Channel Volume", "Panner"];
    this.components = Object.assign(names.map((displayName) => ({ displayName })), { numItems: names.length });
  }
  get name() { return this.projectItem.name; }
  isSelected() { return this.selected; }
  getSpeed() { return this.speed; }
  isSpeedReversed() { return this.reversed; }
  addEffect(name: string) { this.components.push({ displayName: name }); this.components.numItems++; }
  remove(_r: boolean, _a: boolean) {
    const seq = this.track.seq;
    const all = seq.removeLinked ? [this, ...this.linked] : [this];
    for (const it of all) it.track.items = it.track.items.filter((i) => i !== it);
    return 0;
  }
  move(offset: Time) {
    if (this.track.locked) throw new Error("Track is locked");
    const all = this.track.seq.moveLinked ? [this, ...this.linked] : [this];
    for (const it of all) { it.start = Time.k(it.start.t + offset.t); it.end = Time.k(it.end.t + offset.t); }
    return 0;
  }
}

class Track {
  items: TrackItem[] = [];
  locked = false;
  constructor(public seq: Seq, public kind: "video" | "audio", public index: number) {}
  get clips() {
    const arr: any = [...this.items].sort((a, b) => a.start.t - b.start.t);
    arr.numItems = arr.length;
    return arr;
  }
  isLocked() { return this.locked; }
  add(pi: ProjectItem, startS: number, inS: number, outS: number) {
    return this.place(pi, Math.round(startS * TICKS), inS, Math.round((outS - inS) * TICKS));
  }
  /** Lay an item at [startT, startT+durT), overwriting (trimming/splitting/removing) whatever is there. */
  place(pi: ProjectItem, startT: number, inS: number, durT: number) {
    const endT = startT + durT;
    for (const o of [...this.items]) {
      const os = o.start.t, oe = o.end.t;
      if (oe <= startT || os >= endT) continue;
      if (os >= startT && oe <= endT) { this.items = this.items.filter((i) => i !== o); continue; }
      if (os < startT && oe > endT) { // split: keep left, add right remainder
        const right = new TrackItem(this, o.projectItem, endT, o.inPoint.seconds + (endT - os) / TICKS, oe - endT, o.mediaType);
        this.items.push(right);
        o.end = Time.k(startT); o.outPoint = Time.s(o.inPoint.seconds + (startT - os) / TICKS);
        continue;
      }
      if (os < startT) { o.end = Time.k(startT); o.outPoint = Time.s(o.inPoint.seconds + (startT - os) / TICKS); }
      else { o.inPoint = Time.s(o.inPoint.seconds + (endT - os) / TICKS); o.start = Time.k(endT); }
    }
    const it = new TrackItem(this, pi, startT, inS, durT, this.kind === "video" ? "Video" : "Audio");
    this.items.push(it);
    return it;
  }
  /** Overwrite edit: bin item's current in/out, snapped to frames, plus linked audio. */
  overwriteClip(pi: ProjectItem, ticks: string) {
    this.seq.overwriteHook(this, pi, Number(ticks));
    return true;
  }
}

class Seq {
  videoTracks: any; audioTracks: any;
  timebase = String(TPF);
  sequenceID = "seq-1";
  audioTrackFor = (videoIndex: number) => videoIndex;
  dropSpanIndex = -1;
  ignoreInOut = false;
  removeLinked = false;
  moveLinked = false;
  private placements = 0;
  constructor(nV = 2, nA = 3) {
    const v = Array.from({ length: nV }, (_, i) => new Track(this, "video", i));
    const a = Array.from({ length: nA }, (_, i) => new Track(this, "audio", i));
    this.videoTracks = Object.assign(v, { numTracks: nV });
    this.audioTracks = Object.assign(a, { numTracks: nA });
  }
  overwriteHook(track: Track, pi: ProjectItem, startT: number) {
    const n = this.placements++;
    if (n === this.dropSpanIndex) return;
    const inS = this.ignoreInOut ? 0 : pi.inS;
    const outS = this.ignoreInOut ? pi.durationS : pi.outS;
    const s = snap(startT), durT = snap(Math.round((outS - inS) * TICKS));
    const v = track.place(pi, s, inS, durT);
    if (track.kind === "video" && pi.hasAudio) {
      const a = this.audioTracks[this.audioTrackFor(track.index)].place(pi, s, inS, durT);
      v.linked = [a]; a.linked = [v];
    }
  }
}

function load(seq: Seq) {
  const sandbox: any = { app: { project: { activeSequence: seq } }, Time, $: { global: {} } };
  const ctx = vm.createContext(sandbox);
  vm.runInContext("delete this.JSON;", ctx); // ExtendScript has no JSON
  vm.runInContext(HOST_SRC, ctx);
  const call = (fn: string, arg: unknown) => {
    const out: string = (ctx as any)[fn](JSON.stringify(arg));
    if (out.startsWith("Error:")) throw new Error(out.slice(6).trim());
    return JSON.parse(out); // the panel parses with native JSON, so the tests do too
  };
  return { ctx, call };
}

/** One interview clip on V1 + A1: source 10–20 s, placed at 100 s. Bin marks 2–58 s. */
function scene(unit: Unit = "seconds") {
  const seq = new Seq();
  const pi = new ProjectItem("interview_take3.mp4", "node-1", 60, unit);
  const v = seq.videoTracks[0].add(pi, 100, 10, 20);
  const a = seq.audioTracks[0].add(pi, 100, 10, 20);
  v.linked = [a]; a.linked = [v];
  pi.inS = 2; pi.outS = 58;
  v.selected = true; a.selected = true;
  return { seq, pi, v, a, host: load(seq) };
}

/** Three synced angles (V1 wide, V2 close, V3 screen) at 100–110 s, the wide camera's own audio on
 *  A1 (same project item as V1), a music bed on A3 (90–130 s) and a title on V4 (104–106 s).
 *  The angles and A1 are selected; the music bed isn't. */
function multiScene({ music = true } = {}) {
  const seq = new Seq(4, 3);
  const wide = new ProjectItem("wide.mov", "node-w", 600);
  const close = new ProjectItem("close.mov", "node-c", 600);
  const screen = new ProjectItem("screen.mov", "node-s", 600, "seconds", false);
  const v1 = seq.videoTracks[0].add(wide, 100, 10, 20);
  const v2 = seq.videoTracks[1].add(close, 100, 12, 22);
  const v3 = seq.videoTracks[2].add(screen, 100, 5, 15);
  const a1 = seq.audioTracks[0].add(wide, 100, 10, 20);
  v1.linked = [a1]; a1.linked = [v1];
  if (music) seq.audioTracks[2].add(new ProjectItem("music.wav", "node-m", 300, "seconds", false), 90, 0, 40);
  seq.videoTracks[3].add(new ProjectItem("title", "node-t", 30, "seconds", false), 104, 0, 2);
  for (const v of [v1, v2, v3, a1]) v.selected = true;
  wide.inS = 2; wide.outS = 58; close.inS = 0; close.outS = 600;
  return { seq, wide, close, screen, v1, v2, v3, a1, host: load(seq) };
}

/** Georg's real sequence: angles hand-synced with different edges, audio running past them,
 *  a title on V4 after the clips, an unrelated clip on V3 ending just before the screen recording. */
function georgScene() {
  const seq = new Seq(4, 3);
  const a = new ProjectItem("Camera A.mov", "node-a", 900), b = new ProjectItem("Camera B.mov", "node-b", 900, "seconds", false);
  const scr = new ProjectItem("Restream.mov", "node-r", 900, "seconds", false), mic = new ProjectItem("mic.wav", "node-m", 900, "seconds", false);
  const v1 = seq.videoTracks[0].add(a, 100, 10, 20);          // 100–110
  const v2 = seq.videoTracks[1].add(b, 100.24, 30, 39.6);     // 100.24–109.84: starts 0.24 s later, ends 0.16 s earlier
  const v3 = seq.videoTracks[2].add(scr, 100.28, 5, 14.72);   // 100.28–110: starts 0.28 s later
  const a1 = seq.audioTracks[0].add(mic, 99, 50, 62);         // 99–111: runs past both ends
  seq.videoTracks[3].add(new ProjectItem("Title", "node-t", 30, "seconds", false), 112, 0, 3);
  for (const x of [v1, v2, v3, a1]) x.selected = true;
  return { seq, a, b, scr, mic, v1, v2, v3, a1, host: load(seq) };
}
const snapshot = (s: { host: ReturnType<typeof load> }, name = "") => s.host.call("gcutSnapshotSelection", name);

const START = String(100 * TICKS);
/** Cut timeline moments, in seconds from the range start: removes 102–103 and 107–108 s (keeps 8 of 10 s). */
const cuts = [{ start: 2, end: 3 }, { start: 7, end: 8 }];
/** Snapshot the selection, then apply `c` to every recorded item. */
const applyCuts = (s: any, c: unknown = cuts, snap = snapshot(s)) => {
  const items = [...snap.video, ...snap.audio].map((i: any) => ({ kind: i.kind, trackIndex: i.trackIndex, startTicks: i.startTicks, endTicks: i.endTicks }));
  return s.host.call("gcutApplyCutsMulti", { sequenceId: snap.sequenceId, startTicks: snap.startTicks, endTicks: snap.endTicks, items, cuts: c });
};
const span = (t: Track) => t.clips.map((i: TrackItem) => [+(i.start.seconds).toFixed(2), +(i.end.seconds).toFixed(2), +(i.inPoint.seconds).toFixed(2)]);
const restore = (s: ReturnType<typeof scene>) => s.host.call("gcutRestoreMulti", { startTicks: START });
const closeGap = (s: ReturnType<typeof scene>) => s.host.call("gcutCloseGapMulti", { startTicks: START });
const layout = (t: Track) => t.clips.map((i: TrackItem) => [+(i.start.seconds).toFixed(3), +(i.end.seconds).toFixed(3)]);

describe("JSON without native JSON", () => {
  it("round-trips awkward strings, and drops undefined like JSON.stringify", () => {
    const { ctx } = scene().host;
    const s = 'he said "cut" \\ \n tab\t é \u2028';
    expect(JSON.parse((ctx as any).gcutStringify({ s, n: [1, 2.5, null, true], gone: undefined }))).toEqual({ s, n: [1, 2.5, null, true] });
  });
  it("refuses anything that isn't JSON", () => {
    expect(() => (scene().host.ctx as any).gcutParse("app.quit()")).toThrow();
  });
});

describe("gcutSnapshotSelection: one clip", () => {
  it("uses the selected clip when no name is given", () => {
    const c = snapshot(scene());
    expect(c).toMatchObject({ found: true, startTicks: START, startS: 100, durationS: 10, problems: [] });
    expect(c.fps).toBe(25);
    expect(c.video).toEqual([expect.objectContaining({ label: "V1", name: "interview_take3.mp4", trackIndex: 0, inS: 10, outS: 20,
      speed: 1, effects: [], startTicks: START })]);
    expect(c.audio.map((a: any) => [a.label, a.inS])).toEqual([["A1", 10]]);
  });
  it("matches by name with or without the extension, any case", () => {
    const s = scene(); s.v.selected = false;
    expect(snapshot(s, "INTERVIEW_TAKE3").found).toBe(true);
    expect(snapshot(s, "interview_take3.MP4").found).toBe(true);
  });
  it("reports not found rather than guessing", () => {
    expect(snapshot(scene(), "b-roll")).toMatchObject({ found: false });
  });
  it("reports speed, including reversed, and refuses it in problems", () => {
    const s = scene();
    s.v.speed = 1.5; expect(snapshot(s).video[0].speed).toBe(1.5);
    s.v.reversed = 1; expect(snapshot(s).video[0].speed).toBe(-1.5);
    expect(snapshot(s).problems.join(" ")).toMatch(/V1 isn't at 100% speed/);
  });
  it("prefers the selected one of several matches", () => {
    const s = scene(); s.v.selected = false;
    s.seq.videoTracks[1].add(s.pi, 300, 0, 5).selected = true;
    expect(snapshot(s, "interview_take3").video.map((v: any) => v.trackIndex)).toEqual([1]);
  });
  it("names effects that the rebuild would remove, per clip (C2)", () => {
    const s = scene();
    s.v.addEffect("Lumetri Color");
    s.a.addEffect("Parametric Equalizer");
    const r = snapshot(s);
    expect(r.video[0].effects).toEqual(["Lumetri Color"]);
    expect(r.audio[0].effects).toEqual(["Parametric Equalizer"]);
  });
});

describe("gcutApplyCutsMulti: one clip", () => {
  it("rebuilds the kept spans back to back, on the frame grid, video and audio", () => {
    const s = scene();
    const r = applyCuts(s);
    expect(r).toMatchObject({ ok: true, appliedCount: 2 });
    expect(r.trailingGapS).toBeCloseTo(2, 1);
    const v = s.seq.videoTracks[0].clips;
    expect(v.map((i: TrackItem) => +(i.inPoint.seconds).toFixed(2))).toEqual([10, 13, 18]);
    for (let i = 1; i < v.numItems; i++) expect(v[i].start.t).toBe(v[i - 1].end.t); // no gaps, no overlaps
    expect(s.seq.audioTracks[0].clips.numItems).toBe(3);
  });

  it("I1: cuts that aren't on frames still leave pieces back to back with no gaps or overlaps", () => {
    const s = scene();
    const r = applyCuts(s, [{ start: 1.271, end: 2.5021 }, { start: 4.0417, end: 5.33 }, { start: 9.98, end: 10 }]);
    expect(r.ok).toBe(true);
    const v = s.seq.videoTracks[0].clips;
    for (let i = 0; i < v.numItems; i++) expect(v[i].start.t % TPF).toBe(0);
    for (let i = 1; i < v.numItems; i++) expect(v[i].start.t).toBe(v[i - 1].end.t);
  });

  it("Checkpoint B: works when Premiere rounds set in/out points down to whole source frames", () => {
    // Real clip, 2026-10-05: "Premiere didn't accept the source range 13.020-16.253 s." Spans
    // that start mid-frame must be snapped to the source grid before they're set.
    const s = scene();
    s.pi.floorToFrames = true;
    const r = applyCuts(s, [{ start: 2.5, end: 3.03 }, { start: 6.27, end: 7.41 }, { start: 9.97, end: 10 }]);
    expect(r).toMatchObject({ ok: true, appliedCount: 3 });
    const v = s.seq.videoTracks[0].clips;
    for (let i = 0; i < v.numItems; i++) expect(Math.abs(v[i].inPoint.seconds * FPS - Math.round(v[i].inPoint.seconds * FPS))).toBeLessThan(1e-6);
    for (let i = 1; i < v.numItems; i++) expect(v[i].start.t).toBe(v[i - 1].end.t);
    expect([s.pi.inS, s.pi.outS]).toEqual([2, 58]);
  });

  it("works when the source is an integer multiple of the sequence frame rate (50 fps in 25)", () => {
    const s = scene();
    s.pi.floorToFrames = true; s.pi.mediaFps = 50;
    expect(applyCuts(s, [{ start: 2.49, end: 3.03 }, { start: 9.97, end: 10 }])).toMatchObject({ ok: true, appliedCount: 2 });
  });

  it("refuses, changing nothing, when the source frame rate doesn't fit the sequence's (24 fps in 25)", () => {
    const s = scene();
    s.pi.mediaFps = 24;
    const before = layout(s.seq.videoTracks[0]);
    expect(() => applyCuts(s)).toThrow(/24 fps.*25 fps|frame rate/);
    expect(layout(s.seq.videoTracks[0])).toEqual(before);
  });

  it("leaves the bin item's own in/out exactly as it found them", () => {
    const s = scene();
    applyCuts(s);
    expect([s.pi.inS, s.pi.outS]).toEqual([2, 58]);
  });

  it("works when this Premiere build wants ticks instead of seconds", () => {
    const s = scene("ticks");
    expect(applyCuts(s).ok).toBe(true);
    expect(s.seq.videoTracks[0].clips[1].inPoint.seconds).toBeCloseTo(13, 2);
  });

  it("I3: works when the bin's marks sit outside the spans and Premiere rejects in > out", () => {
    const s = scene();
    s.pi.inS = 0; s.pi.outS = 1; s.pi.rejectInAfterOut = true;
    expect(applyCuts(s).ok).toBe(true);
    expect([s.pi.inS, s.pi.outS]).toEqual([0, 1]);
  });

  it("I2: stops at the first span that lands wrong, and says rollback wasn't possible", () => {
    const s = scene();
    s.seq.ignoreInOut = true; // overwriteClip lays the whole source instead of the span
    const r = applyCuts(s);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/didn't land/);
    // A world where overwriteClip ignores in/out can't be rolled back honestly either.
    expect(r.rolledBack).toBe(false);
    expect(r.message).toMatch(/Undo/);
  });

  it("C1: a failure part-way rolls back to the original clip and restores the bin", () => {
    const s = scene();
    s.seq.dropSpanIndex = 1;
    const r = applyCuts(s);
    expect(r).toMatchObject({ ok: false, rolledBack: true });
    expect(r.message).toMatch(/Every clip was put back/);
    expect(layout(s.seq.videoTracks[0])).toEqual([[100, 110]]);
    expect(layout(s.seq.audioTracks[0])).toEqual([[100, 110]]);
    expect([s.pi.inS, s.pi.outS]).toEqual([2, 58]);
  });

  it("C1: a throw part-way (Premiere rejecting a point) also rolls back", () => {
    const s = scene();
    const orig = s.pi.setInPoint.bind(s.pi);
    // Span 2's in point (13 s, exact or nudged, either unit) is always rejected: a one-off
    // rejection is now retried (Checkpoint B fix), so the refusal has to persist.
    const sec = (v: any) => (Number(v) > 1e6 ? Number(v) / TICKS : Number(v));
    s.pi.setInPoint = (v: any, m: number) => { if (Math.abs(sec(v) - 13) < 0.2) throw new Error("boom"); return orig(v, m); };
    const r = applyCuts(s);
    expect(r).toMatchObject({ ok: false, rolledBack: true });
    expect(layout(s.seq.videoTracks[0])).toEqual([[100, 110]]);
    expect([s.pi.inS, s.pi.outS]).toEqual([2, 58]);
  });

  it("C3: refuses, before changing anything, when unrecorded audio sits where linked audio could land", () => {
    const s = scene();
    const music = new ProjectItem("music.wav", "node-9", 300);
    s.seq.audioTracks[1].add(music, 90, 0, 40);
    s.seq.audioTrackFor = () => 1; // Premiere puts the rebuilt audio on A2, over the music
    const items = [{ kind: "video", trackIndex: 0 }, { kind: "audio", trackIndex: 0 }].map((i) => ({ ...i, startTicks: START, endTicks: String(110 * TICKS) }));
    expect(() => s.host.call("gcutApplyCutsMulti", { sequenceId: "seq-1", startTicks: START, endTicks: String(110 * TICKS), items, cuts }))
      .toThrow("A2 (music.wav) sits under the selected video clips, and rebuilding them could overwrite it. Select it too, or move it off the clips' time, then Analyse again.");
    expect(layout(s.seq.audioTracks[1])).toEqual([[90, 130]]);
    expect(layout(s.seq.videoTracks[0])).toEqual([[100, 110]]);
  });

  it("refuses a range that doesn't lie inside the recorded video clips, before changing anything", () => {
    const s = scene();
    const snap = snapshot(s);
    const items = [...snap.video, ...snap.audio].map((i: any) => ({ kind: i.kind, trackIndex: i.trackIndex, startTicks: i.startTicks, endTicks: i.endTicks }));
    for (const [a, b] of [[95, 110], [100, 115], [105, 105], [NaN, 110]]) {
      expect(() => s.host.call("gcutApplyCutsMulti", { sequenceId: "seq-1", startTicks: String(a * TICKS), endTicks: String(b * TICKS), items, cuts }))
        .toThrow(/changed since Analyse\. Analyse again\./);
    }
    expect(layout(s.seq.videoTracks[0])).toEqual([[100, 110]]);
    expect(layout(s.seq.audioTracks[0])).toEqual([[100, 110]]);
  });

  it("a J/L cut (linked audio runs past the video) keeps its tail, slid left by the cuts", () => {
    const s = scene();
    s.a.end = Time.s(112); s.a.outPoint = Time.s(22);
    expect(applyCuts(s)).toMatchObject({ ok: true });
    expect(span(s.seq.videoTracks[0])).toEqual([[100, 102, 10], [102, 106, 13], [106, 108, 18]]);
    expect(span(s.seq.audioTracks[0])).toEqual([[100, 102, 10], [102, 106, 13], [106, 110, 18]]);
  });

  // "C3: refuses a video-only clip whose source has audio" is gone: multi-clip accepts video
  // without its own audio by design (spec §4), as long as some audio lies under the range.

  it("I5: works when Premiere's remove also removes the linked audio", () => {
    const s = scene();
    s.seq.removeLinked = true;
    expect(applyCuts(s)).toMatchObject({ ok: true });
  });

  // "the clip moved" is covered by "refuses when a recorded clip moved since Analyse" below.
  it.each([
    ["there are no cuts", []],
    ["the only cut lies outside the clips", [{ start: 12, end: 14 }]],
    ["the only cut is shorter than half a frame", [{ start: 2, end: 2.01 }]],
  ])("refuses when %s, and changes nothing", (_label, c) => {
    const s = scene();
    expect(() => applyCuts(s, c)).toThrow("There's nothing to cut, so nothing was changed.");
    expect(s.seq.videoTracks[0].clips.numItems).toBe(1);
    expect(s.seq.audioTracks[0].clips.numItems).toBe(1);
  });

  it("refuses a retimed clip, and changes nothing", () => {
    const s = scene(); s.v.speed = 2;
    expect(() => applyCuts(s)).toThrow(/100% speed/);
    expect(s.seq.videoTracks[0].clips.numItems).toBe(1);
  });
});

describe("gcutRestoreMulti: one clip", () => {
  it("puts the original clip back exactly, audio included, and the bin untouched", () => {
    const s = scene();
    applyCuts(s);
    expect(restore(s)).toMatchObject({ ok: true });
    expect(s.seq.videoTracks[0].clips.map((i: TrackItem) => [i.start.seconds, i.end.seconds, i.inPoint.seconds, i.outPoint.seconds]))
      .toEqual([[100, 110, 10, 20]]);
    expect(layout(s.seq.audioTracks[0])).toEqual([[100, 110]]);
    expect([s.pi.inS, s.pi.outS]).toEqual([2, 58]);
  });
  it("without a Genius Cut edit this session, points at Premiere's Undo", () => {
    expect(() => restore(scene())).toThrow(/Undo/);
  });
  it("refuses if something was dropped into the gap since, rather than overwrite it", () => {
    const s = scene();
    applyCuts(s);
    s.seq.videoTracks[0].add(new ProjectItem("logo.png", "node-5", 5), 109, 0, 0.5);
    expect(() => restore(s)).toThrow(/gap/);
  });
});

describe("gcutCloseGapMulti: one clip", () => {
  let s: ReturnType<typeof scene>;
  beforeEach(() => {
    s = scene();
    const later = new ProjectItem("b-roll.mp4", "node-2", 30);
    const lv = s.seq.videoTracks[0].add(later, 110, 0, 5);
    const la = s.seq.audioTracks[0].add(later, 110, 0, 5);
    lv.linked = [la]; la.linked = [lv];
    s.seq.audioTracks[2].add(new ProjectItem("sfx.wav", "node-4", 10), 112, 0, 3);
    applyCuts(s);
  });

  it("ripples everything after the gap left by the gap, on every track", () => {
    expect(closeGap(s)).toMatchObject({ ok: true });
    const v = s.seq.videoTracks[0].clips;
    expect(v[v.numItems - 1].start.seconds).toBeCloseTo(108, 1);
    expect(s.seq.audioTracks[2].clips[0].start.seconds).toBeCloseTo(110, 1);
  });

  it("I5: moves linked audio once, even if Premiere's move also moves linked partners", () => {
    s.seq.moveLinked = true;
    expect(closeGap(s).ok).toBe(true);
    const a = s.seq.audioTracks[0].clips;
    expect(a[a.numItems - 1].start.seconds).toBeCloseTo(108, 1);
  });

  it("refuses, naming it, a clip on another track that crosses a cut, and moves nothing", () => {
    s.seq.audioTracks[1].add(new ProjectItem("music.wav", "node-3", 60), 107.5, 0, 1); // 107.5–108.5 crosses 107–108
    expect(() => closeGap(s)).toThrow("music.wav on A2 crosses a cut at 1:47.0. Move it, or close the gap by hand.");
    expect(s.seq.videoTracks[0].clips.at(-1).start.seconds).toBeCloseTo(110, 1);
  });

  it("I4: refuses on a locked track before moving anything", () => {
    s.seq.audioTracks[2].locked = true;
    expect(() => closeGap(s)).toThrow(/locked/);
    expect(s.seq.audioTracks[2].clips[0].start.seconds).toBeCloseTo(112, 1);
  });

  it("after the gap is closed, restore refuses and points at Undo", () => {
    closeGap(s);
    expect(() => restore(s)).toThrow(/Undo/);
  });
});

describe("gcutSnapshotSelection (timeline model)", () => {
  it("accepts hand-synced clips with different edges; the range is where video and audio overlap", () => {
    const r = snapshot(georgScene());
    expect(r.problems).toEqual([]);
    expect(r.video.map((v: any) => v.label)).toEqual(["V1", "V2", "V3"]);
    expect(r.audio.map((x: any) => x.label)).toEqual(["A1"]);
    expect([r.startS, r.durationS]).toEqual([100, 10]);   // R = [100,110] ∩ [99,111]
  });
  it("uses only the selected audio", () => {
    const s = georgScene();
    s.seq.audioTracks[2].add(new ProjectItem("music.wav", "node-x", 300, "seconds", false), 90, 0, 40); // unselected
    expect(snapshot(s).audio.map((x: any) => x.label)).toEqual(["A1"]);
  });
  it("prompts when no audio is selected", () => {
    const s = georgScene(); s.a1.selected = false;
    expect(snapshot(s).problems).toContain("No audio clip is selected. Select the audio Genius Cut should transcribe along with the video clips.");
  });
  it("refuses linked audio that isn't selected", () => {
    const s = multiScene({ music: false }); // A1 is V1's own audio (same node)
    s.a1.selected = false;
    s.seq.audioTracks[1].add(new ProjectItem("mic.wav", "node-m2", 900, "seconds", false), 100, 0, 10).selected = true;
    expect(snapshot(s).problems).toContain("A1 is linked to V1 but isn't selected. Select it too, or unlink it.");
  });
  it("flags unselected audio under the selected video clips (a music bed), because the rebuild could overwrite it", () => {
    const s = georgScene();
    s.seq.audioTracks[2].add(new ProjectItem("music.wav", "node-x", 300, "seconds", false), 90, 0, 40);
    expect(snapshot(s).problems).toEqual([
      "A3 (music.wav) sits under the selected video clips, and rebuilding them could overwrite it. Select it too, or move it off the clips' time, then Analyse again."]);
  });
  it("doesn't flag unselected audio that lies outside the selected video clips' time", () => {
    const s = georgScene();
    s.seq.audioTracks[2].add(new ProjectItem("sfx.wav", "node-x", 30, "seconds", false), 110, 0, 5); // starts where the video ends
    expect(snapshot(s).problems).toEqual([]);
  });
  it("doesn't count audio from a selected clip's source that lies elsewhere on the timeline as linked", () => {
    const s = multiScene({ music: false });
    s.seq.audioTracks[2].add(s.wide, 200, 40, 45); // wide.mov's audio, unselected, nowhere near V1 (100–110)
    expect(snapshot(s).problems).toEqual([]);
  });
  it("says when the selected audio doesn't overlap the video", () => {
    const s = georgScene(); s.a1.start = Time.k(200 * TICKS); s.a1.end = Time.k(210 * TICKS);
    expect(snapshot(s).problems).toContain("The selected audio doesn't overlap the selected video clips, so there's nothing to transcribe.");
  });
  // A selected item outside the range would only slide at Apply, with no cut and no explanation.
  it("names a selected audio clip that lies wholly outside the video clips' time", () => {
    const s = georgScene();
    s.seq.audioTracks[1].add(new ProjectItem("lav.wav", "node-v", 900, "seconds", false), 200, 0, 10).selected = true;
    const r = snapshot(s);
    expect([r.startS, r.durationS]).toEqual([100, 10]);
    expect(r.problems).toEqual(["A2 (lav.wav) is selected but lies outside the video clips' time. Deselect it, then Analyse again."]);
  });
  it("names a selected video clip that lies outside the selected audio's time", () => {
    const s = georgScene();
    s.seq.videoTracks[3].add(new ProjectItem("Outro.mov", "node-o", 900, "seconds", false), 120, 0, 5).selected = true;
    expect(snapshot(s).problems).toEqual(["V4 (Outro.mov) is selected but lies outside the selected audio's time. Deselect it, then Analyse again."]);
  });
});

describe("gcutSnapshotSelection", () => {
  it("records every selected video clip and the selected audio", () => {
    const r = snapshot(multiScene({ music: false }));
    expect(r).toMatchObject({ found: true, sequenceId: "seq-1", startTicks: START, durationS: 10, problems: [] });
    expect(r.video.map((v: any) => [v.label, v.name, v.inS])).toEqual([["V1", "wide.mov", 10], ["V2", "close.mov", 12], ["V3", "screen.mov", 5]]);
    expect(r.audio.map((a: any) => [a.label, a.name, a.inS])).toEqual([["A1", "wide.mov", 10]]);
  });

  it("lists a selected music bed as audio too, even though it runs past the clips (the panel then asks which to transcribe)", () => {
    const s = multiScene();
    s.seq.audioTracks[2].clips[0].selected = true;
    const r = snapshot(s);
    expect(r.audio.map((a: any) => a.label)).toEqual(["A1", "A3"]);
    expect(r).toMatchObject({ startTicks: START, durationS: 10, problems: [] }); // music runs 90–130 s; the range stays 100–110
  });

  it("selected audio items aren't counted as video or listed twice", () => {
    const s = multiScene({ music: false });
    s.a1.selected = true;
    const r = snapshot(s);
    expect(r.video).toHaveLength(3);
    expect(r.audio).toHaveLength(1);
  });

  it("flags a retimed clip", () => {
    const s = multiScene({ music: false });
    s.v3.speed = 2;
    expect(snapshot(s).problems.join(" ")).toMatch(/V3.*100% speed/);
  });

  it("reports nothing selected", () => {
    const s = multiScene();
    for (const v of [s.v1, s.v2, s.v3]) v.selected = false;
    expect(snapshot(s)).toMatchObject({ found: false, message: "No clip is selected in the timeline." });
  });

  it("with a clip name, records just that clip and the selected audio", () => {
    const r = snapshot(multiScene({ music: false }), "close");
    expect(r.video.map((v: any) => v.label)).toEqual(["V2"]);
    expect(r.audio.map((a: any) => a.label)).toEqual(["A1"]);
  });

  it("names effects per clip", () => {
    const s = multiScene({ music: false });
    s.v2.addEffect("Lumetri Color");
    const r = snapshot(s);
    expect(r.video[1].effects).toEqual(["Lumetri Color"]);
    expect(r.video[0].effects).toEqual([]);
  });
});

const pieces = (t: Track) => t.clips.map((i: TrackItem) => [+(i.start.seconds).toFixed(3), +(i.end.seconds).toFixed(3), +(i.inPoint.seconds).toFixed(3)]);

describe("gcutApplyCutsMulti", () => {
  it("cuts every recorded clip identically, back to back, each from its own source", () => {
    const s = multiScene({ music: false });
    const r = applyCuts(s);
    expect(r).toMatchObject({ ok: true, appliedCount: 2, clipCount: 4 });
    expect(r.trailingGapS).toBeCloseTo(2, 3);
    expect(pieces(s.seq.videoTracks[0])).toEqual([[100, 102, 10], [102, 106, 13], [106, 108, 18]]);
    expect(pieces(s.seq.videoTracks[1])).toEqual([[100, 102, 12], [102, 106, 15], [106, 108, 20]]);
    expect(pieces(s.seq.videoTracks[2])).toEqual([[100, 102, 5], [102, 106, 8], [106, 108, 13]]);
  });

  it("same-source camera audio ends up exactly once per piece on A1", () => {
    const s = multiScene({ music: false });
    applyCuts(s);
    expect(pieces(s.seq.audioTracks[0])).toEqual([[100, 102, 10], [102, 106, 13], [106, 108, 18]]);
    // The close-up's own audio that overwriteClip brought along (sim: lands on A2) is removed.
    expect(s.seq.audioTracks[1].clips.numItems).toBe(0);
  });

  it("leaves everything it didn't record exactly as it was (the title on V4)", () => {
    const s = multiScene({ music: false });
    applyCuts(s);
    expect(layout(s.seq.videoTracks[3])).toEqual([[104, 106]]);
  });

  it("uses the recorded clips even if the selection changed after Analyse", () => {
    const s = multiScene({ music: false });
    const snap = snapshot(s);
    for (const v of [s.v1, s.v2, s.v3]) v.selected = false;
    s.seq.videoTracks[3].clips[0].selected = true;
    expect(applyCuts(s, cuts, snap)).toMatchObject({ ok: true, clipCount: 4 });
    expect(layout(s.seq.videoTracks[3])).toEqual([[104, 106]]);
  });

  it("refuses when a different sequence is open", () => {
    const s = multiScene({ music: false });
    const snap = snapshot(s);
    s.seq.sequenceID = "seq-2";
    const before = layout(s.seq.videoTracks[0]);
    expect(() => applyCuts(s, cuts, snap)).toThrow(/different sequence/);
    expect(layout(s.seq.videoTracks[0])).toEqual(before);
  });

  it("refuses when a recorded clip moved since Analyse, naming its track", () => {
    const s = multiScene({ music: false });
    const snap = snapshot(s);
    s.v2.start = Time.k(101 * TICKS); s.v2.end = Time.k(111 * TICKS);
    expect(() => applyCuts(s, cuts, snap)).toThrow(/V2's clip changed since Analyse/);
  });

  it("refuses a locked track before changing anything", () => {
    const s = multiScene({ music: false });
    s.seq.videoTracks[2].locked = true;
    const before = layout(s.seq.videoTracks[0]);
    expect(() => applyCuts(s)).toThrow(/V3 is locked/);
    expect(layout(s.seq.videoTracks[0])).toEqual(before);
  });

  it("one piece landing wrong rolls back every clip to how it was", () => {
    const s = multiScene({ music: false });
    s.seq.dropSpanIndex = 4; // the 5th placement (V2's second piece) silently fails
    const r = applyCuts(s);
    expect(r).toMatchObject({ ok: false, rolledBack: true });
    expect(r.message).toMatch(/V2/);
    for (const [t, inS] of [[0, 10], [1, 12], [2, 5]] as const) expect(pieces(s.seq.videoTracks[t])).toEqual([[100, 110, inS]]);
    expect(pieces(s.seq.audioTracks[0])).toEqual([[100, 110, 10]]);
    expect(s.seq.audioTracks[1].clips.numItems).toBe(0);
    expect([s.wide.inS, s.wide.outS]).toEqual([2, 58]);
  });

  it("works when Premiere rounds set points down to whole source frames", () => {
    const s = multiScene({ music: false });
    for (const pi of [s.wide, s.close, s.screen]) pi.floorToFrames = true;
    expect(applyCuts(s, [{ start: 2.5, end: 3.03 }, { start: 6.27, end: 7.41 }, { start: 9.97, end: 10 }])).toMatchObject({ ok: true });
  });

  it("refuses a source whose frame rate doesn't fit the sequence's", () => {
    const s = multiScene({ music: false });
    s.close.mediaFps = 24;
    expect(() => applyCuts(s)).toThrow(/V2.*24 fps.*25 fps/);
  });

  it("refuses unrecorded audio under the clips (here added after Analyse), naming it, before changing anything", () => {
    const s = multiScene({ music: false });
    const snap = snapshot(s);
    // An angle's linked audio would land on A2 (sim) and destroy it, so it must be caught up front.
    s.seq.audioTracks[1].add(new ProjectItem("sfx.wav", "node-x", 5, "seconds", false), 103, 0, 1);
    const all = () => [...[0, 1, 2, 3].map((t) => pieces(s.seq.videoTracks[t])), ...[0, 1, 2].map((t) => pieces(s.seq.audioTracks[t]))];
    const before = all();
    expect(() => applyCuts(s, cuts, snap)).toThrow(
      "A2 (sfx.wav) sits under the selected video clips, and rebuilding them could overwrite it. Select it too, or move it off the clips' time, then Analyse again.");
    expect(all()).toEqual(before);
    expect(pieces(s.seq.audioTracks[1])).toEqual([[103, 104, 0]]);
  });
});

describe("gcutApplyCutsMulti: stash and rollback safety", () => {
  const stash = (s: ReturnType<typeof multiScene>) => (s.host.ctx as any).$.global.gcutStash;

  it("a re-apply at the same start that rolls back keeps the first edit's Restore record", () => {
    const s = multiScene({ music: false });
    expect(applyCuts(s)).toMatchObject({ ok: true });
    const first = stash(s)["m@" + START];
    expect(first).toBeTruthy();
    // Analyse the first pieces of the cut timeline (100–102 s) and apply again; it fails.
    for (const t of [0, 1, 2]) s.seq.videoTracks[t].clips[0].selected = true;
    s.seq.audioTracks[0].clips[0].selected = true;
    const snap2 = snapshot(s);
    expect(snap2).toMatchObject({ found: true, startTicks: START, problems: [] });
    s.seq.dropSpanIndex = 12; // 12 placements so far: the re-apply's first one silently fails
    expect(applyCuts(s, [{ start: 1, end: 2 }], snap2)).toMatchObject({ ok: false, rolledBack: true });
    const rec = stash(s)["m@" + START];
    expect(rec).toBe(first);
    expect([rec.startT, rec.endT, rec.rebuiltEndT]).toEqual([100 * TICKS, 110 * TICKS, 108 * TICKS]);
    expect(rec.items.map((i: any) => [i.label, i.inS])).toEqual([["V1", 10], ["V2", 12], ["V3", 5], ["A1", 10]]);
  });

  it("stray audio that won't come off fails the apply, naming the track, and says it couldn't be put back", () => {
    const s = multiScene({ music: false });
    const orig = TrackItem.prototype.remove;
    TrackItem.prototype.remove = function (this: TrackItem, r: boolean, a: boolean) {
      return this.track === s.seq.audioTracks[1] ? 0 : orig.call(this, r, a);
    };
    try {
      const r = applyCuts(s);
      expect(r).toMatchObject({ ok: false, rolledBack: false });
      expect(r.message).toMatch(/A2/);
      expect(r.message).toMatch(/couldn't be put back automatically: use Premiere's Undo/);
    } finally {
      TrackItem.prototype.remove = orig;
    }
  });

  it("an original whose remove does nothing (its tail left in the gap) fails and rolls back", () => {
    const s = multiScene({ music: false });
    s.v1.remove = () => 0;
    const r = applyCuts(s);
    expect(r).toMatchObject({ ok: false, rolledBack: true });
    expect(r.message).toMatch(/V1/);
    for (const [t, inS] of [[0, 10], [1, 12], [2, 5]] as const) expect(pieces(s.seq.videoTracks[t])).toEqual([[100, 110, inS]]);
    expect(pieces(s.seq.audioTracks[0])).toEqual([[100, 110, 10]]);
  });

  it("a failure mid-lay rolls back every clip laid so far", () => {
    const s = multiScene({ music: false });
    const v2 = s.seq.videoTracks[1], real = v2.overwriteClip.bind(v2);
    let calls = 0;
    v2.overwriteClip = (pi: ProjectItem, ticks: string) => { if (calls++ === 0) throw new Error("Premiere refused"); return real(pi, ticks); };
    const r = applyCuts(s, [{ start: 2, end: 3 }]); // V1 is laid in full before V2 throws
    expect(r).toMatchObject({ ok: false, rolledBack: true });
    for (const [t, inS] of [[0, 10], [1, 12], [2, 5]] as const) expect(pieces(s.seq.videoTracks[t])).toEqual([[100, 110, inS]]);
    expect(pieces(s.seq.audioTracks[0])).toEqual([[100, 110, 10]]);
  });
});

describe("gcutApplyCutsMulti: nothing is cut past the range", () => {
  it("a cut ending a frame past the range is clamped, so a clip starting right after keeps its first frame", () => {
    const s = multiScene({ music: false });
    const broll = new ProjectItem("broll.mov", "node-b", 60, "seconds", false);
    s.seq.videoTracks[0].add(broll, 110, 0, 5);
    const r = applyCuts(s, [{ start: 9, end: 10.04 }]);
    expect(r).toMatchObject({ ok: true, appliedCount: 1 });
    expect(r.trailingGapS).toBeCloseTo(1, 6);
    expect(pieces(s.seq.videoTracks[0])).toEqual([[100, 109, 10], [110, 115, 0]]);
    expect(pieces(s.seq.videoTracks[1])).toEqual([[100, 109, 12]]);
  });
});

describe("timeline mapping helpers", () => {
  const ctx = () => multiScene().host.ctx as any;
  const clock = { tpf: TPF };
  const at = (s: number) => Math.round(s * TICKS);

  it("gcutCutTicks: frame-snapped, sorted, merged; zero-length cuts dropped", () => {
    const c = ctx().gcutCutTicks([{ start: 7, end: 8 }, { start: 2.01, end: 3 }, { start: 2.5, end: 3.48 }, { start: 5, end: 5.01 }], at(100), clock);
    expect(c.map((x: any) => [x.startT / TICKS, x.endT / TICKS])).toEqual([[102, 103.48], [107, 108]]);
  });
  it("gcutRemovedBefore: whole cuts before t, and the part of a cut containing t", () => {
    const cutsT = [{ startT: at(102), endT: at(103) }, { startT: at(107), endT: at(108) }];
    expect([101, 102.5, 103, 107.5, 110].map((t) => ctx().gcutRemovedBefore(cutsT, at(t)) / TICKS)).toEqual([0, 0.5, 1, 1.5, 2]);
  });
  it("gcutItemPieces: an item's kept stretches, each slid by what was removed before it", () => {
    const cutsT = [{ startT: at(102), endT: at(103) }, { startT: at(107), endT: at(108) }];
    const p = ctx().gcutItemPieces({ startT: at(100.24), endT: at(109.84), inS: 30 }, cutsT, 1 / FPS);
    expect(p.map((x: any) => [x.fromT / TICKS, x.atT / TICKS, +(x.durT / TICKS).toFixed(2), +x.srcIn.toFixed(2)]))
      .toEqual([[100.24, 100.24, 1.76, 30], [103, 102, 4, 32.76], [108, 106, 1.84, 37.76]]);
  });
});

describe("gcutApplyCutsMulti (timeline mapping)", () => {
  it("removes the same timeline moments from every selected clip and keeps the hand-made offsets", () => {
    const s = georgScene();
    expect(applyCuts(s, cuts)).toMatchObject({ ok: true, clipCount: 4 });
    expect(span(s.seq.videoTracks[0])).toEqual([[100, 102, 10], [102, 106, 13], [106, 108, 18]]);
    expect(span(s.seq.videoTracks[1])).toEqual([[100.24, 102, 30], [102, 106, 32.76], [106, 107.84, 37.76]]);
    expect(span(s.seq.videoTracks[2])).toEqual([[100.28, 102, 5], [102, 106, 7.72], [106, 108, 12.72]]);
    // Audio runs past both ends: untouched before R, its tail slides left by the 2 s total.
    expect(span(s.seq.audioTracks[0])).toEqual([[99, 102, 50], [102, 106, 54], [106, 109, 59]]);
  });

  it("an item that starts after a cut slides without being cut", () => {
    const s = georgScene();
    applyCuts(s, [{ start: 0.04, end: 0.2 }]); // 100.04–100.2, entirely before V2 and V3 start
    expect(span(s.seq.videoTracks[1])).toEqual([[100.08, 109.68, 30]]);
    expect(span(s.seq.videoTracks[2])).toEqual([[100.12, 109.84, 5]]);
  });

  it("refuses when sliding would cover an unrecorded clip, and changes nothing", () => {
    const s = georgScene();
    s.seq.videoTracks[2].add(new ProjectItem("bumper.mov", "node-u", 30, "seconds", false), 99, 0, 1.28); // ends at 100.28
    const before = [0, 1, 2].map((t) => span(s.seq.videoTracks[t]));
    expect(() => applyCuts(s, [{ start: 0.04, end: 0.2 }])).toThrow(/Moving V3's clip left would cover bumper.mov on V3/);
    expect([0, 1, 2].map((t) => span(s.seq.videoTracks[t]))).toEqual(before);
  });

  it("leaves unselected clips alone (the title on V4)", () => {
    const s = georgScene();
    applyCuts(s, cuts);
    expect(span(s.seq.videoTracks[3])).toEqual([[112, 115, 0]]);
  });

  it("one piece landing wrong rolls every clip back to its own original place", () => {
    const s = georgScene();
    s.seq.dropSpanIndex = 4;
    expect(applyCuts(s, cuts)).toMatchObject({ ok: false, rolledBack: true });
    expect(span(s.seq.videoTracks[1])).toEqual([[100.24, 109.84, 30]]);
    expect(span(s.seq.audioTracks[0])).toEqual([[99, 111, 50]]);
  });

  it("refuses an empty cut list", () => {
    expect(() => applyCuts(georgScene(), [])).toThrow(/nothing to cut/);
  });

  it("Restore leaves an unselected clip of a recorded source alone (a razored head on V2)", () => {
    const s = georgScene();
    s.seq.videoTracks[1].add(s.b, 99.5, 29.26, 30); // node-b, unselected, ends where V2's selected part starts
    expect(applyCuts(s, cuts)).toMatchObject({ ok: true });
    expect(span(s.seq.videoTracks[1])).toEqual([[99.5, 100.24, 29.26], [100.24, 102, 30], [102, 106, 32.76], [106, 107.84, 37.76]]);
    expect(s.host.call("gcutRestoreMulti", { startTicks: START })).toEqual({ ok: true });
    expect(span(s.seq.videoTracks[1])).toEqual([[99.5, 100.24, 29.26], [100.24, 109.84, 30]]);
  });

  it("two selected parts of one source on one track are each cut and slid (no false 'didn't come off')", () => {
    const s = georgScene();
    s.seq.videoTracks[0].items = [];
    for (const x of [s.seq.videoTracks[0].add(s.a, 100, 10, 15), s.seq.videoTracks[0].add(s.a, 105, 15, 20)]) x.selected = true;
    expect(applyCuts(s, [{ start: 2, end: 3 }])).toMatchObject({ ok: true, clipCount: 5 });
    expect(span(s.seq.videoTracks[0])).toEqual([[100, 102, 10], [102, 104, 13], [104, 109, 15]]);
    expect(span(s.seq.audioTracks[0])).toEqual([[99, 102, 50], [102, 110, 54]]);
  });

  it("records each item's own original place, and Restore puts every one back there", () => {
    const s = georgScene();
    applyCuts(s, cuts);
    const rec = (s.host.ctx as any).$.global.gcutStash["m@" + START];
    expect(rec.items.map((i: any) => [i.label, i.startT / TICKS, i.endT / TICKS, i.inS])).toEqual(
      [["V1", 100, 110, 10], ["V2", 100.24, 109.84, 30], ["V3", 100.28, 110, 5], ["A1", 99, 111, 50]]);
    expect(rec.cutsT.map((c: any) => [c.startT / TICKS, c.endT / TICKS])).toEqual([[102, 103], [107, 108]]);
    expect(rec.rebuiltEndT).toBe(109 * TICKS);
    expect(s.host.call("gcutRestoreMulti", { startTicks: START })).toEqual({ ok: true });
    expect(span(s.seq.videoTracks[0])).toEqual([[100, 110, 10]]);
    expect(span(s.seq.videoTracks[1])).toEqual([[100.24, 109.84, 30]]);
    expect(span(s.seq.videoTracks[2])).toEqual([[100.28, 110, 5]]);
    expect(span(s.seq.audioTracks[0])).toEqual([[99, 111, 50]]);
    expect(s.seq.audioTracks[1].clips.numItems + s.seq.audioTracks[2].clips.numItems).toBe(0);
  });
});

const restoreMulti = (s: ReturnType<typeof multiScene>) => s.host.call("gcutRestoreMulti", { startTicks: START });
const closeGapMulti = (s: ReturnType<typeof multiScene>) => s.host.call("gcutCloseGapMulti", { startTicks: START });

describe("gcutRestoreMulti", () => {
  it("puts every recorded clip back exactly", () => {
    const s = multiScene({ music: false });
    applyCuts(s);
    expect(restoreMulti(s)).toEqual({ ok: true });
    for (const [t, inS] of [[0, 10], [1, 12], [2, 5]] as const) expect(pieces(s.seq.videoTracks[t])).toEqual([[100, 110, inS]]);
    expect(pieces(s.seq.audioTracks[0])).toEqual([[100, 110, 10]]);
    expect(s.seq.audioTracks[1].clips.numItems).toBe(0);
    expect(layout(s.seq.videoTracks[3])).toEqual([[104, 106]]);
    expect([s.wide.inS, s.wide.outS]).toEqual([2, 58]);
  });
  it("without an edit this session, points at Undo", () => {
    expect(() => restoreMulti(multiScene())).toThrow(/Undo/);
  });
  it("refuses, naming the track, if something was placed in the gap since", () => {
    const s = multiScene({ music: false });
    applyCuts(s);
    s.seq.audioTracks[2].add(new ProjectItem("hit.wav", "node-h", 5, "seconds", false), 108.5, 0, 1);
    expect(() => restoreMulti(s)).toThrow(/gap on A3/);
    expect(pieces(s.seq.videoTracks[0])).toEqual([[100, 102, 10], [102, 106, 13], [106, 108, 18]]);
  });
  it("refuses if something was placed over the cut clips on a recorded track since", () => {
    const s = multiScene({ music: false });
    applyCuts(s);
    s.seq.videoTracks[1].add(new ProjectItem("logo.png", "node-l", 5, "seconds", false), 101, 0, 0.5);
    expect(() => restoreMulti(s)).toThrow(/V2/);
    expect(layout(s.seq.videoTracks[1])).toContainEqual([101, 101.5]);
  });
  it("refuses, naming the track, if audio was added under the cut clips on a track it didn't record", () => {
    const s = multiScene({ music: false });
    applyCuts(s);
    // A2 holds nothing recorded, but the angles' linked audio lands there when Restore re-lays them.
    s.seq.audioTracks[1].add(new ProjectItem("sfx.wav", "node-x", 5, "seconds", false), 101, 0, 0.5);
    expect(() => restoreMulti(s)).toThrow(/A2/);
    expect(pieces(s.seq.audioTracks[1])).toEqual([[101, 101.5, 0]]);
    for (const [t, inS] of [[0, 10], [1, 12], [2, 5]] as const) {
      expect(pieces(s.seq.videoTracks[t])).toEqual([[100, 102, inS], [102, 106, inS + 3], [106, 108, inS + 8]]);
    }
    expect(pieces(s.seq.audioTracks[0])).toEqual([[100, 102, 10], [102, 106, 13], [106, 108, 18]]);
  });
  it("leaves alone a clip that already sat in the gap at Apply", () => {
    const s = multiScene({ music: false });
    s.seq.videoTracks[3].add(new ProjectItem("lower third", "node-3", 30, "seconds", false), 108.5, 0, 1);
    applyCuts(s);
    expect(restoreMulti(s)).toEqual({ ok: true });
    expect(layout(s.seq.videoTracks[3])).toEqual([[104, 106], [108.5, 109.5]]);
  });
  it("a Restore that fails part-way keeps the record, so Close gap still sees the gap", () => {
    const s = multiScene({ music: false });
    applyCuts(s);
    s.seq.dropSpanIndex = 12; // 12 placements so far: Restore's first (V1) silently fails
    expect(() => restoreMulti(s)).toThrow(/Undo/);
    const rec = (s.host.ctx as any).$.global.gcutStash["m@" + START];
    expect([rec.rebuiltEndT, rec.gapClosed]).toEqual([108 * TICKS, false]);
    // The clips that did go back whole aren't planned pieces, so Close gap sees them crossing the cuts.
    expect(() => closeGapMulti(s)).toThrow(/close\.mov on V2 crosses a cut at 1:42\.0/);
  });
});

describe("gcutCloseGapMulti", () => {
  function later(s: ReturnType<typeof multiScene>) {
    const broll = new ProjectItem("broll.mov", "node-b", 60);
    s.seq.videoTracks[0].add(broll, 110, 0, 5);
    s.seq.audioTracks[2].add(new ProjectItem("sfx.wav", "node-x", 5, "seconds", false), 112, 0, 2);
  }
  it("pulls everything after the edit left by the gap, on every track", () => {
    const s = multiScene({ music: false });
    later(s);
    applyCuts(s);
    expect(closeGapMulti(s)).toMatchObject({ ok: true });
    expect(layout(s.seq.videoTracks[0]).at(-1)).toEqual([108, 113]);
    expect(layout(s.seq.audioTracks[2])).toEqual([[110, 112]]);
  });
  it("slides a clip placed after the last cut since Apply by the total", () => {
    const s = multiScene({ music: false });
    applyCuts(s);
    s.seq.audioTracks[2].add(new ProjectItem("hit.wav", "node-h", 5, "seconds", false), 108.5, 0, 1);
    expect(closeGapMulti(s)).toEqual({ ok: true, movedCount: 2 });
    expect(layout(s.seq.audioTracks[2])).toEqual([[106.5, 107.5]]);
    expect(layout(s.seq.videoTracks[3])).toEqual([[103, 105]]); // the title (104–106) had one cut before it
  });
  it("refuses, naming it, a clip that crosses a cut, and moves nothing", () => {
    const s = multiScene({ music: false });
    later(s);
    applyCuts(s);
    s.seq.audioTracks[2].add(new ProjectItem("hit.wav", "node-h", 5, "seconds", false), 107.5, 0, 1);
    expect(() => closeGapMulti(s)).toThrow("hit.wav on A3 crosses a cut at 1:47.0. Move it, or close the gap by hand.");
    expect(layout(s.seq.videoTracks[0]).at(-1)).toEqual([110, 115]);
    expect(layout(s.seq.audioTracks[2])).toEqual([[107.5, 108.5], [112, 114]]);
  });
  it("refuses, naming the track, when a slid clip would overlap one that stays, and moves nothing", () => {
    const s = multiScene({ music: false });
    later(s);
    applyCuts(s);
    // Dropped into V1's gap after Apply: sliding it by 2 s lands it on V1's last piece (106–108).
    s.seq.videoTracks[0].add(new ProjectItem("logo.png", "node-l", 5, "seconds", false), 108.5, 0, 0.5);
    expect(() => closeGapMulti(s)).toThrow("Closing the gap would overlap a clip on V1, so nothing was moved.");
    expect(layout(s.seq.videoTracks[0]).slice(-2)).toEqual([[108.5, 109], [110, 115]]);
    expect(layout(s.seq.audioTracks[2])).toEqual([[112, 114]]);
  });
  it("leaves recorded pieces where Apply put them", () => {
    const s = multiScene({ music: false });
    later(s);
    applyCuts(s);
    closeGapMulti(s);
    expect(pieces(s.seq.videoTracks[1])).toEqual([[100, 102, 12], [102, 106, 15], [106, 108, 20]]);
    expect(pieces(s.seq.audioTracks[0])).toEqual([[100, 102, 10], [102, 106, 13], [106, 108, 18]]);
  });
  it("refuses a locked track before moving anything", () => {
    const s = multiScene({ music: false });
    later(s);
    applyCuts(s);
    s.seq.audioTracks[2].locked = true;
    expect(() => closeGapMulti(s)).toThrow(/A3 is locked/);
    expect(layout(s.seq.videoTracks[0]).at(-1)).toEqual([110, 115]);
  });
  it("after closing the gap, Restore refuses and points at Undo", () => {
    const s = multiScene({ music: false });
    applyCuts(s);
    closeGapMulti(s);
    expect(() => restoreMulti(s)).toThrow(/Undo/);
  });
  it("without an edit this session, says so", () => {
    expect(() => closeGapMulti(multiScene())).toThrow(/no Genius Cut edit/);
  });
});

describe("Restore and Close gap (timeline mapping)", () => {
  const cuts = [{ start: 2, end: 3 }, { start: 7, end: 8 }];
  it("restore returns each item to its own place", () => {
    const s = georgScene();
    applyCuts(s, cuts);
    expect(s.host.call("gcutRestoreMulti", { startTicks: START })).toEqual({ ok: true });
    expect(span(s.seq.videoTracks[0])).toEqual([[100, 110, 10]]);
    expect(span(s.seq.videoTracks[1])).toEqual([[100.24, 109.84, 30]]);
    expect(span(s.seq.videoTracks[2])).toEqual([[100.28, 110, 5]]);
    expect(span(s.seq.audioTracks[0])).toEqual([[99, 111, 50]]);
  });
  it("close gap slides unselected clips after the edit by the same amount", () => {
    const s = georgScene();
    applyCuts(s, cuts);
    expect(s.host.call("gcutCloseGapMulti", { startTicks: START })).toMatchObject({ ok: true });
    expect(span(s.seq.videoTracks[3])).toEqual([[110, 113, 0]]); // the title: 112 − 2
  });
  it("close gap refuses an unselected clip that crosses a cut, naming it", () => {
    const s = georgScene();
    s.seq.videoTracks[3].add(new ProjectItem("Lower third", "node-l", 30, "seconds", false), 101, 0, 2); // 101–103 crosses 102–103
    applyCuts(s, cuts);
    expect(() => s.host.call("gcutCloseGapMulti", { startTicks: START })).toThrow(/Lower third on V4 crosses a cut/);
  });
  it("close gap refuses a locked track before moving anything", () => {
    const s = georgScene();
    applyCuts(s, cuts);
    s.seq.videoTracks[3].locked = true;
    expect(() => s.host.call("gcutCloseGapMulti", { startTicks: START })).toThrow(/V4 is locked/);
    expect(span(s.seq.videoTracks[3])).toEqual([[112, 115, 0]]);
  });
  it("close gap slides a clip between the cuts by only the cuts before it", () => {
    const s = georgScene();
    s.seq.videoTracks[3].add(new ProjectItem("Lower third", "node-l", 30, "seconds", false), 104, 0, 2); // 104–106: one cut before it
    applyCuts(s, cuts);
    expect(s.host.call("gcutCloseGapMulti", { startTicks: START })).toEqual({ ok: true, movedCount: 2 });
    expect(span(s.seq.videoTracks[3])).toEqual([[103, 105, 0], [110, 113, 0]]);
  });
  it("close gap never moves a clip that starts before the range, even one over a cut", () => {
    const s = georgScene();
    s.seq.videoTracks[3].add(new ProjectItem("Logo", "node-l", 30, "seconds", false), 99, 0, 5); // 99–104
    applyCuts(s, cuts);
    expect(s.host.call("gcutCloseGapMulti", { startTicks: START })).toEqual({ ok: true, movedCount: 1 });
    expect(span(s.seq.videoTracks[3])).toEqual([[99, 104, 0], [110, 113, 0]]);
  });
});
