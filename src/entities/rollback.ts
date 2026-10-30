/**
 * Rollback — the move timeline, entity layer (core-blueprint.md §10.12).
 *
 * Rollback steps the user's main working tree backward and forward over the
 * changes a session made, as a LINEAR timeline of moves, through three host
 * commands (`/undo`, `/redo`, `/goto`) backed by whole-tree snapshots. This
 * module is PURE (no I/O): it defines the move/timeline shapes and the pure
 * timeline operations (record, plan undo/redo/goto, prune). The `SnapshotStore`
 * port and its adapters (git / cache / in-memory) do the capture and restore;
 * the `RollbackService` use-case wires them to the engine and facade.
 *
 * A move = exactly one turn that changed at least one file in the main working
 * tree. Ids are per-session sequential integers (1, 2, 3 …) never reused within
 * a session; the pointer marks the last applied move (0 = before the first
 * move, the state the session started from).
 */

/** The method that captured a move's FILE half (§10.12). `git` = whole-tree
 * commit-object snapshots under `refs/voidrift/<session>/<id>/…`; `cache` =
 * content-addressed copies under `.voidrift/cache/snapshots/<session>/`;
 * `none` = a chat-only move (its file half is empty). */
export type SnapshotMethod = "git" | "cache" | "none";

/** How a path changed in a move (§10.12). */
export type PathKind = "modified" | "created" | "deleted";

/** One changed path in a move (workspace-relative). `restorable` is false when
 * the store could not capture it (e.g. a cache file over the 5 MiB cap, a git
 * symlink/submodule); `reason` explains why. `mode` carries the recorded file
 * mode so the exec bit is preserved on restore (git method). */
export interface MovePath {
  path: string;
  kind: PathKind;
  mode?: number;
  restorable: boolean;
  reason?: string;
}

/** A not-undoable effect a move carries (§10.12): a worktree merge, a staging
 * apply, a statically-unattributable shell effect, or a failed snapshot. `/undo`
 * and `/goto` refuse to cross a move with any of these and name the detail. */
export interface NotUndoable {
  kind: "merge" | "apply" | "shell" | "snapshot-failed";
  detail: string;
}

/** The CONVERSATION half of a move (§10.12): the end-of-previous-turn and
 * end-of-this-turn durable checkpoint ids. `beforeCheckpointId` is null for the
 * first turn (an empty conversation = session start). For an aborted turn that
 * left no checkpoint but changed files, `afterCheckpointId === beforeCheckpointId`
 * (the conversation part is unchanged) so the files remain undoable. */
export interface MoveConversation {
  beforeCheckpointId: string | null;
  afterCheckpointId: string | null;
}

/** The FILE half of a move (§10.12). `method` is `"none"` for a chat-only move
 * (no snapshot objects captured). `paths` are the changed paths (empty for a
 * chat-only move); `notUndoable` are the file effects this move cannot reverse. */
export interface MoveFiles {
  method: SnapshotMethod;
  paths: MovePath[];
  notUndoable: NotUndoable[];
}

/**
 * The CONTEXT half of a move (§10.12): the session/metadata state that is
 * injected into every model request but does NOT live in a checkpoint channel,
 * so traversal must set it from the TARGET move (pointer 0 = none/initial).
 * Recorded at the end of the turn that produced the move.
 *   - `rollingSummary` — the compaction summary string in effect after the turn
 *     (§4.9). Stored as produced; it is already bounded by the summary budget
 *     (a ratio of the window, §4.9), so no separate byte cap applies.
 *   - `usageAnchor` — the persisted usage anchor (max input_tokens seen, §4.8)
 *     that backs the context% meter and cost totals after the turn.
 * All fields are part of the signed canonical JSON of the timeline.
 */
export interface MoveContext {
  rollingSummary?: string;
  usageAnchor?: number;
}

/**
 * Build a {@link MoveContext} from the post-turn session values (§10.12). The
 * rolling summary is stored as produced — it is already bounded by the summary
 * budget (§4.9), so no separate byte cap applies. PURE.
 */
export function buildMoveContext(input: { rollingSummary?: string; usageAnchor?: number }): MoveContext {
  const ctx: MoveContext = {};
  if (input.usageAnchor !== undefined) ctx.usageAnchor = input.usageAnchor;
  const summary = input.rollingSummary;
  if (summary !== undefined && summary !== "") ctx.rollingSummary = summary;
  return ctx;
}

/** One move on the timeline (§10.12). EVERY completed turn is a move; its file
 * half may be empty (a chat-only move). */
