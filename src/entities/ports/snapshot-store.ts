/**
 * The rollback snapshot-store port (core-blueprint.md §10.12).
 *
 * Per session. Captures whole-tree (git) or content-addressed (cache) snapshots
 * around each writing turn, restores paths between a move's before/after states
 * with conflict detection, and persists the timeline so a resumed session
 * continues the same history. Two adapters implement it — `GitSnapshotStore`
 * (whole-tree commit objects under `refs/voidrift/<session>/…`) and
 * `CacheSnapshotStore` (`.voidrift/cache/snapshots/<session>/`) — plus an
 * in-memory one for tests. The `RollbackService` picks the method per session.
 *
 * NOTHING here crosses the facade as a model tool; it is host-internal.
 */
import type { Move, MovePath, NotUndoable, Timeline } from "../rollback.js";

/** The per-turn capture context the store needs (§10.12). */
export interface TurnContext {
  sessionId: string;
  /** The move id this turn will become (assigned by the service, monotonic). */
  moveId: number;
  turn: number;
}

/** A draft move the store produces at turn flush (§10.12): the changed paths,
 * the method, and any not-undoable effects it detected. `null` from
 * `commitTurn` means the turn changed nothing (no move). The service fills in
 * the id/time/summary/sessionId to make the final `Move`. */
export interface MoveDraft {
  paths: MovePath[];
  method: "git" | "cache";
  notUndoable?: NotUndoable[];
}

/** The read direction for `readState`/`restore` (§10.12). */
export type RestoreWhich = "before" | "after";

/** `readState` result: the bytes, `null` when the path DID NOT EXIST in that
 * state (so a restore deletes it), or `'absent'` when the snapshot has no record
 * of the path (unknown — a restore skips it). */
export type ReadState = Buffer | null | "absent";

/** The outcome of a restore (§10.12). All-or-nothing per command. */
export interface RestoreResult {
  restored: string[];
  conflicts: string[];
  skipped: { path: string; reason: string }[];
}

/** The capture-attribution note the decision point hands the store at each
 * write (cache method; git ignores it) (§10.12). */
export interface NoteWriteInput {
  sessionId: string;
  /** The workspace-relative target path, or the raw command for a shell effect. */
  target: string;
  /** The RAW before-state bytes of a file target at FIRST touch this turn, or
   * null when it did not exist. Undefined for a shell effect. */
  beforeBytes?: Buffer | null;
  /** True when the target is a non-safe `execute_command` whose file targets are
   * NOT statically known (recorded as a not-undoable shell effect). */
  shellUnattributable?: boolean;
  /** The (masked) command text for a shell effect. */
  shellCommand?: string;
}

export interface SnapshotStore {
  /** The method this store captures with (§10.12). Always git or cache; a
   * chat-only MOVE carries `files.method: "none"`, which is a move-level value. */
  readonly method: "git" | "cache";

  /** Begin capturing a turn (§10.12): the git method takes the whole-tree
   * BEFORE snapshot here (at the first write of the turn); the cache method
   * resets its per-turn attribution. Idempotent within a turn. */
  beginTurn(ctx: TurnContext): Promise<void>;

  /** Note a write to a target (§10.12). The cache method captures the first
   * before-state per path and records shell effects; the git method ignores it
   * (the whole-tree snapshot covers everything). */
  noteWrite(input: NoteWriteInput): Promise<void>;

  /** Commit the turn (§10.12): the git method takes the AFTER snapshot and
   * diffs before↔after; the cache method reads each noted target's actual file
   * and writes its manifest/blobs. Returns the move draft, or null when nothing
   * changed (no move). */
  commitTurn(ctx: TurnContext): Promise<MoveDraft | null>;

  /** Read a path's recorded state in a move (§10.12) for conflict detection. */
  readState(move: Move, which: RestoreWhich, path: string): Promise<ReadState>;

  /** Restore a move's paths in `direction` (§10.12). `undo` restores each path
   * to its BEFORE state iff current === AFTER (else a conflict); `redo` restores
   * to AFTER iff current === BEFORE. `opts.overwrite` forces the listed
   * conflicting paths. All-or-nothing: stage then rename; roll back on failure. */
  restore(move: Move, direction: "undo" | "redo", opts: { overwrite: Set<string> }): Promise<RestoreResult>;

  /** Delete the snapshots (refs / blobs / manifests) of the given move ids
   * (§10.12), used on prune and redo-branch drop. */
  drop(moveIds: number[]): Promise<void>;

  /** Persist the timeline (moves + pointer + method) under the session's cache
   * dir (§10.12) so a resumed session continues the same history. */
  persistTimeline(sessionId: string, timeline: Timeline): Promise<void>;

  /** Load a session's persisted timeline, or null when none exists (§10.12). */
  loadTimeline(sessionId: string): Promise<Timeline | null>;

  /** Open a session (§10.12 item 4): called ONCE per session before any
   * capture/restore so the store can sweep leftover rollback staging files from
   * a prior crash (recover asides whose original is missing, delete the rest).
   * Optional — the in-memory test store has no on-disk staging. */
  openSession?(sessionId: string): Promise<void>;
}
