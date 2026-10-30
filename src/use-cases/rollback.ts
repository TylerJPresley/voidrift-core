/**
 * The rollback service (core-blueprint.md §10.12).
 *
 * Wires the pure timeline (entities/rollback.ts) to a `SnapshotStore` and the
 * engine/facade. Rollback is UNIFIED: a move pairs the CONVERSATION half (always
 * the checkpointer's turn-boundary checkpoints) with the FILE half (git or
 * cache, or none for a chat-only turn). It:
 *   - picks the file method per session at FIRST use (git when the workspace is
 *     a git repo and git runs, else cache) and fixes it for the session's life,
 *   - owns the per-session monotonic move-id counter (never reused within a
 *     session, even across a redo-branch drop or a prune),
 *   - records a move for EVERY completed turn (its file half may be empty) at the
 *     flush point, captures the before/after conversation checkpoint ids, drops
 *     the redo branch, prunes past `snapshotCount`, and persists the timeline,
 *   - serves the host-only `moves/undo/redo/goto` operations: per single-move
 *     step it dry-runs the file half for conflicts, applies the file half, writes
 *     the conversation tip (through the injected `writeTip`), and on a tip-write
 *     failure REVERSES the file half — all-or-nothing per step — then emits the
 *     events `MOVE_RECORDED`, `MOVES_PRUNED`, and `ROLLBACK_APPLIED`.
 *
 * `snapshotCount: 0` disables rollback entirely: no capture, no refs/cache
 * writes; `moves()` reports `{ enabled:false }` and undo/redo/goto answer
 * `rollback is off`. This service is HOST-ONLY — the facade exposes it on the
 * `session` namespace; it is never a model tool nor on the plugin surface.
 */
import {
  type Move,
  type MovePath,
  type NotUndoable,
  type Timeline,
  type SnapshotMethod,
  type MoveContext,
  emptyTimeline,
  moveSummary,
  buildMoveContext,
  record as recordMove,
  prune,
  planUndo,
  planRedo,
  planGoto,
  TIMELINE_SCHEMA_VERSION,
} from "../entities/rollback.js";
import type { SnapshotStore, NoteWriteInput } from "../entities/ports/snapshot-store.js";

/** A persisted timeline carries the move-id counter so ids are never reused
 * within a session even after a drop/prune removes the highest-numbered move. */
type PersistedTimeline = Timeline & { nextId?: number; fileMethod?: "git" | "cache" };

/** The target state for the conversation tip of a single applied step (§10.12).
 * `checkpointId` is the end-of-turn checkpoint the new tip is written from; null
 * = session start (an empty conversation, pointer 0). */
export interface TipTarget {
  checkpointId: string | null;
  /** The move id now current after the step (0 = session start). */
  pointerId: number;
  /** The restored paths (for the harness note), already relative. */
  restored: string[];
}

/** The structured outcome of a rollback operation (§10.12). */
export interface RollbackOutcome {
  ok: boolean;
  action: "undo" | "redo" | "goto";
  fromPointer: number;
  toPointer: number;
  /** The move id at the from/to pointer (0 = session start). */
  fromId: number;
  toId: number;
  restored: string[];
  skipped: { path: string; reason: string }[];
  conflicts?: string[];
  notUndoable?: { kind: string; detail: string }[];
  /** How many undo steps were applied (for a `/goto` summary). */
  undone: number;
  /** How many shell effects the crossed moves could not undo (cache method). */
  shellEffects: number;
  /** The file method of the move(s) stepped (git/cache/none). */
  method: SnapshotMethod;
  message: string;
}

/** The `moves()` report (§10.12). */
export interface MovesReport {
  enabled: boolean;
  method?: "git" | "cache";
  /** The ID of the last applied move (0 = session start), NOT an applied-count
   * index — so the CLI renderer's `pointer === move.id` compare is correct after
   * a prune renumbers the window (§10.12). */
  pointer?: number;
  moves?: Move[];
}

