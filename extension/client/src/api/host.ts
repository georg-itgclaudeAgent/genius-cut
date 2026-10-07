/**
 * The ExtendScript side (extension/host/index.jsx): snapshot the selected range, apply the
 * cuts to every clip in it, close the gap, restore. HostUnavailable means the gcut* functions aren't loaded in Premiere
 * (an old install, or a host script that failed to load), not a failed edit.
 */
import type { NotFound, Snapshot, Span } from "./types";

export class HostUnavailable extends Error {
  constructor() {
    super("Genius Cut's Premiere script isn't loaded. Reinstall Genius Cut, or restart Premiere.");
    this.name = "HostUnavailable";
  }
}

export interface ApplyResult {
  ok: boolean;
  appliedCount: number;
  clipCount: number;
  expectedDuration: number;
  actualDuration: number;
  trailingGapS: number;
  /** On failure: true if the host already put the original clip back. */
  rolledBack?: boolean;
  message?: string;
}

export interface Host {
  snapshotSelection(name: string | null): Promise<Snapshot | NotFound>;
  /** keptSpans are range-relative seconds. */
  applyCuts(snap: Snapshot, keptSpans: Span[]): Promise<ApplyResult>;
  /** Put the original clips back. Throws the host's message if it can't. */
  restore(snap: Snapshot): Promise<void>;
  /** Close the gap the cuts left at the end. Throws the host's message if it can't. */
  closeGap(snap: Snapshot): Promise<void>;
}

const MISSING = "__GCUT_MISSING__";

export function cepHost(evalScript: (s: string) => Promise<string>): Host {
  async function call(fn: string, ...args: unknown[]): Promise<any> {
    const argList = args.map((a) => JSON.stringify(JSON.stringify(a))).join(",");
    // Probe first: "EvalScript error." is what CEP returns for ANY uncaught ExtendScript
    // exception, so it can't tell "function missing" apart from "function failed".
    const script = `typeof ${fn} === "function" ? ${fn}(${argList}) : "${MISSING}"`;
    const out = await evalScript(script);
    if (out === MISSING) throw new HostUnavailable();
    if (!out || out === "EvalScript error.") throw new Error(`The Premiere script failed in ${fn}. Nothing further was changed.`);
    if (out.startsWith("Error:")) throw new Error(out.slice(6).trim());
    return JSON.parse(out);
  }
  const refusal = (r: any) => {
    if (r && r.ok === false) throw new Error(r.message || "Premiere couldn't do that. Use Undo.");
  };
  return {
    snapshotSelection: (name) => call("gcutSnapshotSelection", name ?? ""),
    applyCuts: (snap, spans) => call("gcutApplyCutsMulti", {
      sequenceId: snap.sequenceId, startTicks: snap.startTicks, endTicks: snap.endTicks,
      items: [...snap.video, ...snap.audio].map((x) => ({ kind: x.kind, trackIndex: x.trackIndex, startTicks: x.startTicks, endTicks: x.endTicks })),
      spans,
    }),
    restore: async (snap) => refusal(await call("gcutRestoreMulti", { startTicks: snap.startTicks })),
    closeGap: async (snap) => refusal(await call("gcutCloseGapMulti", { startTicks: snap.startTicks })),
  };
}
