/**
 * Budget math (core-blueprint.md §4.8) — working budget, triggers, occupancy,
 * token-count order of preference, and the summary budget.
 */
import { describe, it, expect } from "vitest";
import {
  computeBudget,
  headWarnTokens,
  occupancyPct,
  preflightEstimate,
  resolveUsedTokens,
  summaryBudgetTokens,
  estimateTokens,
  clampRatio,
  measureRatio,
  RATIO_MIN,
  RATIO_MAX,
} from "./budget.js";

describe("budget math (§4.8)", () => {
  it("computes the worked example: 16k window, full head, 2k output reservation", () => {
    // Given the §4.8 worked example — the head is measured whole (no cap, §4.2.1)
    const window = 16_000;
    const headTokens = 1600; // a 1.6k head, subtracted whole from the working budget
    // When the budget is computed
    const frame = computeBudget({
      window,
      headTokens,
      outputReservation: 2000,
      percents: { activeBudgetPct: 20, compactionPct: 40, safetyNetPct: 80, headWarnPct: 20, noticePcts: [] },
    });
    // Then working budget = 16k − 1.6k − 2k = 12.4k, active 2.48k, compaction 4.96k, safety 9.92k
    expect(frame.workingBudget).toBe(12_400);
    expect(frame.activeChainTokens).toBe(2480);
    expect(frame.compactionTriggerTokens).toBe(4960);
    expect(frame.safetyNetTriggerTokens).toBe(9920);
  });

  it("the head WARNING threshold is a share of the window (§4.2.1, not a cap)", () => {
    // 20% of a 16k window = 3.2k; the fixed context crossing this fires the head
    // warning but never shortens the head.
    expect(headWarnTokens(16_000, 20)).toBe(3200);
    expect(headWarnTokens(1_000_000, 20)).toBe(200_000);
  });

  it("fresh session reads 0% occupancy", () => {
    expect(occupancyPct(0, 12_400)).toBe(0);
  });

  it("takes tokens in order: provider → anchor → estimate", () => {
    expect(resolveUsedTokens({ providerMaxInput: 100, persistedAnchor: 50, estimate: 10 })).toBe(100);
    expect(resolveUsedTokens({ persistedAnchor: 50, estimate: 10 })).toBe(50);
    expect(resolveUsedTokens({ estimate: 10 })).toBe(10);
    // zero/absent provider falls through
    expect(resolveUsedTokens({ providerMaxInput: 0, estimate: 10 })).toBe(10);
  });

  it("pre-flight estimate is 4 chars/token plus a 2000 margin", () => {
    const est = preflightEstimate({ systemText: "a".repeat(400), toolSchemaText: "", chainText: "", newMessage: "" });
    expect(est).toBe(100 + 2000);
    expect(estimateTokens("a".repeat(8))).toBe(2);
  });

  it("summary budget: 20% of folded, floor 2000, ceiling max(floor, min(5% window, 12000))", () => {
    // small fold → floor
    expect(summaryBudgetTokens(1000, 100_000)).toBe(2000);
    // large fold, window 100k → 5% = 5000 ceiling
    expect(summaryBudgetTokens(1_000_000, 100_000)).toBe(5000);
    // 20% of folded between floor and ceiling
    expect(summaryBudgetTokens(20_000, 400_000)).toBe(4000);
  });
});

describe("measured chars/token ratio (§4.8)", () => {
  it("clamps to the internal [1.5, 8] band; a non-positive value falls back to 4", () => {
    expect(clampRatio(4)).toBe(4);
    expect(clampRatio(1)).toBe(RATIO_MIN);
    expect(clampRatio(20)).toBe(RATIO_MAX);
    expect(clampRatio(0)).toBe(4);
    expect(clampRatio(-3)).toBe(4);
    expect(clampRatio(Number.NaN)).toBe(4);
  });

  it("measures request chars / input_tokens, clamped; absent when no usage reported", () => {
    // 1000 chars / 250 tokens = 4.0
    expect(measureRatio(1000, 250)).toBe(4);
    // a near-zero input_tokens would blow up → clamped to the ceiling
    expect(measureRatio(1000, 10)).toBe(RATIO_MAX);
    // a huge input_tokens (cache discount) → clamped to the floor
    expect(measureRatio(1000, 5000)).toBe(RATIO_MIN);
    // no usage reported leaves the ratio unchanged (undefined)
    expect(measureRatio(1000, 0)).toBeUndefined();
    expect(measureRatio(0, 250)).toBeUndefined();
  });

  it("a measured ratio changes the next estimate vs the default 4", () => {
    const parts = { systemText: "a".repeat(800), toolSchemaText: "", chainText: "", newMessage: "" };
    // default 4 → 800/4 = 200 (+0 margin)
    expect(preflightEstimate(parts, 0)).toBe(200);
    // a measured ratio of 2 → 800/2 = 400: a denser model reads MORE tokens
    expect(preflightEstimate(parts, 0, 2)).toBe(400);
    // estimateTokens threads the ratio too
    expect(estimateTokens("a".repeat(8), 2)).toBe(4);
  });
});
