/**
 * The VCS adapter (core-blueprint.md §7.3, §1 rule 3).
 *
 * VoidRift's own worktree lifecycle, because git exposes no worktree API through
 * LangChain. It touches git only through `child_process` (the shell boundary) and
 * implements the `VcsPort` the subagents use-case calls. Every destructive git
 * operation is bounded to the harness's own `voidrift-run-*` / `voidrift-recovery-*`
 * refs and `.voidrift/worktrees/*`; a user branch or the user's working tree is
 * never touched (§7.3 invariant).
 *
 * It also watches `.git/HEAD` through Chokidar (§14.2) and emits `BRANCH_CHANGED`
 * `{ branch, previous }` so no frontend polls git for the branch (§7.3, §14.6).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import chokidar, { type FSWatcher } from "chokidar";
import type { MergeResult, VcsPort, Worktree } from "../entities/ports/vcs-port.js";
import type { LimitsPort } from "../entities/ports/limits-port.js";
import { dirSizeBytes } from "./fs-purge.js";
import { copyIncludeList } from "./worktree-include.js";
import {
  hardenedGitArgs,
  hardenedGitEnv,
  scanRepoConfig,
  type GitConfigScan,
} from "./git-harden.js";

const execFileAsync = promisify(execFile);

/** The harness-owned prefixes — the ONLY refs/paths destructive git may touch. */
const RUN_BRANCH = (id: string): string => `voidrift-run-${id}`;
const RECOVERY_BRANCH = (id: string): string => `voidrift-recovery-${id}`;
const WORKTREE_DIR = ".voidrift/worktrees";

interface GitRun {
  stdout: string;
  stderr: string;
  code: number;
}

/** A worktree's `.meta.json` for orphan detection (§7.3 step 1, lesson L5). */
interface WorktreeMeta {
  pid: number;
  timestamp: string;
  branch: string;
  /** The owning session id (§5.8), recorded so `session.delete` can prove
   * ownership before removing a worktree. Optional on older/orphan worktrees. */
  sessionId?: string;
}

export class VcsAdapter implements VcsPort {
  private watcher: FSWatcher | null = null;
  private lastBranch: string | null = null;
  /** The repo-local config scan, computed once per root on first git use. */
  private scanCache: GitConfigScan | null = null;
  /** Whether a user identity resolves; computed once lazily. */
  private hasIdentity: boolean | null = null;
  /** True once the untrusted-config warning has been emitted (once per adapter). */
  private warnedScan = false;

  constructor(
    private readonly root: string,
    private readonly emit: (type: string, payload: unknown) => void = () => {},
    /** §13.11 SNAP4 — the effective (cascaded) `worktree.includeCapBytes`; when
     * absent the worktree-include helper uses the registry default. */
    private readonly getIncludeCapBytes?: () => number,
    /** §13.11 (SNAP4, §7.3) — the runtime limits port so the include-list copier
     * can emit ONE `LIMIT_HIT('worktree.includeCapBytes')` when it skips an
     * over-cap entry. Absent (older callers/tests) → no hit is emitted. */
    private readonly limits?: LimitsPort,
  ) {}

  // ── git plumbing ─────────────────────────────────────────────────────────

  /**
   * Scan the repo-local config ONCE (value-free) and, when any executable-capable
   * key is present, emit ONE warning naming the classes and the file — then every
   * git invocation is additionally hardened against those keys. Reads no git.
   */
  private configScan(cwd: string): GitConfigScan {
    if (this.scanCache === null) {
      this.scanCache = scanRepoConfig(cwd);
      if (this.scanCache.classes.length > 0 && !this.warnedScan) {
        this.warnedScan = true;
        this.emit("GIT_CONFIG_UNTRUSTED", {
          message: `the repository's git config defines executable-capable keys (${this.scanCache.classes.join(
            ", ",
          )}); they are neutralised for VoidRift's git operations — review .git/config`,
          classes: this.scanCache.classes,
          files: this.scanCache.files,
        });
      }
    }
    return this.scanCache;
  }