export interface Move {
  id: number;
  sessionId: string;
  /** The turn number that produced the move. */
  turn: number;
  /** ISO-8601 time the move was recorded. */
  time: string;
  /** The one-line summary: the first line of the user's message, control chars
   * stripped, ≤120 chars (with an ellipsis when truncated). */
  summary: string;
  /** The conversation half (§10.12): the checkpointer's before/after tips. */
  conversation: MoveConversation;
  /** The file half (§10.12): method, changed paths, and not-undoable effects. */
  files: MoveFiles;
  /** The context half (§10.12): session/metadata state (rolling summary, usage
   * anchor) that is injected into every request but lives outside the checkpoint,
   * recorded at the end of the turn and restored from the TARGET on traversal.
   * Absent on a v2 timeline (ignored as untrusted) and on the initial state. */
  context?: MoveContext;
}

/** The current timeline schema version (§10.12). Bumped when the move shape
 * changes; an older `timeline.json` is treated as UNTRUSTED and ignored (one
 * warning), like any other unverifiable history — no migration code pre-release. */
export const TIMELINE_SCHEMA_VERSION = 3;

/** A linear timeline of moves plus the position pointer (§10.12). The pointer is
 * an index into `moves` 1-based by applied count: 0 = before the first move, N =
 * after move with id `moves[N-1].id`. Moves are stored in id order. `version` is
 * the schema version — a persisted timeline with a different version is ignored. */
export interface Timeline {
  version: number;
  moves: Move[];
  pointer: number;
}

/** The max summary length (§10.12). */
export const MOVE_SUMMARY_MAX = 120;

/** Max displayed length of ONE sanitized path in a trusted-channel string
 * (§10.12 — the harness note / move summary). */
export const SANITIZED_PATH_MAX = 120;
/** Max number of paths listed before an `and N more` tail (§10.12). */
export const SANITIZED_PATH_LIST_MAX = 10;
/** Hard cap on the whole harness-note string (§10.12). */
export const HARNESS_NOTE_MAX = 2000;

/**
 * The ONE control/spoof-character set stripped from any untrusted text that
 * enters a trusted channel — a move summary (CLI layout) or the `[harness note]`
 * human-role message (the model's trusted channel). A restored file NAME is
 * attacker-influenced, so it must be scrubbed before it is spliced into either.
 * Covers, dropped to "" so a run of them cannot inflate the visible length:
 *   - C0 controls `\u0000-\u001F` and DEL `\u007F`, and C1 controls
 *     `\u0080-\u009F` (BEL/ESC → ANSI/terminal injection),
 *   - zero-width + bidi overrides/isolates `\u200B-\u200F`, `\u202A-\u202E`,
 *     `\u2060-\u2064`, `\u2066-\u2069` (U+202E and friends spoof direction),
 *   - the BOM / zero-width-no-break-space `\uFEFF`.
 * NEWLINE/TAB are handled separately (replaced with a single space) so callers
 * that want multi-line structure do not get it here. PURE.
 */
// eslint-disable-next-line no-control-regex
const SANITIZE_DROP = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * Sanitize one piece of untrusted text (a file path or a user-message line) for
 * a trusted-channel string (§10.12). Single shared helper — `moveSummary` and
 * the facade harness note both route through it so there is ONE regex set:
 *   1. replace every newline/tab/CR with a single space,
 *   2. drop every control / bidi / zero-width / BOM character (SANITIZE_DROP),
 *   3. neutralize the literal marker `[harness note]` (case-insensitive) so a
 *      restored NAME cannot forge a second trusted directive — the brackets are
 *      replaced so the marker can no longer be recognized,
 *   4. collapse runs of whitespace and trim,
 *   5. cap at `max` characters with a `…` suffix.
 * PURE, no I/O.
 */
export function sanitizeTrustedText(input: string | undefined, max = SANITIZED_PATH_MAX): string {
  if (!input) return "";
  let s = input.replace(/[\r\n\t]+/g, " ").replace(SANITIZE_DROP, "");
  // Neutralize a forged `[harness note]` marker (case-insensitive) anywhere.
  s = s.replace(/\[harness note\]/gi, "(harness note)");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "\u2026";
}

/**
 * Sanitize a list of paths for a trusted-channel string (§10.12): each path
 * through {@link sanitizeTrustedText} (capped at `SANITIZED_PATH_MAX`), the list
 * capped at `SANITIZED_PATH_LIST_MAX` entries with an `and N more` tail. Returns
 * the joined, comma-separated string. PURE.
 */
