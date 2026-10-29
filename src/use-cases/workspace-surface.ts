/**
 * The read-only workspace surface (retrieval-blueprint §3, §5; core §8, §9.4).
 *
 * A NARROW, READ-ONLY seam exposed to plugins as `core.workspace` (never a model
 * tool, never in any tool list). The retrieval plugin drives its index from it
 * and reads the current turn's input and the session focus from it so a
 * SYNCHRONOUS context provider can be fed from pre-resolved data (core §4).
 *
 * EVERY rule lives HERE, never in the plugin:
 *   - Containment is the FileSystemPort's job (`glob`/`readFile` resolve through
 *     the one workspace-root chokepoint, which rejects `..` and a symlink escape
 *     with `PATH_ESCAPE`, core §8.2); this surface adds no second containment
 *     check but NEVER returns a path the port rejected.
 *   - The ignore mechanism is the same the glob/map tools use (the FileSystemPort
 *     glob already skips `node_modules` and `.git`); this surface additionally
 *     and ALWAYS skips `.voidrift`.
 *   - Secret-looking names are excluded by basename: `.env*`, `*.pem`, `*.key`,
 *     `id_rsa*`, `*credentials*`, `.npmrc`, `.netrc`.
 *   - Binary files (a NUL byte in the first 8 KiB) and files larger than 1 MiB
 *     are excluded from `readText`.
 *   - At most 20,000 files are returned per listing.
 *
 * Paths are returned workspace-relative and sanitized (forward slashes, no
 * leading `./`). The surface is purely additive: it reads, never writes, and a
 * failure degrades to an empty/`null` result rather than throwing into a plugin.
 */
import fs from "node:fs";
import nodePath from "node:path";
import type { FileSystemPort } from "../entities/ports/host.js";
import { contentHash } from "../entities/hash.js";
import { validateGlobPattern } from "../entities/glob-validate.js";
import { compileIgnoreFile, isIgnored, type CompiledIgnoreFile } from "../entities/gitignore.js";
import { limitDefault } from "../entities/limits.js";
import type { LimitsPort } from "../entities/ports/limits-port.js";

/** The hard cap on a single listing (retrieval-blueprint §3, §13.11 TOOL3). The
 * effective value is read from the limits port at use; this export is the
 * registry-backed default for the public surface. */
export const MAX_FILES = limitDefault("tools.workspaceMaxFiles");
/** The per-file byte cap for `readText` (retrieval-blueprint §3, §13.11 TOOL4). */
export const MAX_FILE_BYTES = limitDefault("tools.workspaceFileMaxBytes");
/** How many leading bytes are scanned for a NUL to classify a file as binary. */
const BINARY_SNIFF_BYTES = 8 * 1024;

/** Directory segments always skipped regardless of ignore rules. */
const ALWAYS_SKIP_DIRS = new Set(["node_modules", ".git", ".voidrift"]);

/** A valid `cacheDir` namespace: a lowercase slug (no separators, no traversal).
 * Matches the filename-slug rule (lowercase alphanumerics and hyphens). */
const CACHE_NAMESPACE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Secret-looking basenames are never listed or read (defense in depth over the
 * secret masker, retrieval-blueprint §8). Matched case-insensitively.
 */
function isSecretName(base: string): boolean {
  const b = base.toLowerCase();
  if (b === ".npmrc" || b === ".netrc") return true;
  if (b.startsWith(".env")) return true;
  if (b.startsWith("id_rsa")) return true;
  if (b.endsWith(".pem") || b.endsWith(".key")) return true;
  if (b.includes("credentials")) return true;
  return false;
}

/** True when a workspace-relative path is excluded by segment or basename. */
export function isExcludedPath(rel: string): boolean {
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (norm === "" || norm.startsWith("../") || norm === "..") return true;
  const segs = norm.split("/");
  for (const seg of segs) if (ALWAYS_SKIP_DIRS.has(seg)) return true;
  const base = segs[segs.length - 1] ?? "";
  if (isSecretName(base)) return true;
  return false;
}

