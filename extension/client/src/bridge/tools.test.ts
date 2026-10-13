import { describe, it, expect } from "vitest";
import { createTools, type ToolDeps } from "./tools";
import { createTurns, type TurnStore } from "./turns";
import type { TranscriptJob, TranscriptRequest } from "../api/types";

const TICKS = 254016000000;
const id = (label: string, startS: number, node: string) => `${label}@${Math.round(startS * TICKS)}#${node}`;
const V1 = id("V1", 100.5, "node-a"), A1 = id("A1", 100, "node-m"), A2 = id("A2", 90, "node-l");
const LISTING = {
  sequenceId: "seq-1", name: "Main", fps: 25, durationS: 120, tracks: [], markers: [], selection: [],
  clips: [
    { id: V1, track: "V1", name: "Camera A.mov", startS: 100.5, endS: 110, inS: 10, source: "D:/Camera A.mov", selected: false, enabled: true },
    { id: A1, track: "A1", name: "mic.wav", startS: 100, endS: 112, inS: 50, source: "D:/mic.wav", selected: false, enabled: true },
    { id: A2, track: "A2", name: "lav.wav", startS: 90, endS: 105, inS: 5, source: "D:/lav.wav", selected: false, enabled: true },
  ],
};

const memoryStore = (): TurnStore => { let text: string | null = null; return { read: () => text, write: (t) => { text = t; } }; };

function fakes(job: Partial<TranscriptJob> = {}) {
  const host: [string, unknown][] = [], posted: TranscriptRequest[] = [], polled: [string, number][] = [];
  let next: TranscriptJob = { id: "j1", status: "running", progress: 0.25, ...job };
  let undoReply: () => unknown = () => ({ ok: true });
  let active = "seq-1";
  const turns = createTurns(memoryStore());
  const deps: ToolDeps = {
    turns,
    callHost: async (fn, args) => {
      host.push([fn, args]);
      if (fn === "gcutToolGetSequence") return { ...LISTING, sequenceId: active };
      if (fn === "gcutToolUndo") return undoReply();
      if (fn === "gcutToolAddMarkers") return { ok: true, created: ["g1"], undo: { kind: "markers", sequenceId: "seq-1", markers: [] } };
      if (fn === "gcutToolCutRanges") return { ok: true, cutCount: 1, clipCount: 2, removedS: 1, crossfades: 1, undo: { kind: "cuts", sequenceId: "seq-1" } };
      throw new Error(`unexpected ${fn}`);
    },
    backend: {
      transcript: async (req) => { posted.push(req); return next; },
      transcriptJob: async (jobId, waitS) => { polled.push([jobId, waitS]); return next; },
    },
  };
  return { deps, host, posted, polled, turns, setJob: (j: Partial<TranscriptJob>) => { next = { ...next, ...j }; },
    onUndo: (f: () => unknown) => { undoReply = f; }, setActive: (id: string) => { active = id; } };
}

describe("the bridge's tool table", () => {
  it("has the Phase 1 tools, read and act kinds", () => {
    const t = createTools(fakes().deps);
    expect(Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.kind]))).toMatchObject({
      get_sequence: "read", get_transcript: "read", wait_transcript: "read", add_markers: "act", cut_ranges: "act", undo_last_turn: "act" });
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

  describe("undo_last_turn", () => {
    const MARGS = { sequenceId: "seq-1", markers: [{ atS: 101, name: "Intro" }, { atS: 105, name: "Pricing" }] };
    const CARGS = { sequenceId: "seq-1", clipIds: [V1, A1], ranges: [{ fromS: 102, toS: 103 }] };
    const undoCalls = (f: ReturnType<typeof fakes>) => f.host.filter(([fn]) => fn === "gcutToolUndo").map(([, a]) => a);

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
});
