/**
 * In-memory snapshot store (core-blueprint.md §10.12, §1 rule 7).
 *
 * A test double for the `SnapshotStore` port: it keeps whole-content before/
 * after copies per move in memory (no git, no fs) so the `RollbackService` and
 * its callers can be exercised without a real repo or workspace. It models the
 * SAME restore semantics as the real stores (undo restores BEFORE iff current
 * === AFTER; redo restores AFTER iff current === BEFORE; a mismatch is a
 * conflict; created → deleted on undo; deleted → recreated on undo; protected
 * control paths are skipped).
 *
 * "Current" on-disk content is modelled by an injected `world` map the test
 * mutates (relPath → bytes|null) so capture and restore operate on it.
 */
import type {
  SnapshotStore,
  TurnContext,
  MoveDraft,
  NoteWriteInput,
  RestoreResult,
  RestoreWhich,
  ReadState,
} from "../../entities/ports/snapshot-store.js";
import type { Move, MovePath, NotUndoable, Timeline } from "../../entities/rollback.js";

interface StoredPath {
  path: string;
  kind: MovePath["kind"];
  before: Buffer | null;
  after: Buffer | null;
  mode?: number;
}
interface StoredMove {
  paths: StoredPath[];
  notUndoable?: NotUndoable[];
}

export class InMemorySnapshotStore implements SnapshotStore {
  readonly method = "cache" as const;
  private readonly moves = new Map<number, StoredMove>();
  private readonly timelines = new Map<string, Timeline>();
  private turn: { before: Map<string, Buffer | null>; shell: string[] } | null = null;

  /** The simulated on-disk world: relPath → bytes (null = absent). */
  constructor(public readonly world: Map<string, Buffer | null> = new Map()) {}

  async beginTurn(_ctx: TurnContext): Promise<void> {
    this.turn = { before: new Map(), shell: [] };
  }

  async noteWrite(input: NoteWriteInput): Promise<void> {
    if (!this.turn) return;
    if (input.shellUnattributable) {
      this.turn.shell.push(input.shellCommand ?? "shell");
      return;
    }
    if (!this.turn.before.has(input.target)) {
      this.turn.before.set(input.target, input.beforeBytes ?? null);
    }
  }

  async commitTurn(ctx: TurnContext): Promise<MoveDraft | null> {
    const t = this.turn;
    this.turn = null;
    if (!t) return null;
    const paths: StoredPath[] = [];
    const movePaths: MovePath[] = [];
    for (const [rel, before] of t.before.entries()) {
      const after = this.world.get(rel) ?? null;
      const bMissing = before === null;
      const aMissing = after === null;
      if (bMissing && aMissing) continue;
      if (before && after && before.equals(after)) continue;
      const kind: MovePath["kind"] = bMissing ? "created" : aMissing ? "deleted" : "modified";
      paths.push({ path: rel, kind, before, after });
      movePaths.push({ path: rel, kind, restorable: true });
    }
    const notUndoable = t.shell.map((c) => ({ kind: "shell" as const, detail: c }));
    if (paths.length === 0 && notUndoable.length === 0) return null;
    this.moves.set(ctx.moveId, { paths, ...(notUndoable.length ? { notUndoable } : {}) });
    return {
      paths: movePaths,
      method: "cache",
      ...(notUndoable.length ? { notUndoable } : {}),
    };
  }

  async readState(move: Move, which: RestoreWhich, relPath: string): Promise<ReadState> {
    const m = this.moves.get(move.id);
    const p = m?.paths.find((x) => x.path === relPath);
    if (!p) return "absent";
    return which === "before" ? p.before : p.after;
  }

  async restore(move: Move, direction: "undo" | "redo", opts: { overwrite: Set<string> }): Promise<RestoreResult> {
    const m = this.moves.get(move.id);
    const result: RestoreResult = { restored: [], conflicts: [], skipped: [] };
    if (!m) {
      for (const p of move.files.paths) result.skipped.push({ path: p.path, reason: "snapshot missing" });
      return result;
    }
    const expectWhich: RestoreWhich = direction === "undo" ? "after" : "before";
    const targetWhich: RestoreWhich = direction === "undo" ? "before" : "after";
    const plans: { rel: string; target: Buffer | null }[] = [];
    for (const p of m.paths) {
      if (isControl(p.path)) {
        result.skipped.push({ path: p.path, reason: "protected control location" });
        continue;
      }
      const expect = expectWhich === "before" ? p.before : p.after;
      const current = this.world.get(p.path) ?? null;
      const matches = expect === null ? current === null : current !== null && expect.equals(current);
      if (!matches && !opts.overwrite.has(p.path)) {
        result.conflicts.push(p.path);
        continue;
      }
      plans.push({ rel: p.path, target: targetWhich === "before" ? p.before : p.after });
    }
    if (result.conflicts.length > 0) return { restored: [], conflicts: result.conflicts, skipped: result.skipped };
    for (const pl of plans) {
      if (pl.target === null) this.world.set(pl.rel, null);
      else this.world.set(pl.rel, pl.target);
      result.restored.push(pl.rel);
    }
    return result;
  }

  async drop(moveIds: number[]): Promise<void> {
    for (const id of moveIds) this.moves.delete(id);
  }
  async persistTimeline(sessionId: string, timeline: Timeline): Promise<void> {
    this.timelines.set(sessionId, JSON.parse(JSON.stringify(timeline)) as Timeline);
  }
  async loadTimeline(sessionId: string): Promise<Timeline | null> {
    return this.timelines.get(sessionId) ?? null;
  }
}

function isControl(rel: string): boolean {
  const l = rel.toLowerCase();
  return l.startsWith(".voidrift/") || l === ".voidrift";
}
