/**
 * The GIT snapshot store (core-blueprint.md §10.12).
 *
 * The rollback method chosen when the workspace IS a git repository and git
 * runs. Around each writing turn it captures a snapshot of the WHOLE working
 * tree (tracked + untracked, honouring ignore rules) as a private commit object
 * under `refs/voidrift/<session>/<id>/before` and `.../after`, WITHOUT touching
 * the user's index/HEAD/branches/stash:
 *   1. copy the real index to a temp file (`GIT_INDEX_FILE`),
 *   2. `git add -A --ignore-errors` against the temp index,
 *   3. `git write-tree` → the tree sha,
 *   4. `git commit-tree <tree>` with a fixed neutral identity + a snapshot
 *      message, producing a commit sha,
 *   5. `git update-ref refs/voidrift/<session>/<id>/{before|after} <commit>`.
 *
 * No-op detection: before.tree === after.tree → the turn made no move (the
 * before ref is deleted). Changed paths come from `git diff-tree -r -z
 * --no-renames --name-status <before> <after>`. Restore reads blobs with `git
 * cat-file` (NEVER a checkout/reset/clean/stash) and writes files atomically
 * with the recorded mode; symlinks and submodules are reported as skipped.
 * Refs/commit objects of dropped moves are deleted (`git update-ref -d`); no
 * `git gc`. Unborn HEAD and an identity-less repo both work.
 *
 * EVERY git call routes through the hardened runner (git-harden.ts) so a cloned,
 * untrusted repo's `.git/config`, hooks, and filter/textconv drivers cannot
 * execute programs. The `refs/voidrift/**` refs hold only snapshot commits of
 * the user's OWN tree and are never offered to the model.
 *
 * The timeline json (ids + pointer + method) persists under the CACHE dir
 * (`.voidrift/cache/snapshots/<session>/timeline.json`) for BOTH methods — git
 * refs hold the content, the json holds the ordering — so a resumed session
 * continues the same history.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  existsSync,
  copyFileSync,
  statSync,
  utimesSync,
  readdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { hardenedGitArgs, hardenedGitEnv, scanRepoConfig, type GitConfigScan } from "./git-harden.js";
import type {
  SnapshotStore,
  TurnContext,
  MoveDraft,
  NoteWriteInput,
  RestoreResult,
  RestoreWhich,
  ReadState,
} from "../entities/ports/snapshot-store.js";
import type { Move, MovePath, Timeline } from "../entities/rollback.js";
import { isValidSessionId } from "./repositories/session-repository.js";
import { RollbackIntegrity } from "./rollback-integrity.js";
import { applyStaged, sweepSessionTmp, sessionTmpDir } from "./rollback-staging.js";
import { limitDefault } from "../entities/limits.js";

const execFileAsync = promisify(execFile);
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** The git-capture cost cap (§10.12 item 3): a 20 s wall-clock timeout, a
 * 16 MiB stdout cap, and a 200,000-entry untracked-file ceiling. A capture that
 * blows any of these degrades the turn to `notUndoable: snapshot-failed`. */
const CAPTURE_TIMEOUT_MS_DEFAULT = limitDefault("rollback.gitCaptureTimeoutMs");
const CAPTURE_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_UNTRACKED_ENTRIES = 200_000;
const SNAPSHOT_TOO_SLOW_REASON = "snapshot took too long; large untracked files? add them to .gitignore";

/** Exclude VoidRift's own control state from every capture: `.voidrift` at the
 * workspace root (any depth beneath it) and `.git`. Applied as a trailing
 * pathspec on `git add -A` and `git ls-files --others`. `:(exclude).voidrift`
 * matches at any level; `:(exclude,top).voidrift` anchors it to the workspace
 * root. Both forms together cover a repo with no .gitignore, an unborn HEAD, and
 * one where `.voidrift/*` is tracked. `.git` is never in the tree but is listed
 * for defence. */
const CAPTURE_EXCLUDE_PATHSPEC = [
  "--",
  ".",
  ":(exclude).voidrift",
  ":(exclude,top).voidrift",
  ":(exclude).git",
  ":(exclude,top).git",
];

