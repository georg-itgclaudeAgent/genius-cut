import { describe, it, expect } from "vitest";
import { createTools, undoTurn, TOOL_ARGS, type ToolDeps } from "./tools";
import { createTurns, type TurnStore } from "./turns";
import type { TranscriptJob, TranscriptRequest } from "../api/types";

const TICKS = 254016000000;
const id = (label: string, startS: number, node: string) => `${label}@${Math.round(startS * TICKS)}#${node}`;
const V1 = id("V1", 100.5, "node-a"), A1 = id("A1", 100, "node-m"), A2 = id("A2", 90, "node-l");
const LISTING = {
  sequenceId: "seq-1", name: "Main", fps: 25, durationS: 120, tracks: [], markers: [], selection: [],
  clips: [
    { id: V1, track: "V1", name: "Camera A.mov", startS: 100.5, endS: 110, inS: 10, source: "D:/Camera A.mov", selected: false, enabled: true, speed: 1 },
    { id: A1, track: "A1", name: "mic.wav", startS: 100, endS: 112, inS: 50, source: "D:/mic.wav", selected: false, enabled: true, speed: 1 },
    { id: A2, track: "A2", name: "lav.wav", startS: 90, endS: 105, inS: 5, source: "D:/lav.wav", selected: false, enabled: true, speed: 1 },
  ],
};

const memoryStore = (): TurnStore => { let text: string | null = null; return { read: () => text, write: (t) => { text = t; } }; };

function fakes(job: Partial<TranscriptJob> = {}) {
  const host: [string, unknown][] = [], posted: TranscriptRequest[] = [], polled: [string, number][] = [];
  let next: TranscriptJob = { id: "j1", status: "running", progress: 0.25, ...job };
  let undoReply: () => unknown = () => ({ ok: true });
  let active = "seq-1";
  let listing: any = LISTING;
  let cutReply: any = { ok: true, cutCount: 1, clipCount: 2, removedS: 1, crossfades: 1, undo: { kind: "cuts", sequenceId: "seq-1" } };
  const turns = createTurns(memoryStore());
  const deps: ToolDeps = {
    turns,
    callHost: async (fn, args) => {
      host.push([fn, args]);
      if (fn === "gcutToolGetSequence") return { ...listing, sequenceId: active };
      if (fn === "gcutToolUndo") return undoReply();
      if (fn === "gcutToolAddMarkers") return { ok: true, created: ["g1"], undo: { kind: "markers", sequenceId: "seq-1", markers: [] } };
      if (fn === "gcutToolCutRanges") return typeof cutReply === "function" ? cutReply(args) : cutReply;
      throw new Error(`unexpected ${fn}`);
    },
    backend: {
      transcript: async (req) => { posted.push(req); return next; },
      transcriptJob: async (jobId, waitS) => { polled.push([jobId, waitS]); return next; },
    },
  };
  return { deps, host, posted, polled, turns, setJob: (j: Partial<TranscriptJob>) => { next = { ...next, ...j }; },
    onUndo: (f: () => unknown) => { undoReply = f; }, setActive: (id: string) => { active = id; },
    setListing: (l: any) => { listing = l; }, setCut: (r: any) => { cutReply = r; } };
}

