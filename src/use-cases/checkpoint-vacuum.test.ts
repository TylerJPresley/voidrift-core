/**
 * `vacuumCheckpointStore` tests (core-blueprint.md §13.9.1, §5.2).
 *
 * Real SQLite (`node:sqlite`) in a hermetic temp dir drives the real path:
 *  - a legacy `auto_vacuum=0` store is converted to `2`, rows survive, a 0600
 *    backup is written, and the file shrinks after a thread is deleted;
 *  - an already-`2` store is a no-op (no backup);
 *  - a locked store refuses and is left untouched;
 *  - insufficient free disk refuses (injected probe) and is left untouched;
 *  - a conversion/verify failure leaves the original untouched and returns err.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { vacuumCheckpointStore } from "./checkpoint-vacuum.js";

/** Build a legacy checkpoint store (auto_vacuum=0) with `rows` padded rows in a
 * `checkpoints` table so the file has pages to reclaim after a delete. */
function makeLegacyStore(dbPath: string, rows: number): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA auto_vacuum=NONE");
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE checkpoints (thread_id TEXT, blob BLOB)");
    const stmt = db.prepare("INSERT INTO checkpoints (thread_id, blob) VALUES (?, ?)");
    const pad = "x".repeat(4096);
    for (let i = 0; i < rows; i++) stmt.run(i < rows / 2 ? "keep" : "drop", pad);
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } finally {
    db.close();
  }
  fs.chmodSync(dbPath, 0o600);
}

function autoVacuumOf(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum;
  } finally {
    db.close();
  }
}

describe("vacuumCheckpointStore (§13.9.1)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = hermeticTmp("vacuum");
    dbPath = path.join(dir, "checkpoint.db");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("legacy auto_vacuum=0 → converted to 2, rows intact, 0600 backup, shrinks after delete", () => {
    makeLegacyStore(dbPath, 40);
    expect(autoVacuumOf(dbPath)).toBe(0);

    const r = vacuumCheckpointStore(dbPath, () => 10 * 1024 * 1024 * 1024);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.nothingToDo).toBe(false);
    expect(autoVacuumOf(dbPath)).toBe(2);

    // Backup exists, mode 0600, non-empty.
    expect(r.value.backup).not.toBeNull();
    const backup = r.value.backup!;
    expect(fs.existsSync(backup)).toBe(true);
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600);

    // Rows survived the conversion.
    const after = new DatabaseSync(dbPath, { readOnly: true });
    const count = (after.prepare("SELECT COUNT(*) AS n FROM checkpoints").get() as { n: number }).n;
    after.close();
    expect(count).toBe(40);

    // Deleting a thread now returns pages to the OS (incremental auto-vacuum),
    // so the file shrinks.
    const sizeBefore = fs.statSync(dbPath).size;
    const del = new DatabaseSync(dbPath);
    del.exec("DELETE FROM checkpoints WHERE thread_id = 'drop'");
    del.exec("PRAGMA incremental_vacuum");
    del.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    del.close();
    expect(fs.statSync(dbPath).size).toBeLessThan(sizeBefore);
  });

  it("already auto_vacuum=2 → nothing to do, no backup written", () => {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA auto_vacuum=INCREMENTAL");
    db.exec("CREATE TABLE t (x)");
    db.close();
    fs.chmodSync(dbPath, 0o600);
    expect(autoVacuumOf(dbPath)).toBe(2);

    const r = vacuumCheckpointStore(dbPath, () => 10 * 1024 * 1024 * 1024);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.nothingToDo).toBe(true);
    expect(r.value.backup).toBeNull();
    expect(fs.readdirSync(dir).some((f) => f.startsWith("checkpoint.db.bak-"))).toBe(false);
  });

  it("locked store → refuses, store untouched", () => {
    makeLegacyStore(dbPath, 8);
    const before = fs.readFileSync(dbPath);

    // Hold a write lock from another connection (RESERVED via BEGIN IMMEDIATE).
    const holder = new DatabaseSync(dbPath);
    holder.exec("PRAGMA busy_timeout=0");
    holder.exec("BEGIN IMMEDIATE");
    try {
      const r = vacuumCheckpointStore(dbPath, () => 10 * 1024 * 1024 * 1024);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.message).toMatch(/locked/i);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(autoVacuumOf(dbPath)).toBe(0);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
    expect(fs.readdirSync(dir).some((f) => f.startsWith("checkpoint.db.bak-"))).toBe(false);
  });

  it("insufficient free disk → refuses, store untouched", () => {
    makeLegacyStore(dbPath, 20);
    const before = fs.readFileSync(dbPath);

    // Probe reports far less than 2×(db+wal).
    const r = vacuumCheckpointStore(dbPath, () => 1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/free disk/i);
    expect(autoVacuumOf(dbPath)).toBe(0);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
    expect(fs.readdirSync(dir).some((f) => f.startsWith("checkpoint.db.bak-"))).toBe(false);
  });

  it("absent store → nothing to do (a fresh workspace with no sessions)", () => {
    const r = vacuumCheckpointStore(dbPath, () => 10 * 1024 * 1024 * 1024);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.nothingToDo).toBe(true);
    expect(r.value.backup).toBeNull();
  });

  it("VACUUM/integrity failure → original untouched, non-ok, backup restored", () => {
    // A store that opens and reports auto_vacuum=0 but whose B-tree pages are
    // corrupt, so `VACUUM` (or the following `integrity_check`) fails. We build
    // a valid legacy store, then flip bytes in the middle of the file (past the
    // 100-byte header and the first page so the file still OPENS) to corrupt a
    // page the conversion must read.
    makeLegacyStore(dbPath, 30);
    const buf = fs.readFileSync(dbPath);
    for (let off = 5000; off < Math.min(buf.length, 20000); off += 7) {
      buf[off] = buf[off]! ^ 0xff;
    }
    fs.writeFileSync(dbPath, buf, { mode: 0o600 });
    const before = fs.readFileSync(dbPath);

    const r = vacuumCheckpointStore(dbPath, () => 10 * 1024 * 1024 * 1024);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // The original bytes are restored from the backup; auto_vacuum unchanged.
    expect(autoVacuumOf(dbPath)).toBe(0);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  });

  it("a backup path collision never clobbers an existing backup (flag wx)", () => {
    makeLegacyStore(dbPath, 8);
    const before = fs.readFileSync(dbPath);
    const stamp = new Date("2026-10-30T12:00:00.000Z");
    const collide = path.join(dir, "checkpoint.db.bak-20261030T120000Z");
    fs.writeFileSync(collide, "pre-existing");

    const r = vacuumCheckpointStore(dbPath, () => 10 * 1024 * 1024 * 1024, stamp);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(fs.readFileSync(collide, "utf8")).toBe("pre-existing");
    expect(autoVacuumOf(dbPath)).toBe(0);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  });
});
