/**
 * Plugin loader adapter (core-blueprint.md §12.4).
 *
 * The only place Node module resolution, the `node_modules` candidate scan, and
 * the license-metadata scan touch the real filesystem (§1 rule 3). It resolves a
 * config entry (package or path) to a real directory, dedupes by real path,
 * reads the `package.json` into a `PluginMeta`, walks the dependency tree for a
 * copyleft license, and imports the module to obtain its `register` export. The
 * capability (§12.4) owns enablement, hot-reload, scoping, and failure isolation.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  isPermissiveLicense,
  isPluginManifest,
  toPluginMeta,
  type PackageManifest,
  type PluginMeta,
} from "../entities/plugins/plugin-meta.js";

/** A resolved plugin ready to load, before the license gate (§12.4). */
export interface ResolvedPlugin {
  /** The config-entry key (package name or path string). */
  entryKey: string;
  /** The canonical real path of the plugin package directory. */
  realPath: string;
  manifest: PackageManifest;
  meta: PluginMeta;
}

/** The result of the license scan (§12.4). */
export interface LicenseScanResult {
  ok: boolean;
  /** The offending package and license when `ok` is false. */
  offender?: { pkg: string; license: string };
}

export interface PluginEntryInput {
  id: string;
  path?: string;
}

export class PluginLoader {
  constructor(
    private readonly workspaceRoot: string,
    private readonly globalRoot: string,
  ) {}

  /**
   * Resolve a config entry to its real package directory (§12.4). A path entry
   * resolves against the workspace root; a package entry resolves through Node
   * module resolution from the workspace root first, then the global root.
   * Returns null when it cannot be resolved.
   */
  resolve(entry: PluginEntryInput): ResolvedPlugin | null {
    const dir = entry.path !== undefined ? this.resolvePath(entry.path) : this.resolvePackage(entry.id);
    if (!dir) return null;
    let realPath: string;
    try {
      realPath = fs.realpathSync(dir);
    } catch {
      return null;
    }
    const manifest = this.readManifest(realPath);
    if (!manifest) return null;
    const meta = toPluginMeta(manifest, true);
    return { entryKey: entry.id, realPath, manifest, meta };
  }

  private resolvePath(p: string): string | null {
    const abs = path.isAbsolute(p) ? p : path.join(this.workspaceRoot, p);
    return fs.existsSync(path.join(abs, "package.json")) ? abs : null;
  }

  /**
   * Resolve a package entry through Node module resolution (§12.4, §12.4.1).
   * The global plugin store (`<voidriftConfigDir()>/plugins`) and first-party
   * roots resolve FIRST so a global/first-party plugin always wins; the project
   * plugin store (`.voidrift/plugins`) resolves LAST so an untrusted cloned repo
   * can never SHADOW a legitimate global/first-party package of the same id.
   * `npm install --prefix <store>` places a package at
   * `<store>/node_modules/<name>`, and `createRequire(<store>/noop.js)` resolves
   * from `<store>/node_modules`, so each store is a resolution base. The package
   * ROOT is found by resolving the package's ENTRY point (`require.resolve(name)`)
   * — never `<name>/package.json`, which a package whose `exports` map omits
   * `./package.json` forbids (ERR_PACKAGE_PATH_NOT_EXPORTED) — then walking up to
   * the nearest `package.json` whose `name` equals `name`. The first base that
   * resolves wins; real-path identity then dedupes (§12.4). Loading a
   * project-store entry is additionally gated on workspace trust by the Plugins
   * capability (§12.4.1); this order is the second line of defense.
   */
  private resolvePackage(name: string): string | null {
    const bases = [
      path.join(this.globalRoot, "plugins"),
      this.globalRoot,
      this.workspaceRoot,
      path.join(this.workspaceRoot, ".voidrift", "plugins"),
    ];
    for (const base of bases) {
      const dir = resolvePackageRoot(path.join(base, "noop.js"), name);
      if (dir) return dir;
    }
    return null;
  }

  private readManifest(dir: string): PackageManifest | null {
    try {
      const raw = fs.readFileSync(path.join(dir, "package.json"), "utf8");
      return JSON.parse(raw) as PackageManifest;
    } catch {
      return null;
    }
  }

