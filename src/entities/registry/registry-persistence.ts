/**
 * The durable-registry persistence seam (core-blueprint.md §12.5).
 *
 * The registry is durable: a plugin's entries survive a process exit, so a
 * routine saved or a plan authored in one run is present in the next. The pure
 * `RegistryStore` logic stays unchanged; this port holds the file I/O behind a
 * tiny, synchronous contract so the store can serialize writes in-process and a
 * test can swap an in-memory adapter for the real filesystem one.
 *
 * STAGE 1 (2026-10-27): One JSON file per plugin at
 * `<workspace>/.voidrift/plugins/<name>/registry.json`, where `<name>` is the
 * plugin's SHORT name (its id with the scope and the `plugin-` prefix stripped,
 * lowercased with non-alphanumerics turned to hyphens). The store lives INSIDE
 * the workspace so project-level plugin data travels with the project. Files are
 * `0600`, directories `0700`, and every write is atomic (temp file + `rename`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getLimitSpec } from "../limits.js";

/** The on-disk file schema (§12.5): a versioned envelope of a plugin's keys. */
export interface RegistryFile {
  version: 1;
  entries: Record<string, unknown>;
}

/** The current (only) on-disk schema version. */
export const REGISTRY_FILE_VERSION = 1 as const;

/**
 * Derive the plugin's SHORT name from its id: scope and `plugin-` prefix stripped,
 * lowercased, non-alphanumerics turned to hyphens. Used as the folder name under
 * `.voidrift/plugins/` and to derive the registry file path (§12.5).
 * @voidrift/plugin-plan -> plan
 */
