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
  v.selected = true;
  return { seq, pi, v, a, host: load(seq) };
}

/** Three synced angles (V1 wide, V2 close, V3 screen) at 100–110 s, the wide camera's own audio on
 *  A1 (same project item as V1), a music bed on A3 (90–130 s) and a title on V4 (104–106 s). */
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
  for (const v of [v1, v2, v3]) v.selected = true;
  wide.inS = 2; wide.outS = 58; close.inS = 0; close.outS = 600;
  return { seq, wide, close, screen, v1, v2, v3, a1, host: load(seq) };
}
const snapshot = (s: { host: ReturnType<typeof load> }, name = "") => s.host.call("gcutSnapshotSelection", name);

const START = String(100 * TICKS);
const spans = [{ start: 10, end: 12 }, { start: 13, end: 17 }, { start: 18, end: 20 }]; // keeps 8 of 10 s
const apply = (s: ReturnType<typeof scene>, sp: unknown = spans) => s.host.call("gcutApplyCuts", { trackIndex: 0, startTicks: START, spans: sp });
const restore = (s: ReturnType<typeof scene>) => s.host.call("gcutRestoreOriginal", { trackIndex: 0, startTicks: START });
const closeGap = (s: ReturnType<typeof scene>) => s.host.call("gcutCloseTrailingGap", { trackIndex: 0, startTicks: START });
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

describe("gcutFindClip", () => {
  it("uses the selected clip when no name is given", () => {
    const c = scene().host.call("gcutFindClip", "");
    expect(c).toMatchObject({ found: true, name: "interview_take3.mp4", trackIndex: 0, inS: 10, outS: 20, startS: 100,
      matchCount: 1, selectedUsed: true, speed: 1, effects: [], startTicks: START });
    expect(c.fps).toBe(25);
  });
  it("matches by name with or without the extension, any case", () => {
    const s = scene(); s.v.selected = false;
    expect(s.host.call("gcutFindClip", "INTERVIEW_TAKE3").found).toBe(true);
  });
  it("reports not found rather than guessing", () => {
    expect(scene().host.call("gcutFindClip", "b-roll")).toMatchObject({ found: false });
  });
  it("reports speed, including reversed", () => {
    const s = scene();
    s.v.speed = 1.5; expect(s.host.call("gcutFindClip", "").speed).toBe(1.5);
    s.v.reversed = 1; expect(s.host.call("gcutFindClip", "").speed).toBe(-1.5);
  });
  it("prefers the selected one of several matches and says how many there were", () => {
    const s = scene(); s.v.selected = false;
    s.seq.videoTracks[1].add(s.pi, 300, 0, 5).selected = true;
    expect(s.host.call("gcutFindClip", "interview_take3")).toMatchObject({ trackIndex: 1, matchCount: 2, selectedUsed: true });
  });
  it("names effects that the rebuild would remove (C2)", () => {
    const s = scene();
    s.v.addEffect("Lumetri Color");
    s.a.addEffect("Parametric Equalizer");
    expect(s.host.call("gcutFindClip", "").effects).toEqual(["Lumetri Color", "Parametric Equalizer"]);
  });
});