/** What the service emits/journals for an applied rollback step. */
export interface RollbackStepRecord {
  action: "undo" | "redo" | "goto";
  paths: string[];
  /** The opposite command, for the journal undo hint. */
  undoHint: string;
}

export interface RollbackServiceDeps {
  /** The snapshot store (git or cache), already method-fixed for this process. */
  store: SnapshotStore;
  /** The configured `snapshotCount` (§13.10); read fresh each call so a config
   * change takes effect. 0 disables rollback. */
  getSnapshotCount: () => number;
  /** Emit an event (`MOVE_RECORDED` / `MOVES_PRUNED` / `ROLLBACK_APPLIED`),
   * id/count/method only, never file content (§10.12, §14.6). */
  emit: (type: string, payload: unknown, sessionId: string) => void;
  /** Record a restore step in the mutation journal (§10.11) — a write action,
   * tool `rollback`. Optional: absent in unit tests. */
  journalStep?: (sessionId: string, step: RollbackStepRecord) => Promise<void>;
  /**
   * Write the session's conversation tip from a target checkpoint (§10.12 step
   * d): create a NEW tip from `checkpointId` (null = an empty-conversation tip,
   * session start) through the checkpointer so the chain stays append-only and
   * every earlier checkpoint remains reachable for redo. THROWS on failure so
   * the service reverses the file half (step e). Optional: absent in a pure
   * entity-level unit test exercises the file half only.
   */
  writeTip?: (sessionId: string, target: TipTarget) => Promise<void>;
  /**
   * Restore the session's CONTEXT state (§10.12) — the state injected into every
   * model request that lives OUTSIDE the checkpoint (rolling summary, usage
   * anchor) — plus RESET the per-conversation derived caches (readPaths,
   * stalePaths, the document registry/manifest, the per-turn tool-result cache,
   * lane counters) so nothing trusts an undone turn. Called ONCE per traversal,
   * after the final pointer is set, with the TARGET move's recorded context
   * (`null` = pointer 0, session start → no summary, no anchor). The harness note
   * tells the model to re-read, so a reset is safe. Optional: absent in a pure
   * entity/file-only unit test. Memory/reflection/suggestion stores and
   * observability counters are explicitly NOT touched (not undone).
   */
  restoreContext?: (sessionId: string, context: MoveContext | null) => Promise<void> | void;
}

/** In-memory per-session timeline state (loaded lazily, persisted on change). */
interface SessionState {
  timeline: Timeline;
  nextId: number;
  /** True once a turn's beginTurn has run (so noteWrite/commitTurn apply). */
  turnOpen: boolean;
  currentMoveId: number | null;
  currentTurn: number;
  /** The conversation tip id BEFORE this turn ran (null = empty conversation). */
  beforeCheckpointId: string | null;
}

export class RollbackService {
  private readonly states = new Map<string, SessionState>();
  /** The conversation-tip writer (§10.12 step d). Set by the facade after
   * construction (it owns session resolution + the engine), or passed in deps
   * for a unit test. Absent → the file half is applied but the conversation tip
   * is not rewritten (an entity/file-only test). */
  private writeTipFn: ((sessionId: string, target: TipTarget) => Promise<void>) | undefined;
  /** The context-restore callback (§10.12). Set by the facade after construction
   * (it owns the live Session), or passed in deps for a unit test. */
  private restoreContextFn: ((sessionId: string, context: MoveContext | null) => Promise<void> | void) | undefined;

  constructor(private readonly deps: RollbackServiceDeps) {
    this.writeTipFn = deps.writeTip;
    this.restoreContextFn = deps.restoreContext;
  }

  /** Wire the conversation-tip writer after construction (§10.12). The facade
   * calls this with a closure over its session resolution and the engine. */
  setWriteTip(fn: (sessionId: string, target: TipTarget) => Promise<void>): void {
    this.writeTipFn = fn;
  }

  /** Wire the context-restore callback after construction (§10.12). The facade
   * calls this with a closure over its live Session resolution. */
  setRestoreContext(fn: (sessionId: string, context: MoveContext | null) => Promise<void> | void): void {
    this.restoreContextFn = fn;
  }