/** The injectable git runner (§10.12 item 3) so tests can drive a SLOW runner.
 * Returns stdout (text + raw buffer), stderr, and exit code; never throws. */
export interface GitRunner {
  (
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; indexFile?: string; raw?: boolean; timeoutMs?: number; maxBuffer?: number },
  ): Promise<{ stdout: string; stdoutBuf: Buffer; stderr: string; code: number }>;
}

const SNAPSHOT_IDENTITY = ["-c", "user.name=VoidRift", "-c", "user.email=voidrift@localhost"];

/** The default git runner (§10.12): a real `execFile` call with optional
 * wall-clock timeout and stdout cap. A timeout kills the process; a timeout or
 * maxBuffer overflow surfaces as a non-zero `code` so the caller can degrade.
 * Never throws. */
const defaultGitRunner: GitRunner = async (args, opts) => {
  const env = { ...opts.env };
  if (opts.indexFile) env.GIT_INDEX_FILE = opts.indexFile;
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: opts.cwd,
      env,
      maxBuffer: opts.maxBuffer ?? 256 * 1024 * 1024,
      ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs, killSignal: "SIGKILL" as const } : {}),
      ...(opts.raw ? { encoding: "buffer" as const } : {}),
    });
    if (opts.raw) {
      const buf = stdout as unknown as Buffer;
      return { stdout: buf.toString("utf8"), stdoutBuf: buf, stderr: String(stderr), code: 0 };
    }
    return { stdout: String(stdout), stdoutBuf: Buffer.from(String(stdout)), stderr: String(stderr), code: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: string; code?: number; killed?: boolean; signal?: string };
    const outBuf = Buffer.isBuffer(err.stdout) ? err.stdout : Buffer.from(err.stdout ?? "");
    // A timeout kill or maxBuffer overflow lands here with a non-zero/absent code.
    return { stdout: outBuf.toString("utf8"), stdoutBuf: outBuf, stderr: err.stderr ?? String(e), code: err.code ?? 1 };
  }
};

interface GitRun {
  stdout: string;
  stdoutBuf: Buffer;
  stderr: string;
  code: number;
}

interface TurnState {
  moveId: number;
  turn: number;
  beforeCommit: string | null;
  beforeTree: string | null;
  /** Set when the before-capture exceeded the cost budget (§10.12 item 3): the
   * turn degrades to `snapshot-failed` with this reason. */
  degradeReason?: string;
}

export interface GitSnapshotStoreDeps {
  /** The git repository root (also the workspace root). */
  root: string;
  /** The global config dir for the per-install integrity key (§10.12). */
  globalConfigDir?: string | null;
  /** Emit ONE value-free warning when a session's planted timeline is ignored,
   * or a capture degrades (§10.12). Optional. */
  onUntrusted?: (sessionId: string) => void;
  /** Emit ONE WARNING event when a capture degrades to snapshot-failed under the
   * cost budget (§10.12 item 3). Optional. */
  onSnapshotDegraded?: (sessionId: string) => void;
  /** Emit ONE value-free warning when a crash sweep cleans/recovers leftover
   * rollback staging files (§10.12 item 4); the count only, never paths. */
  onSwept?: (sessionId: string, count: number) => void;
  /** An injectable git runner (§10.12 item 3) so tests can drive a slow runner.
   * Defaults to the real `execFile` runner. */
  runner?: GitRunner;
  /** §13.11 SNAP2 — git-capture wall-clock timeout (registry
   * `rollback.gitCaptureTimeoutMs`, default 20 s); the effective cascaded value
   * when wired, else the registry default. */
  captureTimeoutMs?: number;
}

export class GitSnapshotStore implements SnapshotStore {
  readonly method = "git" as const;
  private scan: GitConfigScan | null = null;
  private readonly turns = new Map<string, TurnState>();
  private readonly integrity: RollbackIntegrity;
  private readonly runner: GitRunner;
  private readonly warnedUntrusted = new Set<string>();
  /** §13.11 SNAP2 — effective git-capture timeout (deps or registry). */
  private readonly captureTimeoutMs: number;