  /**
   * Scan a plugin package's own license and its transitive dependency tree for a
   * non-permissive license (§12.4). Each dependency is resolved with STANDARD
   * node resolution from the dependent package's directory — the plugin's nested
   * `node_modules` first, then any HOISTED copy higher up — so the scanned
   * license is the version the plugin actually loads under the normal
   * npm/monorepo (hoisted) layout and under pnpm. Fail-closed: a dependency that
   * cannot be resolved by that walk, or whose license cannot be determined, is
   * an offender. Only the plugin's DECLARED dependency closure is walked (the BFS
   * enqueues declared deps only), so an unrelated hoisted package is never
   * scanned. Returns the first offender; `ok` is false when the plugin or any
   * transitive dependency fails.
   */
  licenseScan(resolved: ResolvedPlugin): LicenseScanResult {
    if (!isPermissiveLicense(resolved.manifest.license)) {
      return { ok: false, offender: { pkg: resolved.meta.id, license: resolved.manifest.license ?? "UNKNOWN" } };
    }
    const root = resolved.realPath;
    const seen = new Set<string>([resolved.meta.id]);
    const queue: { dir: string; deps: Record<string, string> }[] = [
      { dir: resolved.realPath, deps: resolved.manifest.dependencies ?? {} },
    ];
    while (queue.length > 0) {
      const { dir, deps } = queue.shift()!;
      for (const depName of Object.keys(deps)) {
        if (seen.has(depName)) continue;
        seen.add(depName);
        const depDir = this.resolveDepDir(dir, depName, root);
        if (!depDir) {
          // Fail-closed: a declared dependency not present in the plugin subtree.
          return { ok: false, offender: { pkg: depName, license: "UNRESOLVED" } };
        }
        const depManifest = this.readManifest(depDir);
        if (!depManifest || !isPermissiveLicense(depManifest.license)) {
          // Fail-closed: unreadable manifest or non-permissive/undeterminable license.
          return { ok: false, offender: { pkg: depName, license: depManifest?.license ?? "UNKNOWN" } };
        }
        queue.push({ dir: depDir, deps: depManifest.dependencies ?? {} });
      }
    }
    return { ok: true };
  }

  /**
   * Resolve a dependency directory with STANDARD node resolution from the
   * dependent package's directory (§12.4): walk up `node_modules` from `fromDir`
   * — the plugin's own nested copy first, then any HOISTED copy higher up — so a
   * dependency placed at the install root (the normal npm/monorepo layout) still
   * resolves and is scanned under the version the plugin actually loads. The
   * walk is bounded: it stops at the filesystem root and visits at most
   * `MAX_NODE_MODULES_LEVELS` ancestors (cycle-safe). `root` is retained for the
   * signature but no longer caps the walk — only the plugin's DECLARED
   * dependency closure is scanned (the BFS in {@link licenseScan} only enqueues
   * declared deps), so unrelated hoisted packages are never visited. Returns
   * null when the dependency is absent from every ancestor `node_modules`.
   */
  private resolveDepDir(fromDir: string, depName: string, root: string): string | null {
    void root;
    let current = fromDir;
    for (let level = 0; level < MAX_NODE_MODULES_LEVELS; level++) {
      const candidate = path.join(current, "node_modules", depName, "package.json");
      if (fs.existsSync(candidate)) return path.dirname(candidate);
      const parent = path.dirname(current);
      if (parent === current) break; // reached the filesystem root
      current = parent;
    }
    return null;
  }

  /**
   * Read the `package.json` of an installed package directory for post-install
   * verification (§12.4.1). Public because the Plugins capability verifies an
   * install through the one adapter that touches the filesystem (§1 rule 3).
   */
  readInstalledManifest(packageDir: string): PackageManifest | null {
    return this.readManifest(packageDir);
  }

  /**
   * Read the `dist.integrity` npm recorded for an installed package, from the
   * install store's `package-lock.json` (§12.4.1). npm writes the resolved
   * tarball integrity there, not into the installed `package.json`, so this is
   * where the installed-tarball integrity is checked against the reviewed one. A
   * missing lockfile or entry returns null (the caller then relies on the
   * name/version/plugin-flag/license checks and does not fail on absence).
   */
  /**
   * Read the `dist.integrity` npm recorded for an installed package (§12.4.1).
   * npm 10/11 writes the resolved-tarball integrity into the install store's
   * `package-lock.json` AND the hidden `node_modules/.package-lock.json`, under
   * `packages["node_modules/<name>"].integrity` — never into the installed
   * `package.json`. This reads the store lockfile first and falls back to the
   * hidden one, so the capability can compare the bytes on disk to the reviewed
   * integrity. Returns null only when NEITHER lockfile records an integrity; the
   * caller treats null as a failure and refuses the install (fail closed).
   */
  readInstalledIntegrity(packageDir: string): string | null {
    // packageDir = <store>/node_modules/<name...>; the lockfiles are at <store>
    // and <store>/node_modules/.package-lock.json.
    const marker = `${path.sep}node_modules${path.sep}`;
    const idx = packageDir.indexOf(marker);
    if (idx < 0) return null;
    const store = packageDir.slice(0, idx);
    const manifest = this.readManifest(packageDir);
    const name = manifest?.name;
    if (!name) return null;
    const key = `node_modules/${name}`;
    const lockfiles = [
      path.join(store, "package-lock.json"),
      path.join(store, "node_modules", ".package-lock.json"),
    ];
    for (const lockPath of lockfiles) {
      try {
        const raw = fs.readFileSync(lockPath, "utf8");
        const lock = JSON.parse(raw) as { packages?: Record<string, { integrity?: string }> };
        const integrity = lock.packages?.[key]?.integrity;
        if (integrity) return integrity;
      } catch {
        // try the next lockfile
      }
    }
    return null;
  }

