/**
 * Managed-layer composition — the loosen-proof rules (core-blueprint.md §13.5).
 *
 * The managed layer is the highest-priority, loosen-proof layer: for a policy or
 * permission key the managed value is the CEILING and a lower layer may only make
 * it STRICTER; for a bounded limit the managed value caps the range a lower layer
 * may set; a managed mode is a FLOOR. A lower layer that tries to LOOSEN a managed
 * key is a VALIDATION ERROR, not a silent override.
 *
 * This is pure: it inspects the managed raw document and a candidate lower-layer
 * document and reports any loosening violation. The ConfigCapability runs it on
 * every set and on load so a bad edit is rejected rather than applied (§13.4).
 */

/** A single loosening violation to report as a validation error (§13.5). */
export interface ManagedViolation {
  key: string;
  message: string;
}

/** Compliance mode ordered strict → weak; a lower index is stricter (§9.6). */
const MODE_STRICTNESS: Record<string, number> = { enforcing: 0, permissive: 1, off: 2 };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The permission-rule decisions ordered strict → permissive. A lower layer may
 * tighten a managed rule (toward `deny`) but never loosen it (toward `allow`).
 */
const DECISION_STRICTNESS: Record<string, number> = { deny: 0, ask: 1, allow: 2 };

/** The semantic key Guardian resolves a rule by (§9.2): tool + pattern. */
function ruleKey(rule: Record<string, unknown>): string {
  const tool = typeof rule["tool"] === "string" ? rule["tool"] : "*";
  const pattern = typeof rule["pattern"] === "string" ? rule["pattern"] : "";
  return `${tool}\u0000${pattern}`;
}

function ruleDecision(rule: Record<string, unknown>): string {
  return typeof rule["decision"] === "string" ? rule["decision"] : "ask";
}

function rulePriority(rule: Record<string, unknown>): number {
  return typeof rule["priority"] === "number" ? rule["priority"] : 0;
}

/** A human-readable tool+pattern label for violation messages. */
function describeRule(rule: Record<string, unknown>): string {
  const tool = typeof rule["tool"] === "string" ? rule["tool"] : "*";
  const pattern = typeof rule["pattern"] === "string" ? rule["pattern"] : undefined;
  return pattern ? `${tool} "${pattern}"` : tool;
}

/**
 * A priority above every lower layer (session 300 is the highest non-managed
 * layer; §9.2). The managed floor re-asserts its deny rules here so no lower
 * rule can outrank them in Guardian's highest-priority-wins resolution.
 */
const MANAGED_FLOOR_PRIORITY = 1_000_000;

/**
 * Validate a candidate lower-layer document against the managed layer. Returns
 * every loosening violation; an empty array means the candidate composes legally
 * under the managed ceiling/floor (§13.5).
 *
 * Enforced keys (§13.5 names mode, policy source, and permission denies as the
 * most-set):
 *  - `compliance.mode` — a floor: a lower layer may not weaken it.
 *  - `permissions.*` — a managed `deny` rule may not be loosened to `ask`/`allow`
 *    by a lower rule for the same tool+pattern.
 */
