/**
 * The Config capability (core-blueprint.md §13).
 *
 * Loads the four-layer cascade (managed → global → project → session), merges
 * deep with the narrower layer winning, validates every layer and the merged
 * result against the single Zod schema, and recovers a layer to its last
 * known-good document on an invalid edit (§13.1–13.4). The managed layer is a
 * seam in this slice: `ManagedStatus` is always `none` (§13.5 is slice 7).
 */
import {
  ConfigSchema,
  SESSION_OVERRIDABLE_KEYS,
  ARRAY_UNION_KEYS,
  type Config,
  type ConfigLayer,
} from "../config/schema.js";
import type { ConfigStore } from "./ports/config-store.js";
import { ConfigReadError } from "./ports/config-store.js";
import { migrateRetiredKeys, type KeyMigration } from "../config/migrate.js";
import type { LimitLayerInput } from "./limits-resolve.js";
import { resolveLimits, effectiveLimit } from "./limits-resolve.js";
import { LIMITS, type LimitUnit, type LimitClass } from "./limits.js";

/** One effective-limit row for `/config` (§13.11). */
export interface LimitView {
  key: string;
  area: string;
  value: number;
  unit: LimitUnit;
  class: LimitClass;
  source: "managed" | "global" | "project" | "session" | "default";
  sourcePath?: string;
  /** §13.11 — true when the key is "default only": read only through the
   * registry default (`noLiveOverride`), so a `limits.<key>` override does NOT
   * change behaviour. The UI marks it so it never claims a live knob. */
  defaultOnly?: boolean;
}
import { NEVER_LIST_IDS, neverListView } from "./never-list.js";
import { validateManagedComposition, applyManagedFloor } from "./managed-composition.js";
import { coreError, ErrorCode, type CoreError, type Result, ok, err } from "./errors.js";

const LAYER_ORDER: ConfigLayer[] = ["managed", "global", "project", "session"];

/** A structured validation outcome (§13.2). */
export interface ValidationResult {
  valid: boolean;
  errors: { key: string; message: string }[];
}

/**
 * A recovered (rejected-and-set-aside) config layer (§13.2–§13.3). Recorded at
 * load so a consumer that subscribes to events AFTER boot — the CLI starts the
 * core, then reads this — can still tell the user why their config did not
 * apply. `path` is the layer file; `rejectedPath` is the `.rejected` sibling the
 * store wrote; `errors` carry key names only (never values).
 */
export interface ConfigRejection {
  layer: ConfigLayer;
  path: string;
  rejectedPath: string;
  errors: { key: string; message: string }[];
}

/**
 * A non-fatal config warning: a layer document loaded fine but a key it set was
 * IGNORED (a project/session `unlock`, §13.5/§13.10). Recorded on every resolve
 * so a late subscriber — the CLI boots the core, then reads this — can surface
 * it; de-duplicated by `layer`+`key`+`path` and recomputed each resolve, so a
 * fixed file clears the warning. `message` names the file path and key only,
 * never a value.
 */
export interface ConfigWarning {
  layer: ConfigLayer;
  path: string;
  key: string;
  message: string;
}

/**
 * One applied versioned key migration (§13.1), recorded at load so a late
 * subscriber (the CLI) and `config.doctor` can report `migrated keys` with the
 * fix `voidrift init --migrate`. Names the retired key, its current name, the
 * layer and file it came from, and whether a conflict (both keys present) was
 * resolved in favour of the current key. Value-free.
 */
export interface ConfigMigration {
  layer: ConfigLayer;
  path: string;
  from: string;
  to: string;
  conflict: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The hostname of a URL (userinfo, port, path stripped) for value-free display,
 * or `undefined` when the value is absent or unparseable. Never returns any
 * credential embedded in the URL. */
function hostOfUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw).hostname;
  } catch {
    return undefined;
  }
}

/** Prototype-pollution guard: keys never copied from an untrusted config layer
 * into a merged object (a layer is JSON.parse'd, so `__proto__` can arrive as an
 * own, enumerable key). */
const DANGEROUS_KEYS: ReadonlySet<string> = new Set<string>(["__proto__", "constructor", "prototype"]);

/** Union two arrays preserving the broad layer's order first, then the new
 * entries of the narrow layer, deduping by structural equality (§13.1). Scalars
 * dedupe by value; object/array elements dedupe by their JSON shape so a
 * repeated rule or directory is not listed twice. */
