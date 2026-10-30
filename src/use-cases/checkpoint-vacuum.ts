/**
 * `checkpoint.vacuum` — convert a legacy checkpoint store to incremental
 * auto-vacuum (core-blueprint.md §13.9.1, §5.2).
 *
 * A workspace checkpoint store (`.voidrift/checkpoint.db`) created before core
 * d865bf8 has `PRAGMA auto_vacuum=0` (NONE) and never returns freed pages to the
 * OS. `voidrift init --vacuum` converts it to `auto_vacuum=INCREMENTAL` (`2`),
 * the default for new stores, so a later `deleteThread` shrinks the file.
 *
 * The conversion is a HOST operation (§13.9.1 pin 1): the core owns the SQLite
 * logic; the CLI only parses the flag and prints the report. It is idempotent,
 * refuses on a locked store or insufficient disk, backs the store up before
 * touching it, runs the conversion OUTSIDE any transaction, and verifies the
 * result — leaving the original untouched on any failure.
 *
 * Pure of ambient infrastructure where it matters for tests: the free-disk
 * probe is INJECTED (§13.9.1 pin 3) so a test never depends on the host disk.
 * SQLite I/O uses Node's built-in `node:sqlite` directly (the same engine as
 * `NodeSqliteSaver`); no native bindings, no new dependency.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { coreError, ErrorCode, err, ok, type Result } from "../entities/errors.js";

/** The outcome of a `--vacuum` run (§13.9.1). Sizes are bytes. `nothingToDo`
 * is true when the store was already `auto_vacuum=2` (idempotent no-op — no
 * backup written). `backup` is the absolute path of the backup copy, or null
 * when none was written. */
export interface CheckpointVacuumResult {
  nothingToDo: boolean;
  sizeBefore: number;
  sizeAfter: number;
  backup: string | null;
}

/** Free bytes available on the filesystem holding `absPath`, or null when it
 * cannot be determined. Injected so a test does not depend on the host disk. */
export type FreeDiskProbe = (absPath: string) => number | null;

/** The default free-disk probe over `node:fs` (`statfsSync`). */
export function defaultFreeDiskProbe(absPath: string): number | null {
  try {
    const s = fs.statfsSync(absPath);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/** The combined size of the store and its `-wal` sidecar in bytes (0 for an
 * absent file). */
function dbAndWalSize(dbPath: string): number {
  let total = 0;
  for (const p of [dbPath, `${dbPath}-wal`]) {
    try {
      total += fs.statSync(p).size;
    } catch {
      /* absent sidecar counts 0 */
    }
  }
  return total;
}

/** Read `PRAGMA auto_vacuum` (0 NONE, 1 FULL, 2 INCREMENTAL) from a store opened
 * read-only, so the check holds no write lock. Returns null when the store
 * cannot be opened. */
function readAutoVacuum(dbPath: string): number | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum?: number } | undefined;
    return typeof row?.auto_vacuum === "number" ? row.auto_vacuum : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** True when another process holds a write lock on the store. Probed by opening
 * read-write and attempting `BEGIN IMMEDIATE` (which takes the RESERVED lock
 * SQLite uses for a pending write); a `SQLITE_BUSY` means the store is locked.
 * The probe uses a 0 ms busy timeout so a held lock fails fast rather than
 * waiting. Any open/lock error is treated as "locked" (refuse rather than risk
 * a concurrent writer). */
function isLocked(dbPath: string): boolean {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout=0");
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
    return false;
  } catch {
    return true;
  } finally {
    db?.close();
  }
}

/**
 * Convert the checkpoint store at `dbPath` to `auto_vacuum=INCREMENTAL`
 * (§13.9.1). The steps, in order, each a refusal point that leaves the original
 * untouched:
 *
 *  (0) absent store → a no-op success (`nothingToDo`, nothing to convert);
 *  (a) already `auto_vacuum=2` → idempotent no-op, no backup written;
 *  (b) another process holds a write lock → refuse;
 *  (c) free disk < 2×(db+wal) → refuse;
 *  (d) back the store up to `checkpoint.db.bak-<UTC yyyymmddThhmmss>` (mode 0600,
 *      symlinks NOT followed);
 *  (e) `PRAGMA auto_vacuum=INCREMENTAL; VACUUM` OUTSIDE any transaction;
 *  (f) verify `auto_vacuum` returns `2` and `integrity_check` passes; on any
 *      failure the original store is restored from the backup and the result is
 *      an error (non-zero exit at the CLI).
 */
