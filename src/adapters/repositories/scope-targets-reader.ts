/**
 * The scope-targets journal reader (core-blueprint.md §9.5.1, §10.11).
 *
 * The expectation seam compares a scope's PREDICTION against the scope's ACTUAL
 * write targets. Those targets are read HERE from the mutation journal — a
 * core-internal store (host/reflection-read only, never the plugin surface, the
 * same stance as the rollback and export journal reads). It lists the session's
 * journal entries and returns the `target`s whose entry `planStep` equals the
 * scope identifier (the same identifier the §9.5 plan-scope grant uses), so a
 * prediction and the journal speak one scope id.
 *
 * Reads are never journaled (only writes are), so no read target can ever appear
 * and a read can never be a surprise. A target is returned once per distinct
 * value (a file written twice in a scope is one target), matching the journal's
 * net-per-target intent.
 */
import type { JournalStore } from "../../entities/ports/journal-store.js";

/**
 * Build a reader that returns a scope's distinct write targets from a session's
 * journal (§9.5.1). `getSessionId` resolves the session whose journal to read at
 * close (the active session). With no journal store or no session, it returns an
 * empty list (the comparison then finds nothing to be surprised by).
 */
export function makeScopeTargetsReader(
  journalStore: JournalStore | undefined,
  getSessionId: () => string,
): (scopeId: string) => Promise<string[]> {
  return async (scopeId: string): Promise<string[]> => {
    const sessionId = getSessionId();
    if (!journalStore || !sessionId) return [];
    let entries;
    try {
      entries = await journalStore.list(sessionId);
    } catch {
      // A journal read failure never fails a scope close — nothing to compare.
      return [];
    }
    const seen = new Set<string>();
    for (const e of entries) {
      if (e.planStep !== scopeId) continue;
      if (typeof e.target === "string" && e.target !== "") seen.add(e.target);
    }
    return [...seen];
  };
}
