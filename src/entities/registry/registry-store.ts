/**
 * The namespaced registry (core-blueprint.md §12.5).
 *
 * A typed key-value store. Every key a plugin writes is namespaced to its plugin
 * id by the scoped CoreAPI, so two plugins never collide and a plugin's entries
 * are removed wholesale on disable. `query` matches by key prefix within the
 * namespace. The core's structural entries (panels, provider tables) live under
 * reserved core namespaces a plugin cannot write.
 */

/** The reserved namespace prefix the core writes under; a plugin cannot (§12.5). */
export const CORE_NAMESPACE = "core";

/**
 * The reserved registry-key prefix panel declarations live under (§12.5,
 * panels-blueprint §3). `register.panel("sessions", def)` stores the
 * declaration at the core-namespace key `panels.sessions`, readable by a client
 * at `registry.get("panels.sessions")`. A plugin cannot `registry.set` a
 * `panels.*` key directly — only `register.panel` writes one, which the core
 * routes under the reserved core namespace. The single source of truth.
 */
export const PANELS_KEY_PREFIX = "panels.";

/**
 * The panel-declaration standard the core defines, validates, stores, and
 * exports (core §12.6, panels §2). It is pure, JSON-serializable DATA — a title,
 * columns, the dotted CoreAPI operation(s) its rows come from, and keyed hotkey
 * actions each naming one dotted CoreAPI operation. The shape and its Zod schema
 * are the ONE definition, in `panel-schema.ts`; a client owns the UI and its own
 * bound view-model (panels §5). Re-exported here so the registry's single owner
 * of the `panels.*` namespace also owns the shape it stores.
 */
export type { PanelColumn, PanelAction, PanelDeclaration } from "./panel-schema.js";
export { panelDeclarationSchema, validatePanelDeclaration } from "./panel-schema.js";

/**
 * The reserved registry-key prefix dataset declarations live under (§12.5,
 * §12.7). `register.dataset("permissions", decl)` stores the declaration at the
 * core-namespace key `datasets.permissions`. A plugin cannot `registry.set` a
 * `datasets.*` key directly — only `register.dataset` writes one, routed under
 * the reserved core namespace (which is never persisted, so the `rows` reader
 * function stays in memory). The single source of truth.
 */
export const DATASETS_KEY_PREFIX = "datasets.";

/** True when a plugin-local registry key targets a reserved space — `panels.*`
 * (§12.5, panels-blueprint §3) or `datasets.*` (§12.5, §12.7). A plugin may not
 * `registry.set` such a key directly; only `register.panel`/`register.dataset`
 * writes one. */
export function isReservedKey(key: string): boolean {
  return key.startsWith(PANELS_KEY_PREFIX) || key.startsWith(DATASETS_KEY_PREFIX);
}

/**
 * The reserved core namespaces a plugin id may neither equal nor collide with
 * (§12.5). A plugin whose id is one of these would operate on the core's
 * structural registry entries (panels, provider tables); it is rejected at
 * discovery, its `register` never called. The single source of truth.
 */
export const RESERVED_NAMESPACES: ReadonlySet<string> = new Set([CORE_NAMESPACE, "unknown"]);

/**
 * True when a plugin id would collide with a reserved core namespace (§12.5).
 * An id collides when it equals a reserved namespace or shares the first
 * NUL-separated namespace segment with one — the segment `qualifyKey` keys on.
 */
export function isReservedNamespace(id: string): boolean {
  const segment = id.split("\u0000")[0] ?? id;
  return RESERVED_NAMESPACES.has(id) || RESERVED_NAMESPACES.has(segment);
}

export interface RegistryEntry {
  key: string;
  value: unknown;
}

/**
 * Build a fully-qualified key from a namespace and a plugin-local key. A plugin
 * id and the reserved `core` namespace both route through here so one storage
 * map holds every entry and prefixes never ambiguously overlap.
 */
export function qualifyKey(namespace: string, key: string): string {
  return `${namespace}\u0000${key}`;
}

import type { RegistryPersistencePort, RegistryLimitInjections } from "./registry-persistence.js";
import { getLimitSpec } from "../limits.js";

/**
 * The namespaced key-value store (§12.5). In-memory by default; given a
 * `RegistryPersistencePort` it becomes DURABLE: a plugin's (non-reserved)
 * namespace is lazily loaded from the backing store on first access, cached in
 * memory, and persisted atomically on every mutation. The public
 * `set/get/query/remove/removeNamespace` API is unchanged — behaviour is
 * identical whether or not a port is present, so the existing in-memory tests
 * keep passing with `new RegistryStore()`.
 *
 * The reserved CORE namespaces (`core`, `unknown` — §12.5) are NEVER persisted:
 * panels and provider tables are re-registered at boot and stay in memory only.
 * Writes are serialized in-process (the port's save is synchronous), so two
 * writes in one process cannot interleave; across processes the atomic rename
 * gives last-writer-wins per file with no corruption.
 */