  constructor(private readonly deps: GitSnapshotStoreDeps) {
    this.integrity = new RollbackIntegrity(deps.globalConfigDir ?? null);
    this.runner = deps.runner ?? defaultGitRunner;
    this.captureTimeoutMs = deps.captureTimeoutMs ?? CAPTURE_TIMEOUT_MS_DEFAULT;
  }

  /** The integrity key state, for the doctor ROLLBACK group (§10.12). */
  keyState(): "persisted" | "in-memory" {
    return this.integrity.keyState();
  }

  /** The per-session snapshots dir (shared with the cache method): holds the
   * timeline json and the `tmp/` staging dir (§10.12). */
  private sessionSnapshotDir(sessionId: string): string {
    if (!isValidSessionId(sessionId)) throw new Error("invalid session id for snapshot store");
    return path.join(this.deps.root, ".voidrift", "cache", "snapshots", sessionId);
  }

  /** Startup sweep (§10.12 item 4): recover/clean any leftover rollback staging
   * files from a crash when a session dir is first opened. Called once per
   * session by the service; a sweep warns once with the leftover count. */
  async openSession(sessionId: string): Promise<void> {
    if (!isValidSessionId(sessionId)) return;
    sweepSessionTmp({
      tmpDir: sessionTmpDir(this.sessionSnapshotDir(sessionId)),
      onSwept: (count) => this.deps.onSwept?.(sessionId, count),
    });
  }

  private reportUntrusted(sessionId: string): void {
    if (this.warnedUntrusted.has(sessionId)) return;
    this.warnedUntrusted.add(sessionId);
    this.deps.onUntrusted?.(sessionId);
  }

  // ── hardened git plumbing ─────────────────────────────────────────────────

  private configScan(): GitConfigScan {
    if (this.scan === null) this.scan = scanRepoConfig(this.deps.root);
    return this.scan;
  }

  /** Run a hardened git command. Snapshot ops inject a fixed neutral identity
   * (commit-tree needs an author/committer even when the repo has one). Never
   * throws — returns code + output (both text and raw buffer). */
  private async git(args: string[], opts?: { indexFile?: string; raw?: boolean; timeoutMs?: number; maxBuffer?: number }): Promise<GitRun> {
    const scan = this.configScan();
    // hasIdentity=true so hardenedGitArgs does NOT also inject one; we inject a
    // FIXED snapshot identity explicitly so commits never touch user identity.
    const hardened = [...SNAPSHOT_IDENTITY, ...hardenedGitArgs(args, scan, true)];
    const env = hardenedGitEnv();
    return this.runner(hardened, {
      cwd: this.deps.root,
      env,
      ...(opts?.indexFile ? { indexFile: opts.indexFile } : {}),
      ...(opts?.raw ? { raw: true } : {}),
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts?.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
    });
  }

  // ── snapshot capture ──────────────────────────────────────────────────────

  /** A cheap untracked-entry count probe (§10.12 item 3): a tree with more than
   * MAX_UNTRACKED_ENTRIES untracked files is too costly to snapshot, so the turn
   * degrades rather than hanging on `git add -A`. Returns the degrade reason when
   * over the ceiling (or the probe itself times out/overflows), else null. */
  private async probeTooLarge(): Promise<string | null> {
    const r = await this.git(["ls-files", "--others", "--exclude-standard", "-z", ...CAPTURE_EXCLUDE_PATHSPEC], {
      timeoutMs: this.captureTimeoutMs,
      maxBuffer: CAPTURE_MAX_BUFFER,
    });
    // A timeout/overflow on the probe itself (non-zero code) is also a degrade.
    if (r.code !== 0) return SNAPSHOT_TOO_SLOW_REASON;
    // Count NUL separators; the last field has no trailing NUL when non-empty.
    let count = 0;
    for (let i = 0; i < r.stdoutBuf.length; i++) if (r.stdoutBuf[i] === 0) count++;
    if (count > MAX_UNTRACKED_ENTRIES) return SNAPSHOT_TOO_SLOW_REASON;
    return null;
  }

