/**
 * VCS adapter — untrusted-repo git hardening (security-audit S2, §7.3).
 *
 * A REAL temp git repo seeded with malicious `.git/config` entries and a
 * `.gitattributes` filter driver, each wired to a script that touches a sentinel
 * file. Running the VCS adapter's diff/status/worktree-add/merge must NEVER
 * create any sentinel (git's program-executing config is neutralised) while the
 * operations still succeed. A repo with no user identity still merges, and the
 * untrusted-config warning is emitted once naming every key class.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { VcsAdapter } from "./vcs.js";

function git(cwd: string, ...args: string[]): string {
  // The test's OWN git calls are plain (set-up only, not under test).
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A fully-neutralised git for the test's OWN setup commits INSIDE the malicious
 * repo, so the setup itself never trips the repo's config hooks (only the
 * adapter's operations are under test). Mirrors the adapter's hardening. */
function safeGit(cwd: string, ...args: string[]): string {
  const ov = [
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=",
    "-c", "core.sshCommand=",
    "-c", "core.pager=cat",
    "-c", "core.editor=true",
    "-c", "diff.external=",
    "-c", "credential.helper=",
    "-c", "gpg.program=false",
    "-c", "commit.gpgsign=false",
    "-c", "filter.evil.clean=",
    "-c", "filter.evil.smudge=",
    "-c", "filter.evil.required=false",
  ];
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1", GIT_PAGER: "cat", GIT_EDITOR: "true" };
  return execFileSync("git", [...ov, ...args], { cwd, encoding: "utf8", env });
}

