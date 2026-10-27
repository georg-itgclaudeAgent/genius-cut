/** Money, tokens and the monthly AI limit, as the panel shows them. Pure, so it's tested. */
import type { AiStatus, RunCost } from "../api/types";

/** `$0.03`, `$1.25`; `<$0.01` above zero but under a cent; `cost unknown` for no price. */
export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "cost unknown";
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/** 850, 7.1k, 1.3M. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** m:ss, whole seconds: how the estimate names a clip's length. */
function clipLength(seconds: number): string {
  const t = Math.round(Math.max(0, seconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

export interface BudgetEstimate {
  /** USD for this clip; null when there's no price or no clip yet. */
  estimate: number | null;
  /** Running this would pass the month's limit: the panel disables Analyse. */
  over: boolean;
  text: string;
}

/**
 * The line under Analyse. `clipS` is the clip's length (outS − inS) once the clip is known;
 * before that it's a rate per 10 minutes. `monthUsd` is the freshest month total (the last
 * run's, else /health's). Over the limit when the month plus this clip's estimate would
 * pass it, or when the month is already used up.
 */
export function budgetEstimate(ai: AiStatus, clipS: number | null, monthUsd: number | null): BudgetEstimate {
  const rate = ai.usd_per_minute;
  const estimate = rate !== null && clipS !== null ? rate * clipS / 60 : null;
  const est = rate === null ? "Est. cost unknown"
    : clipS === null ? `Est. ~${formatUsd(rate * 10)} per 10 min of clip`  // per minute is usually under a cent
    : `Est. ~${formatUsd(estimate)} for this ${clipLength(clipS)} clip`;
  const month = `This month ${monthUsd === null ? "unknown" : formatUsd(monthUsd)} of ${formatUsd(ai.limit_usd)}`;
  const over = rate !== null && monthUsd !== null &&
    (monthUsd + (estimate ?? 0) > ai.limit_usd || monthUsd >= ai.limit_usd);
  return { estimate, over, text: `${over ? "Monthly AI limit reached · " : ""}${est} · ${month}` };
}

/** "This run: $0.03 (Gemini 3.7 Flash · 7.1k in / 4.2k out) · Month: $0.11 of $2.00" */
export function runCostLine(c: RunCost): string {
  return `This run: ${formatUsd(c.usd)} (${c.label || c.model} · ${formatTokens(c.input_tokens)} in / ` +
    `${formatTokens(c.output_tokens)} out) · Month: ${formatUsd(c.month_usd)} of ${formatUsd(c.limit_usd)}`;
}

/** The month's share of the limit, 0–1. A zero limit reads as full. */
export function meterFraction(monthUsd: number, limitUsd: number): number {
  if (limitUsd <= 0) return 1;
  return Math.min(1, Math.max(0, monthUsd / limitUsd));
}

/** The meter turns coral from here. */
export const METER_HOT = 0.8;

/** An instruction run that handed over to a trim: one cost line for both. The month and limit are the trim's (it came last). */
export function addCosts(run: RunCost, trim: RunCost | null | undefined): RunCost {
  if (!trim) return run;
  return {
    model: trim.model,
    label: trim.label,
    provider: trim.provider,
    input_tokens: run.input_tokens + trim.input_tokens,
    output_tokens: run.output_tokens + trim.output_tokens,
    usd: run.usd === null || trim.usd === null ? null : run.usd + trim.usd,
    month_usd: trim.month_usd,
    limit_usd: trim.limit_usd,
  };
}