export function sanitizePathList(
  paths: readonly string[],
  opts: { pathMax?: number; listMax?: number } = {},
): string {
  const pathMax = opts.pathMax ?? SANITIZED_PATH_MAX;
  const listMax = opts.listMax ?? SANITIZED_PATH_LIST_MAX;
  const shown = paths.slice(0, listMax).map((p) => sanitizeTrustedText(p, pathMax));
  const joined = shown.join(", ");
  const more = paths.length > listMax ? ` and ${paths.length - listMax} more` : "";
  return joined + more;
}

/**
 * Hard-bound a whole trusted-channel harness note (§10.12, ROLL3) to `max`
 * characters with an ellipsis, so even many long paths cannot inflate the note
 * beyond its cap. `max` defaults to {@link HARNESS_NOTE_MAX}; the caller passes
 * the effective `rollback.harnessNoteMaxChars` registry value. PURE.
 */
export function boundHarnessNote(note: string, max = HARNESS_NOTE_MAX): string {
  return note.length <= max ? note : note.slice(0, max - 1) + "\u2026";
}

/** Build a one-line move summary from the user's message (§10.12): the first
 * line, control/spoof chars stripped, whitespace trimmed, truncated to 120 chars
 * with an ellipsis. Reuses the shared sanitizer. Pure. */
export function moveSummary(userMessage: string | undefined): string {
  if (!userMessage) return "";
  // First line only, then the shared control/spoof strip + cap.
  const firstLine = userMessage.split(/\r?\n/, 1)[0] ?? "";
  return sanitizeTrustedText(firstLine, MOVE_SUMMARY_MAX);
}

/** A fresh, empty timeline (pointer 0, no moves, current schema version). */
export function emptyTimeline(): Timeline {
  return { version: TIMELINE_SCHEMA_VERSION, moves: [], pointer: 0 };
}

/** The next move id for a timeline: one past the highest id ever used. Because
 * `record` drops the redo branch but ids are never reused, we track the next id
 * as `max(existing ids) + 1`; a dropped branch's ids are never reissued within a
 * session because the caller holds the counter (see `RollbackService`). This
 * helper returns the id to use when the timeline alone is the source of truth. */
export function nextMoveId(timeline: Timeline): number {
  let max = 0;
  for (const m of timeline.moves) if (m.id > max) max = m.id;
  return max + 1;
}

/** The result of recording a move (§10.12): the new timeline and the ids of any
 * moves DROPPED from the redo branch (so the store prunes their snapshots). */
export interface RecordResult {
  timeline: Timeline;
  droppedIds: number[];
}

/**
 * Record a new move (§10.12). A new move made while the pointer is behind the
 * end DROPS the redo branch: every move after the pointer is discarded (history
 * stays linear) and its ids are returned so the store prunes their snapshots.
 * The new move is appended and the pointer advanced to it. PURE — the caller
 * assigns `move.id` (monotonic per session, never reused).
 */
export function record(timeline: Timeline, move: Move): RecordResult {
  const kept = timeline.moves.slice(0, timeline.pointer);
  const droppedIds = timeline.moves.slice(timeline.pointer).map((m) => m.id);
  const moves = [...kept, move];
  return { timeline: { version: timeline.version, moves, pointer: moves.length }, droppedIds };
}

/** One planned restore step (§10.12): restore the given move in `direction`. */
export interface PlanStep {
  move: Move;
  direction: "undo" | "redo";
}

/** A plan outcome: the ordered steps to execute, or a refusal (§10.12). A
 * refusal names the move and the reason (a not-undoable move crossed). */
export type PlanResult =
  | { ok: true; steps: PlanStep[]; targetPointer: number }
  | { ok: false; reason: string; blockedMove: Move };

/** Whether a move can be reversed by a per-path restore (§10.12). A move with a
 * `merge`/`apply`/`shell`/`snapshot-failed` not-undoable effect cannot. */
export function isUndoable(move: Move): boolean {
  return move.files.notUndoable.length === 0;
}

/** Describe why a move is not undoable, for a refusal message (§10.12). */
export function notUndoableReason(move: Move): string {
  const parts = move.files.notUndoable.map((n) => {
    switch (n.kind) {
      case "merge":
        return `a worktree merge (${n.detail})`;
      case "apply":
        return `a staging apply (${n.detail})`;
      case "shell":
        return `a shell effect (${n.detail})`;
      case "snapshot-failed":
        return `a failed snapshot (${n.detail})`;
    }
  });
  return parts.join("; ");
}

/** Plan a single `/undo` (§10.12): restore the move at the pointer to its
 * before-state and step the pointer back one. Refuses when the move is not
 * undoable. */
