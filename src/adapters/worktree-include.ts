/**
 * The per-worktree include-list copier (core-blueprint.md §7.3).
 *
 * A worktree carries only git-TRACKED files; a worker that needs an untracked
 * or ignored path present in the main working tree (a `.env`, a built
 * `node_modules`, a local cache) would otherwise find it missing. The harness
 * closes this with a user-configurable include-list (`config.worktreeInclude`):
 * at worktree creation, each listed path that EXISTS in the main tree and is NOT
 * tracked in git is REAL-copied into the same relative path in the new worktree.
 *
 * This is a copy OUT of the main tree, never a symlink back into it, so a worker
 * can never damage the original. The copy is deliberately conservative (§7.3):
 *
 * - Tracked paths are skipped silently (git already put them in the worktree).
 * - A symlinked ENTRY whose real path leaves the repo root is refused (a symlink
 *   could redirect the copy outside the workspace) — skipped with a warning.
 * - Inside a copied DIRECTORY, a symlink is NOT followed and NOT recreated when
 *   it points outside the repo; it is skipped and counted.
 * - Special files (sockets, devices, fifos) are skipped.
 * - An existing destination file is NEVER overwritten.
 * - File modes are preserved.
 * - The total copy is capped at 1 GiB per worktree; entries are copied in listed
 *   order and an entry that would push past the cap is skipped WHOLE.
 *
 * The copied paths are the worker's own: they are untracked, so no merge/apply
 * step ever carries them back (a merge of the worker's branch carries only
 * COMMITTED changes, and nothing commits these). They are discarded with the
 * worktree. Copying a secret (`.env`) is the user's explicit choice; nothing is
 * masked and nothing beyond relative paths and byte counts is logged.
 */
