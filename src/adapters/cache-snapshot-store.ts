/**
 * The CACHE snapshot store (core-blueprint.md §10.12).
 *
 * The best-effort rollback method chosen when there is NO git repo (or git is
 * unavailable). Per session under `<workspaceRoot>/.voidrift/cache/snapshots/<sessionId>/`:
 *   timeline.json            the moves + pointer + method (atomic temp+rename, 0600)
 *   moves/<id>.json          one manifest per move (paths + per-path before/after shas)
 *   blobs/<sha256>           content-addressed RAW file contents (0600)
 *
 * Capture: `noteWrite` records the FIRST before-state per path in a turn (bytes
 * or absent); at `commitTurn` the ACTUAL file is read for the after-state, and a
 * path whose after !== before is a changed path. A non-safe `execute_command`
 * whose file targets are NOT statically known is recorded as a NOT-UNDOABLE
 * shell effect; when its targets ARE known the decision point notes them as
 * ordinary writes so they are captured.
 *
 * Caps (§10.12): per file 5 MiB (a larger file is listed `restorable:false,
 * reason:'too large'` and not copied), total blobs 256 MiB per session (oldest
 * moves dropped first). Independent of `mutationLogLevel`.
 *
 * This is a PROTECTED CONTROL LOCATION (§9.4): the Guardian denies a model
 * file/shell read or write of it. Owner-only (dirs 0700, files 0600). I/O is
 * direct `node:fs` (raw Buffers, explicit modes), not the text FileSystemPort.
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  existsSync,
  statSync,
  lstatSync,
  chmodSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  SnapshotStore,
  TurnContext,
  MoveDraft,
  NoteWriteInput,
  RestoreResult,
  RestoreWhich,
  ReadState,
} from "../entities/ports/snapshot-store.js";
import type { Move, MovePath, NotUndoable, Timeline } from "../entities/rollback.js";
import { isValidSessionId } from "./repositories/session-repository.js";
import { RollbackIntegrity } from "./rollback-integrity.js";
import { applyStaged, sweepSessionTmp, sessionTmpDir } from "./rollback-staging.js";
import { limitDefault } from "../entities/limits.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Per-file cap default (§10.12, §13.11 SNAP1): registry
 * `rollback.cachePerFileBytes` (5 MiB). A larger file is listed but not copied.
 * The runtime passes the effective cascaded value via deps. */
const PER_FILE_CAP_DEFAULT = limitDefault("rollback.cachePerFileBytes");
/** Per-session total blob budget default (§10.12, §13.11 SNAP1): registry
 * `rollback.cacheSessionBytes` (256 MiB), oldest moves dropped first. */
const TOTAL_BLOB_CAP_DEFAULT = limitDefault("rollback.cacheSessionBytes");

const SHA256_HEX = /^[0-9a-f]{64}$/;
function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
function isSha(s: unknown): s is string {
  return typeof s === "string" && SHA256_HEX.test(s);
}

/** The reason reported for a path whose blob failed its content re-hash
 * (§10.12): a planted/corrupt blob under a valid-looking name. */
const INTEGRITY_FAIL_REASON = "snapshot content failed its integrity check";

/** A per-move manifest on disk (§10.12). `before`/`after` are blob shas, or
 * `null` when the path did not exist in that state, or `undefined` when not
 * captured (over-cap). `hmac` binds the manifest to this install/session/
 * workspace (§10.12); a missing/invalid one means the manifest is untrusted. */
interface CacheManifest {
  id: number;
  turn: number;
  method: "cache";
  paths: {
    path: string;
    kind: MovePath["kind"];
    restorable: boolean;
    reason?: string;
    before?: string | null;
    after?: string | null;
    mode?: number;
  }[];
  notUndoable?: NotUndoable[];
  /** HMAC over the canonical JSON of the rest + session id + workspace realpath
   * (§10.12). Absent/invalid → the manifest is untrusted and ignored. */
  hmac?: string;
}

/** The per-turn attribution the store accumulates between beginTurn/commitTurn. */
interface TurnState {
  moveId: number;
  turn: number;
  /** First-before per path: bytes (copied) or null (did not exist). */
  before: Map<string, Buffer | null>;
  /** Not-undoable shell effects noted this turn. */
  shell: { command: string }[];
}

