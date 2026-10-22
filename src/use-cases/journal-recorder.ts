/**
 * The mutation journal recorder (core-blueprint.md §10.11).
 *
 * The decision point (§9.1 step 9) invokes this at the MOMENT a write executes:
 * every `write_file`, `edit_file`, `researcher_save_notes`, a non-safe
 * `execute_command`, a `merge_worktree`/staging apply, and EVERY MCP or plugin
 * tool call. Reads never journal. ONE per-action entry per write.
 *
 * TWO CAPTURE LEVELS (§10.11):
 *  - `action` (default for local text files): the per-action entry carries the
 *    before/after blobs of EVERY write, in order (stepwise revert).
 *  - `turn` (the level, and the FALLBACK for a binary or over-cap target even at
 *    `action`): the per-action entry carries metadata ONLY (no blobs); the NET
 *    change per target is emitted as ONE `turn-net` entry at the END of the turn.
 *    `before` = the content seen immediately before the FIRST write to the target
 *    in the turn (absent if it did not exist); `after` = the actual file content
 *    at flush time, read through the SAME `readTargetBytes` seam (so a shell-made
 *    change is captured too), absent if the target is gone at turn end. A target
 *    created-and-deleted in the turn, or whose final content equals its first
 *    content, yields a `turn-net` entry with `note: 'no net change'` and no blobs.
 *
 * The first-before blob is written to the content-addressed store IMMEDIATELY at
 * first touch, so an interrupted turn can still be reverted from the blob even
 * though the `turn-net` ENTRY is only appended at the flush.
 *
 * ORDERING (FAIL CLOSED, §10.11). The decision point captures the before-state
 * BEFORE the write executes, executes the write, then (in a `finally`) calls the
 * recorder which builds and APPENDS the per-action entry. A blob is written
 * BEFORE the entry that references it so an entry never dangles. If the append
 * fails after the write already happened the recorder throws and the decision
 * point surfaces a loud error naming the target.
 */
import type { JournalStore } from "../entities/ports/journal-store.js";
import {
  type JournalEntry,
  type JournalResult,
  type MutationLogLevel,
  type JournalBlobs,
  CONTENT_ARG_KEYS,
  captureBlob,
  captureGranularity,
  redactContentFields,
  blobHash,
  JOURNAL_LIMITS,
} from "../entities/journal.js";

/** What the decision point knows about a write when it records it (§10.11). */
export interface RecordRequest {
  sessionId: string;
  workerId?: string;
  turn: number;
  /** The plan step id/intent, when the plan plugin exposes one; absent here —
   * no plan step is available in the run context (documented in the slice). */
  planStep?: string;
  tool: string;
  /** The exact tool args (content fields are redacted into the `call` here). */
  args: Record<string, unknown>;
  /** The worktree-/workspace-relative target the write touches. */
  target: string;
  result: JournalResult;
  /** The RAW before-state bytes of a file target, captured right before the
   * write executed; undefined for a non-file tool or a target that did not
   * exist (see `beforeMissing`). */
  before?: Buffer;
  /** True when a file target did NOT exist before the write (undo hint). */
  beforeMissing?: boolean;
  /** The RAW after-state bytes (the content written) for a file target. */
  after?: Buffer;
  /** An undo hint the tool supplied (execute_command / MCP / plugin). */
  undoHint?: string;
  /** Set for an `edit_file` whose post-write after-state read failed (§10.11):
   * the after blob is omitted, `afterUnavailable: true` + a note ride the
   * per-action entry, and the decision point surfaces a WARNING. */
  afterUnavailable?: boolean;
}

/** The flush-time file reader the recorder uses to read a target's ACTUAL
 * content at turn end (§10.11), so a shell-made change is captured; null when
 * the target does not exist at flush time. Keyed by (workerId?, relPath) so a
 * worker reads its own tree root. */
export type FlushReader = (relPath: string, workerId: string | undefined) => Promise<Buffer | null>;