  /** The FILE method the store captures with (git or cache). A chat-only MOVE
   * carries `files.method: "none"`, but the store itself is always git or cache. */
  get method(): "git" | "cache" {
    return this.deps.store.method;
  }

  private get enabled(): boolean {
    return this.deps.getSnapshotCount() > 0;
  }

  /** Load (once) a session's persisted timeline + id counter. A persisted
   * timeline whose schema `version` differs from the current one is IGNORED as
   * untrusted (one warning), like any other unverifiable history — the session
   * starts with an empty timeline (§10.12). */
  private async load(sessionId: string): Promise<SessionState> {
    const cached = this.states.get(sessionId);
    if (cached) return cached;
    try {
      await this.deps.store.openSession?.(sessionId);
    } catch {
      /* a sweep failure never blocks rollback */
    }
    const persisted = (await this.deps.store.loadTimeline(sessionId)) as PersistedTimeline | null;
    let timeline: Timeline;
    let nextId: number;
    if (persisted && persisted.version === TIMELINE_SCHEMA_VERSION) {
      timeline = { version: TIMELINE_SCHEMA_VERSION, moves: persisted.moves ?? [], pointer: persisted.pointer ?? 0 };
      const maxId = timeline.moves.reduce((m, mv) => Math.max(m, mv.id), 0);
      nextId = Math.max(persisted.nextId ?? 0, maxId + 1);
    } else {
      if (persisted) {
        this.deps.emit(
          "WARNING_EMITTED",
          { category: "rollback", source: "timeline", pattern: "ignored a timeline with an incompatible schema version" },
          sessionId,
        );
      }
      timeline = emptyTimeline();
      nextId = 1;
    }
    const state: SessionState = {
      timeline,
      nextId,
      turnOpen: false,
      currentMoveId: null,
      currentTurn: 0,
      beforeCheckpointId: null,
    };
    this.states.set(sessionId, state);
    return state;
  }

  private async persist(sessionId: string, state: SessionState): Promise<void> {
    const toSave: PersistedTimeline = {
      version: TIMELINE_SCHEMA_VERSION,
      moves: state.timeline.moves,
      pointer: state.timeline.pointer,
      nextId: state.nextId,
      fileMethod: this.method,
    };
    await this.deps.store.persistTimeline(sessionId, toSave);
  }

  // ── capture hooks (wired into the engine turn start + flush) ───────────────

  /**
   * Begin capturing a turn at its START (§10.12). Called for EVERY turn (chat-
   * only or file-changing): it records the conversation tip BEFORE the turn
   * (`beforeCheckpointId`, null for the first turn = empty conversation) and
   * opens the file-half capture (the store takes the git before-snapshot on the
   * first write; cache resets attribution). Idempotent within a turn. A snapshot
   * failure is swallowed — it NEVER blocks the user's turn. No-op when disabled.
   */
  async beginTurn(sessionId: string, turn: number, beforeCheckpointId?: string | null): Promise<void> {
    if (!this.enabled) return;
    const state = await this.load(sessionId);
    if (state.turnOpen) return;
    const moveId = state.nextId;
    state.turnOpen = true;
    state.currentMoveId = moveId;
    state.currentTurn = turn;
    state.beforeCheckpointId = beforeCheckpointId ?? null;
    try {
      await this.deps.store.beginTurn({ sessionId, moveId, turn });
    } catch {
      /* a snapshot failure never blocks the turn; commitTurn degrades it */
    }
  }

  /** Note a write to a target this turn (cache attribution; git ignores it). */
  async noteWrite(input: NoteWriteInput): Promise<void> {
    if (!this.enabled) return;
    const state = this.states.get(input.sessionId);
    if (!state?.turnOpen) return;
    try {
      await this.deps.store.noteWrite(input);
    } catch {
      /* best-effort; never blocks the write */
    }
  }

