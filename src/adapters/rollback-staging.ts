/**
 * Crash-safe staging for rollback restore (core-blueprint.md §10.12 item 4).
 *
 * BOTH snapshot stores (git + cache) apply a restore as a two-phase, all-or-
 * nothing transaction: phase 1 stages new content and renames each existing
 * file aside; phase 2 removes the asides. A failure mid-apply rolls every
 * applied step back so the ORIGINAL tree survives.
 *
 * The staging and aside files USED to be created beside the user's files
 * (`<file>.vr-rollback-bak.*`, `<file>.vr-rollback.*.tmp`). A SIGKILL between
 * phases left them beside user files where they could be committed. This module
 * relocates ALL staging/aside files to a per-session directory under the
 * protected cache dir (`.voidrift/cache/snapshots/<session>/tmp/`) — the same
 * filesystem as the workspace, so the final rename is atomic — and adds a
 * startup sweep that recovers a crash:
 *   - a `pending.json` journal records each aside's original path BEFORE it is
 *     moved, so a crash between phases is recoverable even on a cross-device
 *     fallback;
 *   - on `sweepSessionTmp`, any aside whose ORIGINAL path is missing from the
 *     tree is restored to it (crash recovery), every other leftover is deleted,
 *     and ONE value-free warning reports the count (never the paths).
 *
 * Same-device is verified (st_dev): when the cache dir is on a different device
 * than a target path, that step falls back to a sibling temp but registers it in
 * `pending.json` FIRST so the sweep still finds and cleans/recovers it.
 *
 * I/O is direct `node:fs` (raw Buffers, explicit modes). PROTECTED CONTROL
 * LOCATION — owner-only (dir 0700, files 0600).
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  rmSync,
  existsSync,
  statSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import path from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** One plan step to apply: write `target` bytes to `abs` (null = delete it). */
export interface StagePlan {
  /** Absolute path of the file to restore. */
  abs: string;
  /** The target content, or null to delete the file. */
  target: Buffer | null;
  /** The file mode to set (git method preserves the exec bit). */
  mode?: number;
}

/** A pending aside/stage journal entry (§10.12): what a crash sweep needs to
 * recover. `backup` is where the original was renamed; `original` is where it
 * belongs. `staged` is a staged-content temp not yet committed. */
interface PendingEntry {
  /** The original (user-tree) path this entry concerns. */
  original: string;
  /** An aside copy of the original (restore it to `original` if missing), or null. */
  backup?: string;
  /** A staged-content temp not yet renamed into place (delete on sweep), or null. */
  staged?: string;
}

export interface StageDeps {
  /** The per-session tmp dir: `.voidrift/cache/snapshots/<session>/tmp/`. */
  tmpDir: string;
  /** Emit ONE value-free warning on a crash sweep (count only, never paths). */
  onSwept?: (count: number) => void;
  /** Injectable rename for tests (simulate EXDEV). Defaults to fs.renameSync. */
  rename?: (from: string, to: string) => void;
}

/** The pending journal path inside the session tmp dir. */
function pendingPath(tmpDir: string): string {
  return path.join(tmpDir, "pending.json");
}