export interface JournalRecorderDeps {
  store: JournalStore;
  getLevel: () => MutationLogLevel;
  /** Read an effective limit (§13.11); used for `journal.perTargetContentBytes`
   * (JRNL2). Optional: absent → the entity default. Read fresh each call. */
  getLimit?: (key: string) => number;
  /** Read a target's actual content at flush time; absent disables the
   * flush-time re-read (the aggregator then uses the last-seen after bytes). */
  readTargetAtFlush?: FlushReader;
}

/** Tools whose file content is captured as before/after blobs (§10.11). */
const FILE_CONTENT_TOOLS = new Set(["write_file", "edit_file", "researcher_save_notes"]);

/** Per (session, worker, target) turn aggregation state (§10.11). */
interface TargetAccum {
  /** The file-tool target path. */
  target: string;
  /** The first-before content (undefined when the target did not exist at first
   * touch). Captured and stored to the blob store IMMEDIATELY at first touch. */
  firstBefore?: Buffer;
  firstBeforeMissing: boolean;
  firstBeforeSha?: string;
  firstBeforeTruncated: boolean;
  /** The last-seen after bytes (fallback when no flush reader is wired). */
  lastAfter?: Buffer;
  lastAfterMissing: boolean;
  /** How many per-action writes merged into this target's net change. */
  actions: number;
}

export class JournalRecorder {
  constructor(private readonly deps: JournalRecorderDeps) {}

  /** §13.11 (JRNL2) — the effective per-target content cap, read fresh so a
   * config edit takes effect; the entity default when no limits accessor is
   * wired (behaviour byte-identical at default). */
  private perTargetCap(): number {
    return this.deps.getLimit?.("journal.perTargetContentBytes") ?? JOURNAL_LIMITS.perTargetContentBytes;
  }

  /** The turn aggregators, keyed `sessionId\u0000workerId\u0000target`. */
  private readonly accums = new Map<string, TargetAccum>();
  /** Over-cap skip counts, keyed `sessionId\u0000workerId\u0000turn` (§10.11).
   * Once a (session, worker, turn) reaches `turnNetMaxTargets` DISTINCT netted
   * targets, each further NEW target is journaled per-action metadata only (not
   * aggregated) and counted here; ONE `turn-net-cap` note entry is appended at
   * that scope's flush stating how many were not netted. */
  private readonly overCap = new Map<string, number>();
  /** Per-session promise-queue mutex so concurrent workers never produce a
   * duplicate or out-of-order `seq` (SEQ RACE). */
  private readonly appendChains = new Map<string, Promise<unknown>>();

  private accumKey(sessionId: string, workerId: string | undefined, target: string): string {
    return `${sessionId}\u0000${workerId ?? ""}\u0000${target}`;
  }

  /** The blob shas every LIVE aggregator for a session still holds (a stored
   * first-before blob whose referencing `turn-net` entry is not appended yet).
   * Retention must not evict these mid-turn — the pending flush references them
   * (§10.11). An aggregator is removed from `accums` as its `turn-net` entry is
   * appended, so a flushed target is no longer pinned. */
  private pinnedShas(sessionId: string): Set<string> {
    const pinned = new Set<string>();
    for (const [key, acc] of this.accums.entries()) {
      const sid = key.slice(0, key.indexOf("\u0000"));
      if (sid !== sessionId) continue;
      if (acc.firstBeforeSha) pinned.add(acc.firstBeforeSha);
    }
    return pinned;
  }