import { lstatSync, readdirSync, readlinkSync, mkdirSync, copyFileSync, existsSync, chmodSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";
import { limitDefault } from "../entities/limits.js";

/** The per-worktree copy cap default (§7.3, §13.11 SNAP4): registry
 * `worktree.includeCapBytes` (1 GiB total). The caller passes the effective
 * cascaded value via `copyIncludeList`'s `capBytes` argument. */
export const WORKTREE_INCLUDE_CAP_BYTES = limitDefault("worktree.includeCapBytes");

/** A copied path and the bytes it contributed (for the info log, §7.3). */
export interface CopiedEntry {
  path: string; // relative to the worktree/repo root
  bytes: number;
}

/** A skipped entry/path and why (for the warning channel, §7.3). */
export interface SkippedEntry {
  path: string; // relative to the repo root
  reason: string;
}

/** The outcome of applying the include-list to one worktree (§7.3). */
export interface IncludeResult {
  copied: CopiedEntry[];
  skipped: SkippedEntry[];
  totalBytes: number;
  /** Count of nested `.git` entries (file or dir, any depth) skipped inside a
   * copied directory — never copied (it would corrupt the worktree's git state).
   * Surfaced as a single "skipped N nested .git" summary, not per-entry noise. */
  nestedGitSkipped: number;
}

/** Is `child` the same as, or inside, `root`? Both must be resolved absolute. */
function isInside(root: string, child: string): boolean {
  if (child === root) return true;
  const rel = path.relative(root, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Copy the include-list entries from `mainRoot` into `worktreeRoot` (§7.3).
 * `isTracked(rel)` reports whether a repo-relative path is git-tracked (such a
 * path is already in the worktree and is skipped silently). `entries` are the
 * resolved `config.worktreeInclude` (already schema-validated: relative, no
 * `..`, no `.git`). Returns what was copied and what was skipped; never throws —
 * an unexpected per-entry error is recorded as a skip so one bad entry never
 * aborts worktree creation.
 */
export function copyIncludeList(
  mainRoot: string,
  worktreeRoot: string,
  entries: readonly string[],
  isTracked: (rel: string) => boolean,
  capBytes: number = WORKTREE_INCLUDE_CAP_BYTES,
): IncludeResult {
  const result: IncludeResult = { copied: [], skipped: [], totalBytes: 0, nestedGitSkipped: 0 };
  const realMainRoot = safeRealpath(mainRoot) ?? mainRoot;

  for (const entry of entries) {
    const rel = entry;
    const src = path.join(mainRoot, rel);

    // Tracked → already in the worktree (git put it there): skip silently.
    if (isTracked(rel)) continue;

    // Missing in the main tree → nothing to copy: skip silently (not an error).
    const st = safeLstat(src);
    if (st === null) continue;

    // A symlinked ENTRY whose real path leaves the repo root is refused: it could
    // redirect the copy outside the workspace (§7.3 safety).
    const real = safeRealpath(src);
    if (real === null || !isInside(realMainRoot, real)) {
      result.skipped.push({ path: rel, reason: "resolves outside the repository" });
      continue;
    }

    // Measure the entry WHOLE; an entry that would push past the cap is skipped
    // whole, in listed order (§7.3).
    const entryBytes = measureBytes(src, st);
    if (result.totalBytes + entryBytes > capBytes) {
      result.skipped.push({ path: rel, reason: "would exceed the worktree copy cap (worktree.includeCapBytes)" });
      continue;
    }

    const dest = path.join(worktreeRoot, rel);
    try {
      if (st.isDirectory()) {
        const copied = copyDir(src, dest, realMainRoot, rel, result);
        result.totalBytes += copied;
        result.copied.push({ path: rel, bytes: copied });
      } else if (st.isFile()) {
        const copied = copyRegularFile(src, dest, st.mode);
        if (copied >= 0) {
          result.totalBytes += copied;
          result.copied.push({ path: rel, bytes: copied });
        } else {
          result.skipped.push({ path: rel, reason: "destination already exists" });
        }
      } else if (st.isSymbolicLink()) {
        // A top-level symlink entry that resolves inside the repo: copy its
        // TARGET's content (real copy, never a link), by re-stat'ing the target.
        const copied = copyResolvedSymlink(src, dest, result, rel);
        if (copied >= 0) {
          result.totalBytes += copied;
          result.copied.push({ path: rel, bytes: copied });
        }
      } else {
        // Socket, device, fifo: skip special files (§7.3).
        result.skipped.push({ path: rel, reason: "special file (socket/device/fifo)" });
      }
    } catch (e) {
      result.skipped.push({ path: rel, reason: `copy error: ${String(e)}` });
    }
  }
  return result;
}

/** `realpathSync` that returns null instead of throwing (missing/broken link). */
function safeRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** `lstatSync` returning `Stats | null` (default, non-bigint overload). */
function safeLstat(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/** Total regular-file bytes an entry would contribute; symlinks count as 0 (they
 * are not copied). Never follows a symlinked directory. */
function measureBytes(p: string, st: Stats): number {
  if (st.isFile()) return Number(st.size);
  if (st.isSymbolicLink()) {
    // A top-level symlink entry: measure its resolved target's size if a file.
    const real = safeRealpath(p);
    if (real === null) return 0;
    const rst = safeLstat(real);
    if (rst === null) return 0;
    return rst.isFile() ? Number(rst.size) : rst.isDirectory() ? measureDir(real) : 0;
  }
  if (st.isDirectory()) return measureDir(p);
  return 0;
}

/** Sum regular-file bytes under a directory, never following symlinks. */
function measureDir(dir: string): number {
  let total = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const st = safeLstat(path.join(dir, name));
    if (st === null) continue;
    if (st.isDirectory()) total += measureDir(path.join(dir, name));
    else if (st.isFile()) total += Number(st.size);
    // symlinks and special files contribute 0 (not copied)
  }
  return total;
}

/** Copy one regular file, preserving mode; never overwrite. Returns bytes copied,
 * or -1 when the destination already exists. */
function copyRegularFile(src: string, dest: string, mode: number): number {
  if (existsSync(dest)) return -1;
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  try {
    chmodSync(dest, mode);
  } catch {
    // best-effort mode preservation
  }
  const st = safeLstat(dest);
  return st === null ? 0 : Number(st.size);
}

/** Copy a top-level symlink entry by its RESOLVED target content (real copy). */
function copyResolvedSymlink(src: string, dest: string, result: IncludeResult, rel: string): number {
  const real = safeRealpath(src);
  if (real === null) return -1;
  const rst = safeLstat(real);
  if (rst === null) return -1;
  if (rst.isDirectory()) {
    // Treat as a directory copy rooted at the real target.
    return copyDir(real, dest, path.dirname(real), rel, result);
  }
  if (rst.isFile()) {
    const copied = copyRegularFile(real, dest, rst.mode);
    if (copied < 0) {
      result.skipped.push({ path: rel, reason: "destination already exists" });
      return -1;
    }
    return copied;
  }
  result.skipped.push({ path: rel, reason: "special file (socket/device/fifo)" });
  return -1;
}

/**
 * Recursively copy a directory, preserving modes, never overwriting. A symlink
 * INSIDE the directory is NOT followed and NOT recreated when it points outside
 * the repo: it is skipped and counted (§7.3). A symlink that points inside the
 * repo is likewise skipped (we never recreate symlinks in a worktree — the goal
 * is a real, self-contained copy). Special files are skipped. A nested `.git`
 * entry (file or directory, at any depth, case-insensitive) is NEVER copied —
 * it would corrupt the worktree's own git state; it is skipped silently and
 * counted in `result.nestedGitSkipped`. Returns bytes copied. `repoRoot` bounds
 * the "points outside the repo" test.
 */
function copyDir(srcDir: string, destDir: string, repoRoot: string, relBase: string, result: IncludeResult): number {
  let total = 0;
  mkdirSync(destDir, { recursive: true });
  let names: string[];
  try {
    names = readdirSync(srcDir);
  } catch {
    return 0;
  }
  for (const name of names) {
    // A nested `.git` (file or directory, case-insensitive) is never copied — it
    // would corrupt the worktree's own git state. Skip silently-but-counted.
    if (name.toLowerCase() === ".git") {
      result.nestedGitSkipped += 1;
      continue;
    }
    const src = path.join(srcDir, name);
    const dest = path.join(destDir, name);
    const rel = path.posix.join(relBase, name);
    const st = safeLstat(src);
    if (st === null) continue;
    if (st.isSymbolicLink()) {
      // Not followed, not recreated. Record the ones that escape the repo; an
      // in-repo link is simply not reproduced in the self-contained copy.
      const target = resolveLinkTarget(src);
      const escapes = target === null || !isInside(repoRoot, target);
      if (escapes) result.skipped.push({ path: rel, reason: "symlink inside a copied directory points outside the repo (not followed)" });
      continue;
    }
    if (st.isDirectory()) {
      total += copyDir(src, dest, repoRoot, rel, result);
    } else if (st.isFile()) {
      const copied = copyRegularFile(src, dest, st.mode);
      if (copied >= 0) total += copied;
    } else {
      result.skipped.push({ path: rel, reason: "special file (socket/device/fifo)" });
    }
  }
  return total;
}

/** Resolve a symlink's target to an absolute real path, or null. */
function resolveLinkTarget(linkPath: string): string | null {
  try {
    const raw = readlinkSync(linkPath);
    const abs = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(linkPath), raw);
    return safeRealpath(abs) ?? abs;
  } catch {
    return null;
  }
}