export interface CacheSnapshotStoreDeps {
  /** The workspace root; snapshots live at `<root>/.voidrift/cache/snapshots/`. */
  workspaceRoot: string;
  /** The global config dir for the per-install integrity key (§10.12). Null in a
   * pure test forces the per-process in-memory key. */
  globalConfigDir?: string | null;
  /** Emit ONE value-free warning when a session's planted state is ignored
   * (§10.12). Optional (absent in a pure store test). */
  onUntrusted?: (sessionId: string) => void;
  /** Emit ONE value-free warning when a crash sweep cleans/recovers leftover
   * rollback staging files (§10.12 item 4); the count only, never paths. */
  onSwept?: (sessionId: string, count: number) => void;
  /** §13.11 SNAP1 — per-file byte cap (registry `rollback.cachePerFileBytes`,
   * default 5 MiB); the effective cascaded value when wired, else the default. */
  perFileBytes?: number;
  /** §13.11 SNAP1 — per-session total blob byte cap (registry
   * `rollback.cacheSessionBytes`, default 256 MiB). */
  sessionBytes?: number;
}

export class CacheSnapshotStore implements SnapshotStore {
  readonly method = "cache" as const;
  private readonly turns = new Map<string, TurnState>();
  private readonly integrity: RollbackIntegrity;
  /** Sessions already reported as untrusted this process (one warning each). */
  private readonly warnedUntrusted = new Set<string>();
  /** §13.11 SNAP1 — effective per-file / per-session caps (deps or registry). */
  private readonly perFileCap: number;
  private readonly totalBlobCap: number;

  constructor(private readonly deps: CacheSnapshotStoreDeps) {
    this.perFileCap = deps.perFileBytes ?? PER_FILE_CAP_DEFAULT;
    this.totalBlobCap = deps.sessionBytes ?? TOTAL_BLOB_CAP_DEFAULT;
    this.integrity = new RollbackIntegrity(deps.globalConfigDir ?? null);
  }

  /** The integrity key state, for the doctor ROLLBACK group (§10.12). */
  keyState(): "persisted" | "in-memory" {
    return this.integrity.keyState();
  }

  /** Startup sweep (§10.12 item 4): recover/clean any leftover rollback staging
   * files from a crash when a session dir is first opened. Called once per
   * session by the service; a sweep warns once with the leftover count. */
  async openSession(sessionId: string): Promise<void> {
    if (!isValidSessionId(sessionId)) return;
    sweepSessionTmp({
      tmpDir: sessionTmpDir(this.sessionDir(sessionId)),
      onSwept: (count) => this.deps.onSwept?.(sessionId, count),
    });
  }

  // ── paths (session-id validated before any join) ────────────────────────────

  private sessionDir(sessionId: string): string {
    if (!isValidSessionId(sessionId)) throw new Error("invalid session id for snapshot store");
    return path.join(this.deps.workspaceRoot, ".voidrift", "cache", "snapshots", sessionId);
  }
  private blobsDir(s: string): string {
    return path.join(this.sessionDir(s), "blobs");
  }
  private movesDir(s: string): string {
    return path.join(this.sessionDir(s), "moves");
  }
  private timelinePath(s: string): string {
    return path.join(this.sessionDir(s), "timeline.json");
  }

