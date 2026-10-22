/**
 * Expectation comparison — entity layer (core-blueprint.md §9.5.1, invariant 27).
 *
 * A caller registers a set of `predicted` write targets for a scope; when the
 * scope closes the core compares them against the scope's ACTUAL write targets
 * read from the mutation journal (§10.11). A target matching no predicted entry
 * is a SURPRISE; a predicted entry never written is not (over-touch is the
 * signal). Matching runs through the shared glob/path matcher (§9.2) so a
 * prediction and a scope grant speak one path language.
 *
 * INVARIANT 27 — STRUCTURAL: this module imports ONLY the shared glob matcher
 * (`./glob-matcher.js`). It imports nothing from Guardian, Warden, the plan-scope
 * grant, or the decision point, and nothing here ever feeds a permission or scope
 * decision — the comparison is for learning only. The import-guard test asserts
 * this against the source.
 */
import { globMatch } from "./glob-matcher.js";

/**
 * Internal, fixed bounds (§9.5.1). NOT configuration — a new config key needs a
 * demonstrated need (AGENTS.md); these are harness invariants that keep a
 * pathological prediction or a huge surprise set from driving the matcher or the
 * emitted event. One object so a consumer reads a single source of truth.
 */
export const EXPECTATION_LIMITS = {
  /** At most this many predicted entries are kept per registration. */
  maxPredicted: 1_000,
  /** At most this many surprise targets are reported in one event. */
  maxSurprises: 100,
  /** A predicted entry or a reported surprise target is clipped to this length. */
  maxEntryLength: 1_024,
} as const;

/** The result of comparing a prediction against a scope's actual targets. */
export interface ExpectationResult {
  /** False when the prediction was empty/absent — no comparison ran (§9.5.1). */
  ran: boolean;
  /** Written targets matching no predicted entry, bounded (§9.5.1). */
  surprises: string[];
  /** The number of actual targets a predicted entry matched. */
  matched: number;
  /** The total number of actual (written) targets compared. */
  totalActual: number;
  /** matched / totalActual, or 1 when nothing was written (§9.5.1). */
  coverage: number;
}

/** Clip an entry to the max length (a defensive bound, never a semantic change). */
function clip(s: string): string {
  return s.length > EXPECTATION_LIMITS.maxEntryLength ? s.slice(0, EXPECTATION_LIMITS.maxEntryLength) : s;
}

/** True when a predicted entry matches an actual target (§9.2, §9.5.1).
 * A path glob (contains `/`) matches through the shared matcher; a non-path
 * (`*`-free) entry matches a non-file target literally or by prefix, and still
 * runs through the shared matcher for the wildcard case so one path language is
 * used. */
function entryMatches(predicted: string, target: string): boolean {
  if (globMatch(predicted, target)) return true;
  // Non-file target by prefix (a mutating MCP/plugin tool or a remote effect
  // whose journal `target` is a namespaced string, e.g. `mcp_github_`): a
  // predicted prefix matches every target that starts with it.
  if (!predicted.includes("*")) return target.startsWith(predicted);
  return false;
}

/**
 * Compare a prediction against a scope's actual write targets (§9.5.1). An empty
 * prediction runs no comparison (`ran: false`). Otherwise every actual target is
 * matched against the predicted entries; unmatched targets are surprises
 * (bounded), and coverage is matched / total (1 when nothing was written).
 */
export function compareExpectation(predicted: string[], actualTargets: string[]): ExpectationResult {
  const preds = predicted.slice(0, EXPECTATION_LIMITS.maxPredicted).map(clip);
  if (preds.length === 0) {
    return { ran: false, surprises: [], matched: 0, totalActual: actualTargets.length, coverage: 1 };
  }
  let matched = 0;
  const surprises: string[] = [];
  for (const target of actualTargets) {
    if (preds.some((p) => entryMatches(p, target))) {
      matched++;
    } else if (surprises.length < EXPECTATION_LIMITS.maxSurprises) {
      surprises.push(clip(target));
    }
  }
  const totalActual = actualTargets.length;
  const coverage = totalActual === 0 ? 1 : matched / totalActual;
  return { ran: true, surprises, matched, totalActual, coverage };
}