/** Load the pending journal (best-effort; a corrupt/absent file → []). */
function readPending(tmpDir: string): PendingEntry[] {
  try {
    const raw = readFileSync(pendingPath(tmpDir), "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as PendingEntry[]) : [];
  } catch {
    return [];
  }
}

/** Persist the pending journal atomically (temp + rename, 0600). */
function writePending(tmpDir: string, entries: PendingEntry[]): void {
  mkdirSync(tmpDir, { recursive: true, mode: DIR_MODE });
  const tmp = `${pendingPath(tmpDir)}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries), { mode: FILE_MODE });
  renameSync(tmp, pendingPath(tmpDir));
}

/** Same device? Compare st_dev of `tmpDir` and the directory that will hold the
 * target's final rename. A different device means a cross-device rename would
 * throw EXDEV, so the caller must fall back to a sibling temp + pending entry. */
function sameDevice(tmpDir: string, targetDir: string): boolean {
  try {
    return statSync(tmpDir).dev === statSync(targetDir).dev;
  } catch {
    return false;
  }
}

/** Is this error a cross-device link error (EXDEV)? */
function isExdev(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "EXDEV";
}

/**
 * Apply a restore plan as a crash-safe transaction (§10.12 item 4). Staging and
 * aside files live under `deps.tmpDir` (same device → atomic rename); a per-step
 * cross-device target falls back to a sibling temp registered in `pending.json`
 * first. On success the asides are removed and `pending.json` is cleared. On a
 * mid-apply failure every applied step is rolled back (original tree restored)
 * and the error re-thrown. Returns the list of restored absolute paths that were
 * WRITES (deletes are reported by the caller via `onDelete`).
 */
export function applyStaged(
  plans: StagePlan[],
  deps: StageDeps,
  hooks: {
    /** Called for each successfully-written file (not a delete). */
    onWrite: (abs: string) => void;
    /** Called for each successfully-committed delete. */
    onDelete: (abs: string) => void;
    /** Called after a dir is created, so the caller can track/clean it. */
    onMkdir?: (dir: string) => void;
  },
): void {
  const rename = deps.rename ?? renameSync;
  const tmpDir = deps.tmpDir;
  mkdirSync(tmpDir, { recursive: true, mode: DIR_MODE });

  const stamp = `${process.pid}.${Date.now()}`;
  interface Applied {
    abs: string;
    backup: string | null;
    wrote: boolean;
  }
  const applied: Applied[] = [];
  const pending: PendingEntry[] = [];
  let seq = 0;

  // Where a per-step temp lives: the session tmp dir when same-device, else a
  // sibling of the target (registered in pending first).
  const stageName = (abs: string, kind: "bak" | "tmp"): { inTmp: string; sibling: string } => {
    const base = path.basename(abs);
    const inTmp = path.join(tmpDir, `${base}.vr-rollback-${kind}.${stamp}.${seq}`);
    const sibling = `${abs}.vr-rollback-${kind === "bak" ? "bak" : ""}.${stamp}.${seq}.tmp`;
    return { inTmp, sibling };
  };

  const flushPending = (): void => writePending(tmpDir, pending);

  try {
    for (const pl of plans) {
      const targetDir = path.dirname(pl.abs);
      const hadExisting = existsSync(pl.abs);
      const onDev = sameDevice(tmpDir, targetDir);
      let backup: string | null = null;

      // Move the existing original aside (so a failure can restore it).
      if (hadExisting) {
        const { inTmp, sibling } = stageName(pl.abs, "bak");
        if (onDev) {
          // Same device: register pending FIRST (crash between register and
          // rename only leaves a stale entry the sweep ignores), then rename.
          pending.push({ original: pl.abs, backup: inTmp });
          flushPending();
          rename(pl.abs, inTmp);
          backup = inTmp;
        } else {
          // Cross-device: a sibling temp (rename within the same dir is atomic);
          // register it in pending FIRST so the sweep recovers it on a crash.
          pending.push({ original: pl.abs, backup: sibling });
          flushPending();
          rename(pl.abs, sibling);
          backup = sibling;
        }
      }

      if (pl.target === null) {
        // Delete: the original is parked under `backup`; removed at commit.
        applied.push({ abs: pl.abs, backup, wrote: false });
      } else {
        if (!existsSync(targetDir)) {
          mkdirSync(targetDir, { recursive: true });
          hooks.onMkdir?.(targetDir);
        }
        // Stage the new content, then rename into place.
        const { inTmp, sibling } = stageName(pl.abs, "tmp");
        let staged = inTmp;
        if (!onDev) {
          staged = sibling;
          pending.push({ original: pl.abs, staged });
          flushPending();
        }
        writeFileSync(staged, pl.target, pl.mode !== undefined ? { mode: pl.mode } : {});
        try {
          rename(staged, pl.abs);
        } catch (e) {
          if (isExdev(e) && onDev) {
            // The tmp dir claimed same-device but the rename crossed one: retry
            // via a registered sibling temp.
            const sib = `${pl.abs}.vr-rollback.${stamp}.${seq}.tmp`;
            pending.push({ original: pl.abs, staged: sib });
            flushPending();
            writeFileSync(sib, pl.target, pl.mode !== undefined ? { mode: pl.mode } : {});
            renameSync(sib, pl.abs);
          } else {
            throw e;
          }
        }
        if (pl.mode !== undefined) {
          try {
            chmodSync(pl.abs, pl.mode);
          } catch {
            /* best-effort */
          }
        }
        applied.push({ abs: pl.abs, backup, wrote: true });
        hooks.onWrite(pl.abs);
      }
      seq++;
    }
  } catch (e) {
    // Undo every applied step IN REVERSE so the original tree is restored.
    for (let i = applied.length - 1; i >= 0; i--) {
      const a = applied[i]!;
      try {
        if (a.wrote) rmSync(a.abs, { force: true });
        if (a.backup) renameSync(a.backup, a.abs);
      } catch {
        /* best-effort rollback */
      }
    }
    // Clear the journal — the tree is back to its original state.
    try {
      rmSync(pendingPath(tmpDir), { force: true });
    } catch {
      /* ignore */
    }
    throw e;
  }

  // Phase 2 (commit): remove the asides (completing deletes), then clear journal.
  for (const a of applied) {
    if (a.backup) {
      try {
        rmSync(a.backup, { force: true });
      } catch {
        /* ignore: content is already correct in place */
      }
    }
    if (!a.wrote) hooks.onDelete(a.abs);
  }
  try {
    rmSync(pendingPath(tmpDir), { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Startup sweep (§10.12 item 4): when a store opens a session dir, recover any
 * leftover staging/aside files from a crash. For each `pending.json` entry whose
 * ORIGINAL path is MISSING from the tree, restore the aside copy to it (crash
 * recovery); then delete every remaining file in `tmp/` (stale stages, committed
 * asides a crash left behind). Reports ONE value-free warning with the COUNT of
 * leftovers (never paths) via `onSwept`. Idempotent and best-effort. PURE of the
 * store — operates only under `tmpDir`.
 */
export function sweepSessionTmp(deps: StageDeps): void {
  const tmpDir = deps.tmpDir;
  if (!existsSync(tmpDir)) return;

  const pending = readPending(tmpDir);
  let leftovers = 0;

  // Count files present under tmp/ (excluding pending.json itself) for the
  // warning, and so we can report whether a sweep happened at all.
  let entries: string[] = [];
  try {
    entries = readdirSync(tmpDir).filter((n) => n !== "pending.json");
  } catch {
    entries = [];
  }
  leftovers = entries.length;

  // Crash recovery: restore each aside whose original is missing from the tree.
  for (const e of pending) {
    if (e.backup && existsSync(e.backup) && !existsSync(e.original)) {
      try {
        mkdirSync(path.dirname(e.original), { recursive: true });
        renameSync(e.backup, e.original);
      } catch {
        /* best-effort recovery; fall through to deletion of the rest */
      }
    }
  }

  // Delete everything still under tmp/ (including recovered-from stages and
  // committed asides) and the journal.
  try {
    for (const n of readdirSync(tmpDir)) {
      try {
        rmSync(path.join(tmpDir, n), { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* ignore */
  }

  if (leftovers > 0) deps.onSwept?.(leftovers);
}

/** The per-session tmp dir path under the cache snapshots dir. */
export function sessionTmpDir(snapshotsSessionDir: string): string {
  return path.join(snapshotsSessionDir, "tmp");
}