  private refuseSymlinked(dir: string): void {
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
      throw new Error("snapshot directory is a symlink; refusing");
    }
  }

  private ensureDirs(sessionId: string): void {
    const base = path.join(this.deps.workspaceRoot, ".voidrift", "cache", "snapshots");
    this.refuseSymlinked(base);
    this.refuseSymlinked(this.sessionDir(sessionId));
    this.refuseSymlinked(this.blobsDir(sessionId));
    this.refuseSymlinked(this.movesDir(sessionId));
    mkdirSync(this.blobsDir(sessionId), { recursive: true, mode: DIR_MODE });
    mkdirSync(this.movesDir(sessionId), { recursive: true, mode: DIR_MODE });
    for (const d of [base, this.sessionDir(sessionId), this.blobsDir(sessionId), this.movesDir(sessionId)]) {
      try {
        if (existsSync(d)) chmodSync(d, DIR_MODE);
      } catch {
        /* best-effort tightening */
      }
    }
  }

  // ── blob store (content-addressed, write-once) ──────────────────────────────

  private putBlob(sessionId: string, content: Buffer): string {
    const sha = sha256(content);
    this.ensureDirs(sessionId);
    const dest = path.join(this.blobsDir(sessionId), sha);
    if (!existsSync(dest)) {
      const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, content, { mode: FILE_MODE });
      renameSync(tmp, dest);
    }
    return sha;
  }
  private getBlob(sessionId: string, sha: string): Buffer | null {
    if (!isSha(sha)) throw new Error("invalid blob sha");
    const p = path.join(this.blobsDir(sessionId), sha);
    if (!existsSync(p)) return null;
    const buf = readFileSync(p);
    // Content re-hash (§10.12): a blob whose bytes do not hash to the requested
    // sha is planted/corrupt — treat it as missing. The caller reports the path
    // as restorable:false with the integrity-fail reason.
    if (sha256(buf) !== sha) return null;
    return buf;
  }

  // ── capture ─────────────────────────────────────────────────────────────────

  async beginTurn(ctx: TurnContext): Promise<void> {
    this.turns.set(ctx.sessionId, {
      moveId: ctx.moveId,
      turn: ctx.turn,
      before: new Map(),
      shell: [],
    });
  }

  async noteWrite(input: NoteWriteInput): Promise<void> {
    const st = this.turns.get(input.sessionId);
    if (!st) return; // no active turn (defensive)
    if (input.shellUnattributable) {
      st.shell.push({ command: input.shellCommand ?? "<shell command>" });
      return;
    }
    const rel = normalizeRel(input.target);
    if (rel === null) return; // unsafe path — never attribute
    if (!st.before.has(rel)) {
      // Capture the FIRST before-state only. beforeBytes === null → did not exist.
      if (input.beforeBytes === null) st.before.set(rel, null);
      else if (input.beforeBytes !== undefined) {
        // Store the before blob now (bounded; over-cap files are kept null-ish).
        st.before.set(rel, input.beforeBytes);
      } else {
        st.before.set(rel, null);
      }
    }
  }

  async commitTurn(ctx: TurnContext): Promise<MoveDraft | null> {
    const st = this.turns.get(ctx.sessionId);
    this.turns.delete(ctx.sessionId);
    if (!st) return null;

    const paths: CacheManifest["paths"] = [];
    for (const [rel, beforeBytes] of st.before.entries()) {
      const abs = path.join(this.deps.workspaceRoot, rel);
      const after = this.readActual(abs);

      const beforeMissing = beforeBytes === null;
      const afterMissing = after === null;
      if (beforeMissing && afterMissing) continue; // created-and-deleted → no change

      // Over-cap handling (either side too big → list but do not copy).
      const overCap =
        (beforeBytes && beforeBytes.length > this.perFileCap) || (after && after.length > this.perFileCap);

      // No net change?
      if (!beforeMissing && !afterMissing && beforeBytes && after && beforeBytes.equals(after)) continue;

      let kind: MovePath["kind"];
      if (beforeMissing) kind = "created";
      else if (afterMissing) kind = "deleted";
      else kind = "modified";

      if (overCap) {
        paths.push({ path: rel, kind, restorable: false, reason: "too large" });
        continue;
      }

      const beforeSha = beforeMissing ? null : this.putBlob(ctx.sessionId, beforeBytes!);
      const afterSha = afterMissing ? null : this.putBlob(ctx.sessionId, after!);
      const mode = this.statMode(abs);
      paths.push({
        path: rel,
        kind,
        restorable: true,
        before: beforeSha,
        after: afterSha,
        ...(mode !== undefined ? { mode } : {}),
      });
    }

    const notUndoable: NotUndoable[] = st.shell.map((s) => ({
      kind: "shell" as const,
      detail: s.command.slice(0, 200),
    }));

    if (paths.length === 0 && notUndoable.length === 0) return null;

    // Persist the manifest.
    this.ensureDirs(ctx.sessionId);
    const manifest: CacheManifest = {
      id: ctx.moveId,
      turn: ctx.turn,
      method: "cache",
      paths,
      ...(notUndoable.length > 0 ? { notUndoable } : {}),
    };
    this.writeManifest(ctx.sessionId, manifest);
    this.enforceTotalCap(ctx.sessionId);

    const movePaths: MovePath[] = paths.map((p) => ({
      path: p.path,
      kind: p.kind,
      restorable: p.restorable,
      ...(p.reason ? { reason: p.reason } : {}),
      ...(p.mode !== undefined ? { mode: p.mode } : {}),
    }));
    return {
      paths: movePaths,
      method: "cache",
      ...(notUndoable.length > 0 ? { notUndoable } : {}),
    };
  }

  private readActual(abs: string): Buffer | null {
    try {
      const st = lstatSync(abs);
      if (st.isSymbolicLink() || !st.isFile()) return null;
      if (st.size > this.perFileCap) return Buffer.alloc(this.perFileCap + 1); // sentinel over-cap
      return readFileSync(abs);
    } catch {
      return null;
    }
  }
  private statMode(abs: string): number | undefined {
    try {
      return statSync(abs).mode & 0o777;
    } catch {
      return undefined;
    }
  }

  private writeManifest(sessionId: string, m: CacheManifest): void {
    const dest = path.join(this.movesDir(sessionId), `${m.id}.json`);
    // Bind the manifest to this install/session/workspace (§10.12): sign the
    // canonical JSON of everything EXCEPT the hmac field itself.
    const { hmac: _omit, ...rest } = m;
    void _omit;
    const signed: CacheManifest = { ...rest, hmac: this.integrity.sign(rest, sessionId, this.deps.workspaceRoot) };
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(signed), { mode: FILE_MODE });
    renameSync(tmp, dest);
  }
  private readManifest(sessionId: string, id: number): CacheManifest | null {
    const p = path.join(this.movesDir(sessionId), `${id}.json`);
    if (!existsSync(p)) return null;
    let parsed: CacheManifest;
    try {
      parsed = JSON.parse(readFileSync(p, "utf8")) as CacheManifest;
    } catch {
      return null;
    }
    // Verify the HMAC over the rest (§10.12). A manifest that is planted, copied
    // from another machine/workspace, or edited has a missing/invalid hmac and
    // is IGNORED as untrusted — nothing from it is ever restored.
    const { hmac, ...rest } = parsed;
    if (!this.integrity.verify(rest, sessionId, this.deps.workspaceRoot, hmac)) {
      this.reportUntrusted(sessionId);
      return null;
    }
    return parsed;
  }

  /** Emit ONE value-free warning per session when planted/untrusted state is
   * found (§10.12). */
  private reportUntrusted(sessionId: string): void {
    if (this.warnedUntrusted.has(sessionId)) return;
    this.warnedUntrusted.add(sessionId);
    this.deps.onUntrusted?.(sessionId);
  }

  // ── read + restore ───────────────────────────────────────────────────────────

  async readState(move: Move, which: RestoreWhich, relPath: string): Promise<ReadState> {
    const m = this.readManifest(move.sessionId, move.id);
    if (!m) return "absent";
    const entry = m.paths.find((p) => p.path === relPath);
    if (!entry || !entry.restorable) return "absent";
    const sha = which === "before" ? entry.before : entry.after;
    if (sha === null) return null; // did not exist in that state
    if (sha === undefined) return "absent";
    const b = this.getBlob(move.sessionId, sha);
    return b === null ? "absent" : b; // null here = missing/corrupt → unknown
  }

  async restore(
    move: Move,
    direction: "undo" | "redo",
    opts: { overwrite: Set<string> },
  ): Promise<RestoreResult> {
    const m = this.readManifest(move.sessionId, move.id);
    const result: RestoreResult = { restored: [], conflicts: [], skipped: [] };
    if (!m) {
      // Even without a manifest, a protected control path is reported as
      // skipped (a rollback NEVER writes one, §10.12) before the missing-
      // snapshot note, so the protection holds unconditionally.
      for (const p of move.files.paths) {
        if (isLikelyControlPath(p.path)) result.skipped.push({ path: p.path, reason: "protected control location" });
        else result.skipped.push({ path: p.path, reason: "snapshot missing" });
      }
      return result;
    }
    // `undo` restores BEFORE, expects current === AFTER; `redo` restores AFTER,
    // expects current === BEFORE.
    const expectWhich: RestoreWhich = direction === "undo" ? "after" : "before";
    const targetWhich: RestoreWhich = direction === "undo" ? "before" : "after";

    // Plan each path; detect conflicts first (all-or-nothing).
    interface Plan {
      rel: string;
      abs: string;
      target: Buffer | null; // null = delete
      mode?: number;
    }
    const plans: Plan[] = [];
    for (const p of m.paths) {
      if (!p.restorable) {
        result.skipped.push({ path: p.path, reason: p.reason ?? "not restorable" });
        continue;
      }
      // A rollback NEVER writes a protected control path; skip & report.
      if (isLikelyControlPath(p.path)) {
        result.skipped.push({ path: p.path, reason: "protected control location" });
        continue;
      }
      const rel = normalizeRel(p.path);
      if (rel === null) {
        result.skipped.push({ path: p.path, reason: "path escapes workspace" });
        continue;
      }
      const abs = path.join(this.deps.workspaceRoot, rel);
      const expectSha = expectWhich === "before" ? p.before : p.after;
      const current = this.readActual(abs);
      const currentSha = current === null ? null : sha256(current);
      // Conflict: current content differs from the expected state.
      const matches = expectSha === null ? current === null : currentSha === expectSha;
      if (!matches && !opts.overwrite.has(p.path)) {
        result.conflicts.push(p.path);
        continue;
      }
      const targetSha = targetWhich === "before" ? p.before : p.after;
      let targetBytes: Buffer | null;
      if (targetSha === null) targetBytes = null; // delete
      else if (targetSha === undefined) {
        result.skipped.push({ path: p.path, reason: "state not captured" });
        continue;
      } else {
        const b = this.getBlob(move.sessionId, targetSha);
        if (b === null) {
          // A blob file present but failing its re-hash is a planted/corrupt
          // blob (§10.12); a truly absent file is merely missing.
          const present = existsSync(path.join(this.blobsDir(move.sessionId), targetSha));
          result.skipped.push({ path: p.path, reason: present ? INTEGRITY_FAIL_REASON : "snapshot blob missing" });
          continue;
        }
        targetBytes = b;
      }
      plans.push({ rel, abs, target: targetBytes, ...(p.mode !== undefined ? { mode: p.mode } : {}) });
    }

    // If ANY conflict and not all overwritten, change NOTHING (all-or-nothing).
    if (result.conflicts.length > 0) {
      return { restored: [], conflicts: result.conflicts, skipped: result.skipped };
    }

    // Apply as a two-phase, crash-safe transaction (§10.12 item 4): every
    // mutation is first staged so the ORIGINAL tree survives on disk until the
    // commit phase. A failure mid-apply rolls every applied step back, leaving
    // the original tree unchanged (no half-applied delete).
    //
    // Phase 1 (prepare): write new content to a temp; rename the current file
    // (if any) to a backup temp; rename the staged temp into place. A pure
    // delete renames the current file to a backup temp (not removed yet).
    // Phase 2 (commit): remove every backup temp. Phase 1 failures undo by
    // renaming backups back and removing staged temps. ALL staging/aside files
    // live under the per-session `tmp/` dir (§10.12 item 4) so a SIGKILL never
    // leaves a `.vr-rollback*` file beside a user file.
    applyStaged(
      plans,
      {
        tmpDir: sessionTmpDir(this.sessionDir(move.sessionId)),
        onSwept: (count) => this.deps.onSwept?.(move.sessionId, count),
      },
      {
        onWrite: (abs) => result.restored.push(path.relative(this.deps.workspaceRoot, abs).split(path.sep).join("/")),
        onDelete: (abs) => {
          result.restored.push(path.relative(this.deps.workspaceRoot, abs).split(path.sep).join("/"));
          this.removeEmptyParents(path.dirname(abs));
        },
      },
    );
    return result;
  }

  /** Remove now-empty parent directories up to (not including) the workspace. */
  private removeEmptyParents(dir: string): void {
    let cur = dir;
    const root = path.resolve(this.deps.workspaceRoot);
    while (cur.startsWith(root) && cur !== root) {
      try {
        if (readdirSync(cur).length > 0) break;
        rmdirSync(cur);
      } catch {
        break;
      }
      cur = path.dirname(cur);
    }
  }

  // ── drop / prune / timeline ───────────────────────────────────────────────────

  async drop(moveIds: number[]): Promise<void> {
    // Delete manifests and orphaned blobs across every session dir we own. We
    // only know ids, so iterate the sessions root and remove matching manifests;
    // then GC blobs no manifest references.
    const base = path.join(this.deps.workspaceRoot, ".voidrift", "cache", "snapshots");
    if (!existsSync(base)) return;
    let sessions: string[];
    try {
      sessions = readdirSync(base).filter((n) => isValidSessionId(n));
    } catch {
      return;
    }
    for (const s of sessions) {
      const mdir = this.movesDir(s);
      if (!existsSync(mdir)) continue;
      let removedAny = false;
      for (const id of moveIds) {
        const p = path.join(mdir, `${id}.json`);
        if (existsSync(p)) {
          rmSync(p, { force: true });
          removedAny = true;
        }
      }
      if (removedAny) this.gcBlobs(s);
    }
  }

  /** Enforce the 256 MiB total blob budget (§10.12): drop OLDEST moves first
   * (by manifest id) until within the cap. Returns the dropped ids. */
  private enforceTotalCap(sessionId: string): number[] {
    const dropped: number[] = [];
    while (this.totalBlobBytes(sessionId) > this.totalBlobCap) {
      const ids = this.manifestIds(sessionId);
      if (ids.length <= 1) break; // keep at least the newest
      const oldest = ids[0]!;
      rmSync(path.join(this.movesDir(sessionId), `${oldest}.json`), { force: true });
      dropped.push(oldest);
      this.gcBlobs(sessionId);
    }
    return dropped;
  }

  private manifestIds(sessionId: string): number[] {
    const mdir = this.movesDir(sessionId);
    if (!existsSync(mdir)) return [];
    return readdirSync(mdir)
      .filter((n) => /^\d+\.json$/.test(n))
      .map((n) => parseInt(n, 10))
      .sort((a, b) => a - b);
  }
  private totalBlobBytes(sessionId: string): number {
    const bdir = this.blobsDir(sessionId);
    if (!existsSync(bdir)) return 0;
    let total = 0;
    for (const n of readdirSync(bdir)) {
      if (!isSha(n)) continue;
      try {
        total += statSync(path.join(bdir, n)).size;
      } catch {
        /* ignore */
      }
    }
    return total;
  }
  /** Delete blobs no remaining manifest references. */
  private gcBlobs(sessionId: string): void {
    const bdir = this.blobsDir(sessionId);
    if (!existsSync(bdir)) return;
    const referenced = new Set<string>();
    for (const id of this.manifestIds(sessionId)) {
      const m = this.readManifest(sessionId, id);
      if (!m) continue;
      for (const p of m.paths) {
        if (isSha(p.before)) referenced.add(p.before as string);
        if (isSha(p.after)) referenced.add(p.after as string);
      }
    }
    for (const n of readdirSync(bdir)) {
      if (!isSha(n)) continue;
      if (!referenced.has(n)) {
        try {
          rmSync(path.join(bdir, n), { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }

  async persistTimeline(sessionId: string, timeline: Timeline): Promise<void> {
    this.ensureDirs(sessionId);
    const dest = this.timelinePath(sessionId);
    // Bind the timeline to this install/session/workspace (§10.12).
    const { hmac: _omit, ...rest } = timeline as Timeline & { hmac?: string };
    void _omit;
    const signed = { ...rest, hmac: this.integrity.sign(rest, sessionId, this.deps.workspaceRoot) };
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(signed), { mode: FILE_MODE });
    renameSync(tmp, dest);
  }
  async loadTimeline(sessionId: string): Promise<Timeline | null> {
    const p = this.timelinePath(sessionId);
    if (!existsSync(p)) return null;
    let parsed: Timeline & { hmac?: string };
    try {
      parsed = JSON.parse(readFileSync(p, "utf8")) as Timeline & { hmac?: string };
    } catch {
      return null;
    }
    // Verify the HMAC (§10.12). A planted/copied/edited timeline is IGNORED:
    // history for the session starts empty and nothing is restored.
    const { hmac, ...rest } = parsed;
    if (!this.integrity.verify(rest, sessionId, this.deps.workspaceRoot, hmac)) {
      this.reportUntrusted(sessionId);
      return null;
    }
    return rest as Timeline;
  }
}

/** Normalize a workspace-relative path: fold backslashes, collapse `.`/`..`, and
 * reject any result that escapes the workspace (leading `..`) or is absolute.
 * Returns null on an unsafe path. */
function normalizeRel(raw: string): string | null {
  if (!raw) return null;
  const folded = raw.replace(/\\/g, "/");
  if (folded.startsWith("/")) return null;
  const segs: string[] = [];
  for (const s of folded.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (segs.length === 0) return null; // escapes root
      segs.pop();
      continue;
    }
    segs.push(s);
  }
  if (segs.length === 0) return null;
  return segs.join("/");
}

/** A conservative control-path check for the restore skip (§10.12). The full
 * classification lives in entities/protected-paths.ts; the store cannot see the
 * ctx, so it refuses any path under the VoidRift control dirs by tail. */
function isLikelyControlPath(rel: string): boolean {
  const l = rel.replace(/\\/g, "/").toLowerCase();
  return (
    l === ".voidrift" ||
    l.startsWith(".voidrift/") ||
    l.includes("/.voidrift/") ||
    l.endsWith("/.git/config") ||
    l === ".git/config" ||
    l.startsWith(".git/hooks/") ||
    l.startsWith(".github/workflows/")
  );
}
