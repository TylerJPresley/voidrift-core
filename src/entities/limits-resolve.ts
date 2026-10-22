/**
 * Layered resolution of the `limits` config section (core-blueprint.md §13.11).
 *
 * A PURE entity: given each layer's raw `limits` object (nested by area) and the
 * registry, it computes the effective numeric value of every limit, the source
 * layer each came from, and the doctor warnings for a project layer that tried
 * to RAISE a `safety` limit.
 *
 * Rules (§13.11, inventory part c):
 *   - `tunable` — the narrower layer wins (managed → global → project → session),
 *     exactly like any scalar config key.
 *   - `safety` — global/managed may SET it. A PROJECT (or session) value is
 *     honored only if it LOWERS the current effective value; a value that would
 *     RAISE it is IGNORED and recorded as a warning naming key + layer + file.
 *     A managed layer pins a ceiling: once managed sets a safety limit, no lower
 *     layer may exceed it (they may only tighten).
 *   - `integrity` — the inverse of `safety`. global/managed may SET it. A PROJECT
 *     (or session) value is honored only if it RAISES the current effective
 *     value; a value that would LOWER it (weakening an audit/restore guarantee —
 *     e.g. shrinking the journal or disabling rollback) is IGNORED and warned.
 *     A managed layer pins a FLOOR: once managed sets it, no lower layer may go
 *     below. (rollback.snapshotCount = 0 disables rollback — a lowering, so it
 *     is honored only from global/managed, never a project.)
 *   - An absent leaf falls back to the registry default.
 *
 * The cascade order broad→narrow is `managed, global, project, session`. Each
 * entry carries the file path for display (sourced from the config capability).
 */
import { LIMITS, getLimitSpec, type LimitSpec } from "./limits.js";

/** A single layer's contribution: its name, the file it came from, and the raw
 * nested `limits` object it declared (may be `{}` / undefined). `doc` is the
 * layer's full raw config object, used to read a legacy top-level alias key
 * (e.g. `snapshotCount`) when the registry row carries an `alias` and the
 * nested `limits.<area>.<name>` leaf is absent (§13.11 alias resolution). */
export interface LimitLayerInput {
  layer: "managed" | "global" | "project" | "session";
  path?: string;
  limits?: Record<string, unknown>;
  doc?: Record<string, unknown>;
}

/** The resolved value of one limit, with the layer + file it came from. */
export interface ResolvedLimit {
  key: string;
  area: string;
  value: number;
  /** The layer whose value was applied, or `"default"` when none set it. */
  source: "managed" | "global" | "project" | "session" | "default";
  /** The file the applied value came from, when a layer set it. */
  sourcePath?: string;
  /** When the applied value came from a legacy top-level alias key rather than
   * the nested `limits.<key>` leaf, the legacy key name (for a `/config` and
   * doctor source of "<layer> <file> (alias of <legacy key>)"). */
  aliasOf?: string;
}

/** A project/session attempt to RAISE a safety limit, ignored (§13.11). */
export interface LimitWarning {
  key: string;
  layer: "project" | "session";
  path?: string;
  message: string;
}

export interface ResolvedLimits {
  values: Map<string, ResolvedLimit>;
  warnings: LimitWarning[];
}

const ORDER: LimitLayerInput["layer"][] = ["managed", "global", "project", "session"];

/** Read a dotted `area.name` out of a nested `{ area: { name: value } }` object.
 * Returns `undefined` when absent or not a finite number. */
function readLeaf(obj: Record<string, unknown> | undefined, spec: LimitSpec): number | undefined {
  if (!obj) return undefined;
  const area = obj[spec.area];
  if (typeof area !== "object" || area === null) return undefined;
  const name = spec.key.slice(spec.area.length + 1);
  const v = (area as Record<string, unknown>)[name];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Resolve every registry limit across the given layers. Layers are given
 * broad→narrow; absent layers may be omitted. Pure: no I/O.
 */
export function resolveLimits(inputs: LimitLayerInput[]): ResolvedLimits {
  const byLayer = new Map(inputs.map((i) => [i.layer, i]));
  const values = new Map<string, ResolvedLimit>();
  const warnings: LimitWarning[] = [];

  for (const spec of LIMITS) {
    let value = spec.default;
    let source: ResolvedLimit["source"] = "default";
    let sourcePath: string | undefined;
    let aliasOf: string | undefined;
    // managed-set safety ceiling, once managed sets this key.
    let managedCeiling: number | undefined;
    // managed-set integrity floor, once managed sets this key.
    let managedFloor: number | undefined;

    for (const layerName of ORDER) {
      const input = byLayer.get(layerName);
      // The nested `limits.<area>.<name>` leaf wins; else, for an aliased row,
      // the legacy top-level key in the SAME layer's raw doc (§13.11).
      let leaf = readLeaf(input?.limits, spec);
      let fromAlias = false;
      if (leaf === undefined && spec.alias && input?.doc) {
        const legacy = input.doc[spec.alias];
        if (typeof legacy === "number" && Number.isFinite(legacy)) {
          leaf = legacy;
          fromAlias = true;
        }
      }
      if (leaf === undefined) continue;

      if (spec.class === "safety" && (layerName === "project" || layerName === "session")) {
        // Honored only if it LOWERS (never raises) the current effective value,
        // and never above a managed ceiling.
        const raises = leaf > value;
        if (raises) {
          warnings.push({
            key: spec.key,
            layer: layerName,
            ...(input?.path ? { path: input.path } : {}),
            message: `limits.${spec.key} is a safety limit; a ${layerName} layer may only lower it (requested ${leaf}, effective stays ${value})`,
          });
          continue;
        }
      }

      if (spec.class === "integrity" && (layerName === "project" || layerName === "session")) {
        // Honored only if it RAISES (never lowers) the current effective value —
        // a project/session must not weaken an audit/restore guarantee.
        const lowers = leaf < value;
        if (lowers) {
          warnings.push({
            key: spec.key,
            layer: layerName,
            ...(input?.path ? { path: input.path } : {}),
            message: `limits.${spec.key} is an integrity limit; a ${layerName} layer may only raise it (requested ${leaf}, effective stays ${value})`,
          });
          continue;
        }
      }

      value = leaf;
      source = layerName;
      sourcePath = input?.path;
      aliasOf = fromAlias ? spec.alias : undefined;
      if (spec.class === "safety" && layerName === "managed") managedCeiling = leaf;
      if (spec.class === "integrity" && layerName === "managed") managedFloor = leaf;
    }

    // A managed ceiling is a hard cap regardless of order edge cases.
    if (managedCeiling !== undefined && value > managedCeiling) {
      value = managedCeiling;
    }
    // A managed floor is a hard minimum (integrity): a lower layer never goes below.
    if (managedFloor !== undefined && value < managedFloor) {
      value = managedFloor;
    }

    values.set(spec.key, { key: spec.key, area: spec.area, value, source, ...(sourcePath ? { sourcePath } : {}), ...(aliasOf ? { aliasOf } : {}) });
  }

  return { values, warnings };
}

/** The effective value for a key from a resolved set, falling back to the
 * registry default when (defensively) absent. Throws on an unknown key. */
export function effectiveLimit(resolved: ResolvedLimits, key: string): number {
  const r = resolved.values.get(key);
  if (r) return r.value;
  const spec = getLimitSpec(key);
  if (!spec) throw new Error(`unknown limit key: ${key}`);
  return spec.default;
}