describe("gcutApplyCuts", () => {
  it("rebuilds the kept spans back to back, on the frame grid, video and audio", () => {
    const s = scene();
    const r = apply(s);
    expect(r).toMatchObject({ ok: true, appliedCount: 3 });
    expect(r.trailingGapS).toBeCloseTo(2, 1);
    const v = s.seq.videoTracks[0].clips;
    expect(v.map((i: TrackItem) => +(i.inPoint.seconds).toFixed(2))).toEqual([10, 13, 18]);
    for (let i = 1; i < v.numItems; i++) expect(v[i].start.t).toBe(v[i - 1].end.t); // no gaps, no overlaps
    expect(s.seq.audioTracks[0].clips.numItems).toBe(3);
  });

  it("I1: spans that aren't on frames still land back to back with no gaps or overlaps", () => {
    const s = scene();
    const r = apply(s, [{ start: 10.013, end: 11.271 }, { start: 12.5021, end: 14.0417 }, { start: 15.33, end: 19.98 }]);
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
    const r = apply(s, [{ start: 10, end: 12.5 }, { start: 13.03, end: 16.27 }, { start: 17.41, end: 19.97 }]);
    expect(r).toMatchObject({ ok: true, appliedCount: 3 });
    const v = s.seq.videoTracks[0].clips;
    for (let i = 0; i < v.numItems; i++) expect(Math.abs(v[i].inPoint.seconds * FPS - Math.round(v[i].inPoint.seconds * FPS))).toBeLessThan(1e-6);
    for (let i = 1; i < v.numItems; i++) expect(v[i].start.t).toBe(v[i - 1].end.t);
    expect([s.pi.inS, s.pi.outS]).toEqual([2, 58]);
  });

  it("works when the source is an integer multiple of the sequence frame rate (50 fps in 25)", () => {
    const s = scene();
    s.pi.floorToFrames = true; s.pi.mediaFps = 50;
    expect(apply(s, [{ start: 10.011, end: 12.49 }, { start: 13.03, end: 19.97 }])).toMatchObject({ ok: true, appliedCount: 2 });
  });

  it("refuses, changing nothing, when the source frame rate doesn't fit the sequence's (24 fps in 25)", () => {
    const s = scene();
    s.pi.mediaFps = 24;
    const before = layout(s.seq.videoTracks[0]);
    expect(() => apply(s)).toThrow(/24 fps.*25 fps|frame rate/);
    expect(layout(s.seq.videoTracks[0])).toEqual(before);
  });

  it("leaves the bin item's own in/out exactly as it found them", () => {
    const s = scene();
    apply(s);
    expect([s.pi.inS, s.pi.outS]).toEqual([2, 58]);
  });

  it("works when this Premiere build wants ticks instead of seconds", () => {
    const s = scene("ticks");
    expect(apply(s).ok).toBe(true);
    expect(s.seq.videoTracks[0].clips[1].inPoint.seconds).toBeCloseTo(13, 2);
  });

  it("I3: works when the bin's marks sit outside the spans and Premiere rejects in > out", () => {
    const s = scene();
    s.pi.inS = 0; s.pi.outS = 1; s.pi.rejectInAfterOut = true;
    expect(apply(s).ok).toBe(true);
    expect([s.pi.inS, s.pi.outS]).toEqual([0, 1]);
  });

  it("I2: stops at the first span that lands wrong, and says rollback wasn't possible", () => {
    const s = scene();
    s.seq.ignoreInOut = true; // overwriteClip lays the whole source instead of the span
    const r = apply(s);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/didn't land/);
    // A world where overwriteClip ignores in/out can't be rolled back honestly either.
    expect(r.rolledBack).toBe(false);
    expect(r.message).toMatch(/Undo/);
  });

  it("C1: a failure part-way rolls back to the original clip and restores the bin", () => {
    const s = scene();
    s.seq.dropSpanIndex = 1;
    const r = apply(s);
    expect(r).toMatchObject({ ok: false, rolledBack: true });
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
    const r = apply(s);
    expect(r).toMatchObject({ ok: false, rolledBack: true });
    expect(layout(s.seq.videoTracks[0])).toEqual([[100, 110]]);
    expect([s.pi.inS, s.pi.outS]).toEqual([2, 58]);
  });

  it("C3: refuses when audio landing elsewhere would overwrite other audio — and reports it", () => {
    const s = scene();
    const music = new ProjectItem("music.wav", "node-9", 300);
    s.seq.audioTracks[1].add(music, 90, 0, 40);
    s.seq.audioTrackFor = () => 1; // Premiere puts the rebuilt audio on A2, over the music
    const r = apply(s);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/A2/);
  });

  it("C3: refuses a J/L cut (linked audio extends past the video) before changing anything", () => {
    const s = scene();
    s.a.end = Time.s(112); s.a.outPoint = Time.s(22);
    expect(() => apply(s)).toThrow(/J\/L|split or extended/);
    expect(s.seq.videoTracks[0].clips.numItems).toBe(1);
  });

  it("C3: refuses a video-only clip whose source has audio, before changing anything", () => {
    const s = scene();
    s.seq.audioTracks[0].items = []; // scratch audio deleted in favour of a separate recording
    const lav = new ProjectItem("lav.wav", "node-7", 300);
    s.seq.audioTracks[0].add(lav, 100, 50, 60);
    expect(() => apply(s)).toThrow(/audio isn't linked/);
    expect(layout(s.seq.audioTracks[0])).toEqual([[100, 110]]);
  });

  it("I5: works when Premiere's remove also removes the linked audio", () => {
    const s = scene();
    s.seq.removeLinked = true;
    expect(apply(s).ok).toBe(true);
  });

  it.each([
    ["the clip moved", { startTicks: String(99 * TICKS) }, /moved or changed/],
    ["spans outside the clip", { spans: [{ start: 5, end: 12 }] }, /outside the clip/],
    ["overlapping spans", { spans: [{ start: 10, end: 14 }, { start: 13, end: 15 }] }, /overlap/],
    ["nothing kept", { spans: [] }, /nothing to keep/i],
    ["a span shorter than a frame", { spans: [{ start: 10, end: 10.01 }] }, /shorter than a frame/],
  ])("refuses when %s, and changes nothing", (_label, patch, msg) => {
    const s = scene();
    expect(() => s.host.call("gcutApplyCuts", { trackIndex: 0, startTicks: START, spans, ...patch })).toThrow(msg);
    expect(s.seq.videoTracks[0].clips.numItems).toBe(1);
    expect(s.seq.audioTracks[0].clips.numItems).toBe(1);
  });

  it("refuses a retimed clip, and changes nothing", () => {
    const s = scene(); s.v.speed = 2;
    expect(() => apply(s)).toThrow(/100% speed/);
    expect(s.seq.videoTracks[0].clips.numItems).toBe(1);
  });
});

