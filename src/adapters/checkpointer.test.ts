/**
 * SQLite checkpointer file-mode hardening (security-audit S2, §5.1).
 *
 * Under a loose process umask (022), the `.voidrift` state dir must still be
 * 0700 and `checkpoint.db` (and its WAL/SHM sidecars once they appear) 0600, so
 * no session/checkpoint content is ever world-readable.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createSqliteCheckpointer } from "./checkpointer.js";

describe("createSqliteCheckpointer — file modes under a loose umask (S2)", () => {
  let root: string;
  let prevUmask: number;

  beforeEach(async () => {
    root = hermeticTmp("ckpt");
    prevUmask = process.umask(0o022); // the loose default that leaked the mode
  });

  afterEach(async () => {
    process.umask(prevUmask);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("creates .voidrift at 0700 and checkpoint.db + sidecars at 0600", async () => {
    const saver = createSqliteCheckpointer(root);

    const stateDir = path.join(root, ".voidrift");
    expect(fs.statSync(stateDir).mode & 0o777).toBe(0o700);
    const db = path.join(stateDir, "checkpoint.db");
    expect(fs.existsSync(db), "checkpoint.db should be pre-created").toBe(true);
    expect(fs.statSync(db).mode & 0o777, "checkpoint.db must be 0600").toBe(0o600);

    // Touch the saver so sqlite creates its WAL/SHM sidecars; they inherit the
    // main database file's mode (they are NOT pre-created: an empty stray
    // sidecar corrupts the WAL index of a live connection).
    await saver.getTuple({ configurable: { thread_id: "mode-probe" } });
    for (const name of ["checkpoint.db-wal", "checkpoint.db-shm"]) {
      const p = path.join(stateDir, name);
      if (fs.existsSync(p)) expect(fs.statSync(p).mode & 0o777, `${name} must be 0600`).toBe(0o600);
    }
  });

  it("tightens a pre-existing loose .voidrift dir to 0700", () => {
    const stateDir = path.join(root, ".voidrift");
    fs.mkdirSync(stateDir, { mode: 0o755 });
    fs.chmodSync(stateDir, 0o755); // mkdir honours umask; force the loose mode
    expect(fs.statSync(stateDir).mode & 0o777).toBe(0o755);

    createSqliteCheckpointer(root);
    expect(fs.statSync(stateDir).mode & 0o777).toBe(0o700);
  });
});