  /**
   * Commit a turn at a flush point (§10.12). Records a move for EVERY completed
   * turn: it captures the after snapshot via the store (a chat-only turn → an
   * empty file half, `method: "none"`), pairs it with the conversation half
   * (`before`/`after` checkpoint ids), drops the redo branch (and prunes its
   * snapshots), prunes past `snapshotCount`, persists, and emits `MOVE_RECORDED`
   * / `MOVES_PRUNED`. No-op (and resets) when disabled or no turn was open.
   *
   * `afterCheckpointId` is the conversation tip AFTER the turn; null means the
   * turn produced no durable checkpoint (an aborted turn, §5.2) — the move's
   * conversation part is then left unchanged (`after = before`) so its files
   * remain undoable (§10.12).
   */
  async commitTurn(
    sessionId: string,
    userMessage: string | undefined,
    afterCheckpointId?: string | null,
    context?: { rollingSummary?: string; usageAnchor?: number },
  ): Promise<Move | null> {
    const state = this.states.get(sessionId);
    if (!state || !state.turnOpen) return null;
    const moveId = state.currentMoveId!;
    const turn = state.currentTurn;
    const beforeCheckpointId = state.beforeCheckpointId;
    state.turnOpen = false;
    state.currentMoveId = null;
    if (!this.enabled) return null;

    let draft;
    try {
      draft = await this.deps.store.commitTurn({ sessionId, moveId, turn });
    } catch {
      draft = null;
    }

    // §10.12 — a move is recorded for every turn that produced a durable
    // checkpoint OR changed files. An aborted turn (no checkpoint) that changed
    // nothing records no move.
    const hasCheckpoint = afterCheckpointId != null;
    const hasFiles = draft != null;
    if (!hasCheckpoint && !hasFiles) return null;

    const paths: MovePath[] = draft?.paths ?? [];
    const notUndoable: NotUndoable[] = draft?.notUndoable ?? [];
    const fileMethod: SnapshotMethod = hasFiles ? (draft!.method as "git" | "cache") : "none";
    // An aborted-but-file-changing turn: the conversation part is unchanged.
    const afterId = hasCheckpoint ? afterCheckpointId! : beforeCheckpointId;

    const move: Move = {
      id: moveId,
      sessionId,
      turn,
      time: new Date().toISOString(),
      summary: moveSummary(userMessage),
      conversation: { beforeCheckpointId, afterCheckpointId: afterId },
      files: { method: fileMethod, paths, notUndoable },
      // §10.12 — the context half: post-turn session state outside the checkpoint.
      context: buildMoveContext(context ?? {}),
    };

    // Record on the timeline (drops the redo branch, returns dropped ids).
    const rec = recordMove(state.timeline, move);
    state.timeline = rec.timeline;
    state.nextId = moveId + 1;
    if (rec.droppedIds.length > 0) {
      await this.deps.store.drop(rec.droppedIds).catch(() => undefined);
    }

    // Prune past snapshotCount (oldest first).
    const pr = prune(state.timeline, this.deps.getSnapshotCount());
    state.timeline = pr.timeline;
    if (pr.droppedIds.length > 0) {
      await this.deps.store.drop(pr.droppedIds).catch(() => undefined);
      this.deps.emit(
        "MOVES_PRUNED",
        { prunedIds: pr.droppedIds, method: this.method, remaining: state.timeline.moves.length },
        sessionId,
      );
    }

    await this.persist(sessionId, state);
    // §14.6 — MOVE_RECORDED fires for every completed turn (method "none" ok).
    this.deps.emit(
      "MOVE_RECORDED",
      { id: move.id, turn: move.turn, fileCount: move.files.paths.length, method: move.files.method },
      sessionId,
    );
    return move;
  }

  /** Discard a half-captured turn without recording a move (e.g. a turn that
   * errored before any checkpoint and changed nothing). Resets the per-turn flags. */
  discardTurn(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (state) {
      state.turnOpen = false;
      state.currentMoveId = null;
      state.beforeCheckpointId = null;
    }
  }

