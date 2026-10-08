import type { AiStatus, RunCost } from "../api/types";
import { budgetEstimate, METER_HOT, meterFraction, runCostLine } from "../lib/cost";

/** Under Analyse: what this clip should cost, and the month so far. */
export function CostEstimate({ ai, clipS, monthUsd }: { ai: AiStatus; clipS: number | null; monthUsd: number | null }) {
  const b = budgetEstimate(ai, clipS, monthUsd);
  return <div className={`cost-est${b.over ? " warn" : ""}`} role="status">{b.text}</div>;
}

/** After a run: what it cost, with a slim month-against-limit meter. */
export function RunCostLine({ cost }: { cost: RunCost }) {
  const f = meterFraction(cost.month_usd, cost.limit_usd);
  return (
    <div className="sec cost-run">
      <div className="cost-line">{runCostLine(cost)}</div>
      <div className={`meter${f >= METER_HOT ? " hot" : ""}`} role="meter" aria-label="AI spend this month"
        aria-valuemin={0} aria-valuemax={cost.limit_usd} aria-valuenow={cost.month_usd}>
        <span style={{ width: `${+(f * 100).toFixed(1)}%` }} />
      </div>
    </div>
  );
}
