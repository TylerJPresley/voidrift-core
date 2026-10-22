/**
 * Expectations capability — use-case layer (core-blueprint.md §9.5.1).
 *
 * A generic, plan-agnostic prediction seam kept APART from the permission seam
 * so it can never influence a decision (invariant 27). A caller registers a set
 * of `predicted` targets against a scope identifier (the same identifier the
 * §9.5 plan-scope grant uses); it is runtime-only, never persisted, and
 * re-registered on resume. `clear(scope)` removes it.
 *
 * At scope CLOSE — the registrant clears the scope because the plan step passed
 * or failed and the loop advanced, or the plan completed/was abandoned — the
 * CORE reads that scope's actual write targets from the mutation journal
 * (`readScopeTargets`, core-internal: the plugin never reads the journal),
 * compares them against `predicted` with the shared matcher, masks any surprise
 * target through the one secret detector (§10.10), and emits ONE
 * `WARNING_EMITTED { category:"surprise", source:"expectation", pattern, count }`
 * per scope close. The coverage ratio is RETURNED to the registrant for
 * rendering. An empty/absent `predicted` registers nothing and runs no
 * comparison. Nothing here feeds a permission, scope, approval, or loop decision.
 */
import type { EventBus } from "../entities/event-bus.js";
import { compareExpectation, type ExpectationResult } from "../entities/expectations.js";
import { maskText } from "./secret-mask.js";
import { stripUnsafeChars } from "../entities/untrusted-text.js";

/**
 * Reads the ACTUAL write targets a scope drove, from the mutation journal
 * (§10.11). Core-internal: the journal is host/reflection-read only and never
 * crosses the plugin surface. The adapter filters the session's journal entries
 * by the scope identifier (the entry's `planStep`) and returns their `target`s.
 */
export type ScopeTargetsReader = (scopeId: string) => Promise<string[]>;

export interface ExpectationsDeps {
  bus: EventBus;
  readScopeTargets: ScopeTargetsReader;
  /** The active session id for event scope; "" when there is none. */
  sessionId: () => string;
}

/** The registrant-facing coverage report handed back at scope close (§9.5.1). */
export interface ExpectationCoverage {
  /** matched actual / total actual (1 when nothing was written). */
  coverage: number;
  /** The number of actual targets a predicted entry matched. */
  matched: number;
  /** The total number of actual (written) targets compared. */
  totalActual: number;
  /** The number of unpredicted (surprise) targets. */
  surprises: number;
}

export class Expectations {
  /** Live registrations: scope identifier → predicted targets. Runtime only,
   * never persisted (§9.5.1). */
  private readonly predictions = new Map<string, string[]>();

  constructor(private readonly deps: ExpectationsDeps) {}

  /**
   * Register a prediction for a scope (§9.5.1). An empty/absent `predicted`
   * registers nothing — no comparison will run at close. A re-register replaces
   * the prior prediction for that scope (resume re-registers from the plan
   * record).
   */
  register(req: { scope: string; predicted: string[] }): void {
    const predicted = Array.isArray(req?.predicted) ? req.predicted.filter((p) => typeof p === "string") : [];
    if (typeof req?.scope !== "string" || req.scope === "" || predicted.length === 0) return;
    this.predictions.set(req.scope, predicted);
  }

  /** Remove a scope's prediction (§9.5.1). A cleared scope runs no comparison. */
  clear(scope: string): void {
    this.predictions.delete(scope);
  }

  /**
   * Close a scope: compare its prediction against the scope's actual journal
   * write targets, emit ONE surprise warning (masked) when any target was
   * unpredicted, and return the coverage report (§9.5.1). Returns null when the
   * scope was never registered or was cleared before close (no comparison runs
   * and the journal is never read). Idempotent: the prediction is removed on
   * close so a second close is a no-op.
   */
  async closeScope(scope: string): Promise<ExpectationCoverage | null> {
    const predicted = this.predictions.get(scope);
    if (!predicted) return null;
    this.predictions.delete(scope);

    const actual = await this.deps.readScopeTargets(scope);
    const result: ExpectationResult = compareExpectation(predicted, actual);
    if (!result.ran) return null;

    if (result.surprises.length > 0) {
      // Mask each surprise target through the ONE shared detector (§10.10) and
      // STRIP terminal-/spoof-dangerous characters (§8.2) before it leaves the
      // process — a journal target is model-/tool-influenced text, so U+202E,
      // ESC/ANSI and BEL must never reach the event, the context, or a note.
      const pattern = result.surprises.map((t) => stripUnsafeChars(maskText(t))).join(", ");
      const session = this.deps.sessionId();
      // §14.6 — every WARNING_EMITTED payload carries a human `message`; the CLI
      // renders a `surprise` as a dim `ℹ` info line, never a `⚠` warning. The
      // message names the unpredicted target(s) (already masked and char-stripped
      // above), no raw secrets.
      const n = result.surprises.length;
      const message = `Unpredicted change${n === 1 ? "" : "s"} to ${pattern} (${n} not in the plan's predicted targets).`;
      this.deps.bus.emit(
        "WARNING_EMITTED",
        { category: "surprise", source: "expectation", pattern, count: result.surprises.length, message },
        session ? { session } : {},
      );
    }

    return {
      coverage: result.coverage,
      matched: result.matched,
      totalActual: result.totalActual,
      surprises: result.surprises.length,
    };
  }
}
