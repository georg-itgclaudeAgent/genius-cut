/**
 * Find a running backend or start one (plan D3): poll /health; if nothing answers,
 * spawn it once and re-poll. A backend that's already running is reused, never doubled.
 */
import type { Health } from "../api/types";

export type BackendState =
  | { kind: "ready"; health: Health }
  | { kind: "starting"; health: Health }
  | { kind: "failed"; message: string };

interface Deps {
  health: () => Promise<Health>;
  spawn: () => void;
  sleep: (ms: number) => Promise<void>;
  attempts?: number;
  intervalMs?: number;
}

function classify(h: Health): BackendState {
  if (h.status === "error") return { kind: "failed", message: h.error || "The speech model failed to load." };
  if (h.stt_device === "loading") return { kind: "starting", health: h };
  return { kind: "ready", health: h };
}

export async function ensureBackend({ health, spawn, sleep, attempts = 30, intervalMs = 500 }: Deps): Promise<BackendState> {
  const probe = async () => { try { return await health(); } catch { return null; } };
  const first = await probe();
  if (first) return classify(first);
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
