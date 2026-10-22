/**
 * The default durable checkpointer (core-blueprint.md §5, §1 rule 6).
 *
 * `SqliteSaver` over `.voidrift/checkpoint.db` is the durable DEFAULT (§5.1,
 * §2.1): `createCore` constructs it when `opts.checkpointer` is omitted, and an
 * injected `BaseCheckpointSaver` (tests, hosted Postgres) overrides it. Proven
 * across process boundaries by substrate §1.5. `MemorySaver` remains available
 * for deterministic, offline runs (unit tests inject it, §15.3).
 */
import path from "node:path";
import fs from "node:fs";
import { MemorySaver } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";

/** Build the default SQLite checkpointer under the workspace state dir. The
 * `.voidrift` state dir is created if missing (0700) so the durable default
 * works out of the box; an unwritable directory surfaces as a construction
 * error. The db file is created owner-only (0600) BEFORE sqlite
 * opens it (the WAL/SHM sidecars inherit its mode), so no checkpoint content is
 * ever world-readable regardless of the process umask (security-audit S2). */
export function createSqliteCheckpointer(workspaceRoot: string): BaseCheckpointSaver {
  const stateDir = path.join(workspaceRoot, ".voidrift");
  fs.mkdirSync(stateDir, { recursive: true });
  // Tighten the state dir to 0700 even if it pre-existed with a looser umask;
  // only `.voidrift` itself — never the workspace root.
  try {
    fs.chmodSync(stateDir, 0o700);
  } catch {
    /* best-effort: a non-POSIX fs may reject chmod */
  }
  const dbPath = path.join(stateDir, "checkpoint.db");
  // Pre-create ONLY the db file at mode 0600 before sqlite opens it, so no
  // checkpoint content is ever world-readable regardless of the process umask.
  // SQLite gives the -wal/-shm sidecars the main database file's mode, so they
  // inherit 0600. Do NOT pre-create the sidecars: an empty stray -wal/-shm that
  // races a live connection corrupts the WAL index ("database disk image is
  // malformed", found by the headless test suite after security-audit S2).
  try {
    fs.closeSync(fs.openSync(dbPath, "a", 0o600));
    fs.chmodSync(dbPath, 0o600);
  } catch {
    /* best-effort: the fs may reject chmod */
  }
  return SqliteSaver.fromConnString(dbPath);
}

/** An in-memory checkpointer for deterministic, offline runs. */
export function createMemoryCheckpointer(): BaseCheckpointSaver {
  return new MemorySaver();
}
