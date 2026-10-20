/**
 * Runs the real ExtendScript host (extension/host/index.jsx) in a Node sandbox against a
 * simulated Premiere object model. The sandbox has NO native JSON, like ExtendScript.
 *
 * This proves the host's logic against our model of the Premiere API, not against Premiere
 * itself: Checkpoint B checks the real thing. The model is deliberately NOT kind:
 *   - overwriteClip really overwrites: it trims, splits or removes whatever it lands on;
 *   - placements snap to the sequence frame grid;
 *   - behaviours the docs don't pin down are switches (setInPoint units, where linked audio
 *     lands, whether remove also acts on linked partners, locked tracks, in > out);
 *   - TrackItem.move throws (it hung real Premiere), except while the panel's Close gap runs.
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
  /** A file with pictures (a camera, a screen recording). An audio-only file (a .wav, see `wav`) has none, and
   *  reports no frame rate, or its sample rate. */
  hasVideo = true;
  constructor(public name: string, public nodeId: string, public durationS: number, public unit: Unit = "seconds", public hasAudio = true) {
    this.outS = durationS;
  }
  getMediaPath() { return `D:/Footage/${this.name}`; }
  getFootageInterpretation() { return { frameRate: this.hasVideo || this.mediaFps > 1000 ? this.mediaFps : 0 }; }
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

/** A component property as measured in Premiere 26.5.2 (2026-10-14): the audio Volume component's "Level" reads
 *  0.17783 at 0 dB and is linear (dB = 20·log10(v) + 15); setValue(v, true) reads back v. */
class Param {
  timeVarying = false;
  constructor(public displayName: string, public value: any) {}
  getValue() { return this.value; }
  setValue(v: any, _update: boolean) { this.value = v; return 0; }
  isTimeVarying() { return this.timeVarying; }
}
const coll = <T,>(xs: T[]) => Object.assign([...xs], { numItems: xs.length });
/** A clip's components; an audio clip's Volume has Bypass and Level (0 dB). */
function components(names: string[], level = 0.17783) {
  return coll(names.map((displayName) => (displayName === "Volume"
    ? { displayName, properties: coll([new Param("Bypass", false), new Param("Level", level)]) } : { displayName })));
}

