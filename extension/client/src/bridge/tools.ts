/**
 * The assistant's tool table: name → {kind, run(args)}. Host tools go to extension/host/assistant.jsx
 * through evalScript; transcripts go to the backend. Every time Claude sends or receives is in seconds
 * on the sequence.
 */
import type { Snapshot, SnapshotItem, TranscriptJob, TranscriptRequest } from "../api/types";
import { round3 } from "../lib/review";
import { trimRequestFor } from "../lib/snapshot";
import type { Turns } from "./turns";

export interface Tool {
  /** act tools change the timeline: refused while the Cut tab is busy. */
  kind: "read" | "act";
  run(args: any): Promise<unknown>;
}
export type ToolTable = Record<string, Tool>;

export interface ToolDeps {
  /** A gcut* host function with one JSON argument (api/host.ts hostCaller). */
  callHost: (fn: string, args: unknown) => Promise<any>;
  backend: {
    transcript(req: TranscriptRequest): Promise<TranscriptJob>;
    transcriptJob(id: string, waitS: number): Promise<TranscriptJob>;
  };
  /** The undo stack: every successful act call is pushed as one turn. */
  turns: Turns;
}

const TICKS = 254016000000;
const WAIT_S = 60;
const STALE = "The timeline changed since you read it; call get_sequence again.";

interface Clip { id: string; track: string; name: string; startS: number; endS: number; inS: number; source: string }

/** A get_sequence clip as the snapshot item trimRequestFor reads (its start ticks are in its id). */
function asItem(c: Clip): SnapshotItem {
  const kind = c.id.startsWith("A") ? "audio" : "video";
  return { kind, trackIndex: Number(c.track.slice(1)) - 1, label: c.track, startTicks: /@(\d+)#/.exec(c.id)![1],
           endTicks: String(Math.round(c.endS * TICKS)), name: c.name, mediaPath: c.source, inS: c.inS, outS: 0, speed: 1, effects: [] };
}

/** The job with its words moved from range-relative to sequence seconds. */
function onSequence(job: TranscriptJob, startS: number) {
  const out: Record<string, unknown> = { id: job.id, status: job.status, progress: job.progress };
  if (job.words) out.words = job.words.map((w) => ({ w: w.w, start: round3(w.start + startS), end: round3(w.end + startS) }));
  if (job.error) out.error = job.error;
  return out;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function markersSummary(args: any): string {
  const names = (Array.isArray(args?.markers) ? args.markers : []).map((m: any) => String(m?.name ?? ""));
  return `Added ${plural(names.length, "marker")}: ${names.join(", ")}`;
}

function cutSummary(r: any): string {
  return `Cut ${plural(r.cutCount, "range")} from ${plural(r.clipCount, "clip")} (${round3(r.removedS)} s removed)`;
}

export function createTools(deps: ToolDeps): ToolTable {
  /** Run an act tool on the host; on success push it as a turn and reply without the undo record (the stack keeps that). */
  async function act(tool: string, fn: string, args: any, summary: (args: any, r: any) => string) {
    const r = await deps.callHost(fn, args ?? {});
    const { undo, ...reply } = r;
    deps.turns.push({ sequenceId: String(undo.sequenceId), tool, args: args ?? {}, summary: summary(args, r), undo });
    return reply;
  }

  /** Where each job this panel started begins on the sequence: its words come back range-relative. */
  const jobStarts = new Map<string, number>();

  return {
    get_sequence: { kind: "read", run: (args) => deps.callHost("gcutToolGetSequence", args ?? {}) },

    get_transcript: {
      kind: "read",
      async run(args) {
        const ids: unknown = args?.clipIds;
        if (!Array.isArray(ids) || !ids.length) throw new Error("Choose at least one clip (its id from get_sequence).");
        const seq = await deps.callHost("gcutToolGetSequence", {});
        const chosen: Clip[] = ids.map((id) => {
          const c = (seq.clips as Clip[]).find((x) => x.id === String(id));
          if (!c) throw new Error(STALE);
          return c;
        });
        // The chosen audio clips are the sources; with only video chosen, their own files' sound.
        const audio = chosen.filter((c) => c.id.startsWith("A"));
        const sources = (audio.length ? audio : chosen).map(asItem);
        const startS = Math.min(...chosen.map((c) => c.startS)), endS = Math.max(...chosen.map((c) => c.endS));
        const snap: Snapshot = { found: true, sequenceId: seq.sequenceId, startTicks: String(Math.round(startS * TICKS)),
          endTicks: String(Math.round(endS * TICKS)), startS, durationS: round3(endS - startS), fps: seq.fps,
          video: [], audio: sources, problems: [] };
        const { duration_s, range_start_seq_s, audio: parts } = trimRequestFor(snap, sources, "");
        const job = await deps.backend.transcript({ duration_s, range_start_seq_s, audio: parts });
        jobStarts.set(job.id, range_start_seq_s);
        return onSequence(job, range_start_seq_s);
      },
    },

    wait_transcript: {
      kind: "read",
      async run(args) {
        const id = String(args?.id ?? "");
        const startS = jobStarts.get(id);
        if (startS === undefined) throw new Error("That transcript wasn't asked for in this panel session; call get_transcript again.");
        return onSequence(await deps.backend.transcriptJob(id, WAIT_S), startS);
      },
    },

    add_markers: { kind: "act", run: (args) => act("add_markers", "gcutToolAddMarkers", args, markersSummary) },
    cut_ranges: { kind: "act", run: (args) => act("cut_ranges", "gcutToolCutRanges", args, (_a, r) => cutSummary(r)) },

    undo_last_turn: {
      kind: "act",
      async run() {
        // The active sequence's id (a listing of nothing: the stretch 0–0 holds no clip).
        const { sequenceId } = await deps.callHost("gcutToolGetSequence", { fromS: 0, toS: 0 });
        const turn = deps.turns.latest(String(sequenceId));
        if (!turn) throw new Error("Nothing to undo on this sequence: no assistant change made on it is left to undo.");
        // A refusal throws the host's reason (what is in the way) and the turn stays.
        const r = await deps.callHost("gcutToolUndo", { record: turn.undo });
        deps.turns.pop(turn.sequenceId, turn.id);
        return r && r.alreadyUndone
          ? { ok: true, alreadyUndone: true, undone: turn.summary, message: "Already undone: nothing of it was left on the timeline." }
          : { ok: true, undone: turn.summary };
      },
    },
  };
}