/** True when the bytes look binary (a NUL in the first `BINARY_SNIFF_BYTES`). */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** Normalize a path to workspace-relative, forward-slash, no leading `./`. */
function sanitize(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Translate a listing glob to a RegExp with the SAME simple semantics the glob
 * tools use (FX-B, used only to filter the authoritative `git ls-files` set by
 * the caller's pattern): a double-star spans path segments (a leading
 * double-star segment also matches zero leading segments), a single star stays
 * within a segment. The pattern is already length/nesting-validated
 * (validateGlobPattern) before this is reached.
 */
function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0002")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0001/g, ".*")
    .replace(/\u0002/g, "(?:.*/)?");
  return new RegExp("^" + body + "$");
}

export interface WorkspaceSurfaceDeps {
  fileSystem: FileSystemPort;
  /**
   * The ABSOLUTE workspace root, used only by `cacheDir` to return and create
   * the owner-only `<workspace>/.voidrift/cache/<namespace>/` path (retrieval
   * §4; core §12.4). Optional so an in-memory test that never calls `cacheDir`
   * can omit it; `cacheDir` throws when it is absent.
   */
  workspaceRoot?: string;
  /**
   * The tracked+untracked candidate list from the HARDENED git runner inside a
   * git repo (`git ls-files -z --cached --others --exclude-standard`, FX-B) —
   * git applies `.gitignore`, `.git/info/exclude` and the global excludes file
   * exactly as git does, and keeps a tracked-but-ignored file visible. Returns
   * workspace-relative POSIX paths, or `null` OUTSIDE a git repo (the surface
   * then parses `.gitignore` files itself). Optional so an in-memory test can
   * drive either path; when absent the surface takes the non-git path.
   */
  gitListFiles?: () => Promise<string[] | null>;
  /** The active session's current turn input (facade `activeTurnInput`). */
  getTurnInput: () => string;
  /** The active session's focus paths (facade `activeFocusPaths`). */
  getFocusPaths: () => string[];
  /** §13.11 — the limits port; the listing cap (`tools.workspaceMaxFiles`) and
   * per-file byte cap (`tools.workspaceFileMaxBytes`) come from the registry and
   * a listing truncation emits `LIMIT_HIT`. Omitted → registry defaults. */
  limits?: LimitsPort;
}

/**
 * The implementation behind `core.workspace` on the ScopedCoreApi. Constructed
 * once by boot and shared by every plugin (the surface is stateless and purely
 * read-only; there is no per-plugin state to isolate).
 */
export class WorkspaceSurfaceImpl {
  /**
   * The per-surface content-hash cache (retrieval §3) backing the SYNCHRONOUS
   * `hashFor`. Populated by `readText` and the surface's own reads, keyed by the
   * sanitized workspace-relative path. Never written for an excluded path.
   */
  private readonly hashCache = new Map<string, string>();
  /** Lazily-compiled workspace `.gitignore` set for the SYNC `hashFor` exclusion
   * check (undefined until first use; [] when none / unavailable). */
  private ignoreCache: CompiledIgnoreFile[] | undefined;

  constructor(private readonly deps: WorkspaceSurfaceDeps) {}

  /** §13.11 effective caps (port value, else registry default). */
  private maxFiles(): number {
    return this.deps.limits?.get("tools.workspaceMaxFiles") ?? MAX_FILES;
  }
  private maxFileBytes(): number {
    return this.deps.limits?.get("tools.workspaceFileMaxBytes") ?? MAX_FILE_BYTES;
  }

