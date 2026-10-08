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

class ProjectItem {
  inS = 0; outS: number;
  rejectInAfterOut = false;
  /** Real Premiere (Checkpoint B, 2026-10-05) rounds set in/out points DOWN to the media's frame grid. */
  floorToFrames = false;
  /** Out points, and a clip's end, can't run past the end of the media (off by default). */
  clampToMedia = false;
  /** Premiere 26.5.2 (measured 2026-10-08): an out point lands a whole number of the media's frames
   *  after the in point already set, floored (off by default). */
  outFromIn = false;
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
    let s: number;
    if (this.outFromIn) {
      const raw = this.unit === "seconds" ? Number(v) : Number(v) / TICKS;
      const want = this.clampToMedia ? Math.min(raw, this.durationS) : raw;
      s = this.inS + Math.floor((want - this.inS) * this.mediaFps) / this.mediaFps;
    } else s = this.clampToMedia ? Math.min(this.toSeconds(v), this.durationS) : this.toSeconds(v);
    if (this.rejectInAfterOut && s <= this.inS) throw new Error("Out point before in point");
    this.outS = s; return 0;
  }
  getInPoint() { return Time.s(this.inS); }
  getOutPoint() { return Time.s(this.outS); }
}

class TrackItem {
  start: Time; outPoint: Time;
  /** The source time the clip really starts at; `inPoint` is what Premiere reports of it. */
  trueIn: Time;
  private _end: Time;
  selected = false; speed = 1; reversed = 0;
  linked: TrackItem[] = [];
  components: any;
  constructor(public track: Track, public projectItem: ProjectItem, startT: number, inS: number, durT: number, public mediaType: string) {
    this.start = Time.k(startT); this._end = Time.k(startT + durT);
    this.trueIn = Time.s(inS); this.outPoint = Time.s(inS + durT / TICKS);
    const names = mediaType === "Video" ? ["Opacity", "Motion"] : ["Volume", "Channel Volume", "Panner"];
    this.components = Object.assign(names.map((displayName) => ({ displayName })), { numItems: names.length });
  }
  /** Premiere 26.5.2 (measured 2026-10-08) reports the in point floored to the SEQUENCE's frames
   *  (`seq.inPointOnSeqGrid`); the simulator's own edits always use `trueIn`. */
  get inPoint() {
    if (!this.track.seq.inPointOnSeqGrid) return this.trueIn;
    const tpf = Number(this.track.seq.timebase);
    return Time.k(Math.floor(this.trueIn.t / tpf + 1e-6) * tpf);
  }
  set inPoint(v: Time) { this.trueIn = v; }
  get end() { return this._end; }
  /** A trim, as setting `end` is in Premiere: the in point stays, the out point follows. Throws when `seq.endSettable` is off. */
  set end(v: Time) {
    if (!this.track.seq.endSettable) throw new Error("end is read-only");
    let t = Number(v.ticks);
    const pi = this.projectItem;
    if (pi.clampToMedia) { // the last whole sequence frame the media still covers
      const tpf = Number(this.track.seq.timebase), last = this.start.t + (pi.durationS - this.trueIn.seconds) * TICKS;
      t = Math.min(t, Math.floor(last / tpf + 1e-9) * tpf);
    }
    this.setEnd(t);
  }
  /** The simulator's own trims (overwrites), never refused. */
  setEnd(t: number) { this._end = Time.k(t); this.outPoint = Time.s(this.trueIn.seconds + (t - this.start.t) / TICKS); }
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
    for (const it of all) { it.start = Time.k(it.start.t + offset.t); it.setEnd(it.end.t + offset.t); }
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
        const right = new TrackItem(this, o.projectItem, endT, o.trueIn.seconds + (endT - os) / TICKS, oe - endT, o.mediaType);
        this.items.push(right);
        o.setEnd(startT);
        continue;
      }
      if (os < startT) { o.setEnd(startT); }
      else { o.trueIn = Time.s(o.trueIn.seconds + (endT - os) / TICKS); o.start = Time.k(endT); }
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
  /** Placement number lateSpanIndex starts lateInS later in its source than the bin item says (a wrong placement). */
  lateSpanIndex = -1; lateInS = 0;
  ignoreInOut = false;
  endSettable = true;
  /** TrackItem.inPoint reads floored to this sequence's frames, as measured in Premiere 26.5.2. */
  inPointOnSeqGrid = false;
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
    const inS = (this.ignoreInOut ? 0 : pi.inS) + (n === this.lateSpanIndex ? this.lateInS : 0);
    const outS = (this.ignoreInOut ? pi.durationS : pi.outS) + (n === this.lateSpanIndex ? this.lateInS : 0);
    const tpf = Number(this.timebase), snap = (ticks: number) => Math.round(ticks / tpf) * tpf; // this sequence's own grid
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
    // A fitting source keeps the strict tolerances: it isn't recorded as loose.
    const v1 = (s.host.ctx as any).$.global.gcutStash["m@" + START].items[0];
    expect([v1.label, v1.loose, v1.srcFrameS]).toEqual(["V1", false, 1 / 50]);
  });

  it("applies, on the timeline's frames, a source whose frame rate doesn't fit the sequence's (24 fps in 25)", () => {
    // Was a refusal: since 2026-10-08 no clip is refused for its own frame rate.
    const s = scene();
    s.pi.mediaFps = 24;
    expect(applyCuts(s)).toMatchObject({ ok: true, appliedCount: 2 });
    expect(layout(s.seq.videoTracks[0])).toEqual([[100, 102], [102, 106], [106, 108]]);
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

  it("applies a source whose frame rate doesn't fit the sequence's (was a refusal)", () => {
    const s = multiScene({ music: false });
    s.close.mediaFps = 24;
    expect(applyCuts(s)).toMatchObject({ ok: true, clipCount: 4 });
    expect(pieces(s.seq.videoTracks[1])).toEqual([[100, 102, 12], [102, 106, 15], [106, 108, 20]]);
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
    // The clips that did go back whole aren't planned pieces, so Close gap refuses them as changed since Apply.
    expect(() => closeGapMulti(s)).toThrow("A rebuilt clip on V2 changed since Apply. Close the gap by hand.");
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

describe("audio items and the frame-rate check", () => {
  const F = 1001 / 30000; // one 29.97 fps frame, in seconds
  /** A 29.97 fps sequence: a camera on V1 and a .wav on A1, both at 100 s, both selected. */
  function ntscScene(micFps: number) {
    const seq = new Seq(1, 1);
    seq.timebase = String(Math.round(F * TICKS));
    const cam = new ProjectItem("cam.mov", "node-c", 900, "seconds", false);
    const mic = new ProjectItem("mic.wav", "node-m", 900, "seconds", false);
    cam.mediaFps = 30000 / 1001; mic.mediaFps = micFps;
    const v1 = seq.videoTracks[0].add(cam, 2997 * F, 300 * F, 600 * F);
    const a1 = seq.audioTracks[0].add(mic, 2997 * F, 1500 * F, 1800 * F);
    v1.selected = true; a1.selected = true;
    return { seq, cam, mic, v1, a1, host: load(seq) };
  }
  // Premiere may report a .wav's sample rate (or 0) as its frame rate: that mustn't refuse Apply.
  it.each([48000, 0])("applies an audio item whose frame rate reads %s, its pieces' in points on the sequence frame grid", (fps) => {
    const s = ntscScene(fps);
    expect(applyCuts(s, [{ start: 2, end: 3 }])).toMatchObject({ ok: true });
    // Audio-only (a sample rate, or no rate): neither loose nor on a grid of its own, the sequence's.
    const rec: any = Object.values((s.host.ctx as any).$.global.gcutStash)[0];
    const a1 = rec.items.find((i: any) => i.label === "A1");
    expect([a1.loose, a1.mediaFrameS]).toEqual([false, 0]);
    expect(a1.srcFrameS).toBeCloseTo(F, 12);
    const a = s.seq.audioTracks[0].clips;
    expect(a.numItems).toBe(2);
    for (let i = 0; i < a.numItems; i++) {
      const frames = a[i].inPoint.seconds / F;
      expect(Math.abs(frames - Math.round(frames))).toBeLessThan(1e-6);
    }
  });
  it("applies a video item whose frame rate doesn't fit the sequence's (was a refusal), on the sequence's frames", () => {
    const s = ntscScene(48000);
    s.cam.mediaFps = 25;
    s.v1.inPoint = Time.s(10); // a clip Premiere laid starts on one of its own frames (frame 250 at 25 fps)
    expect(applyCuts(s, [{ start: 2, end: 3 }])).toMatchObject({ ok: true });
    const tpf = Math.round(F * TICKS), v = s.seq.videoTracks[0].clips;
    // The cut is frames 3057–3087: 2997–3057 from 10 s, then 3057–3267 from 10 s + 90 sequence frames.
    expect(v.map((i: TrackItem) => [i.start.t / tpf, i.end.t / tpf])).toEqual([[2997, 3057], [3057, 3267]]);
    expect(v[0].inPoint.seconds).toBeCloseTo(10, 6);
    expect(v[1].inPoint.seconds).toBeCloseTo(10 + 90 * F, 6);
  });
});

describe("a clip whose own frame rate doesn't fit the sequence (cut on timeline time)", () => {
  const SRC_FPS = 17.364, SRC_FRAME = 1 / SRC_FPS; // Checkpoint B: Camera B, variable frame rate
  const floorSrc = (x: number) => Math.floor(x * SRC_FPS) / SRC_FPS; // where Premiere puts a set point
  const loosePi = (name: string, node: string) => {
    const pi = new ProjectItem(name, node, 900, "seconds", false);
    pi.mediaFps = SRC_FPS; pi.floorToFrames = true;
    return pi;
  };
  /** georgScene, with Camera B (V2) at 17.364 fps and Premiere flooring set points to its frames. A clip Premiere
   *  laid starts on one of its own frames, so V2 starts at floorSrc(30), not 30. */
  function looseScene() {
    const s = georgScene();
    s.b.mediaFps = SRC_FPS; s.b.floorToFrames = true;
    s.v2.inPoint = Time.s(floorSrc(30));
    return s;
  }
  const at = (sec: number) => Math.round(sec * FPS) * TPF; // a whole sequence frame, in ticks
  const ticks = (t: Track) => t.clips.map((i: TrackItem) => [i.start.t, i.end.t]);
  const stash = (s: ReturnType<typeof georgScene>) => (s.host.ctx as any).$.global.gcutStash;
  const fitting = (s: ReturnType<typeof georgScene>) => {
    expect(span(s.seq.videoTracks[0])).toEqual([[100, 102, 10], [102, 106, 13], [106, 108, 18]]);
    expect(span(s.seq.videoTracks[2])).toEqual([[100.28, 102, 5], [102, 106, 7.72], [106, 108, 12.72]]);
    expect(span(s.seq.audioTracks[0])).toEqual([[99, 102, 50], [102, 106, 54], [106, 109, 59]]);
  };
  const original = (s: ReturnType<typeof georgScene>) => {
    expect(span(s.seq.videoTracks[0])).toEqual([[100, 110, 10]]);
    expect(span(s.seq.videoTracks[2])).toEqual([[100.28, 110, 5]]);
    expect(span(s.seq.audioTracks[0])).toEqual([[99, 111, 50]]);
    const v2 = s.seq.videoTracks[1].clips;
    expect(ticks(s.seq.videoTracks[1])).toEqual([[at(100.24), at(109.84)]]);
    expect(v2[0].inPoint.seconds).toBeCloseTo(floorSrc(30), 9); // the original in point, as Premiere floors it
  };

  it("applies: every V2 piece exactly where planned, back to back, the last ending exactly at its planned end", () => {
    const s = looseScene();
    expect(applyCuts(s, cuts)).toMatchObject({ ok: true, clipCount: 4 });
    const v2 = s.seq.videoTracks[1].clips;
    expect(ticks(s.seq.videoTracks[1])).toEqual([[at(100.24), at(102)], [at(102), at(106)], [at(106), at(107.84)]]);
    // From the original in point plus the piece's offset, floored to a source frame at most.
    [0, 2.76, 7.76].forEach((off, i) => {
      const want = floorSrc(30) + off, got = v2[i].inPoint.seconds;
      expect(got).toBeLessThanOrEqual(want + 1e-9);
      expect(got).toBeGreaterThan(want - SRC_FRAME);
    });
    fitting(s);
    expect(span(s.seq.videoTracks[3])).toEqual([[112, 115, 0]]);
  });

  it("leaves no gap where Premiere's flooring would make a piece a frame short", () => {
    // V2's piece 101.00–101.44 (from 30.76 s) floors to 0.40 s when laid exact: a one-frame gap before the next.
    const s = looseScene();
    expect(applyCuts(s, [{ start: 0.52, end: 1 }, { start: 1.44, end: 2 }])).toMatchObject({ ok: true });
    expect(ticks(s.seq.videoTracks[1])).toEqual([[at(100.24), at(100.52)], [at(100.52), at(100.96)], [at(100.96), at(108.8)]]);
  });

  it("records which items are loose, with their own frame length, for Restore and Close gap", () => {
    const s = looseScene();
    applyCuts(s, cuts);
    expect(stash(s)["m@" + START].items.map((i: any) => [i.label, i.loose, i.mediaFrameS]))
      .toEqual([["V1", false, 0], ["V2", true, SRC_FRAME], ["V3", false, 0], ["A1", false, 0]]);
  });

  it("Restore puts V2 back at exactly 100.24–109.84, from its original in point", () => {
    const s = looseScene();
    applyCuts(s, cuts);
    expect(s.host.call("gcutRestoreMulti", { startTicks: START })).toEqual({ ok: true });
    original(s);
    expect(s.seq.audioTracks[1].clips.numItems + s.seq.audioTracks[2].clips.numItems).toBe(0);
  });

  it("a V2 piece landing wrong rolls every clip back to its own original place", () => {
    const s = looseScene();
    s.seq.dropSpanIndex = 4; // V1 lays 3 pieces first: the 5th placement is V2's second piece
    expect(applyCuts(s, cuts)).toMatchObject({ ok: false, rolledBack: true });
    original(s);
  });

  it("Close gap recognises the loose pieces and slides the title by the total", () => {
    const s = looseScene();
    applyCuts(s, cuts);
    expect(s.host.call("gcutCloseGapMulti", { startTicks: START })).toEqual({ ok: true, movedCount: 1 });
    expect(span(s.seq.videoTracks[3])).toEqual([[110, 113, 0]]);
    expect(ticks(s.seq.videoTracks[1])).toEqual([[at(100.24), at(102)], [at(102), at(106)], [at(106), at(107.84)]]);
  });

  /** Review probes: a loose Camera B on V1 (100–104, from 30.04 s) with an unrecorded clip X right after it (104–107). */
  function probeScene({ v2 = false, inS = 30.04 } = {}) {
    const seq = new Seq(2, 1);
    const v1 = seq.videoTracks[0].add(loosePi("Camera B.mov", "node-b"), 100, floorSrc(inS), floorSrc(inS) + 4); // on its own frames, as Premiere lays it
    seq.videoTracks[0].add(new ProjectItem("X.mov", "node-x", 900, "seconds", false), 104, 0, 3);
    const a1 = seq.audioTracks[0].add(new ProjectItem("mic.wav", "node-m", 900, "seconds", false), 99, 50, 58);
    const sel = [v1, a1];
    if (v2) sel.push(seq.videoTracks[1].add(loosePi("Camera C.mov", "node-c"), 100, floorSrc(30.16), floorSrc(30.16) + 6));
    for (const x of sel) x.selected = true;
    return { seq, host: load(seq) };
  }
  const xUntouched = (s: { seq: Seq }) => expect(span(s.seq.videoTracks[0]).at(-1)).toEqual([104, 107, 0]);

  it("probe A: Apply and Restore never touch the clip right after a loose clip, and Restore is exact", () => {
    const s = probeScene();
    expect(applyCuts(s, [{ start: 1, end: 2 }])).toMatchObject({ ok: true });
    expect(ticks(s.seq.videoTracks[0])).toEqual([[at(100), at(101)], [at(101), at(103)], [at(104), at(107)]]);
    xUntouched(s);
    expect(s.host.call("gcutRestoreMulti", { startTicks: START })).toEqual({ ok: true });
    expect(ticks(s.seq.videoTracks[0])).toEqual([[at(100), at(104)], [at(104), at(107)]]);
    expect(s.seq.videoTracks[0].clips[0].inPoint.seconds).toBeCloseTo(floorSrc(30.04), 9);
    xUntouched(s);
  });

  it("Restore re-lays a loose clip from its own original in point, not one snapped to the sequence's frames", () => {
    // The clip starts at floorSrc(30.06) = 30.0046 s; snapped to the 25 fps grid that is 30.00 s, a whole source frame earlier.
    const s = probeScene({ inS: 30.06 });
    expect(applyCuts(s, [{ start: 1, end: 2 }])).toMatchObject({ ok: true });
    expect(s.host.call("gcutRestoreMulti", { startTicks: START })).toEqual({ ok: true });
    expect(ticks(s.seq.videoTracks[0])).toEqual([[at(100), at(104)], [at(104), at(107)]]);
    expect(s.seq.videoTracks[0].clips[0].inPoint.seconds).toBeCloseTo(floorSrc(30.06), 9);
    expect(floorSrc(30.06)).not.toBeCloseTo(floorSrc(Math.round(floorSrc(30.06) * FPS) / FPS), 6);
  });

  it("probe B: an uncut loose clip is re-laid exactly, and a rollback leaves X and every clip exact", () => {
    const ok = probeScene({ v2: true });
    expect(applyCuts(ok, [{ start: 5, end: 5.48 }])).toMatchObject({ ok: true });
    expect(ticks(ok.seq.videoTracks[0])).toEqual([[at(100), at(104)], [at(104), at(107)]]);
    expect(ticks(ok.seq.videoTracks[1])).toEqual([[at(100), at(105)], [at(105), at(105.52)]]);
    xUntouched(ok);

    const bad = probeScene({ v2: true });
    bad.seq.dropSpanIndex = 2; // V1 is one placement, V2's last piece is the third
    expect(applyCuts(bad, [{ start: 5, end: 5.48 }])).toMatchObject({ ok: false, rolledBack: true });
    expect(ticks(bad.seq.videoTracks[0])).toEqual([[at(100), at(104)], [at(104), at(107)]]);
    expect(ticks(bad.seq.videoTracks[1])).toEqual([[at(100), at(106)]]);
    expect(bad.seq.videoTracks[0].clips[0].inPoint.seconds).toBeCloseTo(floorSrc(30.04), 9);
    expect(bad.seq.videoTracks[1].clips[0].inPoint.seconds).toBeCloseTo(floorSrc(30.16), 9);
    expect(span(bad.seq.audioTracks[0])).toEqual([[99, 107, 50]]);
    xUntouched(bad);
  });

  describe("in a 30 fps sequence (a source frame is longer than a sequence frame)", () => {
    const TPF30 = TICKS / 30;
    function scene30(inS: number) {
      const seq = new Seq(1, 1);
      seq.timebase = String(TPF30);
      const v1 = seq.videoTracks[0].add(loosePi("Camera B.mov", "node-b"), 100, floorSrc(inS), floorSrc(inS) + 4); // on its own frames, as Premiere lays it
      const a1 = seq.audioTracks[0].add(new ProjectItem("mic.wav", "node-m", 900, "seconds", false), 99, 50, 56);
      v1.selected = true; a1.selected = true;
      return { seq, host: load(seq) };
    }
    const f30 = (sec: number) => Math.round(sec * 30); // a time in whole 30 fps frames
    const pairs = [
      [[0.767, 0.867], [1.2, 1.433]], // the review's gap case
      [[0.5, 0.533], [0.6, 1]], [[1, 1.1], [2.9, 3.033]], [[0.1, 0.2], [3.5, 3.967]],
    ];
    const cases = pairs.flatMap((p) => Array.from({ length: 10 }, (_, k) => [30 + k / 30, p] as const));

    it.each(cases)("inS %s, cuts %j: pieces back to back on the planned frames, the last ending at its planned end", (inS, pair) => {
      const s = scene30(inS);
      expect(applyCuts(s, pair.map(([a, b]) => ({ start: a, end: b })))).toMatchObject({ ok: true });
      const cutF = pair.map(([a, b]) => [f30(100 + a), f30(100 + b)]);
      const removed = cutF.reduce((n, [a, b]) => n + b - a, 0);
      // Planned: each kept stretch lands at its start less what was cut before it.
      const kept: number[][] = [];
      let cursor = 3000;
      for (const [a, b] of cutF) { if (a > cursor) kept.push([cursor, a]); cursor = b; }
      kept.push([cursor, 3120]);
      let gone = 0;
      const plan = kept.map(([a, b], i) => { if (i) gone += cutF[i - 1][1] - cutF[i - 1][0]; return [a - gone, b - gone, a]; });
      const v = s.seq.videoTracks[0].clips;
      expect(v.map((i: TrackItem) => [i.start.t / TPF30, i.end.t / TPF30])).toEqual(plan.map(([a, b]) => [a, b]));
      expect(v.at(-1).end.t).toBe((3120 - removed) * TPF30);
      plan.forEach(([, , from], i) => expect(Math.abs(v[i].inPoint.seconds - (floorSrc(inS) + (from - 3000) / 30))).toBeLessThanOrEqual(SRC_FRAME + 1e-9));
    });
  });

  describe("a loose clip running to the very end of its source (Premiere won't go past the media's end)", () => {
    /** V1: a loose clip at 100–104 whose source ends exactly where the clip does; mic on A1 99–105. */
    function endScene(fps: number, inS: number) {
      const seq = new Seq(1, 1);
      seq.timebase = String(TICKS / fps);
      const pi = new ProjectItem("Camera B.mov", "node-b", floorSrc(inS) + 4, "seconds", false);
      pi.mediaFps = SRC_FPS; pi.floorToFrames = true; pi.clampToMedia = true;
      const v1 = seq.videoTracks[0].add(pi, 100, floorSrc(inS), floorSrc(inS) + 4); // on its own frames, as Premiere lays it
      const a1 = seq.audioTracks[0].add(new ProjectItem("mic.wav", "node-m", 900, "seconds", false), 99, 50, 56);
      v1.selected = true; a1.selected = true;
      return { seq, pi, host: load(seq) };
    }
    const frames = (s: { seq: Seq }, fps: number) =>
      s.seq.videoTracks[0].clips.map((i: TrackItem) => [Math.round(i.start.t / (TICKS / fps)), Math.round(i.end.t / (TICKS / fps))]);

    it("cut in the middle and at the end: applies with exact pieces, and Restore is exact", () => {
      const s = endScene(25, 30.07);
      expect(applyCuts(s, [{ start: 1, end: 2 }, { start: 3.6, end: 4 }])).toMatchObject({ ok: true });
      expect(frames(s, 25)).toEqual([[2500, 2525], [2525, 2565]]);
      expect(s.host.call("gcutRestoreMulti", { startTicks: START })).toEqual({ ok: true });
      expect(frames(s, 25)).toEqual([[2500, 2600]]);
      expect(s.seq.videoTracks[0].clips[0].inPoint.seconds).toBeCloseTo(floorSrc(30.07), 9);
    });

    const ins = Array.from({ length: 25 }, (_, k) => +(30 + k * 0.007).toFixed(3));
    it.each([25, 30].flatMap((fps) => ins.map((inS) => [fps, inS] as const)))(
      "%s fps, inS %s, cut in the middle: the last piece reaches the media's end exactly, and Restore puts the clip back at its exact place", (fps, inS) => {
        const s = endScene(fps, inS);
        expect(applyCuts(s, [{ start: 1, end: 2 }])).toMatchObject({ ok: true });
        expect(frames(s, fps)).toEqual([[100 * fps, 101 * fps], [101 * fps, 103 * fps]]);
        expect(s.host.call("gcutRestoreMulti", { startTicks: START })).toEqual({ ok: true });
        expect(frames(s, fps)).toEqual([[100 * fps, 104 * fps]]);
      });
  });

  it.each(["throws", "silently does nothing"])("when setting a piece's end %s, Apply rolls back and says so, every track unchanged", (how) => {
    const s = scene(); // 24 fps in 25, source points on whole seconds: the originals go back without a trim
    s.pi.mediaFps = 24; s.pi.floorToFrames = true;
    const real = Object.getOwnPropertyDescriptor(TrackItem.prototype, "end")!;
    if (how === "throws") s.seq.endSettable = false;
    else Object.defineProperty(TrackItem.prototype, "end", { ...real, set() { /* ignored */ } });
    try {
      const r = applyCuts(s);
      expect(r).toMatchObject({ ok: false, rolledBack: true });
      expect(r.message).toMatch(/Premiere wouldn't trim V1's piece to length\./);
    } finally {
      Object.defineProperty(TrackItem.prototype, "end", real);
    }
    expect(span(s.seq.videoTracks[0])).toEqual([[100, 110, 10]]);
    expect(span(s.seq.audioTracks[0])).toEqual([[100, 110, 10]]);
    expect(s.seq.audioTracks[1].clips.numItems + s.seq.audioTracks[2].clips.numItems).toBe(0);
    expect([s.pi.inS, s.pi.outS]).toEqual([2, 58]);
  });
});

describe("cuts land on whole sequence frames", () => {
  it("a range starting off the frame grid (audio starting a quarter frame after the video) still cuts on whole frames", () => {
    const s = georgScene();
    s.a1.start = Time.s(100.01); s.a1.inPoint = Time.s(51.01);
    const snap = snapshot(s);
    expect(snap.problems).toEqual([]);
    expect(snap.startS).toBeCloseTo(100.01, 6);
    expect(applyCuts(s, cuts, snap)).toMatchObject({ ok: true });
    const rec = (s.host.ctx as any).$.global.gcutStash["m@" + snap.startTicks];
    for (const c of rec.cutsT) expect([c.startT % TPF, c.endT % TPF]).toEqual([0, 0]);
    expect(rec.cutsT.map((c: any) => [c.startT / TICKS, c.endT / TICKS])).toEqual([[102, 103], [107, 108]]);
    expect(span(s.seq.videoTracks[0])).toEqual([[100, 102, 10], [102, 106, 13], [106, 108, 18]]);
  });
  it("gcutCutTicks: an off-grid start is snapped as an absolute time, and clamped to whole frames inside the range", () => {
    const ctx = multiScene().host.ctx as any;
    const at = (x: number) => Math.round(x * TICKS);
    const c = ctx.gcutCutTicks([{ start: 0, end: 0.5 }, { start: 2, end: 3 }, { start: 9.5, end: 10 }], at(100.01), { tpf: TPF }, at(110.01));
    expect(c.map((x: any) => [x.startT / TICKS, x.endT / TICKS])).toEqual([[100.04, 100.52], [102, 103], [109.52, 110]]);
  });
});

describe("Close gap after a rebuilt piece was edited", () => {
  it("refuses, naming the track, when a rebuilt piece was trimmed after Apply, and moves nothing", () => {
    const s = georgScene();
    applyCuts(s, cuts);
    // Trim the head of V1's middle piece (102–106) to 103.5: it would otherwise slide by the 1 s cut before it, a second time.
    const mid = s.seq.videoTracks[0].clips[1];
    mid.start = Time.s(103.5); mid.inPoint = Time.s(mid.inPoint.seconds + 1.5);
    const before = [0, 1, 2, 3].map((t) => span(s.seq.videoTracks[t]));
    expect(() => s.host.call("gcutCloseGapMulti", { startTicks: START })).toThrow("A rebuilt clip on V1 changed since Apply. Close the gap by hand.");
    expect([0, 1, 2, 3].map((t) => span(s.seq.videoTracks[t]))).toEqual(before);
  });
});

describe("Apply, Restore, Apply again, Close gap", () => {
  it("ends with the hand-made offsets intact and the title slid by the total", () => {
    const s = georgScene();
    expect(applyCuts(s, cuts)).toMatchObject({ ok: true });
    expect(s.host.call("gcutRestoreMulti", { startTicks: START })).toEqual({ ok: true });
    // Restore lays fresh clips: select them again, as the editor would, and Analyse again.
    for (const t of [0, 1, 2]) for (const x of s.seq.videoTracks[t].items) x.selected = true;
    for (const x of s.seq.audioTracks[0].items) x.selected = true;
    expect(applyCuts(s, cuts)).toMatchObject({ ok: true, clipCount: 4 });
    expect(s.host.call("gcutCloseGapMulti", { startTicks: START })).toEqual({ ok: true, movedCount: 1 });
    expect(span(s.seq.videoTracks[0])).toEqual([[100, 102, 10], [102, 106, 13], [106, 108, 18]]);
    expect(span(s.seq.videoTracks[1])).toEqual([[100.24, 102, 30], [102, 106, 32.76], [106, 107.84, 37.76]]);
    expect(span(s.seq.videoTracks[2])).toEqual([[100.28, 102, 5], [102, 106, 7.72], [106, 108, 12.72]]);
    expect(span(s.seq.audioTracks[0])).toEqual([[99, 102, 50], [102, 106, 54], [106, 109, 59]]);
    expect(span(s.seq.videoTracks[3])).toEqual([[110, 113, 0]]);
  });
});

describe("measured in Premiere 26.5.2: classify by EXACT frame rate, audio follows its clip", () => {
  const TPF30 = TICKS / 30, SEQ_F = 1 / 30;
  const RESTREAM = 29.9950808, CAM_B = 17.363944, CAM_A = 29.896349;
  /** As measured: set points floor to the media's own frames, and an out point lands whole frames after the in point. */
  const measured = (name: string, node: string, durationS: number, fps: number, hasAudio: boolean) => {
    const pi = new ProjectItem(name, node, durationS, "seconds", hasAudio);
    pi.mediaFps = fps; pi.floorToFrames = true; pi.outFromIn = true;
    return pi;
  };
  const ownGrid = (x: number, fps: number) => Math.floor(x * fps) / fps; // where Premiere puts a set point
  const seqGrid = (x: number) => Math.floor(x * 30 + 1e-6) / 30; // how Premiere 26.5.2 reports a track item's in point
  // Premiere lays a clip from a bin set point it has floored to the clip's own frames (785.3 → 785.29543,
  // measured), so a clip already on the timeline starts on one of its own frames.
  const RS_IN = ownGrid(785.3, RESTREAM), B_IN = ownGrid(700.1, CAM_B), A_IN = ownGrid(1002.478, CAM_A);
  /** Georg's sequence (30 fps): Restream on V1 with its own audio on A1 (0–120 s, from ≈785.3 s), Camera B
   *  on V2 (0.5–119 s), Camera A on V3 (1–121 s) whose source ends exactly where the clip does. */
  function restreamScene() {
    const seq = new Seq(3, 1);
    seq.timebase = String(TPF30); seq.inPointOnSeqGrid = true;
    const rs = measured("Restream.io.mp4", "node-r", 6219.453, RESTREAM, true);
    const camB = measured("Camera B.mov", "node-b", 3600, CAM_B, false);
    const camA = measured("Camera A.mov", "node-a", A_IN + 120, CAM_A, false);
    camA.clampToMedia = true;
    const v1 = seq.videoTracks[0].add(rs, 0, RS_IN, RS_IN + 120);
    const a1 = seq.audioTracks[0].add(rs, 0, RS_IN, RS_IN + 120);
    v1.linked = [a1]; a1.linked = [v1];
    const v2 = seq.videoTracks[1].add(camB, 0.5, B_IN, B_IN + 118.5);
    const v3 = seq.videoTracks[2].add(camA, 1, A_IN, A_IN + 120);
    for (const x of [v1, v2, v3, a1]) x.selected = true;
    return { seq, rs, camB, camA, host: load(seq) };
  }
  type Scene = ReturnType<typeof restreamScene>;
  const tracks = (s: Scene) => [s.seq.videoTracks[0], s.seq.videoTracks[1], s.seq.videoTracks[2], s.seq.audioTracks[0]];
  /** Each track's clip: [startFrame, endFrame, true source in, own frame length]. */
  const ORIGINAL: [number, number, number, number][] = [[0, 3600, RS_IN, 1 / RESTREAM], [15, 3570, B_IN, 1 / CAM_B],
    [30, 3630, A_IN, 1 / CAM_A], [0, 3600, RS_IN, 1 / RESTREAM]];
  /** Select every clip again, as the editor would after Restore lays fresh ones. */
  const reselect = (t: Track[]) => { for (const x of t) for (const i of x.items) i.selected = true; };

  it("calibration: the simulator reproduces the field readings (Premiere 26.5.2, 2026-10-08)", () => {
    const setIn = (fps: number, s: number) => { const pi = measured("x", "n-x", 7000, fps, false); pi.setInPoint(s, 4); return pi.inS; };
    expect(setIn(RESTREAM, 859.7333333)).toBeCloseTo(859.707636, 6);
    expect(setIn(CAM_A, 859.742)).toBeCloseTo(859.737077, 4); // 29.896349 is a rounded readout: 25703 frames is 29.8963493
    expect(setIn(CAM_B, 859.742)).toBeCloseTo(859.712477, 4); // 17.363944 is a rounded readout too
    // In point first, then out: the out lands whole frames after the in. Out first: floored on its own.
    const inFirst = measured("r", "n-r", 7000, RESTREAM, true);
    inFirst.setInPoint(859.7333333, 4); inFirst.setOutPoint(864.4333, 4);
    expect(inFirst.outS).toBeCloseTo(864.408, 3);
    const outFirst = measured("r", "n-r", 7000, RESTREAM, true);
    outFirst.setOutPoint(864.442, 4); outFirst.setInPoint(859.742, 4);
    expect(outFirst.outS).toBeCloseTo(864.4417, 4);
    // overwriteClip of bin 785.3–790.3 at 30000 s on V1 of a 30 fps sequence.
    const seq = new Seq(1, 1);
    seq.timebase = String(TPF30); seq.inPointOnSeqGrid = true;
    const rs = measured("Restream.io.mp4", "node-r", 6219.453, RESTREAM, true);
    rs.setInPoint(785.3, 4); rs.setOutPoint(790.3, 4);
    expect(rs.inS).toBeCloseTo(785.29543, 5);
    seq.videoTracks[0].overwriteClip(rs, String(30000 * TICKS));
    const v = seq.videoTracks[0].clips[0];
    expect([v.start.t, v.end.t]).toEqual([30000 * TICKS, 30005 * TICKS]);
    expect(v.inPoint.seconds).toBeCloseTo(785.2667, 4);
    expect(seq.audioTracks[0].clips.map((a: TrackItem) => [a.start.t, a.end.t])).toEqual([[30000 * TICKS, 30005 * TICKS]]);
  });

  describe("gcutTrueInS: a loose clip's true in point back from the one Premiere reports", () => {
    const trueIn = (r: number, fps: number) => (scene().host.ctx as any).gcutTrueInS(r, 1 / fps, SEQ_F);
    it("Restream: 785.2667 reported is 785.29543, the bin's own frame", () => {
      expect(trueIn(seqGrid(RS_IN), RESTREAM)).toBeCloseTo(785.29543, 5);
      expect(trueIn(seqGrid(RS_IN), RESTREAM)).toBeCloseTo(RS_IN, 9);
    });
    it.each([RESTREAM, CAM_A, CAM_B, 24])("%s fps in 30 (own frames longer): exact for every own frame", (fps) => {
      for (let k = 0; k < 600; k++) {
        const t = (Math.floor(800 * fps) + k) / fps;
        expect(trueIn(seqGrid(t), fps)).toBeCloseTo(t, 9);
      }
    });
    it.each([50, 47.952, 120])("%s fps in 30 (own frames shorter): an own frame in the reported sequence frame, a fixed point", (fps) => {
      for (let k = 0; k < 600; k++) {
        const r = seqGrid((Math.floor(800 * fps) + k) / fps), g = trueIn(r, fps);
        expect(g).toBeGreaterThanOrEqual(r - 1e-9);
        expect(g).toBeLessThan(r + SEQ_F);
        expect(Math.abs(g * fps - Math.round(g * fps))).toBeLessThan(1e-6);
        expect(trueIn(seqGrid(g), fps)).toBeCloseTo(g, 9);
      }
    });
  });

  it("Apply → Restore four times over: no clip drifts in its source, each goes back to its original in point", () => {
    const s = restreamScene(), orig = tracks(s).map((t) => t.clips[0].trueIn.seconds);
    for (let cycle = 0; cycle < 4; cycle++) {
      reselect(tracks(s));
      const snap = snapshot(s);
      expect(applyCuts(s, cutsOf([[73, 74.433], [79.133, 81]]), snap)).toMatchObject({ ok: true, clipCount: 4 });
      expectLayout(s, toF([[73, 74.433], [79.133, 81]]));
      expect(s.host.call("gcutRestoreMulti", { startTicks: snap.startTicks })).toEqual({ ok: true });
      expectOriginal(s);
      tracks(s).forEach((t, k) => expect(t.clips[0].trueIn.seconds, `cycle ${cycle} track ${k}`).toBeCloseTo(orig[k], 9));
    }
  });

  it.each([["on one of its own frames", true], ["off its own frames (not something Premiere lays)", false]])(
    "Camera B in 25 fps, starting %s: Apply → Restore four times over never drifts", (_, onGrid) => {
      const seq = new Seq(1, 1);
      seq.inPointOnSeqGrid = true;
      const camB = measured("Camera B.mov", "node-b", 900, CAM_B, false);
      const mic = new ProjectItem("mic.wav", "node-m", 900, "seconds", false);
      mic.mediaFps = 0;
      const inS = onGrid ? ownGrid(30, CAM_B) : 30;
      const v1 = seq.videoTracks[0].add(camB, 100.24, inS, inS + 9.6);
      seq.audioTracks[0].add(mic, 99, 50, 62);
      const s = { seq, host: load(seq) }, own = 1 / CAM_B;
      const ins: number[] = [];
      for (let cycle = 0; cycle < 4; cycle++) {
        reselect([seq.videoTracks[0], seq.audioTracks[0]]);
        const snap = snapshot(s);
        expect(applyCuts(s, cuts, snap)).toMatchObject({ ok: true });
        expect(s.host.call("gcutRestoreMulti", { startTicks: snap.startTicks })).toEqual({ ok: true });
        const v = seq.videoTracks[0].clips;
        expect(v.map((i: TrackItem) => [i.start.t, i.end.t])).toEqual([[Math.round(100.24 * FPS) * TPF, Math.round(109.84 * FPS) * TPF]]);
        ins.push(v[0].trueIn.seconds);
      }
      expect(Math.abs(ins[0] - v1.trueIn.seconds)).toBeLessThan(own);
      if (onGrid) expect(ins[0]).toBeCloseTo(inS, 9);
      for (const x of ins) expect(x).toBeCloseTo(ins[0], 9);
    });
  const removedBefore = (cutsF: number[][], t: number) => cutsF.reduce((n, [a, b]) => n + (b <= t ? b - a : a < t ? t - a : 0), 0);
  /** An item's kept pieces, the host's mapping: [atFrame, endFrame, fromFrame]. */
  const plan = (startF: number, endF: number, cutsF: number[][]) => {
    const out: number[][] = [];
    let cursor = startF;
    const push = (a: number, b: number) => { if (b > a) out.push([a - removedBefore(cutsF, a), b - removedBefore(cutsF, a), a]); };
    for (const [a, b] of cutsF) { if (b <= cursor || a >= endF) continue; push(cursor, Math.min(a, endF)); cursor = Math.max(cursor, b); }
    push(cursor, endF);
    return out;
  };
  /** Every piece exactly on its planned sequence frames, and its true source in point no later than planned and
   *  at most one sequence frame (the reported in point is floored to them) plus one own frame earlier. */
  const expectLayout = (s: Scene, cutsF: number[][]) => tracks(s).forEach((t, k) => {
    const [startF, endF, inS, ownF] = ORIGINAL[k], want = plan(startF, endF, cutsF), clips = t.clips;
    expect(clips.map((i: TrackItem) => [i.start.t, i.end.t]), `track ${k}`).toEqual(want.map(([a, b]) => [a * TPF30, b * TPF30]));
    want.forEach(([, , from], i) => {
      const planned = inS + (from - startF) / 30, got = clips[i].trueIn.seconds;
      expect(got, `track ${k} piece ${i}`).toBeLessThanOrEqual(planned + 1e-9);
      expect(got, `track ${k} piece ${i}`).toBeGreaterThan(planned - SEQ_F - ownF);
    });
  });
  const expectOriginal = (s: Scene) => expectLayout(s, []);
  const toF = (c: number[][]) => c.map(([a, b]) => [Math.round(a * 30), Math.min(Math.round(b * 30), 3600)]);
  const cutsOf = (c: number[][]) => c.map(([start, end]) => ({ start, end }));

  it("records every Restream, Camera A and Camera B item as loose, the Restream audio too, with its own frame length", () => {
    const s = restreamScene();
    expect(applyCuts(s, cutsOf([[73, 74.433], [79.133, 81]]))).toMatchObject({ ok: true, clipCount: 4 });
    const rec: any = Object.values((s.host.ctx as any).$.global.gcutStash)[0];
    expect(rec.items.map((i: any) => [i.label, i.loose, i.mediaFrameS, i.srcFrameS]))
      .toEqual([["V1", true, 1 / RESTREAM, SEQ_F], ["V2", true, 1 / CAM_B, SEQ_F], ["V3", true, 1 / CAM_A, SEQ_F], ["A1", true, 1 / RESTREAM, SEQ_F]]);
  });

  // The pair that failed on 2026-10-08 (kept source ≈ 859.733–864.433 s on Restream), cuts at the start and at the
  // end of the range, and a sweep of pairs across the clips.
  const sweep = Array.from({ length: 24 }, (_, k) => {
    const a = 2 + k * 4.71 + (k % 7) * 0.0333;
    return [[a, a + 0.4 + (k % 5) * 0.317], [a + 1.9 + (k % 3) * 0.271, a + 2.5 + (k % 4) * 0.5]];
  });
  const cases: number[][][] = [[[73, 74.433], [79.133, 81]], [[0, 0.7], [118.5, 120]], [[0.2, 0.633], [119.9, 120]], ...sweep];

  it.each(cases)("cuts %j: Apply lays every track exactly on the sequence frames, back to back; Restore puts every clip back at its exact original place", (...c) => {
    const s = restreamScene(), snap = snapshot(s);
    expect(applyCuts(s, cutsOf(c), snap)).toMatchObject({ ok: true, clipCount: 4 });
    expectLayout(s, toF(c));
    for (const t of tracks(s)) for (let i = 1; i < t.clips.numItems; i++) expect(t.clips[i].start.t).toBe(t.clips[i - 1].end.t);
    expect(s.host.call("gcutRestoreMulti", { startTicks: snap.startTicks })).toEqual({ ok: true });
    expectOriginal(s);
  });

  it.each(cases)("cuts %j: a piece landing wrong rolls every clip back to its exact original place", (...c) => {
    const s = restreamScene();
    s.seq.dropSpanIndex = plan(0, 3600, toF(c)).length; // V2's first piece: V1's pieces are laid first
    expect(applyCuts(s, cutsOf(c))).toMatchObject({ ok: false, rolledBack: true });
    expectOriginal(s);
  });

  it("accepts a piece whose reported in point is floored twice (its own frames, then the sequence's)", () => {
    // Camera A alone at 100–104 s from A_IN; the mic is an audio-only file. Find a piece whose planned source time
    // Premiere reports more than half a sequence frame plus one of Camera A's frames early.
    const seq = new Seq(1, 1);
    seq.timebase = String(TPF30); seq.inPointOnSeqGrid = true;
    const camA = measured("Camera A.mov", "node-a", A_IN + 120, CAM_A, false);
    const mic = new ProjectItem("mic.wav", "node-m", 900, "seconds", false);
    mic.mediaFps = 0;
    const v1 = seq.videoTracks[0].add(camA, 100, A_IN, A_IN + 4);
    const a1 = seq.audioTracks[0].add(mic, 100, 50, 54);
    v1.selected = true; a1.selected = true;
    const s = { seq, host: load(seq) };
    const reported = (p: number) => seqGrid(ownGrid(p, CAM_A));
    const j = Array.from({ length: 104 }, (_, k) => k + 16).find((k) => reported(A_IN + k / 30) < A_IN + k / 30 - SEQ_F / 2 - 1 / CAM_A)!;
    expect(j).toBeDefined();
    expect(applyCuts(s, [{ start: j / 30 - 0.5, end: j / 30 }])).toMatchObject({ ok: true });
    const piece = seq.videoTracks[0].clips[1];
    expect(piece.start.t).toBe((3000 + j - 15) * TPF30);
    expect(piece.inPoint.seconds).toBeCloseTo(reported(A_IN + j / 30), 9);
  });

  it("refuses a piece laid one of its own frames late in its source, even where that reads within half a frame of the plan", () => {
    // Camera B alone at 100–104 s, from one of its own frames that sits in the later half of a sequence frame, so
    // every planned source time does too: one source frame late, Premiere can report a sequence frame that is
    // past the plan by under half a frame.
    const IN = Array.from({ length: 40 }, (_, m) => ownGrid(B_IN + m / CAM_B + 1e-9, CAM_B)).find((x) => {
      const frac = x * 30 - Math.floor(x * 30);
      return frac > 0.55 && frac < 0.95;
    })!;
    const j = Array.from({ length: 80 }, (_, k) => k + 20).find((k) => {
      const p = IN + k / 30, late = seqGrid(ownGrid(p, CAM_B) + 1 / CAM_B);
      return late > p && late <= p + SEQ_F / 2;
    })!;
    expect([IN, j].every((x) => x !== undefined)).toBe(true);
    const seq = new Seq(1, 1);
    seq.timebase = String(TPF30); seq.inPointOnSeqGrid = true;
    const camB = measured("Camera B.mov", "node-b", 3600, CAM_B, false);
    const mic = new ProjectItem("mic.wav", "node-m", 900, "seconds", false);
    mic.mediaFps = 0;
    const v1 = seq.videoTracks[0].add(camB, 100, IN, IN + 4);
    const a1 = seq.audioTracks[0].add(mic, 100, 50, 54);
    v1.selected = true; a1.selected = true;
    const s = { seq, host: load(seq) };
    seq.lateSpanIndex = 1; seq.lateInS = 1 / CAM_B; // the piece after the cut
    const r = applyCuts(s, [{ start: (j - 15) / 30, end: j / 30 }]);
    expect(r).toMatchObject({ ok: false, rolledBack: true });
    expect(r.message).toMatch(/Kept span 2 of 2 on V1 didn't land/);
    expect(seq.videoTracks[0].clips.map((i: TrackItem) => [i.start.t, i.end.t])).toEqual([[3000 * TPF30, 3120 * TPF30]]);
    expect(seq.videoTracks[0].clips[0].trueIn.seconds).toBeCloseTo(IN, 9);
  });

  describe("a source at exactly the sequence's rate, or a whole multiple, stays fitting (strict)", () => {
    const F = 1001 / 30000;
    it.each([30000 / 1001, 29.97, 60000 / 1001, 59.94])("%s fps in a 29.97 fps sequence", (fps) => {
      const seq = new Seq(1, 1);
      seq.timebase = String(Math.round(F * TICKS)); seq.inPointOnSeqGrid = true;
      const cam = measured("cam.mov", "node-c", 900, fps, true);
      const v1 = seq.videoTracks[0].add(cam, 2997 * F, 300 * F, 600 * F);
      const a1 = seq.audioTracks[0].add(cam, 2997 * F, 300 * F, 600 * F);
      v1.linked = [a1]; a1.linked = [v1]; v1.selected = true; a1.selected = true;
      const s = { seq, host: load(seq) };
      expect(applyCuts(s, [{ start: 2, end: 3.5 }, { start: 6.1, end: 7 }])).toMatchObject({ ok: true });
      const rec: any = Object.values((s.host.ctx as any).$.global.gcutStash)[0];
      expect(rec.items.map((i: any) => [i.label, i.loose, i.srcFrameS])).toEqual([["V1", false, 1 / fps], ["A1", false, 1 / fps]]);
      const tpf = Math.round(F * TICKS);
      for (const t of [seq.videoTracks[0], seq.audioTracks[0]]) {
        expect(t.clips.map((i: TrackItem) => [i.start.t / tpf, i.end.t / tpf])).toEqual([[2997, 3057], [3057, 3135], [3135, 3225]]);
      }
    });
    it.each([["on the sequence grid", true], ["as it is", false]])(
      "59.94 in 29.97, a clip from an odd 59.94 frame, its in point reported %s: Apply and Restore land exactly", (_, onSeqGrid) => {
        const F2 = 1001 / 60000, tpf = Math.round(F * TICKS);
        const seq = new Seq(1, 1);
        seq.timebase = String(tpf); seq.inPointOnSeqGrid = onSeqGrid;
        const cam = measured("cam.mov", "node-c", 900, 60000 / 1001, false);
        const mic = new ProjectItem("mic.wav", "node-m", 900, "seconds", false);
        mic.mediaFps = 0;
        const v1 = seq.videoTracks[0].add(cam, 2997 * F, 601 * F2, 601 * F2 + 300 * F);
        const a1 = seq.audioTracks[0].add(mic, 2997 * F, 1500 * F, 1800 * F);
        v1.selected = true; a1.selected = true;
        const s = { seq, host: load(seq) }, snap = snapshot(s);
        expect(applyCuts(s, [{ start: 2, end: 3.5 }, { start: 6.1, end: 7 }], snap)).toMatchObject({ ok: true });
        const v = seq.videoTracks[0].clips;
        expect(v.map((i: TrackItem) => [i.start.t / tpf, i.end.t / tpf])).toEqual([[2997, 3057], [3057, 3135], [3135, 3225]]);
        // The source's own frames: odd ones when Premiere reports the in point as it is.
        const first = Math.round(v[0].trueIn.seconds / F2);
        expect(Math.abs(v[0].trueIn.seconds / F2 - first)).toBeLessThan(1e-6);
        expect(first).toBe(onSeqGrid ? 600 : 601);
        expect(s.host.call("gcutRestoreMulti", { startTicks: snap.startTicks })).toEqual({ ok: true });
        expect(seq.videoTracks[0].clips.map((i: TrackItem) => [i.start.t / tpf, i.end.t / tpf])).toEqual([[2997, 3297]]);
      });
  });
});