  /** Take a whole-tree snapshot commit WITHOUT touching the user's index/HEAD.
   * Returns `{ commit, tree }`, `{ degraded }` when the cost budget was blown
   * (§10.12 item 3), or null on an ordinary capture failure. */
  private async snapshot(
    ctx: { sessionId: string; moveId: number },
    which: RestoreWhich,
  ): Promise<{ commit: string; tree: string } | { degraded: string } | null> {
    const tooLarge = await this.probeTooLarge();
    if (tooLarge) return { degraded: tooLarge };
    const tmpIndex = path.join(os.tmpdir(), `vr-idx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      // Copy the real index to a temp file so `git add` never touches the user's
      // index. An unborn HEAD / missing index → start from an empty temp index
      // (git creates it on first `add`), so copy only when it exists.
      const realIndex = path.join(this.deps.root, ".git", "index");
      if (existsSync(realIndex)) {
        try {
          copyFileSync(realIndex, tmpIndex);
          // Racily-clean fix (§10.12): git decides whether to re-hash a tracked
          // file by comparing its mtime to the INDEX FILE's mtime — an entry with
          // mtime >= the index mtime is "racy" and re-checked by content. The
          // fresh copy would carry the copy-time mtime (now), so a file modified
          // in the SAME timestamp tick as its index entry (same size, same
          // second) looks clean and its change is silently dropped from the
          // snapshot — an undo would then fail to restore it. Restore the ORIGINAL
          // index mtime on the copy so those racy entries are re-hashed.
          const st = statSync(realIndex);
          try {
            utimesSync(tmpIndex, st.atime, st.mtime);
          } catch {
            /* best-effort: the refresh below still forces re-hashing */
          }
        } catch {
          /* fall through to an empty temp index */
        }
      }
      // Drop any TRACKED `.voidrift` entries from the TEMP index only (never the
      // user's real index) so a repo that tracks `.voidrift/config.json` never
      // carries control state into a snapshot tree. --ignore-unmatch keeps this a
      // no-op when nothing under `.voidrift` is tracked.
      await this.git(["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--", ".voidrift"], {
        indexFile: tmpIndex,
        timeoutMs: this.captureTimeoutMs,
        maxBuffer: CAPTURE_MAX_BUFFER,
      });
      // Defence-in-depth for the racily-clean fix above: force git to resolve
      // every racy entry against the file's current content before staging.
      // `--really-refresh` ignores the stat/assume-unchanged shortcuts and
      // re-checks each tracked path, so a same-size, same-tick modification is
      // re-hashed into the temp index rather than carried over stale. It touches
      // the TEMP index only; the user's real index is never refreshed. A
      // non-zero exit (e.g. a path needing update) is expected and ignored — the
      // subsequent `git add -A` restages everything regardless.
      await this.git(["update-index", "-q", "--really-refresh"], {
        indexFile: tmpIndex,
        timeoutMs: this.captureTimeoutMs,
        maxBuffer: CAPTURE_MAX_BUFFER,
      });
      // `git add -A` over a huge untracked tree can hang: run it under the
      // wall-clock timeout + stdout cap (§10.12 item 3); a kill/overflow degrades.
      // The exclude pathspec keeps VoidRift's own `.voidrift`/`.git` state out of
      // every snapshot tree (bug fix: previously staged whole-tree with no path).
      const add = await this.git(["add", "-A", "--ignore-errors", ...CAPTURE_EXCLUDE_PATHSPEC], {
        indexFile: tmpIndex,
        timeoutMs: this.captureTimeoutMs,
        maxBuffer: CAPTURE_MAX_BUFFER,
      });
      // `add -A` with --ignore-errors can return non-zero yet still stage; a
      // timeout kill, though, leaves no usable index — treat a non-zero write-tree
      // as the degrade below. (We cannot tell a kill from a benign non-zero here,
      // so the write-tree failure path decides.)
      void add;
      const wt = await this.git(["write-tree"], { indexFile: tmpIndex, timeoutMs: this.captureTimeoutMs, maxBuffer: CAPTURE_MAX_BUFFER });
      if (wt.code !== 0) return { degraded: SNAPSHOT_TOO_SLOW_REASON };
      const tree = wt.stdout.trim();
      if (!/^[0-9a-f]{40,64}$/.test(tree)) return null;
      const msg = `voidrift snapshot ${ctx.sessionId} ${ctx.moveId} ${which}`;
      const ct = await this.git(["commit-tree", tree, "-m", msg], { indexFile: tmpIndex });
      if (ct.code !== 0) return null;
      const commit = ct.stdout.trim();
      if (!/^[0-9a-f]{40,64}$/.test(commit)) return null;
      const ref = this.refName(ctx.sessionId, ctx.moveId, which);
      const ur = await this.git(["update-ref", ref, commit]);
      if (ur.code !== 0) return null;
      return { commit, tree };
    } finally {
      try {
        rmSync(tmpIndex, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  private refName(sessionId: string, moveId: number, which: RestoreWhich): string {
    if (!isValidSessionId(sessionId)) throw new Error("invalid session id for snapshot ref");
    return `refs/voidrift/${sessionId}/${moveId}/${which}`;
  }

  async beginTurn(ctx: TurnContext): Promise<void> {
    if (this.turns.has(ctx.sessionId)) return; // idempotent within a turn
    const snap = await this.snapshot(ctx, "before");
    const degraded = snap && "degraded" in snap;
    if (degraded) this.deps.onSnapshotDegraded?.(ctx.sessionId);
    this.turns.set(ctx.sessionId, {
      moveId: ctx.moveId,
      turn: ctx.turn,
      beforeCommit: snap && "commit" in snap ? snap.commit : null,
      beforeTree: snap && "tree" in snap ? snap.tree : null,
      ...(degraded ? { degradeReason: (snap as { degraded: string }).degraded } : {}),
    });
  }

  async noteWrite(_input: NoteWriteInput): Promise<void> {
    // The git method captures the WHOLE tree; per-write notes are not needed.
  }

  async commitTurn(ctx: TurnContext): Promise<MoveDraft | null> {
    const st = this.turns.get(ctx.sessionId);
    this.turns.delete(ctx.sessionId);
    if (st?.degradeReason) {
      // §10.12 item 3 — the before-capture blew the cost budget: record a
      // snapshot-failed (not-undoable) move with the budget reason.
      return { paths: [], method: "git", notUndoable: [{ kind: "snapshot-failed", detail: st.degradeReason }] };
    }
    if (!st || st.beforeTree === null) {
      // No before snapshot (capture failed) → degrade to a snapshot-failed move
      // so the turn is recorded but marked not-undoable (the service decides).
      return { paths: [], method: "git", notUndoable: [{ kind: "snapshot-failed", detail: "before snapshot failed" }] };
    }
    const after = await this.snapshot(ctx, "after");
    if (after && "degraded" in after) {
      this.deps.onSnapshotDegraded?.(ctx.sessionId);
      return { paths: [], method: "git", notUndoable: [{ kind: "snapshot-failed", detail: after.degraded }] };
    }
    if (!after) {
      return { paths: [], method: "git", notUndoable: [{ kind: "snapshot-failed", detail: "after snapshot failed" }] };
    }
    // No-op: identical trees → delete the before ref and record no move.
    if (after.tree === st.beforeTree) {
      await this.git(["update-ref", "-d", this.refName(ctx.sessionId, ctx.moveId, "before")]);
      await this.git(["update-ref", "-d", this.refName(ctx.sessionId, ctx.moveId, "after")]);
      return null;
    }
    const paths = await this.diffPaths(st.beforeCommit!, after.commit, ctx);
    return { paths, method: "git" };
  }

  /** Changed paths between two commits (§10.12): `diff-tree -r -z --no-renames
   * --name-status`. Symlinks/submodules are listed restorable:false (skipped on
   * restore). */
  private async diffPaths(beforeCommit: string, afterCommit: string, ctx: { sessionId: string; moveId: number }): Promise<MovePath[]> {
    const r = await this.git(["diff-tree", "-r", "-z", "--no-renames", "--name-status", beforeCommit, afterCommit]);
    if (r.code !== 0) return [];
    const out: MovePath[] = [];
    const parts = r.stdout.split("\u0000").filter((p) => p !== "");
    // Format: STATUS\0PATH\0STATUS\0PATH ...  (status is a single letter).
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i]!;
      const p = parts[i + 1]!;
      // Defence in depth: never let a `.voidrift/*` or `.git/*` path pollute a
      // move's paths/counts even if one slipped past the capture exclude.
      if (isLikelyControlPath(p) || p === ".git" || p.replace(/\\/g, "/").startsWith(".git/")) continue;
      let kind: MovePath["kind"];
      if (status.startsWith("A")) kind = "created";
      else if (status.startsWith("D")) kind = "deleted";
      else kind = "modified";
      // Determine mode + symlink/submodule from the after tree (or before on delete).
      const info = await this.pathInfo(kind === "deleted" ? beforeCommit : afterCommit, p);
      if (info.special) {
        out.push({ path: p, kind, restorable: false, reason: info.special });
      } else {
        out.push({ path: p, kind, restorable: true, ...(info.mode !== undefined ? { mode: info.mode } : {}) });
      }
    }
    void ctx;
    return out;
  }

  /** The git mode of a path in a commit's tree, and whether it is a symlink
   * (120000) or submodule/gitlink (160000) — both reported as special. */
  private async pathInfo(commit: string, relPath: string): Promise<{ mode?: number; special?: string }> {
    const r = await this.git(["ls-tree", commit, "--", relPath]);
    if (r.code !== 0 || r.stdout.trim() === "") return {};
    // `<mode> <type> <sha>\t<path>`
    const m = /^(\d{6})\s+(\w+)\s+[0-9a-f]+\t/.exec(r.stdout);
    if (!m) return {};
    const gitMode = m[1]!;
    if (gitMode === "120000") return { special: "symlink" };
    if (gitMode === "160000") return { special: "submodule" };
    // Regular file: 100644 or 100755 → fs mode.
    const mode = gitMode === "100755" ? 0o755 : 0o644;
    return { mode };
  }

  // ── read + restore ──────────────────────────────────────────────────────────

  async readState(move: Move, which: RestoreWhich, relPath: string): Promise<ReadState> {
    const ref = this.refName(move.sessionId, move.id, which);
    // Does the path exist in that tree?
    const ls = await this.git(["ls-tree", ref, "--", relPath]);
    if (ls.code !== 0) return "absent";
    if (ls.stdout.trim() === "") return null; // not present in that state
    const r = await this.git(["cat-file", "blob", `${ref}:${relPath}`], { raw: true });
    if (r.code !== 0) return "absent";
    return r.stdoutBuf;
  }

  async restore(move: Move, direction: "undo" | "redo", opts: { overwrite: Set<string> }): Promise<RestoreResult> {
    const result: RestoreResult = { restored: [], conflicts: [], skipped: [] };
    const expectWhich: RestoreWhich = direction === "undo" ? "after" : "before";
    const targetWhich: RestoreWhich = direction === "undo" ? "before" : "after";

    interface Plan {
      rel: string;
      abs: string;
      target: Buffer | null;
      mode?: number;
    }
    const plans: Plan[] = [];
    for (const p of move.files.paths) {
      if (!p.restorable) {
        result.skipped.push({ path: p.path, reason: p.reason ?? "not restorable" });
        continue;
      }
      if (isLikelyControlPath(p.path)) {
        result.skipped.push({ path: p.path, reason: "protected control location" });
        continue;
      }
      const rel = normalizeRel(p.path);
      if (rel === null) {
        result.skipped.push({ path: p.path, reason: "path escapes workspace" });
        continue;
      }
      const abs = path.join(this.deps.root, rel);
      const expected = await this.readState(move, expectWhich, p.path);
      const current = this.readActual(abs);
      const matches = statesEqual(expected, current);
      if (!matches && !opts.overwrite.has(p.path)) {
        result.conflicts.push(p.path);
        continue;
      }
      const target = await this.readState(move, targetWhich, p.path);
      if (target === "absent") {
        result.skipped.push({ path: p.path, reason: "state not captured" });
        continue;
      }
      plans.push({ rel, abs, target, ...(p.mode !== undefined ? { mode: p.mode } : {}) });
    }

    if (result.conflicts.length > 0) {
      return { restored: [], conflicts: result.conflicts, skipped: result.skipped };
    }

    // Two-phase, crash-safe apply (§10.12 item 4): the original tree survives on
    // disk (renamed aside to a backup temp under the per-session `tmp/` dir)
    // until every write/delete succeeds; a mid-apply failure rolls every applied
    // step back, so no half-applied tree. Staging/aside files live under the
    // protected cache dir (NOT beside user files) so a SIGKILL never leaves a
    // `.vr-rollback*` file where it could be committed.
    applyStaged(
      plans,
      {
        tmpDir: sessionTmpDir(this.sessionSnapshotDir(move.sessionId)),
        onSwept: (count) => this.deps.onSwept?.(move.sessionId, count),
      },
      {
        onWrite: (abs) => result.restored.push(path.relative(this.deps.root, abs).split(path.sep).join("/")),
        onDelete: (abs) => {
          result.restored.push(path.relative(this.deps.root, abs).split(path.sep).join("/"));
          this.removeEmptyParents(path.dirname(abs));
        },
      },
    );
    return result;
  }

  private readActual(abs: string): Buffer | null {
    try {
      const st = statSync(abs);
      if (!st.isFile()) return null;
      return readFileSync(abs);
    } catch {
      return null;
    }
  }

  private removeEmptyParents(dir: string): void {
    let cur = dir;
    const root = path.resolve(this.deps.root);
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

  // ── drop / timeline ──────────────────────────────────────────────────────────

  async drop(moveIds: number[]): Promise<void> {
    // Delete the before/after refs (and thus unreference the commit objects; no
    // `git gc`). We iterate known ref names for each id across every session we
    // can see under refs/voidrift/.
    const list = await this.git(["for-each-ref", "--format=%(refname)", "refs/voidrift/"]);
    if (list.code !== 0) return;
    const refs = list.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    const idSet = new Set(moveIds.map(String));
    for (const ref of refs) {
      // refs/voidrift/<session>/<id>/{before|after}
      const parts = ref.split("/");
      const id = parts[parts.length - 2];
      if (id && idSet.has(id)) {
        await this.git(["update-ref", "-d", ref]);
      }
    }
  }

  // The timeline json lives under the cache dir for BOTH methods.
  private timelinePath(sessionId: string): string {
    if (!isValidSessionId(sessionId)) throw new Error("invalid session id for snapshot store");
    return path.join(this.deps.root, ".voidrift", "cache", "snapshots", sessionId, "timeline.json");
  }
  private ensureTimelineDir(sessionId: string): void {
    mkdirSync(path.dirname(this.timelinePath(sessionId)), { recursive: true, mode: DIR_MODE });
  }

  async persistTimeline(sessionId: string, timeline: Timeline): Promise<void> {
    this.ensureTimelineDir(sessionId);
    const dest = this.timelinePath(sessionId);
    // §10.12 — bind the timeline to this install/session/workspace AND to the
    // ref names + commit shas it relies on, so a planted timeline pointing at a
    // crafted ref cannot be trusted. Resolve each move's before/after commit sha.
    const refs = await this.resolveRefShas(sessionId, timeline);
    const { hmac: _omit, ...rest } = timeline as Timeline & { hmac?: string };
    void _omit;
    const payload = { ...rest, refs };
    const signed = { ...rest, refs, hmac: this.integrity.sign(payload, sessionId, this.deps.root) };
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(signed), { mode: FILE_MODE });
    renameSync(tmp, dest);
  }
  async loadTimeline(sessionId: string): Promise<Timeline | null> {
    const p = this.timelinePath(sessionId);
    if (!existsSync(p)) return null;
    let parsed: Timeline & { hmac?: string; refs?: Record<string, { before?: string; after?: string }> };
    try {
      parsed = JSON.parse(readFileSync(p, "utf8")) as typeof parsed;
    } catch {
      return null;
    }
    const { hmac, refs, ...rest } = parsed;
    // Verify the HMAC over the rest + the ref map (§10.12). A planted/copied/
    // edited timeline has a missing/invalid hmac and is IGNORED as untrusted.
    if (!this.integrity.verify({ ...rest, refs: refs ?? {} }, sessionId, this.deps.root, hmac)) {
      this.reportUntrusted(sessionId);
      return null;
    }
    // Even with a valid HMAC, verify every referenced commit EXISTS and carries
    // the expected `voidrift snapshot` message before it is ever used (§10.12):
    // a trusted timeline whose refs were since deleted or swapped is untrusted.
    if (!(await this.verifyRefCommits(sessionId, refs ?? {}))) {
      this.reportUntrusted(sessionId);
      return null;
    }
    return rest as Timeline;
  }

  /** Resolve the before/after commit sha each move's refs currently point at,
   * for the signed payload (§10.12). A missing ref yields no entry for it. */
  private async resolveRefShas(
    sessionId: string,
    timeline: Timeline,
  ): Promise<Record<string, { before?: string; after?: string }>> {
    const out: Record<string, { before?: string; after?: string }> = {};
    for (const mv of timeline.moves) {
      const entry: { before?: string; after?: string } = {};
      for (const which of ["before", "after"] as const) {
        const r = await this.git(["rev-parse", "--verify", "--quiet", `${this.refName(sessionId, mv.id, which)}^{commit}`]);
        const sha = r.stdout.trim();
        if (r.code === 0 && /^[0-9a-f]{40,64}$/.test(sha)) entry[which] = sha;
      }
      if (entry.before || entry.after) out[String(mv.id)] = entry;
    }
    return out;
  }

  /** Verify every referenced commit exists AND its message is the expected
   * `voidrift snapshot <session> <id> <which>` (§10.12). Any mismatch fails. */
  private async verifyRefCommits(
    sessionId: string,
    refs: Record<string, { before?: string; after?: string }>,
  ): Promise<boolean> {
    for (const [idStr, entry] of Object.entries(refs)) {
      for (const which of ["before", "after"] as const) {
        const sha = entry[which];
        if (!sha) continue;
        if (!/^[0-9a-f]{40,64}$/.test(sha)) return false;
        // The ref must still point at this exact sha (not swapped since signing).
        const rp = await this.git(["rev-parse", "--verify", "--quiet", `${this.refName(sessionId, Number(idStr), which)}^{commit}`]);
        if (rp.code !== 0 || rp.stdout.trim() !== sha) return false;
        const msg = await this.git(["show", "-s", "--format=%s", sha]);
        if (msg.code !== 0) return false;
        if (msg.stdout.trim() !== `voidrift snapshot ${sessionId} ${idStr} ${which}`) return false;
      }
    }
    return true;
  }
}

/** Whether two recorded/actual states are equal for conflict detection. */
function statesEqual(recorded: ReadState, current: Buffer | null): boolean {
  if (recorded === "absent") return false; // unknown recorded state → treat as mismatch (conservative)
  if (recorded === null) return current === null; // did not exist
  if (current === null) return false;
  return recorded.equals(current);
}

function normalizeRel(raw: string): string | null {
  if (!raw) return null;
  const folded = raw.replace(/\\/g, "/");
  if (folded.startsWith("/")) return null;
  const segs: string[] = [];
  for (const s of folded.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (segs.length === 0) return null;
      segs.pop();
      continue;
    }
    segs.push(s);
  }
  if (segs.length === 0) return null;
  return segs.join("/");
}

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
