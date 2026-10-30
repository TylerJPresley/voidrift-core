/**
 * tool-round entity tests (core-blueprint.md §3.3, §3.6) — the derived recursion
 * ceiling, the 80% note, the generated limit summary, and the counter.
 */
import { describe, it, expect } from "vitest";
import {
  deriveRecursionLimit,
  workerRecursionLimit,
  roundBudgetNote,
  limitNotice,
  limitSummary,
  ToolRoundCounter,
} from "./tool-round.js";

describe("tool-round derivations (§3.6)", () => {
  it("derives the recursion ceiling as 2*rounds+5", () => {
    expect(deriveRecursionLimit(15)).toBe(35);
    expect(deriveRecursionLimit(10)).toBe(25);
  });
  it("workerRecursionLimit derives from turnMaxToolRounds when unset (§7.2, §3.6)", () => {
    // Unset override → derived with the same margin as the orchestrator.
    expect(workerRecursionLimit(15, undefined)).toBe(35);
    expect(workerRecursionLimit(10, undefined)).toBe(25);
  });
  it("workerRecursionLimit uses the explicit override when set", () => {
    expect(workerRecursionLimit(15, 50)).toBe(50);
  });
  it("workerRecursionLimit maps a non-positive derived ceiling to a large finite one", () => {
    expect(workerRecursionLimit(0, undefined, 0, 0)).toBe(1_000_000);
  });
  it("limitNotice is the pinned CLI wording", () => {
    expect(limitNotice(15)).toBe("Step limit reached (15). Say continue to resume.");
  });
  it("limitSummary names the limit, rounds used, and tools", () => {
    const s = limitSummary(15, 15, ["read_file", "read_file", "search_contents"]);
    expect(s).toContain("15 of 15 rounds");
    expect(s).toContain("read_file");
    expect(s).toContain("search_contents");
  });
});

describe("ToolRoundCounter (§3.3)", () => {
  it("queues the 80% note once, then ends at the limit with a carried result", () => {
    const c = new ToolRoundCounter(() => 10);
    // rounds 1..7: no note, not at limit.
    for (let i = 0; i < 7; i++) {
      expect(c.recordRound().atLimit).toBe(false);
    }
    expect(c.takeNote()).toBeNull();
    // round 8 = 80% of 10 → note queued once.
    expect(c.recordRound().atLimit).toBe(false);
    expect(c.takeNote()).toBe(roundBudgetNote(8, 10));
    expect(c.takeNote()).toBeNull(); // once only
    // rounds 9, 10: the 10th reaches the limit.
    expect(c.recordRound().atLimit).toBe(false);
    expect(c.recordRound().atLimit).toBe(true);
    expect(c.atLimit).toBe(true);
  });
  it("resets per turn", () => {
    const c = new ToolRoundCounter(() => 3);
    c.recordRound();
    c.recordRound();
    c.recordRound();
    expect(c.atLimit).toBe(true);
    c.reset();
    expect(c.count).toBe(0);
    expect(c.atLimit).toBe(false);
  });
});
