/**
 * RollbackService tests (core-blueprint.md §10.12) — via the in-memory store.
 *
 * Covers the UNIFIED move timeline: a move is EVERY completed turn (chat-only or
 * file-changing), its conversation half is the before/after checkpoint ids, its
 * file half is git/cache/none. Traversal applies both halves all-or-nothing:
 * a conflict changes nothing, a confirmed overwrite applies both, a
 * conversation-write failure reverses the file half. Plus redo-branch drop,
 * pointer persistence across resume, snapshotCount:0, a merge refuses, an
 * aborted-with-file-change move, protected paths skipped, and events.
 */
import { describe, it, expect, vi } from "vitest";
import { RollbackService, type RollbackStepRecord, type TipTarget } from "./rollback.js";
import { InMemorySnapshotStore } from "../adapters/repositories/in-memory-snapshot-store.js";

const SID = "deadbeef";

function svc(opts?: { snapshotCount?: number; world?: Map<string, Buffer | null>; failTip?: () => boolean }) {
  const store = new InMemorySnapshotStore(opts?.world ?? new Map());
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const steps: RollbackStepRecord[] = [];
  const tips: TipTarget[] = [];
  const restores: (import("../entities/rollback.js").MoveContext | null)[] = [];
  const service = new RollbackService({
    store,
    getSnapshotCount: () => opts?.snapshotCount ?? 50,
    emit: (type, payload) => events.push({ type, payload: payload as Record<string, unknown> }),
    journalStep: async (_s, step) => {
      steps.push(step);
    },
  });
  // The conversation-tip writer the facade wires in production.
  service.setWriteTip(async (_sid, target) => {
    if (opts?.failTip?.()) throw new Error("tip write boom");
    tips.push(target);
  });
  // The context-restore callback the facade wires in production (§10.12).
  service.setRestoreContext((_sid, context) => {
    restores.push(context);
  });
  return { store, service, events, steps, tips, restores };
}

let cp = 0;
/** Run one writing turn: begin (before cp), writes, commit (after cp). */
async function turn(
  service: RollbackService,
  store: InMemorySnapshotStore,
  id: number,
  userMsg: string,
  writes: { path: string; before: Buffer | null; after: Buffer | null }[],
  shell?: string,
  context?: { rollingSummary?: string; usageAnchor?: number },
): Promise<void> {
  const before = cp === 0 ? null : `cp-${cp}`;
  await service.beginTurn(SID, id, before);
  for (const w of writes) {
    await service.noteWrite({ sessionId: SID, target: w.path, beforeBytes: w.before });
    store.world.set(w.path, w.after); // the write takes effect on disk
  }
  if (shell) await service.noteWrite({ sessionId: SID, target: shell, shellUnattributable: true, shellCommand: shell });
  cp += 1;
  await service.commitTurn(SID, userMsg, `cp-${cp}`, context);
}

/** A chat-only turn: no writes, but a durable checkpoint → still a move. */
async function chatTurn(
  service: RollbackService,
  id: number,
  userMsg: string,
  context?: { rollingSummary?: string; usageAnchor?: number },
): Promise<void> {
  const before = cp === 0 ? null : `cp-${cp}`;
  await service.beginTurn(SID, id, before);
  cp += 1;
  await service.commitTurn(SID, userMsg, `cp-${cp}`, context);
}

