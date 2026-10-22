/**
 * VCS adapter tests (core-blueprint.md §7.3).
 *
 * Real temp git repos (`git init` under os.mkdtemp), cleaned up in afterEach.
 * Deterministic and offline — git is local, no network. Proves the VoidRift
 * worktree lifecycle: create + `.meta.json`, clean merge, conflict → abort +
 * recovery branch, and dead-owner TTL prune on boot.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { VcsAdapter } from "./vcs.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function makeRepo(): Promise<string> {
  const dir = hermeticTmp("vcs");
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  // Ensure a stable base branch name across git versions.
  git(dir, "checkout", "-q", "-B", "main");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".voidrift/\n");
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

describe("VcsAdapter — worktree lifecycle (§7.3)", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeRepo();
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("isRepo is true in a repo and false outside one", async () => {
    const vcs = new VcsAdapter(root);
    expect(vcs.isRepo()).toBe(true);
    const outside = hermeticTmp("norepo");
    try {
      expect(new VcsAdapter(outside).isRepo()).toBe(false);
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it("createWorktree makes .voidrift/worktrees/{id} on voidrift-run-{id} with .meta.json", async () => {
    // Given a VCS adapter over a real repo.
    const vcs = new VcsAdapter(root);

    // When a worktree is created for a worker id.
    const wt = await vcs.createWorktree("w1");

    // Then the worktree is on the harness branch at the harness path with meta.
    expect(wt.branch).toBe("voidrift-run-w1");
    expect(wt.path).toBe(path.join(root, ".voidrift/worktrees/w1"));
    expect(fs.existsSync(wt.path)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(wt.path, ".meta.json"), "utf8"));
    expect(meta.pid).toBe(process.pid);
    expect(meta.branch).toBe("voidrift-run-w1");
    expect(typeof meta.timestamp).toBe("string");
  });

  it("a clean worktree merge brings the branch into base and removes the worktree", async () => {
    // Given a worktree whose worker committed a new file.
    const vcs = new VcsAdapter(root);
    const wt = await vcs.createWorktree("w2");
    fs.writeFileSync(path.join(wt.path, "feature.txt"), "feature\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-q", "-m", "feature");

    // When the worktree is merged.
    const result = await vcs.mergeWorktree(wt);

    // Then it merged cleanly, the file is in base, and the worktree is gone.
    expect(result.merged).toBe(true);
    expect(result.recoveryBranch).toBeUndefined();
    expect(fs.existsSync(path.join(root, "feature.txt"))).toBe(true);
    expect(fs.existsSync(wt.path)).toBe(false);
    const branches = git(root, "branch", "--list", "voidrift-run-w2");
    expect(branches.trim()).toBe("");
  });

  it("a merge conflict aborts and preserves the work on voidrift-recovery-{id}", async () => {
    // Given base and worktree both edit the same file divergently.
    const vcs = new VcsAdapter(root);
    const wt = await vcs.createWorktree("w3");
    fs.writeFileSync(path.join(wt.path, "base.txt"), "worker-change\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-q", "-m", "worker edit");
    // Base diverges on the same file so the merge conflicts.
    fs.writeFileSync(path.join(root, "base.txt"), "base-change\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base edit");

    // When the worktree merge is attempted.
    const result = await vcs.mergeWorktree(wt);

    // Then the merge did not land, the base tree is intact (no conflict markers),
    //   and the work is preserved on the recovery branch.
    expect(result.merged).toBe(false);
    expect(result.recoveryBranch).toBe("voidrift-recovery-w3");
    expect(fs.readFileSync(path.join(root, "base.txt"), "utf8")).toBe("base-change\n");
    const recovery = git(root, "branch", "--list", "voidrift-recovery-w3");
    expect(recovery).toContain("voidrift-recovery-w3");
    // The run branch's work is reachable from the recovery branch.
    const show = git(root, "show", "voidrift-recovery-w3:base.txt");
    expect(show).toBe("worker-change\n");
    expect(fs.existsSync(wt.path)).toBe(false);
  });

  it("abandonWorktree preserves work on a recovery branch and removes the worktree", async () => {
    const vcs = new VcsAdapter(root);
    const wt = await vcs.createWorktree("w4");
    fs.writeFileSync(path.join(wt.path, "partial.txt"), "partial\n");
    git(wt.path, "add", "-A");
    git(wt.path, "commit", "-q", "-m", "partial");

    const recoveryBranch = await vcs.abandonWorktree(wt);

    expect(recoveryBranch).toBe("voidrift-recovery-w4");
    expect(git(root, "show", "voidrift-recovery-w4:partial.txt")).toBe("partial\n");
    expect(fs.existsSync(wt.path)).toBe(false);
  });

  it("preserveWorktree leaves the worktree in place (cancel does not delete)", async () => {
    const vcs = new VcsAdapter(root);
    const wt = await vcs.createWorktree("w5");
    const kept = vcs.preserveWorktree(wt);
    expect(kept).toBe(wt.path);
    expect(fs.existsSync(wt.path)).toBe(true);
  });

  it("createWorktree throws when git worktree add fails (duplicate id)", async () => {
    const vcs = new VcsAdapter(root);
    await vcs.createWorktree("dup");
    // A second worktree on the same path/branch fails inside git.
    await expect(vcs.createWorktree("dup")).rejects.toThrow(/worktree add failed/);
  });

  it("removeWorktree falls back to a filesystem delete when git cannot remove it", async () => {
    // Given a worktree whose git registration was pruned out from under it, so
    //   `git worktree remove` fails and the filesystem fallback must fire.
    const vcs = new VcsAdapter(root);
    const wt = await vcs.createWorktree("w6");
    // Corrupt the git worktree registration so `git worktree remove` errors.
    fs.rmSync(path.join(root, ".git", "worktrees"), { recursive: true, force: true });
    // abandonWorktree runs removeWorktree; the dir must be gone afterward.
    await vcs.abandonWorktree(wt);
    expect(fs.existsSync(wt.path)).toBe(false);
  });
});

describe("VcsAdapter — boot cleanup (§7.3 step 5)", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeRepo();
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("prunes a dead-owner worktree older than the TTL and keeps a fresh one", async () => {
    const vcs = new VcsAdapter(root);
    // A stale worktree: dead owner pid, timestamp well past the TTL.
    const stale = await vcs.createWorktree("dead");
    const staleMeta = {
      pid: 2 ** 30, // a pid that does not exist → process.kill throws → dead
      timestamp: new Date(Date.now() - 1000 * 60 * 1000).toISOString(), // 1000 min ago
      branch: "voidrift-run-dead",
    };
    fs.writeFileSync(path.join(stale.path, ".meta.json"), JSON.stringify(staleMeta));
    // A fresh worktree owned by this live process, created just now.
    const fresh = await vcs.createWorktree("alive");

    // When boot cleanup runs with a 120-minute TTL.
    const pruned = await vcs.bootCleanup(120);

    // Then only the dead, stale worktree is pruned; the fresh one survives.
    expect(pruned).toEqual(["dead"]);
    expect(fs.existsSync(stale.path)).toBe(false);
    expect(fs.existsSync(fresh.path)).toBe(true);
    expect(git(root, "branch", "--list", "voidrift-run-dead").trim()).toBe("");
  });

  it("does not prune a dead-owner worktree younger than the TTL", async () => {
    const vcs = new VcsAdapter(root);
    const wt = await vcs.createWorktree("recent");
    fs.writeFileSync(
      path.join(wt.path, ".meta.json"),
      JSON.stringify({ pid: 2 ** 30, timestamp: new Date().toISOString(), branch: "voidrift-run-recent" }),
    );
    const pruned = await vcs.bootCleanup(120);
    expect(pruned).toEqual([]);
    expect(fs.existsSync(wt.path)).toBe(true);
  });

  it("bootCleanup is a no-op outside a git repo", async () => {
    const outside = hermeticTmp("norepo");
    try {
      const vcs = new VcsAdapter(outside);
      expect(await vcs.bootCleanup(120)).toEqual([]);
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("VcsAdapter — branch watch (§7.3, §14.6)", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeRepo();
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("currentBranch reports the checked-out branch in a repo and null outside one", async () => {
    const vcs = new VcsAdapter(root);
    expect(await vcs.currentBranch()).toBe("main");
    const outside = hermeticTmp("norepo");
    try {
      expect(await new VcsAdapter(outside).currentBranch()).toBeNull();
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it("emits BRANCH_CHANGED { branch, previous } when the checked-out branch changes", async () => {
    const events: { branch: string | null; previous: string | null }[] = [];
    const vcs = new VcsAdapter(root, (type, payload) => {
      if (type === "BRANCH_CHANGED") events.push(payload as { branch: string | null; previous: string | null });
    });
    await vcs.startBranchWatch();
    try {
      // When the user checks out a new branch.
      git(root, "checkout", "-q", "-b", "feature");
      // Chokidar polls at 50ms; wait for the HEAD change to propagate.
      await new Promise((r) => setTimeout(r, 600));
      expect(events.length).toBeGreaterThanOrEqual(1);
      const last = events[events.length - 1]!;
      expect(last.branch).toBe("feature");
      expect(last.previous).toBe("main");
    } finally {
      await vcs.stopBranchWatch();
    }
  });

  it("startBranchWatch is a no-op outside a git repo and stop is safe to call", async () => {
    const outside = hermeticTmp("norepo");
    try {
      const vcs = new VcsAdapter(outside);
      await vcs.startBranchWatch();
      await vcs.stopBranchWatch(); // no throw
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("VcsAdapter — removeWorktreesForSession (§5.8)", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeRepo();
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("removes only this session's worktrees + run branches, preserves recovery branches, reports them, and reclaims bytes", async () => {
    const vcs = new VcsAdapter(root);
    // Given two worktrees owned by session S1 and one owned by S2.
    const a = await vcs.createWorktree("a", "s1aaaaaa");
    const b = await vcs.createWorktree("b", "s1aaaaaa");
    const c = await vcs.createWorktree("c", "s2bbbbbb");
    // Some content so reclaimedBytes > 0.
    fs.writeFileSync(path.join(a.path, "file.txt"), "x".repeat(100));
    // A recovery branch for worktree "a" is the user's work — must be preserved.
    git(root, "branch", "voidrift-recovery-a", "voidrift-run-a");

    // When S1 is deleted.
    const res = await vcs.removeWorktreesForSession("s1aaaaaa");

    // Then S1's worktrees and run branches are gone; S2's survive.
    expect(fs.existsSync(a.path)).toBe(false);
    expect(fs.existsSync(b.path)).toBe(false);
    expect(fs.existsSync(c.path)).toBe(true);
    expect(git(root, "branch", "--list", "voidrift-run-a").trim()).toBe("");
    expect(git(root, "branch", "--list", "voidrift-run-b").trim()).toBe("");
    expect(git(root, "branch", "--list", "voidrift-run-c").trim()).not.toBe("");
    // The recovery branch is preserved and reported.
    expect(git(root, "branch", "--list", "voidrift-recovery-a").trim()).not.toBe("");
    expect(res.remainingRecoveryBranches).toContain("voidrift-recovery-a");
    expect(res.reclaimedBytes).toBeGreaterThan(0);
  });

  it("a worktree with no/other session id is never removed (ownership must be proven)", async () => {
    const vcs = new VcsAdapter(root);
    const orphan = await vcs.createWorktree("orphan"); // no sessionId recorded
    const res = await vcs.removeWorktreesForSession("s1aaaaaa");
    expect(fs.existsSync(orphan.path)).toBe(true);
    expect(res.reclaimedBytes).toBe(0);
    expect(res.remainingRecoveryBranches).toEqual([]);
  });

  it("is a no-op outside a git repo", async () => {
    const outside = hermeticTmp("norepo");
    try {
      const vcs = new VcsAdapter(outside);
      const res = await vcs.removeWorktreesForSession("s1aaaaaa");
      expect(res).toEqual({ reclaimedBytes: 0, remainingRecoveryBranches: [] });
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });
});
