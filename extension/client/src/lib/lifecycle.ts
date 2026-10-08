/**
 * Find a running backend or start one (plan D3): poll /health; if nothing answers,
 * spawn it once and re-poll. A backend that's already running is reused, never doubled.
 */
import type { Health } from "../api/types";

/** The backend contract this panel speaks (backend/geniuscut/config.py API_VERSION). A backend
 *  left running from an older version is stopped and replaced (Checkpoint B, 2026-10-08: a
 *  day-old backend answered the new panel with "Field required" x4). */
export const API_VERSION = 3; // 3: TrimRequest.frame_s (clean cuts, 2026-10-08)

export const OUTDATED_BACKEND =
  "An older Genius Cut backend is still running. Restart Premiere, or end its python.exe in Task Manager, then try again.";

export type BackendState =
  | { kind: "ready"; health: Health }
  | { kind: "starting"; health: Health }
  | { kind: "failed"; message: string };

interface Deps {
  health: () => Promise<Health>;
  spawn: () => void;
  /** Stop a process by id (an outdated backend). */
  kill?: (pid: number) => void;
  sleep: (ms: number) => Promise<void>;
  attempts?: number;
  intervalMs?: number;
}

function classify(h: Health): BackendState {
  if (h.status === "error") return { kind: "failed", message: h.error || "The speech model failed to load." };
  if (h.stt_device === "loading") return { kind: "starting", health: h };
  return { kind: "ready", health: h };
}

export async function ensureBackend({ health, spawn, kill, sleep, attempts = 30, intervalMs = 500 }: Deps): Promise<BackendState> {
  const probe = async () => { try { return await health(); } catch { return null; } };
  const first = await probe();
  if (first && first.api === API_VERSION) return classify(first);
  if (first) {
    // A backend from an older version: stop it, wait for the port to free, then start ours.
    if (typeof first.pid !== "number" || !kill) return { kind: "failed", message: OUTDATED_BACKEND };
    try { kill(first.pid); } catch { return { kind: "failed", message: OUTDATED_BACKEND }; }
    let gone = false;
    for (let i = 0; i < attempts && !gone; i++) {
      await sleep(intervalMs);
      gone = (await probe()) === null;
    }
    if (!gone) return { kind: "failed", message: OUTDATED_BACKEND };
  }
  try {
    spawn();
  } catch (e: any) {
    if (e?.needsSetup) return { kind: "failed", message: e.message }; // already user-ready, no prefix
    return { kind: "failed", message: `Couldn't start the Genius Cut backend: ${e?.message || e}` };
  }
  for (let i = 0; i < attempts; i++) {
    await sleep(intervalMs);
    const h = await probe();
    if (h) return classify(h);
  }
  return {
    kind: "failed",
    message: `The Genius Cut backend didn't start within ${Math.round((attempts * intervalMs) / 1000)} s. ` +
      "Check the log at %APPDATA%/itGenius/genius-cut/backend.log.",
  };
}

/** What the panel says while the speech model loads: a download only when one is happening. */
export function startingMessage(h: Health): string {
  return h.stt_phase === "downloading"
    ? "Downloading the speech model. This happens once and is about 3 GB."
    : "Loading the speech model (about 30 seconds)…";
}
