/**
 * NodeSqliteSaver — durable checkpointer over Node's built-in `node:sqlite`.
 *
 * Replaces `@langchain/langgraph-checkpoint-sqlite` (which depends on native
 * better-sqlite3) with a pure-Node implementation: NO native bindings, NO install
 * scripts. Uses the SAME table schema and observable semantics as the reference
 * implementation (MIT license; behavior mirrored, not copied).
 *
 * Node >=24 LTS (stability 1.2, release candidate; no flag required).
 * STAGE A: proves equivalence; stage B removes the old dependency.
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
  type CheckpointListOptions,
  type PendingWrite,
  WRITES_IDX_MAP,
  copyCheckpoint,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";

type ChannelVersions = Record<string, number | string>;

/** NodeSqliteSaver extends BaseCheckpointSaver over Node's built-in DatabaseSync. */
export class NodeSqliteSaver extends BaseCheckpointSaver {
  private db: DatabaseSync;
  private isSetup = false;

  constructor(db: DatabaseSync) {
    super();
    this.db = db;
  }

  /**
   * Open a NodeSqliteSaver from a file path. Pre-creates the db file at mode 0600
   * and the state dir at 0700 (so checkpoints are never world-readable). Enables
   * WAL mode and a busy timeout for concurrent access.
   */
  static fromPath(dbPath: string): NodeSqliteSaver {
    const stateDir = path.dirname(dbPath);
    fs.mkdirSync(stateDir, { recursive: true });
    try {
      fs.chmodSync(stateDir, 0o700);
    } catch {
      /* best-effort: non-POSIX fs may reject */
    }

    // Pre-create the db file at mode 0600 BEFORE sqlite opens it (WAL/SHM inherit).
    try {
      fs.closeSync(fs.openSync(dbPath, "a", 0o600));
      fs.chmodSync(dbPath, 0o600);
    } catch {
      /* best-effort */
    }

    const db = new DatabaseSync(dbPath);
    return new NodeSqliteSaver(db);
  }

  /** Read-only access to the underlying database (for tests). */
  get database(): DatabaseSync {
    return this.db;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }

