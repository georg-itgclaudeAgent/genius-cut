/**
 * The assistant's tool table: name → {kind, run(args)}. Host tools go to the gcutTool* functions in
 * extension/host/index.jsx through evalScript; transcripts go to the backend. Every time Claude sends or receives is in seconds
 * on the sequence.
 */
import type { Snapshot, SnapshotItem, TranscriptJob, TranscriptRequest } from "../api/types";
import { round3 } from "../lib/review";
import { trimRequestFor } from "../lib/snapshot";
import type { Turn, Turns } from "./turns";

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
  /** The undo stack: every successful act call is pushed (a turn of its own, or into the open group). */
  turns: Turns;
}

const TICKS = 254016000000;
const WAIT_S = 60;
const STALE = "The timeline changed since you read it; call get_sequence again.";

interface Clip { id: string; track: string; name: string; startS: number; endS: number; inS: number; source: string; speed: number }

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

/**
 * What stands in the way of undoing this turn, read off the timeline before anything is reversed:
 * markers it made that were changed or partly removed since, and clips an act call made (its idMap)
 * that were moved, trimmed or removed since — except clips a later call of the same turn replaced
 * on purpose. All of them gone means already undone (the host says so); that is no problem.
 */
export function undoProblems(turn: Turn, listing: any): string[] {
  const problems: string[] = [];
  const tol = listing?.fps > 0 ? 0.5 / listing.fps : 0.02;
  const clips = new Set<string>((listing?.clips ?? []).map((c: any) => String(c.id)));
  const markers = new Map<string, any>((listing?.markers ?? []).map((m: any) => [String(m.id), m]));
  const replacedLater = new Set<string>();
  for (let i = turn.actions.length - 1; i >= 0; i--) {
    const a = turn.actions[i], u: any = a.undo;
    if (u?.kind === "markers" && Array.isArray(u.markers) && u.markers.some((m: any) => markers.has(String(m.id)))) {
      for (const m of u.markers) {
        const now = markers.get(String(m.id));
        if (!now) problems.push(`${m.name} is gone`);
        else if (Math.abs(now.startS - m.startS) > tol || Math.abs(now.endS - m.endS) > tol || now.name !== m.name ||
                 now.comments !== m.comments || now.colour !== m.colour) problems.push(`${m.name} was changed since`);
      }
    }
    const made = Object.values(a.idMap ?? {}).flat().filter((x) => !replacedLater.has(x));
    const there = made.filter((x) => clips.has(x)).length;
    if (there > 0 && there < made.length) problems.push(`${a.summary}: its clips were moved, trimmed or removed since`);
    for (const old of Object.keys(a.idMap ?? {})) replacedLater.add(old);
  }
  return problems;
}

/** A cut record's span [startT, endT] (the host's own units), or null when it doesn't say. */
function cutSpan(u: any): [number, number] | null {
  return Number.isFinite(u?.startT) && Number.isFinite(u?.endT) ? [u.startT, u.endT] : null;
}

/**
 * True when a later action of the turn is a cut over this cut's span: that cut re-cut or covered what
 * this one's undo checks, so the host can only judge it once the later one is undone (undoProblems
 * checks its clips from the panel meanwhile). A record that doesn't give its span counts as overlapped.
 */
function overlappedLater(turn: Turn, i: number): boolean {
  const u: any = turn.actions[i].undo;
  if (u?.kind !== "cuts") return false;
  const mine = cutSpan(u);
  for (let j = i + 1; j < turn.actions.length; j++) {
    const v: any = turn.actions[j].undo;
    if (v?.kind !== "cuts") continue;
    const theirs = cutSpan(v);
    if (!mine || !theirs || (theirs[0] < mine[1] && mine[0] < theirs[1])) return true;
  }
  return false;
}

/**
 * Undo one turn (a single act call, or a whole Go), newest action first. The whole turn is checked
 * before anything is reversed: the panel's own read of the timeline (undoProblems), then the host's
 * check-only undo of every record, newest first (gcutToolUndo with check: true runs every refusal and
 * changes nothing); any refusal undoes nothing and is the reply. A cut a later cut of the turn overlaps
 * can't be host-checked until that one is undone, so a refusal only the host can see there still stops
 * part-way: what was undone is dropped from the turn, the rest stays, and the error says so.
 * `id`: undo that turn, refused unless it is still the newest on its sequence; none: the newest on
 * the active sequence.
 */
export async function undoTurn(deps: Pick<ToolDeps, "callHost" | "turns">, sequenceId?: string, id?: string) {
  const listing = await deps.callHost("gcutToolGetSequence", {});
  const active = String(listing.sequenceId);
  if (sequenceId !== undefined && sequenceId !== active) {
    throw new Error("A different sequence is open than the one this change was made on. Open that sequence first.");
  }
  const turn = deps.turns.latest(active);
  if (!turn) throw new Error("Nothing to undo on this sequence: no assistant change made on it is left to undo.");
  if (id !== undefined && turn.id !== id) throw new Error("Newer changes were made since on this sequence; undo them first.");
  const problems = undoProblems(turn, listing);
  if (problems.length) throw new Error(`Nothing was undone: ${problems.join("; ")}. Use Premiere's Undo instead.`);
  const total = turn.actions.length, summary = turn.summary, done: string[] = [];
  for (let i = total - 1; i >= 0; i--) {
    if (!overlappedLater(turn, i)) await deps.callHost("gcutToolUndo", { record: turn.actions[i].undo, check: true });
  }
  let already = 0;
  for (let i = total - 1; i >= 0; i--) {
    const a = turn.actions[i];
    let r: any;
    try {
      r = await deps.callHost("gcutToolUndo", { record: a.undo });
    } catch (e) {
      // A refusal throws the host's reason (what is in the way); the turn keeps what wasn't undone.
      if (!done.length) throw e;
      throw new Error(`Undid ${done.length} of ${total} changes (${done.join("; ")}); then stopped: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (r && r.alreadyUndone) already++;
    deps.turns.dropNewest(turn.sequenceId, turn.id);
    done.push(a.summary);
  }
  return already === total
    ? { ok: true, alreadyUndone: true, undone: summary, message: "Already undone: nothing of it was left on the timeline." }
    : { ok: true, undone: summary };
}

export function createTools(deps: ToolDeps): ToolTable {
  /** Run an act tool on the host; on success push it to the undo stack and reply without the undo record (the stack keeps that). */
  async function act(tool: string, fn: string, args: any, summary: (args: any, r: any) => string) {
    const r = await deps.callHost(fn, args ?? {});
    const { undo, ...reply } = r;
    deps.turns.push({ sequenceId: String(undo.sequenceId), tool, args: args ?? {}, summary: summary(args, r), undo,
      ...(r.idMap ? { idMap: r.idMap } : {}) });
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
        // As the Cut tab refuses them: a retimed clip's source time isn't its timeline time.
        const retimed = chosen.find((c) => Math.abs(c.speed - 1) > 1e-6);
        if (retimed) throw new Error(`${retimed.track} isn't at 100% speed.`);
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

    undo_last_turn: { kind: "act", run: () => undoTurn(deps) },
  };
}