class TrackItem {
  start: Time; outPoint: Time;
  /** The source time the clip really starts at; `inPoint` is what Premiere reports of it. */
  trueIn: Time;
  private _end: Time;
  selected = false; speed = 1; reversed = 0;
  /** TrackItem.disabled: the clip is switched off in the timeline. */
  disabled = false;
  /** Transitions added through QE at this clip's start; they go when the clip goes (measured). */
  transitions: { applyToStart: boolean; duration: string; offset: string; alignment: number }[] = [];
  linked: TrackItem[] = [];
  components: any;
  constructor(public track: Track, public projectItem: ProjectItem, startT: number, inS: number, durT: number, public mediaType: string) {
    this.start = Time.k(startT); this._end = Time.k(startT + durT);
    this.trueIn = Time.s(inS); this.outPoint = Time.s(inS + durT / TICKS);
    this.components = components(mediaType === "Video" ? ["Opacity", "Motion"] : ["Volume", "Channel Volume", "Panner"]);
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
  /** The Volume component's Level (linear), or undefined on a clip without one. */
  get level() { return this.components.find((c: any) => c.displayName === "Volume")?.properties[1].value; }
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
  /** Real Premiere 26.5.2 (2026-10-15) blocked forever inside trackItem.move(Time) (V3 Camera A by +3 s; a restart
   *  was needed twice): it throws, except inside the panel's Close gap (gcutCloseGapMulti, see load), which still uses it. */
  move(offset: Time) {
    if (!this.track.seq.moveAllowed) throw new Error("TrackItem.move was called: it hangs Premiere 26.5.2, and the host must never use it.");
    if (this.track.locked) throw new Error("Track is locked");
    const all = this.track.seq.moveLinked ? [this, ...this.linked] : [this];
    for (const it of all) { it.start = Time.k(it.start.t + offset.t); it.setEnd(it.end.t + offset.t); }
    return 0;
  }
  /** The user dragging this one clip along its track by hand (the simulator's own edit, not an API call). */
  drag(offset: Time) { this.start = Time.k(this.start.t + offset.t); this.setEnd(this.end.t + offset.t); }
}

class Track {
  items: TrackItem[] = [];
  locked = false;
  muted = false;
  constructor(public seq: Seq, public kind: "video" | "audio", public index: number) {}
  get name() { return (this.kind === "video" ? "Video " : "Audio ") + (this.index + 1); }
  isMuted() { return this.muted; }
  /** Premiere 26.5.2 (measured 2026-10-14): setMute(1) / setMute(0) toggles, isMuted() reads it back. */
  setMute(v: number) { this.muted = !!v; }
  get clips() {
    const arr: any = [...this.items].sort((a, b) => a.start.t - b.start.t);
    arr.numItems = arr.length;
    return arr;
  }
  isLocked() { return this.locked; }
  add(pi: ProjectItem, startS: number, inS: number, outS: number) {
    if (!this.seq.bin.includes(pi)) this.seq.bin.push(pi);
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
      else { o.trueIn = Time.s(o.trueIn.seconds + (endT - os) / TICKS); o.start = Time.k(endT); o.transitions = []; }
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

/** A sequence marker as measured in Premiere 26.5.2 (2026-10-14): a guid per marker, start/end as Time, `end`
 *  set in seconds (a range marker), name, comments, a colour index. */
let markerCount = 0;
class Marker {
  guid = `guid-${++markerCount}`;
  start: Time; private _end: Time;
  name = ""; comments = ""; type = "Comment";
  private colour = 0;
  constructor(sec: number) { this.start = Time.s(sec); this._end = Time.s(sec); }
  get end() { return this._end; }
  set end(v: any) { this._end = typeof v === "number" ? Time.s(v) : Time.k(Number(v.ticks)); }
  setColorByIndex(i: number) { this.colour = i; }
  getColorByIndex() { return this.colour; }
}
class Markers {
  list: Marker[] = [];
  get numMarkers() { return this.list.length; }
  private sorted() { return [...this.list].sort((a, b) => a.start.t - b.start.t); }
  createMarker(sec: number) { const m = new Marker(sec); this.list.push(m); return m; }
  getFirstMarker() { return this.sorted()[0]; }
  getNextMarker(m: Marker) { const all = this.sorted(); return all[all.indexOf(m) + 1]; }
  deleteMarker(m: Marker) { this.list = this.list.filter((x) => x !== m); }
}

class Seq {
  videoTracks: any; audioTracks: any;
  name = "Main edit";
  markers = new Markers();
  /** The project items on this sequence, as the project panel holds them (app.project.rootItem, see load). */
  bin: ProjectItem[] = [];
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
  /** Set by load's call only while gcutCloseGapMulti runs: the one host path still allowed to call TrackItem.move. */
  moveAllowed = false;
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
    const it = track.place(pi, s, inS, durT);
    // Premiere 26.5.2 (measured 2026-10-08) places a file's picture AND sound whichever kind of track it's
    // called on: a video clip's sound on A(same number), audio from a video file's picture on V(same number).
    if (track.kind === "video" && pi.hasAudio) {
      const a = this.audioTracks[this.audioTrackFor(track.index)].place(pi, s, inS, durT);
      it.linked = [a]; a.linked = [it];
    }
    if (track.kind === "audio" && pi.hasVideo && track.index < this.videoTracks.numTracks) {
      const v = this.videoTracks[track.index].place(pi, s, inS, durT);
      it.linked = [v]; v.linked = [it];
    }
  }
}

/** An audio-only file (a .wav): no pictures, so placing it drops nothing on a video track. */
function wav(name: string, nodeId: string, durationS: number) {
  const pi = new ProjectItem(name, nodeId, durationS);
  pi.hasVideo = false;
  return pi;
}

/**
 * The QE DOM as measured in Premiere 26.5.2 (2026-10-08): app.enableQE() defines `qe`; an audio track lists its
 * items in order with gaps as "Empty" items (item.start.secs, item.type, item.name); a clip's addTransition with
 * applyToStart=true puts a transition at its start, counted in track.numTransitions; removing the clip removes it.
 * `transition: false` models Premiere not finding "Constant Power"; `throws` an addTransition that throws.
 */
class FakeQE {
  transition = true;
  throws = false;
  /** Premiere taking a razor call and doing nothing (an earlier build did, with another timecode form). */
  razorNoop = false;
  /** Every razor call, as [track label, timecode]. */
  razors: [string, string][] = [];
  constructor(public seq: Seq) {}
  project: any = {
    getActiveSequence: () => ({
      getAudioTrackAt: (i: number) => this.track(this.seq.audioTracks[i]),
      getVideoTrackAt: (i: number) => this.track(this.seq.videoTracks[i]),
    }),
    getAudioTransitionByName: (name: string) => (this.transition && name === "Constant Power" ? { name } : null),
    getVideoTransitionByName: (name: string) => (this.transition && name === "Cross Dissolve" ? { name } : null),
  };
  /** Premiere taking setSpeed and doing nothing. */
  speedNoop = false;
  /** Premiere 26.5.2 (measured 2026-10-14): qeTrack.razor("HH:MM:SS:FF") splits the clip under that frame on THAT track only
   *  (a linked partner on another track is not split); both pieces keep the clip's effects and state. */
  private razor(t: Track, tc: string) {
    this.razors.push([(t.kind === "video" ? "V" : "A") + (t.index + 1), tc]);
    if (this.razorNoop) return true;
    const m = /^(\d\d):(\d\d):(\d\d):(\d\d)$/.exec(tc);
    if (!m) throw new Error("bad timecode");
    const tpf = Number(this.seq.timebase), nominal = Math.round(TICKS / tpf);
    const at = (((+m[1] * 60 + +m[2]) * 60 + +m[3]) * nominal + +m[4]) * tpf;
    const c = t.items.find((i) => i.start.t < at && i.end.t > at);
    if (!c) return true;
    const right = new TrackItem(t, c.projectItem, at, c.trueIn.seconds + (at - c.start.t) / TICKS, c.end.t - at, c.mediaType);
    right.disabled = c.disabled; right.speed = c.speed; right.reversed = c.reversed;
    const lvl = c.level;
    right.components = components(c.components.map((x: any) => x.displayName), lvl);
    c.setEnd(at);
    t.items.push(right);
    return true;
  }
  private track(t: Track) {
    const items: any[] = [];
    let cursor = 0;
    for (const c of t.clips as TrackItem[]) {
      if (c.start.t > cursor) items.push({ type: "Empty", name: "", start: { secs: cursor / TICKS } });
      items.push({
        type: "Clip", name: c.name, start: { secs: c.start.seconds },
        addTransition: (x: any, applyToStart: boolean, duration: string, offset: string, alignment: number) => {
          if (this.throws || !x) throw new Error("addTransition failed");
          c.transitions.push({ applyToStart, duration, offset, alignment });
          return true;
        },
        // Measured 2026-10-14: setSpeed(2, "", false, false, false) plays the clip at 2x and keeps its timeline length;
        // its linked partner is unchanged.
        setSpeed: (speed: number) => { if (!this.speedNoop) c.speed = speed; return true; },
        getSpeed: () => c.speed,
      });
      cursor = c.end.t;
    }
    return { numItems: items.length, getItemAt: (i: number) => items[i], razor: (tc: string) => this.razor(t, tc),
      get numTransitions() { return t.items.reduce((n, c) => n + c.transitions.length, 0); } };
  }
}

function load(seq: Seq, { qe = true } = {}) {
  const fakeQe = new FakeQE(seq);
  const coll = (xs: any[]) => Object.assign([...xs], { numItems: xs.length });
  // app.project.rootItem: the root, a "Footage" bin inside it, the sequence's project items in that.
  const project = { activeSequence: seq, get rootItem() {
    return { nodeId: "root", name: "", children: coll([{ nodeId: "bin-1", name: "Footage", children: coll(seq.bin) }]) };
  } };
  const sandbox: any = { app: { project }, Time, $: { global: {} } };
  if (qe) sandbox.app.enableQE = () => { sandbox.qe = fakeQe; };
  const ctx = vm.createContext(sandbox);
  vm.runInContext("delete this.JSON;", ctx); // ExtendScript has no JSON
  vm.runInContext(HOST_SRC, ctx);
  const call = (fn: string, arg: unknown) => {
    seq.moveAllowed = fn === "gcutCloseGapMulti";
    let out: string;
    try { out = (ctx as any)[fn](JSON.stringify(arg)); } finally { seq.moveAllowed = false; }
    if (out.startsWith("Error:")) throw new Error(out.slice(6).trim());
    return JSON.parse(out); // the panel parses with native JSON, so the tests do too
  };
  return { ctx, call, qe: fakeQe };
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
  if (music) seq.audioTracks[2].add(wav("music.wav", "node-m", 300), 90, 0, 40);
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
  const scr = new ProjectItem("Restream.mov", "node-r", 900, "seconds", false), mic = wav("mic.wav", "node-m", 900);
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
    const music = wav("music.wav", "node-9", 300);
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
    s.seq.audioTracks[2].add(wav("sfx.wav", "node-4", 10), 112, 0, 3);
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
    s.seq.audioTracks[1].add(wav("music.wav", "node-3", 60), 107.5, 0, 1); // 107.5–108.5 crosses 107–108
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
    s.seq.audioTracks[2].add(wav("music.wav", "node-x", 300), 90, 0, 40); // unselected
    expect(snapshot(s).audio.map((x: any) => x.label)).toEqual(["A1"]);
  });
  it("prompts when no audio is selected", () => {
    const s = georgScene(); s.a1.selected = false;
    expect(snapshot(s).problems).toContain("No audio clip is selected. Select the audio Genius Cut should transcribe along with the video clips.");
  });
  it("refuses linked audio that isn't selected", () => {
    const s = multiScene({ music: false }); // A1 is V1's own audio (same node)
    s.a1.selected = false;
    s.seq.audioTracks[1].add(wav("mic.wav", "node-m2", 900), 100, 0, 10).selected = true;
    expect(snapshot(s).problems).toContain("A1 is linked to V1 but isn't selected. Select it too, or unlink it.");
  });
  it("flags unselected audio under the selected video clips (a music bed), because the rebuild could overwrite it", () => {
    const s = georgScene();
    s.seq.audioTracks[2].add(wav("music.wav", "node-x", 300), 90, 0, 40);
    expect(snapshot(s).problems).toEqual([
      "A3 (music.wav) sits under the selected video clips, and rebuilding them could overwrite it. Select it too, or move it off the clips' time, then Analyse again."]);
  });
  it("doesn't flag unselected audio that lies outside the selected video clips' time", () => {
    const s = georgScene();
    s.seq.audioTracks[2].add(wav("sfx.wav", "node-x", 30), 110, 0, 5); // starts where the video ends
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
    s.seq.audioTracks[1].add(wav("lav.wav", "node-v", 900), 200, 0, 10).selected = true;
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

  it("refuses unrecorded audio where an angle's own sound lands (here added after Analyse), naming both, before changing anything", () => {
    const s = multiScene({ music: false });
    const snap = snapshot(s);
    // V2's own sound lands on A2 (measured: the same track number) and would destroy it, so it must be caught up front.
    s.seq.audioTracks[1].add(wav("sfx.wav", "node-x", 5), 103, 0, 1);
    const all = () => [...[0, 1, 2, 3].map((t) => pieces(s.seq.videoTracks[t])), ...[0, 1, 2].map((t) => pieces(s.seq.audioTracks[t]))];
    const before = all();
    expect(() => applyCuts(s, cuts, snap)).toThrow(
      "Placing V2 also drops its own sound onto A2, which would cover sfx.wav. Move that clip off A2's time.");
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
    s.seq.dropSpanIndex = 9; // 9 placements so far (V1-V3; A1 comes with V1): the re-apply's first one silently fails
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
    s.seq.audioTracks[2].add(wav("hit.wav", "node-h", 5), 108.5, 0, 1);
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
    s.seq.audioTracks[1].add(wav("sfx.wav", "node-x", 5), 101, 0, 0.5);
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
  const cutVersion = (s: ReturnType<typeof multiScene>) => {
    for (const [t, inS] of [[0, 10], [1, 12], [2, 5]] as const) {
      expect(pieces(s.seq.videoTracks[t])).toEqual([[100, 102, inS], [102, 106, inS + 3], [106, 108, inS + 8]]);
    }
    expect(pieces(s.seq.audioTracks[0])).toEqual([[100, 102, 10], [102, 106, 13], [106, 108, 18]]);
    expect(s.seq.audioTracks[1].clips.numItems + s.seq.audioTracks[2].clips.numItems).toBe(0);
    expect(layout(s.seq.videoTracks[3])).toEqual([[104, 106]]);
  };
  it("a Restore that fails part-way puts the cut version back exactly and keeps the record: Restore and Close gap still work", () => {
    const s = multiScene({ music: false });
    applyCuts(s);
    s.seq.dropSpanIndex = 9; // 9 placements so far (V1-V3; A1 comes with V1): Restore's first (V1) silently fails
    expect(() => restoreMulti(s)).toThrow("The original clips didn't go back as expected, so the cut version was put back as it was. " +
      "Try Restore again, or use Premiere's Undo.");
    cutVersion(s); // never a mix of whole clips and pieces
    const rec = (s.host.ctx as any).$.global.gcutStash["m@" + START];
    expect([rec.rebuiltEndT, rec.gapClosed]).toEqual([108 * TICKS, false]);
    expect(restoreMulti(s)).toEqual({ ok: true });
    for (const [t, inS] of [[0, 10], [1, 12], [2, 5]] as const) expect(pieces(s.seq.videoTracks[t])).toEqual([[100, 110, inS]]);
  });
  it("a Restore that fails part-way, then Close gap: the gap closes", () => {
    const s = multiScene({ music: false });
    applyCuts(s);
    s.seq.dropSpanIndex = 9;
    expect(() => restoreMulti(s)).toThrow(/cut version was put back/);
    expect(closeGapMulti(s)).toEqual({ ok: true, movedCount: 1 }); // the title, 104–106 → 103–105
    expect(layout(s.seq.videoTracks[3])).toEqual([[103, 105]]);
  });
  it("a Restore whose cut version can't be put back either says to use Undo", () => {
    const s = multiScene({ music: false });
    applyCuts(s);
    const v1 = s.seq.videoTracks[0], real = v1.overwriteClip.bind(v1);
    v1.overwriteClip = () => { throw new Error("Premiere refused"); }; // every lay on V1 fails, both ways
    expect(() => restoreMulti(s)).toThrow("The original clips didn't go back as expected, and the cut version couldn't be put back either. Use Premiere's Undo.");
    v1.overwriteClip = real;
  });
});

describe("gcutCloseGapMulti", () => {
  function later(s: ReturnType<typeof multiScene>) {
    const broll = new ProjectItem("broll.mov", "node-b", 60);
    s.seq.videoTracks[0].add(broll, 110, 0, 5);
    s.seq.audioTracks[2].add(wav("sfx.wav", "node-x", 5), 112, 0, 2);
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
    s.seq.audioTracks[2].add(wav("hit.wav", "node-h", 5), 108.5, 0, 1);
    expect(closeGapMulti(s)).toEqual({ ok: true, movedCount: 2 });
    expect(layout(s.seq.audioTracks[2])).toEqual([[106.5, 107.5]]);
    expect(layout(s.seq.videoTracks[3])).toEqual([[103, 105]]); // the title (104–106) had one cut before it
  });
  it("refuses, naming it, a clip that crosses a cut, and moves nothing", () => {
    const s = multiScene({ music: false });
    later(s);
    applyCuts(s);
    s.seq.audioTracks[2].add(wav("hit.wav", "node-h", 5), 107.5, 0, 1);
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
    const mic = wav("mic.wav", "node-m", 900);
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
    expect(v[1].inPoint.seconds).toBeCloseTo(Math.round((10 + 90 * F) * 25) / 25, 6); // the nearest 25 fps frame (clean cuts)
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
    // From the original in point plus the piece's offset, on the nearest source frame (clean cuts): half a frame at most.
    [0, 2.76, 7.76].forEach((off, i) => {
      const want = floorSrc(30) + off, got = v2[i].inPoint.seconds;
      expect(Math.abs(got - want)).toBeLessThanOrEqual(SRC_FRAME / 2 + 1e-9);
      expect(Math.abs(got * SRC_FPS - Math.round(got * SRC_FPS))).toBeLessThan(1e-6);
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
    const a1 = seq.audioTracks[0].add(wav("mic.wav", "node-m", 900), 99, 50, 58);
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
      const a1 = seq.audioTracks[0].add(wav("mic.wav", "node-m", 900), 99, 50, 56);
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
      const a1 = seq.audioTracks[0].add(wav("mic.wav", "node-m", 900), 99, 50, 56);
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
   *  on V2 (0.5–119 s), Camera A on V3 (1–121 s) whose source ends exactly where the clip does. With
   *  `camerasSound` (the 2026-10-08 field run on copies), the cameras bring their own sound too, which Premiere
   *  drops on A2 and A3 (empty, unrecorded); `len` shortens every clip (the field copies were 20 s). */
  function restreamScene({ camerasSound = false, len = 120 } = {}) {
    const seq = new Seq(3, camerasSound ? 3 : 1);
    seq.timebase = String(TPF30); seq.inPointOnSeqGrid = true;
    const rs = measured("Restream.io.mp4", "node-r", 6219.453, RESTREAM, true);
    const camB = measured("Camera B.mov", "node-b", 3600, CAM_B, camerasSound);
    const camA = measured("Camera A.mov", "node-a", A_IN + len, CAM_A, camerasSound);
    camA.clampToMedia = true;
    const v1 = seq.videoTracks[0].add(rs, 0, RS_IN, RS_IN + len);
    const a1 = seq.audioTracks[0].add(rs, 0, RS_IN, RS_IN + len);
    v1.linked = [a1]; a1.linked = [v1];
    const v2 = seq.videoTracks[1].add(camB, 0.5, B_IN, B_IN + len - 1.5);
    const v3 = seq.videoTracks[2].add(camA, 1, A_IN, A_IN + len);
    for (const x of [v1, v2, v3, a1]) x.selected = true;
    /** Each track's clip: [startFrame, endFrame, true source in, own frame length]. */
    const orig: [number, number, number, number][] = [[0, 30 * len, RS_IN, 1 / RESTREAM], [15, 30 * (len - 1), B_IN, 1 / CAM_B],
      [30, 30 * (len + 1), A_IN, 1 / CAM_A], [0, 30 * len, RS_IN, 1 / RESTREAM]];
    return { seq, rs, camB, camA, orig, host: load(seq) };
  }
  type Scene = ReturnType<typeof restreamScene>;
  const tracks = (s: Scene) => [s.seq.videoTracks[0], s.seq.videoTracks[1], s.seq.videoTracks[2], s.seq.audioTracks[0]];
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
      const mic = wav("mic.wav", "node-m", 900);
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
  describe("own frames SHORTER than the sequence's (59.94 or 50 in 30): no drift, exact", () => {
    /** One clip at 100–104 s in a 30 fps sequence from source `inS`, on its own frames; mic.wav on A1. */
    function shortScene(fps: number, inS: number, onSeqGrid: boolean, toMediaEnd = false) {
      const seq = new Seq(1, 1);
      seq.timebase = String(TPF30); seq.inPointOnSeqGrid = onSeqGrid;
      const cam = measured("cam.mov", "node-c", toMediaEnd ? inS + 4 : 900, fps, false);
      cam.clampToMedia = toMediaEnd;
      const v1 = seq.videoTracks[0].add(cam, 100, inS, inS + 4);
      const a1 = seq.audioTracks[0].add(wav("mic.wav", "node-m", 900), 100, 50, 54);
      v1.selected = true; a1.selected = true;
      return { seq, host: load(seq) };
    }
    const cycles = (s: { seq: Seq; host: ReturnType<typeof load> }, inS: number, n: number) => {
      for (let cycle = 0; cycle < n; cycle++) {
        reselect([s.seq.videoTracks[0], s.seq.audioTracks[0]]);
        const snap = snapshot(s);
        expect(applyCuts(s, [{ start: 1, end: 2 }], snap), `cycle ${cycle}`).toMatchObject({ ok: true });
        expect(s.seq.videoTracks[0].clips.map((i: TrackItem) => [i.start.t / TPF30, i.end.t / TPF30])).toEqual([[3000, 3030], [3030, 3090]]);
        expect(s.host.call("gcutRestoreMulti", { startTicks: snap.startTicks }), `cycle ${cycle}`).toEqual({ ok: true });
        const v = s.seq.videoTracks[0].clips;
        expect(v.map((i: TrackItem) => [i.start.t / TPF30, i.end.t / TPF30])).toEqual([[3000, 3120]]);
        expect(v[0].trueIn.seconds, `cycle ${cycle}`).toBeCloseTo(inS, 9);
      }
    };
    it.each([["floored to the sequence's frames (measured)", true], ["as it is", false]])(
      "59.94 in 30 from source 0, in point reported %s: four Apply → Restore cycles never move it in its source", (_, onSeqGrid) => {
        cycles(shortScene(60000 / 1001, 0, onSeqGrid), 0, 4);
      });
    it("50 in 30, in point reported as it is: four cycles never move it in its source", () => {
      cycles(shortScene(50, 10, false), 10, 4);
    });
    it("59.94 in 30 from source 0 running to the media's end: Apply and Restore are both exact", () => {
      cycles(shortScene(60000 / 1001, 0, true, true), 0, 1);
    });
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
  /** Every piece exactly on its planned sequence frames, and its true source in point on the NEAREST of its own
   *  frames to the plan: within half an own frame either side (clean cuts, 2026-10-08). The one exception is a piece
   *  that runs to its media's very end (Camera A's last): it can't start later, so it starts on the frame below. */
  const expectLayout = (s: Scene, cutsF: number[][]) => tracks(s).forEach((t, k) => {
    const [startF, endF, inS, ownF] = s.orig[k], want = plan(startF, endF, cutsF), clips = t.clips;
    expect(clips.map((i: TrackItem) => [i.start.t, i.end.t]), `track ${k}`).toEqual(want.map(([a, b]) => [a * TPF30, b * TPF30]));
    want.forEach(([, , from], i) => {
      const planned = inS + (from - startF) / 30, got = clips[i].trueIn.seconds;
      const toMediaEnd = k === 2 && i === want.length - 1;
      expect(got, `track ${k} piece ${i}`).toBeLessThanOrEqual(planned + (toMediaEnd ? 1e-9 : ownF / 2 + 1e-9));
      expect(got, `track ${k} piece ${i}`).toBeGreaterThan(planned - (toMediaEnd ? ownF : ownF / 2 + 1e-9));
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

  describe("the 2026-10-08 field run: Restream's own sound on A1, the cameras' own sound dropped on A2 and A3", () => {
    // Field: "Kept span 4 of 4 on V1 didn't land where or as expected", and a rollback that left V1 0–19.9667 plus a
    // 1-frame clip: laying A1 (Restream's sound, from a video file) dropped untrimmed pictures on V1 over its pieces.
    const FIELD: number[][] = [[2, 3], [7, 8.5], [12.3, 12.9]];
    const field = (len = 120) => restreamScene({ camerasSound: true, len });
    const noStrays = (s: Scene) => expect([1, 2].map((t) => pieces(s.seq.audioTracks[t]))).toEqual([[], []]);
    const backToBack = (s: Scene) => {
      for (const t of tracks(s)) for (let i = 1; i < t.clips.numItems; i++) expect(t.clips[i].start.t).toBe(t.clips[i - 1].end.t);
    };

    it("the field's 20 s copies and cuts: Apply lays every track exactly with no camera sound left; Restore puts every clip back exactly", () => {
      const s = field(20), snap = snapshot(s);
      expect(applyCuts(s, cutsOf(FIELD), snap)).toMatchObject({ ok: true, clipCount: 4, crossfades: 3 }); // A1's 3 cuts
      expect(s.seq.audioTracks[0].items.filter((c: TrackItem) => c.transitions.length).map((c: TrackItem) => c.start.t / TPF30).sort((a: number, b: number) => a - b)).toEqual([60, 180, 294]);
      expectLayout(s, toF(FIELD));
      backToBack(s);
      noStrays(s);
      expect(s.host.call("gcutRestoreMulti", { startTicks: snap.startTicks })).toEqual({ ok: true });
      expectOriginal(s);
      noStrays(s);
      expect(s.seq.audioTracks[0].items.flatMap((c: TrackItem) => c.transitions)).toEqual([]);
    });

    it.each(cases)("120 s clips, cuts %j: Apply lays every track exactly with no camera sound left; Restore puts every clip back exactly", (...c) => {
      const s = field(), snap = snapshot(s);
      expect(applyCuts(s, cutsOf(c), snap)).toMatchObject({ ok: true, clipCount: 4 });
      expectLayout(s, toF(c));
      backToBack(s);
      noStrays(s);
      expect(s.host.call("gcutRestoreMulti", { startTicks: snap.startTicks })).toEqual({ ok: true });
      expectOriginal(s);
      noStrays(s);
    });

    // 12 placements: V1, V2 and V3 four pieces each (A1 comes with V1's). 0: V1's first; 3: V1's last; 4: V2's first; 11: V3's last.
    it.each([0, 3, 4, 11])("20 s copies: a piece landing wrong (placement %s) rolls every clip back to its exact original place", (n) => {
      const s = field(20);
      s.seq.dropSpanIndex = n;
      expect(applyCuts(s, cutsOf(FIELD))).toMatchObject({ ok: false, rolledBack: true });
      expectOriginal(s);
      noStrays(s);
    });

    it("records A1 as audio from a video file, and the cameras' clips as video", () => {
      const s = field();
      expect(applyCuts(s, cutsOf(FIELD))).toMatchObject({ ok: true });
      const rec: any = Object.values((s.host.ctx as any).$.global.gcutStash)[0];
      expect(rec.items.map((i: any) => [i.label, i.av])).toEqual([["V1", false], ["V2", false], ["V3", false], ["A1", true]]);
    });
  });

  it("accepts a piece on its nearest own frame whose reported in point is then floored to the sequence's frames", () => {
    // Camera A alone at 100–104 s from A_IN; the mic is an audio-only file. Find a piece whose planned source time
    // Premiere reports more than half a sequence frame early: the nearest own frame below it, floored again.
    const seq = new Seq(1, 1);
    seq.timebase = String(TPF30); seq.inPointOnSeqGrid = true;
    const camA = measured("Camera A.mov", "node-a", A_IN + 120, CAM_A, false);
    const mic = wav("mic.wav", "node-m", 900);
    mic.mediaFps = 0;
    const v1 = seq.videoTracks[0].add(camA, 100, A_IN, A_IN + 4);
    const a1 = seq.audioTracks[0].add(mic, 100, 50, 54);
    v1.selected = true; a1.selected = true;
    const s = { seq, host: load(seq) };
    const reported = (p: number) => seqGrid(Math.round(p * CAM_A) / CAM_A);
    const j = Array.from({ length: 104 }, (_, k) => k + 16).find((k) => reported(A_IN + k / 30) < A_IN + k / 30 - SEQ_F / 2 - 1e-6)!;
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
    const mic = wav("mic.wav", "node-m", 900);
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
      "59.94 in 29.97, a clip from an odd 59.94 frame, its in point reported %s: Apply and Restore land on the exact timeline frames", (_, onSeqGrid) => {
        const F2 = 1001 / 60000, tpf = Math.round(F * TICKS);
        const seq = new Seq(1, 1);
        seq.timebase = String(tpf); seq.inPointOnSeqGrid = onSeqGrid;
        const cam = measured("cam.mov", "node-c", 900, 60000 / 1001, false);
        const mic = wav("mic.wav", "node-m", 900);
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

  describe("the assistant's toolbox on Georg's 30 fps sequence", () => {
    it("gcutToolGetSequence lists the Restream clips with ids that resolve to them", () => {
      const s = restreamScene();
      const r = s.host.call("gcutToolGetSequence", {});
      expect(r).toMatchObject({ fps: 30, durationS: 121 });
      expect(r.clips.map((c: any) => [c.id, c.startS, c.endS])).toEqual([
        [`V1@0#node-r`, 0, 120], [`V2@${15 * TPF30}#node-b`, 0.5, 119], [`V3@${30 * TPF30}#node-a`, 1, 121], [`A1@0#node-r`, 0, 120]]);
      // Premiere 26.5.2 reports a loose clip's in point floored to the sequence's frames; get_sequence
      // gives its true one (gcutTrueInS), the one the transcript request needs.
      expect(tracks(s)[0].items[0].inPoint.seconds).toBeCloseTo(seqGrid(RS_IN), 9);
      r.clips.forEach((c: any, i: number) => expect(c.inS, c.id).toBeCloseTo(s.orig[i][2], 9));
      const got = (s.host.ctx as any).gcutResolveIds(s.seq, r.clips.map((c: any) => c.id));
      got.forEach((x: any, i: number) => expect(x.item).toBe(tracks(s)[i].items[0]));
    });

    const allIds = (s: Scene) => s.host.call("gcutToolGetSequence", {}).clips.map((c: any) => c.id);
    const asRanges = (c: number[][]) => c.map(([fromS, toS]) => ({ fromS, toS }));
    it.each(cases.slice(0, 3))("cut_ranges %j on the loose Restream clips lays exactly what Apply lays; undo puts every clip back exactly", (...c) => {
      const s = restreamScene();
      const r = s.host.call("gcutToolCutRanges", { sequenceId: "seq-1", clipIds: allIds(s), ranges: asRanges(c) });
      expect(r).toMatchObject({ ok: true, clipCount: 4 });
      expectLayout(s, toF(c));
      expect(s.host.call("gcutToolUndo", { record: JSON.parse(JSON.stringify(r.undo)) })).toEqual({ ok: true });
      expectOriginal(s);
    });

    it("cut_ranges then undo four times over: no clip drifts in its source", () => {
      const s = restreamScene(), orig = tracks(s).map((t) => t.clips[0].trueIn.seconds), c = cases[0];
      for (let cycle = 0; cycle < 4; cycle++) {
        const r = s.host.call("gcutToolCutRanges", { sequenceId: "seq-1", clipIds: allIds(s), ranges: asRanges(c) });
        expectLayout(s, toF(c));
        expect(s.host.call("gcutToolUndo", { record: JSON.parse(JSON.stringify(r.undo)) }), `cycle ${cycle}`).toEqual({ ok: true });
        expectOriginal(s);
        tracks(s).forEach((t, k) => expect(t.clips[0].trueIn.seconds, `cycle ${cycle} track ${k}`).toBeCloseTo(orig[k], 9));
      }
    });

    describe("split_at and switch_angle on the loose cameras: their in points are read as the cut verify reads them", () => {
      const at = (s: Scene) => tracks(s).map((t) => t.clips.map((i: TrackItem) => [i.start.t, i.end.t, +i.trueIn.seconds.toFixed(9), i.disabled]));
      it.each([["V3 (Camera A)", "V3"], ["V2 (Camera B)", "V2"], ["V1 + A1 (Restream)", "V1", "A1"]])("split_at %s, then undo: exact, and idMap names both pieces", (_, ...labels) => {
        const s = restreamScene(), orig = at(s);
        const ids = allIds(s).filter((x: string) => labels.some((l) => x.startsWith(l)));
        const r = s.host.call("gcutToolSplitAt", { sequenceId: "seq-1", clipIds: ids, atS: 50.4 });
        expect(r).toMatchObject({ ok: true, splitCount: ids.length });
        for (const id of ids) expect(r.idMap[id], id).toHaveLength(2);
        const record = JSON.parse(JSON.stringify(r.undo));
        expect(s.host.call("gcutToolUndo", { record, check: true })).toEqual({ ok: true, wouldUndo: true });
        expect(s.host.call("gcutToolUndo", { record })).toEqual({ ok: true });
        expect(at(s)).toEqual(orig);
        expect(s.host.call("gcutToolUndo", { record })).toEqual({ ok: true, alreadyUndone: true });
      });
      it("switch_angle across the three angles (showing V3, Camera A), then undo: exact", () => {
        const s = restreamScene(), orig = at(s);
        const ids = allIds(s).filter((x: string) => x.startsWith("V"));
        const r = s.host.call("gcutToolSwitchAngle", { sequenceId: "seq-1", clipIds: ids, fromS: 40.2, toS: 47.7, showTrack: 3 });
        expect(r).toMatchObject({ ok: true, shown: "V3", hidden: ["V1", "V2"], splitCount: 6 });
        for (const id of ids) expect(r.idMap[id], id).toHaveLength(3);
        const record = JSON.parse(JSON.stringify(r.undo));
        expect(s.host.call("gcutToolUndo", { record, check: true })).toEqual({ ok: true, wouldUndo: true });
        expect(s.host.call("gcutToolUndo", { record })).toEqual({ ok: true });
        expect(at(s)).toEqual(orig);
      });
      it("a loose piece slip-edited by a whole own frame since is still refused", () => {
        const s = restreamScene();
        const ids = allIds(s).filter((x: string) => x.startsWith("V3"));
        const r = s.host.call("gcutToolSplitAt", { sequenceId: "seq-1", clipIds: ids, atS: 50.4 });
        const p = s.seq.videoTracks[2].clips[1];
        p.trueIn = Time.s(p.trueIn.seconds + 2 / CAM_A);
        expect(() => s.host.call("gcutToolUndo", { record: JSON.parse(JSON.stringify(r.undo)) })).toThrow(/V3's pieces were .*slip-edited since/);
      });
    });

    describe("move_clips and close_gaps on the loose cameras (laid again, never TrackItem.move)", () => {
      const at = (s: Scene) => tracks(s).map((t) => t.clips.map((i: TrackItem) => [i.start.t / TPF30, i.end.t / TPF30, +i.trueIn.seconds.toFixed(9)]));
      it.each([["without", false], ["with", true]])("Camera A on V3 by +3 s (%s its own sound): exact at its new place, and its undo exact", (_, camerasSound) => {
        const s = restreamScene({ camerasSound }), orig = at(s);
        const r = s.host.call("gcutToolMoveClips", { sequenceId: "seq-1", clipIds: allIds(s).filter((x: string) => x.startsWith("V3")), byS: 3 });
        expect(r).toMatchObject({ ok: true, movedCount: 1 });
        const v3 = s.seq.videoTracks[2].clips;
        expect([v3.numItems, v3[0].start.t, v3[0].end.t]).toEqual([1, 4 * 30 * TPF30, 124 * 30 * TPF30]);
        expect(v3[0].trueIn.seconds).toBeCloseTo(A_IN, 9);
        if (camerasSound) expect(s.seq.audioTracks[2].clips.numItems).toBe(0); // the sound Premiere dropped along is taken off
        expect(s.host.call("gcutToolUndo", { record: JSON.parse(JSON.stringify(r.undo)) })).toEqual({ ok: true });
        expect(at(s)).toEqual(orig);
      });
      it("Camera B and Camera A together, four moves and undos over: no clip drifts in its source", () => {
        const s = restreamScene({ camerasSound: true }), orig = at(s);
        for (let cycle = 0; cycle < 4; cycle++) {
          const ids = allIds(s).filter((x: string) => x.startsWith("V2") || x.startsWith("V3"));
          const r = s.host.call("gcutToolMoveClips", { sequenceId: "seq-1", clipIds: ids, byS: cycle % 2 ? -0.5 : 2 });
          expect(r, `cycle ${cycle}`).toMatchObject({ ok: true, movedCount: 2 });
          expect(s.host.call("gcutToolUndo", { record: JSON.parse(JSON.stringify(r.undo)) }), `cycle ${cycle}`).toEqual({ ok: true });
          expect(at(s), `cycle ${cycle}`).toEqual(orig);
        }
      });
      it("close_gaps slides a loose clip after a gap exactly, and its undo is exact", () => {
        const s = restreamScene();
        const camA = s.seq.videoTracks[2].clips[0] as TrackItem;
        camA.drag(Time.k((130 - 1) * 30 * TPF30)); // Camera A now 130–250 s: a 10 s gap after Restream (0–120 s)
        const orig = at(s), v1 = allIds(s).find((x: string) => x.startsWith("V1"))!, v3 = allIds(s).find((x: string) => x.startsWith("V3"))!;
        const r = s.host.call("gcutToolCloseGaps", { sequenceId: "seq-1", clipIds: [v1, v3] });
        expect(r).toMatchObject({ ok: true, gapCount: 1, movedCount: 1 });
        const now = s.seq.videoTracks[2].clips[0];
        expect([now.start.t, now.end.t]).toEqual([120 * 30 * TPF30, 240 * 30 * TPF30]);
        expect(now.trueIn.seconds).toBeCloseTo(A_IN, 9);
        expect(s.host.call("gcutToolUndo", { record: JSON.parse(JSON.stringify(r.undo)) })).toEqual({ ok: true });
        expect(at(s)).toEqual(orig);
      });
    });
  });
});

describe("measured in Premiere 26.5.2: a file's picture and sound land together, whichever kind of track it's placed on", () => {
  /** Camera A (no sound of its own here) on V1 at 100–110, and Zoom.mp4's sound (a video file) selected on A(zoomOn+1)
   *  at 99–111 from 50 s; with zoomOn = 1, mic.wav (audio-only) on A1 at 99–111 too. All selected. */
  function zoomScene({ nV = 2, zoomOn = 1, loose = false } = {}) {
    const seq = new Seq(nV, 2);
    const cam = new ProjectItem("Camera A.mov", "node-a", 900, "seconds", false);
    const zoom = new ProjectItem("Zoom.mp4", "node-z", 900);
    let zoomIn = 50;
    if (loose) { zoom.mediaFps = 29.9950808; zoom.floorToFrames = true; zoom.outFromIn = true; zoomIn = Math.floor(50 * zoom.mediaFps) / zoom.mediaFps; }
    const sel = [seq.videoTracks[0].add(cam, 100, 10, 20), seq.audioTracks[zoomOn].add(zoom, 99, zoomIn, zoomIn + 12)];
    if (zoomOn === 1) sel.push(seq.audioTracks[0].add(wav("mic.wav", "node-m", 900), 99, 50, 62));
    for (const x of sel) x.selected = true;
    return { seq, zoom, host: load(seq) };
  }
  const everything = (seq: Seq) => [...Array.from({ length: seq.videoTracks.numTracks }, (_, t) => layout(seq.videoTracks[t])),
    ...Array.from({ length: seq.audioTracks.numTracks }, (_, t) => layout(seq.audioTracks[t]))];
  const APPLIED = [[[100, 102], [102, 106], [106, 108]], [], [[99, 102], [102, 106], [106, 109]], [[99, 102], [102, 106], [106, 109]]];
  const ORIGINAL = [[[100, 110]], [], [[99, 111]], [[99, 111]]];

  it.each([["fitting", false], ["loose (29.995 fps in 25)", true]])(
    "%s audio from a video file over an empty video track: the picture it drops is removed; Apply, Restore and rollback are exact", (_, loose) => {
      const s = zoomScene({ loose });
      expect(applyCuts(s, cuts)).toMatchObject({ ok: true, clipCount: 3 });
      expect(everything(s.seq)).toEqual(APPLIED);
      expect(s.host.call("gcutRestoreMulti", { startTicks: START })).toEqual({ ok: true });
      expect(everything(s.seq)).toEqual(ORIGINAL);

      const bad = zoomScene({ loose });
      bad.seq.dropSpanIndex = 4; // Zoom's 3 pieces go first, then V1's: the 5th placement is V1's second piece
      expect(applyCuts(bad, cuts)).toMatchObject({ ok: false, rolledBack: true });
      expect(everything(bad.seq)).toEqual(ORIGINAL);
    });

  it("refuses audio from a video file whose picture would land on a clip it didn't record, changing nothing", () => {
    const s = zoomScene();
    s.seq.videoTracks[1].add(new ProjectItem("logo.png", "node-l", 5, "seconds", false), 104, 0, 2); // on V2, not selected
    const before = everything(s.seq);
    expect(() => applyCuts(s, cuts)).toThrow("A2's audio comes from a video file, and Premiere drops its picture onto V2 when it's placed. " +
      "Move that audio to a track whose video track has nothing else under it, or select that video too.");
    expect(everything(s.seq)).toEqual(before);
  });

  it("refuses audio from a video file under a selected video clip from a different file, changing nothing", () => {
    const s = zoomScene({ zoomOn: 0 });
    const before = everything(s.seq);
    expect(() => applyCuts(s, cuts)).toThrow("A1's audio and V1's video come from different files, so Genius Cut can't place both on these tracks. " +
      "Put the audio on a track number with no selected video.");
    expect(everything(s.seq)).toEqual(before);
  });

  it("refuses audio from a video file on a track number the sequence has no video track for, changing nothing", () => {
    const s = zoomScene({ nV: 1 });
    const before = everything(s.seq);
    expect(() => applyCuts(s, cuts)).toThrow("A2's audio comes from a video file, and Premiere drops its picture onto V2 when it's placed, " +
      "but this sequence has no V2. Add a video track, then Apply again.");
    expect(everything(s.seq)).toEqual(before);
  });

  it.each([["starts before it (a J cut)", 99, 9], ["has slipped out of sync", 100, 10.5]])(
    "refuses a camera's own sound that %s, changing nothing", (_, startS, inS) => {
      const s = scene();
      s.a.start = Time.s(startS); s.a.inPoint = Time.s(inS);
      const before = everything(s.seq);
      expect(() => applyCuts(s)).toThrow("A1's audio comes from the same file as V1's video but doesn't start with it in sync, so Genius Cut " +
        "can't place both on these tracks. Line them up, or put the audio on a track number with no selected video.");
      expect(everything(s.seq)).toEqual(before);
    });

  it.each([["fitting", 25], ["loose (24 fps in 25)", 24]])("%s: a camera's own sound running past its picture (an L cut) keeps its tail; Restore is exact", (_, fps) => {
    const s = scene();
    s.pi.mediaFps = fps; s.pi.floorToFrames = true;
    s.a.end = Time.s(112);
    expect(applyCuts(s)).toMatchObject({ ok: true });
    expect(everything(s.seq)).toEqual([[[100, 102], [102, 106], [106, 108]], [], [[100, 102], [102, 106], [106, 110]], [], []]);
    expect(span(s.seq.audioTracks[0]).map((x: number[]) => x[2])).toEqual([10, 13, 18]);
    expect(restore(s)).toEqual({ ok: true });
    expect(everything(s.seq)).toEqual([[[100, 110]], [], [[100, 112]], [], []]);
  });

  it("Restore refuses when a clip was placed where a camera's own sound would drop its picture, beyond the camera's clip", () => {
    const s = scene();
    s.a.end = Time.s(112);
    expect(applyCuts(s)).toMatchObject({ ok: true });
    s.seq.videoTracks[0].add(new ProjectItem("logo.png", "node-l", 5, "seconds", false), 110.4, 0, 0.6); // past V1's 110, under A1's 112
    expect(() => restore(s)).toThrow(/V1/);
    expect(layout(s.seq.videoTracks[0])).toContainEqual([110.4, 111]);
  });

  it("an audio-only mic.wav (Georg's A1) is laid last and drops nothing; the cameras' own sound is removed", () => {
    const s = georgScene();
    s.b.hasAudio = true; // Camera A and Camera B both bring their own sound, onto A1 and A2
    expect(applyCuts(s, cuts)).toMatchObject({ ok: true, clipCount: 4 });
    expect(span(s.seq.videoTracks[0])).toEqual([[100, 102, 10], [102, 106, 13], [106, 108, 18]]);
    expect(span(s.seq.videoTracks[1])).toEqual([[100.24, 102, 30], [102, 106, 32.76], [106, 107.84, 37.76]]);
    expect(span(s.seq.audioTracks[0])).toEqual([[99, 102, 50], [102, 106, 54], [106, 109, 59]]);
    expect(s.seq.audioTracks[1].clips.numItems + s.seq.audioTracks[2].clips.numItems).toBe(0);
    const rec = (s.host.ctx as any).$.global.gcutStash["m@" + START];
    expect(rec.items.find((i: any) => i.label === "A1").av).toBe(false);
    expect(s.host.call("gcutRestoreMulti", { startTicks: START })).toEqual({ ok: true });
    expect(span(s.seq.audioTracks[0])).toEqual([[99, 111, 50]]);
    expect(span(s.seq.videoTracks[1])).toEqual([[100.24, 109.84, 30]]);
    expect(s.seq.audioTracks[1].clips.numItems + s.seq.audioTracks[2].clips.numItems).toBe(0);
  });
});

describe("clean cuts: a 2-frame Constant Power crossfade at every internal cut of the recorded audio (QE, measured)", () => {
  /** [clip start, applyToStart, duration, offset, alignment] for every transition on the track. */
  const fades = (t: Track) => (t.clips as TrackItem[]).flatMap((c) => c.transitions.map((x) => [+c.start.seconds.toFixed(3), x.applyToStart, x.duration, x.offset, x.alignment]));
  const CENTRED = [true, "00:00:00:02", "00:00:00:00", 0.5];
  const noVideoFades = (seq: Seq) => {
    for (let t = 0; t < seq.videoTracks.numTracks; t++) expect(fades(seq.videoTracks[t])).toEqual([]);
  };

  it("crossfades each audio piece's start except the item's first, centred, 2 frames; video gets none", () => {
    const s = multiScene({ music: false });
    const r = applyCuts(s);
    expect(r).toMatchObject({ ok: true, crossfades: 2 });
    expect(r.warning).toBeUndefined();
    expect(fades(s.seq.audioTracks[0])).toEqual([[102, ...CENTRED], [106, ...CENTRED]]);
    noVideoFades(s.seq);
  });

  it("Georg's mic.wav running past the clips: crossfades at the two cuts, not at its first piece", () => {
    const s = georgScene();
    expect(applyCuts(s, cuts)).toMatchObject({ ok: true, crossfades: 2 });
    expect(fades(s.seq.audioTracks[0])).toEqual([[102, ...CENTRED], [106, ...CENTRED]]);
    noVideoFades(s.seq);
  });

  it("a single cut: one crossfade, on the audio only", () => {
    const s = georgScene();
    expect(applyCuts(s, [{ start: 0.04, end: 0.2 }])).toMatchObject({ ok: true, crossfades: 1 }); // 100.04-100.2
    expect(fades(s.seq.audioTracks[0]).map((x) => x[0])).toEqual([100.04]);
  });

  it("Restore leaves no transition behind (they go with the clips), and every clip is back exactly", () => {
    const s = multiScene({ music: false });
    expect(applyCuts(s)).toMatchObject({ ok: true, crossfades: 2 });
    expect(restoreMulti(s)).toEqual({ ok: true });
    expect(fades(s.seq.audioTracks[0])).toEqual([]);
    for (const [t, inS] of [[0, 10], [1, 12], [2, 5]] as const) expect(pieces(s.seq.videoTracks[t])).toEqual([[100, 110, inS]]);
    expect(pieces(s.seq.audioTracks[0])).toEqual([[100, 110, 10]]);
  });

  it("a failed Apply adds none, and rolls back exactly", () => {
    const s = multiScene({ music: false });
    s.seq.dropSpanIndex = 4;
    expect(applyCuts(s)).toMatchObject({ ok: false, rolledBack: true });
    expect(fades(s.seq.audioTracks[0])).toEqual([]);
    expect(pieces(s.seq.audioTracks[0])).toEqual([[100, 110, 10]]);
  });

  it.each([
    ["QE isn't available", (s: ReturnType<typeof multiScene>) => { delete (s.host.ctx as any).app.enableQE; }],
    ["Premiere has no Constant Power transition", (s: ReturnType<typeof multiScene>) => { s.host.qe.transition = false; }],
    ["addTransition throws", (s: ReturnType<typeof multiScene>) => { s.host.qe.throws = true; }],
  ])("when %s, Apply still succeeds with the cuts in place and says how many crossfades it couldn't add", (_, breakIt) => {
    const s = multiScene({ music: false });
    breakIt(s);
    const r = applyCuts(s);
    expect(r).toMatchObject({ ok: true, clipCount: 4, crossfades: 0, warning: "Couldn't add 2 crossfades; the cuts are in place." });
    expect(pieces(s.seq.audioTracks[0])).toEqual([[100, 102, 10], [102, 106, 13], [106, 108, 18]]);
    expect(pieces(s.seq.videoTracks[0])).toEqual([[100, 102, 10], [102, 106, 13], [106, 108, 18]]);
    expect(restoreMulti(s)).toEqual({ ok: true });
  });

  it("counts only the crossfades Premiere really added (one that adds nothing is reported as not added)", () => {
    const s = multiScene({ music: false });
    const real = s.host.qe.project.getActiveSequence;
    s.host.qe.project.getActiveSequence = () => {
      const q = real();
      return { getAudioTrackAt: (i: number) => {
        const t = q.getAudioTrackAt(i);
        // The clip after the first cut (102 s) says yes but nothing appears.
        const item = (k: number) => { const it = t.getItemAt(k); return it.type === "Clip" && Math.abs(it.start.secs - 102) < 1e-6 ? { ...it, addTransition: () => true } : it; };
        return { numItems: t.numItems, getItemAt: item, get numTransitions() { return t.numTransitions; } };
      } };
    };
    expect(applyCuts(s)).toMatchObject({ ok: true, crossfades: 1, warning: "Couldn't add 1 crossfade; the cuts are in place." });
  });
});

// ── the assistant's toolbox (the gcutTool* functions in extension/host/index.jsx) ────

const getSeq = (s: { host: ReturnType<typeof load> }, args: unknown = {}) => s.host.call("gcutToolGetSequence", args);
/** A clip id as get_sequence gives it: <V|A><track>@<startTicks>#<nodeId>. */
const idOf = (label: string, startS: number, node: string) => `${label}@${Math.round(startS * TICKS)}#${node}`;
const STALE = "The timeline changed since you read it; call get_sequence again.";

describe("gcutToolGetSequence: the active sequence for Claude", () => {
  it("lists the tracks, every clip with its id, times, source, selection and state, on Georg's sequence", () => {
    const s = georgScene();
    s.v2.disabled = true;
    s.seq.audioTracks[1].muted = true;
    const r = getSeq(s);
    expect(r).toMatchObject({ sequenceId: "seq-1", name: "Main edit", fps: 25, durationS: 115, markers: [] });
    expect(r.tracks).toEqual([
      { kind: "video", index: 1, name: "Video 1", muted: false }, { kind: "video", index: 2, name: "Video 2", muted: false },
      { kind: "video", index: 3, name: "Video 3", muted: false }, { kind: "video", index: 4, name: "Video 4", muted: false },
      { kind: "audio", index: 1, name: "Audio 1", muted: false }, { kind: "audio", index: 2, name: "Audio 2", muted: true },
      { kind: "audio", index: 3, name: "Audio 3", muted: false }]);
    expect(r.clips).toEqual([
      { id: idOf("V1", 100, "node-a"), track: "V1", name: "Camera A.mov", startS: 100, endS: 110, inS: 10, source: "D:/Footage/Camera A.mov", selected: true, enabled: true, effects: [], speed: 1 },
      { id: idOf("V2", 100.24, "node-b"), track: "V2", name: "Camera B.mov", startS: 100.24, endS: 109.84, inS: 30, source: "D:/Footage/Camera B.mov", selected: true, enabled: false, effects: [], speed: 1 },
      { id: idOf("V3", 100.28, "node-r"), track: "V3", name: "Restream.mov", startS: 100.28, endS: 110, inS: 5, source: "D:/Footage/Restream.mov", selected: true, enabled: true, effects: [], speed: 1 },
      { id: idOf("V4", 112, "node-t"), track: "V4", name: "Title", startS: 112, endS: 115, inS: 0, source: "D:/Footage/Title", selected: false, enabled: true, effects: [], speed: 1 },
      { id: idOf("A1", 99, "node-m"), track: "A1", name: "mic.wav", startS: 99, endS: 111, inS: 50, source: "D:/Footage/mic.wav", selected: true, enabled: true, effects: [], speed: 1 }]);
    expect(r.selection).toEqual([idOf("V1", 100, "node-a"), idOf("V2", 100.24, "node-b"), idOf("V3", 100.28, "node-r"), idOf("A1", 99, "node-m")]);
  });

  it("names each clip's effects, leaving out the intrinsic ones (Motion, Opacity, Volume...)", () => {
    const s = georgScene();
    s.v1.addEffect("Lumetri Color");
    s.a1.addEffect("DeNoise");
    s.a1.addEffect("Lumetri Color");
    const fx = Object.fromEntries(getSeq(s).clips.map((c: any) => [c.track, c.effects]));
    expect(fx).toEqual({ V1: ["Lumetri Color"], V2: [], V3: [], V4: [], A1: ["DeNoise", "Lumetri Color"] });
  });

  it("gives each clip's speed as the Cut tab checks it (1 = 100%, negative = reversed)", () => {
    const s = georgScene();
    s.v2.speed = 2;
    s.v3.speed = 0.5; s.v3.reversed = 1;
    const speed = Object.fromEntries(getSeq(s).clips.map((c: any) => [c.track, c.speed]));
    expect(speed).toEqual({ V1: 1, V2: 2, V3: -0.5, V4: 1, A1: 1 });
  });

  it("lists sequence markers with their guid as id, range, name, comments and colour", () => {
    const s = georgScene();
    const m = s.seq.markers.createMarker(105);
    m.name = "Pricing"; m.comments = "talks about plans"; m.end = 107; m.setColorByIndex(3);
    s.seq.markers.createMarker(101).name = "Intro";
    expect(getSeq(s).markers).toEqual([
      { id: s.seq.markers.list[1].guid, startS: 101, endS: 101, name: "Intro", comments: "", colour: 0 },
      { id: m.guid, startS: 105, endS: 107, name: "Pricing", comments: "talks about plans", colour: 3 }]);
  });

  it("with {fromS, toS}, lists only the clips and markers overlapping that stretch", () => {
    const s = georgScene();
    s.seq.markers.createMarker(50).name = "early";
    s.seq.markers.createMarker(113).name = "late";
    const r = getSeq(s, { fromS: 111, toS: 120 });
    expect(r.clips.map((c: any) => c.track)).toEqual(["V4"]);
    expect(r.markers.map((x: any) => x.name)).toEqual(["late"]);
    expect(r.durationS).toBe(115);
    expect(getSeq(s, { fromS: 0, toS: 99.5 }).clips.map((c: any) => c.track)).toEqual(["A1"]);
  });

  it("an empty sequence has no clips and lasts 0 s", () => {
    const seq = new Seq(1, 1);
    expect(getSeq({ host: load(seq) })).toMatchObject({ durationS: 0, clips: [], markers: [], selection: [] });
  });

  it("fails without an active sequence", () => {
    const s = georgScene();
    (s.host.ctx as any).app.project.activeSequence = null;
    expect(() => getSeq(s)).toThrow(/No active sequence/);
  });
});

describe("gcutResolveIds: clip ids back to the clips on the timeline", () => {
  const resolve = (s: ReturnType<typeof georgScene>, ids: string[]) => (s.host.ctx as any).gcutResolveIds(s.seq, ids);

  it("every id get_sequence gives finds exactly its own clip", () => {
    const s = georgScene();
    const ids = getSeq(s).clips.map((c: any) => c.id);
    const got = resolve(s, ids);
    expect(got.map((x: any) => [x.kind, x.trackIndex])).toEqual([["video", 0], ["video", 1], ["video", 2], ["video", 3], ["audio", 0]]);
    got.forEach((x: any, i: number) => expect(x.item).toBe([s.v1, s.v2, s.v3, s.seq.videoTracks[3].items[0], s.a1][i]));
  });

  it("an id named twice is resolved once", () => {
    const s = georgScene();
    expect(resolve(s, [idOf("V1", 100, "node-a"), idOf("V1", 100, "node-a")])).toHaveLength(1);
  });

  it.each([
    ["the clip moved", (s: ReturnType<typeof georgScene>) => { s.v2.start = Time.s(101); }],
    ["another source sits there now", (s: ReturnType<typeof georgScene>) => { s.v2.projectItem = s.a; }],
    ["the clip is gone", (s: ReturnType<typeof georgScene>) => { s.seq.videoTracks[1].items = []; }],
  ])("refuses a stale id when %s", (_, change) => {
    const s = georgScene();
    const id = getSeq(s).clips[1].id;
    change(s);
    expect(() => resolve(s, [id])).toThrow(STALE);
  });

  it.each(["V9@2540160000000#node-a", "nonsense", "A0@0#node-m"])("refuses an id that names nothing (%s)", (id) => {
    expect(() => resolve(georgScene(), [id])).toThrow(STALE);
  });

  it("refuses an empty list", () => {
    expect(() => resolve(georgScene(), [])).toThrow(/at least one clip/);
  });
});

describe("gcutToolAddMarkers and its undo", () => {
  const add = (s: ReturnType<typeof georgScene>, markers: unknown, sequenceId = "seq-1") => s.host.call("gcutToolAddMarkers", { sequenceId, markers });
  const undo = (s: { host: ReturnType<typeof load> }, record: unknown) => s.host.call("gcutToolUndo", { record });
  const all = (s: ReturnType<typeof georgScene>) => getSeq(s).markers.map((m: any) => [m.startS, m.endS, m.name, m.comments, m.colour]);
  const TWO = [{ atS: 105, endS: 107, name: "Pricing", comments: "plans and prices", colour: 3 }, { atS: 101, name: "Intro" }];

  it("adds point and range markers with name, comments and colour, and returns their ids and a pure-data undo record", () => {
    const s = georgScene();
    const r = add(s, TWO);
    expect(r.ok).toBe(true);
    expect(all(s)).toEqual([[101, 101, "Intro", "", 0], [105, 107, "Pricing", "plans and prices", 3]]);
    const [pricing, intro] = [s.seq.markers.list[0], s.seq.markers.list[1]];
    expect(r.created).toEqual([pricing.guid, intro.guid]);
    expect(r.undo).toEqual({ kind: "markers", sequenceId: "seq-1", markers: [
      { id: pricing.guid, startS: 105, endS: 107, name: "Pricing", comments: "plans and prices", colour: 3 },
      { id: intro.guid, startS: 101, endS: 101, name: "Intro", comments: "", colour: 0 }] });
  });

  it("undo removes exactly the markers it added, from the record alone (after a panel reload), and leaves the others", () => {
    const s = georgScene();
    s.seq.markers.createMarker(50).name = "Georg's own";
    const record = JSON.parse(JSON.stringify(add(s, TWO).undo));
    const reloaded = { host: load(s.seq) };
    expect(undo(reloaded, record)).toEqual({ ok: true });
    expect(all(s)).toEqual([[50, 50, "Georg's own", "", 0]]);
  });

  it.each([
    ["a time before the sequence", [{ atS: -1, name: "x" }], /Marker 1/],
    ["a time past the sequence's end (115 s)", [{ atS: 100, name: "ok" }, { atS: 116, name: "x" }], /Marker 2/],
    ["a range ending before it starts", [{ atS: 105, endS: 104, name: "x" }], /Marker 1/],
    ["a range ending past the sequence", [{ atS: 105, endS: 120, name: "x" }], /Marker 1/],
    ["no name", [{ atS: 105 }], /Marker 1 needs a name/],
    ["a colour Premiere doesn't have", [{ atS: 105, name: "x", colour: 8 }], /colour/],
    ["no markers at all", [], /at least one marker/],
  ])("refuses %s, adding nothing", (_, markers, msg) => {
    const s = georgScene();
    expect(() => add(s, markers)).toThrow(msg);
    expect(s.seq.markers.numMarkers).toBe(0);
  });

  it("refuses when a different sequence is open, adding nothing", () => {
    const s = georgScene();
    expect(() => add(s, TWO, "seq-2")).toThrow(/different sequence/);
    expect(s.seq.markers.numMarkers).toBe(0);
  });

  it("a failure part-way removes the markers it already added, then fails", () => {
    const s = georgScene();
    s.seq.markers.createMarker(50).name = "Georg's own";
    const real = s.seq.markers.createMarker.bind(s.seq.markers);
    let n = 0;
    s.seq.markers.createMarker = (sec: number) => { if (++n === 2) throw new Error("Premiere refused"); return real(sec); };
    expect(() => add(s, TWO)).toThrow(/Premiere refused/);
    expect(all(s)).toEqual([[50, 50, "Georg's own", "", 0]]);
  });

  it.each([
    ["renamed", (m: Marker) => { m.name = "Prices"; }],
    ["moved", (m: Marker) => { m.start = Time.s(106); }],
    ["given a different range", (m: Marker) => { m.end = 108; }],
    ["recoloured", (m: Marker) => { m.setColorByIndex(1); }],
    ["given other comments", (m: Marker) => { m.comments = "edited"; }],
  ])("undo refuses, deleting nothing, when one was %s by hand", (_, change) => {
    const s = georgScene();
    const record = add(s, TWO).undo;
    change(s.seq.markers.list[0]);
    const before = all(s);
    expect(() => undo(s, record)).toThrow(/changed by hand.*Pricing/);
    expect(all(s)).toEqual(before);
    expect(s.seq.markers.numMarkers).toBe(2);
  });

  it("undo refuses, deleting nothing, when only some were deleted by hand", () => {
    const s = georgScene();
    const record = add(s, TWO).undo;
    s.seq.markers.deleteMarker(s.seq.markers.list[1]);
    expect(() => undo(s, record)).toThrow(/changed by hand.*Intro/);
    expect(all(s)).toEqual([[105, 107, "Pricing", "plans and prices", 3]]);
  });

  it("when every one was already deleted by hand, undo says it is already undone", () => {
    const s = georgScene();
    const record = add(s, TWO).undo;
    for (const m of [...s.seq.markers.list]) s.seq.markers.deleteMarker(m);
    expect(undo(s, record)).toEqual({ ok: true, alreadyUndone: true });
  });

  it.each([
    ["no markers", { kind: "markers", sequenceId: "seq-1", markers: [] }],
    ["no marker list", { kind: "markers", sequenceId: "seq-1" }],
    ["a marker list that isn't one", { kind: "markers", sequenceId: "seq-1", markers: "Intro" }],
  ])("undo refuses a record with %s as incomplete (not already undone), deleting nothing", (_, record) => {
    const s = georgScene();
    add(s, TWO);
    expect(() => undo(s, record)).toThrow("This undo record is incomplete.");
    expect(s.seq.markers.numMarkers).toBe(2);
  });

  describe("check: true runs every refusal and changes nothing, matching the real undo's outcome", () => {
    const check = (s: { host: ReturnType<typeof load> }, record: unknown) => s.host.call("gcutToolUndo", { record, check: true });
    const outcome = (f: () => unknown) => { try { return f(); } catch (e) { return String((e as Error).message); } };

    it.each([
      ["untouched", (_: ReturnType<typeof georgScene>) => {}],
      ["one renamed", (s: ReturnType<typeof georgScene>) => { s.seq.markers.list[0].name = "Prices"; }],
      ["one deleted", (s: ReturnType<typeof georgScene>) => { s.seq.markers.deleteMarker(s.seq.markers.list[1]); }],
      ["all deleted", (s: ReturnType<typeof georgScene>) => { for (const m of [...s.seq.markers.list]) s.seq.markers.deleteMarker(m); }],
    ])("%s", (name, change) => {
      const s = georgScene();
      const record = asStored(add(s, TWO).undo);
      change(s);
      const before = all(s);
      const checked = outcome(() => check(s, record));
      expect(all(s)).toEqual(before);
      expect(outcome(() => check(s, record))).toEqual(checked); // checking twice is the same: nothing changed
      const real = outcome(() => undo(s, record));
      if (name === "untouched") {
        expect(checked).toEqual({ ok: true, wouldUndo: true });
        expect(real).toEqual({ ok: true });
      } else {
        expect(real).toEqual(checked);
      }
    });

    it("refuses an incomplete record, and a different sequence, the same way", () => {
      const s = georgScene();
      const record = add(s, TWO).undo;
      expect(() => check(s, { kind: "markers", sequenceId: "seq-1" })).toThrow("This undo record is incomplete.");
      s.seq.sequenceID = "seq-2";
      expect(() => check(s, record)).toThrow(/different sequence/);
      expect(s.seq.markers.numMarkers).toBe(2);
    });
  });

  it("undo refuses on a different sequence, and a record it doesn't know", () => {
    const s = georgScene();
    const record = add(s, TWO).undo;
    s.seq.sequenceID = "seq-2";
    expect(() => undo(s, record)).toThrow(/different sequence/);
    expect(s.seq.markers.numMarkers).toBe(2);
    expect(() => undo(s, { kind: "teleport", sequenceId: "seq-2" })).toThrow(/can't undo/);
    expect(() => undo(s, null)).toThrow(/nothing to undo/);
  });
});

const cutTool = (s: { host: ReturnType<typeof load> }, clipIds: string[], ranges: unknown, sequenceId = "seq-1") =>
  s.host.call("gcutToolCutRanges", { sequenceId, clipIds, ranges });
const undoTool = (s: { host: ReturnType<typeof load> }, record: unknown) => s.host.call("gcutToolUndo", { record });
/** A record as the bridge keeps it: JSON only, no live objects. */
const asStored = (record: unknown) => JSON.parse(JSON.stringify(record));
const allTracks = (seq: Seq) => [...Array.from({ length: seq.videoTracks.numTracks }, (_, t) => span(seq.videoTracks[t])),
  ...Array.from({ length: seq.audioTracks.numTracks }, (_, t) => span(seq.audioTracks[t]))];
const RANGES = [{ fromS: 102, toS: 103 }, { fromS: 107, toS: 108 }];

describe("gcutToolAdvice: Apply's refusals worded for Claude, who reads the timeline instead of analysing", () => {
  const advice = (msg: string) => (load(new Seq()).ctx as any).gcutToolAdvice(new Error(msg)).message;
  it.each([
    ["V1's clip changed since Analyse. Analyse again.", "V1's clip changed since you read the timeline. Read the timeline again."],
    ["V3 is locked. Unlock it to apply.", "V3 is locked. Unlock it to cut."],
    ["Add a video track, then Apply again.", "Add a video track, then call cut_ranges again."],
    ["Deselect it, then Analyse again.", "Deselect it, then read the timeline again."],
    ["Move that clip off A1's time.", "Move that clip off A1's time."],
  ])("%s", (from, to) => expect(advice(from)).toBe(to));
});

describe("gcutToolCutRanges: timeline ranges cut from chosen clips with Apply's engine, and its undo", () => {
  const bins = (s: ReturnType<typeof georgScene>) => [s.a, s.b, s.scr, s.mic].map((pi) => [pi.inS, pi.outS]);
  function marked() {
    const s = georgScene();
    for (const pi of [s.a, s.b, s.scr, s.mic]) { pi.inS = 2; pi.outS = 58; }
    return s;
  }

  it("cuts exactly as Apply does on Georg's sequence (fitting sources), leaves the bins' marks, and undo puts every clip back exactly", () => {
    const s = marked(), original = allTracks(s.seq);
    const r = cutTool(s, getSeq(s).selection, RANGES);
    expect(r).toMatchObject({ ok: true, cutCount: 2, clipCount: 4, crossfades: 2 });
    expect(r.removedS).toBeCloseTo(2, 9);
    expect(span(s.seq.videoTracks[0])).toEqual([[100, 102, 10], [102, 106, 13], [106, 108, 18]]);
    expect(span(s.seq.videoTracks[1])).toEqual([[100.24, 102, 30], [102, 106, 32.76], [106, 107.84, 37.76]]);
    expect(span(s.seq.videoTracks[2])).toEqual([[100.28, 102, 5], [102, 106, 7.72], [106, 108, 12.72]]);
    expect(span(s.seq.audioTracks[0])).toEqual([[99, 102, 50], [102, 106, 54], [106, 109, 59]]);
    expect(span(s.seq.videoTracks[3])).toEqual([[112, 115, 0]]);
    expect(bins(s)).toEqual([[2, 58], [2, 58], [2, 58], [2, 58]]);
    // Never the Apply/Restore stash.
    expect(Object.keys((s.host.ctx as any).$.global.gcutStash)).toEqual([]);
    expect(undoTool(s, asStored(r.undo))).toEqual({ ok: true });
    expect(allTracks(s.seq)).toEqual(original);
    expect(bins(s)).toEqual([[2, 58], [2, 58], [2, 58], [2, 58]]);
  });

  it("returns idMap: each chosen clip's old id to the ids of the pieces it became, as get_sequence now gives them", () => {
    const s = georgScene();
    const r = cutTool(s, getSeq(s).selection, RANGES);
    expect(r.idMap).toEqual({
      [idOf("V1", 100, "node-a")]: [idOf("V1", 100, "node-a"), idOf("V1", 102, "node-a"), idOf("V1", 106, "node-a")],
      [idOf("V2", 100.24, "node-b")]: [idOf("V2", 100.24, "node-b"), idOf("V2", 102, "node-b"), idOf("V2", 106, "node-b")],
      [idOf("V3", 100.28, "node-r")]: [idOf("V3", 100.28, "node-r"), idOf("V3", 102, "node-r"), idOf("V3", 106, "node-r")],
      [idOf("A1", 99, "node-m")]: [idOf("A1", 99, "node-m"), idOf("A1", 102, "node-m"), idOf("A1", 106, "node-m")],
    });
    const now = getSeq(s).clips.map((c: any) => c.id);
    for (const ids of Object.values(r.idMap) as string[][]) for (const id of ids) expect(now).toContain(id);
  });

  it("idMap leaves out a chosen clip whose id didn't change (cut only past its end, or only its tail trimmed)", () => {
    const s = georgScene();
    // Only A1 runs past 110 s: V1-V3 are laid back whole where they were; A1 keeps its start, losing its tail.
    const r = cutTool(s, getSeq(s).selection, [{ fromS: 110.5, toS: 111 }]);
    expect(r).toMatchObject({ ok: true, idMap: {} });
  });

  it("the undo record is pure data: the cut's place, its cuts, each item as Apply records it, and the others as gcutOthers gives them", () => {
    const s = georgScene();
    s.seq.videoTracks[1].add(s.b, 99.5, 29.26, 30); // a razored head of Camera B, not chosen
    const r = cutTool(s, getSeq(s).selection, RANGES);
    expect(asStored(r.undo)).toEqual(r.undo);
    expect(r.undo).toMatchObject({ kind: "cuts", sequenceId: "seq-1", startT: 99 * TICKS, endT: 111 * TICKS, rebuiltEndT: 109 * TICKS,
      cutsT: [{ startT: 102 * TICKS, endT: 103 * TICKS }, { startT: 107 * TICKS, endT: 108 * TICKS }] });
    expect(Object.keys(r.undo.items[0]).sort()).toEqual(
      ["av", "endT", "inS", "kind", "label", "loose", "mediaFrameS", "node", "outS", "srcFrameS", "startT", "trackIndex"]);
    expect(r.undo.items.map((i: any) => [i.label, i.node, i.startT / TICKS, i.endT / TICKS, i.inS])).toEqual(
      [["V1", "node-a", 100, 110, 10], ["V2", "node-b", 100.24, 109.84, 30], ["V3", "node-r", 100.28, 110, 5], ["A1", "node-m", 99, 111, 50]]);
    expect(r.undo.others).toEqual([{ label: "V2", t: 1, start: Math.round(99.5 * TICKS), end: Math.round(100.24 * TICKS), inS: 29.26, node: "node-b" }]);
  });

  it("undo after a panel reload, from the stored record only: a same-source clip among the others survives", () => {
    const s = georgScene();
    s.seq.videoTracks[1].add(s.b, 99.5, 29.26, 30);
    const original = allTracks(s.seq);
    const record = asStored(cutTool(s, getSeq(s).selection, RANGES).undo);
    expect(span(s.seq.videoTracks[1])).toEqual([[99.5, 100.24, 29.26], [100.24, 102, 30], [102, 106, 32.76], [106, 107.84, 37.76]]);
    const reloaded = { host: load(s.seq) }; // a fresh ExtendScript engine: no stash, no live objects
    expect(undoTool(reloaded, record)).toEqual({ ok: true });
    expect(allTracks(s.seq)).toEqual(original);
  });

  it("cuts only the chosen clips: clips on tracks it wasn't given stay as they are", () => {
    const s = georgScene();
    const ids = getSeq(s).clips.filter((c: any) => c.track === "V1" || c.track === "A1").map((c: any) => c.id);
    const r = cutTool(s, ids, [{ fromS: 104, toS: 105 }]);
    expect(r).toMatchObject({ ok: true, clipCount: 2 });
    expect(span(s.seq.videoTracks[0])).toEqual([[100, 104, 10], [104, 109, 15]]);
    expect(span(s.seq.videoTracks[1])).toEqual([[100.24, 109.84, 30]]);
    expect(span(s.seq.videoTracks[2])).toEqual([[100.28, 110, 5]]);
    expect(span(s.seq.audioTracks[0])).toEqual([[99, 104, 50], [104, 110, 56]]);
    expect(undoTool(s, asStored(r.undo))).toEqual({ ok: true });
    expect(span(s.seq.videoTracks[0])).toEqual([[100, 110, 10]]);
    expect(span(s.seq.audioTracks[0])).toEqual([[99, 111, 50]]);
  });

  describe("refuses, changing nothing", () => {
    type Case = { s: any; ids: string[]; ranges?: unknown; seqId?: string; msg: string | RegExp };
    it.each<[string, () => Case]>([
      ["linked audio it wasn't given (V1 without its own sound on A1)", () => {
        const s = scene();
        return { s, ids: [getSeq(s).clips[0].id], msg: "Placing V1 also drops its own sound onto A1, which would cover interview_take3.mp4. Move that clip off A1's time." };
      }],
      ["a slide over a clip it wasn't given", () => {
        const s = georgScene();
        s.seq.videoTracks[2].add(new ProjectItem("bumper.mov", "node-u", 30, "seconds", false), 99, 0, 1.28); // ends at 100.28
        return { s, ids: getSeq(s).selection, ranges: [{ fromS: 100.04, toS: 100.2 }], msg: /Moving V3's clip left would cover bumper.mov on V3/ };
      }],
      ["a locked track", () => { const s = georgScene(); s.seq.videoTracks[2].locked = true; return { s, ids: getSeq(s).selection, msg: /V3 is locked/ }; }],
      ["a clip not at 100% speed", () => { const s = georgScene(); s.v2.speed = 2; return { s, ids: getSeq(s).selection, msg: /V2 isn't at 100% speed/ }; }],
      ["unchosen audio under the chosen video, saying to read the timeline again (not to Analyse)", () => {
        const s = scene();
        s.seq.audioTracks[1].add(wav("music.wav", "node-9", 300), 90, 0, 40);
        return { s, ids: getSeq(s).selection, msg: "A2 (music.wav) sits under the selected video clips, and rebuilding them could overwrite it. " +
          "Select it too, or move it off the clips' time, then read the timeline again." };
      }],
      ["a locked track, saying to unlock it to cut (not to apply)", () => {
        const s = georgScene(); s.seq.videoTracks[2].locked = true; return { s, ids: getSeq(s).selection, msg: "V3 is locked. Unlock it to cut." };
      }],
      ["audio from a video file with no video track of its number, saying to call cut_ranges again (not Apply)", () => {
        const seq = new Seq(1, 2);
        seq.audioTracks[1].add(new ProjectItem("Zoom.mp4", "node-z", 600), 100, 10, 20);
        const s = { seq, host: load(seq) };
        return { s, ids: getSeq(s).clips.map((c: any) => c.id), msg: "A2's audio comes from a video file, and Premiere drops its picture onto V2 " +
          "when it's placed, but this sequence has no V2. Add a video track, then call cut_ranges again." };
      }],
      ["a chosen clip with no source media, with its own message", () => {
        const s = georgScene();
        const title = s.seq.videoTracks[3].items[0];
        (title as any).projectItem = null;
        Object.defineProperty(title, "name", { value: "Graphic" });
        return { s, ids: [`V4@${title.start.ticks}#`], ranges: [{ fromS: 113, toS: 114 }], msg: "V4's clip can't be cut: it has no source media." };
      }],
      ["a different sequence", () => { const s = georgScene(); return { s, ids: getSeq(s).selection, seqId: "seq-2", msg: /different sequence/ }; }],
      ["a stale id", () => { const s = georgScene(); const ids = getSeq(s).selection; s.v2.start = Time.s(100.2); return { s, ids, msg: STALE }; }],
      ["ranges outside the chosen clips", () => { const s = georgScene(); return { s, ids: getSeq(s).selection, ranges: [{ fromS: 120, toS: 121 }], msg: /nothing to cut/ }; }],
      ["no ranges", () => { const s = georgScene(); return { s, ids: getSeq(s).selection, ranges: [], msg: /nothing to cut/ }; }],
      ["a range without times", () => { const s = georgScene(); return { s, ids: getSeq(s).selection, ranges: [{ fromS: 102 }], msg: /Range 1/ }; }],
    ])("%s", (_, make) => {
      const { s, ids, ranges, seqId, msg } = make();
      const before = allTracks(s.seq), pis = s.seq.bin.map((pi: ProjectItem) => [pi.inS, pi.outS]);
      expect(() => cutTool(s, ids, ranges ?? RANGES, seqId)).toThrow(msg);
      expect(allTracks(s.seq)).toEqual(before);
      expect(s.seq.bin.map((pi: ProjectItem) => [pi.inS, pi.outS])).toEqual(pis);
    });
  });

  describe("effects: the rebuild doesn't keep them, so the user must agree first", () => {
    function withEffects() {
      const s = georgScene();
      s.v2.addEffect("Lumetri Color");
      s.a1.addEffect("DeNoise");
      return s;
    }

    it("refuses, changing nothing, naming each chosen clip and its effects", () => {
      const s = withEffects(), before = allTracks(s.seq);
      expect(() => cutTool(s, getSeq(s).selection, RANGES)).toThrow(
        "Cutting rebuilds the clips from their source, so these effects would be removed: V2 (Camera B.mov): Lumetri Color; " +
        "A1 (mic.wav): DeNoise. Nothing was changed. Ask the user; only if they agree, call cut_ranges again with acceptEffectLoss: true.");
      expect(allTracks(s.seq)).toEqual(before);
    });

    it("ignores effects on clips it wasn't given", () => {
      const s = withEffects();
      const ids = getSeq(s).clips.filter((c: any) => c.track === "V1").map((c: any) => c.id);
      s.seq.audioTracks[0].items = []; // V1 has no sound of its own here; keep A1 out of the way
      expect(cutTool(s, ids, [{ fromS: 104, toS: 105 }])).toMatchObject({ ok: true, clipCount: 1 });
    });

    it("with acceptEffectLoss: true, cuts (and undo still puts every clip back)", () => {
      const s = withEffects(), original = allTracks(s.seq);
      const r = s.host.call("gcutToolCutRanges", { sequenceId: "seq-1", clipIds: getSeq(s).selection, ranges: RANGES, acceptEffectLoss: true });
      expect(r).toMatchObject({ ok: true, cutCount: 2, clipCount: 4 });
      expect(undoTool(s, asStored(r.undo))).toEqual({ ok: true });
      expect(allTracks(s.seq)).toEqual(original);
    });

    it("anything but true is no agreement", () => {
      const s = withEffects();
      expect(() => s.host.call("gcutToolCutRanges", { sequenceId: "seq-1", clipIds: getSeq(s).selection, ranges: RANGES, acceptEffectLoss: "yes" }))
        .toThrow(/acceptEffectLoss/);
    });
  });

  it("a piece landing wrong rolls every clip back, and says so", () => {
    const s = georgScene(), original = allTracks(s.seq);
    s.seq.dropSpanIndex = 4;
    expect(() => cutTool(s, getSeq(s).selection, RANGES)).toThrow(/didn't land where or as expected\. Every clip was put back\./);
    expect(allTracks(s.seq)).toEqual(original);
  });

  describe("undo", () => {
    function cutGeorg() {
      const s = georgScene();
      const original = allTracks(s.seq), saved = [...s.seq.videoTracks, ...s.seq.audioTracks].map((t: Track) => [...t.items]);
      const record = asStored(cutTool(s, getSeq(s).selection, RANGES).undo);
      return { s, original, saved, record, cut: allTracks(s.seq) };
    }

    it("refuses, changing nothing, when a cut piece was moved since", () => {
      const { s, record, cut } = cutGeorg();
      s.seq.videoTracks[0].clips[1].drag(Time.s(0.2));
      const now = allTracks(s.seq);
      expect(now).not.toEqual(cut);
      expect(() => undoTool(s, record)).toThrow(/changed since.*Nothing was undone/);
      expect(allTracks(s.seq)).toEqual(now);
    });

    it("refuses, changing nothing, when a cut piece was slip-edited since (same place and length, another in point)", () => {
      const { s, record } = cutGeorg();
      const piece = s.seq.videoTracks[0].clips[1];
      piece.trueIn = Time.s(piece.trueIn.seconds + 0.4);
      const now = allTracks(s.seq);
      expect(() => undoTool(s, record)).toThrow("A cut piece on V1 was slip-edited since (its source in point changed), so the cut changed since. " +
        "Nothing was undone; use Premiere's Undo instead.");
      expect(allTracks(s.seq)).toEqual(now);
    });

    it("refuses, changing nothing, when something was placed in the gap since (an extra piece of a cut source)", () => {
      const { s, record } = cutGeorg();
      s.seq.videoTracks[0].add(s.a, 108.2, 40, 40.8);
      const now = allTracks(s.seq);
      expect(() => undoTool(s, record)).toThrow(/gap on V1/);
      expect(allTracks(s.seq)).toEqual(now);
    });

    it("when the original arrangement is back (Premiere's Undo), says it is already undone and changes nothing", () => {
      const { s, record, original, saved } = cutGeorg();
      [...s.seq.videoTracks, ...s.seq.audioTracks].forEach((t: Track, k: number) => { t.items = saved[k]; });
      expect(allTracks(s.seq)).toEqual(original);
      expect(undoTool(s, record)).toEqual({ ok: true, alreadyUndone: true });
      expect(allTracks(s.seq)).toEqual(original);
    });

    it("when the original clips don't go back, lays the cut version back as it was and says so", () => {
      const { s, record, cut } = cutGeorg();
      const bins = s.seq.bin.map((pi) => [pi.inS, pi.outS]);
      s.seq.dropSpanIndex = (s.seq as any).placements; // the undo's first placement goes missing
      expect(() => undoTool(s, record)).toThrow("The original clips didn't go back as expected, so the cut version was put back as it was. " +
        "Nothing was undone; try again, or use Premiere's Undo.");
      expect(allTracks(s.seq)).toEqual(cut);
      expect(s.seq.bin.map((pi) => [pi.inS, pi.outS])).toEqual(bins);
    });

    it("is not \"already undone\" when one clip is back but another's cut pieces remain: refuses, changing nothing", () => {
      const { s, record, original, saved } = cutGeorg();
      s.seq.videoTracks[0].items = saved[0]; // V1 back as it was (Premiere's Undo of part of it); V2, V3 and A1 still cut
      expect(span(s.seq.videoTracks[0])).toEqual(original[0]);
      const now = allTracks(s.seq);
      expect(() => undoTool(s, record)).toThrow(/changed since.*Nothing was undone/);
      expect(allTracks(s.seq)).toEqual(now);
    });

    it("refuses when a source is no longer in the project, changing nothing", () => {
      const { s, record, cut } = cutGeorg();
      s.seq.bin = s.seq.bin.filter((pi) => pi !== s.b);
      expect(() => undoTool(s, record)).toThrow(/V2's source isn't in the project/);
      expect(allTracks(s.seq)).toEqual(cut);
    });

    it("refuses on a different sequence", () => {
      const { s, record, cut } = cutGeorg();
      s.seq.sequenceID = "seq-2";
      expect(() => undoTool(s, record)).toThrow(/different sequence/);
      expect(allTracks(s.seq)).toEqual(cut);
    });

    describe("check: true runs every refusal and changes nothing, matching the real undo's outcome", () => {
      const checkTool = (s: { host: ReturnType<typeof load> }, record: unknown) => s.host.call("gcutToolUndo", { record, check: true });
      const outcome = (f: () => unknown) => { try { return f(); } catch (e) { return String((e as Error).message); } };
      type Ctx = ReturnType<typeof cutGeorg>;

      it.each([
        ["untouched", (_: Ctx) => {}],
        ["a cut piece moved", ({ s }: Ctx) => { s.seq.videoTracks[0].clips[1].drag(Time.s(0.2)); }],
        ["a cut piece slip-edited", ({ s }: Ctx) => { const p = s.seq.videoTracks[0].clips[1]; p.trueIn = Time.s(p.trueIn.seconds + 0.4); }],
        ["something placed in the gap", ({ s }: Ctx) => { s.seq.videoTracks[0].add(s.a, 108.2, 40, 40.8); }],
        ["the original back (Premiere's Undo)", ({ s, saved }: Ctx) => { [...s.seq.videoTracks, ...s.seq.audioTracks].forEach((t: Track, k: number) => { t.items = saved[k]; }); }],
        ["one clip back, the others still cut", ({ s, saved }: Ctx) => { s.seq.videoTracks[0].items = saved[0]; }],
        ["a source gone from the project", ({ s }: Ctx) => { s.seq.bin = s.seq.bin.filter((pi) => pi !== s.b); }],
      ])("%s", (name, change) => {
        const ctx = cutGeorg(), { s, record } = ctx;
        change(ctx);
        const now = allTracks(s.seq), bins = s.seq.bin.map((pi) => [pi.inS, pi.outS]), placements = (s.seq as any).placements;
        const checked = outcome(() => checkTool(s, record));
        expect(allTracks(s.seq)).toEqual(now);
        expect(s.seq.bin.map((pi) => [pi.inS, pi.outS])).toEqual(bins);
        expect((s.seq as any).placements).toBe(placements);
        const real = outcome(() => undoTool(s, record));
        if (name === "untouched") {
          expect(checked).toEqual({ ok: true, wouldUndo: true });
          expect(real).toEqual({ ok: true });
          expect(allTracks(s.seq)).toEqual(ctx.original);
        } else {
          expect(real).toEqual(checked);
        }
      });
    });
  });
});

// ── piece 4 act tools (plan tasks 5-7), each with an exact undo ──────────────────────

/** Every clip on every track, exactly: track, start and end ticks, true in point, source and on/off. */
const exact = (seq: Seq) => [...seq.videoTracks, ...seq.audioTracks].map((t: Track) =>
  t.clips.map((i: TrackItem) => [i.start.t, i.end.t, +i.trueIn.seconds.toFixed(6), i.projectItem?.nodeId ?? null, i.disabled]));
const act = (s: { host: ReturnType<typeof load> }, fn: string, args: object) => s.host.call(fn, { sequenceId: "seq-1", ...args });
const undoCheck = (s: { host: ReturnType<typeof load> }, record: unknown) => s.host.call("gcutToolUndo", { record, check: true });
const outcomeOf = (f: () => unknown) => { try { return f(); } catch (e) { return String((e as Error).message); } };
const idsOn = (s: { host: ReturnType<typeof load> }, ...labels: string[]) => getSeq(s).clips.filter((c: any) => labels.includes(c.track)).map((c: any) => c.id);

/**
 * check: true must change nothing, give the same answer twice, and match the real undo; untouched, it says
 * wouldUndo and the real undo restores `original` exactly.
 */
function checkMatchesUndo(s: { seq: Seq; host: ReturnType<typeof load> }, record: unknown, untouched: boolean, original?: unknown) {
  const now = exact(s.seq);
  const checked = outcomeOf(() => undoCheck(s, record));
  expect(exact(s.seq)).toEqual(now);
  expect(outcomeOf(() => undoCheck(s, record))).toEqual(checked);
  const real = outcomeOf(() => undoTool(s, record));
  if (untouched) {
    expect(checked).toEqual({ ok: true, wouldUndo: true });
    expect(real).toEqual({ ok: true });
    if (original) expect(exact(s.seq)).toEqual(original);
  } else expect(real).toEqual(checked);
}

describe("gcutToolSetClipEnabled: switch chosen clips off or on, and its undo", () => {
  const set = (s: any, clipIds: string[], enabled: unknown) => act(s, "gcutToolSetClipEnabled", { clipIds, enabled });

  it("switches the chosen clips off (TrackItem.disabled, measured), touching nothing else; undo switches them back exactly", () => {
    const s = georgScene(), original = exact(s.seq);
    const r = set(s, idsOn(s, "V2", "V3"), false);
    expect(r).toMatchObject({ ok: true, changed: 2, idMap: {} });
    expect([s.v1.disabled, s.v2.disabled, s.v3.disabled, s.a1.disabled]).toEqual([false, true, true, false]);
    expect(asStored(r.undo)).toEqual(r.undo);
    expect(r.undo).toMatchObject({ kind: "enabled", sequenceId: "seq-1" });
    expect(undoTool({ host: load(s.seq) }, asStored(r.undo))).toEqual({ ok: true });
    expect(exact(s.seq)).toEqual(original);
  });

  it("switching on a clip that is already on changes nothing and its undo leaves it on", () => {
    const s = georgScene();
    s.v2.disabled = true;
    const r = set(s, idsOn(s, "V1", "V2"), true);
    expect(r).toMatchObject({ ok: true, changed: 1 });
    expect([s.v1.disabled, s.v2.disabled]).toEqual([false, false]);
    expect(undoTool(s, asStored(r.undo))).toEqual({ ok: true });
    expect([s.v1.disabled, s.v2.disabled]).toEqual([false, true]);
  });

  it.each([
    ["enabled missing", {}, /enabled must be true or false/],
    ["enabled not a boolean", { enabled: "no" }, /enabled must be true or false/],
  ])("refuses %s, changing nothing", (_, extra, msg) => {
    const s = georgScene(), before = exact(s.seq);
    expect(() => act(s, "gcutToolSetClipEnabled", { clipIds: idsOn(s, "V1"), ...extra })).toThrow(msg);
    expect(exact(s.seq)).toEqual(before);
  });

  it("refuses a locked track, a stale id and a different sequence, changing nothing", () => {
    const s = georgScene(), before = exact(s.seq), ids = idsOn(s, "V1", "V3");
    s.seq.videoTracks[2].locked = true;
    expect(() => set(s, ids, false)).toThrow("V3 is locked. Unlock it to switch clips off or on.");
    s.seq.videoTracks[2].locked = false;
    expect(() => act(s, "gcutToolSetClipEnabled", { sequenceId: "seq-2", clipIds: ids, enabled: false })).toThrow(/different sequence/);
    s.v3.start = Time.s(100.32);
    expect(() => set(s, ids, false)).toThrow(STALE);
    s.v3.start = Time.s(100.28);
    expect(exact(s.seq)).toEqual(before);
  });

  describe("undo", () => {
    function off() {
      const s = georgScene(), original = exact(s.seq);
      const record = asStored(set(s, idsOn(s, "V2", "V3"), false).undo);
      return { s, original, record };
    }
    it("refuses, changing nothing, when one was switched back on by hand and the other not", () => {
      const { s, record } = off();
      s.v2.disabled = false;
      const now = exact(s.seq);
      expect(() => undoTool(s, record)).toThrow(/changed by hand.*V2.*Nothing was undone/);
      expect(exact(s.seq)).toEqual(now);
    });
    it("refuses, changing nothing, when a clip was moved or trimmed since", () => {
      const { s, record } = off();
      s.v3.setEnd(Math.round(109 * TICKS));
      const now = exact(s.seq);
      expect(() => undoTool(s, record)).toThrow(/changed by hand.*V3.*moved, trimmed or removed/);
      expect(exact(s.seq)).toEqual(now);
    });
    it("when every one is back on (switched on by hand, or Premiere's Undo), says it is already undone", () => {
      const { s, record, original } = off();
      s.v2.disabled = false; s.v3.disabled = false;
      expect(undoTool(s, record)).toEqual({ ok: true, alreadyUndone: true });
      expect(exact(s.seq)).toEqual(original);
    });
    it("a second undo says already undone", () => {
      const { s, record } = off();
      expect(undoTool(s, record)).toEqual({ ok: true });
      expect(undoTool(s, record)).toEqual({ ok: true, alreadyUndone: true });
    });
    it("refuses a record with no clips as incomplete", () => {
      const { s } = off();
      expect(() => undoTool(s, { kind: "enabled", sequenceId: "seq-1", items: [] })).toThrow("This undo record is incomplete.");
    });
    it.each([
      ["untouched", (_: any) => {}],
      ["one switched back", ({ s }: any) => { s.v2.disabled = false; }],
      ["all switched back", ({ s }: any) => { s.v2.disabled = false; s.v3.disabled = false; }],
      ["one trimmed", ({ s }: any) => { s.v3.setEnd(Math.round(109 * TICKS)); }],
    ])("check: true matches the real undo (%s)", (name, change) => {
      const c = off();
      change(c);
      checkMatchesUndo(c.s, c.record, name === "untouched", c.original);
    });
  });
});

/** One camera with gaps between its pieces: V1 100-105, 108-112 and 115-118 (no sound of its own), a title on V2 at
 *  109-110, a lower third on V2 at 90-95 (before everything), the mic on A1 108-112 (in sync with the middle piece). */
function gapScene() {
  const seq = new Seq(2, 2);
  const cam = new ProjectItem("Camera.mov", "node-c", 900, "seconds", false), mic = wav("mic.wav", "node-m", 900);
  const p1 = seq.videoTracks[0].add(cam, 100, 10, 15);
  const p2 = seq.videoTracks[0].add(cam, 108, 30, 34);
  const p3 = seq.videoTracks[0].add(cam, 115, 50, 53);
  const title = seq.videoTracks[1].add(new ProjectItem("Title", "node-t", 30, "seconds", false), 109, 0, 1);
  const lower = seq.videoTracks[1].add(new ProjectItem("Lower third", "node-l", 30, "seconds", false), 90, 0, 5);
  const a1 = seq.audioTracks[0].add(mic, 108, 30, 34);
  return { seq, cam, mic, p1, p2, p3, title, lower, a1, host: load(seq) };
}

/** The clip on this track starting at startS now (a move lays a fresh TrackItem, so a scene's own references go stale). */
const clipAt = (t: Track, startS: number): TrackItem => {
  const it = (t.clips as TrackItem[]).find((i) => Math.abs(i.start.seconds - startS) < 1e-6);
  if (!it) throw new Error(`no clip at ${startS} s on ${t.kind} ${t.index + 1}`);
  return it;
};

describe("gcutToolCloseGaps: close the gaps between chosen clips by moving everything after each gap, and its undo", () => {
  const close = (s: any, clipIds: string[], extra: object = {}) => act(s, "gcutToolCloseGaps", { clipIds, ...extra });

  it("moves every clip after each gap left by the gaps before it, on every track (laid again from its source, never TrackItem.move), and returns idMap for every moved clip", () => {
    const s = gapScene();
    const r = close(s, idsOn(s, "V1"));
    expect(r).toMatchObject({ ok: true, gapCount: 2, movedCount: 4 });
    expect(r.closedS).toBeCloseTo(6, 9);
    expect(layout(s.seq.videoTracks[0])).toEqual([[100, 105], [105, 109], [109, 112]]);
    expect(layout(s.seq.videoTracks[1])).toEqual([[90, 95], [106, 107]]);
    expect(layout(s.seq.audioTracks[0])).toEqual([[105, 109]]);
    expect(span(s.seq.videoTracks[0]).map((x: number[]) => x[2])).toEqual([10, 30, 50]); // each from its own in point
    expect(span(s.seq.audioTracks[0])[0][2]).toBe(30);
    expect(r.idMap).toEqual({
      [idOf("V1", 108, "node-c")]: [idOf("V1", 105, "node-c")],
      [idOf("V1", 115, "node-c")]: [idOf("V1", 109, "node-c")],
      [idOf("V2", 109, "node-t")]: [idOf("V2", 106, "node-t")],
      [idOf("A1", 108, "node-m")]: [idOf("A1", 105, "node-m")],
    });
    const now = getSeq(s).clips.map((c: any) => c.id);
    for (const ids of Object.values(r.idMap) as string[][]) for (const id of ids) expect(now).toContain(id);
    expect(now).toContain(idOf("V2", 90, "node-l"));
    expect([s.cam.inS, s.cam.outS, s.mic.inS, s.mic.outS]).toEqual([0, 900, 0, 900]); // the bin marks as they were
  });

  it("undo lays every clip back exactly, from the stored record (after a panel reload)", () => {
    const s = gapScene(), original = exact(s.seq);
    const r = close(s, idsOn(s, "V1"));
    expect(asStored(r.undo)).toEqual(r.undo);
    expect(r.undo).toMatchObject({ kind: "moves", sequenceId: "seq-1" });
    expect(undoTool({ host: load(s.seq) }, asStored(r.undo))).toEqual({ ok: true });
    expect(exact(s.seq)).toEqual(original);
  });

  it("a clip that was switched off is laid off again, and comes back off", () => {
    const s = gapScene();
    s.title.disabled = true;
    const original = exact(s.seq);
    const r = close(s, idsOn(s, "V1"));
    expect(clipAt(s.seq.videoTracks[1], 106).disabled).toBe(true);
    expect(undoTool(s, asStored(r.undo))).toEqual({ ok: true });
    expect(exact(s.seq)).toEqual(original);
  });

  it("a camera's own sound moves with it, in sync, and comes back exactly", () => {
    const s = gapScene();
    const talk = new ProjectItem("Talk.mov", "node-k", 900); // picture and sound
    s.seq.audioTracks[0].items = [];
    const v = s.seq.videoTracks[1].add(talk, 120, 40, 44), a = s.seq.audioTracks[1].add(talk, 120, 40, 44);
    v.linked = [a]; a.linked = [v];
    const original = exact(s.seq);
    const r = close(s, idsOn(s, "V1"));
    expect(r.movedCount).toBe(5);
    expect(span(s.seq.videoTracks[1]).at(-1)).toEqual([114, 118, 40]);
    expect(span(s.seq.audioTracks[1])).toEqual([[114, 118, 40]]);
    expect(undoTool(s, asStored(r.undo))).toEqual({ ok: true });
    expect(exact(s.seq)).toEqual(original);
  });

  it.each([
    ["a clip sitting in a gap on another track", (s: any) => { s.seq.audioTracks[1].add(wav("music.wav", "node-9", 300), 90, 0, 40); },
      "music.wav on A2 sits in the gap at 1:45.0, so closing it would need that clip cut or moved. Nothing was moved."],
    ["a locked track with a clip to move", (s: any) => { s.seq.audioTracks[0].locked = true; }, "A1 is locked. Unlock it to close the gaps."],
    ["chosen clips with no gap between them", (s: any) => { s.seq.videoTracks[0].items = [s.p1]; s.seq.videoTracks[0].add(s.cam, 105, 0, 3); },
      "There's no gap between the chosen clips, so nothing was moved."],
    ["a clip to move that isn't at 100% speed", (s: any) => { s.title.speed = 2; },
      "V2's clip (Title) isn't at 100% speed, so laying it again would change it. Nothing was moved."],
    ["a clip to move with effects (laying it again would remove them)", (s: any) => { s.title.addEffect("Gaussian Blur"); },
      "Moving lays the clips again from their source, so these effects would be removed: V2 (Title): Gaussian Blur. Nothing was moved. " +
      "Ask the user; only if they agree, call close_gaps again with acceptEffectLoss: true."],
  ])("refuses %s, changing nothing", (_, change, msg) => {
    const s = gapScene();
    change(s);
    const before = exact(s.seq);
    expect(() => close(s, idsOn(s, "V1"))).toThrow(msg);
    expect(exact(s.seq)).toEqual(before);
  });

  it("acceptEffectLoss: true moves a clip with effects (laid again from its source, without them)", () => {
    const s = gapScene();
    s.title.addEffect("Gaussian Blur");
    expect(close(s, idsOn(s, "V1"), { acceptEffectLoss: true })).toMatchObject({ ok: true, movedCount: 4 });
    expect(clipAt(s.seq.videoTracks[1], 106).components.map((c: any) => c.displayName)).toEqual(["Opacity", "Motion"]);
  });

  it("a clip that doesn't land as expected puts every clip back, and says so", () => {
    const s = gapScene(), original = exact(s.seq);
    s.seq.dropSpanIndex = 2; // Premiere silently doesn't lay the third clip
    expect(() => close(s, idsOn(s, "V1"))).toThrow(/^A clip on .* didn't land where expected, so every clip was put back\. Nothing was changed\.$/);
    expect(exact(s.seq)).toEqual(original);
  });

  describe("undo", () => {
    function closed() {
      const s = gapScene(), original = exact(s.seq);
      const record = asStored(close(s, idsOn(s, "V1")).undo);
      return { s, original, record };
    }
    const title = (s: ReturnType<typeof gapScene>) => clipAt(s.seq.videoTracks[1], 106);
    const allBack = (s: ReturnType<typeof gapScene>) => {
      for (const [t, at, by] of [[s.seq.videoTracks[0], 109, 6], [s.seq.videoTracks[0], 105, 3], [s.seq.videoTracks[1], 106, 3], [s.seq.audioTracks[0], 105, 3]] as [Track, number, number][]) {
        clipAt(t, at).drag(Time.s(by));
      }
    };
    it("refuses, changing nothing, when a moved clip was moved again by hand", () => {
      const { s, record } = closed();
      title(s).drag(Time.s(0.4));
      const now = exact(s.seq);
      expect(() => undoTool(s, record)).toThrow("Some of the moved clips were moved, trimmed or removed by hand since (3 of 4 are where the move left them). Nothing was undone; use Premiere's Undo instead.");
      expect(exact(s.seq)).toEqual(now);
    });
    it("refuses, changing nothing, when a moved clip was slip-edited since", () => {
      const { s, record } = closed();
      const p = clipAt(s.seq.videoTracks[0], 105);
      p.trueIn = Time.s(p.trueIn.seconds + 0.4);
      const now = exact(s.seq);
      expect(() => undoTool(s, record)).toThrow("V1's moved clip was slip-edited since (its source in point changed). Nothing was undone; use Premiere's Undo instead.");
      expect(exact(s.seq)).toEqual(now);
    });
    it("refuses, changing nothing, when something was placed where a clip would move back to", () => {
      const { s, record } = closed();
      s.seq.videoTracks[1].add(new ProjectItem("Logo", "node-o", 30, "seconds", false), 109, 0, 0.5);
      const now = exact(s.seq);
      expect(() => undoTool(s, record)).toThrow("Moving the clips back would land Title on Logo on V2. Nothing was undone; use Premiere's Undo instead.");
      expect(exact(s.seq)).toEqual(now);
    });
    it("refuses, changing nothing, when a track with a clip to move back is locked", () => {
      const { s, record } = closed();
      s.seq.audioTracks[0].locked = true;
      expect(() => undoTool(s, record)).toThrow("A1 is locked. Unlock it to undo.");
    });
    it("refuses, changing nothing, when a source is no longer in the project", () => {
      const { s, record } = closed();
      s.seq.bin = s.seq.bin.filter((pi) => pi !== s.mic);
      expect(() => undoTool(s, record)).toThrow(/A1's source isn't in the project any more, so the move can't be undone/);
    });
    it("refuses a record from before moves were laid again (it keeps too little), changing nothing", () => {
      const { s, record } = closed();
      const old = { ...record, moves: record.moves.map(({ kind, trackIndex, label, name, node, fromT, toT, durT }: any) => ({ kind, trackIndex, label, name, node, fromT, toT, durT })) };
      expect(() => undoTool(s, old)).toThrow("This move was made by an earlier Genius Cut, which kept too little to lay it back. Nothing was undone; use Premiere's Undo instead.");
    });
    it("when laying back fails, every clip is put back where the move left it, and it says so", () => {
      const { s, record } = closed();
      const now = exact(s.seq);
      s.seq.dropSpanIndex = (s.seq as any).placements + 1;
      expect(() => undoTool(s, record)).toThrow(/didn't land where expected, so every clip was put back\. Nothing was undone\.$/);
      expect(exact(s.seq)).toEqual(now);
    });
    it("when every clip is back where it was (Premiere's Undo), says it is already undone", () => {
      const { s, record, original } = closed();
      allBack(s);
      expect(exact(s.seq)).toEqual(original);
      expect(undoTool(s, record)).toEqual({ ok: true, alreadyUndone: true });
      expect(exact(s.seq)).toEqual(original);
    });
    it.each([
      ["untouched", (_: any) => {}],
      ["one moved again", ({ s }: any) => { title(s).drag(Time.s(0.4)); }],
      ["something in the way", ({ s }: any) => { s.seq.videoTracks[1].add(new ProjectItem("Logo", "node-o", 30, "seconds", false), 109, 0, 0.5); }],
      ["all back", ({ s }: any) => { allBack(s); }],
    ])("check: true matches the real undo (%s)", (name, change) => {
      const c = closed();
      change(c);
      checkMatchesUndo(c.s, c.record, name === "untouched", c.original);
    });
  });
});

describe("gcutToolSplitAt: split chosen clips at one moment with the QE razor, and its undo", () => {
  const split = (s: any, clipIds: string[], atS: unknown) => act(s, "gcutToolSplitAt", { clipIds, atS });

  it("razors each chosen clip's own track at the frame (HH:MM:SS:FF), leaving other tracks whole; idMap gives both pieces", () => {
    const s = georgScene();
    const r = split(s, idsOn(s, "V1", "A1"), 104.01); // rounds to the frame at 104 s
    expect(r).toMatchObject({ ok: true, splitCount: 2 });
    expect(s.host.qe.razors).toEqual([["V1", "00:01:44:00"], ["A1", "00:01:44:00"]]);
    expect(span(s.seq.videoTracks[0])).toEqual([[100, 104, 10], [104, 110, 14]]);
    expect(span(s.seq.audioTracks[0])).toEqual([[99, 104, 50], [104, 111, 55]]);
    expect(span(s.seq.videoTracks[1])).toEqual([[100.24, 109.84, 30]]);
    expect(r.idMap).toEqual({
      [idOf("V1", 100, "node-a")]: [idOf("V1", 100, "node-a"), idOf("V1", 104, "node-a")],
      [idOf("A1", 99, "node-m")]: [idOf("A1", 99, "node-m"), idOf("A1", 104, "node-m")],
    });
  });

  it("both pieces keep the clip's state (off stays off); undo joins them back exactly, from the stored record", () => {
    const s = georgScene();
    s.v1.disabled = true;
    const original = exact(s.seq);
    const r = split(s, idsOn(s, "V1", "A1"), 104);
    expect(s.seq.videoTracks[0].clips.map((i: TrackItem) => i.disabled)).toEqual([true, true]);
    expect(asStored(r.undo)).toEqual(r.undo);
    expect(r.undo).toMatchObject({ kind: "split", sequenceId: "seq-1" });
    expect(undoTool({ host: load(s.seq) }, asStored(r.undo))).toEqual({ ok: true });
    expect(exact(s.seq)).toEqual(original);
  });

  it.each([
    ["a time outside a chosen clip", 99.5, "V1's clip (100–110 s) doesn't run across 99.5 s, so it can't be split there. Nothing was changed."],
    ["a clip's very start", 100, "V1's clip (100–110 s) doesn't run across 100 s, so it can't be split there. Nothing was changed."],
    ["no time", undefined, "atS must be a time in seconds on the sequence."],
  ])("refuses %s, changing nothing", (_, atS, msg) => {
    const s = georgScene(), before = exact(s.seq);
    expect(() => split(s, idsOn(s, "V1", "A1"), atS)).toThrow(msg);
    expect(exact(s.seq)).toEqual(before);
    expect(s.host.qe.razors).toEqual([]);
  });

  it("refuses a locked track, changing nothing", () => {
    const s = georgScene(), before = exact(s.seq);
    s.seq.audioTracks[0].locked = true;
    expect(() => split(s, idsOn(s, "V1", "A1"), 104)).toThrow("A1 is locked. Unlock it to split.");
    expect(exact(s.seq)).toEqual(before);
  });

  it("when Premiere doesn't split a clip, joins back what it split and fails", () => {
    const s = georgScene(), original = exact(s.seq);
    const qe = s.host.qe as any, real = qe.razor.bind(qe);
    qe.razor = (t: Track, tc: string) => (t.kind === "audio" ? true : real(t, tc));
    expect(() => split(s, idsOn(s, "V1", "A1"), 104)).toThrow("Premiere didn't split A1's clip at 1:44.0. Nothing was changed.");
    expect(exact(s.seq)).toEqual(original);
  });

  it("refuses without QE, changing nothing", () => {
    const s = georgScene(), host = load(s.seq, { qe: false }), before = exact(s.seq);
    expect(() => host.call("gcutToolSplitAt", { sequenceId: "seq-1", clipIds: idsOn(s, "V1"), atS: 104 })).toThrow(/QE/);
    expect(exact(s.seq)).toEqual(before);
  });

  describe("undo", () => {
    function cut() {
      const s = georgScene(), original = exact(s.seq);
      const record = asStored(split(s, idsOn(s, "V1", "A1"), 104).undo);
      return { s, original, record };
    }
    it("refuses, changing nothing, when a piece was trimmed since", () => {
      const { s, record } = cut();
      s.seq.videoTracks[0].clips[1].setEnd(Math.round(109 * TICKS));
      const now = exact(s.seq);
      expect(() => undoTool(s, record)).toThrow("V1's pieces were moved, trimmed, removed or slip-edited since. Nothing was undone; use Premiere's Undo instead.");
      expect(exact(s.seq)).toEqual(now);
    });
    it("refuses, changing nothing, when a piece was slip-edited since", () => {
      const { s, record } = cut();
      const p = s.seq.audioTracks[0].clips[1];
      p.trueIn = Time.s(p.trueIn.seconds + 0.4);
      const now = exact(s.seq);
      expect(() => undoTool(s, record)).toThrow(/A1's pieces were .*slip-edited since/);
      expect(exact(s.seq)).toEqual(now);
    });
    it("a second undo says already undone", () => {
      const { s, record, original } = cut();
      expect(undoTool(s, record)).toEqual({ ok: true });
      expect(undoTool(s, record)).toEqual({ ok: true, alreadyUndone: true });
      expect(exact(s.seq)).toEqual(original);
    });
    it.each([
      ["untouched", (_: any) => {}],
      ["a piece trimmed", ({ s }: any) => { s.seq.videoTracks[0].clips[1].setEnd(Math.round(109 * TICKS)); }],
      ["already joined", ({ s, record }: any) => { undoTool(s, record); }],
    ])("check: true matches the real undo (%s)", (name, change) => {
      const c = cut();
      change(c);
      checkMatchesUndo(c.s, c.record, name === "untouched", c.original);
    });
  });
});

describe("gcutToolDeleteClips: remove chosen clips (no ripple), and its undo", () => {
  const del = (s: any, clipIds: string[]) => act(s, "gcutToolDeleteClips", { clipIds });

  it("removes exactly the chosen clips with remove(false, false): nothing slides, linked partners stay", () => {
    const s = multiScene();
    const r = del(s, idsOn(s, "V1"));
    expect(r).toMatchObject({ ok: true, deleted: [idOf("V1", 100, "node-w")], idMap: {} });
    expect(span(s.seq.videoTracks[0])).toEqual([]);
    expect(span(s.seq.audioTracks[0])).toEqual([[100, 110, 10]]);
    expect(layout(s.seq.videoTracks[3])).toEqual([[104, 106]]);
  });

  it("undo lays every deleted clip back exactly where it was, from its source and the stored record, on/off as it was", () => {
    const s = multiScene({ music: false }); // the music bed on A3 would sit where V3's sound lands
    s.v3.disabled = true;
    const original = exact(s.seq);
    const r = del(s, idsOn(s, "V2", "V3"));
    expect(r.warning).toBeUndefined();
    expect(span(s.seq.videoTracks[1])).toEqual([]);
    expect(asStored(r.undo)).toEqual(r.undo);
    expect(r.undo).toMatchObject({ kind: "delete", sequenceId: "seq-1" });
    expect(undoTool({ host: load(s.seq) }, asStored(r.undo))).toEqual({ ok: true });
    expect(exact(s.seq)).toEqual(original);
  });

  it("a linked pair given together goes together, and comes back together", () => {
    const s = multiScene(), original = exact(s.seq);
    const r = del(s, idsOn(s, "V1", "A1"));
    expect(span(s.seq.videoTracks[0])).toEqual([]);
    expect(span(s.seq.audioTracks[0])).toEqual([]);
    expect(undoTool(s, asStored(r.undo))).toEqual({ ok: true });
    expect(exact(s.seq)).toEqual(original);
  });

  it("warns when the undo can't lay a clip back (its sound would land on a clip that stays), and that undo refuses, changing nothing", () => {
    const s = multiScene();
    const r = del(s, idsOn(s, "V1"));
    expect(r.warning).toBe("Undoing this delete will need Premiere's Undo: laying V1's clip back from its source would also lay its sound on A1, over wide.mov there.");
    const now = exact(s.seq);
    expect(() => undoTool(s, asStored(r.undo))).toThrow("Laying V1's clip back would also lay its sound on A1, over wide.mov there. Nothing was undone; use Premiere's Undo instead.");
    expect(exact(s.seq)).toEqual(now);
  });

  it("warns that a clip's effects won't come back with an undo", () => {
    const s = multiScene();
    s.v2.addEffect("Lumetri Color");
    const r = del(s, idsOn(s, "V2"));
    expect(r.warning).toBe("An undo lays deleted clips back from their source, so these effects wouldn't come back: V2 (close.mov): Lumetri Color.");
  });

  it.each([
    ["a locked track", (s: any) => { s.seq.videoTracks[1].locked = true; }, "V2 is locked. Unlock it to delete."],
    ["a clip not at 100% speed", (s: any) => { s.v2.speed = 2; }, "V2 isn't at 100% speed, so deleting it couldn't be undone exactly. Delete it by hand."],
  ])("refuses %s, changing nothing", (_, change, msg) => {
    const s = multiScene(), ids = idsOn(s, "V2");
    change(s);
    const before = exact(s.seq);
    expect(() => del(s, ids)).toThrow(msg);
    expect(exact(s.seq)).toEqual(before);
  });

  describe("undo", () => {
    function deleted() {
      const s = multiScene({ music: false }), original = exact(s.seq);
      const saved = [...s.seq.videoTracks, ...s.seq.audioTracks].map((t: Track) => [...t.items]);
      const record = asStored(del(s, idsOn(s, "V2", "V3")).undo);
      return { s, original, saved, record };
    }
    it("refuses, changing nothing, when something was placed where a deleted clip was", () => {
      const { s, record } = deleted();
      s.seq.videoTracks[2].add(new ProjectItem("Logo", "node-o", 30, "seconds", false), 105, 0, 1);
      const now = exact(s.seq);
      expect(() => undoTool(s, record)).toThrow("Something was placed on V3 where a deleted clip was since. Nothing was undone; use Premiere's Undo instead.");
      expect(exact(s.seq)).toEqual(now);
    });
    it("refuses, changing nothing, when only some of the deleted clips are back", () => {
      const { s, record, saved } = deleted();
      s.seq.videoTracks[1].items = saved[1];
      const now = exact(s.seq);
      expect(() => undoTool(s, record)).toThrow("Some of the deleted clips were put back by hand since (1 of 2). Nothing was undone; use Premiere's Undo instead.");
      expect(exact(s.seq)).toEqual(now);
    });
    it("refuses, changing nothing, when a source is no longer in the project", () => {
      const { s, record } = deleted();
      s.seq.bin = s.seq.bin.filter((pi) => pi !== s.close);
      expect(() => undoTool(s, record)).toThrow(/V2's source isn't in the project/);
    });
    it("when every one is back (Premiere's Undo), says it is already undone", () => {
      const { s, record, saved, original } = deleted();
      [...s.seq.videoTracks, ...s.seq.audioTracks].forEach((t: Track, k: number) => { t.items = saved[k]; });
      expect(undoTool(s, record)).toEqual({ ok: true, alreadyUndone: true });
      expect(exact(s.seq)).toEqual(original);
    });
    it("when a clip doesn't land as expected, takes off what it laid and fails, changing nothing", () => {
      const { s, record } = deleted();
      const now = exact(s.seq);
      s.seq.dropSpanIndex = (s.seq as any).placements;
      expect(() => undoTool(s, record)).toThrow("The deleted clips didn't go back as expected, so they were taken off again. Nothing was undone; try again, or use Premiere's Undo.");
      expect(exact(s.seq)).toEqual(now);
    });
    it.each([
      ["untouched", (_: any) => {}],
      ["something in the way", ({ s }: any) => { s.seq.videoTracks[2].add(new ProjectItem("Logo", "node-o", 30, "seconds", false), 105, 0, 1); }],
      ["one back", ({ s, saved }: any) => { s.seq.videoTracks[1].items = saved[1]; }],
      ["all back", ({ s, saved }: any) => { [...s.seq.videoTracks, ...s.seq.audioTracks].forEach((t: Track, k: number) => { t.items = saved[k]; }); }],
    ])("check: true matches the real undo (%s)", (name, change) => {
      const c = deleted();
      change(c);
      checkMatchesUndo(c.s, c.record, name === "untouched", c.original);
    });
  });
});

describe("gcutToolMoveClips: move chosen clips along their tracks, and its undo", () => {
  const move = (s: any, clipIds: string[], byS: unknown, extra: object = {}) => act(s, "gcutToolMoveClips", { clipIds, byS, ...extra });

  it("moves a chosen clip by byS (to the frame), laid again from its own source (never TrackItem.move); a linked partner that isn't chosen stays", () => {
    const s = scene(), original = exact(s.seq);
    const r = move(s, idsOn(s, "V1"), 30.01); // clear of its own sound, which Premiere drops on A1 with it
    expect(r).toMatchObject({ ok: true, movedCount: 1 });
    expect(span(s.seq.videoTracks[0])).toEqual([[130, 140, 10]]);
    expect(span(s.seq.audioTracks[0])).toEqual([[100, 110, 10]]); // the partner stays; the dropped sound is taken off
    expect([s.pi.inS, s.pi.outS]).toEqual([2, 58]); // the bin marks as they were
    expect(r.idMap).toEqual({ [idOf("V1", 100, "node-1")]: [idOf("V1", 130, "node-1")] });
    expect(undoTool(s, asStored(r.undo))).toEqual({ ok: true });
    expect(exact(s.seq)).toEqual(original);
  });

  it("a linked pair given together moves together; undo lays both back exactly, from the stored record", () => {
    const s = scene(), original = exact(s.seq);
    const r = move(s, idsOn(s, "V1", "A1"), -3);
    expect(span(s.seq.videoTracks[0])).toEqual([[97, 107, 10]]);
    expect(span(s.seq.audioTracks[0])).toEqual([[97, 107, 10]]);
    expect(Object.keys(r.idMap)).toHaveLength(2);
    expect(asStored(r.undo)).toEqual(r.undo);
    expect(r.undo).toMatchObject({ kind: "moves", sequenceId: "seq-1" });
    expect(undoTool({ host: load(s.seq) }, asStored(r.undo))).toEqual({ ok: true });
    expect(exact(s.seq)).toEqual(original);
  });

  it.each([
    ["landing on another clip", (s: any) => { s.seq.videoTracks[0].add(new ProjectItem("Logo", "node-o", 30, "seconds", false), 111, 0, 1); }, 2,
      "Moving the clips by 2 s would land interview_take3.mp4 on Logo on V1. Nothing was moved."],
    ["a move before the sequence's start", (_: any) => {}, -101, "Moving V1's clip by -101 s would put it before the sequence's start. Nothing was moved."],
    ["a move of less than a frame", (_: any) => {}, 0.01, "byS rounds to less than a frame, so nothing would move."],
    ["no byS", (_: any) => {}, undefined, "byS must be a time in seconds (negative moves left)."],
    ["a locked track", (s: any) => { s.seq.videoTracks[0].locked = true; }, 2, "V1 is locked. Unlock it to move clips."],
    ["its own sound landing on its partner that stays (choose both to move both)", (_: any) => {}, 2,
      "Laying V1's clip again at its new place also drops its own sound onto A1, over interview_take3.mp4 there. " +
      "Choose that clip too, so both move, or move the clip clear of it. Nothing was moved."],
    ["a clip not at 100% speed", (s: any) => { s.v.speed = 2; }, 30,
      "V1's clip (interview_take3.mp4) isn't at 100% speed, so laying it again would change it. Nothing was moved."],
    ["a clip with effects (laying it again would remove them)", (s: any) => { s.v.addEffect("Lumetri Color"); }, 30,
      "Moving lays the clips again from their source, so these effects would be removed: V1 (interview_take3.mp4): Lumetri Color. Nothing was moved. " +
      "Ask the user; only if they agree, call move_clips again with acceptEffectLoss: true."],
  ])("refuses %s, changing nothing", (_, change, byS, msg) => {
    const s = scene(), ids = idsOn(s, "V1");
    change(s);
    const before = exact(s.seq);
    expect(() => move(s, ids, byS)).toThrow(msg);
    expect(exact(s.seq)).toEqual(before);
  });

  it("refuses audio from a video file whose picture would land on a clip that stays, changing nothing", () => {
    const s = scene(), before = exact(s.seq);
    expect(() => move(s, idsOn(s, "A1"), 2)).toThrow(
      "Laying A1's clip again at its new place also drops its picture onto V1, over interview_take3.mp4 there. Choose that clip too, so both move, or move the clip clear of it. Nothing was moved.");
    expect(exact(s.seq)).toEqual(before);
  });

  it("acceptEffectLoss: true moves a clip with effects (laid again without them)", () => {
    const s = scene();
    s.v.addEffect("Lumetri Color");
    expect(move(s, idsOn(s, "V1", "A1"), 2, { acceptEffectLoss: true })).toMatchObject({ ok: true, movedCount: 2 });
    expect(clipAt(s.seq.videoTracks[0], 102).components.map((c: any) => c.displayName)).toEqual(["Opacity", "Motion"]);
  });

  it("a clip that was switched off is laid off again, and comes back off", () => {
    const s = scene();
    s.v.disabled = true;
    const original = exact(s.seq);
    const r = move(s, idsOn(s, "V1", "A1"), 2);
    expect(clipAt(s.seq.videoTracks[0], 102).disabled).toBe(true);
    expect(undoTool(s, asStored(r.undo))).toEqual({ ok: true });
    expect(exact(s.seq)).toEqual(original);
  });

  it("a clip that doesn't land as expected puts every clip back, and says so", () => {
    const s = scene(), original = exact(s.seq);
    s.seq.lateSpanIndex = 0; s.seq.lateInS = 0.4; // Premiere lays the clip from the wrong source time
    expect(() => move(s, idsOn(s, "V1", "A1"), 2)).toThrow(/didn't land where expected, so every clip was put back\. Nothing was changed\.$/);
    expect(exact(s.seq)).toEqual(original);
  });

  it("chosen clips may move into each other's old places on the same track", () => {
    const s = gapScene(), original = exact(s.seq);
    const r = move(s, idsOn(s, "V1", "A1"), -3);
    expect(layout(s.seq.videoTracks[0])).toEqual([[97, 102], [105, 109], [112, 115]]);
    expect(layout(s.seq.audioTracks[0])).toEqual([[105, 109]]);
    expect(undoTool(s, asStored(r.undo))).toEqual({ ok: true });
    expect(exact(s.seq)).toEqual(original);
  });

  describe("undo", () => {
    function moved() {
      const s = scene(), original = exact(s.seq);
      const record = asStored(move(s, idsOn(s, "V1", "A1"), 2).undo);
      return { s, original, record };
    }
    const v = (s: ReturnType<typeof scene>) => clipAt(s.seq.videoTracks[0], 102), a = (s: ReturnType<typeof scene>) => clipAt(s.seq.audioTracks[0], 102);
    it("refuses, changing nothing, when a moved clip was moved again by hand", () => {
      const { s, record } = moved();
      v(s).drag(Time.s(1));
      const now = exact(s.seq);
      expect(() => undoTool(s, record)).toThrow("Some of the moved clips were moved, trimmed or removed by hand since (1 of 2 are where the move left them). Nothing was undone; use Premiere's Undo instead.");
      expect(exact(s.seq)).toEqual(now);
    });
    it("refuses, changing nothing, when something was placed where a clip would move back to", () => {
      const { s, record } = moved();
      s.seq.audioTracks[0].add(wav("sfx.wav", "node-x", 30), 100, 0, 1);
      const now = exact(s.seq);
      expect(() => undoTool(s, record)).toThrow("Moving the clips back would land interview_take3.mp4 on sfx.wav on A1. Nothing was undone; use Premiere's Undo instead.");
      expect(exact(s.seq)).toEqual(now);
    });
    it("when both are back (Premiere's Undo), says it is already undone", () => {
      const { s, record, original } = moved();
      const [x, y] = [v(s), a(s)];
      x.drag(Time.s(-2)); y.drag(Time.s(-2));
      expect(undoTool(s, record)).toEqual({ ok: true, alreadyUndone: true });
      expect(exact(s.seq)).toEqual(original);
    });
    it.each([
      ["untouched", (_: any) => {}],
      ["one moved again", ({ s }: any) => { v(s).drag(Time.s(1)); }],
      ["something in the way", ({ s }: any) => { s.seq.audioTracks[0].add(wav("sfx.wav", "node-x", 30), 100, 0, 1); }],
      ["both back", ({ s }: any) => { const [x, y] = [v(s), a(s)]; x.drag(Time.s(-2)); y.drag(Time.s(-2)); }],
    ])("check: true matches the real undo (%s)", (name, change) => {
      const c = moved();
      change(c);
      checkMatchesUndo(c.s, c.record, name === "untouched", c.original);
    });
  });
});

describe("gcutToolSwitchAngle: show one angle for a stretch by switching the others' pieces off, and its undo", () => {
  const sw = (s: any, clipIds: string[], fromS: unknown, toS: unknown, showTrack: unknown) =>
    act(s, "gcutToolSwitchAngle", { clipIds, fromS, toS, showTrack });
  const offs = (t: Track) => t.clips.map((i: TrackItem) => i.disabled);
  const angles = () => multiScene({ music: false });

  it("splits each chosen angle at fromS and toS (razor, per track) and switches every piece in the stretch off but showTrack's", () => {
    const s = angles();
    const r = sw(s, idsOn(s, "V1", "V2", "V3"), 103, 106, 2);
    expect(r).toMatchObject({ ok: true, shown: "V2", hidden: ["V1", "V3"], splitCount: 6 });
    for (const t of [0, 1, 2]) expect(layout(s.seq.videoTracks[t])).toEqual([[100, 103], [103, 106], [106, 110]]);
    expect(offs(s.seq.videoTracks[0])).toEqual([false, true, false]);
    expect(offs(s.seq.videoTracks[1])).toEqual([false, false, false]);
    expect(offs(s.seq.videoTracks[2])).toEqual([false, true, false]);
    expect(layout(s.seq.audioTracks[0])).toEqual([[100, 110]]); // the wide camera's own sound isn't split
    expect(span(s.seq.videoTracks[1]).map((p: number[]) => p[2])).toEqual([12, 15, 18]);
    expect(r.idMap).toEqual({
      [idOf("V1", 100, "node-w")]: [idOf("V1", 100, "node-w"), idOf("V1", 103, "node-w"), idOf("V1", 106, "node-w")],
      [idOf("V2", 100, "node-c")]: [idOf("V2", 100, "node-c"), idOf("V2", 103, "node-c"), idOf("V2", 106, "node-c")],
      [idOf("V3", 100, "node-s")]: [idOf("V3", 100, "node-s"), idOf("V3", 103, "node-s"), idOf("V3", 106, "node-s")],
    });
  });

  it("undo puts every angle back whole, on as it was, from the stored record", () => {
    const s = angles(), original = exact(s.seq);
    const r = sw(s, idsOn(s, "V1", "V2", "V3"), 103, 106, 2);
    expect(asStored(r.undo)).toEqual(r.undo);
    expect(r.undo).toMatchObject({ kind: "angle", sequenceId: "seq-1" });
    expect(undoTool({ host: load(s.seq) }, asStored(r.undo))).toEqual({ ok: true });
    expect(exact(s.seq)).toEqual(original);
  });

  it("a stretch reaching a clip's edge splits only where it must; an angle that was off is switched on, and undo switches it off again", () => {
    const s = angles();
    s.v3.disabled = true;
    const original = exact(s.seq);
    const r = sw(s, idsOn(s, "V1", "V3"), 100, 104, 3);
    expect(r).toMatchObject({ ok: true, shown: "V3", hidden: ["V1"], splitCount: 2 });
    expect(layout(s.seq.videoTracks[0])).toEqual([[100, 104], [104, 110]]);
    expect(offs(s.seq.videoTracks[0])).toEqual([true, false]);
    expect(offs(s.seq.videoTracks[2])).toEqual([false, true]);
    expect(layout(s.seq.videoTracks[1])).toEqual([[100, 110]]);
    expect(r.idMap[idOf("V2", 100, "node-c")]).toBeUndefined();
    expect(undoTool(s, asStored(r.undo))).toEqual({ ok: true });
    expect(exact(s.seq)).toEqual(original);
  });

  it("a chosen clip outside the stretch is left as it is", () => {
    const s = angles();
    const later = s.seq.videoTracks[0].add(s.wide, 120, 40, 45);
    const r = sw(s, idsOn(s, "V1", "V2"), 103, 106, 2);
    expect(r).toMatchObject({ ok: true, splitCount: 4 });
    expect(later.disabled).toBe(false);
    expect(layout(s.seq.videoTracks[0]).at(-1)).toEqual([120, 125]);
  });

  it.each([
    ["an audio clip", (s: any) => idsOn(s, "V1", "A1"), 103, 106, 1, "A1's clip is audio: switch_angle works on the chosen video clips. Nothing was changed."],
    ["a show track with no chosen clip over the whole stretch", (s: any) => idsOn(s, "V1", "V2"), 103, 112, 2,
      "None of the chosen clips on V2 covers 103–112 s, so V2 can't be shown there. Nothing was changed."],
    ["a show track that isn't chosen", (s: any) => idsOn(s, "V1", "V2"), 103, 106, 3,
      "None of the chosen clips on V3 covers 103–106 s, so V3 can't be shown there. Nothing was changed."],
    ["a stretch that ends before it starts", (s: any) => idsOn(s, "V1", "V2"), 106, 103, 2, "toS must be after fromS (at least a frame)."],
    ["no times", (s: any) => idsOn(s, "V1", "V2"), undefined, 106, 2, "fromS and toS must be times in seconds on the sequence."],
    ["a show track that isn't a track number", (s: any) => idsOn(s, "V1", "V2"), 103, 106, "V2", "showTrack must be a video track number (1 for V1)."],
  ])("refuses %s, changing nothing", (_, ids, fromS, toS, show, msg) => {
    const s = angles(), before = exact(s.seq);
    expect(() => sw(s, ids(s), fromS, toS, show)).toThrow(msg);
    expect(exact(s.seq)).toEqual(before);
    expect(s.host.qe.razors).toEqual([]);
  });

  it("refuses a locked track, changing nothing", () => {
    const s = angles(), before = exact(s.seq);
    s.seq.videoTracks[2].locked = true;
    expect(() => sw(s, idsOn(s, "V1", "V2", "V3"), 103, 106, 2)).toThrow("V3 is locked. Unlock it to switch angles.");
    expect(exact(s.seq)).toEqual(before);
  });

  it("when Premiere doesn't split a clip, joins back what it split and fails, changing nothing", () => {
    const s = angles(), original = exact(s.seq);
    const qe = s.host.qe as any, real = qe.razor.bind(qe);
    qe.razor = (t: Track, tc: string) => (t.index === 2 ? true : real(t, tc));
    expect(() => sw(s, idsOn(s, "V1", "V2", "V3"), 103, 106, 2)).toThrow("Premiere didn't split V3's clip at 1:43.0. Nothing was changed.");
    expect(exact(s.seq)).toEqual(original);
  });

  describe("undo", () => {
    function switched() {
      const s = angles(), original = exact(s.seq);
      const record = asStored(sw(s, idsOn(s, "V1", "V2", "V3"), 103, 106, 2).undo);
      return { s, original, record };
    }
    it("refuses, changing nothing, when a switched-off piece was switched on by hand", () => {
      const { s, record } = switched();
      s.seq.videoTracks[2].clips[1].disabled = false;
      const now = exact(s.seq);
      expect(() => undoTool(s, record)).toThrow("V3's piece was switched on by hand since. Nothing was undone; use Premiere's Undo instead.");
      expect(exact(s.seq)).toEqual(now);
    });
    it("refuses, changing nothing, when a piece was trimmed since", () => {
      const { s, record } = switched();
      s.seq.videoTracks[1].clips[2].setEnd(Math.round(109 * TICKS));
      const now = exact(s.seq);
      expect(() => undoTool(s, record)).toThrow("V2's pieces were moved, trimmed, removed or slip-edited since. Nothing was undone; use Premiere's Undo instead.");
      expect(exact(s.seq)).toEqual(now);
    });
    it("a second undo says already undone", () => {
      const { s, record, original } = switched();
      expect(undoTool(s, record)).toEqual({ ok: true });
      expect(undoTool(s, record)).toEqual({ ok: true, alreadyUndone: true });
      expect(exact(s.seq)).toEqual(original);
    });
    it.each([
      ["untouched", (_: any) => {}],
      ["a piece switched on", ({ s }: any) => { s.seq.videoTracks[2].clips[1].disabled = false; }],
      ["a piece trimmed", ({ s }: any) => { s.seq.videoTracks[1].clips[2].setEnd(Math.round(109 * TICKS)); }],
      ["already undone", ({ s, record }: any) => { undoTool(s, record); }],
    ])("check: true matches the real undo (%s)", (name, change) => {
      const c = switched();
      change(c);
      checkMatchesUndo(c.s, c.record, name === "untouched", c.original);
    });
  });
});

describe("gcutToolSetVolume: a clip-level volume in dB on chosen audio clips, and its undo", () => {
  const vol = (s: any, clipIds: string[], db: unknown) => act(s, "gcutToolSetVolume", { clipIds, db });
  const levelParam = (it: TrackItem) => it.components.find((c: any) => c.displayName === "Volume").properties[1] as Param;
  const ZERO_DB = 0.17783;

  it("sets the Volume component's Level, linear as measured (v = 10^((dB - 15) / 20)), on each chosen clip only", () => {
    const s = scene();
    s.seq.audioTracks[1].add(wav("music.wav", "node-9", 300), 90, 0, 40);
    const r = vol(s, idsOn(s, "A1", "A2"), -6);
    expect(r).toMatchObject({ ok: true, changed: 2, idMap: {} });
    expect(r.level).toBeCloseTo(Math.pow(10, -21 / 20), 9);
    expect(s.a.level).toBeCloseTo(0.0891251, 6);
    expect(s.seq.audioTracks[1].items[0].level).toBeCloseTo(0.0891251, 6);
    expect(Math.pow(10, (0 - 15) / 20)).toBeCloseTo(ZERO_DB, 5); // the formula meets the measured 0 dB value
  });

  it("undo puts each clip's previous level back exactly, from the stored record", () => {
    const s = scene();
    levelParam(s.a).value = 0.3;
    const r = vol(s, idsOn(s, "A1"), 3);
    expect(r.undo).toMatchObject({ kind: "volume", sequenceId: "seq-1" });
    expect(asStored(r.undo)).toEqual(r.undo);
    expect(undoTool({ host: load(s.seq) }, asStored(r.undo))).toEqual({ ok: true });
    expect(s.a.level).toBe(0.3);
  });

  it.each([
    ["a video clip", (s: any) => idsOn(s, "V1"), -6, "V1's clip is video: set_volume works on audio clips. Nothing was changed."],
    ["more than +15 dB", (s: any) => idsOn(s, "A1"), 16, "db must be a number of decibels, at most +15 (Premiere's clip volume limit)."],
    ["no dB", (s: any) => idsOn(s, "A1"), undefined, "db must be a number of decibels, at most +15 (Premiere's clip volume limit)."],
  ])("refuses %s, changing nothing", (_, ids, db, msg) => {
    const s = scene();
    expect(() => vol(s, ids(s), db)).toThrow(msg);
    expect(s.a.level).toBe(ZERO_DB);
  });

  it("refuses volume keyframes (a single level would replace them) and a locked track, changing nothing", () => {
    const s = scene();
    levelParam(s.a).timeVarying = true;
    expect(() => vol(s, idsOn(s, "A1"), -6)).toThrow("A1's volume has keyframes, so one level would replace them. Nothing was changed; set it by hand.");
    levelParam(s.a).timeVarying = false;
    s.seq.audioTracks[0].locked = true;
    expect(() => vol(s, idsOn(s, "A1"), -6)).toThrow("A1 is locked. Unlock it to change the volume.");
    expect(s.a.level).toBe(ZERO_DB);
  });

  describe("undo", () => {
    function set() {
      const s = scene();
      const record = asStored(vol(s, idsOn(s, "A1"), -6).undo);
      return { s, record };
    }
    it("refuses, changing nothing, when the level was changed by hand since", () => {
      const { s, record } = set();
      levelParam(s.a).value = 0.5;
      expect(() => undoTool(s, record)).toThrow("These clips were changed by hand since: A1's volume was changed. Nothing was undone; use Premiere's Undo instead.");
      expect(s.a.level).toBe(0.5);
    });
    it("refuses when the clip was moved since", () => {
      const { s, record } = set();
      s.a.drag(Time.s(1));
      expect(() => undoTool(s, record)).toThrow(/A1's clip was moved, trimmed or removed/);
    });
    it("when the level is back (Premiere's Undo), says it is already undone", () => {
      const { s, record } = set();
      levelParam(s.a).value = ZERO_DB;
      expect(undoTool(s, record)).toEqual({ ok: true, alreadyUndone: true });
    });
    it.each([
      ["untouched", (_: any) => {}],
      ["changed by hand", ({ s }: any) => { levelParam(s.a).value = 0.5; }],
      ["back", ({ s }: any) => { levelParam(s.a).value = ZERO_DB; }],
    ])("check: true matches the real undo (%s)", (name, change) => {
      const c = set();
      change(c);
      checkMatchesUndo(c.s, c.record, name === "untouched");
      if (name === "untouched") expect(c.s.a.level).toBe(ZERO_DB);
    });
  });
});

describe("gcutToolMuteTrack: mute or unmute a whole track, and its undo", () => {
  const mute = (s: any, kind: unknown, track: unknown, muted: unknown) => act(s, "gcutToolMuteTrack", { kind, track, muted });

  it("mutes an audio track with setMute (measured) and undo unmutes it", () => {
    const s = multiScene();
    const r = mute(s, "audio", 3, true);
    expect(r).toMatchObject({ ok: true, track: "A3", muted: true, changed: true, idMap: {} });
    expect(s.seq.audioTracks[2].muted).toBe(true);
    expect(r.undo).toEqual({ kind: "mute", sequenceId: "seq-1", trackKind: "audio", trackIndex: 2, label: "A3", before: false, after: true });
    expect(undoTool({ host: load(s.seq) }, asStored(r.undo))).toEqual({ ok: true });
    expect(s.seq.audioTracks[2].muted).toBe(false);
  });

  it("unmutes a video track; a track already that way is unchanged and its undo is already undone", () => {
    const s = multiScene();
    s.seq.videoTracks[3].muted = true;
    expect(mute(s, "video", 4, false)).toMatchObject({ ok: true, track: "V4", muted: false, changed: true });
    expect(s.seq.videoTracks[3].muted).toBe(false);
    const r = mute(s, "audio", 1, false);
    expect(r).toMatchObject({ changed: false });
    expect(undoTool(s, r.undo)).toEqual({ ok: true, alreadyUndone: true });
  });

  it.each([
    ["an unknown kind", "music", 1, true, "kind must be \"audio\" or \"video\"."],
    ["a track that doesn't exist", "audio", 4, true, "track must be a track number from 1 to 3 (A1 is 1)."],
    ["a track that isn't a number", "audio", "A1", true, "track must be a track number from 1 to 3 (A1 is 1)."],
    ["muted not a boolean", "audio", 1, "yes", "muted must be true or false."],
  ])("refuses %s, changing nothing", (_, kind, track, muted, msg) => {
    const s = multiScene();
    expect(() => mute(s, kind, track, muted)).toThrow(msg);
    expect(s.seq.audioTracks.map((t: Track) => t.muted)).toEqual([false, false, false]);
  });

  it("refuses when Premiere doesn't take it, leaving the track as it was", () => {
    const s = multiScene();
    s.seq.audioTracks[2].setMute = () => {};
    expect(() => mute(s, "audio", 3, true)).toThrow("Premiere didn't mute A3. Nothing was changed.");
  });

  describe("undo", () => {
    it("when the track was unmuted by hand (or Premiere's Undo), says it is already undone; a second undo too", () => {
      const s = multiScene();
      const record = asStored(mute(s, "audio", 3, true).undo);
      s.seq.audioTracks[2].muted = false;
      expect(undoTool(s, record)).toEqual({ ok: true, alreadyUndone: true });
      s.seq.audioTracks[2].muted = true;
      expect(undoTool(s, record)).toEqual({ ok: true });
      expect(undoTool(s, record)).toEqual({ ok: true, alreadyUndone: true });
    });
    it("refuses when the track no longer exists", () => {
      const s = multiScene();
      const record = asStored(mute(s, "audio", 3, true).undo);
      s.seq.audioTracks.numTracks = 2;
      expect(() => undoTool(s, record)).toThrow("A3 no longer exists. Nothing was undone; use Premiere's Undo instead.");
    });
    it.each([["untouched"], ["unmuted by hand"]])("check: true matches the real undo (%s)", (name) => {
      const s = multiScene();
      const record = asStored(mute(s, "audio", 3, true).undo);
      if (name !== "untouched") s.seq.audioTracks[2].muted = false;
      const checked = undoCheck(s, record);
      expect(s.seq.audioTracks[2].muted).toBe(name === "untouched");
      const real = undoTool(s, record);
      if (name === "untouched") { expect(checked).toEqual({ ok: true, wouldUndo: true }); expect(real).toEqual({ ok: true }); }
      else expect(real).toEqual(checked);
      expect(s.seq.audioTracks[2].muted).toBe(false);
    });
  });
});

describe("gcutToolAddTransition: a cross dissolve or constant power fade at a clip's start or end (QE), and its undo", () => {
  const add = (s: any, clipId: string, at: unknown, seconds: unknown) => act(s, "gcutToolAddTransition", { clipId, at, seconds });
  const SKIPPED = { ok: true, skipped: true, message: "The transition stays: Premiere can't remove it from a script. Remove it by hand if needed." };

  it("adds a video Cross Dissolve at the clip's start through QE (measured call), counted on the track", () => {
    const s = georgScene();
    const r = add(s, idsOn(s, "V1")[0], "start", 1);
    expect(r).toMatchObject({ ok: true, transition: "Cross Dissolve", at: "start", seconds: 1, idMap: {} });
    expect(s.v1.transitions).toEqual([{ applyToStart: true, duration: "00:00:01:00", offset: "00:00:00:00", alignment: 0.5 }]);
    expect(asStored(r.undo)).toEqual(r.undo);
    expect(r.undo).toMatchObject({ kind: "transition", sequenceId: "seq-1" });
  });

  it("adds an audio Constant Power fade at the clip's end, to the frame", () => {
    const s = georgScene();
    const r = add(s, idsOn(s, "A1")[0], "end", 0.49); // 12.25 frames: the nearest is 12
    expect(r).toMatchObject({ ok: true, transition: "Constant Power", at: "end", seconds: 0.48 });
    expect(s.a1.transitions).toEqual([{ applyToStart: false, duration: "00:00:00:12", offset: "00:00:00:00", alignment: 0.5 }]);
  });

  it("undo skips the transition (no measured call removes one), saying so, in check mode too, and leaves it in place", () => {
    const s = georgScene();
    const r = add(s, idsOn(s, "V1")[0], "start", 1);
    expect(undoCheck(s, asStored(r.undo))).toEqual(SKIPPED);
    expect(undoTool(s, asStored(r.undo))).toEqual(SKIPPED);
    expect(s.v1.transitions).toHaveLength(1);
  });

  it.each([
    ["at that isn't start or end", "middle", 1, "at must be \"start\" or \"end\"."],
    ["no length", "start", undefined, "seconds must be the transition's length, at least one frame."],
    ["less than a frame", "start", 0.01, "seconds must be the transition's length, at least one frame."],
    ["longer than the clip", "start", 11, "A 11 s transition is longer than V1's clip (10 s). Nothing was changed."],
  ])("refuses %s, adding nothing", (_, at, seconds, msg) => {
    const s = georgScene();
    expect(() => add(s, idsOn(s, "V1")[0], at, seconds)).toThrow(msg);
    expect(s.v1.transitions).toEqual([]);
  });

  it("refuses when Premiere doesn't have the transition, or adds nothing", () => {
    const s = georgScene();
    s.host.qe.transition = false;
    expect(() => add(s, idsOn(s, "V1")[0], "start", 1)).toThrow("Premiere didn't find its Cross Dissolve transition. Nothing was changed.");
    s.host.qe.transition = true;
    const real = s.host.qe.project.getActiveSequence;
    s.host.qe.project.getActiveSequence = () => {
      const q = real(), t = q.getVideoTrackAt(0);
      return { ...q, getVideoTrackAt: () => ({ ...t, numItems: t.numItems, getItemAt: (k: number) => ({ ...t.getItemAt(k), addTransition: () => true }), numTransitions: 0 }) };
    };
    expect(() => add(s, idsOn(s, "V1")[0], "start", 1)).toThrow("Premiere didn't add the transition to V1's clip. Nothing was changed.");
  });

  it("refuses a locked track and a stale id, adding nothing", () => {
    const s = georgScene(), id = idsOn(s, "V1")[0];
    s.seq.videoTracks[0].locked = true;
    expect(() => add(s, id, "start", 1)).toThrow("V1 is locked. Unlock it to add a transition.");
    s.seq.videoTracks[0].locked = false;
    s.v1.start = Time.s(100.2);
    expect(() => add(s, id, "start", 1)).toThrow(STALE);
    expect(s.v1.transitions).toEqual([]);
  });
});

describe("gcutToolSetSpeed: play chosen clips faster or slower (QE setSpeed, timeline length kept), and its undo", () => {
  const speed = (s: any, clipIds: string[], v: unknown) => act(s, "gcutToolSetSpeed", { clipIds, speed: v });

  it("sets each chosen clip's speed with QE setSpeed; its place and length stay (measured)", () => {
    const s = georgScene(), before = exact(s.seq);
    const r = speed(s, idsOn(s, "V2"), 2);
    expect(r).toMatchObject({ ok: true, speed: 2, changed: 1, idMap: {} });
    expect(s.v2.speed).toBe(2);
    expect(exact(s.seq)).toEqual(before);
    expect(getSeq(s).clips.find((c: any) => c.track === "V2").speed).toBe(2);
  });

  it("undo sets the previous speed back, from the stored record", () => {
    const s = georgScene();
    s.v2.speed = 0.5;
    const r = speed(s, idsOn(s, "V2"), 2);
    expect(r.undo).toMatchObject({ kind: "speed", sequenceId: "seq-1" });
    expect(asStored(r.undo)).toEqual(r.undo);
    expect(undoTool({ host: load(s.seq) }, asStored(r.undo))).toEqual({ ok: true });
    expect(s.v2.speed).toBe(0.5);
  });

  it("refuses a clip whose own sound (or picture) isn't chosen with it: they would go out of sync", () => {
    const s = scene();
    expect(() => speed(s, idsOn(s, "V1"), 2)).toThrow(
      "V1's clip and its own sound on A1 would go out of sync. Choose both, or neither. Nothing was changed.");
    expect(() => speed(s, idsOn(s, "A1"), 2)).toThrow(
      "A1's clip and its own picture on V1 would go out of sync. Choose both, or neither. Nothing was changed.");
    expect([s.v.speed, s.a.speed]).toEqual([1, 1]);
    expect(speed(s, idsOn(s, "V1", "A1"), 2)).toMatchObject({ ok: true, changed: 2 });
    expect([s.v.speed, s.a.speed]).toEqual([2, 2]);
  });

  it.each([
    ["no speed", undefined, "speed must be a number above 0 and at most 100 (1 = 100%, 2 = twice as fast)."],
    ["zero", 0, "speed must be a number above 0 and at most 100 (1 = 100%, 2 = twice as fast)."],
    ["a reverse (negative)", -1, "speed must be a number above 0 and at most 100 (1 = 100%, 2 = twice as fast)."],
  ])("refuses %s, changing nothing", (_, v, msg) => {
    const s = georgScene();
    expect(() => speed(s, idsOn(s, "V2"), v)).toThrow(msg);
    expect(s.v2.speed).toBe(1);
  });

  it("refuses a reversed clip, a locked track, and Premiere not taking it, changing nothing", () => {
    const s = georgScene();
    s.v2.reversed = 1;
    expect(() => speed(s, idsOn(s, "V2"), 2)).toThrow("V2's clip plays reversed. Nothing was changed; set its speed by hand.");
    s.v2.reversed = 0;
    s.seq.videoTracks[1].locked = true;
    expect(() => speed(s, idsOn(s, "V2"), 2)).toThrow("V2 is locked. Unlock it to change the speed.");
    s.seq.videoTracks[1].locked = false;
    s.host.qe.speedNoop = true;
    expect(() => speed(s, idsOn(s, "V2", "V3"), 2)).toThrow("Premiere didn't set V2's speed. Nothing was changed.");
    expect([s.v2.speed, s.v3.speed]).toEqual([1, 1]);
  });

  it("puts back the speeds it set when a later clip fails", () => {
    const s = georgScene();
    const realGet = s.host.qe.project.getActiveSequence;
    s.host.qe.project.getActiveSequence = () => {
      const q = realGet(), t3 = q.getVideoTrackAt(2);
      return { ...q, getVideoTrackAt: (i: number) => (i !== 2 ? q.getVideoTrackAt(i)
        : { ...t3, numItems: t3.numItems, getItemAt: (k: number) => ({ ...t3.getItemAt(k), setSpeed: () => true }) }) };
    };
    expect(() => speed(s, idsOn(s, "V2", "V3"), 2)).toThrow("Premiere didn't set V3's speed. Nothing was changed.");
    expect([s.v2.speed, s.v3.speed]).toEqual([1, 1]);
  });

  describe("undo", () => {
    function fast() {
      const s = georgScene();
      const record = asStored(speed(s, idsOn(s, "V2", "V3"), 2).undo);
      return { s, record };
    }
    it("refuses, changing nothing, when a speed was changed by hand since", () => {
      const { s, record } = fast();
      s.v3.speed = 1.5;
      expect(() => undoTool(s, record)).toThrow("These clips were changed by hand since: V3's speed was changed. Nothing was undone; use Premiere's Undo instead.");
      expect([s.v2.speed, s.v3.speed]).toEqual([2, 1.5]);
    });
    it("refuses, changing nothing, when one was set back and the other not", () => {
      const { s, record } = fast();
      s.v3.speed = 1;
      expect(() => undoTool(s, record)).toThrow("These clips were changed by hand since: V3's speed was set back. Nothing was undone; use Premiere's Undo instead.");
      expect([s.v2.speed, s.v3.speed]).toEqual([2, 1]);
    });
    it("when both are back, says it is already undone; a second undo too", () => {
      const { s, record } = fast();
      expect(undoTool(s, record)).toEqual({ ok: true });
      expect([s.v2.speed, s.v3.speed]).toEqual([1, 1]);
      expect(undoTool(s, record)).toEqual({ ok: true, alreadyUndone: true });
    });
    it.each([
      ["untouched", (_: any) => {}],
      ["changed by hand", ({ s }: any) => { s.v3.speed = 1.5; }],
      ["back", ({ s }: any) => { s.v2.speed = 1; s.v3.speed = 1; }],
    ])("check: true matches the real undo (%s)", (name, change) => {
      const c = fast();
      change(c);
      const speeds = [c.s.v2.speed, c.s.v3.speed];
      const checked = outcomeOf(() => undoCheck(c.s, c.record));
      expect([c.s.v2.speed, c.s.v3.speed]).toEqual(speeds);
      const real = outcomeOf(() => undoTool(c.s, c.record));
      if (name === "untouched") { expect(checked).toEqual({ ok: true, wouldUndo: true }); expect(real).toEqual({ ok: true }); }
      else expect(real).toEqual(checked);
    });
  });
});