  async files(opts?: { pattern?: string }): Promise<string[]> {
    const pattern = opts?.pattern;
    if (pattern !== undefined && typeof pattern !== "string") return [];
    const glob = pattern && pattern.trim() !== "" ? pattern : "**/*";
    // S5 (GHSA-vfj7-8cjw-p6xm): reject a pathological glob before the library.
    if (validateGlobPattern(glob) !== null) return [];

    // FX-B — honour ignore rules so retrieval never surfaces an ignored file.
    // Inside a git repo the hardened `git ls-files` set IS the candidate list
    // (it applies .gitignore, .git/info/exclude and the global excludes file the
    // way git does, and keeps a tracked-but-ignored file visible). Outside a
    // repo the glob is the candidate list and the surface parses the workspace's
    // `.gitignore` files itself to exclude ignored paths.
    const candidates = await this.candidateFiles(glob);
    if (candidates === null) return [];

    const out: string[] = [];
    const cap = this.maxFiles();
    for (const raw of candidates.list) {
      const rel = sanitize(raw);
      if (isExcludedPath(rel)) continue;
      if (candidates.reject && candidates.reject(rel)) continue;
      out.push(rel);
      if (out.length >= cap) {
        // §13.11 TOOL3 — the listing is capped; files beyond `cap` are not
        // returned. One LIMIT_HIT names the key.
        this.deps.limits?.hit("tools.workspaceMaxFiles", cap, { what: "workspace listing truncated" });
        break;
      }
    }
    return out.sort();
  }

  /**
   * The candidate file list for a listing and an optional reject predicate
   * (FX-B). In a git repo the candidates ARE the hardened `git ls-files` set
   * (gitignore already applied — no reject predicate needed); the caller's glob
   * then filters it. Outside a repo the candidates are `fileSystem.glob(glob)`
   * and the reject predicate is the compiled `.gitignore` set. Returns null when
   * the glob itself fails (degrades to an empty listing); either ignore step
   * degrades OPEN on failure (the always-on `isExcludedPath` exclusions still
   * apply), never throwing into a plugin.
   */
  private async candidateFiles(
    glob: string,
  ): Promise<{ list: string[]; reject?: (rel: string) => boolean } | null> {
    // Git path: the git set is authoritative; filter it by the caller's glob.
    if (this.deps.gitListFiles) {
      try {
        const listed = await this.deps.gitListFiles();
        if (listed !== null) {
          const re = globToRegExp(glob);
          const list = listed
            .map(sanitize)
            .filter((p) => re.test(p) || re.test(p.split("/").pop() ?? ""));
          return { list };
        }
      } catch {
        // fall through to the non-git path
      }
    }
    // Non-git path: glob the workspace, then exclude paths matched by .gitignore.
    let matched: string[];
    try {
      matched = await this.deps.fileSystem.glob(glob);
    } catch {
      return null; // a PATH_ESCAPE or any port error degrades to an empty listing
    }
    const compiled = await this.compileWorkspaceIgnores();
    const reject = compiled.length > 0 ? (rel: string) => isIgnored(rel, false, compiled) : undefined;
    return reject ? { list: matched, reject } : { list: matched };
  }

  /** Compile every `.gitignore` in the workspace (nested too, root->leaf) for
   * the non-git listing path; returns [] when none exist or on failure. */
  private async compileWorkspaceIgnores(): Promise<CompiledIgnoreFile[]> {
    try {
      const ignoreFiles = await this.deps.fileSystem.glob("**/.gitignore");
      if (ignoreFiles.length === 0) return [];
      const compiled: CompiledIgnoreFile[] = [];
      for (const f of ignoreFiles.map(sanitize).sort((a, b) => a.split("/").length - b.split("/").length)) {
        const baseDir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
        try {
          compiled.push(compileIgnoreFile(baseDir, await this.deps.fileSystem.readFile(f)));
        } catch {
          // skip an unreadable .gitignore
        }
      }
      return compiled;
    } catch {
      return [];
    }
  }

