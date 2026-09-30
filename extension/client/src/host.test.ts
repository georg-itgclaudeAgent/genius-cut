/**
 * Runs the real ExtendScript host (extension/host/index.jsx) in a Node sandbox against a
 * simulated Premiere object model. The sandbox has NO native JSON, like ExtendScript.
 *
 * This proves the host's logic against our model of the Premiere API, not against Premiere
 * itself: Checkpoint B checks the real thing. Where the docs are silent or contradictory
 * (setInPoint units, where overwriteClip puts linked audio) the model is configurable, so
 * the host's fallbacks and checks are exercised both ways.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import vm from "vm";

const TICKS = 254016000000;
const HOST_SRC = readFileSync(resolve(__dirname, "../../host/index.jsx"), "utf8");

class Time {
  private t = 0;
  get seconds() { return this.t / TICKS; }
  set seconds(s: number) { this.t = Math.round(s * TICKS); }
  get ticks() { return String(this.t); }
  set ticks(v: string) { this.t = Number(v); }
  static s(sec: number) { const x = new Time(); x.seconds = sec; return x; }
}

type Unit = "seconds" | "ticks";

class ProjectItem {
  inS = 0; outS: number;
  constructor(public name: string, public nodeId: string, public durationS: number, public unit: Unit = "seconds", public hasAudio = true) {
    this.outS = durationS;
  }
  getMediaPath() { return `D:/Footage/${this.name}`; }
  private toSeconds(v: any) { return this.unit === "seconds" ? Number(v) : Number(v) / TICKS; }
  setInPoint(v: any, _media: number) { this.inS = this.toSeconds(v); return 0; }
  setOutPoint(v: any, _media: number) { this.outS = this.toSeconds(v); return 0; }
  getInPoint() { return Time.s(this.inS); }
  getOutPoint() { return Time.s(this.outS); }
}

class TrackItem {
  start: Time; end: Time; inPoint: Time; outPoint: Time;
  selected = false; speed = 1; reversed = 0;
  constructor(public track: Track, public projectItem: ProjectItem, startS: number, inS: number, outS: number, public mediaType: string) {
    this.start = Time.s(startS); this.end = Time.s(startS + (outS - inS));
    this.inPoint = Time.s(inS); this.outPoint = Time.s(outS);
  }
  get name() { return this.projectItem.name; }
  isSelected() { return this.selected; }
  getSpeed() { return this.speed; }
  isSpeedReversed() { return this.reversed; }
  remove(_ripple: boolean, _align: boolean) { this.track.items = this.track.items.filter((i) => i !== this); return 0; }
  move(offset: Time) {
    const d = offset.seconds;
    this.start = Time.s(this.start.seconds + d); this.end = Time.s(this.end.seconds + d);
    return 0;
  }
}

class Track {
  items: TrackItem[] = [];
  constructor(public seq: Seq, public kind: "video" | "audio", public index: number) {}
  get clips() {
    const arr: any = [...this.items].sort((a, b) => a.start.seconds - b.start.seconds);
    arr.numItems = arr.length;
    return arr;
  }
  add(pi: ProjectItem, startS: number, inS: number, outS: number) {
    const it = new TrackItem(this, pi, startS, inS, outS, this.kind === "video" ? "Video" : "Audio");
    this.items.push(it);
    return it;
  }
  /** Overwrite: lays the bin item's current in/out at `ticks`, plus linked audio. */
  overwriteClip(pi: ProjectItem, ticks: string) {
    const startS = Number(ticks) / TICKS;
    this.seq.overwriteHook(this, pi, startS);
    return true;
  }
}

class Seq {
  videoTracks: any; audioTracks: any;
  timebase = String(Math.round(TICKS / 23.976));
  /** Where linked audio lands: same index as the video track by default. */
  audioTrackFor = (videoIndex: number) => videoIndex;
  dropSpanIndex = -1;
  private placements = 0;
  constructor(nV = 2, nA = 2) {
    const v = Array.from({ length: nV }, (_, i) => new Track(this, "video", i));
    const a = Array.from({ length: nA }, (_, i) => new Track(this, "audio", i));
    this.videoTracks = Object.assign(v, { numTracks: nV });
    this.audioTracks = Object.assign(a, { numTracks: nA });
  }
  overwriteHook(track: Track, pi: ProjectItem, startS: number) {
    const n = this.placements++;
    if (n === this.dropSpanIndex) return; // simulate Premiere silently not placing a span
    track.add(pi, startS, pi.inS, pi.outS);
    if (track.kind === "video" && pi.hasAudio) this.audioTracks[this.audioTrackFor(track.index)].add(pi, startS, pi.inS, pi.outS);
  }
}

