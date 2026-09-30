/**
 * Review maths, recomputed live as the editor unticks cuts. `keptSpansSource` must
 * agree with backend/geniuscut/trim.py `kept_spans`: it is what the host re-lays.
 */
import type { SequenceCut, Span } from "../api/types";

const EPS = 1e-6;
const ms = (x: number) => Math.round(x * 1000) / 1000;

/** Complement of the ticked cuts over [0, duration], span-relative. */
function keptRelative(cuts: SequenceCut[], checked: boolean[], duration: number): Span[] {
  const active = cuts.filter((_, i) => checked[i]).sort((a, b) => a.start - b.start);
  const kept: Span[] = [];
  let cursor = 0;
  for (const c of active) {
    const start = Math.max(0, c.start), end = Math.min(duration, c.end);
    if (start > cursor) kept.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
  }
  if (cursor < duration) kept.push({ start: cursor, end: duration });
  return kept.filter((s) => s.end - s.start > EPS);
}

export function keptSpansSource(
  cuts: SequenceCut[], checked: boolean[], clip: { in_s: number; out_s: number },
): Span[] {
  return keptRelative(cuts, checked, clip.out_s - clip.in_s)
    .map((s) => ({ start: ms(clip.in_s + s.start), end: ms(clip.in_s + s.end) }));
}

export interface ReviewSummary {
  count: number;
  reclaimedS: number;
  resultS: number;
  keepsNothing: boolean;
}

export function reviewSummary(cuts: SequenceCut[], checked: boolean[], duration: number): ReviewSummary {
  const kept = keptRelative(cuts, checked, duration);
  const keptS = kept.reduce((a, s) => a + (s.end - s.start), 0);
  return {
    count: checked.filter(Boolean).length,
    reclaimedS: duration - keptS,
    resultS: keptS,
    keepsNothing: kept.length === 0,
  };
}