describe("RollbackService (§10.12)", () => {
  it("a chat-only turn records a move with method none; a read-only aborted turn records none", async () => {
    cp = 0;
    const { service, events } = svc();
    await chatTurn(service, 1, "hi there");
    const report = await service.moves(SID);
    expect(report.moves).toHaveLength(1);
    expect(report.moves![0]!.files.method).toBe("none");
    expect(report.moves![0]!.files.paths).toEqual([]);
    expect(report.moves![0]!.conversation.beforeCheckpointId).toBeNull();
    expect(report.moves![0]!.conversation.afterCheckpointId).toBe("cp-1");
    // MOVE_RECORDED fires for a chat-only turn with method none.
    const mr = events.find((e) => e.type === "MOVE_RECORDED")!.payload;
    expect(Object.keys(mr).sort()).toEqual(["fileCount", "id", "method", "turn"]);
    expect(mr).toMatchObject({ id: 1, method: "none", fileCount: 0 });

    // An aborted turn (no checkpoint, no files) records nothing.
    await service.beginTurn(SID, 2, "cp-1");
    await service.commitTurn(SID, "aborted", null);
    expect((await service.moves(SID)).moves).toHaveLength(1);
  });

  it("a turn with two writes becomes ONE move", async () => {
    cp = 0;
    const { service, store } = svc();
    await turn(service, store, 1, "edit two", [
      { path: "a.txt", before: null, after: Buffer.from("A") },
      { path: "b.txt", before: null, after: Buffer.from("B") },
    ]);
    const report = await service.moves(SID);
    expect(report.moves).toHaveLength(1);
    expect(report.moves![0]!.files.paths.map((p) => p.path).sort()).toEqual(["a.txt", "b.txt"]);
    expect(report.pointer).toBe(1);
  });

  it("undo then redo restores files AND targets the right conversation tip", async () => {
    cp = 0;
    const { service, store, events, tips } = svc();
    await turn(service, store, 1, "create a", [{ path: "a.txt", before: null, after: Buffer.from("A") }]);
    const undo = await service.undo(SID);
    expect(undo.ok).toBe(true);
    expect(undo.restored).toEqual(["a.txt"]);
    expect(store.world.get("a.txt")).toBeNull(); // created → removed on undo
    expect(undo.toPointer).toBe(0);
    // The conversation tip for pointer 0 is session start (null checkpoint).
    expect(tips.at(-1)).toMatchObject({ checkpointId: null, pointerId: 0 });

    const redo = await service.redo(SID);
    expect(redo.ok).toBe(true);
    expect(store.world.get("a.txt")!.toString()).toBe("A");
    expect(redo.toPointer).toBe(1);
    expect(tips.at(-1)).toMatchObject({ checkpointId: "cp-1", pointerId: 1 });
    expect(events.filter((e) => e.type === "ROLLBACK_APPLIED")).toHaveLength(2);
    const ra = events.find((e) => e.type === "ROLLBACK_APPLIED")!.payload;
    expect(ra).toMatchObject({ method: "cache", direction: "undo", conversationTargets: 1 });
  });

  it("a cancelled conflict leaves files AND conversation untouched; confirm applies both", async () => {
    cp = 0;
    const { service, store, tips } = svc();
    await turn(service, store, 1, "set a", [{ path: "a.txt", before: Buffer.from("v1"), after: Buffer.from("v2") }]);
    store.world.set("a.txt", Buffer.from("v3")); // user edit → conflict
    const tipsBefore = tips.length;
    const c = await service.undo(SID);
    expect(c.ok).toBe(false);
    expect(c.conflicts).toEqual(["a.txt"]);
    expect(store.world.get("a.txt")!.toString()).toBe("v3"); // files untouched
    expect(c.toPointer).toBe(1);
    expect(tips.length).toBe(tipsBefore); // conversation tip NOT rewritten
    // Confirm overwrite → both halves move.
    const ok = await service.undo(SID, { confirmOverwrite: ["a.txt"] });
    expect(ok.ok).toBe(true);
    expect(store.world.get("a.txt")!.toString()).toBe("v1");
    expect(tips.length).toBe(tipsBefore + 1);
  });

  it("a conversation-tip write failure REVERSES the file half", async () => {
    cp = 0;
    let fail = false;
    const { service, store } = svc({ failTip: () => fail });
    await turn(service, store, 1, "create a", [{ path: "a.txt", before: null, after: Buffer.from("A") }]);
    fail = true;
    const undo = await service.undo(SID);
    expect(undo.ok).toBe(false);
    expect(undo.message).toContain("tip write failed");
    // The file half was applied then reversed → a.txt is back to its after-state.
    expect(store.world.get("a.txt")!.toString()).toBe("A");
  });

  it("goto walks several moves (mixed kinds) in order and journals per restore", async () => {
    cp = 0;
    const { service, store, steps } = svc();
    await chatTurn(service, 1, "chat first");
    await turn(service, store, 2, "m2", [{ path: "b.txt", before: null, after: Buffer.from("2") }]);
    await chatTurn(service, 3, "chat third");
    steps.length = 0;
    const g = await service.goto(SID, 1); // undo move 3 (chat), move 2 (file)
    expect(g.ok).toBe(true);
    expect(g.toPointer).toBe(1);
    expect(g.toId).toBe(1);
    expect(store.world.get("b.txt")).toBeNull();
    expect(steps).toHaveLength(1); // only the file move produced a restore to journal
  });

  it("a new move while behind drops the redo branch and prunes its snapshots", async () => {
    cp = 0;
    const { service, store } = svc();
    await turn(service, store, 1, "m1", [{ path: "a.txt", before: null, after: Buffer.from("1") }]);
    await turn(service, store, 2, "m2", [{ path: "b.txt", before: null, after: Buffer.from("2") }]);
    await service.undo(SID);
    const dropSpy = vi.spyOn(store, "drop");
    await turn(service, store, 3, "m3", [{ path: "c.txt", before: null, after: Buffer.from("3") }]);
    expect(dropSpy).toHaveBeenCalledWith([2]);
    const report = await service.moves(SID);
    expect(report.moves!.map((m) => m.id)).toEqual([1, 3]);
    // pointer is the ID of the last applied move (move 3), not an applied-count.
    expect(report.pointer).toBe(3);
  });

  it("persists the pointer+timeline so a resume continues, redo still works until a new turn", async () => {
    cp = 0;
    const world = new Map<string, Buffer | null>();
    const { service, store } = svc({ world });
    await turn(service, store, 1, "m1", [{ path: "a.txt", before: null, after: Buffer.from("1") }]);
    await service.undo(SID); // pointer → 0
    // A fresh service over the SAME store = a resume.
    const tips2: TipTarget[] = [];
    const service2 = new RollbackService({ store, getSnapshotCount: () => 50, emit: () => {} });
    service2.setWriteTip(async (_s, t) => {
      tips2.push(t);
    });
    const report = await service2.moves(SID);
    expect(report.moves).toHaveLength(1);
    expect(report.pointer).toBe(0);
    const redo = await service2.redo(SID);
    expect(redo.ok).toBe(true);
    expect(redo.toPointer).toBe(1);
    expect(tips2.at(-1)).toMatchObject({ checkpointId: "cp-1" });
  });

  it("snapshotCount 0 disables rollback entirely (conversation traversal included)", async () => {
    cp = 0;
    const { service } = svc({ snapshotCount: 0 });
    await chatTurn(service, 1, "hi");
    const report = await service.moves(SID);
    expect(report.enabled).toBe(false);
    const undo = await service.undo(SID);
    expect(undo.ok).toBe(false);
    expect(undo.message).toContain("rollback is off");
  });

  it("prunes the oldest move past snapshotCount and emits MOVES_PRUNED", async () => {
    cp = 0;
    const { service, store, events } = svc({ snapshotCount: 2 });
    await turn(service, store, 1, "m1", [{ path: "a.txt", before: null, after: Buffer.from("1") }]);
    await turn(service, store, 2, "m2", [{ path: "b.txt", before: null, after: Buffer.from("2") }]);
    await turn(service, store, 3, "m3", [{ path: "c.txt", before: null, after: Buffer.from("3") }]);
    const report = await service.moves(SID);
    expect(report.moves!.map((m) => m.id)).toEqual([2, 3]);
    const mp = events.find((e) => e.type === "MOVES_PRUNED")!.payload;
    expect(mp).toMatchObject({ prunedIds: [1], method: "cache", remaining: 2 });
  });

  it("an aborted turn that changed a file still records a move (conversation unchanged)", async () => {
    cp = 0;
    const { service, store } = svc();
    // begin with a before checkpoint, write, then commit with NO after checkpoint.
    await service.beginTurn(SID, 1, "cp-prev");
    await service.noteWrite({ sessionId: SID, target: "a.txt", beforeBytes: null });
    store.world.set("a.txt", Buffer.from("A"));
    await service.commitTurn(SID, "aborted but wrote", null);
    const report = await service.moves(SID);
    expect(report.moves).toHaveLength(1);
    const m = report.moves![0]!;
    // conversation after === before (unchanged) yet the file half is undoable.
    expect(m.conversation.afterCheckpointId).toBe("cp-prev");
    expect(m.conversation.beforeCheckpointId).toBe("cp-prev");
    const undo = await service.undo(SID);
    expect(undo.ok).toBe(true);
    expect(store.world.get("a.txt")).toBeNull();
  });

  it("a merge move is not undoable and goto refuses to cross it", async () => {
    cp = 0;
    const { service, store } = svc();
    await turn(service, store, 1, "m1", [{ path: "a.txt", before: null, after: Buffer.from("1") }]);
    await service.beginTurn(SID, 2, "cp-1");
    await service.noteWrite({ sessionId: SID, target: "merge", shellUnattributable: true, shellCommand: "merge_worktree" });
    cp += 1;
    await service.commitTurn(SID, "m2 merge", `cp-${cp}`);
    await turn(service, store, 3, "m3", [{ path: "c.txt", before: null, after: Buffer.from("3") }]);
    const g = await service.goto(SID, 1);
    expect(g.ok).toBe(false);
    expect(g.message.toLowerCase()).toContain("shell");
  });

  it("skips a protected control path in a restore", async () => {
    cp = 0;
    const { service, store } = svc();
    store.world.set(".voidrift/config.json", Buffer.from("x"));
    await turn(service, store, 1, "touch config", [
      { path: ".voidrift/config.json", before: Buffer.from("w"), after: Buffer.from("x") },
      { path: "ok.txt", before: null, after: Buffer.from("ok") },
    ]);
    const undo = await service.undo(SID);
    expect(undo.skipped.map((s) => s.path)).toContain(".voidrift/config.json");
    expect(store.world.get(".voidrift/config.json")!.toString()).toBe("x");
    expect(store.world.get("ok.txt")).toBeNull();
  });

  it("records the post-turn context on each move and restores it from the TARGET on traversal", async () => {
    cp = 0;
    const { service, restores } = svc();
    await chatTurn(service, 1, "m1", { usageAnchor: 100 });
    await chatTurn(service, 2, "m2 fold", { rollingSummary: "[VOIDRIFT SUMMARY v1]\nolder work", usageAnchor: 200 });
    await chatTurn(service, 3, "m3", { rollingSummary: "[VOIDRIFT SUMMARY v1]\nolder work", usageAnchor: 300 });

    const report = await service.moves(SID);
    expect(report.moves![1]!.context).toEqual({ rollingSummary: "[VOIDRIFT SUMMARY v1]\nolder work", usageAnchor: 200 });

    // undo to move 1 (before the fold) → the restore carries NO summary, anchor 100.
    restores.length = 0;
    await service.undo(SID); // → move 2
    await service.undo(SID); // → move 1
    expect(restores.at(-1)).toEqual({ usageAnchor: 100 });

    // goto 0 (session start) → restore is null (no summary, no anchor).
    restores.length = 0;
    await service.goto(SID, 0);
    expect(restores.at(-1)).toBeNull();

    // redo past the fold (goto 3) → the summary is back and anchor is 300.
    restores.length = 0;
    await service.goto(SID, 3);
    expect(restores.at(-1)).toEqual({ rollingSummary: "[VOIDRIFT SUMMARY v1]\nolder work", usageAnchor: 300 });
  });

  it("drops an over-cap rolling summary on the move (rollingSummaryDropped) and restores no summary", async () => {
    cp = 0;
    const { service, restores } = svc();
    const huge = "x".repeat(17 * 1024); // > 16 KiB cap
    await chatTurn(service, 1, "m1", { rollingSummary: huge, usageAnchor: 50 });
    await chatTurn(service, 2, "m2");
    const report = await service.moves(SID);
    expect(report.moves![0]!.context).toEqual({ rollingSummaryDropped: true, usageAnchor: 50 });
    restores.length = 0;
    await service.undo(SID); // → move 1
    expect(restores.at(-1)).toEqual({ rollingSummaryDropped: true, usageAnchor: 50 });
  });

  it("does NOT restore context on a no-op traversal (already at the end/start)", async () => {
    cp = 0;
    const { service, restores } = svc();
    await chatTurn(service, 1, "m1", { usageAnchor: 10 });
    restores.length = 0;
    const r = await service.redo(SID); // already at the tip
    expect(r.ok).toBe(false);
    expect(restores).toHaveLength(0);
  });

  it("after a prune, moves().pointer is the ID of the last applied move (not an applied-count)", async () => {
    cp = 0;
    const { service } = svc({ snapshotCount: 2 });
    await chatTurn(service, 1, "m1");
    await chatTurn(service, 2, "m2");
    await chatTurn(service, 3, "m3"); // prunes move 1; window is [2,3]
    const report = await service.moves(SID);
    expect(report.moves!.map((m) => m.id)).toEqual([2, 3]);
    // The pointer is the ID of the last applied move (3), so the CLI ▶ lands on
    // the right row even though ids no longer start at 1.
    expect(report.pointer).toBe(3);

    // undo → pointer is now move 2's ID.
    await service.undo(SID);
    expect((await service.moves(SID)).pointer).toBe(2);

    // goto 3 after the prune re-applies move 3 → pointer ID 3.
    const g = await service.goto(SID, 3);
    expect(g.ok && g.toPointer).toBeTruthy();
    expect((await service.moves(SID)).pointer).toBe(3);
  });
});