  /**
   * Import a resolved plugin's module and return its `register` export (§12.4).
   * The entry module is the package's main; a throwing import is surfaced to the
   * caller for failure isolation.
   */
  async importRegister(resolved: ResolvedPlugin): Promise<(core: unknown, options?: unknown) => void | Promise<void>> {
    const main = resolved.manifest && typeof (resolved.manifest as { main?: unknown }).main === "string"
      ? (resolved.manifest as { main: string }).main
      : "index.js";
    const entry = path.join(resolved.realPath, main);
    const mod = (await import(pathToFileURL(entry).href)) as { register?: (core: unknown, options?: unknown) => void | Promise<void> };
    if (typeof mod.register !== "function") {
      throw new Error(`plugin ${resolved.meta.id} does not export register()`);
    }
    return mod.register;
  }

  /**
   * A best-effort scan of `node_modules` for the `voidrift.plugin` flag, one
   * level deeper inside `@`-scoped directories (§12.4). Produces candidates only
   * — never loads. Returns the package manifests found.
   */
  scanCandidates(): { manifest: PackageManifest; realPath: string }[] {
    const out: { manifest: PackageManifest; realPath: string }[] = [];
    const nm = path.join(this.workspaceRoot, "node_modules");
    if (!fs.existsSync(nm)) return out;
    const entries = this.safeReaddir(nm);
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const dir = path.join(nm, name);
      if (name.startsWith("@")) {
        for (const scoped of this.safeReaddir(dir)) {
          this.collectCandidate(path.join(dir, scoped), out);
        }
      } else {
        this.collectCandidate(dir, out);
      }
    }
    return out;
  }

  private collectCandidate(dir: string, out: { manifest: PackageManifest; realPath: string }[]): void {
    const manifest = this.readManifest(dir);
    if (!manifest || !isPluginManifest(manifest)) return;
    try {
      out.push({ manifest, realPath: fs.realpathSync(dir) });
    } catch {
      // Unreadable real path — skip.
    }
  }

  private safeReaddir(dir: string): string[] {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
    } catch {
      return [];
    }
  }
}

/**
 * The bound on how many ancestor `node_modules` the license scan walks when
 * resolving a (possibly hoisted) dependency — a cycle-safe, DoS-safe cap well
 * above any realistic nesting depth.
 */
const MAX_NODE_MODULES_LEVELS = 64;

/**
 * Resolve a package's ROOT directory from a resolution base WITHOUT requiring
 * `<name>/package.json` to be exported (§12.4). Node's `exports` map commonly
 * exposes only `.` under the `import` condition (no `require`), which makes both
 * `require.resolve("<name>/package.json")` AND `createRequire().resolve(name)`
 * throw `ERR_PACKAGE_PATH_NOT_EXPORTED` for an ESM-only plugin. Resolving the
 * package ENTRY with `import.meta.resolve(name, base)` (the `import` condition a
 * plugin IS loaded under) is always allowed; the package root is then the
 * nearest ancestor `package.json` whose `name` equals `name`. A `createRequire`
 * resolution is kept as a fallback for a CJS package. Returns null when the
 * package cannot be resolved from `base`, or when no ancestor manifest with the
 * matching name is found within {@link MAX_NODE_MODULES_LEVELS} levels.
 */
function resolvePackageRoot(basePath: string, name: string): string | null {
  let entry: string | null = null;
  const baseUrl = pathToFileURL(basePath).href;
  try {
    entry = fileURLToPath(import.meta.resolve(name, baseUrl));
  } catch {
    // Fall back to CJS resolution for a package exposing a `require` condition.
    try {
      entry = createRequire(basePath).resolve(name);
    } catch {
      return null;
    }
  }
  let current = path.dirname(entry);
  for (let level = 0; level < MAX_NODE_MODULES_LEVELS; level++) {
    const pkgPath = path.join(current, "package.json");
    try {
      const raw = fs.readFileSync(pkgPath, "utf8");
      const manifest = JSON.parse(raw) as { name?: unknown };
      if (manifest.name === name) return current;
    } catch {
      // No manifest here (or unreadable) — keep walking up.
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