  private setup(): void {
    if (this.isSetup) return;

    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000"); // 5s busy timeout for multi-process

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type TEXT,
        checkpoint BLOB,
        metadata BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        type TEXT,
        value BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      )
    `);

    this.isSetup = true;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.setup();

    const { thread_id, checkpoint_ns = "", checkpoint_id } = config.configurable ?? {};
    if (!thread_id) return undefined;

    const sql = `
      SELECT
        thread_id,
        checkpoint_ns,
        checkpoint_id,
        parent_checkpoint_id,
        type,
        checkpoint,
        metadata
      FROM checkpoints
      WHERE thread_id = ? AND checkpoint_ns = ?
        ${checkpoint_id ? "AND checkpoint_id = ?" : "ORDER BY checkpoint_id DESC LIMIT 1"}
    `;

    const args: (string | number)[] = [thread_id, checkpoint_ns];
    if (checkpoint_id) args.push(checkpoint_id);

    const stmt = this.db.prepare(sql);
    const row = stmt.get(...args) as {
      thread_id: string;
      checkpoint_ns: string;
      checkpoint_id: string;
      parent_checkpoint_id: string | null;
      type: string | null;
      checkpoint: Uint8Array;
      metadata: Uint8Array;
    } | undefined;

    if (!row) return undefined;

    const finalConfig: RunnableConfig = checkpoint_id
      ? config
      : {
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns,
            checkpoint_id: row.checkpoint_id,
          },
        };

    // Load pending writes
    const writesSql = `
      SELECT task_id, channel, type, value
      FROM writes
      WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
    `;
    const writesStmt = this.db.prepare(writesSql);
    const writesRows = writesStmt.all(row.thread_id, row.checkpoint_ns, row.checkpoint_id) as {
      task_id: string;
      channel: string;
      type: string | null;
      value: Uint8Array;
    }[];

    const pendingWrites: [string, string, unknown][] = await Promise.all(
      writesRows.map(async (w) => [
        w.task_id,
        w.channel,
        await this.serde.loadsTyped(w.type ?? "json", w.value),
      ])
    );

    const checkpoint = (await this.serde.loadsTyped(
      row.type ?? "json",
      row.checkpoint
    )) as Checkpoint;
    const metadata = (await this.serde.loadsTyped(
      row.type ?? "json",
      row.metadata
    )) as CheckpointMetadata;

    const result: CheckpointTuple = {
      checkpoint,
      config: finalConfig,
      metadata,
      pendingWrites,
    };
    
    if (row.parent_checkpoint_id) {
      result.parentConfig = {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.parent_checkpoint_id,
        },
      };
    }

    return result;
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    this.setup();

    const { limit, before, filter } = options ?? {};
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns;

    let sql = `
      SELECT
        thread_id,
        checkpoint_ns,
        checkpoint_id,
        parent_checkpoint_id,
        type,
        checkpoint,
        metadata
      FROM checkpoints
    `;

    const whereClause: string[] = [];
    if (thread_id) whereClause.push("thread_id = ?");
    if (checkpoint_ns !== undefined && checkpoint_ns !== null)
      whereClause.push("checkpoint_ns = ?");
    if (before?.configurable?.checkpoint_id !== undefined)
      whereClause.push("checkpoint_id < ?");

    const sanitizedFilter = Object.fromEntries(
      Object.entries(filter ?? {}).filter(([, value]) => value !== undefined)
    );
    whereClause.push(
      ...Object.keys(sanitizedFilter).map(() => `jsonb(CAST(metadata AS TEXT))->? = ?`)
    );

    if (whereClause.length > 0) {
      sql += `\nWHERE ${whereClause.join(" AND ")}\n`;
    }

    sql += "ORDER BY checkpoint_id DESC";
    if (limit) sql += ` LIMIT ${parseInt(String(limit), 10)}`;

    const args: (string | number)[] = [
      thread_id,
      checkpoint_ns,
      before?.configurable?.checkpoint_id,
      ...Object.entries(sanitizedFilter).flatMap(([key, value]) => [
        `$.${key}`,
        JSON.stringify(value),
      ]),
    ].filter((value): value is string | number => value !== undefined && value !== null);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...args) as {
      thread_id: string;
      checkpoint_ns: string;
      checkpoint_id: string;
      parent_checkpoint_id: string | null;
      type: string | null;
      checkpoint: Uint8Array;
      metadata: Uint8Array;
    }[];

    for (const row of rows) {
      // Load pending writes for this checkpoint
      const writesSql = `
        SELECT task_id, channel, type, value
        FROM writes
        WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
      `;
      const writesStmt = this.db.prepare(writesSql);
      const writesRows = writesStmt.all(row.thread_id, row.checkpoint_ns, row.checkpoint_id) as {
        task_id: string;
        channel: string;
        type: string | null;
        value: Uint8Array;
      }[];

      const pendingWrites: [string, string, unknown][] = await Promise.all(
        writesRows.map(async (w) => [
          w.task_id,
          w.channel,
          await this.serde.loadsTyped(w.type ?? "json", w.value),
        ])
      );

      const checkpoint = (await this.serde.loadsTyped(
        row.type ?? "json",
        row.checkpoint
      )) as Checkpoint;
      const metadata = (await this.serde.loadsTyped(
        row.type ?? "json",
        row.metadata
      )) as CheckpointMetadata;

      const result: CheckpointTuple = {
        config: {
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns: row.checkpoint_ns,
            checkpoint_id: row.checkpoint_id,
          },
        },
        checkpoint,
        metadata,
        pendingWrites,
      };

      if (row.parent_checkpoint_id) {
        result.parentConfig = {
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns: row.checkpoint_ns,
            checkpoint_id: row.parent_checkpoint_id,
          },
        };
      }

      yield result;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _newVersions: ChannelVersions
  ): Promise<RunnableConfig> {
    this.setup();

    if (!config.configurable) throw new Error("Empty configuration supplied.");
    const thread_id = config.configurable.thread_id;
    const checkpoint_ns = config.configurable.checkpoint_ns ?? "";
    const parent_checkpoint_id = config.configurable.checkpoint_id;

    if (!thread_id)
      throw new Error('Missing "thread_id" field in passed "config.configurable".');

    const preparedCheckpoint = copyCheckpoint(checkpoint);
    const [[type1, serializedCheckpoint], [type2, serializedMetadata]] = await Promise.all([
      this.serde.dumpsTyped(preparedCheckpoint),
      this.serde.dumpsTyped(metadata),
    ]);

    if (type1 !== type2) {
      throw new Error("Failed to serialize checkpoint and metadata to the same type.");
    }

    const sql = `
      INSERT OR REPLACE INTO checkpoints
      (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    const stmt = this.db.prepare(sql);
    stmt.run(
      thread_id,
      checkpoint_ns,
      checkpoint.id,
      parent_checkpoint_id ?? null,
      type1,
      serializedCheckpoint as Uint8Array,
      serializedMetadata as Uint8Array
    );

    return {
      configurable: {
        thread_id,
        checkpoint_ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    this.setup();

    if (!config.configurable) throw new Error("Empty configuration supplied.");
    if (!config.configurable.thread_id)
      throw new Error("Missing thread_id field in config.configurable.");
    if (!config.configurable.checkpoint_id)
      throw new Error("Missing checkpoint_id field in config.configurable.");

    const thread_id = config.configurable.thread_id;
    const checkpoint_ns = config.configurable.checkpoint_ns ?? "";
    const checkpoint_id = config.configurable.checkpoint_id;

    const allSpecial = writes.every(([channel]) => channel in WRITES_IDX_MAP);
    const sql = `
      INSERT ${allSpecial ? "OR REPLACE" : "OR IGNORE"} INTO writes
      (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const rows = await Promise.all(
      writes.map(async (write, idx) => {
        const [type, serializedWrite] = await this.serde.dumpsTyped(write[1]);
        return [
          thread_id,
          checkpoint_ns,
          checkpoint_id,
          taskId,
          WRITES_IDX_MAP[write[0]] ?? idx,
          write[0],
          type,
          serializedWrite,
        ];
      })
    );

    // Execute in a transaction
    this.db.exec("BEGIN TRANSACTION");
    try {
      const stmt = this.db.prepare(sql);
      for (const row of rows) {
        stmt.run(...(row as (string | number | Uint8Array)[]));
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    this.setup();

    this.db.exec("BEGIN TRANSACTION");
    try {
      const stmtCheckpoints = this.db.prepare("DELETE FROM checkpoints WHERE thread_id = ?");
      stmtCheckpoints.run(threadId);

      const stmtWrites = this.db.prepare("DELETE FROM writes WHERE thread_id = ?");
      stmtWrites.run(threadId);

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