function load(seq: Seq) {
  const sandbox: any = { app: { project: { activeSequence: seq } }, Time, $: { global: {} } };
  const ctx = vm.createContext(sandbox);
  vm.runInContext("delete this.JSON;", ctx); // ExtendScript has no JSON
  vm.runInContext(HOST_SRC, ctx);
  const call = (fn: string, arg: unknown) => {
    const out: string = (ctx as any)[fn]((ctx as any).gcutStringify(arg));
    if (out.startsWith("Error:")) throw new Error(out.slice(6).trim());
    return (ctx as any).gcutParse(out);
  };
  return { ctx, call };
}

/** One interview clip on V1 + A1: source 10–20 s, placed at 100 s on the timeline. */
function scene(unit: Unit = "seconds") {
  const seq = new Seq();
  const pi = new ProjectItem("interview_take3.mp4", "node-1", 60, unit);
  pi.inS = 2; pi.outS = 58; // the bin item's own in/out, which must be left as found
  const v = seq.videoTracks[0].add(pi, 100, 10, 20);
  seq.audioTracks[0].add(pi, 100, 10, 20);
  v.selected = true;
  return { seq, pi, v, host: load(seq) };
}

const spans = [{ start: 10, end: 12 }, { start: 13, end: 17 }, { start: 18, end: 20 }]; // keeps 8 of 10 s

describe("JSON without native JSON", () => {
  it("round-trips awkward strings", () => {
    const { ctx } = scene().host;
    const s = 'he said "cut" \\ \n tab\t é \u2028';
    expect((ctx as any).gcutParse((ctx as any).gcutStringify({ s, n: [1, 2.5, null, true] }))).toEqual({ s, n: [1, 2.5, null, true] });
  });
  it("refuses anything that isn't JSON", () => {
    const { ctx } = scene().host;
    expect(() => (ctx as any).gcutParse("app.quit()")).toThrow();
  });
});

describe("gcutFindClip", () => {
  it("uses the selected clip when no name is given", () => {
    const { host } = scene();
    const c = host.call("gcutFindClip", "");
    expect(c).toMatchObject({ found: true, name: "interview_take3.mp4", trackIndex: 0, inS: 10, outS: 20, startS: 100,
      matchCount: 1, selectedUsed: true, speed: 1, mediaPath: "D:/Footage/interview_take3.mp4" });
    expect(c.fps).toBeCloseTo(23.976, 2);
    expect(c.startTicks).toBe(String(100 * TICKS));
  });
  it("matches by name with or without the extension, any case", () => {
    const { host, v } = scene();
    v.selected = false;
    expect(host.call("gcutFindClip", "INTERVIEW_TAKE3").found).toBe(true);
  });
  it("reports not found rather than guessing", () => {
    const { host } = scene();
    expect(host.call("gcutFindClip", "b-roll")).toMatchObject({ found: false });
  });
  it("reports speed, including reversed", () => {
    const { host, v } = scene();
    v.speed = 1.5; expect(host.call("gcutFindClip", "").speed).toBe(1.5);
    v.reversed = 1; expect(host.call("gcutFindClip", "").speed).toBe(-1.5);
  });
  it("prefers the selected one of several matches and says how many there were", () => {
    const { seq, pi, host, v } = scene();
    v.selected = false;
    const second = seq.videoTracks[1].add(pi, 300, 0, 5);
    second.selected = true;
    expect(host.call("gcutFindClip", "interview_take3")).toMatchObject({ trackIndex: 1, matchCount: 2, selectedUsed: true });
  });
});