  // ── host operations ────────────────────────────────────────────────────────

  async moves(sessionId: string): Promise<MovesReport> {
    if (!this.enabled) return { enabled: false };
    const state = await this.load(sessionId);
    // §10.12 MEDIUM-fix — `pointer` is the ID of the last applied move (0 =
    // session start), NOT the applied-count index: after a prune the ids no
    // longer start at 1, and the CLI renderer compares `pointer === move.id`.
    return {
      enabled: true,
      method: this.method,
      pointer: this.idAt(state.timeline, state.timeline.pointer),
      moves: state.timeline.moves,
    };
  }

  async undo(sessionId: string, opts?: { confirmOverwrite?: string[] }): Promise<RollbackOutcome> {
    return this.apply(sessionId, "undo", opts);
  }
  async redo(sessionId: string, opts?: { confirmOverwrite?: string[] }): Promise<RollbackOutcome> {
    return this.apply(sessionId, "redo", opts);
  }
  async goto(sessionId: string, id: number, opts?: { confirmOverwrite?: string[] }): Promise<RollbackOutcome> {
    return this.apply(sessionId, "goto", opts, id);
  }

  /** The disabled outcome used when `snapshotCount` is 0. */
  private disabledOutcome(action: RollbackOutcome["action"]): RollbackOutcome {
    return {
      ok: false,
      action,
      fromPointer: 0,
      toPointer: 0,
      fromId: 0,
      toId: 0,
      restored: [],
      skipped: [],
      undone: 0,
      shellEffects: 0,
      method: "none",
      message: "rollback is off (snapshotCount is 0)",
    };
  }

  /** The move id at a pointer (0 = session start). */
  private idAt(timeline: Timeline, pointer: number): number {
    return pointer > 0 ? (timeline.moves[pointer - 1]?.id ?? 0) : 0;
  }

  /** The conversation checkpoint id a pointer resolves to (§10.12): the
   * after-checkpoint of the move now current, or null (session start) at 0. */
  private checkpointAt(timeline: Timeline, pointer: number): string | null {
    if (pointer <= 0) return null;
    return timeline.moves[pointer - 1]?.conversation.afterCheckpointId ?? null;
  }

