/**
 * The default durable checkpointer (core-blueprint.md §5, §1 rule 6).
 *
 * `NodeSqliteSaver` over `.voidrift/checkpoint.db` is the durable DEFAULT (§5.1,
 * §2.1): `createCore` constructs it when `opts.checkpointer` is omitted, and an
 * injected `BaseCheckpointSaver` (tests, hosted Postgres) overrides it. Proven
 * across process boundaries by substrate §1.5. `MemorySaver` remains available
 * for deterministic, offline runs (unit tests inject it, §15.3).
 */
import { MemorySaver } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { NodeSqliteSaver } from "./node-sqlite-saver.js";

/** Build the default SQLite checkpointer under the workspace state dir. The
 * `.voidrift` state dir is created if missing (0700) so the durable default
 * works out of the box; an unwritable directory surfaces as a construction
 * error. The db file is created owner-only (0600) BEFORE sqlite
 * opens it (the WAL/SHM sidecars inherit its mode), so no checkpoint content is
 * ever world-readable regardless of the process umask (security-audit S2). */
export function createSqliteCheckpointer(workspaceRoot: string): BaseCheckpointSaver {
  const dbPath = `${workspaceRoot}/.voidrift/checkpoint.db`;
  return NodeSqliteSaver.fromPath(dbPath);
}

/** An in-memory checkpointer for deterministic, offline runs. */
export function createMemoryCheckpointer(): BaseCheckpointSaver {
  return new MemorySaver();
}
