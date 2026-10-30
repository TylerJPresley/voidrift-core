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
