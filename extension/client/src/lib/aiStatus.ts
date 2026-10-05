/**
 * Keeps the panel's AI spend figure fresh. /health is otherwise read once at connect, so
 * the month total and limit are re-read after every trim attempt (a failed run can still
 * be paid for), and whenever the panel regains focus or becomes visible (a summary ran,
 * the limit was raised, a new month started).
 */
import type { AiStatus, Health } from "../api/types";

export function watchAiStatus({ fetchHealth, onAi, win, doc }: {
  fetchHealth: () => Promise<Health>;
  onAi: (ai: AiStatus) => void;
  win: EventTarget;
  doc: EventTarget & { visibilityState: DocumentVisibilityState };
}) {
  let stopped = false;
  async function refresh() {
    try {
      const h = await fetchHealth();
      if (!stopped && h.ai) onAi(h.ai);
    } catch { /* backend busy or gone: keep the last figure */ }
  }
  const onFocus = () => { refresh(); };
  const onVisible = () => { if (doc.visibilityState === "visible") refresh(); };
  win.addEventListener("focus", onFocus);
  doc.addEventListener("visibilitychange", onVisible);
  return {
    refresh,
    stop() {
      stopped = true;
      win.removeEventListener("focus", onFocus);
      doc.removeEventListener("visibilitychange", onVisible);
    },
  };
}

/** Run a trim, then refresh the spend figure whether it worked or not. */
export async function afterTrimRefresh<T>(trim: () => Promise<T>, refresh: () => Promise<void>): Promise<T> {
  try {
    return await trim();
  } finally {
    await refresh();
  }
}
