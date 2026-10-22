/**
 * The durable-registry persistence seam (core-blueprint.md §12.5).
 *
 * The registry is durable: a plugin's entries survive a process exit, so a
 * routine saved or a plan authored in one run is present in the next. The pure
 * `RegistryStore` logic stays unchanged; this port holds the file I/O behind a
 * tiny, synchronous contract so the store can serialize writes in-process and a
 * test can swap an in-memory adapter for the real filesystem one.
 *
 * One JSON file per (workspace, plugin) at
 * `<global config dir>/registry/<workspace key>/<plugin id file-safe>.json`,
 * where the workspace key is the first 16 hex characters of the SHA-256 of the
 * workspace real path and the plugin id is made file-safe. The store lives
 * OUTSIDE the workspace on purpose — a cloned repository cannot ship routines or
 * plans, and a registry file dropped in the workspace tree is ignored. Files are
 * `0600`, directories `0700`, and every write is atomic (temp file + `rename`).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** The on-disk file schema (§12.5): a versioned envelope of a plugin's keys. */
export interface RegistryFile {
  version: 1;
  entries: Record<string, unknown>;
}

/** The current (only) on-disk schema version. */
export const REGISTRY_FILE_VERSION = 1 as const;

/** The 1 MiB per-plugin file cap (§12.5): a larger file is set aside. */
export const REGISTRY_FILE_MAX_BYTES = 1024 * 1024;

/** The 64 KiB per-value cap (§12.5): a larger value is refused at write. */
export const REGISTRY_VALUE_MAX_BYTES = 64 * 1024;

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

/** The 16-hex workspace key: the first 16 hex of SHA-256 of the real path. */
export function workspaceKey(workspaceRealPath: string): string {
  return createHash("sha256").update(workspaceRealPath).digest("hex").slice(0, 16);
}

/** Make a plugin id file-safe: keep `[a-z0-9._-]`, replace the rest with `_`,
 * and bound the length so a hostile id cannot overflow a path. A collision is
 * acceptable (two ids mapping to one file is a plugin-author problem, not a
 * safety one); the value remains namespaced in memory by the raw id. */
export function fileSafePluginId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
  return safe === "" ? "_" : safe;
}

/**
 * The real filesystem adapter (§12.5). Writes outside the workspace under the
 * global config dir; dirs `0700`, files `0600`, atomic temp+rename. A malformed,
 * wrong-version, non-object, or over-cap file is set aside byte-for-byte as
 * `<file>.rejected` with one warning and the plugin starts empty. Uses raw node
 * fs (never the workspace `FileSystemPort`) because the store is deliberately
 * outside the workspace sandbox.
 */
export class NodeRegistryPersistence implements RegistryPersistencePort {
  private readonly dir: string;

  constructor(
    globalConfigDir: string,
    workspaceRealPath: string,
    private readonly warn: RegistryWarn = () => {},
  ) {
    this.dir = path.join(globalConfigDir, "registry", workspaceKey(this.resolveReal(workspaceRealPath)));
  }

  /** The directory this adapter writes into (for a doctor STORAGE check). */
  directory(): string {
    return this.dir;
  }

  private resolveReal(p: string): string {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  }

  private fileFor(namespace: string): string {
    return path.join(this.dir, `${fileSafePluginId(namespace)}.json`);
  }

  load(namespace: string): Record<string, unknown> {
    const file = this.fileFor(namespace);
    let raw: string;
    try {
      const stat = fs.statSync(file);
      if (stat.size > REGISTRY_FILE_MAX_BYTES) {
        this.setAside(file, `registry file ${file} exceeds the ${REGISTRY_FILE_MAX_BYTES}-byte cap`);
        return {};
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
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // Harden the dir mode even if it pre-existed with a looser mode.
    try {
      fs.chmodSync(this.dir, 0o700);
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