export function planUndo(timeline: Timeline): PlanResult {
  if (timeline.pointer <= 0) {
    return { ok: false, reason: "already at the start of the timeline", blockedMove: undefined as never };
  }
  const move = timeline.moves[timeline.pointer - 1]!;
  if (!isUndoable(move)) {
    return {
      ok: false,
      reason: `move ${move.id} cannot be undone: it applied ${notUndoableReason(move)}`,
      blockedMove: move,
    };
  }
  return { ok: true, steps: [{ move, direction: "undo" }], targetPointer: timeline.pointer - 1 };
}

/** Plan a single `/redo` (§10.12): restore the next move to its after-state and
 * step the pointer forward one. Refuses when the next move is not undoable
 * (re-applying a merge/apply by per-path restore is likewise unsupported). */
export function planRedo(timeline: Timeline): PlanResult {
  if (timeline.pointer >= timeline.moves.length) {
    return { ok: false, reason: "already at the end of the timeline", blockedMove: undefined as never };
  }
  const move = timeline.moves[timeline.pointer]!;
  if (!isUndoable(move)) {
    return {
      ok: false,
      reason: `move ${move.id} cannot be redone: it applied ${notUndoableReason(move)}`,
      blockedMove: move,
    };
  }
  return { ok: true, steps: [{ move, direction: "redo" }], targetPointer: timeline.pointer + 1 };
}

/**
 * Plan a `/goto <id>` (§10.12): walk the pointer to the move with the given id
 * (id 0 = before the first move) by applying the moves between the current
 * pointer and the target IN ORDER — undos when the target is behind, redos when
 * ahead. Refuses (naming the blocking move) when any crossed move is not
 * undoable; the caller stops BEFORE that step. An unknown id is a refusal.
 */
export function planGoto(timeline: Timeline, targetId: number): PlanResult {
  // Resolve the target POINTER from the id. id 0 → pointer 0.
  let targetPointer: number;
  if (targetId === 0) {
    targetPointer = 0;
  } else {
    const idx = timeline.moves.findIndex((m) => m.id === targetId);
    if (idx === -1) {
      return { ok: false, reason: `no move with id ${targetId}`, blockedMove: undefined as never };
    }
    targetPointer = idx + 1;
  }
  const steps: PlanStep[] = [];
  if (targetPointer < timeline.pointer) {
    // Walk back: undo moves from pointer-1 down to targetPointer.
    for (let p = timeline.pointer; p > targetPointer; p--) {
      const move = timeline.moves[p - 1]!;
      if (!isUndoable(move)) {
        return {
          ok: false,
          reason: `move ${move.id} cannot be crossed: it applied ${notUndoableReason(move)}`,
          blockedMove: move,
        };
      }
      steps.push({ move, direction: "undo" });
    }
  } else if (targetPointer > timeline.pointer) {
    // Walk forward: redo moves from pointer up to targetPointer-1.
    for (let p = timeline.pointer; p < targetPointer; p++) {
      const move = timeline.moves[p]!;
      if (!isUndoable(move)) {
        return {
          ok: false,
          reason: `move ${move.id} cannot be crossed: it applied ${notUndoableReason(move)}`,
          blockedMove: move,
        };
      }
      steps.push({ move, direction: "redo" });
    }
  }
  return { ok: true, steps, targetPointer };
}

/** The result of pruning (§10.12): the kept timeline and the dropped move ids. */
export interface PruneResult {
  timeline: Timeline;
  droppedIds: number[];
}

/**
 * Prune the timeline to the `snapshotCount` most recent moves (§10.12), dropping
 * the OLDEST beyond the count and returning their ids so the store deletes their
 * refs/blobs/manifests. The pointer is adjusted to stay on the same move (or to
 * 0 when its move was pruned). `snapshotCount` 0 drops everything (the caller
 * disables rollback at that level, so this is defensive). PURE.
 */
export function prune(timeline: Timeline, snapshotCount: number): PruneResult {
  if (snapshotCount < 0) snapshotCount = 0;
  if (timeline.moves.length <= snapshotCount) {
    return { timeline, droppedIds: [] };
  }
  const dropCount = timeline.moves.length - snapshotCount;
  const dropped = timeline.moves.slice(0, dropCount);
  const kept = timeline.moves.slice(dropCount);
  // The pointer counted applied moves from the front; drop the same count,
  // clamped to 0 (a pointer inside the dropped region means those moves are gone
  // and the earliest restorable state is now the start of the kept window).
  const pointer = Math.max(0, timeline.pointer - dropCount);
  return { timeline: { version: timeline.version, moves: kept, pointer }, droppedIds: dropped.map((m) => m.id) };
}