export class RegistryStore {
  private readonly store = new Map<string, unknown>();
  /** Namespaces whose durable file has been loaded into `store` this process. */
  private readonly loaded = new Set<string>();
  private readonly getLimit: (key: string) => number;
  private readonly getLimitAction: (key: string) => "warn" | "deny";
  private readonly onLimitHit: (key: string, detail: { observed: number; cap: number; action: string }) => void;

  constructor(
    private readonly persistence?: RegistryPersistencePort,
    injections?: RegistryLimitInjections,
  ) {
    this.getLimit = injections?.getLimit ?? ((key: string) => {
      const spec = getLimitSpec(key);
      return spec?.default ?? 64 * 1024; // 64 KiB fallback
    });
    this.getLimitAction = injections?.getLimitAction ?? ((key: string) => {
      const spec = getLimitSpec(key);
      return spec?.action ?? "warn";
    });
    this.onLimitHit = injections?.onLimitHit ?? (() => {});
  }

  /** True when a namespace is persisted (durable mode on, and not reserved). */
  private durable(namespace: string): boolean {
    return this.persistence !== undefined && !isReservedNamespace(namespace);
  }

  /** Lazily hydrate a durable namespace's file into the in-memory map once. */
  private ensureLoaded(namespace: string): void {
    if (!this.durable(namespace) || this.loaded.has(namespace)) return;
    this.loaded.add(namespace);
    const entries = this.persistence!.load(namespace);
    for (const [key, value] of Object.entries(entries)) {
      this.store.set(qualifyKey(namespace, key), value);
    }
  }

  /** Persist a durable namespace's current entries to the backing store. */
  private flush(namespace: string): void {
    if (!this.durable(namespace)) return;
    const nsPrefix = qualifyKey(namespace, "");
    const entries: Record<string, unknown> = {};
    for (const [q, value] of this.store) {
      if (q.startsWith(nsPrefix)) entries[q.slice(nsPrefix.length)] = value;
    }
    this.persistence!.save(namespace, entries);
  }

  /** Set a key within a namespace (§12.5). */
  set(namespace: string, key: string, value: unknown): void {
    this.ensureLoaded(namespace);
    if (this.durable(namespace)) {
      // Per-value cap (§12.5, §13.11): a value over cap serialized is handled
      // by the limit action: warn => stored + emit, deny => refuse
      const size = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
      const cap = this.getLimit("plugins.registryValueMaxBytes");
      const action = this.getLimitAction("plugins.registryValueMaxBytes");
      if (size > cap) {
        if (action === "deny") {
          throw new Error(
            `registry value for "${key}" is ${size} bytes, over the ${cap}-byte per-value cap`,
          );
        }
        // Warn action: emit LIMIT_HIT but store anyway
        this.onLimitHit("plugins.registryValueMaxBytes", {
          observed: size,
          cap,
          action: "warn",
        });
      }
    }
    this.store.set(qualifyKey(namespace, key), value);
    this.flush(namespace);
  }

  /** Get a key within a namespace; null when absent (§12.5). */
  get(namespace: string, key: string): unknown {
    this.ensureLoaded(namespace);
    const q = qualifyKey(namespace, key);
    return this.store.has(q) ? this.store.get(q) : null;
  }

  /** Entries whose local key starts with `prefix`, within the namespace (§12.5). */
  query(namespace: string, prefix: string): RegistryEntry[] {
    this.ensureLoaded(namespace);
    const nsPrefix = qualifyKey(namespace, "");
    const out: RegistryEntry[] = [];
    for (const [q, value] of this.store) {
      if (!q.startsWith(nsPrefix)) continue;
      const local = q.slice(nsPrefix.length);
      if (local.startsWith(prefix)) out.push({ key: local, value });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  /** Remove a key within a namespace (§12.5). */
  remove(namespace: string, key: string): void {
    this.ensureLoaded(namespace);
    this.store.delete(qualifyKey(namespace, key));
    this.flush(namespace);
  }

  /** Remove every key in a namespace — a plugin's entries on disable (§12.5).
   * In durable mode this also removes the plugin's backing file wholesale. */
  removeNamespace(namespace: string): void {
    const nsPrefix = qualifyKey(namespace, "");
    for (const q of [...this.store.keys()]) {
      if (q.startsWith(nsPrefix)) this.store.delete(q);
    }
    this.loaded.delete(namespace);
    if (this.durable(namespace)) this.persistence!.remove(namespace);
  }
}