  async readText(path: string, opts?: { maxBytes?: number }): Promise<{ text: string; hash: string } | null> {
    if (typeof path !== "string" || path.trim() === "") return null;
    const rel = sanitize(path);
    if (isExcludedPath(rel)) return null;
    const maxFileBytes = this.maxFileBytes();
    const maxBytes = Math.max(1, Math.min(opts?.maxBytes ?? maxFileBytes, maxFileBytes));
    let bytes: Uint8Array;
    try {
      // readBinary enforces containment (PATH_ESCAPE) and the size cap BEFORE a
      // byte is buffered (core §8.2, §3.3); an oversized/escaping/unreadable path
      // throws and we degrade to null.
      bytes = await this.deps.fileSystem.readBinary(rel, { maxBytes });
    } catch (e) {
      // §13.11 — `tools.workspaceFileMaxBytes` is a `warn` cap: an over-cap file
      // is SKIPPED (degrades to null), but the skip is NEVER silent — emit ONE
      // LIMIT_HIT naming the key so reflection/stats see the bound bite. Only
      // the size-cap throw names the key; a PATH_ESCAPE/unreadable stays silent.
      const msg = e instanceof Error ? e.message : String(e);
      if (/exceeds the .*-byte cap/.test(msg)) {
        this.deps.limits?.hit("tools.workspaceFileMaxBytes", maxBytes, { what: "workspace file over the byte cap (skipped)" });
      }
      return null;
    }
    if (looksBinary(bytes)) return null;
    const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
    const hash = contentHash(text);
    // Prime the sync hash cache so a later `hashFor(path)` resolves without a
    // read (retrieval §3) — the surface's own read populates it.
    this.hashCache.set(rel, hash);
    return { text, hash };
  }

  currentInput(): string {
    try {
      return this.deps.getTurnInput() ?? "";
    } catch {
      return "";
    }
  }

  focusPaths(): string[] {
    try {
      return (this.deps.getFocusPaths() ?? []).map(sanitize).filter((p) => !isExcludedPath(p));
    } catch {
      return [];
    }
  }