describe("gcutApplyCuts", () => {
  const apply = (s: ReturnType<typeof scene>, sp = spans) =>
    s.host.call("gcutApplyCuts", { trackIndex: 0, startTicks: String(100 * TICKS), spans: sp });

  it("rebuilds the kept spans back to back from the original start, video and audio", () => {
    const s = scene();
    const r = apply(s);
    expect(r).toMatchObject({ ok: true, appliedCount: 3 });
    expect(r.expectedDuration).toBeCloseTo(8);
    expect(r.trailingGapS).toBeCloseTo(2);
    const v = s.seq.videoTracks[0].clips, a = s.seq.audioTracks[0].clips;
    expect(v.map((i: TrackItem) => [i.start.seconds, i.inPoint.seconds, i.outPoint.seconds])).toEqual([[100, 10, 12], [102, 13, 17], [106, 18, 20]]);
    expect(a.numItems).toBe(3);
  });

  it("leaves the bin item's own in/out exactly as it found them", () => {
    const s = scene();
    apply(s);
    expect([s.pi.inS, s.pi.outS]).toEqual([2, 58]);
  });

  it("works when this Premiere build wants ticks instead of seconds", () => {
    const s = scene("ticks");
    expect(apply(s).ok).toBe(true);
    expect(s.seq.videoTracks[0].clips[1].inPoint.seconds).toBeCloseTo(13);
  });

  it("reports ok:false (never success) when a span silently fails to land", () => {
    const s = scene();
    s.seq.dropSpanIndex = 1;
    const r = apply(s);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/doesn't match/);
  });

  it("reports ok:false when the linked audio lands on a different track", () => {
    const s = scene();
    s.seq.audioTrackFor = () => 1;
    const r = apply(s);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/A1/);
  });

  it.each([
    ["the clip moved", { startTicks: String(99 * TICKS) }, /moved or changed/],
    ["spans outside the clip", { spans: [{ start: 5, end: 12 }] }, /outside the clip/],
    ["overlapping spans", { spans: [{ start: 10, end: 14 }, { start: 13, end: 15 }] }, /overlap/],
    ["nothing kept", { spans: [] }, /nothing to keep/i],
  ])("refuses when %s, and changes nothing", (_label, patch, msg) => {
    const s = scene();
    expect(() => s.host.call("gcutApplyCuts", { trackIndex: 0, startTicks: String(100 * TICKS), spans, ...patch })).toThrow(msg);
    expect(s.seq.videoTracks[0].clips.numItems).toBe(1);
    expect(s.seq.audioTracks[0].clips.numItems).toBe(1);
  });

  it("refuses a retimed clip, and changes nothing", () => {
    const s = scene();
    s.v.speed = 2;
    expect(() => apply(s)).toThrow(/100% speed/);
    expect(s.seq.videoTracks[0].clips.numItems).toBe(1);
  });
});

describe("gcutRestoreOriginal", () => {
  it("puts the original clip back exactly, audio included, and the bin untouched", () => {
    const s = scene();
    s.host.call("gcutApplyCuts", { trackIndex: 0, startTicks: String(100 * TICKS), spans });
    expect(s.host.call("gcutRestoreOriginal", { trackIndex: 0, startTicks: String(100 * TICKS) })).toEqual({ ok: true });
    const v = s.seq.videoTracks[0].clips;
    expect(v.map((i: TrackItem) => [i.start.seconds, i.end.seconds, i.inPoint.seconds, i.outPoint.seconds])).toEqual([[100, 110, 10, 20]]);
    expect(s.seq.audioTracks[0].clips.numItems).toBe(1);
    expect([s.pi.inS, s.pi.outS]).toEqual([2, 58]);
  });
  it("without a Genius Cut edit this session, points at Premiere's Undo", () => {
    const s = scene();
    expect(() => s.host.call("gcutRestoreOriginal", { trackIndex: 0, startTicks: String(100 * TICKS) })).toThrow(/Undo/);
  });
});

describe("gcutCloseTrailingGap", () => {
  let s: ReturnType<typeof scene>;
  beforeEach(() => {
    s = scene();
    const later = new ProjectItem("b-roll.mp4", "node-2", 30);
    s.seq.videoTracks[0].add(later, 110, 0, 5);   // right after the original clip on V1
    s.seq.audioTracks[1].add(later, 112, 0, 3);   // and something later on A2
    s.host.call("gcutApplyCuts", { trackIndex: 0, startTicks: String(100 * TICKS), spans });
  });

  it("ripples everything after the gap left by the gap, on every track", () => {
    expect(s.host.call("gcutCloseTrailingGap", { trackIndex: 0, startTicks: String(100 * TICKS) })).toMatchObject({ ok: true, movedCount: 2 });
    const bRoll = s.seq.videoTracks[0].clips.find((i: TrackItem) => i.name === "b-roll.mp4");
    expect(bRoll.start.seconds).toBeCloseTo(108);
    expect(s.seq.audioTracks[1].clips[0].start.seconds).toBeCloseTo(110);
  });

  it("refuses if anything on another track sits inside the gap", () => {
    const blocker = new ProjectItem("music.wav", "node-3", 60);
    s.seq.audioTracks[1].add(blocker, 109, 0, 0.5);
    expect(() => s.host.call("gcutCloseTrailingGap", { trackIndex: 0, startTicks: String(100 * TICKS) })).toThrow(/A2 sits inside the gap/);
  });

  it("after the gap is closed, restore refuses and points at Undo", () => {
    s.host.call("gcutCloseTrailingGap", { trackIndex: 0, startTicks: String(100 * TICKS) });
    expect(() => s.host.call("gcutRestoreOriginal", { trackIndex: 0, startTicks: String(100 * TICKS) })).toThrow(/Undo/);
  });
});
