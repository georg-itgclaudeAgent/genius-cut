import { describe, it, expect } from "vitest";
import { budgetEstimate, formatTokens, formatUsd, meterFraction, modelLabel, runCostLine } from "./cost";
import type { AiStatus, RunCost } from "../api/types";

const AI: AiStatus = { provider: "gemini", model: "gemini-3.7-flash", month_usd: 0.08, limit_usd: 2, usd_per_minute: 0.003 };

describe("formatUsd", () => {
  it("shows two decimals from one cent up", () => {
    expect(formatUsd(0.03)).toBe("$0.03");
    expect(formatUsd(1.25)).toBe("$1.25");
    expect(formatUsd(0.034)).toBe("$0.03");
    expect(formatUsd(2)).toBe("$2.00");
  });
  it("shows anything under a cent as <$0.01", () => {
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0.0099)).toBe("<$0.01");
  });
  it("shows nothing spent as $0.00", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });
  it("shows a missing price as cost unknown", () => {
    expect(formatUsd(null)).toBe("cost unknown");
    expect(formatUsd(undefined)).toBe("cost unknown");
  });
});

describe("labels", () => {
  it("names models the way people say them", () => {
    expect(modelLabel("gemini-3.7-flash")).toBe("Gemini 3.7 Flash");
    expect(modelLabel("gemini-2.5-flash-lite")).toBe("Gemini 2.5 Flash Lite");
    expect(modelLabel("claude-opus-5-5")).toBe("Claude Opus 5.5");
  });
  it("shortens token counts", () => {
    expect(formatTokens(850)).toBe("850");
    expect(formatTokens(7100)).toBe("7.1k");
    expect(formatTokens(4249)).toBe("4.2k");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });
});

describe("budgetEstimate", () => {
  it("prices the clip from the per-minute rate and its length", () => {
    const b = budgetEstimate(AI, 647, 0.08);  // 10:47
    expect(b.estimate).toBeCloseTo(0.003 * 647 / 60);
    expect(b.text).toBe("Est. ~$0.03 for this 10:47 clip · This month $0.08 of $2.00");
    expect(b.over).toBe(false);
  });
  it("gives a rate per 10 minutes before a clip is known", () => {
    expect(budgetEstimate({ ...AI, usd_per_minute: 0.0071 }, null, 0.08).text)
      .toBe("Est. ~$0.07 per 10 min of clip · This month $0.08 of $2.00");
  });
  it("is over the limit when the month plus the estimate would pass it", () => {
    const b = budgetEstimate(AI, 600, 1.99);  // + $0.03
    expect(b.over).toBe(true);
    expect(b.text).toBe("Monthly AI limit reached · Est. ~$0.03 for this 10:00 clip · This month $1.99 of $2.00");
  });
  it("is over the limit when the month is already used up, even before a clip is known", () => {
    expect(budgetEstimate(AI, null, 2).over).toBe(true);
    expect(budgetEstimate(AI, null, 1.5).over).toBe(false);
  });
  it("can't price an unpriced model, and never blocks on one", () => {
    const b = budgetEstimate({ ...AI, provider: "anthropic", model: "claude-opus-5-5", usd_per_minute: null }, 600, 0);
    expect(b.text).toBe("Est. cost unknown · This month $0.00 of $2.00");
    expect(b.over).toBe(false);
  });
  it("says so when the month's spend couldn't be read", () => {
    const b = budgetEstimate({ ...AI, month_usd: null }, 60, null);
    expect(b.text).toBe("Est. ~<$0.01 for this 1:00 clip · This month unknown of $2.00");
    expect(b.over).toBe(false);
  });
});

describe("run cost", () => {
  const cost: RunCost = { model: "gemini-3.7-flash", input_tokens: 7100, output_tokens: 4200, usd: 0.03, month_usd: 0.11, limit_usd: 2 };
  it("reads like a receipt", () => {
    expect(runCostLine(cost)).toBe("This run: $0.03 (Gemini 3.7 Flash · 7.1k in / 4.2k out) · Month: $0.11 of $2.00");
  });
  it("says cost unknown for an unpriced model", () => {
    expect(runCostLine({ ...cost, model: "claude-opus-5-5", usd: null }))
      .toBe("This run: cost unknown (Claude Opus 5.5 · 7.1k in / 4.2k out) · Month: $0.11 of $2.00");
  });
  it("meters the month against the limit, clamped", () => {
    expect(meterFraction(0.5, 2)).toBe(0.25);
    expect(meterFraction(3, 2)).toBe(1);
    expect(meterFraction(0, 0)).toBe(1);
    expect(meterFraction(-1, 2)).toBe(0);
  });
});
