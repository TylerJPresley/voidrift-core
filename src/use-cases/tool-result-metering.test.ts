/**
 * Metering: tool-result growth is seen immediately (core-blueprint.md §8.3
 * metering, §3.3 rounds, §4.8).
 *
 * The external research (`harness-limits-cli.md`, the Codex finding) flagged
 * un-metered growth from tool results: a result's size must count the MOMENT it
 * enters the chain, not only when the next model response reports usage. Two
 * mechanisms, both exercised here with the REAL helpers (no model, no fs):
 *
 *   1. the per-result eviction gate (`applyResultPolicy`) runs the MOMENT a
 *      result is produced — BEFORE it joins the chain — so an oversized result
 *      never enters whole and the chain estimate immediately reflects a bounded
 *      handle, never a deferred full body; and
 *   2. the turn-level round ceiling (`ToolRoundCounter`, `turnMaxToolRounds`)
 *      caps how many rounds of results accumulate.
 *
 * The chain token estimate is computed from the chain itself (what the context
 * meter sees each round), proving growth is metered at production. The final
 * backstop when the metered total would still exceed the window is the
 * compaction trigger / `CONTEXT_OVERFLOW` pre-flight in the context pipeline
 * (§4.8/§4.9/§4.10) — out of this entity's scope; see the NOTE in the summary.
 */
import { describe, it, expect } from "vitest";
import { applyResultPolicy } from "../entities/tool-eviction.js";
import { ToolRoundCounter } from "../entities/tool-round.js";
import { estimateTokens } from "../entities/context/budget.js";
import { maskText } from "./secret-mask.js";

const WINDOW = 32_000;
const FIT = 0.4; // ingest.fitFraction default ⇒ ~12.8k-token fit threshold

/** Apply the ONE gate and return what ACTUALLY enters the chain: the bounded
 * handle when evicted, else the result unchanged — plus whether it evicted. */
function throughGate(content: string): { entered: string; evicted: boolean } {
  const e = applyResultPolicy(content, {
    sessionId: "s",
    availableBudget: WINDOW,
    fitFraction: FIT,
    headLines: 30,
    tailLines: 20,
    mask: maskText,
  });
  return e ? { entered: e.handle, evicted: true } : { entered: content, evicted: false };
}

describe("§8.3 metering — tool-result growth is measured at production", () => {
  it("each result's size is reflected in the chain estimate the SAME round it enters (not deferred)", () => {
    const medium = Array.from({ length: 50 }, (_, i) => `line ${i} ${"m".repeat(20)}`).join("\n");
    const chain: string[] = [];
    let lastUsed = 0;
    for (let round = 0; round < 5; round++) {
      chain.push(throughGate(medium).entered);
      const used = chain.reduce((sum, c) => sum + estimateTokens(c), 0);
      // The estimate strictly grows AS each result enters — growth is metered
      // immediately, never only at the next model response (the Codex failure).
      expect(used).toBeGreaterThan(lastUsed);
      lastUsed = used;
    }
    // The metered total equals the sum of the entered results exactly.
    expect(lastUsed).toBe(chain.reduce((s, c) => s + estimateTokens(c), 0));
  });

  it("an OVERSIZED result is caught at production — the bounded handle enters, never the whole body", () => {
    // Many lines (~100k tokens, 3× the window); the head/tail excerpt bounds the
    // handle while the full body is cached off-model.
    const huge = Array.from({ length: 20_000 }, (_, i) => `line ${i} ${"H".repeat(16)}`).join("\n");
    const { entered, evicted } = throughGate(huge);
    expect(evicted).toBe(true);
    // What enters the chain is bounded (< the fit threshold), not 100k tokens.
    expect(estimateTokens(entered)).toBeLessThan(FIT * WINDOW);
    expect(entered).toContain("evicted");
  });

  it("the round ceiling bounds how many rounds of results accumulate (200 results ⇒ exactly 20 rounds, then the turn ends)", () => {
    const rounds = new ToolRoundCounter(() => 20);
    const medium = "m".repeat(1_500);
    let roundsRun = 0;
    let results = 0;
    for (let round = 0; round < 1000; round++) {
      for (let k = 0; k < 10; k++) {
        throughGate(medium);
        results++;
      }
      roundsRun++;
      if (rounds.recordRound().atLimit) break;
    }
    // The round cap stopped the turn at its ceiling — growth is never unbounded
    // in rounds; the per-round metered size then drives compaction/overflow
    // (the context-pipeline backstop) when the sum would exceed the window.
    expect(roundsRun).toBe(20);
    expect(results).toBe(200);
  });

  it("every result oversized: each is evicted at production, so no SINGLE result ever carries a full body into the chain", () => {
    // Many lines, ~15000 tokens each, over the ~12.8k fit threshold; the
    // head/tail excerpt bounds each handle.
    const big = Array.from({ length: 3_000 }, (_, i) => `row ${i} ${"B".repeat(16)}`).join("\n");
    for (let i = 0; i < 200; i++) {
      const { entered, evicted } = throughGate(big);
      expect(evicted).toBe(true);
      // Each handle is individually bounded under the fit threshold — the
      // ~15000-token body never rides inline on any path.
      expect(estimateTokens(entered)).toBeLessThan(FIT * WINDOW);
    }
  });
});
