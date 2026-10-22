/**
 * Durable staging manifest entities (core-blueprint.md §7.4).
 *
 * With no git repo there is no file safety net, so writers never touch disk
 * directly — they stage through a read-through layer whose durable record is a
 * per-run manifest. For each staged file the manifest records BOTH the current
 * disk base hash (for conflict detection on apply) and the staged content's own
 * hash (for integrity), using the ONE hash utility (§8.2 `contentHash`) so the
 * staged base/content hashes never fork their own hashing.
 *
 * This module is pure: it builds a manifest entry, verifies an integrity pair
 * and a base-conflict, and masks the manifest for durable write (§10.10). No
 * filesystem is imported here — the adapter owns temp-and-rename durability.
 */
import path from "node:path";
import { contentHash } from "./hash.js";
import { maskValue } from "../use-cases/secret-mask.js";

/** One staged file's durable record (§7.4). */
export interface StagedFileEntry {
  /** The workspace-relative target path. */
  path: string;
  /** The disk base hash when the write was staged — a changed base is a conflict. */
  baseHash: string;
  /** The staged content's own hash — a disagreement means an unreliable staged file. */
  stagedHash: string;
  /** The staged file's name inside the staging folder (its content lives there). */
  blob: string;
}

/** A per-run staging manifest (§7.4). */
export interface StagingManifest {
  /** The run id — the `.voidrift/cache/staging/{run}/` folder name. */
  run: string;
  /** The owning process pid — for dead-owner prune (§7.4, like worktrees §7.3). */
  pid: number;
  /**
   * The owning session id (§5.8). Staging folders are keyed by run id; the
   * session that created the run is recorded here so `session.delete` can PROVE
   * ownership before removing a folder — a folder with no/other session id is
   * never deleted by a session delete. Optional: an older/orphan manifest
   * without it is simply not owned by any session.
   */
  sessionId?: string;
  /** ISO timestamp of creation — for the TTL prune (§7.4). */
  timestamp: string;
  /** The staged files, in stage order (apply is sequential, §7.4). */
  files: StagedFileEntry[];
}

/** The reason an apply of one file does not proceed (§7.4). */
export type ApplyCheck =
  | { ok: true }
  /** The staged file re-hash disagrees with the manifest — unreliable, not applied. */
  | { ok: false; reason: "unreliable"; path: string }
  /** The disk base hash changed since staging — a conflict, re-dispatch needed. */
  | { ok: false; reason: "conflict"; path: string }
  /** The target resolves outside the staging root — a containment breach, refused (§8.2, §15.1#8). */
  | { ok: false; reason: "escape"; path: string };

/**
 * Lexically resolve a workspace-relative target against the staging root and
 * REQUIRE it to lie inside that root — the no-repo mirror of the §8.2 file-tool
 * containment the worktree path gets from `LocalShellBackend` ("Path traversal
 * not allowed"). An absolute path, a `../` escape, or anything resolving outside
 * `root` returns null; a contained path returns its canonical absolute form.
 * This is the lexical layer; the adapter adds symlink (realpath) resolution so a
 * boundary-crossing symlink is caught too (one source of truth for both layers).
 */
export function resolveWithinRoot(root: string, targetPath: string): string | null {
  const abs = path.resolve(root, targetPath);
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

/** A fresh manifest for a run (§7.4). The owning `sessionId` (§5.8) is recorded
 * so `session.delete` can prove ownership before removing the folder. */
export function newManifest(run: string, pid = process.pid, sessionId?: string): StagingManifest {
  return { run, pid, ...(sessionId !== undefined ? { sessionId } : {}), timestamp: new Date().toISOString(), files: [] };
}

/**
 * Build a staged-file entry (§7.4). `baseContent` is the file's current disk
 * content (empty string when it does not yet exist); `stagedContent` is the new
 * content the writer stages. Both hashes come from the ONE utility.
 */
export function stageEntry(targetPath: string, baseContent: string, stagedContent: string, blob: string): StagedFileEntry {
  return {
    path: targetPath,
    baseHash: contentHash(baseContent),
    stagedHash: contentHash(stagedContent),
    blob,
  };
}

/**
 * Add or replace a file's entry in a manifest — a later stage of the same path
 * supersedes the earlier one, matching read-through's last-write-wins (§7.4).
 */
export function upsertEntry(manifest: StagingManifest, entry: StagedFileEntry): StagingManifest {
  const files = manifest.files.filter((f) => f.path !== entry.path);
  files.push(entry);
  return { ...manifest, files };
}

/**
 * The two re-hash checks run inside the apply critical section (§7.4), in order:
 * 1. INTEGRITY — the staged file re-hash must equal the manifest's staged hash;
 *    a disagreeing pair is unreliable (corrupted / half-written) and not applied.
 * 2. CONFLICT — the current disk hash must still equal the manifest's base hash;
 *    a changed base is a conflict and is reported for re-dispatch.
 */
export function checkApply(entry: StagedFileEntry, stagedContentNow: string, diskContentNow: string): ApplyCheck {
  if (contentHash(stagedContentNow) !== entry.stagedHash) {
    return { ok: false, reason: "unreliable", path: entry.path };
  }
  if (contentHash(diskContentNow) !== entry.baseHash) {
    return { ok: false, reason: "conflict", path: entry.path };
  }
  return { ok: true };
}

/**
 * Mask a manifest for durable write (§7.4, §10.10). Paths and hashes are not
 * secrets, but a path or blob name could in principle carry a secret-looking
 * token; routing the whole manifest through the ONE detector keeps the durable
 * session file consistent with every other egress and nothing to remember.
 */
export function maskManifest(manifest: StagingManifest): StagingManifest {
  return maskValue(manifest) as unknown as StagingManifest;
}
