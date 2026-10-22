/**
 * Turn grouping and compaction planning (core-blueprint.md §4.9) — a fold never
 * splits a turn, the leading summary is its own group, the active chain keeps
 * anchors, and the cursor is recovered by marker scan.
 */
import { describe, it, expect } from "vitest";
import {
  groupTurns,
  activeChainStart,
  planCompaction,
  recoverSummaryIndex,
  isSummaryMessage,
  SUMMARY_MARKER,
  type MsgView,
} from "./compaction.js";

function m(role: MsgView["role"], text: string, tokens = text.length): MsgView {
  return {
    role,
    text,
    tokens,
    isSummary: role === "assistant" && text.startsWith(SUMMARY_MARKER),
    isTool: role === "tool",
  };
}

describe("turn grouping (§4.9)", () => {
  it("groups user→next-user as one turn, assistant+tool stay with their user", () => {
    const msgs = [
      m("user", "u1"),
      m("assistant", "a1"),
      m("tool", "t1"),
      m("user", "u2"),
      m("assistant", "a2"),
    ];
    const groups = groupTurns(msgs);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.turn).toBe(1);
    expect(groups[0]!.indices).toEqual([0, 1, 2]);
    expect(groups[1]!.indices).toEqual([3, 4]);
  });

  it("treats a leading summary/system message as its own group ahead of turn 1", () => {
    const msgs = [
      m("assistant", `${SUMMARY_MARKER}\nprior`),
      m("user", "u1"),
      m("assistant", "a1"),
    ];
    const groups = groupTurns(msgs);
    expect(groups[0]!.isLeading).toBe(true);
    expect(groups[0]!.turn).toBe(0);
    expect(groups[1]!.turn).toBe(1);
  });
});

describe("active chain (§4.8)", () => {
  it("keeps the final turn as an anchor regardless of budget", () => {
    const msgs = [
      m("user", "u1", 100),
      m("assistant", "a1", 100),
      m("user", "u2", 100),
      m("assistant", "a2", 100),
    ];
    const groups = groupTurns(msgs);
    // budget 0 → still keep the last turn
    const start = activeChainStart(groups, 0);
    expect(start).toBe(2);
  });

  it("includes earlier turns while they fit the active budget", () => {
    const msgs = [
      m("user", "u1", 50),
      m("assistant", "a1", 50),
      m("user", "u2", 50),
      m("assistant", "a2", 50),
    ];
    const groups = groupTurns(msgs);
    const start = activeChainStart(groups, 1000);
    expect(start).toBe(1); // both turns fit
  });
});

describe("compaction plan (§4.9)", () => {
  it("plans tool-clearing and assistant-folding for turns before the active chain", () => {
    const msgs = [
      m("user", "u1", 100),
      m("assistant", "a1", 100),
      m("tool", "t1", 100),
      m("user", "u2", 100),
      m("assistant", "a2", 100),
    ];
    const plan = planCompaction(msgs, 0); // only final turn active
    expect(plan.empty).toBe(false);
    expect(plan.foldedThroughTurn).toBe(1);
    expect(plan.turnsFolded).toBe(1);
    expect(plan.clearableToolIndices).toEqual([2]);
    expect(plan.foldableAssistantIndices).toEqual([1]);
  });

  it("is a no-op when nothing lies beyond the active chain (idempotent)", () => {
    const msgs = [m("user", "u1", 10), m("assistant", "a1", 10)];
    const plan = planCompaction(msgs, 100_000);
    expect(plan.empty).toBe(true);
    expect(plan.turnsFolded).toBe(0);
  });

  it("never folds user messages (they stay verbatim)", () => {
    const msgs = [
      m("user", "u1", 100),
      m("assistant", "a1", 100),
      m("user", "u2", 100),
      m("assistant", "a2", 100),
    ];
    const plan = planCompaction(msgs, 0);
    // user index 0 is not in the foldable assistant set
    expect(plan.foldableAssistantIndices).not.toContain(0);
  });
});

describe("cursor recovery (§4.9)", () => {
  it("recovers the last summary index by marker scan; -1 when none", () => {
    const msgs = [
      m("assistant", `${SUMMARY_MARKER}\nold`),
      m("user", "u"),
      m("assistant", `${SUMMARY_MARKER}\nnew`),
    ];
    expect(recoverSummaryIndex(msgs)).toBe(2);
    expect(isSummaryMessage(msgs[0]!)).toBe(true);
    expect(recoverSummaryIndex([m("user", "u")])).toBe(-1);
  });
});
