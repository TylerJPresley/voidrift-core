/**
 * Versioned config-key migration (core-blueprint.md §13.1).
 *
 * Loading runs this step so a config written for an OLDER VoidRift keeps working
 * instead of silently losing a value: each RETIRED key name is mapped to its
 * current name IN MEMORY during the cascade (the on-disk file is not rewritten
 * unless the user runs `voidrift init --migrate`, §13.9.1). An UNKNOWN key that
 * is NOT a known retired name is left untouched, so the schema still rejects it
 * as a validation error (§13.2) — migration maps only the named retired set and
 * never suppresses an unrecognized key.
 *
 * Conflict rule (§13.1): when BOTH the retired key and its current key are
 * present, the CURRENT key's value wins (the retired one is dropped) and the
 * migration is flagged `conflict: true` so the caller can warn.
 *
 * The retired→current map is fixed in code. It is drawn from every retired
 * loader key found in the prior implementations (the `_bak`/`_old` loaders):
 *   modelPrimary     → modelSelected   (the active model)
 *   modelTierFlash   → modelSelected   (older tier name for the active model)
 *   modelBackground  → modelUtility    (the internal/utility model)
 *   modelTierUtility → modelUtility    (older tier name for the utility model)
 * The old escalation tier (`modelTierDense`/`modelEscalation`) has NO current
 * equivalent — VoidRift has no model escalation or failover (owner decision
 * 2026-10-18) — so it is deliberately NOT in the table: a config naming it still
 * fails as an unknown key, which is the correct signal that the feature is gone.
 */

/** The fixed retired→current key map (§13.1). */
export const RETIRED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  modelPrimary: "modelSelected",
  modelTierFlash: "modelSelected",
  modelBackground: "modelUtility",
  modelTierUtility: "modelUtility",
});

/** One applied (or conflicting) key migration, for a warning/report (§13.1). */
export interface KeyMigration {
  /** The retired key found in the layer document. */
  from: string;
  /** Its current name. */
  to: string;
  /** True when the current key was ALSO present — the current value won and the
   * retired one was dropped (the caller surfaces a warning). */
  conflict: boolean;
}

/**
 * Apply the retired→current migration to ONE raw layer document (§13.1). Returns
 * a FRESH document (never mutates the input) with each retired key renamed to
 * its current name, and the list of migrations applied. When both a retired key
 * and its current key are present the current value is kept (conflict). A
 * document with no retired key is returned as a shallow copy with an empty list.
 */
export function migrateRetiredKeys(doc: Record<string, unknown>): {
  doc: Record<string, unknown>;
  migrations: KeyMigration[];
} {
  const migrations: KeyMigration[] = [];
  const out: Record<string, unknown> = { ...doc };
  for (const [from, to] of Object.entries(RETIRED_KEYS)) {
    if (!(from in out)) continue;
    const retiredValue = out[from];
    delete out[from];
    const conflict = to in out && out[to] !== undefined;
    // §13.1 — the CURRENT key wins on conflict; otherwise carry the value over.
    if (!conflict) out[to] = retiredValue;
    migrations.push({ from, to, conflict });
  }
  return { doc: out, migrations };
}