export function vacuumCheckpointStore(
  dbPath: string,
  freeDisk: FreeDiskProbe = defaultFreeDiskProbe,
  now: Date = new Date(),
): Result<CheckpointVacuumResult> {
  // (0) An absent store is nothing to convert — a clean success (a workspace
  // that has never run a session has no checkpoint.db yet).
  if (!fs.existsSync(dbPath)) {
    return ok({ nothingToDo: true, sizeBefore: 0, sizeAfter: 0, backup: null });
  }

  // Refuse to operate through a symlink: a crafted link could redirect the
  // backup write or the VACUUM to a path outside the state dir (§13.9.1 pin 2).
  try {
    if (fs.lstatSync(dbPath).isSymbolicLink()) {
      return err(coreError(ErrorCode.INVALID_INPUT, `checkpoint store ${dbPath} is a symbolic link; refusing to vacuum`));
    }
  } catch {
    /* lstat failure falls through to the open attempt below */
  }

  // (a) Idempotent: a store already at INCREMENTAL is a no-op (read-only probe,
  // no lock held, no backup written).
  const before = readAutoVacuum(dbPath);
  if (before === null) {
    return err(coreError(ErrorCode.INTERNAL, `cannot read PRAGMA auto_vacuum on ${dbPath}`));
  }
  const sizeBefore = dbAndWalSize(dbPath);
  if (before === 2) {
    return ok({ nothingToDo: true, sizeBefore, sizeAfter: sizeBefore, backup: null });
  }

  // (b) Refuse if another process holds a write lock (checked BEFORE any change).
  if (isLocked(dbPath)) {
    return err(coreError(ErrorCode.INVALID_INPUT, `checkpoint store ${dbPath} is locked by another process; close other VoidRift sessions and retry`));
  }

  // (c) Refuse unless free disk ≥ 2×(db+wal): VACUUM writes a full temporary copy.
  const free = freeDisk(dbPath);
  const needed = 2 * sizeBefore;
  if (free === null) {
    return err(
      coreError(
        ErrorCode.INVALID_INPUT,
        `cannot determine free disk for ${dbPath}: need ≥ ${needed} bytes (2× the ${sizeBefore}-byte store+WAL) free to vacuum`,
      ),
    );
  }
  if (free < needed) {
    return err(
      coreError(
        ErrorCode.INVALID_INPUT,
        `not enough free disk to vacuum ${dbPath}: need ≥ ${needed} bytes (2× the ${sizeBefore}-byte store+WAL), ${free} free`,
      ),
    );
  }

  // (d) Back the store up BEFORE touching it, mode 0600, without following a
  // symlink at the destination.
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z"); // yyyymmddThhmmssZ
  const backup = path.join(path.dirname(dbPath), `checkpoint.db.bak-${stamp}`);
  try {
    const content = fs.readFileSync(dbPath);
    // `wx` fails if the destination exists (never clobber), and the file is
    // created with the restrictive mode from the start.
    fs.writeFileSync(backup, content, { mode: 0o600, flag: "wx" });
    fs.chmodSync(backup, 0o600);
  } catch (e) {
    return err(coreError(ErrorCode.INTERNAL, `failed to back up ${dbPath}: ${e instanceof Error ? e.message : String(e)}`));
  }

  // (e) + (f) Convert, then verify. Any failure restores the original from the
  // backup and returns an error (the original is left untouched to the caller).
  try {
    const db = new DatabaseSync(dbPath);
    try {
      // Outside any transaction: SQLite forbids VACUUM inside one, and the
      // auto_vacuum change only takes effect through this full VACUUM on an
      // existing file (§5.2).
      db.exec("PRAGMA auto_vacuum=INCREMENTAL");
      db.exec("VACUUM");
      // Verify within the same open handle.
      const avRow = db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum?: number } | undefined;
      const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
      if (avRow?.auto_vacuum !== 2) {
        throw new Error(`auto_vacuum is ${String(avRow?.auto_vacuum)} after conversion, expected 2`);
      }
      if (integrity?.integrity_check !== "ok") {
        throw new Error(`integrity_check returned ${String(integrity?.integrity_check)}`);
      }
    } finally {
      db.close();
    }
  } catch (e) {
    // Restore the original from the backup, then surface the failure.
    try {
      const saved = fs.readFileSync(backup);
      fs.writeFileSync(dbPath, saved, { mode: 0o600 });
      // Drop stale WAL/SHM the aborted VACUUM may have left beside the restored db.
      for (const side of [`${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          fs.rmSync(side, { force: true });
        } catch {
          /* best-effort */
        }
      }
    } catch {
      /* best-effort restore; the backup remains for the user */
    }
    return err(
      coreError(ErrorCode.INTERNAL, `vacuum failed for ${dbPath}; the original is unchanged (backup kept at ${backup}): ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  return ok({ nothingToDo: false, sizeBefore, sizeAfter: dbAndWalSize(dbPath), backup });
}
