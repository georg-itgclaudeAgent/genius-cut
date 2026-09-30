/**
 * The ExtendScript side (extension/host/index.jsx): find the clip, apply the cuts, close
 * the gap, restore. HostUnavailable means the gcut* functions aren't loaded in Premiere
 * (an old install, or a host script that failed to load), not a failed edit.
 */
import type { ClipInfo, Span } from "./types";

export class HostUnavailable extends Error {
  constructor() {
    super("Genius Cut's Premiere script isn't loaded. Reinstall Genius Cut, or restart Premiere.");
    this.name = "HostUnavailable";
  }
}

export interface ApplyResult {
  ok: boolean;
  appliedCount: number;
  expectedDuration: number;
  actualDuration: number;
  trailingGapS: number;
  message?: string;
}

export interface Host {
  findClip(name: string | null): Promise<ClipInfo>;
  applyCuts(clip: ClipInfo, keptSpansSource: Span[]): Promise<ApplyResult>;
  closeGap(clip: ClipInfo): Promise<void>;
  restoreOriginal(clip: ClipInfo): Promise<void>;
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
  return {
    findClip: (name) => call("gcutFindClip", name ?? ""),
    applyCuts: (clip, spans) => call("gcutApplyCuts", { trackIndex: clip.trackIndex, startTicks: clip.startTicks, spans }),
    closeGap: (clip) => call("gcutCloseTrailingGap", { trackIndex: clip.trackIndex, startTicks: clip.startTicks }),
    restoreOriginal: (clip) => call("gcutRestoreOriginal", { trackIndex: clip.trackIndex, startTicks: clip.startTicks }),
  };
}