describe("gcutRestoreOriginal", () => {
  it("puts the original clip back exactly, audio included, and the bin untouched", () => {
    const s = scene();
    apply(s);
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
    apply(s);
    s.seq.videoTracks[0].add(new ProjectItem("logo.png", "node-5", 5), 109, 0, 0.5);
    expect(() => restore(s)).toThrow(/gap/);
  });
});

describe("gcutCloseTrailingGap", () => {
  let s: ReturnType<typeof scene>;
  beforeEach(() => {
    s = scene();
    const later = new ProjectItem("b-roll.mp4", "node-2", 30);
    const lv = s.seq.videoTracks[0].add(later, 110, 0, 5);
    const la = s.seq.audioTracks[0].add(later, 110, 0, 5);
    lv.linked = [la]; la.linked = [lv];
    s.seq.audioTracks[2].add(new ProjectItem("sfx.wav", "node-4", 10), 112, 0, 3);
    apply(s);
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

  it("refuses if anything on another track sits inside the gap", () => {
    s.seq.audioTracks[1].add(new ProjectItem("music.wav", "node-3", 60), 109, 0, 0.5);
    expect(() => closeGap(s)).toThrow(/A2 sits inside the gap/);
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

describe("gcutSnapshotSelection", () => {
  it("records every selected video clip and the audio under them", () => {
    const r = snapshot(multiScene({ music: false }));
    expect(r).toMatchObject({ found: true, sequenceId: "seq-1", startTicks: START, durationS: 10, problems: [] });
    expect(r.video.map((v: any) => [v.label, v.name, v.inS])).toEqual([["V1", "wide.mov", 10], ["V2", "close.mov", 12], ["V3", "screen.mov", 5]]);
    expect(r.audio.map((a: any) => [a.label, a.name, a.inS])).toEqual([["A1", "wide.mov", 10]]);
  });

  it("lists a music bed under the clips as audio too (the panel then asks which to transcribe)", () => {
    const r = snapshot(multiScene());
    expect(r.audio.map((a: any) => a.label)).toEqual(["A1", "A3"]);
    expect(r.problems[0]).toMatch(/A3.*past|J\/L/); // music runs 90–130 s: beyond the range, refused as a J/L-style overhang
  });

  it("selected audio items aren't counted as video or listed twice", () => {
    const s = multiScene({ music: false });
    s.a1.selected = true;
    const r = snapshot(s);
    expect(r.video).toHaveLength(3);
    expect(r.audio).toHaveLength(1);
  });

  it("flags clips that don't start and end together, naming the track and the offset", () => {
    const s = multiScene({ music: false });
    s.v2.start = Time.k(103 * TICKS); s.v2.end = Time.k(113 * TICKS);
    expect(snapshot(s).problems.join(" ")).toMatch(/V2.*3\.00 s.*start and end together/);
  });

  it("says when there's no audio under the clips", () => {
    const s = multiScene({ music: false });
    s.seq.audioTracks[0].items = [];
    expect(snapshot(s).problems).toContain("No audio on the timeline under these clips.");
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

  it("with a clip name, records just that clip and the audio under it", () => {
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

const rel = [{ start: 0, end: 2 }, { start: 3, end: 7 }, { start: 8, end: 10 }]; // keeps 8 of 10 s
function applyMulti(s: ReturnType<typeof multiScene>, spans: unknown = rel, snap = snapshot(s)) {
  const items = [...snap.video, ...snap.audio].map((i: any) => ({ kind: i.kind, trackIndex: i.trackIndex, startTicks: i.startTicks, endTicks: i.endTicks }));
  return s.host.call("gcutApplyCutsMulti", { sequenceId: snap.sequenceId, startTicks: snap.startTicks, endTicks: snap.endTicks, items, spans });
}
const pieces = (t: Track) => t.clips.map((i: TrackItem) => [+(i.start.seconds).toFixed(3), +(i.end.seconds).toFixed(3), +(i.inPoint.seconds).toFixed(3)]);

describe("gcutApplyCutsMulti", () => {
  it("cuts every recorded clip identically, back to back, each from its own source", () => {
    const s = multiScene({ music: false });
    const r = applyMulti(s);
    expect(r).toMatchObject({ ok: true, appliedCount: 3, clipCount: 4 });
    expect(r.trailingGapS).toBeCloseTo(2, 3);
    expect(pieces(s.seq.videoTracks[0])).toEqual([[100, 102, 10], [102, 106, 13], [106, 108, 18]]);
    expect(pieces(s.seq.videoTracks[1])).toEqual([[100, 102, 12], [102, 106, 15], [106, 108, 20]]);
    expect(pieces(s.seq.videoTracks[2])).toEqual([[100, 102, 5], [102, 106, 8], [106, 108, 13]]);
  });

  it("same-source camera audio ends up exactly once per piece on A1", () => {
    const s = multiScene({ music: false });
    applyMulti(s);
    expect(pieces(s.seq.audioTracks[0])).toEqual([[100, 102, 10], [102, 106, 13], [106, 108, 18]]);
    // The close-up's own audio that overwriteClip brought along (sim: lands on A2) is removed.
    expect(s.seq.audioTracks[1].clips.numItems).toBe(0);
  });

  it("leaves everything it didn't record exactly as it was (the title on V4)", () => {
    const s = multiScene({ music: false });
    applyMulti(s);
    expect(layout(s.seq.videoTracks[3])).toEqual([[104, 106]]);
  });

  it("uses the recorded clips even if the selection changed after Analyse", () => {
    const s = multiScene({ music: false });
    const snap = snapshot(s);
    for (const v of [s.v1, s.v2, s.v3]) v.selected = false;
    s.seq.videoTracks[3].clips[0].selected = true;
    expect(applyMulti(s, rel, snap)).toMatchObject({ ok: true, clipCount: 4 });
    expect(layout(s.seq.videoTracks[3])).toEqual([[104, 106]]);
  });

  it("refuses when a different sequence is open", () => {
    const s = multiScene({ music: false });
    const snap = snapshot(s);
    s.seq.sequenceID = "seq-2";
    const before = layout(s.seq.videoTracks[0]);
    expect(() => applyMulti(s, rel, snap)).toThrow(/different sequence/);
    expect(layout(s.seq.videoTracks[0])).toEqual(before);
  });

  it("refuses when a recorded clip moved since Analyse, naming its track", () => {
    const s = multiScene({ music: false });
    const snap = snapshot(s);
    s.v2.start = Time.k(101 * TICKS); s.v2.end = Time.k(111 * TICKS);
    expect(() => applyMulti(s, rel, snap)).toThrow(/V2's clip changed since Analyse/);
  });

  it("refuses a locked track before changing anything", () => {
    const s = multiScene({ music: false });
    s.seq.videoTracks[2].locked = true;
    const before = layout(s.seq.videoTracks[0]);
    expect(() => applyMulti(s)).toThrow(/V3 is locked/);
    expect(layout(s.seq.videoTracks[0])).toEqual(before);
  });

  it("one piece landing wrong rolls back every clip to how it was", () => {
    const s = multiScene({ music: false });
    s.seq.dropSpanIndex = 4; // the 5th placement (V2's second piece) silently fails
    const r = applyMulti(s);
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
    expect(applyMulti(s, [{ start: 0, end: 2.5 }, { start: 3.03, end: 6.27 }, { start: 7.41, end: 9.97 }])).toMatchObject({ ok: true });
  });

  it("refuses a source whose frame rate doesn't fit the sequence's", () => {
    const s = multiScene({ music: false });
    s.close.mediaFps = 24;
    expect(() => applyMulti(s)).toThrow(/V2.*24 fps.*25 fps/);
  });
});

describe("gcutApplyCutsMulti: items that don't cover the whole range", () => {
  it("refuses a short audio item inside the range, in the snapshot and in apply, changing nothing", () => {
    const s = multiScene({ music: false });
    s.seq.audioTracks[1].add(s.close, 104, 50, 52); // B-roll audio on A2, 104–106 s
    const snap = snapshot(s);
    expect(snap.problems.join(" ")).toMatch(/A2 doesn't start and end with the video clips/);
    expect(snap.problems.join(" ")).not.toMatch(/A2 runs past/);
    const before = [0, 1, 2].map((t) => pieces(s.seq.videoTracks[t]));
    expect(() => applyMulti(s, rel, snap)).toThrow(/A2 doesn't start and end with the video clips/);
    expect([0, 1, 2].map((t) => pieces(s.seq.videoTracks[t]))).toEqual(before);
    expect(pieces(s.seq.audioTracks[1])).toEqual([[104, 106, 50]]);
  });

  it("refuses two back-to-back audio clips on one track", () => {
    const s = multiScene({ music: false });
    s.a1.end = Time.k(105 * TICKS); s.a1.outPoint = Time.s(15);
    s.seq.audioTracks[0].add(s.wide, 105, 15, 20);
    const snap = snapshot(s);
    expect(snap.problems.join(" ")).toMatch(/A1 doesn't start and end with the video clips/);
    expect(() => applyMulti(s, rel, snap)).toThrow(/A1 doesn't start and end/);
    expect(pieces(s.seq.audioTracks[0])).toEqual([[100, 105, 10], [105, 110, 15]]);
  });
});

describe("gcutApplyCutsMulti: stash and rollback safety", () => {
  const stash = (s: ReturnType<typeof multiScene>) => (s.host.ctx as any).$.global.gcutStash;

  it("a re-apply at the same start that rolls back keeps the first edit's Restore record", () => {
    const s = multiScene({ music: false });
    expect(applyMulti(s)).toMatchObject({ ok: true });
    const first = stash(s)["m@" + START];
    expect(first).toBeTruthy();
    // Analyse the first pieces of the cut timeline (100–102 s) and apply again; it fails.
    for (const t of [0, 1, 2]) s.seq.videoTracks[t].clips[0].selected = true;
    const snap2 = snapshot(s);
    expect(snap2).toMatchObject({ found: true, startTicks: START, problems: [] });
    s.seq.dropSpanIndex = 12; // 12 placements so far: the re-apply's first one silently fails
    expect(applyMulti(s, [{ start: 0, end: 1 }], snap2)).toMatchObject({ ok: false, rolledBack: true });
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
      const r = applyMulti(s);
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
    const r = applyMulti(s);
    expect(r).toMatchObject({ ok: false, rolledBack: true });
    expect(r.message).toMatch(/V1/);
    for (const [t, inS] of [[0, 10], [1, 12], [2, 5]] as const) expect(pieces(s.seq.videoTracks[t])).toEqual([[100, 110, inS]]);
    expect(pieces(s.seq.audioTracks[0])).toEqual([[100, 110, 10]]);
  });

  it("a failure mid-lay rolls back pieces that reached a frame past the range", () => {
    const s = multiScene({ music: false });
    const v2 = s.seq.videoTracks[1], real = v2.overwriteClip.bind(v2);
    let calls = 0;
    v2.overwriteClip = (pi: ProjectItem, ticks: string) => { if (calls++ === 0) throw new Error("Premiere refused"); return real(pi, ticks); };
    const r = applyMulti(s, [{ start: 0, end: 10.04 }]); // V1 is laid 100–110.04 before V2 throws
    expect(r).toMatchObject({ ok: false, rolledBack: true });
    for (const [t, inS] of [[0, 10], [1, 12], [2, 5]] as const) expect(pieces(s.seq.videoTracks[t])).toEqual([[100, 110, inS]]);
    expect(pieces(s.seq.audioTracks[0])).toEqual([[100, 110, 10]]);
  });
});
