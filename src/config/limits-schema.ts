/**
 * The `limits` config section schema (core-blueprint.md §13.11), generated from
 * the registry (`entities/limits.ts`) so the config schema and the registry can
 * never drift. Nested by area (`{ context: { summaryBudgetFloor: 2000 } }`).
 *
 * Validation mirrors the registry row: each leaf is a bare number within
 * `[min, max]` (using the registry's default action) or an object
 * `{ value: <number>, action: "warn" | "deny" }` (overriding the action).
 * An UNKNOWN area or leaf is a validation error naming the offending key (both
 * the area object and the top-level `limits` object are strict). Every leaf is
 * optional and the whole section defaults to `{}`, so adding the section changes
 * nothing.
 */
import { z } from "zod";
import { LIMITS } from "../entities/limits.js";

function buildLimitsSchema(): z.ZodType {
  const byArea = new Map<string, Record<string, z.ZodType>>();
  for (const spec of LIMITS) {
    const name = spec.key.slice(spec.area.length + 1);
    let valueSchema = z.number();
    if (spec.unit !== "ratio") valueSchema = valueSchema.int();
    valueSchema = valueSchema.min(spec.min, `limits.${spec.key} must be >= ${spec.min}`).max(spec.max, `limits.${spec.key} must be <= ${spec.max}`);
    
    // Accept either bare number or { value, action } object
    const leaf = z.union([
      valueSchema,
      z.object({
        value: valueSchema,
        action: z.enum(["warn", "deny"]),
      }),
    ]);
    
    const group = byArea.get(spec.area) ?? {};
    group[name] = leaf.optional();
    byArea.set(spec.area, group);
  }
  const shape: Record<string, z.ZodType> = {};
  for (const [area, group] of byArea) {
    shape[area] = z.object(group).strict().optional();
  }
  return z.object(shape).strict();
}

/** The validated `limits` section schema, defaulting to `{}`. */
export const LimitsSchema = buildLimitsSchema().default({});