  private async apply(
    sessionId: string,
    action: "undo" | "redo" | "goto",
    opts?: { confirmOverwrite?: string[] },
    gotoId?: number,
  ): Promise<RollbackOutcome> {
    if (!this.enabled) return this.disabledOutcome(action);
    const state = await this.load(sessionId);
    const from = state.timeline.pointer;
    const overwrite = new Set(opts?.confirmOverwrite ?? []);

    const plan =
      action === "undo"
        ? planUndo(state.timeline)
        : action === "redo"
          ? planRedo(state.timeline)
          : planGoto(state.timeline, gotoId!);

    if (!plan.ok) {
      const fromId = this.idAt(state.timeline, from);
      return {
        ok: false,
        action,
        fromPointer: from,
        toPointer: from,
        fromId,
        toId: fromId,
        restored: [],
        skipped: [],
        ...(plan.blockedMove ? { notUndoable: plan.blockedMove.files.notUndoable } : {}),
        undone: 0,
        shellEffects: 0,
        method: "none",
        message: plan.reason,
      };
    }

    const allRestored: string[] = [];
    const allSkipped: { path: string; reason: string }[] = [];
    const allConflicts: string[] = [];
    let pointer = from;
    let undone = 0;
    let shellEffects = 0;
    let steppedMethod: SnapshotMethod = "none";

    // Execute steps in order; each step applies BOTH halves all-or-nothing:
    //   (b) dry-run the file half for conflicts; stop and change nothing if any
    //       are unconfirmed; (c) apply the file half; (d) write the conversation
    //       tip; (e) on a tip-write failure REVERSE the file half and stop.
    for (const step of plan.steps) {
      const move = step.move;
      const hasFiles = move.files.method !== "none" && move.files.paths.length > 0;

      // (b)+(c) apply the file half (the store itself does dry-run→stage→rename;
      // a conflict returns with nothing changed).
      let res = { restored: [] as string[], conflicts: [] as string[], skipped: [] as { path: string; reason: string }[] };
      if (hasFiles) {
        res = await this.deps.store.restore(move, step.direction, { overwrite });
        if (res.conflicts.length > 0) {
          allConflicts.push(...res.conflicts);
          break; // stop before this step; pointer stays at the last applied
        }
        if (move.files.method !== "none") steppedMethod = move.files.method;
      }

      // The conversation tip for the state AFTER this step.
      const nextPointer = pointer + (step.direction === "undo" ? -1 : 1);
      const tipCheckpoint = this.checkpointAt(state.timeline, nextPointer);
      const pointerId = this.idAt(state.timeline, nextPointer);

      // (d) write the conversation tip; (e) reverse the file half on failure.
      if (this.writeTipFn) {
        try {
          await this.writeTipFn(sessionId, {
            checkpointId: tipCheckpoint,
            pointerId,
            restored: res.restored,
          });
        } catch (e) {
          if (hasFiles) {
            // Reverse the file half: apply the opposite direction, force the
            // same paths so the reversal is not itself blocked by a conflict.
            await this.deps.store
              .restore(move, step.direction === "undo" ? "redo" : "undo", {
                overwrite: new Set(res.restored),
              })
              .catch(() => undefined);
          }
          const fromId0 = this.idAt(state.timeline, from);
          return {
            ok: false,
            action,
            fromPointer: from,
            toPointer: pointer,
            fromId: fromId0,
            toId: this.idAt(state.timeline, pointer),
            restored: [],
            skipped: allSkipped,
            undone,
            shellEffects,
            method: steppedMethod,
            message: `conversation tip write failed: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      }

      allRestored.push(...res.restored);
      allSkipped.push(...res.skipped);
      shellEffects += move.files.notUndoable.filter((n) => n.kind === "shell").length;
      pointer = nextPointer;
      if (step.direction === "undo") undone += 1;

      if (this.deps.journalStep && res.restored.length > 0) {
        await this.deps
          .journalStep(sessionId, {
            action,
            paths: res.restored,
            undoHint: step.direction === "undo" ? "redo to reapply" : "undo to reverse",
          })
          .catch(() => undefined);
      }
    }

    // Persist the new pointer.
    state.timeline = { ...state.timeline, pointer };
    await this.persist(sessionId, state);

    // §10.12 — restore the CONTEXT half + RESET the derived caches from the
    // TARGET move (the move now current). Done once, only when the pointer
    // actually moved, so a no-op traversal leaves live state untouched. Pointer 0
    // (session start) restores NO context (null). A restore failure never fails
    // the traversal — the files/conversation already moved.
    if (this.restoreContextFn && pointer !== from) {
      const targetCtx: MoveContext | null = pointer > 0 ? (state.timeline.moves[pointer - 1]?.context ?? {}) : null;
      try {
        await this.restoreContextFn(sessionId, targetCtx);
      } catch {
        /* a context restore failure never fails the traversal */
      }
    }

    const ok = allConflicts.length === 0;
    const toId = this.idAt(state.timeline, pointer);
    if (pointer !== from) {
      this.deps.emit(
        "ROLLBACK_APPLIED",
        { id: toId, method: steppedMethod, fileCount: allRestored.length, direction: action, conversationTargets: Math.abs(pointer - from) },
        sessionId,
      );
    }

    return {
      ok,
      action,
      fromPointer: from,
      toPointer: pointer,
      fromId: this.idAt(state.timeline, from),
      toId,
      restored: allRestored,
      skipped: allSkipped,
      ...(allConflicts.length > 0 ? { conflicts: allConflicts } : {}),
      undone,
      shellEffects,
      method: steppedMethod,
      message: ok ? `moved to move ${toId}` : `conflict: ${allConflicts.length} path(s) changed since the move`,
    };
  }
}
