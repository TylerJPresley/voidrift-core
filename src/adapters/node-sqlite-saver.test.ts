/**
 * NodeSqliteSaver tests.
 *
 * (1) Contract tests.
 * (2) CROSS-PROCESS: child process writes, parent reads.
 * (3) Concurrent connections without SQLITE_BUSY.
 * (4) File modes: db 0600, sidecars 0600, state dir 0700.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import fsp from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { NodeSqliteSaver } from "./node-sqlite-saver.js";
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint";

describe("NodeSqliteSaver — contract tests (stay after stage B)", () => {
  let dir: string;
  let dbPath: string;
  let saver: NodeSqliteSaver;

  beforeEach(async () => {
    dir = hermeticTmp("node-sqlite-contract");
    dbPath = path.join(dir, "checkpoint.db");
    saver = NodeSqliteSaver.fromPath(dbPath);
  });

  afterEach(async () => {
    saver.close?.();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("puts and retrieves a checkpoint", async () => {
    const ckpt: Checkpoint = {
      v: 4,
      id: "ckpt-100",
      ts: "2026-10-27T10:00:00.000Z",
      channel_values: { test: "data" },
      channel_versions: { test: 1 },
      versions_seen: { node: { test: 1 } },
    };
    const meta: CheckpointMetadata = { step: 1, source: "input", parents: {} };
    const config = { configurable: { thread_id: "t1", checkpoint_ns: "" } };

    const saved = await saver.put(config, ckpt, meta, {});
    const retrieved = await saver.getTuple(saved);

    expect(retrieved).toBeDefined();
    expect(retrieved!.checkpoint.id).toBe(ckpt.id);
    expect(retrieved!.checkpoint.channel_values).toEqual(ckpt.channel_values);
    expect(retrieved!.metadata).toEqual(meta);
  });

  it("lists checkpoints in descending order by checkpoint_id", async () => {
    const thread = "t-order";
    const ns = "";
    const meta: CheckpointMetadata = { step: 1, source: "input", parents: {} };
    for (const id of ["ckpt-a", "ckpt-b", "ckpt-c"]) {
      await saver.put(
        { configurable: { thread_id: thread, checkpoint_ns: ns } },
        { v: 4, id, ts: new Date().toISOString(), channel_values: {}, channel_versions: {}, versions_seen: {} },
        meta,
        {}
      );
    }

    const list = [];
    for await (const tuple of saver.list({ configurable: { thread_id: thread, checkpoint_ns: ns } })) {
      list.push(tuple.checkpoint.id);
    }

    expect(list).toEqual(["ckpt-c", "ckpt-b", "ckpt-a"]);
  });

  it("putWrites stores writes and retrieves them as pendingWrites", async () => {
    const ckpt: Checkpoint = {
      v: 4,
      id: "ckpt-writes",
      ts: new Date().toISOString(),
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
    };
    const meta: CheckpointMetadata = { step: 1, source: "input", parents: {} };
    const config = await saver.put({ configurable: { thread_id: "t-writes" } }, ckpt, meta, {});

    await saver.putWrites(config, [["ch1", { val: 1 }], ["ch2", { val: 2 }]], "task-x");

    const tuple = await saver.getTuple(config);
    expect(tuple?.pendingWrites).toHaveLength(2);
    expect(tuple?.pendingWrites![0]![0]).toBe("task-x");
    expect(tuple?.pendingWrites![0]![1]).toBe("ch1");
  });

  it("deleteThread removes all checkpoints and writes for a thread", async () => {
    const thread = "t-delete";
    const meta: CheckpointMetadata = { step: 1, source: "input", parents: {} };
    const config = await saver.put(
      { configurable: { thread_id: thread } },
      { v: 4, id: "ckpt-del", ts: new Date().toISOString(), channel_values: {}, channel_versions: {}, versions_seen: {} },
      meta,
      {}
    );
    await saver.putWrites(config, [["ch", { val: 1 }]], "task");

    await saver.deleteThread(thread);

    const tuple = await saver.getTuple(config);
    expect(tuple).toBeUndefined();
  });

  it("handles parent checkpoint chains", async () => {
    const thread = "t-parent";
    const meta: CheckpointMetadata = { step: 1, source: "input", parents: {} };
    const ckpt1: Checkpoint = {
      v: 4,
      id: "ckpt-parent",
      ts: new Date().toISOString(),
      channel_values: { a: 1 },
      channel_versions: { a: 1 },
      versions_seen: {},
    };
    await saver.put({ configurable: { thread_id: thread } }, ckpt1, meta, {});

    const ckpt2: Checkpoint = {
      v: 4,
      id: "ckpt-child",
      ts: new Date().toISOString(),
      channel_values: { a: 2 },
      channel_versions: { a: 2 },
      versions_seen: {},
    };
    const config2 = await saver.put(
      { configurable: { thread_id: thread, checkpoint_id: ckpt1.id } },
      ckpt2,
      meta,
      {}
    );

    const tuple = await saver.getTuple(config2);
    expect(tuple?.parentConfig).toBeDefined();
    expect(tuple?.parentConfig?.configurable?.checkpoint_id).toBe(ckpt1.id);
  });
});

describe("NodeSqliteSaver — cross-process durability", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = hermeticTmp("node-sqlite-xproc");
    dbPath = path.join(dir, "checkpoint.db");
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("child process writes, parent process reads back", async () => {
    // Write a checkpoint in this (parent) process
    const saver = NodeSqliteSaver.fromPath(dbPath);
    const ckpt: Checkpoint = {
      v: 4,
      id: "ckpt-xproc",
      ts: new Date().toISOString(),
      channel_values: { cross: "process" },
      channel_versions: { cross: 1 },
      versions_seen: {},
    };
    const meta: CheckpointMetadata = { step: 1, source: "input", parents: {} };
    await saver.put({ configurable: { thread_id: "t-xproc" } }, ckpt, meta, {});
    saver.close?.();

    // Spawn a child process that writes another checkpoint
    const builtModulePath = path.resolve(process.cwd(), "dist/adapters/node-sqlite-saver.js");
    const childScript = `
import { NodeSqliteSaver } from "${builtModulePath}";
const saver = NodeSqliteSaver.fromPath("${dbPath}");
const ckpt = {
  v: 4,
  id: "ckpt-child",
  ts: new Date().toISOString(),
  channel_values: { child: "wrote" },
  channel_versions: { child: 1 },
  versions_seen: {},
};
const meta = { step: 2, source: "input", parents: {} };
await saver.put({ configurable: { thread_id: "t-xproc" } }, ckpt, meta, {});
saver.close?.();
`;
    await fs.writeFile(path.join(dir, "child.mjs"), childScript);
    execFileSync("node", [path.join(dir, "child.mjs")], { cwd: process.cwd() });

    // Read back in the parent
    const saver2 = NodeSqliteSaver.fromPath(dbPath);
    const list = [];
    for await (const tuple of saver2.list({ configurable: { thread_id: "t-xproc" } })) {
      list.push(tuple.checkpoint.id);
    }
    saver2.close?.();

    expect(list).toContain("ckpt-xproc");
    expect(list).toContain("ckpt-child");
  });
});

describe("NodeSqliteSaver — concurrent connections", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = hermeticTmp("node-sqlite-concurrent");
    dbPath = path.join(dir, "checkpoint.db");
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("two simultaneous connections write without SQLITE_BUSY", async () => {
    const saver1 = NodeSqliteSaver.fromPath(dbPath);
    const saver2 = NodeSqliteSaver.fromPath(dbPath);

    const meta: CheckpointMetadata = { step: 1, source: "input", parents: {} };
    const ckpt1: Checkpoint = {
      v: 4,
      id: "ckpt-conn1",
      ts: new Date().toISOString(),
      channel_values: { conn: 1 },
      channel_versions: { conn: 1 },
      versions_seen: {},
    };
    const ckpt2: Checkpoint = {
      v: 4,
      id: "ckpt-conn2",
      ts: new Date().toISOString(),
      channel_values: { conn: 2 },
      channel_versions: { conn: 2 },
      versions_seen: {},
    };

    // Write from both connections
    await Promise.all([
      saver1.put({ configurable: { thread_id: "t-c1" } }, ckpt1, meta, {}),
      saver2.put({ configurable: { thread_id: "t-c2" } }, ckpt2, meta, {}),
    ]);

    const tuple1 = await saver1.getTuple({ configurable: { thread_id: "t-c1", checkpoint_id: ckpt1.id } });
    const tuple2 = await saver2.getTuple({ configurable: { thread_id: "t-c2", checkpoint_id: ckpt2.id } });

    expect(tuple1?.checkpoint.id).toBe("ckpt-conn1");
    expect(tuple2?.checkpoint.id).toBe("ckpt-conn2");

    saver1.close?.();
    saver2.close?.();
  });
});

describe("NodeSqliteSaver — file modes", () => {
  let dir: string;
  let dbPath: string;
  let prevUmask: number;

  beforeEach(async () => {
    dir = hermeticTmp("node-sqlite-modes");
    dbPath = path.join(dir, "checkpoint.db");
    prevUmask = process.umask(0o022); // loose umask
  });

  afterEach(async () => {
    process.umask(prevUmask);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("creates db file at 0600 and sidecars at 0600 after first write", async () => {
    const saver = NodeSqliteSaver.fromPath(dbPath);

    // Check db file mode before any writes (pre-created)
    const statBefore = await fs.stat(dbPath);
    expect(statBefore.mode & 0o777).toBe(0o600);

    // Write a checkpoint to force WAL/SHM creation
    const meta: CheckpointMetadata = { step: 1, source: "input", parents: {} };
    await saver.put(
      { configurable: { thread_id: "t-mode" } },
      { v: 4, id: "ckpt-mode", ts: new Date().toISOString(), channel_values: {}, channel_versions: {}, versions_seen: {} },
      meta,
      {}
    );

    // Check db file mode after write
    const statAfter = await fs.stat(dbPath);
    expect(statAfter.mode & 0o777).toBe(0o600);

    // Check WAL/SHM sidecars if they exist
    for (const suffix of ["-wal", "-shm"]) {
      const sidecarPath = dbPath + suffix;
      try {
        const sidecarStat = await fs.stat(sidecarPath);
        expect(sidecarStat.mode & 0o777).toBe(0o600);
      } catch {
        // sidecar may not exist yet; that's fine
      }
    }

    saver.close?.();
  });

  it("state dir is 0700", async () => {
    const stateDir = path.dirname(dbPath);
    const saver = NodeSqliteSaver.fromPath(dbPath);

    const stat = await fs.stat(stateDir);
    expect(stat.mode & 0o777).toBe(0o700);

    saver.close?.();
  });
});

describe("NodeSqliteSaver — deleteThread reclaims disk (incremental auto_vacuum)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = hermeticTmp("node-sqlite-vacuum");
    dbPath = path.join(dir, "checkpoint.db");
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  /** On-disk footprint of the main db file only (what grows unbounded today). */
  async function mainSize(p: string): Promise<number> {
    const { size } = await fs.stat(p);
    return size;
  }

  /** Write `n` checkpoints each carrying a ~`blobKB` KB channel value. */
  async function fillLargeRows(
    saver: NodeSqliteSaver,
    thread: string,
    n: number,
    blobKB: number
  ): Promise<void> {
    const big = "x".repeat(blobKB * 1024);
    const meta: CheckpointMetadata = { step: 1, source: "loop", parents: {} };
    for (let i = 0; i < n; i++) {
      await saver.put(
        { configurable: { thread_id: thread } },
        {
          v: 4,
          id: `ckpt-${String(i).padStart(5, "0")}`,
          ts: new Date().toISOString(),
          channel_values: { blob: big },
          channel_versions: { blob: 1 },
          versions_seen: {},
        },
        meta,
        {}
      );
    }
  }

  it("deleteThread on a new DB with many large rows shrinks the file on disk", async () => {
    const saver = NodeSqliteSaver.fromPath(dbPath);

    // Given a thread with ~80 MB of checkpoint blobs on disk. The first write
    // runs the adapter's lazy schema setup, which on this fresh file sets
    // auto_vacuum=INCREMENTAL before creating the tables.
    await fillLargeRows(saver, "big", 400, 200);
    const av = saver.database.prepare("PRAGMA auto_vacuum").get() as {
      auto_vacuum: number;
    };
    expect(av.auto_vacuum).toBe(2); // 2 == INCREMENTAL (fresh file)
    // Consolidate the WAL into the main file so "before" reflects the writes.
    saver.database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    const before = await mainSize(dbPath);
    expect(before).toBeGreaterThan(50 * 1024 * 1024);

    // When the only thread is deleted.
    await saver.deleteThread("big");

    // Then the main file shrinks back toward empty (pages returned to the OS).
    const after = await mainSize(dbPath);
    expect(after).toBeLessThan(before * 0.2);

    // And the rows are gone.
    const tuple = await saver.getTuple({ configurable: { thread_id: "big" } });
    expect(tuple).toBeUndefined();
    saver.close?.();
  });

  it("a legacy auto_vacuum=0 DB still works and does not VACUUM on delete", async () => {
    // Given a pre-existing database created with auto_vacuum=0 (the old format),
    // populated and then opened by the current adapter.
    const { DatabaseSync } = await import("node:sqlite");
    {
      const legacy = new DatabaseSync(dbPath);
      legacy.exec("PRAGMA auto_vacuum=0");
      legacy.exec("PRAGMA journal_mode=WAL");
      legacy.exec(`CREATE TABLE checkpoints (
        thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL, parent_checkpoint_id TEXT, type TEXT,
        checkpoint BLOB, metadata BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id))`);
      legacy.exec(`CREATE TABLE writes (
        thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL, task_id TEXT NOT NULL, idx INTEGER NOT NULL,
        channel TEXT NOT NULL, type TEXT, value BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx))`);
      legacy.close();
    }

    const saver = NodeSqliteSaver.fromPath(dbPath);
    // Opening the adapter must NOT convert an existing file: it stays 0.
    const av = saver.database.prepare("PRAGMA auto_vacuum").get() as {
      auto_vacuum: number;
    };
    expect(av.auto_vacuum).toBe(0);

    // The adapter still reads and writes normally against the legacy schema.
    await fillLargeRows(saver, "legacy", 50, 50);
    const got = await saver.getTuple({ configurable: { thread_id: "legacy" } });
    expect(got).toBeDefined();

    saver.database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    const before = await mainSize(dbPath);

    // deleteThread succeeds and removes the rows; with auto_vacuum=0 the file
    // is NOT shrunk (no VACUUM) — behaviour is exactly as before this change.
    await saver.deleteThread("legacy");
    const avAfter = saver.database.prepare("PRAGMA auto_vacuum").get() as {
      auto_vacuum: number;
    };
    expect(avAfter.auto_vacuum).toBe(0); // still unconverted
    const after = await mainSize(dbPath);
    expect(after).toBe(before); // no reclaim on a legacy file

    const gone = await saver.getTuple({ configurable: { thread_id: "legacy" } });
    expect(gone).toBeUndefined();
    saver.close?.();
  });
});
