/**
 * The VCS port (core-blueprint.md §7.3, §1 rule 3).
 *
 * The worktree lifecycle is VoidRift-built — git exposes no worktree API through
 * LangChain — so the subagents use-case depends on this port and the VCS adapter
 * implements it over the shell/child_process boundary. All destructive git is
 * bounded to the harness's own `voidrift-run-*` / `voidrift-recovery-*` refs and
 * `.voidrift/worktrees/*`; a user branch or working tree is never touched.
 */

/** A created worktree: its absolute path and branch (§7.3 step 1). */
export interface Worktree {
  id: string;
  path: string;
  branch: string;
}

/** The result of attempting a merge of a run branch into the base (§7.3). */
export interface MergeResult {
  merged: boolean;
  /** When the merge conflicted, the recovery branch work was preserved on. */
  recoveryBranch?: string;
  /** On a SUCCEEDED merge (§10.11): the workspace-relative POSIX paths the merge
   * brought into the base working tree (git `diff --name-only` of the base HEAD
   * before vs after), so the mutation journal records one entry per path and the
   * §9.5.1 surprise seam can see them. Bounded by the caller's journal cap. */
  mergedPaths?: string[];
  /** On a SUCCEEDED merge (§10.11): the base HEAD commit BEFORE the merge, so the
   * journal's undo hint can name where the previous state lives ("reset to
   * <sha>"), matching the README's "/undo names the previous HEAD". Absent when
   * the base had no prior commit. */
  previousHead?: string;
}

export interface VcsPort {
  /** True inside a git repo (a `.git` is present at the root). */
  isRepo(): boolean;

  /** The checked-out branch, or null outside a repo (§7.3 branch watch). */
  currentBranch(): Promise<string | null>;

  /**
   * The working tree's unified diff against HEAD (§7.3, §2.2 `workspace.diff`).
   * A read, never destructive: `git diff HEAD`, optionally scoped to one path.
   * Returns "" outside a repo or when the tree is clean. Bounded to the repo.
   */
  workingDiff(path?: string): Promise<string>;

  /**
   * The tracked + untracked, NON-ignored file set for the workspace surface
   * (§2.2, FX-B): `git ls-files -z --cached --others --exclude-standard` through
   * the hardened runner. Applies `.gitignore`, `.git/info/exclude` and the
   * global excludes file exactly as git does, keeping a tracked-but-ignored file
   * visible. Returns workspace-relative POSIX paths bounded to `max`, or null
   * outside a git repo. Never destructive.
   */
  listFiles(max?: number): Promise<string[] | null>;

  /**
   * Create a worktree for a worker at `.voidrift/worktrees/{id}` on branch
   * `voidrift-run-{id}` and write `.meta.json` `{ pid, timestamp, branch,
   * sessionId }` (§7.3 step 1). The returned path roots the worker's backend.
   * `sessionId` (§5.8) is recorded so `session.delete` can prove which session
   * owns a worktree before removing it. `include` (§7.3) is the resolved
   * `config.worktreeInclude`: each listed path that exists in the main tree and
   * is NOT git-tracked is real-copied into the new worktree at creation; any
   * skipped/capped entry is surfaced through the adapter's warning channel and a
   * copy summary is logged (relative paths + bytes only).
   */
  createWorktree(id: string, sessionId?: string, include?: readonly string[]): Promise<Worktree>;

  /**
   * Merge the run branch into the base with `git merge --no-edit` (§7.3 step 3).
   * A clean merge removes the worktree and deletes the branch. A conflict runs
   * `git merge --abort`, preserves the work on `voidrift-recovery-{id}`, removes
   * the worktree, and reports the recovery branch (§7.3 step 4).
   */
  mergeWorktree(wt: Worktree): Promise<MergeResult>;

  /**
   * Abandon a worktree without merging (cancel/failure, §7.3 step 4): preserve
   * the work on `voidrift-recovery-{id}` and remove the worktree. Returns the
   * recovery branch.
   */
  abandonWorktree(wt: Worktree): Promise<string>;

  /**
   * Preserve a worktree in place as a recovery artifact — used on cancel, which
   * does NOT delete worktrees (§3.3, §15.1#1). Returns the worktree path.
   */
  preserveWorktree(wt: Worktree): string;

  /**
   * Prune worktrees whose owning pid is dead (`process.kill(pid, 0)` throws) AND
   * older than `ttlMinutes` (§7.3 step 5). Returns the pruned worktree ids.
   */
  bootCleanup(ttlMinutes: number): Promise<string[]>;

  /**
   * Remove every worktree OWNED BY `sessionId` (§5.8): `git worktree remove
   * --force` + `git branch -D voidrift-run-{id}` for ONLY the harness's own run
   * refs — the same bounded removal `abandonWorktree`/`bootCleanup` use. A
   * `voidrift-recovery-*` branch is the user's work and is PRESERVED, never
   * deleted. Ownership is proven from each worktree's `.meta.json` `sessionId`;
   * a worktree with no/other session id is left untouched. Returns the bytes
   * reclaimed and the recovery branches that remain in the repo.
   */
  removeWorktreesForSession(
    sessionId: string,
  ): Promise<{ reclaimedBytes: number; remainingRecoveryBranches: string[] }>;
}