  /**
   * Serialize an append-bearing critical section per session (SEQ RACE). The
   * whole `nextSeq`→`append` pair runs under the chain so two concurrent callers
   * can never read the same `nextSeq`. The chain survives a thrown fn.
   */
  private serializeAppend<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.appendChains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Keep the chain alive regardless of outcome; swallow for the stored handle.
    this.appendChains.set(
      sessionId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /** Append one entry under the per-session serialized chain, assigning the
   * next seq atomically with the append so concurrent callers never collide. */
  private async appendSerialized(sessionId: string, build: (seq: number) => JournalEntry): Promise<JournalEntry> {
    return this.serializeAppend(sessionId, async () => {
      const seq = await this.deps.store.nextSeq(sessionId);
      const entry = build(seq);
      await this.deps.store.append(sessionId, entry);
      return entry;
    });
  }

  /**
   * Build and append the single PER-ACTION journal entry for a write (§10.11).
   * At `action` granularity for a target the per-action entry carries the
   * before/after blobs; at `turn` granularity (the level, or the binary/over-cap
   * fallback) it carries metadata only and the write is folded into the turn
   * aggregator (with the first-before blob stored immediately). Throws if the
   * store append fails so the decision point can surface a loud error.
   */
  async record(req: RecordRequest): Promise<JournalEntry> {
    const level = this.deps.getLevel();

    const contentKeys = CONTENT_ARG_KEYS[req.tool] ?? [];
    const call = redactContentFields(req.args, contentKeys);

    const blobs: JournalBlobs = {};
    let truncated = false;
    let undoHint = req.undoHint;

    const isFileTool = FILE_CONTENT_TOOLS.has(req.tool);
    // The effective granularity for this file target: `none`/`action`/`turn`.
    // Binary or over-cap targets fall back to `turn` even at `action`.
    const probe = req.after ?? req.before;
    const gran = isFileTool ? captureGranularity(level, probe, this.perTargetCap()) : "none";

    if (isFileTool && gran === "action") {
      // Per-write blobs on the entry (stepwise revert).
      if (req.before !== undefined) {
        const cap = captureBlob(req.before, this.perTargetCap());
        await this.deps.store.putBlob(req.sessionId, cap.bytes);
        blobs.before = cap.sha;
        truncated ||= cap.truncated;
      }
      if (req.after !== undefined) {
        const cap = captureBlob(req.after, this.perTargetCap());
        await this.deps.store.putBlob(req.sessionId, cap.bytes);
        blobs.after = cap.sha;
        truncated ||= cap.truncated;
      }
    } else if (isFileTool && gran === "turn") {
      // Turn granularity: the per-action entry carries NO blobs; fold this write
      // into the turn aggregator and store the FIRST-before blob immediately so
      // an interrupted turn is still revertible from the blob.
      await this.foldTurn(req);
    }

    // The undo hint for a file write is metadata — written at EVERY level,
    // including `off` (§10.11). It names where the previous state lives.
    if (isFileTool) {
      if (req.beforeMissing) undoHint = undoHint ?? "file did not exist";
      else if (blobs.before) undoHint = undoHint ?? `previous content stored at blob ${blobs.before}`;
      else if (req.before !== undefined) undoHint = undoHint ?? `previous content hash ${blobHash(req.before)}`;
    }

    const entry = await this.appendSerialized(req.sessionId, (seq) => ({
      seq,
      time: new Date().toISOString(),
      sessionId: req.sessionId,
      turn: req.turn,
      ...(req.workerId ? { workerId: req.workerId } : {}),
      ...(req.planStep ? { planStep: req.planStep } : {}),
      tool: req.tool,
      call,
      target: req.target,
      result: req.result,
      ...(undoHint ? { undoHint } : {}),
      ...(blobs.before || blobs.after ? { blobs } : {}),
      ...(truncated ? { truncated: true } : {}),
      ...(req.afterUnavailable ? { afterUnavailable: true, note: "after-state unavailable: post-write read failed" } : {}),
    }));

    await this.afterAppendRetention(req);
    return entry;
  }

  /** Fold a turn-granularity write into its (session, worker, target) accumulator
   * (§10.11), capturing & storing the FIRST-before blob immediately. Enforces the
   * per (session, worker, turn) target cap: once `turnNetMaxTargets` distinct
   * targets are aggregated, a further NEW target is NOT aggregated (its per-action
   * entry still carries metadata); it is counted so flush can emit one
   * `turn-net-cap` note. */
  private async foldTurn(req: RecordRequest): Promise<void> {
    const key = this.accumKey(req.sessionId, req.workerId, req.target);
    let acc = this.accums.get(key);
    if (!acc) {
      // A NEW target: enforce the aggregator cap before creating an accumulator.
      if (this.distinctTargets(req.sessionId, req.workerId) >= JOURNAL_LIMITS.turnNetMaxTargets) {
        const ck = this.capKey(req.sessionId, req.workerId, req.turn);
        this.overCap.set(ck, (this.overCap.get(ck) ?? 0) + 1);
        return; // per-action metadata only; not netted
      }
      acc = {
        target: req.target,
        firstBeforeMissing: !!req.beforeMissing,
        firstBeforeTruncated: false,
        lastAfterMissing: false,
        actions: 0,
      };
      if (req.before !== undefined) {
        const cap = captureBlob(req.before, this.perTargetCap());
        await this.deps.store.putBlob(req.sessionId, cap.bytes); // store NOW
        acc.firstBefore = cap.bytes;
        acc.firstBeforeSha = cap.sha;
        acc.firstBeforeTruncated = cap.truncated;
      }
      this.accums.set(key, acc);
    }
    acc.actions += 1;
    if (req.after !== undefined) {
      acc.lastAfter = req.after;
      acc.lastAfterMissing = false;
    } else {
      // A delete or a non-captured after; remember absence for the fallback path.
      delete acc.lastAfter;
      acc.lastAfterMissing = true;
    }
  }

  /** The over-cap counter key for a (session, worker, turn) scope. */
  private capKey(sessionId: string, workerId: string | undefined, turn: number): string {
    return `${sessionId}\u0000${workerId ?? ""}\u0000${turn}`;
  }

  /** Count the DISTINCT targets already aggregated for a (session, worker) scope
   * in the live turn (aggregators are cleared at each flush, so every live accum
   * belongs to the current turn). */
  private distinctTargets(sessionId: string, workerId: string | undefined): number {
    const prefix = `${sessionId}\u0000${workerId ?? ""}\u0000`;
    let n = 0;
    for (const key of this.accums.keys()) if (key.startsWith(prefix)) n += 1;
    return n;
  }

  /**
   * Flush every target aggregated for a turn (§10.11): append ONE `turn-net`
   * entry per touched target with the net before/after and the merged action
   * count, then drop the aggregators. Scoped to a single worker when `workerId`
   * is given (a worker's run ended), else to the ORCHESTRATOR's own targets
   * (`workerId` undefined) — a parent turn end flushes the orchestrator; each
   * worker flushes its own on run end AND at the parent turn end as a backstop.
   * `after` is read from the ACTUAL file at flush time via `readTargetAtFlush`
   * (capturing shell-made changes); it falls back to the last-seen after bytes
   * when no reader is wired. Flush failures throw like an append failure.
   */
  async flushTurn(
    sessionId: string,
    turn: number,
    opts?: { workerId?: string | undefined; reader?: FlushReader },
  ): Promise<JournalEntry[]> {
    const workerId = opts?.workerId;
    const reader = opts?.reader ?? this.deps.readTargetAtFlush;
    const out: JournalEntry[] = [];
    for (const [key, acc] of [...this.accums.entries()]) {
      const [sid, wid, _target] = key.split("\u0000");
      void _target;
      if (sid !== sessionId) continue;
      if (opts && "workerId" in opts) {
        if ((wid || undefined) !== workerId) continue;
      }
      this.accums.delete(key);
      out.push(await this.emitTurnNet(sessionId, turn, wid || undefined, acc, reader));
    }
    // Emit ONE `turn-net-cap` note per over-cap scope for this turn, then clear
    // its counter. A scope-targeted flush only touches its own worker; an
    // all-scopes flush (no `workerId` in opts) covers every over-cap scope for
    // the session/turn, including scopes that had NO aggregated target left.
    for (const [ck, count] of [...this.overCap.entries()]) {
      const [sid, wid, t] = ck.split("\u0000");
      if (sid !== sessionId || Number(t) !== turn) continue;
      if (opts && "workerId" in opts && (wid || undefined) !== workerId) continue;
      this.overCap.delete(ck);
      if (count <= 0) continue;
      out.push(await this.emitTurnNetCap(sessionId, turn, wid || undefined, count));
    }
    return out;
  }

  /** Append ONE `turn-net-cap` note stating how many targets exceeded the
   * aggregator cap and were journaled per-action metadata only (§10.11). */
  private async emitTurnNetCap(
    sessionId: string,
    turn: number,
    workerId: string | undefined,
    count: number,
  ): Promise<JournalEntry> {
    const entry = await this.appendSerialized(sessionId, (seq) => ({
      seq,
      time: new Date().toISOString(),
      sessionId,
      turn,
      ...(workerId ? { workerId } : {}),
      tool: "turn-net-cap",
      call: { cappedTargets: count, cap: JOURNAL_LIMITS.turnNetMaxTargets },
      target: "",
      result: {
        status: "ok" as const,
        summary: `${count} target(s) beyond the ${JOURNAL_LIMITS.turnNetMaxTargets}-target turn-net cap; journaled per-action metadata only`,
      },
      note: "turn-net target cap exceeded",
    }));
    await this.afterAppendRetention({ sessionId, turn });
    return entry;
  }

  /** Build & append one `turn-net` entry from an accumulator (§10.11). */
  private async emitTurnNet(
    sessionId: string,
    turn: number,
    workerId: string | undefined,
    acc: TargetAccum,
    reader: FlushReader | undefined,
  ): Promise<JournalEntry> {
    // Resolve the net after-state: read the actual file now (shell-made changes),
    // else the last-seen after bytes.
    let after: Buffer | undefined;
    let afterMissing: boolean;
    if (reader) {
      const read = await reader(acc.target, workerId);
      after = read ?? undefined;
      afterMissing = read === null;
    } else {
      after = acc.lastAfter;
      afterMissing = acc.lastAfterMissing || acc.lastAfter === undefined;
    }

    const blobs: JournalBlobs = {};
    let truncated = acc.firstBeforeTruncated;
    let note: string | undefined;

    const beforeMissing = acc.firstBeforeMissing || acc.firstBefore === undefined;

    // No-net-change: created-and-deleted (both missing), or final === first.
    const sameContent =
      !beforeMissing &&
      !afterMissing &&
      acc.firstBefore !== undefined &&
      after !== undefined &&
      Buffer.compare(captureBlob(acc.firstBefore, this.perTargetCap()).bytes, captureBlob(after, this.perTargetCap()).bytes) === 0;
    const createdThenDeleted = beforeMissing && afterMissing;

    if (sameContent || createdThenDeleted) {
      note = "no net change";
    } else {
      if (!beforeMissing && acc.firstBefore !== undefined) {
        // The first-before blob was already stored at first touch; record its sha.
        blobs.before = acc.firstBeforeSha ?? captureBlob(acc.firstBefore, this.perTargetCap()).sha;
      }
      if (!afterMissing && after !== undefined) {
        const cap = captureBlob(after, this.perTargetCap());
        await this.deps.store.putBlob(sessionId, cap.bytes);
        blobs.after = cap.sha;
        truncated ||= cap.truncated;
      }
    }

    const entry = await this.appendSerialized(sessionId, (seq) => ({
      seq,
      time: new Date().toISOString(),
      sessionId,
      turn,
      ...(workerId ? { workerId } : {}),
      tool: "turn-net",
      call: {},
      target: acc.target,
      result: { status: "ok" as const, summary: `net change over ${acc.actions} write(s)` },
      actions: acc.actions,
      ...(blobs.before || blobs.after ? { blobs } : {}),
      ...(truncated ? { truncated: true } : {}),
      ...(note ? { note } : {}),
    }));

    await this.afterAppendRetention({ sessionId, turn });
    return entry;
  }

  /** Enforce blob retention after an append and note any eviction (§10.11).
   * Pins every blob a live turn aggregator still holds (first-before shas with
   * no `turn-net` entry appended yet) so retention never evicts a blob the
   * pending flush must still reference. */
  private async afterAppendRetention(req: { sessionId: string; turn: number }): Promise<void> {
    const pinned = this.pinnedShas(req.sessionId);
    const ret = await this.deps.store.enforceRetention(req.sessionId, pinned);
    if (ret.evictedShas.length > 0) {
      await this.appendSerialized(req.sessionId, (seq) => ({
        seq,
        time: new Date().toISOString(),
        sessionId: req.sessionId,
        turn: req.turn,
        tool: "journal-retention",
        call: { evictedBlobs: ret.evictedShas.length, affectedEntries: ret.blobsEvictedSeqs.length },
        target: "",
        result: { status: "ok", summary: `evicted ${ret.evictedShas.length} oldest blob(s) over retention cap` },
      }));
    }
  }
}
