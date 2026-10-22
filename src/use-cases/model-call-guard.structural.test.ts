/**
 * Structural regression guard — every model call passes the shared §4.10
 * CONTEXT_OVERFLOW guard (invariant 9).
 *
 * The guard mechanism is ONE shared `overflowGuardSpec` middleware bound to every
 * agent (orchestrator, worker, reviewer) plus one direct-invoke guard for the
 * compaction summarizer. A FUTURE unguarded model call is the regression this
 * test catches: it scans the SOURCE for raw model-call shapes
 * (`agent.stream(`, `agent.invoke(`, `chatModel.invoke(`) and asserts every one
 * lives at a KNOWN, guarded site. A new call site that is not allow-listed fails
 * this test, forcing the author to either route it through the guard or
 * explicitly justify it here.
 *
 * Simple and offline: a line scan, an explicit allow-list of the guarded sites.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SRC = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/** The production files that make real model calls (not *.test.ts, not the
 * substrate/* LangGraph-primitive probes which call `graph.invoke` on bare
 * graphs, not VoidRift's model). */
const MODEL_CALL_FILES = ["use-cases/engine.ts", "use-cases/subagents.ts"];

/** Raw model-call shapes the scan flags. */
const CALL_RE = /\b(agent|chatModel|model)\.(invoke|stream)\s*\(/g;

/**
 * Allow-listed guarded sites: the exact receiver.method occurrences that are
 * proven to run behind the shared guard. Each is a model call that EITHER goes
 * through an agent built with `contextOverflowMiddleware`/`overflowMiddleware`
 * (so the guard runs inside `wrapModelCall`), OR is the summarizer's direct
 * invoke which checks `guardInput` inline before calling. Keep this list tight;
 * a NEW entry demands review.
 */
const ALLOWLIST = new Set<string>([
  // engine.ts — the orchestrator turn + confirm resume stream, both built via
  // buildAgent() whose middleware array leads with contextOverflowMiddleware.
  "engine.ts:agent.stream",
  // engine.ts — the compaction summarizer's direct invoke, guarded by an inline
  // guardInput() check that throws ContextOverflowError before this line.
  "engine.ts:chatModel.invoke",
  // subagents.ts — the worker + reviewer invoke, both built via buildWorker()
  // whose middleware array leads with overflowMiddleware.
  "subagents.ts:agent.invoke",
  // engine.ts — the session auto-namer's direct invoke (`suggestSessionName`,
  // §5.5, §11.6). A bounded PASSIVE off-turn call whose input is hard-capped by
  // construction (latest-activity ≤ 2000 chars + current name ≤ 120 chars + a
  // fixed instruction), so it cannot approach any context window and needs no
  // overflow guard; it also carries a 5 s AbortSignal wall. Justified here
  // rather than routed through the per-agent guard because it is not an agent
  // turn and builds no agent/pipeline.
  "engine.ts:model.invoke",
]);

describe("structural regression — every model call is behind the shared §4.10 guard", () => {
  it("flags no raw model-call site outside the allow-listed guarded sites", () => {
    const found = new Set<string>();
    for (const rel of MODEL_CALL_FILES) {
      const source = readFileSync(path.join(SRC, rel), "utf8");
      const base = path.basename(rel);
      for (const m of source.matchAll(CALL_RE)) {
        const receiver = m[1]!;
        const method = m[2]!;
        found.add(`${base}:${receiver}.${method}`);
      }
    }
    const unguarded = [...found].filter((s) => !ALLOWLIST.has(s));
    // A new, unrecognized model-call site must be routed through the shared guard
    // (or justified by adding it to ALLOWLIST with a comment).
    expect(unguarded, `unguarded model-call site(s): ${unguarded.join(", ")}`).toEqual([]);
  });

  it("every allow-listed site is still present in source (list stays honest)", () => {
    const found = new Set<string>();
    for (const rel of MODEL_CALL_FILES) {
      const source = readFileSync(path.join(SRC, rel), "utf8");
      const base = path.basename(rel);
      for (const m of source.matchAll(CALL_RE)) found.add(`${base}:${m[1]}.${m[2]}`);
    }
    for (const entry of ALLOWLIST) {
      expect(found.has(entry), `allow-listed site vanished: ${entry}`).toBe(true);
    }
  });
});