/** Write an executable shell script that appends a line to `sentinel`. */
function writeSentinelScript(file: string, sentinel: string): void {
  fs.writeFileSync(file, `#!/bin/sh\necho hit >> "${sentinel}"\nexit 0\n`, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

/** A real repo whose git config is fully weaponised to run `script` on any op. */
async function makeMaliciousRepo(): Promise<{ root: string; sentinel: string }> {
  const root = hermeticTmp("evil");
  const sentinel = path.join(root, "SENTINEL");
  const script = path.join(root, "evil.sh");
  writeSentinelScript(script, sentinel);
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t.t");
  git(root, "config", "user.name", "t");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "checkout", "-q", "-B", "main");
  fs.writeFileSync(path.join(root, ".gitignore"), ".voidrift/\nSENTINEL\nevil.sh\n");
  fs.writeFileSync(path.join(root, "base.txt"), "base\n");
  // A .gitattributes textconv/filter driver on a tracked file.
  fs.writeFileSync(path.join(root, ".gitattributes"), "base.txt filter=evil diff=evil\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  // Weaponise the repo-local config AFTER the base commit.
  const hooksDir = path.join(root, ".git", "evilhooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const hook of ["post-merge", "pre-commit", "post-checkout", "post-index-change"]) {
    writeSentinelScript(path.join(hooksDir, hook), sentinel);
  }
  const cfg = [
    "[core]",
    `\tfsmonitor = ${script}`,
    `\tsshCommand = ${script}`,
    `\thooksPath = ${hooksDir}`,
    `\tpager = ${script}`,
    `\teditor = ${script}`,
    "[diff]",
    `\texternal = ${script}`,
    '[diff "evil"]',
    `\ttextconv = ${script}`,
    '[filter "evil"]',
    `\tsmudge = ${script}`,
    `\tclean = ${script}`,
    "\trequired = true",
    "[credential]",
    `\thelper = ${script}`,
    "[gpg]",
    `\tprogram = ${script}`,
  ].join("\n");
  fs.appendFileSync(path.join(root, ".git", "config"), "\n" + cfg + "\n");
  return { root, sentinel };
}

describe("VcsAdapter — untrusted-repo git hardening (§7.3, S2)", () => {
  let root: string;
  let sentinel: string;
  const warnings: { type: string; payload: unknown }[] = [];

  beforeEach(async () => {
    warnings.length = 0;
    ({ root, sentinel } = await makeMaliciousRepo());
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  function adapter(): VcsAdapter {
    return new VcsAdapter(root, (type, payload) => warnings.push({ type, payload }));
  }

  it("diff / status / worktree-add / merge never execute the repo's config scripts, and still succeed", async () => {
    const vcs = adapter();

    // status-shaped: currentBranch (rev-parse) + working diff.
    expect(await vcs.currentBranch()).toBe("main");
    // Mutate a tracked file so `git diff HEAD` has something to show (and would
    // invoke a textconv/external-diff driver if hardening were absent).
    fs.writeFileSync(path.join(root, "base.txt"), "base\nchanged\n");
    const diff = await vcs.workingDiff();
    expect(diff).toContain("base.txt");
    // Restore the working tree so the uncommitted edit does not block the merge
    // (the merge, not the diff, is the operation under test here).
    fs.writeFileSync(path.join(root, "base.txt"), "base\n");

    // worktree add (would fire a filter smudge + post-checkout hook unhardened).
    const wt = await vcs.createWorktree("w1");
    expect(fs.existsSync(wt.path)).toBe(true);
    // Commit work in the worktree, then merge (would fire post-merge hook). The
    // commit is test SETUP (not the op under test); disable the repo's own
    // fsmonitor/hooks on it so the setup git doesn't itself trip the sentinel.
    fs.writeFileSync(path.join(wt.path, "feature.txt"), "feature\n");
    safeGit(wt.path, "add", "-A");
    safeGit(wt.path, "commit", "-q", "-m", "feature");
    const merged = await vcs.mergeWorktree(wt);
    expect(merged.merged).toBe(true);
    expect(fs.existsSync(path.join(root, "feature.txt"))).toBe(true);

    // THE assertion: no script ever ran — the sentinel was never created.
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it("emits ONE untrusted-config warning naming every executable-capable key class", async () => {
    const vcs = adapter();
    await vcs.currentBranch(); // first git op triggers the scan + warning
    await vcs.workingDiff();
    const w = warnings.filter((x) => x.type === "GIT_CONFIG_UNTRUSTED");
    expect(w).toHaveLength(1); // emitted exactly once per adapter
    const payload = w[0]!.payload as { classes: string[]; message: string; files: string[] };
    expect(payload.classes).toEqual(
      expect.arrayContaining([
        "core.fsmonitor",
        "core.sshCommand",
        "core.hooksPath",
        "core.pager",
        "core.editor",
        "diff.external",
        "diff.textconv",
        "filter",
        "credential",
        "gpg",
      ]),
    );
    expect(payload.message).toContain("review .git/config");
    // Value-free: the warning names classes/files, never a config value.
    expect(JSON.stringify(payload)).not.toContain("evil.sh");
  });

  it("merges a repo with NO user identity (neutral identity injected)", async () => {
    // A fresh repo with its identity unset and no malicious config.
    const plain = hermeticTmp("noident");
    try {
      git(plain, "init", "-q");
      git(plain, "checkout", "-q", "-B", "main");
      // Explicitly ensure no identity resolves for this repo.
      fs.appendFileSync(path.join(plain, ".git", "config"), "\n");
      fs.writeFileSync(path.join(plain, ".gitignore"), ".voidrift/\n");
      fs.writeFileSync(path.join(plain, "base.txt"), "base\n");
      // Commit the base with a one-off identity (setup only).
      execFileSync(
        "git",
        ["-c", "user.name=setup", "-c", "user.email=s@s", "commit", "--allow-empty", "-q", "-m", "base"],
        { cwd: plain },
      );
      execFileSync("git", ["-c", "user.name=setup", "-c", "user.email=s@s", "add", "-A"], { cwd: plain });
      execFileSync(
        "git",
        ["-c", "user.name=setup", "-c", "user.email=s@s", "commit", "-q", "-m", "files"],
        { cwd: plain },
      );

      const vcs = new VcsAdapter(plain);
      const wt = await vcs.createWorktree("n1");
      fs.writeFileSync(path.join(wt.path, "f.txt"), "f\n");
      execFileSync(
        "git",
        ["-c", "user.name=setup", "-c", "user.email=s@s", "-c", "core.hooksPath=", "add", "-A"],
        { cwd: wt.path },
      );
      execFileSync(
        "git",
        ["-c", "user.name=setup", "-c", "user.email=s@s", "-c", "core.hooksPath=", "commit", "-q", "-m", "w"],
        { cwd: wt.path },
      );
      // The merge runs WITHOUT a resolvable identity on `plain` — hardening must
      // inject a neutral identity so the merge commit still succeeds.
      const merged = await vcs.mergeWorktree(wt);
      expect(merged.merged).toBe(true);
      expect(fs.existsSync(path.join(plain, "f.txt"))).toBe(true);
    } finally {
      await fsp.rm(plain, { recursive: true, force: true });
    }
  });
});
