/**
 * Review maths, recomputed live as the editor unticks cuts. `keptSpans` must
 * agree with backend/geniuscut/trim.py `kept_spans`: it is what the host re-lays.
 */
import type { SequenceCut, Span } from "../api/types";

const EPS = 1e-6;

/**
 * Python's round(x, 3): correctly rounded from the exact binary value, exact ties to even.
 * toFixed also works from the exact value but breaks ties upward, so ties are handled here.
 */
export function round3(x: number): number {
  const exact = x.toFixed(20);
  const tie = exact.match(/^(-?\d+\.\d{3})50*$/);
  if (!tie) return Number(x.toFixed(3));
  const down = Number(tie[1]);
  const lastDigit = Number(tie[1].slice(-1));
  return lastDigit % 2 === 0 ? down : Number((down + Math.sign(x) * 0.001).toFixed(3));
}
const ms = round3;

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

export function keptSpans(cuts: SequenceCut[], checked: boolean[], durationS: number): Span[] {
  return keptRelative(cuts, checked, durationS).map((s) => ({ start: ms(s.start), end: ms(s.end) }));
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