  /** Resolve once whether a git user identity exists, using a HARDENED probe
   * (base overrides + env) so the probe itself cannot execute repo config. */
  private async resolveIdentity(cwd: string): Promise<boolean> {
    if (this.hasIdentity === null) {
      const empty: GitConfigScan = { classes: [], filterNames: [], files: [] };
      const run = async (key: string): Promise<string> => {
        try {
          const { stdout } = await execFileAsync(
            "git",
            hardenedGitArgs(["config", "--get", key], empty, true),
            { cwd, env: hardenedGitEnv(), maxBuffer: 1024 * 1024 },
          );
          return stdout.trim();
        } catch {
          return "";
        }
      };
      const [name, email] = await Promise.all([run("user.name"), run("user.email")]);
      this.hasIdentity = name !== "" && email !== "";
    }
    return this.hasIdentity;
  }

  /** Run a git command in `cwd`; never throws — returns exit code and output.
   * Every invocation is hardened against untrusted repo config (git-harden.ts). */
  private async git(args: string[], cwd = this.root): Promise<GitRun> {
    const scan = this.configScan(cwd);
    const hasIdentity = await this.resolveIdentity(cwd);
    try {
      const { stdout, stderr } = await execFileAsync("git", hardenedGitArgs(args, scan, hasIdentity), {
        cwd,
        env: hardenedGitEnv(),
        maxBuffer: 8 * 1024 * 1024,
      });
      return { stdout, stderr, code: 0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; code?: number };
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? String(e), code: err.code ?? 1 };
    }
  }

  isRepo(): boolean {
    return existsSync(path.join(this.root, ".git"));
  }

  async currentBranch(): Promise<string | null> {
    if (!this.isRepo()) return null;
    const r = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (r.code !== 0) return null;
    const b = r.stdout.trim();
    return b === "" ? null : b;
  }

  /**
   * The tracked + untracked, NON-ignored file set (§2.2 workspace surface,
   * FX-B): `git ls-files -z --cached --others --exclude-standard`. git applies
   * `.gitignore`, `.git/info/exclude` and the global excludes file exactly as it
   * would, and a tracked-but-also-ignored file stays listed (git keeps tracked
   * files visible) — the behaviour the retrieval invariant requires. Run through
   * the HARDENED runner (never a plain git) so a cloned repo's config/hooks
   * cannot execute. Returns workspace-relative POSIX paths, or `null` outside a
   * repo so the caller takes its own `.gitignore` path. Bounded to `max` entries.
   */
  async listFiles(max = 20_000): Promise<string[] | null> {
    if (!this.isRepo()) return null;
    const r = await this.git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    if (r.code !== 0) return null;
    const out: string[] = [];
    for (const entry of r.stdout.split("\0")) {
      if (entry === "") continue;
      out.push(entry);
      if (out.length >= max) break;
    }
    return out;
  }

  /**
   * The working-tree unified diff against HEAD (§2.2 `workspace.diff`). A read
   * only — `git diff HEAD` with no destructive flag — scoped to a path when
   * given and always bounded to the repo. "" outside a repo or on a clean tree.
   */
  async workingDiff(p?: string): Promise<string> {
    if (!this.isRepo()) return "";
    const args = ["diff", "HEAD"];
    if (p !== undefined && p.trim() !== "") args.push("--", p);
    const r = await this.git(args);
    return r.code === 0 ? r.stdout : "";
  }

  // ── worktree lifecycle (§7.3) ──────────────────────────────────────────────

  async createWorktree(id: string, sessionId?: string, include?: readonly string[]): Promise<Worktree> {
    const branch = RUN_BRANCH(id);
    const rel = `${WORKTREE_DIR}/${id}`;
    const abs = path.join(this.root, rel);
    const r = await this.git(["worktree", "add", rel, "-b", branch]);
    if (r.code !== 0) {
      throw new Error(`git worktree add failed for ${id}: ${r.stderr.trim()}`);
    }
    const meta: WorktreeMeta = {
      pid: process.pid,
      timestamp: new Date().toISOString(),
      branch,
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
    writeFileSync(path.join(abs, ".meta.json"), JSON.stringify(meta), "utf8");
    // §7.3 — after `git worktree add`, copy the include-list's untracked paths
    // into the worktree (a real copy, never a symlink back to the original).
    if (include && include.length > 0) {
      await this.applyIncludeList(id, abs, include);
    }
    return { id, path: abs, branch };
  }

  /**
   * Copy each `config.worktreeInclude` entry that exists in the main tree and is
   * NOT git-tracked into the new worktree (§7.3). Tracked paths are already in
   * the worktree (git put them there) and are skipped silently. A one-line
   * warning per skipped/capped entry is emitted through the adapter's event
   * channel; a single info log records what was copied (relative paths + bytes).
   */
  private async applyIncludeList(id: string, worktreeRoot: string, include: readonly string[]): Promise<void> {
    const tracked = await this.trackedPaths();
    const isTracked = (rel: string): boolean => {
      // A path is tracked if git lists it, or if it is a directory any tracked
      // path lies inside (git tracks files, not directories).
      if (tracked.has(rel)) return true;
      const prefix = rel.endsWith("/") ? rel : `${rel}/`;
      for (const t of tracked) if (t.startsWith(prefix)) return true;
      return false;
    };
    const result = copyIncludeList(this.root, worktreeRoot, include, isTracked, this.getIncludeCapBytes?.(), this.limits);
    for (const skip of result.skipped) {
      this.emit("WORKTREE_INCLUDE_SKIPPED", {
        worktree: id,
        message: `worktreeInclude: skipped ${skip.path} (${skip.reason})`,
        path: skip.path,
        reason: skip.reason,
      });
    }
    if (result.nestedGitSkipped > 0) {
      this.emit("WORKTREE_INCLUDE_SKIPPED", {
        worktree: id,
        message: `worktreeInclude: skipped ${result.nestedGitSkipped} nested .git`,
        reason: "nested .git",
        count: result.nestedGitSkipped,
      });
    }
    if (result.copied.length > 0) {
      this.emit("WORKTREE_INCLUDE_COPIED", {
        worktree: id,
        copied: result.copied,
        totalBytes: result.totalBytes,
      });
    }
  }

  /** The set of git-tracked, repo-relative paths (forward-slash). Empty on error
   * or outside a repo. Used to skip include-list paths git already materialized. */
  private async trackedPaths(): Promise<Set<string>> {
    const r = await this.git(["ls-files", "-z"]);
    if (r.code !== 0) return new Set();
    const out = new Set<string>();
    for (const p of r.stdout.split("\u0000")) {
      if (p !== "") out.add(p);
    }
    return out;
  }

  /** The workspace-relative POSIX paths changed between a base commit and the
   * current HEAD (§10.11): `git diff --name-only <sha> HEAD -z`, through the
   * HARDENED runner. Empty on error or a no-op merge. `.meta.json` is never part
   * of a merge (excluded at commit), so it cannot appear. */
  private async mergedPathsSince(since: string): Promise<string[]> {
    const r = await this.git(["diff", "--name-only", "-z", since, "HEAD"]);
    if (r.code !== 0) return [];
    const out: string[] = [];
    for (const p of r.stdout.split("\u0000")) if (p !== "") out.push(p);
    return out;
  }

  async mergeWorktree(wt: Worktree): Promise<MergeResult> {
    // §7.3 step 3 — the worker's file writes land in the worktree's WORKING
    // tree (the file tools write to disk, they do not commit). "The merge carries
    // committed work only" (§7.3), so first commit the worktree's pending changes
    // onto the run branch inside the worktree. The harness's own `.meta.json`
    // (worktree root, orphan detection) is EXCLUDED so it never merges back and
    // never collides between parallel workers. An empty change set yields nothing
    // to commit — the merge is then a clean no-op. The commit runs through the
    // SAME hardened runner, in the worktree's cwd.
    await this.git(["add", "-A", "--", ".", ":(exclude).meta.json"], wt.path);
    const status = await this.git(["status", "--porcelain", "--", ".", ":(exclude).meta.json"], wt.path);
    if (status.code === 0 && status.stdout.trim() !== "") {
      await this.git(["commit", "--no-verify", "-m", `voidrift worker ${wt.id}`], wt.path);
    }
    // §10.11 — the base HEAD BEFORE the merge, so a successful merge's journal
    // undo hint can name where the previous state lives (README: /undo names the
    // previous HEAD). Absent when the base has no commit yet (an empty repo).
    const headBefore = await this.git(["rev-parse", "HEAD"]);
    const previousHead = headBefore.code === 0 ? headBefore.stdout.trim() : undefined;
    // §7.3 step 3 — merge the run branch into the base with --no-edit.
    const r = await this.git(["merge", "--no-edit", wt.branch]);
    if (r.code === 0) {
      // §10.11 — the workspace-relative paths the merge brought into the base
      // (diff of the base HEAD before vs after), so the journal records one entry
      // per merged path and the §9.5.1 surprise seam can see them. A no-op merge
      // (no committed worker change) yields an empty list. Read-only; [] on error.
      const mergedPaths = previousHead !== undefined ? await this.mergedPathsSince(previousHead) : [];
      await this.removeWorktree(wt);
      await this.git(["branch", "-D", wt.branch]);
      return {
        merged: true,
        mergedPaths,
        ...(previousHead !== undefined ? { previousHead } : {}),
      };
    }
    // §7.3 step 4 — conflict: abort, preserve on a recovery branch, remove.
    await this.git(["merge", "--abort"]);
    const recoveryBranch = await this.preserveRecovery(wt);
    await this.removeWorktree(wt);
    await this.git(["branch", "-D", wt.branch]);
    return { merged: false, recoveryBranch };
  }

  async abandonWorktree(wt: Worktree): Promise<string> {
    const recoveryBranch = await this.preserveRecovery(wt);
    await this.removeWorktree(wt);
    await this.git(["branch", "-D", wt.branch]);
    return recoveryBranch;
  }

  preserveWorktree(wt: Worktree): string {
    // Cancel preserves the worktree in place as a recovery artifact — no
    // destructive op runs (§3.3, §15.1#1).
    return wt.path;
  }

  /**
   * Preserve a worker's work on `voidrift-recovery-{id}` (§7.3 step 4). The
   * run branch already holds the committed work; we point a recovery branch at
   * it so removing the worktree and deleting the run branch never loses it. This
   * is a REQUIRED, implemented operation (lesson L2: it was a no-op in `_bak`).
   */
  private async preserveRecovery(wt: Worktree): Promise<string> {
    const recovery = RECOVERY_BRANCH(wt.id);
    // Create the recovery branch at the run branch's tip from the main checkout.
    const r = await this.git(["branch", recovery, wt.branch]);
    if (r.code !== 0) {
      // The run branch may already be checked out in the worktree; branch from
      // its resolved commit directly as a fallback.
      const tip = await this.git(["rev-parse", wt.branch]);
      if (tip.code === 0) await this.git(["branch", recovery, tip.stdout.trim()]);
    }
    return recovery;
  }

  /** Remove a worktree with a filesystem fallback (§7.3 steps 3–5). */
  private async removeWorktree(wt: Worktree): Promise<void> {
    const r = await this.git(["worktree", "remove", "--force", wt.path]);
    if (r.code !== 0 && existsSync(wt.path)) {
      rmSync(wt.path, { recursive: true, force: true });
      await this.git(["worktree", "prune"]);
    }
  }

  // ── boot cleanup (§7.3 step 5) ──────────────────────────────────────────────

  async bootCleanup(ttlMinutes: number): Promise<string[]> {
    if (!this.isRepo()) return [];
    const dir = path.join(this.root, WORKTREE_DIR);
    if (!existsSync(dir)) return [];
    const pruned: string[] = [];
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    for (const id of entries) {
      const wtPath = path.join(dir, id);
      const metaPath = path.join(wtPath, ".meta.json");
      if (!existsSync(metaPath)) continue;
      let meta: WorktreeMeta;
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf8")) as WorktreeMeta;
      } catch {
        continue;
      }
      const ageMinutes = (Date.now() - new Date(meta.timestamp).getTime()) / 60_000;
      if (!this.isDeadPid(meta.pid)) continue; // owner still alive — leave it
      if (ageMinutes <= ttlMinutes) continue; // not stale enough yet
      // §7.3 step 5 — git remove + branch -D, with a filesystem fallback.
      const r = await this.git(["worktree", "remove", "--force", wtPath]);
      if (r.code !== 0 && existsSync(wtPath)) {
        rmSync(wtPath, { recursive: true, force: true });
        await this.git(["worktree", "prune"]);
      }
      await this.git(["branch", "-D", meta.branch]);
      pruned.push(id);
    }
    return pruned;
  }

  /** True when the process that owned a worktree is gone (§7.3 step 5). */
  private isDeadPid(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }

  async removeWorktreesForSession(
    sessionId: string,
  ): Promise<{ reclaimedBytes: number; remainingRecoveryBranches: string[] }> {
    // §5.8 — remove ONLY the worktrees this session owns (proven from each
    // `.meta.json` `sessionId`), through the SAME bounded removal every other
    // worktree teardown uses: `git worktree remove --force` + `git branch -D`
    // for the harness's own `voidrift-run-*` ref ONLY. A `voidrift-recovery-*`
    // branch is the user's work and is PRESERVED and reported, never deleted.
    const result = { reclaimedBytes: 0, remainingRecoveryBranches: [] as string[] };
    if (!this.isRepo()) return result;
    const dir = path.join(this.root, WORKTREE_DIR);
    if (!existsSync(dir)) return result;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return result;
    }
    for (const id of entries) {
      const wtPath = path.join(dir, id);
      const metaPath = path.join(wtPath, ".meta.json");
      if (!existsSync(metaPath)) continue;
      let meta: WorktreeMeta;
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf8")) as WorktreeMeta;
      } catch {
        continue;
      }
      if (meta.sessionId !== sessionId) continue; // not provably owned — leave it
      // Size before removal; `fs.rm` on an in-tree symlink unlinks it, so a
      // symlink can never redirect the removal outside the worktree (§5.8).
      result.reclaimedBytes += dirSizeBytes(wtPath);
      const r = await this.git(["worktree", "remove", "--force", wtPath]);
      if (r.code !== 0 && existsSync(wtPath)) {
        rmSync(wtPath, { recursive: true, force: true });
        await this.git(["worktree", "prune"]);
      }
      // Bounded: delete the harness's own run branch ONLY — never a recovery or
      // a user branch.
      await this.git(["branch", "-D", RUN_BRANCH(id)]);
      // A recovery branch for this run is the user's work: preserved and reported.
      const recovery = RECOVERY_BRANCH(id);
      const exists = await this.git(["rev-parse", "--verify", "--quiet", recovery]);
      if (exists.code === 0) result.remainingRecoveryBranches.push(recovery);
    }
    return result;
  }

  // ── branch watch (§7.3, §14.2, §14.6) ───────────────────────────────────────

  /**
   * Watch `.git/HEAD` through Chokidar and emit `BRANCH_CHANGED`
   * `{ branch, previous }` on a change of the checked-out branch. Read-only; it
   * reports the user's own checkouts and the harness's worktree operations alike.
   */
  async startBranchWatch(): Promise<void> {
    if (!this.isRepo() || this.watcher) return;
    this.lastBranch = await this.currentBranch();
    const head = path.join(this.root, ".git", "HEAD");
    // Poll `.git/HEAD`: it is replaced atomically on checkout (rename), which
    // native fs events miss on some platforms; polling catches it reliably.
    const watcher = chokidar.watch(head, { ignoreInitial: true, usePolling: true, interval: 50 });
    this.watcher = watcher;
    const onChange = (): void => {
      void this.checkBranch();
    };
    watcher.on("change", onChange).on("add", onChange);
    // Await the initial scan so a change that follows startBranchWatch is caught.
    await new Promise<void>((resolve) => {
      watcher.once("ready", () => resolve());
    });
  }

  private async checkBranch(): Promise<void> {
    const branch = await this.currentBranch();
    if (branch !== this.lastBranch) {
      const previous = this.lastBranch;
      this.lastBranch = branch;
      this.emit("BRANCH_CHANGED", { branch, previous });
    }
  }

  async stopBranchWatch(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /** Ensure the worktree parent dir exists (used by callers before dispatch). */
  ensureWorktreeDir(): void {
    const dir = path.join(this.root, WORKTREE_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}
