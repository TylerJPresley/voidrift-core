/**
 * Symlink-safe directory purge (core-blueprint.md §5.8, §7.3, §7.4).
 *
 * The ONE place a harness-owned directory is sized and recursively removed for a
 * `session.delete`. Removal is destructive, so it is deliberately conservative:
 *
 * - SIZE counts regular-file bytes only, via `lstat`, so a symlink inside the
 *   tree contributes its own (tiny) link size — never the size of whatever it
 *   points at. The traversal never follows a symlinked directory.
 * - REMOVE uses `fs.rm(dir, { recursive: true, force: true })`, which UNLINKS a
 *   symlink (removes the link, not its target). A symlink inside the cache dir
 *   can therefore never redirect the delete outside the directory: the target
 *   survives. Callers derive `dir` from a VALIDATED id joined under a fixed
 *   harness-owned root (the containment layer), so the path itself can never
 *   escape; this layer guarantees the recursive walk cannot either.
 */
import { lstatSync, readdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";

/** Total regular-file bytes under `dir`, never following symlinks (§5.8). */
export function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const child = path.join(dir, name);
    let st;
    try {
      st = lstatSync(child); // lstat: do NOT follow symlinks
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      total += st.size; // the link's own size, never its target's
    } else if (st.isDirectory()) {
      total += dirSizeBytes(child);
    } else if (st.isFile()) {
      total += st.size;
    }
  }
  return total;
}

/**
 * Size then recursively remove `dir`, returning the bytes reclaimed. `fs.rm`
 * removes a symlink as a link, so an in-tree symlink's target is never touched
 * (§5.8). A missing dir reclaims 0. Never throws — a partial failure returns the
 * best-effort size so the caller can report non-fatally and continue (§5.8).
 */
export function purgeDir(dir: string): number {
  if (!existsSync(dir)) return 0;
  const bytes = dirSizeBytes(dir);
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}