describe("the bridge's tool table", () => {
  it("has the whole toolbox, read and act kinds, and declares each tool's arguments", () => {
    const t = createTools(fakes().deps);
    expect(Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.kind]))).toEqual({
      get_sequence: "read", get_transcript: "read", wait_transcript: "read", add_markers: "act", cut_ranges: "act",
      delete_clips: "act", close_gaps: "act", split_at: "act", set_clip_enabled: "act", move_clips: "act", switch_angle: "act",
      set_volume: "act", mute_track: "act", add_transition: "act", set_speed: "act", undo_last_turn: "act" });
    expect(Object.keys(TOOL_ARGS).sort()).toEqual(Object.keys(t).sort());
    expect(t.set_clip_label).toBeUndefined(); // dropped: Premiere can't label a single clip
  });

  it("refuses an argument the tool doesn't take, without calling the host", async () => {
    const f = fakes(), t = createTools(f.deps);
    await expect(t.split_at.run({ sequenceId: "seq-1", clipIds: [V1], atS: 102, at: 3 })).rejects.toThrow(
      "split_at has no argument at. Its arguments are: sequenceId, clipIds, atS.");
    expect(f.host).toEqual([]);
  });

  it("get_sequence is the host's listing, with Claude's arguments", async () => {
    const f = fakes();
    expect(await createTools(f.deps).get_sequence.run({ fromS: 10, toS: 20 })).toEqual(LISTING);
    expect(f.host).toEqual([["gcutToolGetSequence", { fromS: 10, toS: 20 }]]);
  });

  it("add_markers and cut_ranges hand Claude's arguments to the host and keep the undo record out of the reply", async () => {
    const f = fakes(), t = createTools(f.deps);
    const margs = { sequenceId: "seq-1", markers: [{ atS: 101, name: "Intro" }] };
    expect(await t.add_markers.run(margs)).toEqual({ ok: true, created: ["g1"] });
    const cargs = { sequenceId: "seq-1", clipIds: [V1, A1], ranges: [{ fromS: 102, toS: 103 }] };
    expect(await t.cut_ranges.run(cargs)).toEqual({ ok: true, cutCount: 1, clipCount: 2, removedS: 1, crossfades: 1 });
    expect(f.host).toEqual([["gcutToolAddMarkers", margs], ["gcutToolCutRanges", cargs]]);
  });

  describe("get_transcript", () => {
    it("asks the backend for the chosen clips' range, with the chosen audio as the sources (trimRequestFor)", async () => {
      const f = fakes();
      const r = await createTools(f.deps).get_transcript.run({ clipIds: [V1, A1, A2] });
      // Range = earliest start to latest end of the chosen clips: 90–112 s. Each source covers its part.
      expect(f.posted).toEqual([{ duration_s: 22, range_start_seq_s: 90, audio: [
        { media_path: "D:/mic.wav", in_s: 50, offset_s: 10, duration_s: 12 },
        { media_path: "D:/lav.wav", in_s: 5, offset_s: 0, duration_s: 15 }] }]);
      expect(r).toEqual({ id: "j1", status: "running", progress: 0.25 });
    });

    it("with only video clips chosen, transcribes their own files' sound", async () => {
      const f = fakes();
      await createTools(f.deps).get_transcript.run({ clipIds: [V1] });
      expect(f.posted[0]).toEqual({ duration_s: 9.5, range_start_seq_s: 100.5, audio: [
        { media_path: "D:/Camera A.mov", in_s: 10, offset_s: 0, duration_s: 9.5 }] });
    });

    it("gives the words in sequence seconds (the backend's are range-relative)", async () => {
      const f = fakes({ status: "done", progress: 1, words: [{ w: "hello", start: 0.5, end: 0.9 }, { w: "there", start: 11.25, end: 11.6 }] });
      const r = await createTools(f.deps).get_transcript.run({ clipIds: [A1] });
      expect(r).toEqual({ id: "j1", status: "done", progress: 1, words: [{ w: "hello", start: 100.5, end: 100.9 }, { w: "there", start: 111.25, end: 111.6 }] });
    });

    it("refuses an id that isn't on the timeline any more, without asking the backend", async () => {
      const f = fakes();
      await expect(createTools(f.deps).get_transcript.run({ clipIds: [id("V1", 7, "node-x")] })).rejects.toThrow(/call get_sequence again/);
      await expect(createTools(f.deps).get_transcript.run({ clipIds: [] })).rejects.toThrow(/at least one clip/);
      expect(f.posted).toEqual([]);
    });

    it("refuses a chosen clip not at 100% speed, as the Cut tab does, without asking the backend", async () => {
      const f = fakes();
      const listing = { ...LISTING, clips: LISTING.clips.map((c) => (c.id === V1 ? { ...c, speed: 2 } : c.id === A2 ? { ...c, speed: -1 } : c)) };
      const deps: ToolDeps = { ...f.deps, callHost: async (fn, a) => (fn === "gcutToolGetSequence" ? listing : f.deps.callHost(fn, a)) };
      const t = createTools(deps);
      await expect(t.get_transcript.run({ clipIds: [V1, A1] })).rejects.toThrow("V1 isn't at 100% speed.");
      await expect(t.get_transcript.run({ clipIds: [A1, A2] })).rejects.toThrow("A2 isn't at 100% speed.");
      expect(f.posted).toEqual([]);
      // A clip not chosen doesn't matter.
      expect(await t.get_transcript.run({ clipIds: [A1] })).toMatchObject({ id: "j1" });
    });

    it("passes a job's error on", async () => {
      const f = fakes({ status: "error", error: "ffmpeg failed" });
      expect(await createTools(f.deps).get_transcript.run({ clipIds: [A1] })).toEqual({ id: "j1", status: "error", progress: 0.25, error: "ffmpeg failed" });
    });
  });

  describe("wait_transcript", () => {
    it("long-polls the job up to 60 s and converts its words with that job's range start", async () => {
      const f = fakes(), t = createTools(f.deps);
      await t.get_transcript.run({ clipIds: [A2] }); // range starts at 90 s
      f.setJob({ status: "done", progress: 1, words: [{ w: "ok", start: 2, end: 2.4 }] });
      expect(await t.wait_transcript.run({ id: "j1" })).toEqual({ id: "j1", status: "done", progress: 1, words: [{ w: "ok", start: 92, end: 92.4 }] });
      expect(f.polled).toEqual([["j1", 60]]);
    });

    it("refuses a job this panel didn't start (its range start is unknown)", async () => {
      const f = fakes();
      await expect(createTools(f.deps).wait_transcript.run({ id: "other" })).rejects.toThrow(/call get_transcript again/);
      expect(f.polled).toEqual([]);
    });
  });

  describe("grouped undo (one Go = one turn)", () => {
    const MARGS = { sequenceId: "seq-1", markers: [{ atS: 101, name: "Intro" }] };
    const undoCalls = (f: ReturnType<typeof fakes>) => f.host.filter(([fn, a]: any) => fn === "gcutToolUndo" && !a.check).map(([, a]: any) => a.record.kind);
    const checkCalls = (f: ReturnType<typeof fakes>) => f.host.filter(([fn, a]: any) => fn === "gcutToolUndo" && a.check).map(([, a]: any) => a.record);
    const MARKER = { id: "g1", startS: 101, endS: 101, name: "Intro", comments: "", colour: 0 };
    const markerUndo = { kind: "markers", sequenceId: "seq-1", markers: [MARKER] };
    function grouped(f: ReturnType<typeof fakes>) {
      const deps: ToolDeps = { ...f.deps, callHost: async (fn, a) => (fn === "gcutToolAddMarkers"
        ? { ok: true, created: ["g1"], undo: markerUndo } : f.deps.callHost(fn, a)) };
      return createTools(deps);
    }
    const P1 = id("V1", 100.5, "node-a"), P2 = id("V1", 104, "node-a"), P3 = id("V1", 104, "node-b");

    it("undoes every action of the group, newest first, and says what the group did", async () => {
      const f = fakes(), t = grouped(f);
      f.setListing({ ...LISTING, markers: [MARKER] });
      f.turns.begin();
      await t.add_markers.run(MARGS);
      await t.cut_ranges.run({ sequenceId: "seq-1", clipIds: [V1], ranges: [{ fromS: 102, toS: 103 }] });
      f.turns.end();
      expect(await t.undo_last_turn.run({})).toEqual({ ok: true, undone: "Added 1 marker: Intro; Cut 1 range from 2 clips (1 s removed)" });
      expect(undoCalls(f)).toEqual(["cuts", "markers"]);
      expect(f.turns.latest("seq-1")).toBeUndefined();
    });

    it("pre-checks the whole group first: a marker changed by hand refuses before anything is undone", async () => {
      const f = fakes(), t = grouped(f);
      f.turns.begin();
      await t.add_markers.run(MARGS);
      await t.cut_ranges.run({ sequenceId: "seq-1", clipIds: [V1], ranges: [{ fromS: 102, toS: 103 }] });
      f.turns.end();
      f.setListing({ ...LISTING, markers: [{ ...MARKER, name: "Renamed" }] });
      await expect(t.undo_last_turn.run({})).rejects.toThrow("Nothing was undone: Intro was changed since. Use Premiere's Undo instead.");
      expect(undoCalls(f)).toEqual([]);
      expect(f.turns.latest("seq-1")!.actions).toHaveLength(2);
    });

    it("pre-checks the clips each act call made, except those a later call of the group replaced", async () => {
      const f = fakes();
      const tools = createTools(f.deps);
      f.turns.begin();
      // The first cut makes P1 and P2 from V1; the second cuts P2 into P3. P2 is gone by design; P3 must be there.
      f.setCut({ ok: true, cutCount: 1, clipCount: 1, removedS: 1, crossfades: 0, idMap: { [V1]: [P1, P2] }, undo: { kind: "cuts", sequenceId: "seq-1" } });
      await tools.cut_ranges.run({ sequenceId: "seq-1", clipIds: [V1], ranges: [{ fromS: 102, toS: 103 }] });
      f.setCut({ ok: true, cutCount: 1, clipCount: 1, removedS: 1, crossfades: 0, idMap: { [P2]: [P3] }, undo: { kind: "cuts", sequenceId: "seq-1" } });
      await tools.cut_ranges.run({ sequenceId: "seq-1", clipIds: [P2], ranges: [{ fromS: 105, toS: 106 }] });
      f.turns.end();
      const clip = (cid: string) => ({ ...LISTING.clips[0], id: cid });
      f.setListing({ ...LISTING, clips: [clip(P1), clip(P3)] });
      expect(await tools.undo_last_turn.run({})).toMatchObject({ ok: true });
      expect(undoCalls(f)).toHaveLength(2);

      // Again, with P1 moved by hand since: refused, nothing undone.
      f.host.length = 0;
      f.turns.begin();
      f.setCut({ ok: true, cutCount: 1, clipCount: 1, removedS: 1, crossfades: 0, idMap: { [V1]: [P1, P2] }, undo: { kind: "cuts", sequenceId: "seq-1" } });
      await tools.cut_ranges.run({ sequenceId: "seq-1", clipIds: [V1], ranges: [{ fromS: 102, toS: 103 }] });
      f.turns.end();
      f.setListing({ ...LISTING, clips: [clip(P2)] });
      await expect(tools.undo_last_turn.run({})).rejects.toThrow(/^Nothing was undone: Cut 1 range from 1 clip \(1 s removed\): its clips were moved, trimmed or removed since/);
      expect(undoCalls(f)).toEqual([]);
    });

    it("asks the host to check every record of the group, newest first, before reversing anything", async () => {
      const f = fakes(), t = grouped(f);
      f.setListing({ ...LISTING, markers: [MARKER] });
      f.turns.begin();
      await t.add_markers.run(MARGS);
      await t.cut_ranges.run({ sequenceId: "seq-1", clipIds: [V1], ranges: [{ fromS: 102, toS: 103 }] });
      f.turns.end();
      await t.undo_last_turn.run({});
      const undos = f.host.filter(([fn]) => fn === "gcutToolUndo").map(([, a]: any) => [a.record.kind, a.check === true]);
      expect(undos).toEqual([["cuts", true], ["markers", true], ["cuts", false], ["markers", false]]);
    });

    it("all or nothing: a host refusal on the oldest record leaves the newest untouched", async () => {
      const f = fakes(), t = grouped(f);
      f.setListing({ ...LISTING, markers: [MARKER] });
      f.turns.begin();
      await t.add_markers.run(MARGS);
      await t.cut_ranges.run({ sequenceId: "seq-1", clipIds: [V1], ranges: [{ fromS: 102, toS: 103 }] });
      f.turns.end();
      const refusal = "These markers were changed by hand since: Intro was changed. Nothing was undone.";
      f.onUndo(() => { const last: any = f.host[f.host.length - 1][1]; if (last.record.kind === "markers") throw new Error(refusal); return last.check ? { ok: true, wouldUndo: true } : { ok: true }; });
      await expect(t.undo_last_turn.run({})).rejects.toThrow(refusal);
      expect(checkCalls(f).map((r: any) => r.kind)).toEqual(["cuts", "markers"]);
      expect(undoCalls(f)).toEqual([]);
      expect(f.turns.latest("seq-1")!.actions).toHaveLength(2);
    });

    it("doesn't host-check a cut whose span a later cut of the group overlaps (that cut changed what it checks); undoes it after", async () => {
      const f = fakes();
      const tools = createTools(f.deps);
      const cut = (startT: number, endT: number) => ({ ok: true, cutCount: 1, clipCount: 1, removedS: 1, crossfades: 0,
        undo: { kind: "cuts", sequenceId: "seq-1", startT, endT } });
      f.turns.begin();
      f.setCut(cut(100, 200));
      await tools.cut_ranges.run({ sequenceId: "seq-1", clipIds: [V1], ranges: [{ fromS: 102, toS: 103 }] });
      f.setCut(cut(150, 180)); // inside the first cut's span
      await tools.cut_ranges.run({ sequenceId: "seq-1", clipIds: [V1], ranges: [{ fromS: 105, toS: 106 }] });
      f.setCut(cut(300, 400)); // clear of both
      await tools.cut_ranges.run({ sequenceId: "seq-1", clipIds: [V1], ranges: [{ fromS: 305, toS: 306 }] });
      f.turns.end();
      expect(await tools.undo_last_turn.run({})).toMatchObject({ ok: true });
      expect(checkCalls(f).map((r: any) => r.startT)).toEqual([300, 150]);
      expect(f.host.filter(([fn, a]: any) => fn === "gcutToolUndo" && !a.check).map(([, a]: any) => a.record.startT)).toEqual([300, 150, 100]);
    });

    it("a refusal the pre-check couldn't see stops the undo: what was undone is dropped, the rest stays, and the reply says so", async () => {
      const f = fakes(), t = grouped(f);
      f.setListing({ ...LISTING, markers: [MARKER] });
      f.turns.begin();
      await t.add_markers.run(MARGS);
      await t.cut_ranges.run({ sequenceId: "seq-1", clipIds: [V1], ranges: [{ fromS: 102, toS: 103 }] });
      f.turns.end();
      f.onUndo(() => { if (undoCalls(f).length === 2 && !(f.host[f.host.length - 1][1] as any).check) throw new Error("These markers were changed by hand since: Intro was changed. Nothing was undone."); return { ok: true }; });
      await expect(t.undo_last_turn.run({})).rejects.toThrow(
        "Undid 1 of 2 changes (Cut 1 range from 2 clips (1 s removed)); then stopped: These markers were changed by hand since: Intro was changed. Nothing was undone.");
      expect(f.turns.latest("seq-1")!.summary).toBe("Added 1 marker: Intro");
    });

    it("a transition the host skips (Premiere can't remove one from a script) doesn't block the group; the reply carries its note", async () => {
      const f = fakes(), t = grouped(f);
      f.setListing({ ...LISTING, markers: [MARKER] });
      const note = "The transition stays: Premiere can't remove it from a script. Remove it by hand if needed.";
      f.turns.begin();
      await t.add_markers.run(MARGS);
      f.turns.push({ sequenceId: "seq-1", tool: "add_transition", args: {}, summary: "Added a Cross Dissolve", undo: { kind: "transition", sequenceId: "seq-1" }, idMap: {} });
      f.turns.end();
      f.onUndo(() => { const last: any = f.host[f.host.length - 1][1]; return last.record.kind === "transition" ? { ok: true, skipped: true, message: note } : { ok: true }; });
      expect(await t.undo_last_turn.run({})).toEqual({ ok: true, undone: "Added 1 marker: Intro; Added a Cross Dissolve", message: note });
      expect(undoCalls(f)).toEqual(["transition", "markers"]);
      expect(f.turns.latest("seq-1")).toBeUndefined();
    });

    it("undoTurn undoes a chosen turn only while it is the newest on its sequence", async () => {
      const f = fakes(), t = grouped(f);
      f.setListing({ ...LISTING, markers: [MARKER] });
      const g = f.turns.begin();
      await t.add_markers.run(MARGS);
      f.turns.end();
      await t.cut_ranges.run({ sequenceId: "seq-1", clipIds: [V1], ranges: [{ fromS: 102, toS: 103 }] });
      await expect(undoTurn(f.deps, "seq-1", g)).rejects.toThrow("Newer changes were made since on this sequence; undo them first.");
      expect(undoCalls(f)).toEqual([]);
    });
  });

  describe("undo_last_turn", () => {
    const MARGS = { sequenceId: "seq-1", markers: [{ atS: 101, name: "Intro" }, { atS: 105, name: "Pricing" }] };
    const CARGS = { sequenceId: "seq-1", clipIds: [V1, A1], ranges: [{ fromS: 102, toS: 103 }] };
    const undoCalls = (f: ReturnType<typeof fakes>) => f.host.filter(([fn, a]: any) => fn === "gcutToolUndo" && !a.check).map(([, a]) => a);

    it("each successful act call is a turn: undo reverses the newest first, then the one before, with the host's own records", async () => {
      const f = fakes(), t = createTools(f.deps);
      await t.add_markers.run(MARGS);
      await t.cut_ranges.run(CARGS);
      expect(await t.undo_last_turn.run({})).toEqual({ ok: true, undone: "Cut 1 range from 2 clips (1 s removed)" });
      expect(await t.undo_last_turn.run({})).toEqual({ ok: true, undone: "Added 2 markers: Intro, Pricing" });
      expect(undoCalls(f)).toEqual([{ record: { kind: "cuts", sequenceId: "seq-1" } }, { record: { kind: "markers", sequenceId: "seq-1", markers: [] } }]);
      await expect(t.undo_last_turn.run({})).rejects.toThrow(/Nothing to undo/);
    });

    it("a refusal keeps the turn, and the reply says what is in the way", async () => {
      const f = fakes(), t = createTools(f.deps);
      await t.add_markers.run(MARGS);
      f.onUndo(() => { throw new Error("These markers were changed by hand since: Intro was changed. Nothing was undone."); });
      await expect(t.undo_last_turn.run({})).rejects.toThrow("These markers were changed by hand since: Intro was changed. Nothing was undone.");
      expect(f.turns.latest("seq-1")!.summary).toBe("Added 2 markers: Intro, Pricing");
      f.onUndo(() => ({ ok: true }));
      expect(await t.undo_last_turn.run({})).toMatchObject({ ok: true });
      expect(f.turns.latest("seq-1")).toBeUndefined();
    });

    it("when the host finds the turn already undone (Premiere's Undo took it back), pops it and says so", async () => {
      const f = fakes(), t = createTools(f.deps);
      await t.add_markers.run(MARGS);
      await t.cut_ranges.run(CARGS);
      f.onUndo(() => ({ ok: true, alreadyUndone: true }));
      expect(await t.undo_last_turn.run({})).toEqual({ ok: true, alreadyUndone: true, undone: "Cut 1 range from 2 clips (1 s removed)",
        message: "Already undone: nothing of it was left on the timeline." });
      expect(f.turns.latest("seq-1")!.summary).toBe("Added 2 markers: Intro, Pricing");
    });

    it("undoes the active sequence's turns only", async () => {
      const f = fakes(), t = createTools(f.deps);
      await t.add_markers.run(MARGS);
      f.setActive("seq-2");
      await expect(t.undo_last_turn.run({})).rejects.toThrow(/Nothing to undo/);
      expect(undoCalls(f)).toEqual([]);
      f.setActive("seq-1");
      expect(await t.undo_last_turn.run({})).toMatchObject({ ok: true });
    });

    it("a failed act call is no turn", async () => {
      const f = fakes(), t = createTools(f.deps);
      const failing: ToolDeps = { ...f.deps, callHost: async (fn, a) => {
        if (fn === "gcutToolAddMarkers") throw new Error("Marker 1 needs a name.");
        return f.deps.callHost(fn, a);
      } };
      await expect(createTools(failing).add_markers.run(MARGS)).rejects.toThrow("Marker 1 needs a name.");
      await expect(t.undo_last_turn.run({})).rejects.toThrow(/Nothing to undo/);
    });
  });

  describe("the piece-4 act tools", () => {
    const SEQ = "seq-1";
    // Each: Claude's args, the host function, the host's reply (with its undo record), the line the run shows.
    const cases: [string, any, string, any, string][] = [
      ["delete_clips", { sequenceId: SEQ, clipIds: [V1, A1] }, "gcutToolDeleteClips",
        { ok: true, deleted: [V1, A1], idMap: {}, undo: { kind: "delete", sequenceId: SEQ, items: [] } }, "Deleted 2 clips"],
      ["close_gaps", { sequenceId: SEQ, clipIds: [V1, A2], acceptEffectLoss: true }, "gcutToolCloseGaps",
        { ok: true, gapCount: 1, closedS: 2.5, movedCount: 3, idMap: { [V1]: ["V1@1#node-a"] }, undo: { kind: "moves", sequenceId: SEQ, moves: [] } },
        "Closed 1 gap (2.5 s); 3 clips moved"],
      ["split_at", { sequenceId: SEQ, clipIds: [V1], atS: 104 }, "gcutToolSplitAt",
        { ok: true, splitCount: 1, idMap: { [V1]: [V1, "V1@2#node-a"] }, undo: { kind: "split", sequenceId: SEQ, clips: [] } }, "Split 1 clip at 104 s"],
      ["set_clip_enabled", { sequenceId: SEQ, clipIds: [V1], enabled: false }, "gcutToolSetClipEnabled",
        { ok: true, changed: 1, idMap: {}, undo: { kind: "enabled", sequenceId: SEQ, items: [] } }, "Switched 1 clip off"],
      ["move_clips", { sequenceId: SEQ, clipIds: [V1, A1], byS: -1.5 }, "gcutToolMoveClips",
        { ok: true, movedCount: 2, idMap: { [V1]: ["V1@3#node-a"] }, undo: { kind: "moves", sequenceId: SEQ, moves: [] } }, "Moved 2 clips by -1.5 s"],
      ["switch_angle", { sequenceId: SEQ, clipIds: [V1], fromS: 101, toS: 103, showTrack: 2 }, "gcutToolSwitchAngle",
        { ok: true, shown: "V2", hidden: ["V1"], splitCount: 2, idMap: {}, undo: { kind: "angle", sequenceId: SEQ, clips: [], states: [] } },
        "Showed V2 from 101 to 103 s (V1 off)"],
      ["set_volume", { sequenceId: SEQ, clipIds: [A1], db: -6 }, "gcutToolSetVolume",
        { ok: true, db: -6, level: 0.1, changed: 1, idMap: {}, undo: { kind: "volume", sequenceId: SEQ, items: [] } }, "Set 1 clip's volume to -6 dB"],
      ["mute_track", { sequenceId: SEQ, kind: "audio", track: 2, muted: true }, "gcutToolMuteTrack",
        { ok: true, track: "A2", muted: true, changed: true, idMap: {}, undo: { kind: "mute", sequenceId: SEQ } }, "Muted A2"],
      ["add_transition", { sequenceId: SEQ, clipId: V1, at: "end", seconds: 1 }, "gcutToolAddTransition",
        { ok: true, transition: "Cross Dissolve", at: "end", seconds: 1, idMap: {}, undo: { kind: "transition", sequenceId: SEQ } },
        "Added a 1 s Cross Dissolve at the end of V1's clip"],
      ["set_speed", { sequenceId: SEQ, clipIds: [V1, A1], speed: 1.5 }, "gcutToolSetSpeed",
        { ok: true, speed: 1.5, changed: 2, idMap: {}, undo: { kind: "speed", sequenceId: SEQ, items: [] } }, "Set 2 clips to 150% speed"],
    ];

    it.each(cases)("%s calls its host function with Claude's arguments, records the undo and passes the idMap on", async (name, args, fn, hostReply, line) => {
      const f = fakes();
      const deps: ToolDeps = { ...f.deps, callHost: async (h, a) => { f.host.push([h, a]); return structuredClone(hostReply); } };
      const r: any = await createTools(deps)[name].run(args);
      const { undo, ...reply } = hostReply;
      expect(r).toEqual(reply);
      expect(r.idMap).toEqual(hostReply.idMap);
      expect(f.host).toEqual([[fn, args]]);
      const turn = f.turns.latest(SEQ)!;
      expect(turn.actions).toHaveLength(1);
      expect(turn.actions[0]).toMatchObject({ tool: name, args, summary: line, undo });
      if (Object.keys(hostReply.idMap).length) expect(turn.actions[0].idMap).toEqual(hostReply.idMap);
    });

    it("a refusal from the host is no turn", async () => {
      const f = fakes();
      const deps: ToolDeps = { ...f.deps, callHost: async () => { throw new Error("V1 is locked."); } };
      await expect(createTools(deps).delete_clips.run({ sequenceId: SEQ, clipIds: [V1] })).rejects.toThrow("V1 is locked.");
      expect(f.turns.latest(SEQ)).toBeUndefined();
    });
  });
});