  /**
   * Return (and lazily create) the owner-only cache directory for a plugin
   * namespace: `<workspace>/.voidrift/cache/<namespace>/` (retrieval §4; core
   * §12.4). Directories are created `0700`. The `namespace` must be a lowercase
   * slug and the returned path is always inside the workspace cache root — a
   * traversal, absolute, or non-slug argument is REFUSED (throws), so one
   * plugin's cache can never land in another's tree or outside `.voidrift`. The
   * cache dir is harness state: it is a protected control path for the model's
   * file/shell tools (§9.4) and is excluded from rollback snapshots (§10.12).
   */
  cacheDir(namespace: string): string {
    if (typeof namespace !== "string" || !CACHE_NAMESPACE_RE.test(namespace)) {
      throw new Error(`invalid cache namespace "${String(namespace)}" (must be a lowercase slug)`);
    }
    const root = this.deps.workspaceRoot;
    if (!root) throw new Error("cacheDir requires a workspace root");
    const cacheRoot = nodePath.resolve(root, ".voidrift", "cache");
    const dir = nodePath.resolve(cacheRoot, namespace);
    // Defense in depth: the resolved dir must stay under the cache root (the
    // slug check already forbids separators, but never trust a single guard).
    if (dir !== nodePath.join(cacheRoot, namespace) || !dir.startsWith(cacheRoot + nodePath.sep)) {
      throw new Error(`cache namespace "${namespace}" escapes the cache root`);
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /**
   * The surface's own content hash of a workspace file, SYNCHRONOUSLY, or
   * `null` when the path is outside the workspace, excluded by the same
   * secret/exclusion rules `readText` applies, or unresolvable/unreadable
   * (retrieval §3). It serves from the per-surface hash cache that `readText`
   * and prior `hashFor` calls populate; on a miss it resolves the hash with a
   * single bounded SYNC read (the surface's own read) and caches it, so a plugin
   * verifies a persisted index entry's freshness against the LIVE tree inside a
   * synchronous context provider without an async round-trip. A `null` marks the
   * entry stale → rebuild rather than trusting it. The read goes through the
   * SAME containment (no `..`, no symlink escape) and the SAME 1 MiB cap and
   * binary/exclusion rules as `readText`.
   */
  hashFor(path: string): string | null {
    if (typeof path !== "string" || path.trim() === "") return null;
    const rel = sanitize(path);
    if (isExcludedPath(rel)) return null;
    const cached = this.hashCache.get(rel);
    if (cached !== undefined) return cached;
    const root = this.deps.workspaceRoot;
    if (!root) return null;
    // Excluded by the workspace's gitignore rules, like a listing (FX-B). A
    // cached hash (already read, so not ignored) short-circuits above.
    if (this.isGitignoredSync(root, rel)) return null;
    try {
      // Containment: resolve under the root, resolving symlinks on the deepest
      // existing ancestor so an in-workspace symlink cannot point outside — the
      // SAME chokepoint rule the FileSystemPort enforces (§8.2), done
      // synchronously here.
      const abs = this.resolveInsideSync(root, rel);
      if (abs === null) return null;
      const st = fs.statSync(abs);
      if (!st.isFile()) return null;
      if (st.size > this.maxFileBytes()) {
        // §13.11 — over-cap file skipped: ONE LIMIT_HIT naming the key, not
        // silent (same `warn` contract as the async readText skip above).
        this.deps.limits?.hit("tools.workspaceFileMaxBytes", st.size, { what: "workspace file over the byte cap (skipped)" });
        return null;
      }
      const bytes = fs.readFileSync(abs);
      if (looksBinary(bytes)) return null;
      const hash = contentHash(bytes.toString("utf8"));
      this.hashCache.set(rel, hash);
      return hash;
    } catch {
      return null;
    }
  }

  /**
   * Synchronous containment: the absolute canonical path of `rel` under `root`,
   * or `null` when it escapes (an absolute `rel`, a `..` escape, or an
   * in-workspace symlink whose resolved target leaves the root). Mirrors the
   * FileSystemPort's async `resolve` chokepoint for `hashFor`'s one sync read.
   */
  private resolveInsideSync(root: string, rel: string): string | null {
    const normRoot = nodePath.resolve(root);
    const abs = nodePath.resolve(normRoot, rel);
    const inside = (p: string): boolean => {
      const r = nodePath.relative(normRoot, p);
      return r === "" || (!r.startsWith("..") && !nodePath.isAbsolute(r));
    };
    if (!inside(abs)) return null;
    let probe = abs;
    for (;;) {
      try {
        const real = fs.realpathSync(probe);
        const tail = nodePath.relative(probe, abs);
        const canonical = tail === "" ? real : nodePath.join(real, tail);
        return inside(canonical) ? canonical : null;
      } catch {
        const parent = nodePath.dirname(probe);
        if (parent === probe) return abs;
        probe = parent;
      }
    }
  }

  /**
   * True when `rel` is excluded by the workspace's `.gitignore` files — the SYNC
   * counterpart of the listing's gitignore step, for `hashFor`. The compiled set
   * is built once per surface from every `.gitignore` under the root (root→leaf
   * so the nearest file wins) using the same matcher the listing uses. Degrades
   * OPEN (not ignored) on any read failure, never throwing.
   */
  private isGitignoredSync(root: string, rel: string): boolean {
    if (this.ignoreCache === undefined) this.ignoreCache = this.compileIgnoresSync(root);
    return this.ignoreCache.length > 0 && isIgnored(rel, false, this.ignoreCache);
  }

  private compileIgnoresSync(root: string): CompiledIgnoreFile[] {
    const out: CompiledIgnoreFile[] = [];
    const walk = (dir: string, relDir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const name = e.name;
        if (e.isFile() && name === ".gitignore") {
          try {
            out.push(compileIgnoreFile(relDir, fs.readFileSync(nodePath.join(dir, name), "utf8")));
          } catch {
            /* skip an unreadable .gitignore */
          }
        } else if (e.isDirectory() && !ALWAYS_SKIP_DIRS.has(name)) {
          walk(nodePath.join(dir, name), relDir === "" ? name : `${relDir}/${name}`);
        }
      }
    };
    try {
      walk(nodePath.resolve(root), "");
    } catch {
      return [];
    }
    // Root→leaf so the nearest file and later patterns win (git precedence).
    return out.sort((a, b) => a.baseDir.split("/").length - b.baseDir.split("/").length);
  }
}
