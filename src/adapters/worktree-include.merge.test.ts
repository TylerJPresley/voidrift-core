/**
 * Worktree include-list ↔ merge interaction (core-blueprint.md §7.3).
 *
 * The include-list is honored at CREATION only; the copied paths are the
 * worker's own untracked files and are NEVER carried back by a merge. A merge of
 * the worker's run branch carries only COMMITTED changes, and nothing in the
 * harness commits the included paths — so after a clean merge the worker's
 * committed work lands in the main tree while the included untracked files are
 * absent and the main tree's git status is clean. Proven over the real VCS
 * adapter and a real temp git repo (the dispatch path wires this adapter).
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
  const dir = hermeticTmp("wtmerge");
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "checkout", "-q", "-B", "main");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".voidrift/\n.env\n");
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

describe("worktreeInclude — included untracked files are never merged back (§7.3)", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeRepo();
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("a worker's worktree contains the included path; after merge it is absent from the main tree and status is clean", async () => {
    // Given an untracked (git-ignored) .env in the main tree.
    fs.writeFileSync(path.join(root, ".env"), "SECRET=abc\n");
    const vcs = new VcsAdapter(root);

    // When a worker's worktree is created with .env on the include list.
    const wt = await vcs.createWorktree("merge1", undefined, [".env"]);
    // Then the included path is present in the worker's worktree.
    expect(fs.readFileSync(path.join(wt.path, ".env"), "utf8")).toBe("SECRET=abc\n");

    // The worker does its real (tracked) work and COMMITS it on the run branch.
    fs.writeFileSync(path.join(wt.path, "feature.txt"), "feature\n");
    git(wt.path, "add", "feature.txt");
    git(wt.path, "commit", "-q", "-m", "worker feature");
    // The included .env is NOT committed (it is git-ignored and never auto-added);
    // only the harness-written .meta.json is untracked in the worktree.
    const wtStatus = git(wt.path, "status", "--porcelain");
    expect(wtStatus).not.toContain(".env");

    // When the worktree is merged.
    const result = await vcs.mergeWorktree(wt);
    expect(result.merged).toBe(true);

    // Then the worker's committed change landed in the main tree.
    expect(fs.readFileSync(path.join(root, "feature.txt"), "utf8")).toBe("feature\n");
    // The included untracked file did NOT appear as a tracked/merged file: the
    // main tree's own .env (which pre-existed) is still ignored and untracked,
    // and git never recorded a copy of it from the worktree.
    const lsFiles = git(root, "ls-files");
    expect(lsFiles).not.toContain(".env");
    // The main tree's git status is clean (the pre-existing ignored .env does not
    // show; no copied path leaked into tracked state).
    expect(git(root, "status", "--porcelain").trim()).toBe("");
    // The worktree (and its copied .env) is gone.
    expect(fs.existsSync(wt.path)).toBe(false);
  });

  it("a brand-new ignored file copied into the worktree never becomes tracked after merge", async () => {
    // A file that does NOT exist in the main tree, only copied into the worktree.
    fs.writeFileSync(path.join(root, "local-only.log"), "lines\n"); // ignored? add to gitignore
    fs.appendFileSync(path.join(root, ".gitignore"), "local-only.log\n");
    git(root, "add", ".gitignore");
    git(root, "commit", "-q", "-m", "ignore log");
    const vcs = new VcsAdapter(root);
    const wt = await vcs.createWorktree("merge2", undefined, ["local-only.log"]);
    expect(fs.existsSync(path.join(wt.path, "local-only.log"))).toBe(true);
    // Worker commits unrelated tracked work.
    fs.writeFileSync(path.join(wt.path, "x.txt"), "x\n");
    git(wt.path, "add", "x.txt");
    git(wt.path, "commit", "-q", "-m", "x");
    const result = await vcs.mergeWorktree(wt);
    expect(result.merged).toBe(true);
    expect(git(root, "ls-files")).not.toContain("local-only.log");
    expect(git(root, "status", "--porcelain").trim()).toBe("");
  });
});