function unionArrays(base: unknown[], over: unknown[]): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  const push = (el: unknown): void => {
    // Prototype-pollution guard: never admit a bare dangerous-key marker element.
    if (typeof el === "string" && DANGEROUS_KEYS.has(el)) return;
    const key = typeof el === "object" && el !== null ? JSON.stringify(el) : `${typeof el}:${String(el)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(el);
  };
  for (const el of base) push(el);
  for (const el of over) push(el);
  return out;
}

/**
 * Deep-merge raw documents (§13.1). Objects merge by key; scalars replace. An
 * array REPLACES by default (a single layer's own edit is authoritative), but a
 * top-level key named in `arrayUnionKeys` instead UNIONS the two arrays — the
 * broad layer's entries first, then the narrow layer's new entries, deduped —
 * so the resolved allow list / skills / findings dirs are the union of every
 * contributing layer. `arrayUnionKeys` applies at THIS level only (it is never
 * forwarded into the recursive object merge) because every union key is
 * top-level; nested arrays (e.g. a model entry's `contextNoticePcts`) keep
 * replace semantics.
 */
export function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
  arrayUnionKeys?: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    // Prototype-pollution guard: skip `__proto__`/`constructor`/`prototype` from
    // an untrusted (JSON.parse'd) layer so a merge can never walk the prototype.
    if (DANGEROUS_KEYS.has(k)) continue;
    const existing = out[k];
    if (isPlainObject(existing) && isPlainObject(v)) {
      out[k] = deepMerge(existing, v);
    } else if (arrayUnionKeys?.has(k) && Array.isArray(existing) && Array.isArray(v)) {
      out[k] = unionArrays(existing, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const ARRAY_UNION_SET: ReadonlySet<string> = new Set<string>(ARRAY_UNION_KEYS);

/** The layers that may set `unlock` — a safeguard opt-out honored only from the
 * broad layers (§13.5, §13.10). A project/session `unlock` is ignored with a
 * visible warning (it must not let a repo opt itself out of a never-list name). */
const UNLOCK_HONORED_LAYERS: ReadonlySet<ConfigLayer> = new Set<ConfigLayer>(["managed", "global"]);

function toValidationErrors(e: unknown): { key: string; message: string }[] {
  if (e && typeof e === "object" && "issues" in e) {
    const issues = (e as {
      issues: { path: (string | number)[]; message: string; code?: string; keys?: string[] }[];
    }).issues;
    const out: { key: string; message: string }[] = [];
    for (const i of issues) {
      // A `.strict()` object reports unknown top-level keys as a single
      // `unrecognized_keys` issue whose `keys` names them and whose `path` is
      // empty; expand it so each offending KEY is named (never its value).
      if (i.code === "unrecognized_keys" && Array.isArray(i.keys) && i.keys.length > 0) {
        for (const k of i.keys) out.push({ key: k, message: `unrecognized key "${k}"` });
      } else {
        out.push({ key: i.path.join(".") || "(root)", message: i.message });
      }
    }
    return out;
  }
  return [{ key: "(root)", message: String(e) }];
}

export class ConfigCapability {
  private rawLayers: Partial<Record<ConfigLayer, Record<string, unknown>>> = {};
  private lastGood: Partial<Record<ConfigLayer, Record<string, unknown>>> = {};
  private resolved: Config;
  private overlay: Record<string, unknown> | undefined;
  /** Layers rejected during load, kept so a late subscriber can still report
   * why a config did not apply (§13.2–§13.3). Cleared each load; a successful
   * `recover`/`set` of a layer removes its entry. */
  private rejections: ConfigRejection[] = [];
  /** Non-fatal warnings (ignored project/session `unlock`, §13.5/§13.10)
   * recomputed on every `reresolve`, so a fixed file clears them. Deduped by
   * layer+key+path. Exposed read-only via `configWarnings()` for a late
   * subscriber (the CLI) to surface at startup. */
  private warnings: ConfigWarning[] = [];

  /** Applied versioned key migrations (§13.1), recorded each load so a late
   * subscriber and `doctor` can report `migrated keys`. Reset at the start of
   * every `load`. */
  private migrations: ConfigMigration[] = [];

  constructor(
    private readonly store: ConfigStore,
    private readonly emit: (type: string, payload: unknown) => void,
  ) {
    // Resolved is populated by load(); seed with schema defaults so a pre-load
    // read is still a valid document.
    this.resolved = ConfigSchema.parse({});
  }

  /**
   * Load every layer from the store and resolve. Invalid layers recover (§13.3).
   *
   * First-run bootstrap (§13.8): when `seed` is supplied and the global layer
   * file does not exist, a minimal valid global document is written first so the
   * core starts against a local server out of the box. An unwritable config dir
   * is a recoverable condition — the seed is held in memory and boot proceeds —
   * never a construction error (§2.1, §13.3).
   *
   * Each layer is validated in isolation on load (§13.2–§13.3): an invalid layer
   * document is set aside as a `.rejected` sibling, `CONFIG_INVALID` is emitted,
   * and that layer is skipped so the known-good layers still resolve — the core
   * never runs on a broken config.
   */
  async load(seed?: Record<string, unknown>): Promise<void> {
    this.rejections = [];
    this.migrations = [];
    // §13.8 — first-run bootstrap of the global layer.
    if (seed) {
      const existing = this.store.pathOf("global");
      if (!existing.exists) {
        const parsed = ConfigSchema.partial().safeParse(seed);
        if (parsed.success) {
          try {
            await this.store.write("global", seed);
          } catch {
            // An unwritable config dir is recoverable (§2.1): keep the seed in
            // memory so the core still starts with the seeded endpoint.
            this.rawLayers["global"] = seed;
            this.lastGood["global"] = seed;
          }
        }
      }
    }
    for (const layer of LAYER_ORDER) {
      let doc: Record<string, unknown> | null;
      try {
        doc = await this.store.read(layer);
      } catch (e) {
        // §13.2–§13.3 — the file EXISTS but could not be loaded (invalid JSON, or
        // an fs error such as EACCES). Treat it EXACTLY like a schema-invalid
        // layer: set the broken content aside as `.rejected` (preserving the
        // user's exact bytes when they were readable), record a rejection so the
        // CLI startup notice reports it, and recover to last-known-good/defaults.
        // Never mistake it for an absent file.
        const readErr = e as ConfigReadError;
        const reason = readErr instanceof ConfigReadError ? readErr.reason : "cannot read config file";
        if (readErr instanceof ConfigReadError && readErr.raw !== undefined) {
          await this.store.rejectRaw(layer, readErr.raw).catch(() => undefined);
        }
        const errors = [{ key: "(root)", message: reason }];
        this.emit("CONFIG_INVALID", { layer, errors });
        const p = this.store.pathOf(layer);
        this.rejections.push({ layer, path: p.path, rejectedPath: p.path + ".rejected", errors });
        const good = this.lastGood[layer];
        if (good) this.rawLayers[layer] = good;
        else delete this.rawLayers[layer];
        continue;
      }
      if (doc) {
        // §13.1 — versioned key migration: map any RETIRED key to its current
        // name IN MEMORY before validation so an old config keeps working. A
        // conflict (both the retired and current key present) keeps the current
        // value and warns. An unknown NON-retired key is left untouched so the
        // schema still rejects it below. Record each applied mapping so a late
        // subscriber (the CLI) and `doctor` can report `migrated keys` (§13.9.2).
        const { doc: migratedDoc, migrations } = migrateRetiredKeys(doc);
        doc = migratedDoc;
        for (const m of migrations) this.recordMigration(layer, m);
        // §13.3 — validate the layer in isolation; set aside an invalid one.
        const parsed = ConfigSchema.partial().safeParse(doc);
        if (parsed.success) {
          this.rawLayers[layer] = doc;
          this.lastGood[layer] = doc;
        } else {
          await this.store.reject(layer, doc).catch(() => undefined);
          const errors = toValidationErrors(parsed.error);
          this.emit("CONFIG_INVALID", { layer, errors });
          const p = this.store.pathOf(layer);
          this.rejections.push({
            layer,
            path: p.path,
            rejectedPath: p.path + ".rejected",
            errors,
          });
          const good = this.lastGood[layer];
          if (good) this.rawLayers[layer] = good;
          else delete this.rawLayers[layer];
        }
      } else if (this.rawLayers[layer] === undefined && this.lastGood[layer] !== undefined) {
        // The seed written in-memory above (unwritable dir) stands as the layer.
        this.rawLayers[layer] = this.lastGood[layer]!;
      }
    }
    this.reresolve();
  }

  /** Merge raw layers and validate the result; populate `resolved`. */
  private reresolve(): void {
    // Recompute warnings from scratch each resolve so a fixed file clears them.
    this.warnings = [];
    let merged: Record<string, unknown> = {};
    for (const layer of LAYER_ORDER) {
      const doc = this.rawLayers[layer];
      if (!doc) continue;
      // §13.5/§13.10 — `unlock` is a safeguard opt-out honored only from the
      // broad (global/managed) layers; a project/session `unlock` is IGNORED
      // (not unioned, not overridden in) with one visible warning that names
      // the file and key. Strip it from the layer document before merging so it
      // never reaches the resolved value or the array union.
      const effective = this.stripIgnoredUnlock(layer, doc);
      merged = deepMerge(merged, effective, ARRAY_UNION_SET);
    }
    // The per-process override overlay composes above the session layer (§13.1).
    // The overlay is a session-scoped per-process layer: its `unlock` is ignored
    // on the same rule as the session layer.
    if (this.overlay) {
      const effective = this.stripIgnoredUnlock("session", this.overlay);
      merged = deepMerge(merged, effective, ARRAY_UNION_SET);
    }
    // §13.5 — the managed layer is loosen-proof: after the normal cascade, apply
    // the managed floor/ceiling so a lower layer can only TIGHTEN a managed key,
    // never loosen it. The `set` guard rejects a loosening edit up front; this
    // keeps the floor correct even for a lower-layer document that predates the
    // managed layer, while still letting a lower layer tighten within it.
    const managedDoc = this.rawLayers["managed"];
    if (managedDoc) merged = applyManagedFloor(managedDoc, merged);
    const parsed = ConfigSchema.safeParse(merged);
    if (parsed.success) {
      this.resolved = parsed.data;
      // §13.10 — an UNKNOWN never-list id in the resolved (honored) `unlock` is a
      // non-fatal validation WARNING naming the id, not an error (owner D1.2):
      // the config still applies; the user is told the id lifts nothing. The
      // resolved `unlock` already reflects the honored (global/managed) layers.
      for (const id of this.resolved.unlock) {
        if (NEVER_LIST_IDS.has(id)) continue;
        const key = "unlock";
        const message = `"unlock" lists an unknown never-list id "${id}"; it lifts nothing — valid ids: ${[...NEVER_LIST_IDS].join(", ")}`;
        const layer: ConfigLayer = "global";
        const { path } = this.store.pathOf(layer);
        if (!this.warnings.some((w) => w.key === key && w.message === message)) {
          this.warnings.push({ layer, path, key, message });
        }
        this.emit("CONFIG_WARNING", { layer, path, key, message });
      }
      // security-audit S3 — a PROJECT/SESSION layer can redirect the `baseUrl`
      // (or set the `apiKeyEnv`) of a model, so the API key named by `apiKeyEnv`
      // is posted — with the whole conversation — to a host a repo config chose.
      // Per owner decision there is NO trust gate, but it must be VISIBLE: emit
      // ONE value-free warning per model whose endpoint (or key env) comes from
      // the project/session layer and that carries an `apiKeyEnv`. Host only
      // (credentials stripped); the env var NAME only, never its value.
      this.warnModelEndpointProvenance();
      // security audit (LOW) — the same visibility for an EXPORTER endpoint set
      // by a project/session layer: masked telemetry is posted to a host a repo
      // config chose. One value-free warning per such exporter.
      this.warnExporterEndpointProvenance();
      // §13.11 — a successful resolve is the signal to re-resolve the runtime
      // limits capability (boot subscribes). Value-free: carries no config data.
      this.emit("CONFIG_RESOLVED", {});
    } else {
      // Keep the last resolved document in force; a bad merge never applies.
      this.emit("CONFIG_INVALID", { layer: "(merged)", errors: toValidationErrors(parsed.error) });
    }
  }

  /**
   * Return the layer document with an IGNORED `unlock` key stripped (§13.5,
   * §13.10). `unlock` is honored only from the global/managed layers; a value
   * set by the project or session layer is dropped — the project config still
   * loads (never a validation error), but one `CONFIG_WARNING` naming the file
   * and key is emitted so the user sees that it had no effect. Emits at most
   * once per `reresolve` per offending layer. Pure for honored layers and for a
   * document with no `unlock`.
   */
  private stripIgnoredUnlock(layer: ConfigLayer, doc: Record<string, unknown>): Record<string, unknown> {
    if (UNLOCK_HONORED_LAYERS.has(layer)) return doc;
    if (!("unlock" in doc)) return doc;
    const { path } = this.store.pathOf(layer);
    const key = "unlock";
    // The session layer (and the per-process override overlay, which strips with
    // layer "session") has no real backing file in production — it is an
    // in-memory set of overrides — so its warning names "the session overrides",
    // never a path that could be mistaken for a file. A project (or any other
    // file-backed) layer names its file so the user can find and fix it.
    const message =
      layer === "session"
        ? `"unlock" in the session overrides is ignored; it is honored only from the global or managed layer`
        : `"unlock" in the ${layer} layer (${path}) is ignored; it is honored only from the global or managed layer`;
    // Retain for a late subscriber (the CLI), deduped by layer+key+path.
    if (!this.warnings.some((w) => w.layer === layer && w.key === key && w.path === path)) {
      this.warnings.push({ layer, path, key, message });
    }
    this.emit("CONFIG_WARNING", { layer, path, key, message });
    const { unlock: _ignored, ...rest } = doc;
    return rest;
  }

  /**
   * Resolve an array-valued config key with per-layer provenance (§13.1, §13.9).
   * Returns the resolved union (the same value `get()` exposes) alongside `from`:
   * for each element, the layers that contributed it, in broad→narrow order, so a
   * future `/access` can print the layer and file of each list ELEMENT. `unlock`
   * reflects the honored-layers-only rule (a project/session `unlock` is absent
   * from `from`). A non-array key returns an empty result.
   */
  resolveWithProvenance(key: string): { value: unknown[]; from: Record<string, ConfigLayer[]> } {
    const union = ARRAY_UNION_SET.has(key);
    const value = Array.isArray((this.resolved as Record<string, unknown>)[key])
      ? ((this.resolved as Record<string, unknown>)[key] as unknown[])
      : [];
    const from: Record<string, ConfigLayer[]> = {};
    const elemKey = (el: unknown): string =>
      typeof el === "object" && el !== null ? JSON.stringify(el) : `${typeof el}:${String(el)}`;
    const layers: ConfigLayer[] = union ? LAYER_ORDER : [...LAYER_ORDER].reverse();
    for (const layer of layers) {
      const doc = this.rawLayers[layer];
      if (!doc) continue;
      const effective = this.hasIgnoredUnlock(layer, key) ? undefined : doc[key];
      if (!Array.isArray(effective)) continue;
      for (const el of effective) {
        const ek = elemKey(el);
        if (!value.some((v) => elemKey(v) === ek)) continue; // not in the resolved value
        const bucket = (from[ek] ??= []);
        if (!bucket.includes(layer)) bucket.push(layer);
        if (!union) break; // scalar-replace key: the narrowest layer alone wins
      }
    }
    return { value, from };
  }

  /** True when `key` is `unlock` and `layer` is one whose `unlock` is ignored. */
  private hasIgnoredUnlock(layer: ConfigLayer, key: string): boolean {
    return key === "unlock" && !UNLOCK_HONORED_LAYERS.has(layer);
  }

  /** Apply a per-process override overlay above the session layer (§13.1, §2.1). */
  setProcessOverlay(overlay: Record<string, unknown>): void {
    this.overlay = overlay;
    this.reresolve();
  }

  /**
   * Install (or clear) the managed layer at runtime and re-resolve (§13.5). The
   * managed document is the highest-priority, loosen-proof layer; passing `null`
   * removes it. The resolver has already validated the document against the
   * schema; this stores it as `lastGood` and re-resolves so the floor/ceiling
   * takes effect immediately.
   */
  installManagedLayer(doc: Record<string, unknown> | null): void {
    if (doc) {
      this.rawLayers["managed"] = doc;
      this.lastGood["managed"] = doc;
    } else {
      delete this.rawLayers["managed"];
      delete this.lastGood["managed"];
    }
    this.reresolve();
  }

  /** The resolved, validated config document. */
  get(): Config {
    return this.resolved;
  }

  /**
   * The per-layer inputs for the limits cascade (§13.11): each present layer's
   * raw `limits` object and the file it came from, broad→narrow. Consumed by
   * `resolveLimits` in boot to build the one runtime `LimitsCapability`, and
   * re-read on `CONFIG_RESOLVED` so a config edit re-resolves the limits. The
   * session overlay (an in-memory per-process layer) contributes as the
   * `session` layer when it carries a `limits` object.
   */
  limitLayers(): LimitLayerInput[] {
    const out: LimitLayerInput[] = [];
    for (const layer of LAYER_ORDER) {
      const doc = layer === "session" ? this.overlay : this.rawLayers[layer];
      const limits = doc?.["limits"];
      const hasLimits = limits && typeof limits === "object" && !Array.isArray(limits);
      // A layer contributes if it has a `limits` object OR a raw doc (which may
      // carry a legacy top-level alias key like `snapshotCount`, §13.11).
      if (hasLimits || (doc && typeof doc === "object")) {
        const { path } = this.store.pathOf(layer);
        out.push({
          layer,
          path,
          ...(hasLimits ? { limits: limits as Record<string, unknown> } : {}),
          ...(doc && typeof doc === "object" ? { doc: doc as Record<string, unknown> } : {}),
        });
      }
    }
    return out;
  }

  /**
   * The effective value of ONE registry limit (§13.11), resolved the same way
   * the runtime `LimitsCapability` does, for a facade/host read that is not on a
   * turn path (e.g. the session-name cap applied by `autoName`). Falls back to
   * the registry default when (defensively) absent. Throws on an unknown key.
   */
  effectiveLimit(key: string): number {
    return effectiveLimit(resolveLimits(this.limitLayers()), key);
  }

  /**
   * The source LAYER a registry limit's effective value came from (§13.11):
   * `"default"` when no layer set it, else the winning layer. Used to tell an
   * EXPLICIT configuration (`memory.projectChars`) apart from the registry
   * default so project-context sizing can fall back to `ingest.fitFraction`.
   * Throws on an unknown key.
   */
  limitSource(key: string): "managed" | "global" | "project" | "session" | "default" {
    const resolved = resolveLimits(this.limitLayers());
    return resolved.values.get(key)?.source ?? "default";
  }

  /**
   * The effective limits for `/config` (§13.11): every registry key with its
   * resolved value, unit, class, and the layer+file it came from, plus the
   * ignored-safety-raise warnings. Numeric only — carries no value a secret
   * could hide in. Built the same way the runtime capability resolves.
   */
  limitsView(): { limits: LimitView[]; warnings: import("./limits-resolve.js").LimitWarning[] } {
    const resolved = resolveLimits(this.limitLayers());
    const limits: LimitView[] = [];
    for (const spec of LIMITS) {
      const r = resolved.values.get(spec.key);
      limits.push({
        key: spec.key,
        area: spec.area,
        value: r?.value ?? spec.default,
        unit: spec.unit,
        class: spec.class,
        source: r?.source ?? "default",
        ...(r?.sourcePath ? { sourcePath: r.sourcePath } : {}),
        ...(typeof spec.noLiveOverride === "string" ? { defaultOnly: true } : {}),
      });
    }
    return { limits, warnings: resolved.warnings };
  }

  /**
   * The layers that were rejected (set aside as `.rejected`) during the last
   * `load`, or recovered since (§13.2–§13.3). A consumer that boots the core and
   * only then subscribes to events uses this to tell the user why their config
   * did not apply. Empty when every layer validated.
   */
  rejectedLayers(): ConfigRejection[] {
    return this.rejections.slice();
  }

  /**
   * Non-fatal config warnings from the last resolve (ignored project/session
   * `unlock`, §13.5/§13.10). Deduped by layer+key+path and recomputed each
   * resolve, so a fixed file clears them. A client reads this at startup to
   * surface why a key had no effect; messages name the file path and key only,
   * never a value. Empty when nothing was ignored.
   */
  configWarnings(): ConfigWarning[] {
    return this.warnings.slice();
  }

  /**
   * Record one applied key migration (§13.1) with its layer and file, and — when
   * the retired key CONFLICTED with its current key (both present) — emit one
   * value-free `CONFIG_WARNING` so the user is told the current key won. Deduped
   * by layer+from so a re-load does not pile up duplicates.
   */
  private recordMigration(layer: ConfigLayer, m: KeyMigration): void {
    const { path } = this.store.pathOf(layer);
    if (!this.migrations.some((x) => x.layer === layer && x.from === m.from)) {
      this.migrations.push({ layer, path, from: m.from, to: m.to, conflict: m.conflict });
    }
    if (m.conflict) {
      const where = layer === "session" ? "the session overrides" : path;
      const key = m.from;
      const message = `retired key "${m.from}" and current key "${m.to}" are both set in ${where}; "${m.to}" wins and "${m.from}" is ignored`;
      if (!this.warnings.some((w) => w.key === key && w.layer === layer && w.path === path)) {
        this.warnings.push({ layer, path, key, message });
      }
      this.emit("CONFIG_WARNING", { layer, path, key, message });
    }
  }

  /**
   * The versioned key migrations applied during the last `load` (§13.1). A
   * consumer (`config.doctor`, the CLI) reads this to report `migrated keys`
   * with the fix `voidrift init --migrate`. Value-free: retired/current key
   * names, layer, and file only. Empty when no retired key was present.
   */
  configMigrations(): ConfigMigration[] {
    return this.migrations.slice();
  }

  /**
   * The narrowest layer whose OWN `models.<name>` document sets `field`, or
   * `undefined` when no layer sets it. Model entries merge by id but their
   * FIELDS merge per key (§13.1), so the layer that contributed `baseUrl` can
   * differ from the one that contributed `apiKeyEnv`; this resolves each field
   * independently. Narrowest-wins (session > project > global > managed) mirrors
   * the cascade. Pure read over the raw layers.
   */
  private modelFieldLayer(name: string, field: string): ConfigLayer | undefined {
    for (const layer of ["session", "project", "global", "managed"] as ConfigLayer[]) {
      const models = this.rawLayers[layer]?.["models"];
      if (!isPlainObject(models)) continue;
      const entry = models[name];
      if (!isPlainObject(entry)) continue;
      if (field in entry && entry[field] !== undefined) return layer;
    }
    return undefined;
  }

  /**
   * The absolute path of the config file whose OWN layer defines `models.<name>`
   * (§13.1), narrowest-wins (session/project > global > managed). `undefined`
   * when no writable layer owns the entry (a model known only to the provider,
   * or defined solely in the session overlay). A pure read over the raw layers;
   * used to name the exact file in the actionable IMAGE_NOT_SUPPORTED message
   * (§3.3). Secret-free — a path, never a value.
   */
  modelEntryFile(name: string): string | undefined {
    const paths = this.paths();
    for (const layer of ["project", "global", "managed"] as ConfigLayer[]) {
      const models = this.rawLayers[layer]?.["models"];
      if (!isPlainObject(models) || !isPlainObject(models[name])) continue;
      return paths[layer]?.path;
    }
    return undefined;
  }

  /**
   * Per-model endpoint provenance (security-audit S3): for each effective model
   * that carries an `apiKeyEnv`, the layer of its `baseUrl` and of its
   * `apiKeyEnv`, the endpoint host (credentials stripped), and whether a
   * project/session layer redirected the endpoint or set the key env. A host
   * reads this for `voidrift access`. Secret-free: host and env-var NAME only.
   */
  modelEndpointProvenance(): Array<{
    name: string;
    host: string | undefined;
    apiKeyEnv: string | undefined;
    baseUrlLayer: ConfigLayer | undefined;
    apiKeyEnvLayer: ConfigLayer | undefined;
    fromProject: boolean;
  }> {
    const out: Array<{
      name: string;
      host: string | undefined;
      apiKeyEnv: string | undefined;
      baseUrlLayer: ConfigLayer | undefined;
      apiKeyEnvLayer: ConfigLayer | undefined;
      fromProject: boolean;
    }> = [];
    const models = this.resolved.models ?? {};
    for (const [name, entry] of Object.entries(models)) {
      const e = entry as { baseUrl?: string; apiKeyEnv?: string };
      const baseUrlLayer = e.baseUrl !== undefined ? this.modelFieldLayer(name, "baseUrl") : undefined;
      const apiKeyEnvLayer = e.apiKeyEnv !== undefined ? this.modelFieldLayer(name, "apiKeyEnv") : undefined;
      const fromProject =
        baseUrlLayer === "project" ||
        baseUrlLayer === "session" ||
        apiKeyEnvLayer === "project" ||
        apiKeyEnvLayer === "session";
      out.push({
        name,
        host: hostOfUrl(e.baseUrl),
        apiKeyEnv: e.apiKeyEnv,
        baseUrlLayer,
        apiKeyEnvLayer,
        fromProject,
      });
    }
    return out;
  }

  /** Emit one value-free warning per model whose endpoint (or key env) is set by
   * a project/session layer AND which carries an `apiKeyEnv` (so a key would be
   * sent there). Recomputed each resolve; deduped by layer+key+path. */
  private warnModelEndpointProvenance(): void {
    for (const p of this.modelEndpointProvenance()) {
      if (!p.fromProject || !p.apiKeyEnv) continue;
      // The layer that redirected the endpoint/key — prefer the one driving the
      // concern (project/session). Name its file so the user can find it.
      const layer: ConfigLayer =
        p.baseUrlLayer === "project" || p.baseUrlLayer === "session"
          ? p.baseUrlLayer
          : (p.apiKeyEnvLayer as ConfigLayer);
      const { path } = this.store.pathOf(layer);
      const host = p.host ?? "the configured endpoint";
      const where = layer === "session" ? "the session overrides" : path;
      const key = `models.${p.name}.endpoint`;
      const message = `model '${p.name}' endpoint ${host} comes from ${where}; the API key in $${p.apiKeyEnv} is sent there`;
      if (!this.warnings.some((w) => w.key === key && w.layer === layer && w.path === path)) {
        this.warnings.push({ layer, path, key, message });
      }
      this.emit("CONFIG_WARNING", { layer, path, key, message });
    }
  }

  /**
   * The narrowest layer whose OWN `plugins.<id>.options.config.<field>` is set,
   * or `undefined` when no layer sets it. Mirrors `modelFieldLayer` for the
   * exporter-endpoint provenance: the exporters read their endpoint from
   * `options.config.endpoint` (otel) or `options.config.host` (langfuse), which
   * merge per key through the cascade; this resolves the field's own layer.
   */
  private pluginConfigFieldLayer(id: string, field: string): ConfigLayer | undefined {
    for (const layer of ["session", "project", "global", "managed"] as ConfigLayer[]) {
      const plugins = this.rawLayers[layer]?.["plugins"];
      if (!isPlainObject(plugins)) continue;
      const entry = plugins[id];
      if (!isPlainObject(entry)) continue;
      const options = entry["options"];
      if (!isPlainObject(options)) continue;
      const config = options["config"];
      if (!isPlainObject(config)) continue;
      if (field in config && config[field] !== undefined) return layer;
    }
    return undefined;
  }

  /**
   * Per-exporter endpoint provenance (security audit, LOW). An exporter ships
   * MASKED telemetry to the endpoint named in `plugins.<id>.options.config` —
   * `endpoint` (otel) or `host` (langfuse). A PROJECT/SESSION layer (an
   * untrusted-repo surface) can redirect that endpoint, so it must be VISIBLE
   * exactly like a model endpoint: host only, no path/userinfo. Returns, per
   * enabled exporter plugin whose endpoint is set, the host, the layer of the
   * endpoint field, and whether a project/session layer set it. Host-free of
   * any credential; `voidrift doctor` reads this too.
   */
  exporterEndpointProvenance(): Array<{
    id: string;
    host: string | undefined;
    endpointLayer: ConfigLayer | undefined;
    fromProject: boolean;
  }> {
    const out: Array<{ id: string; host: string | undefined; endpointLayer: ConfigLayer | undefined; fromProject: boolean }> = [];
    const plugins = this.resolved.plugins ?? {};
    for (const [id, entry] of Object.entries(plugins)) {
      const e = entry as { enabled?: boolean; options?: { config?: { endpoint?: string; host?: string } } };
      if (e.enabled === false) continue;
      const cfg = e.options?.config;
      if (!cfg) continue;
      // `endpoint` (otel) or `host` (langfuse) — whichever the plugin uses.
      const field = cfg.endpoint !== undefined ? "endpoint" : cfg.host !== undefined ? "host" : undefined;
      if (!field) continue;
      const raw = field === "endpoint" ? cfg.endpoint : cfg.host;
      const endpointLayer = this.pluginConfigFieldLayer(id, field);
      const fromProject = endpointLayer === "project" || endpointLayer === "session";
      out.push({ id, host: hostOfUrl(raw), endpointLayer, fromProject });
    }
    return out;
  }

  /** Emit one value-free warning per enabled exporter whose endpoint/host is set
   * by a project/session layer (security audit, LOW). Mirrors the model-endpoint
   * warning: host only, names the file. Recomputed each resolve; deduped. */
  private warnExporterEndpointProvenance(): void {
    for (const p of this.exporterEndpointProvenance()) {
      if (!p.fromProject || !p.endpointLayer) continue;
      const { path } = this.store.pathOf(p.endpointLayer);
      const where = p.endpointLayer === "session" ? "the session overrides" : path;
      const host = p.host ?? "the configured endpoint";
      const key = `plugins.${p.id}.endpoint`;
      const message = `exporter '${p.id}' endpoint ${host} comes from ${where}; masked telemetry is sent there`;
      if (!this.warnings.some((w) => w.key === key && w.layer === p.endpointLayer && w.path === path)) {
        this.warnings.push({ layer: p.endpointLayer, path, key, message });
      }
      this.emit("CONFIG_WARNING", { layer: p.endpointLayer, path, key, message });
    }
  }

  /**
   * The code-level NEVER LIST with each category's lifted state under the
   * resolved (honored) `unlock` (§9.3/§13.10, owner D1.2). Host-readable for the
   * later `/access` and `doctor`; plain-English one-line descriptions. The never
   * list lives in CODE, not config — this is a read-only VIEW of it.
   */
  neverList(): Array<{ id: string; description: string; unlocked: boolean }> {
    return neverListView(this.resolved.unlock);
  }

  /** A single resolved value by top-level key. */
  getKey<K extends keyof Config>(key: K): Config[K] {
    return this.resolved[key];
  }

  /**
   * The raw `plugins` record of each layer, by layer, for load-time provenance
   * (§12.4.1). The resolved document merges all layers and loses which layer
   * declared an entry, but the plugin loader must know whether an enabled entry
   * came from the project layer (untrusted-repo surface) or from the global/
   * managed layer (the user's own machine). Each layer's `plugins` is validated
   * on load, so this reflects only known-good entries.
   */
  pluginLayers(): Record<ConfigLayer, Record<string, unknown>> {
    const out = {} as Record<ConfigLayer, Record<string, unknown>>;
    for (const layer of LAYER_ORDER) {
      const doc = this.rawLayers[layer];
      const plugins = isPlainObject(doc?.["plugins"]) ? (doc!["plugins"] as Record<string, unknown>) : {};
      out[layer] = plugins;
    }
    return out;
  }

  /**
   * The raw `permissions` record of a single layer (§9.2, Slice C3). Used before
   * persisting an approved allow rule to the PROJECT layer so existing entries
   * are merged and never lost or reordered. Reflects only the layer's own,
   * known-good document (not the cascaded union). Empty when the layer sets no
   * permissions.
   */
  layerPermissions(layer: ConfigLayer): Record<string, unknown> {
    const doc = this.rawLayers[layer];
    return isPlainObject(doc?.["permissions"]) ? { ...(doc!["permissions"] as Record<string, unknown>) } : {};
  }

  /**
   * The raw value a single layer's own document declares for a top-level key, or
   * `undefined` when that layer does not set it. Reflects the layer's own
   * known-good document (not the cascaded union). Used by `doctor` to tell
   * whether a model endpoint or the webSearch setting in effect was contributed
   * by the PROJECT layer (an untrusted-repo surface) versus the user's global.
   */
  layerKey(layer: ConfigLayer, key: string): unknown {
    const doc = this.rawLayers[layer];
    return doc ? doc[key] : undefined;
  }

  paths(): Record<ConfigLayer, { path: string; exists: boolean }> {
    return {
      managed: this.store.pathOf("managed"),
      global: this.store.pathOf("global"),
      project: this.store.pathOf("project"),
      session: this.store.pathOf("session"),
    };
  }

  /** Validate a candidate document without writing (§13.4). */
  validate(document: Record<string, unknown>): ValidationResult {
    const parsed = ConfigSchema.safeParse(document);
    if (parsed.success) return { valid: true, errors: [] };
    return { valid: false, errors: toValidationErrors(parsed.error) };
  }

  /**
   * Set a key on a layer: validate, write, re-resolve. Rejects a non-session
   * key on the session layer and a session-only key on a broader layer (§13.7).
   */
  async set(key: string, value: unknown, layer: ConfigLayer): Promise<Result<Config>> {
    const sessionKey = (SESSION_OVERRIDABLE_KEYS as readonly string[]).includes(key);
    if (layer === "session" && !sessionKey) {
      return err(
        coreError(ErrorCode.INVALID_INPUT, `${key} is not session-overridable`, { field: key }),
      );
    }
    if (layer !== "session" && key === "permissions" && value && typeof value === "object") {
      // permissions is allowed at any layer; no-op branch kept for clarity.
    }
    const candidate = deepMerge(this.rawLayers[layer] ?? {}, { [key]: value });
    // Validate the layer document in isolation against the schema's partial shape.
    const parsed = ConfigSchema.partial().safeParse(candidate);
    if (!parsed.success) {
      await this.store.reject(layer, candidate);
      const errors = toValidationErrors(parsed.error);
      this.emit("CONFIG_INVALID", { layer, errors });
      return err(coreError(ErrorCode.CONFIG_INVALID, errors[0]?.message ?? "invalid config", {
        field: key,
        details: errors,
      }));
    }
    // §13.5 — a lower layer may only tighten a managed key, never loosen it.
    // A loosening edit is a validation error, not a silent override.
    if (layer !== "managed") {
      const violations = validateManagedComposition(this.rawLayers["managed"], candidate);
      if (violations.length > 0) {
        await this.store.reject(layer, candidate);
        this.emit("CONFIG_INVALID", { layer, errors: violations });
        return err(
          coreError(ErrorCode.CONFIG_INVALID, violations[0]!.message, {
            field: violations[0]!.key,
            details: violations,
          }),
        );
      }
    }
    this.rawLayers[layer] = candidate;
    this.lastGood[layer] = candidate;
    await this.store.write(layer, candidate);
    this.reresolve();
    this.emit("CONFIG_CHANGED", { key, layer });
    return ok(this.resolved);
  }

  /**
   * Remove a persisted Guardian rule by id from a config layer (§9.2 revoke).
   * The id is the key under that layer's `permissions` map. A MANAGED rule — one
   * whose id lives in the managed layer, or whose `source` is `managed` — can
   * never be revoked by a lower layer (§13.5, the loosen-proof guarantee); the
   * attempt returns a typed error and the rule stays. Validated and recoverable
   * like every other config write (§13).
   */
  async removePermissionRule(id: string, layer: ConfigLayer): Promise<Result<Config>> {
    // The managed layer is loosen-proof: a managed rule is never removable by a
    // lower layer, and the facade never targets the managed layer for a revoke.
    const managedPerms = (this.rawLayers["managed"]?.["permissions"] ?? {}) as Record<string, unknown>;
    if (layer !== "managed" && managedPerms[id] !== undefined) {
      return err(
        coreError(ErrorCode.INVALID_INPUT, `permission rule "${id}" is managed and cannot be revoked`, {
          field: "id",
          details: { layer: "managed" },
        }),
      );
    }
    const layerPerms = (this.rawLayers[layer]?.["permissions"] ?? {}) as Record<string, unknown>;
    const target = layerPerms[id];
    if (target === undefined) {
      return err(coreError(ErrorCode.NOT_FOUND, `no permission rule "${id}" in the ${layer} layer`, { field: "id" }));
    }
    if (isPlainObject(target) && target["source"] === "managed") {
      return err(
        coreError(ErrorCode.INVALID_INPUT, `permission rule "${id}" is managed and cannot be revoked`, { field: "id" }),
      );
    }
    const nextPerms: Record<string, unknown> = { ...layerPerms };
    delete nextPerms[id];
    const candidate = { ...(this.rawLayers[layer] ?? {}), permissions: nextPerms };
    this.rawLayers[layer] = candidate;
    this.lastGood[layer] = candidate;
    await this.store.write(layer, candidate);
    this.reresolve();
    this.emit("CONFIG_CHANGED", { key: "permissions", layer });
    return ok(this.resolved);
  }

  /** Restore a layer to its last known-good document (§13.3). */
  async recover(layer: ConfigLayer): Promise<Result<Config>> {
    this.rejections = this.rejections.filter((r) => r.layer !== layer);
    const good = this.lastGood[layer];
    if (good) {
      this.rawLayers[layer] = good;
      await this.store.write(layer, good);
    } else {
      delete this.rawLayers[layer];
    }
    this.reresolve();
    return ok(this.resolved);
  }

  /** Apply an external (watcher-reported) edit to a layer, validating it (§13.4). */
  applyExternal(layer: ConfigLayer, doc: Record<string, unknown>): CoreError | null {
    const parsed = ConfigSchema.partial().safeParse(doc);
    if (!parsed.success) {
      const errors = toValidationErrors(parsed.error);
      this.emit("CONFIG_INVALID", { layer, errors });
      return coreError(ErrorCode.CONFIG_INVALID, errors[0]?.message ?? "invalid config");
    }
    this.rawLayers[layer] = doc;
    this.lastGood[layer] = doc;
    this.reresolve();
    this.emit("CONFIG_CHANGED", { key: "(layer)", layer });
    return null;
  }
}