export function pluginShortName(id: string): string {
  // Strip @scope/ prefix
  let name = id.replace(/^@[^/]+\//, "");
  // Strip plugin- prefix
  name = name.replace(/^plugin-/, "");
  // Lowercase and replace non-alphanumerics with hyphens
  name = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  // Collapse repeated hyphens and trim edges
  name = name.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return name;
}

/**
 * Reserved plugin folder names (§12.5, STAGE 1b): a plugin whose short name
 * is one of these is refused at registration to prevent shadowing install
 * artifacts that live directly under `.voidrift/plugins/`. These are the
 * NORMALIZED short names (after lowercasing and replacing non-alphanumerics
 * with hyphens).
 */
const RESERVED_PLUGIN_SHORTNAMES = new Set(["node-modules", "package-json", "package-lock-json"]);

/**
 * True when a plugin's short name is reserved (§12.5, STAGE 1b).
 */
export function isReservedPluginShortName(id: string): boolean {
  return RESERVED_PLUGIN_SHORTNAMES.has(pluginShortName(id));
}

/**
 * The persistence port the durable `RegistryStore` drives. Synchronous to match
 * the `registry.set/get/query/remove` API, which is synchronous by contract. A
 * `load` returns the plugin's entries (an empty object when absent or set aside
 * as malformed/oversized); `save` writes the whole envelope atomically; `remove`
 * deletes the file on plugin disable.
 */
export interface RegistryPersistencePort {
  /** Load one plugin's entries; `{}` when absent, malformed, or over-cap. */
  load(namespace: string): Record<string, unknown>;
  /** Persist one plugin's entries atomically (temp + rename). */
  save(namespace: string, entries: Record<string, unknown>): void;
  /** Remove one plugin's file wholesale (plugin disable). */
  remove(namespace: string): void;
}

/** A warning sink: one line naming a set-aside file (§12.5). */
export type RegistryWarn = (message: string) => void;

/** Callbacks for injected limits enforcement (§12.5, §13.11). */
export interface RegistryLimitInjections {
  /** Get the effective limit value; defaults to registry default if not injected. */
  getLimit?: (key: string) => number;
  /** Get the effective limit action (warn|deny); defaults to registry action if not injected. */
  getLimitAction?: (key: string) => "warn" | "deny";
  /** Emit a LIMIT_HIT event when a limit is exceeded (warn action). */
  onLimitHit?: (key: string, detail: { observed: number; cap: number; action: string }) => void;
}

/**
 * The real filesystem adapter (§12.5, STAGE 1). Writes inside the workspace at
 * `.voidrift/plugins/<short-name>/registry.json`; dirs `0700`, files `0600`,
 * atomic temp+rename. A malformed, wrong-version, non-object, or over-cap file
 * is set aside byte-for-byte as `registry.json.rejected` with one warning and
 * the plugin starts empty. Uses raw node fs to avoid FileSystemPort containment
 * constraints that would prevent writing to `.voidrift/`.
 */
export class NodeRegistryPersistence implements RegistryPersistencePort {
  private readonly baseDir: string;
  private readonly getLimit: (key: string) => number;
  private readonly getLimitAction: (key: string) => "warn" | "deny";
  private readonly onLimitHit: (key: string, detail: { observed: number; cap: number; action: string }) => void;

  constructor(
    workspaceRoot: string,
    private readonly warn: RegistryWarn = () => {},
    injections?: RegistryLimitInjections,
  ) {
    this.baseDir = path.join(workspaceRoot, ".voidrift", "plugins");
    this.getLimit = injections?.getLimit ?? ((key: string) => {
      const spec = getLimitSpec(key);
      return spec?.default ?? 1024 * 1024; // 1 MiB fallback for file, 64 KiB fallback for value
    });
    this.getLimitAction = injections?.getLimitAction ?? ((key: string) => {
      const spec = getLimitSpec(key);
      return spec?.action ?? "warn";
    });
    this.onLimitHit = injections?.onLimitHit ?? (() => {});
  }

  /** The base plugins directory for this adapter (for doctor STORAGE check). */
  directory(): string {
    return this.baseDir;
  }

  private pluginDir(namespace: string): string {
    return path.join(this.baseDir, pluginShortName(namespace));
  }

  private fileFor(namespace: string): string {
    return path.join(this.pluginDir(namespace), "registry.json");
  }

  load(namespace: string): Record<string, unknown> {
    const file = this.fileFor(namespace);
    let raw: string;
    try {
      const stat = fs.statSync(file);
      const fileCap = this.getLimit("plugins.registryFileMaxBytes");
      const fileAction = this.getLimitAction("plugins.registryFileMaxBytes");
      if (stat.size > fileCap) {
        // File over limit: action warn => load + emit, action deny => set aside
        if (fileAction === "deny") {
          this.setAside(file, `registry file ${file} exceeds the ${fileCap}-byte cap`);
          return {};
        }
        // Warn action: emit LIMIT_HIT but continue loading
        this.onLimitHit("plugins.registryFileMaxBytes", {
          observed: stat.size,
          cap: fileCap,
          action: "warn",
        });
      }
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return {}; // absent → empty start
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.setAside(file, `registry file ${file} is not valid JSON`);
      return {};
    }
    if (!isRegistryFile(parsed)) {
      this.setAside(file, `registry file ${file} is not a { version: 1, entries: {} } object`);
      return {};
    }
    return { ...parsed.entries };
  }

  save(namespace: string, entries: Record<string, unknown>): void {
    const pluginDir = this.pluginDir(namespace);
    fs.mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
    // Harden the dir mode even if it pre-existed with a looser mode.
    try {
      fs.chmodSync(pluginDir, 0o700);
    } catch {
      /* best effort */
    }
    const file = this.fileFor(namespace);
    const payload: RegistryFile = { version: REGISTRY_FILE_VERSION, entries };
    const body = JSON.stringify(payload);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      /* best effort */
    }
    fs.renameSync(tmp, file); // atomic last-writer-wins
  }

  remove(namespace: string): void {
    try {
      fs.rmSync(this.fileFor(namespace), { force: true });
    } catch {
      /* already gone */
    }
  }

  private setAside(file: string, reason: string): void {
    try {
      fs.renameSync(file, `${file}.rejected`);
    } catch {
      /* best effort; the plugin still starts empty */
    }
    this.warn(`${reason}; set aside as ${path.basename(file)}.rejected, plugin starts empty`);
  }
}

/**
 * An in-memory persistence adapter for tests: a `Map` of namespace → entries.
 * Deep-clones on load and save so a test cannot alias the store's live copy.
 */
export class InMemoryRegistryPersistence implements RegistryPersistencePort {
  private readonly files = new Map<string, Record<string, unknown>>();

  load(namespace: string): Record<string, unknown> {
    const v = this.files.get(namespace);
    return v ? structuredClone(v) : {};
  }

  save(namespace: string, entries: Record<string, unknown>): void {
    this.files.set(namespace, structuredClone(entries));
  }

  remove(namespace: string): void {
    this.files.delete(namespace);
  }

  /** Test helper: the raw stored entries for a namespace (or undefined). */
  peek(namespace: string): Record<string, unknown> | undefined {
    return this.files.get(namespace);
  }
}

/** True when `v` is a valid `{ version: 1, entries: {<non-null object>} }`. */
export function isRegistryFile(v: unknown): v is RegistryFile {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.version !== REGISTRY_FILE_VERSION) return false;
  const e = o.entries;
  return typeof e === "object" && e !== null && !Array.isArray(e);
}