export function validateManagedComposition(
  managed: Record<string, unknown> | undefined,
  candidate: Record<string, unknown>,
): ManagedViolation[] {
  if (!managed) return [];
  const violations: ManagedViolation[] = [];

  // compliance.mode is a floor.
  const managedCompliance = isRecord(managed["compliance"]) ? managed["compliance"] : undefined;
  const candCompliance = isRecord(candidate["compliance"]) ? candidate["compliance"] : undefined;
  if (managedCompliance && candCompliance && typeof candCompliance["mode"] === "string") {
    const managedMode = typeof managedCompliance["mode"] === "string" ? managedCompliance["mode"] : "off";
    const candMode = candCompliance["mode"];
    const mFloor = MODE_STRICTNESS[managedMode] ?? 2;
    const cVal = MODE_STRICTNESS[candMode] ?? 2;
    if (cVal > mFloor) {
      violations.push({
        key: "compliance.mode",
        message: `managed layer sets compliance.mode="${managedMode}" (a floor); a lower layer cannot weaken it to "${candMode}"`,
      });
    }
  }

  // Managed permission rules may not be loosened by any lower rule that shares
  // the same (tool, pattern) — the semantic key Guardian resolves by (§9.2).
  // A lower rule loosens the managed floor when it is weaker in decision OR
  // when it could outrank the managed rule by priority (highest priority wins),
  // regardless of the config map key it is authored under.
  const managedPerms = isRecord(managed["permissions"]) ? managed["permissions"] : undefined;
  const candPerms = isRecord(candidate["permissions"]) ? candidate["permissions"] : undefined;
  if (managedPerms && candPerms) {
    // Index lower-layer rules by their (tool, pattern) semantic key.
    const candByKey = new Map<string, { id: string; rule: Record<string, unknown> }[]>();
    for (const [cid, cRule] of Object.entries(candPerms)) {
      if (!isRecord(cRule)) continue;
      const key = ruleKey(cRule);
      const bucket = candByKey.get(key);
      if (bucket) bucket.push({ id: cid, rule: cRule });
      else candByKey.set(key, [{ id: cid, rule: cRule }]);
    }
    for (const [id, mRule] of Object.entries(managedPerms)) {
      if (!isRecord(mRule)) continue;
      const mDecision = ruleDecision(mRule);
      const mStrict = DECISION_STRICTNESS[mDecision] ?? 1;
      const mPriority = rulePriority(mRule);
      const lower = candByKey.get(ruleKey(mRule));
      if (!lower) continue;
      for (const { id: cid, rule: cRule } of lower) {
        const cDecision = ruleDecision(cRule);
        const cStrict = DECISION_STRICTNESS[cDecision] ?? 1;
        // Looser decision for the same (tool, pattern) → loosening.
        if (cStrict > mStrict) {
          violations.push({
            key: `permissions.${cid}`,
            message: `managed layer sets permissions.${id}="${mDecision}" for ${describeRule(mRule)} (a ceiling); a lower layer cannot loosen it to "${cDecision}"`,
          });
          continue;
        }
        // A looser-or-equal-decision rule that could OUTRANK the managed rule by
        // priority also loosens the floor: Guardian picks the highest-priority
        // match, so a higher-priority non-deny rule overrides a managed deny.
        if (cStrict > 0 && rulePriority(cRule) >= mPriority) {
          violations.push({
            key: `permissions.${cid}`,
            message: `managed layer denies ${describeRule(mRule)} (permissions.${id}); a lower layer cannot add a higher-priority "${cDecision}" rule for the same tool and pattern`,
          });
        }
      }
    }
  }

  return violations;
}

/**
 * Apply the managed floor/ceiling to an already-merged document (§13.5). The
 * normal cascade lets the narrowest layer win; this pass re-asserts the managed
 * layer only where it is STRICTER, so a lower layer can tighten but never loosen:
 *  - `compliance.mode` — the managed mode is a floor; the stricter of managed and
 *    merged wins.
 *  - `permissions.*` — a managed `deny` is re-asserted when a lower rule loosened
 *    it (the `set` guard rejects such edits, but a predating document is corrected
 *    here so the floor always holds).
 */
export function applyManagedFloor(
  managed: Record<string, unknown> | undefined,
  merged: Record<string, unknown>,
): Record<string, unknown> {
  if (!managed) return merged;
  const out: Record<string, unknown> = { ...merged };

  const managedCompliance = isRecord(managed["compliance"]) ? managed["compliance"] : undefined;
  if (managedCompliance && typeof managedCompliance["mode"] === "string") {
    const mergedCompliance = isRecord(out["compliance"]) ? out["compliance"] : {};
    const mergedMode = typeof mergedCompliance["mode"] === "string" ? mergedCompliance["mode"] : "off";
    const managedMode = managedCompliance["mode"];
    const strict =
      (MODE_STRICTNESS[mergedMode] ?? 2) <= (MODE_STRICTNESS[managedMode] ?? 2) ? mergedMode : managedMode;
    out["compliance"] = { ...managedCompliance, ...mergedCompliance, mode: strict };
  }

  const managedPerms = isRecord(managed["permissions"]) ? managed["permissions"] : undefined;
  if (managedPerms) {
    const mergedPerms = isRecord(out["permissions"]) ? { ...out["permissions"] } : {};
    for (const [id, mRule] of Object.entries(managedPerms)) {
      if (!isRecord(mRule)) continue;
      const mDecision = ruleDecision(mRule);
      const mStrict = DECISION_STRICTNESS[mDecision] ?? 1;
      const mKey = ruleKey(mRule);

      // A managed deny is a hard floor: re-assert it at a priority no lower
      // layer can exceed so Guardian's highest-priority-wins resolution can
      // never let a differently-keyed, higher-priority lower rule override it.
      if (mDecision === "deny") {
        mergedPerms[id] = { ...mRule, priority: MANAGED_FLOOR_PRIORITY };
        continue;
      }

      // For a non-deny managed rule, re-assert it only where a same-key lower
      // rule loosened the decision; a stricter lower rule may still tighten.
      const cRule = mergedPerms[id];
      if (isRecord(cRule) && ruleKey(cRule) === mKey && typeof cRule["decision"] === "string") {
        const cStrict = DECISION_STRICTNESS[cRule["decision"]] ?? 1;
        if (cStrict > mStrict) mergedPerms[id] = mRule;
      } else if (!isRecord(cRule)) {
        mergedPerms[id] = mRule;
      }
    }
    out["permissions"] = mergedPerms;
  }

  return out;
}
