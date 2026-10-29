/**
 * VCS adapter include-list tests (core-blueprint.md §7.3).
 *
 * Real temp git repos. Proves `createWorktree(id, sessionId, include)` copies
 * each untracked/ignored include path into the worktree at creation, with the
 * conservative copy rules: tracked paths skipped silently, ignored dirs copied,
 * existing files never overwritten, symlink ENTRIES that escape the repo refused,
 * symlinks INSIDE a copied directory not followed, missing entries ignored, the
 * 1 GiB cap skipping a whole entry, and file modes preserved. Offline.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { VcsAdapter } from "./vcs.js";
import { copyIncludeList, WORKTREE_INCLUDE_CAP_BYTES } from "./worktree-include.js";
import { EventBus } from "../entities/event-bus.js";
import { resolveLimits } from "../entities/limits-resolve.js";
import { LimitsCapability } from "../use-cases/limits-capability.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function makeRepo(): Promise<string> {
  const dir = hermeticTmp("wtinc");
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "checkout", "-q", "-B", "main");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".voidrift/\nnode_modules/\n");
  fs.writeFileSync(path.join(dir, "tracked.txt"), "tracked\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

describe("VcsAdapter — worktreeInclude copy at creation (§7.3)", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeRepo();
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("copies an untracked file and an untracked directory into the worktree", async () => {
    fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n");
    fs.mkdirSync(path.join(root, "localcache"));
    fs.writeFileSync(path.join(root, "localcache", "a.bin"), "x".repeat(10));
    const events: { t: string; p: unknown }[] = [];
    const vcs = new VcsAdapter(root, (t, p) => events.push({ t, p }));

    const wt = await vcs.createWorktree("w1", undefined, [".env", "localcache"]);

    expect(fs.readFileSync(path.join(wt.path, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(fs.readFileSync(path.join(wt.path, "localcache", "a.bin"), "utf8")).toBe("x".repeat(10));
    // The copy is real, not a symlink back to the original.
    expect(fs.lstatSync(path.join(wt.path, ".env")).isSymbolicLink()).toBe(false);
    expect(events.some((e) => e.t === "WORKTREE_INCLUDE_COPIED")).toBe(true);
  });

  it("skips a tracked path silently (git already materialized it)", async () => {
    const events: { t: string }[] = [];
    const vcs = new VcsAdapter(root, (t) => events.push({ t }));
    const wt = await vcs.createWorktree("w2", undefined, ["tracked.txt"]);
    expect(fs.existsSync(path.join(wt.path, "tracked.txt"))).toBe(true); // from git
    expect(events.some((e) => e.t === "WORKTREE_INCLUDE_SKIPPED")).toBe(false);
    expect(events.some((e) => e.t === "WORKTREE_INCLUDE_COPIED")).toBe(false);
  });

  it("copies a git-ignored node_modules-like directory", async () => {
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "module.exports={}\n");
    const vcs = new VcsAdapter(root);
    const wt = await vcs.createWorktree("w3", undefined, ["node_modules"]);
    expect(fs.readFileSync(path.join(wt.path, "node_modules", "pkg", "index.js"), "utf8")).toBe("module.exports={}\n");
  });

  it("never overwrites an existing file in the worktree", async () => {
    fs.mkdirSync(path.join(root, "overlay"));
    fs.writeFileSync(path.join(root, "overlay", "keep.txt"), "from-main\n");
    const vcs = new VcsAdapter(root);
    const wt = await vcs.createWorktree("w4", undefined, ["overlay"]);
    const dest = path.join(wt.path, "overlay", "keep.txt");
    expect(fs.readFileSync(dest, "utf8")).toBe("from-main\n");
    // Edit the destination, then re-run the copy helper: the existing file must
    // NOT be overwritten.
    fs.writeFileSync(dest, "worker-edited\n");
    copyIncludeList(root, wt.path, ["overlay"], () => false);
    expect(fs.readFileSync(dest, "utf8")).toBe("worker-edited\n");
  });

  it("refuses a symlink ENTRY whose real path escapes the repo (skipped + warned)", async () => {
    const outside = hermeticTmp("outside");
    try {
      fs.writeFileSync(path.join(outside, "target.txt"), "outside\n");
      fs.symlinkSync(path.join(outside, "target.txt"), path.join(root, "escape"));
      const events: { t: string; p: unknown }[] = [];
      const vcs = new VcsAdapter(root, (t, p) => events.push({ t, p }));
      const wt = await vcs.createWorktree("w5", undefined, ["escape"]);
      expect(fs.existsSync(path.join(wt.path, "escape"))).toBe(false);
      const skip = events.find((e) => e.t === "WORKTREE_INCLUDE_SKIPPED");
      expect(skip).toBeDefined();
      expect((skip!.p as { message: string }).message).toMatch(/worktreeInclude: skipped escape \(.*outside/);
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it("does not follow a symlink INSIDE a copied directory (and warns when it escapes)", async () => {
    const outside = hermeticTmp("outside2");
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "leak\n");
      fs.mkdirSync(path.join(root, "bundle"));
      fs.writeFileSync(path.join(root, "bundle", "real.txt"), "real\n");
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "bundle", "link"));
      const events: { t: string; p: unknown }[] = [];
      const vcs = new VcsAdapter(root, (t, p) => events.push({ t, p }));
      const wt = await vcs.createWorktree("w6", undefined, ["bundle"]);
      expect(fs.readFileSync(path.join(wt.path, "bundle", "real.txt"), "utf8")).toBe("real\n");
      expect(fs.existsSync(path.join(wt.path, "bundle", "link"))).toBe(false);
      const skip = events.find((e) => e.t === "WORKTREE_INCLUDE_SKIPPED");
      expect((skip!.p as { message: string }).message).toMatch(/symlink inside a copied directory/);
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it("ignores a missing entry (nothing to copy, no warning)", async () => {
    const events: unknown[] = [];
    const vcs = new VcsAdapter(root, (t, p) => events.push({ t, p }));
    const wt = await vcs.createWorktree("w7", undefined, ["does-not-exist"]);
    expect(fs.existsSync(path.join(wt.path, "does-not-exist"))).toBe(false);
    expect(events.length).toBe(0);
  });

  it("skips a whole entry that would push past the 1 GiB cap", async () => {
    fs.writeFileSync(path.join(root, "small.txt"), "ok\n");
    const bigPath = path.join(root, "big.bin");
    const fd = fs.openSync(bigPath, "w");
    fs.ftruncateSync(fd, WORKTREE_INCLUDE_CAP_BYTES + 1); // sparse file over the cap
    fs.closeSync(fd);
    const vcs = new VcsAdapter(root);
    const wt = await vcs.createWorktree("w8", undefined, ["small.txt", "big.bin"]);
    expect(fs.existsSync(path.join(wt.path, "small.txt"))).toBe(true);
    expect(fs.existsSync(path.join(wt.path, "big.bin"))).toBe(false);
  });

  it("SNAP4: default cap equals the registry worktree.includeCapBytes (1 GiB)", async () => {
    const { limitDefault } = await import("../entities/limits.js");
    expect(WORKTREE_INCLUDE_CAP_BYTES).toBe(limitDefault("worktree.includeCapBytes"));
  });

  it("SNAP4: an explicit capBytes override changes which entries copy", async () => {
    fs.writeFileSync(path.join(root, "a.bin"), "x".repeat(100));
    fs.writeFileSync(path.join(root, "b.bin"), "y".repeat(100));
    const wt = await new VcsAdapter(root).createWorktree("w8b", undefined, []);
    // Cap of 150 bytes admits the first 100-byte entry, skips the second.
    const res = copyIncludeList(root, wt.path, ["a.bin", "b.bin"], () => false, 150);
    expect(res.copied.map((c) => c.path)).toEqual(["a.bin"]);
    expect(res.skipped.find((s) => s.path === "b.bin")?.reason).toMatch(/worktree copy cap/);
  });

  it("SNAP4: the real vcs adapter wires the limits port — an over-cap entry is skipped and fires ONE LIMIT_HIT", async () => {
    // Given a real repo with an untracked file over a TINY effective cap, and a
    // real LimitsCapability built from a project override (so the adapter's
    // getIncludeCapBytes AND the LimitsPort both reflect it).
    fs.writeFileSync(path.join(root, "a.bin"), "x".repeat(100));
    fs.writeFileSync(path.join(root, "big.bin"), "y".repeat(500));
    const bus = new EventBus();
    const hits: { key: string; observed?: number }[] = [];
    bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string; observed?: number }));
    const limits = new LimitsCapability(
      resolveLimits([{ layer: "project", limits: { worktree: { includeCapBytes: 150 } } }]),
      bus,
      { workspace: root },
    );
    // When a worktree is created through the real adapter wired exactly as boot.ts
    // wires it (getIncludeCapBytes + the limits port).
    const vcs = new VcsAdapter(root, () => {}, () => limits.get("worktree.includeCapBytes"), limits);
    const wt = await vcs.createWorktree("wcap", undefined, ["a.bin", "big.bin"]);

    // Then the first entry copied, the over-cap one skipped WHOLE, and exactly
    // ONE LIMIT_HIT named the key.
    expect(fs.existsSync(path.join(wt.path, "a.bin"))).toBe(true);
    expect(fs.existsSync(path.join(wt.path, "big.bin"))).toBe(false);
    expect(hits.filter((h) => h.key === "worktree.includeCapBytes").length).toBe(1);
  });

  it("SNAP4: no LIMIT_HIT when every entry fits under the effective cap", async () => {
    fs.writeFileSync(path.join(root, "a.bin"), "x".repeat(100));
    const bus = new EventBus();
    const hits: { key: string }[] = [];
    bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string }));
    const limits = new LimitsCapability(
      resolveLimits([{ layer: "project", limits: { worktree: { includeCapBytes: 1000 } } }]),
      bus,
      { workspace: root },
    );
    const vcs = new VcsAdapter(root, () => {}, () => limits.get("worktree.includeCapBytes"), limits);
    const wt = await vcs.createWorktree("wfit", undefined, ["a.bin"]);
    expect(fs.existsSync(path.join(wt.path, "a.bin"))).toBe(true);
    expect(hits.filter((h) => h.key === "worktree.includeCapBytes").length).toBe(0);
  });

  it("preserves file modes on a copied file", async () => {
    const exe = path.join(root, "run.sh");
    fs.writeFileSync(exe, "#!/bin/sh\necho hi\n");
    fs.chmodSync(exe, 0o755);
    const vcs = new VcsAdapter(root);
    const wt = await vcs.createWorktree("w9", undefined, ["run.sh"]);
    const mode = fs.statSync(path.join(wt.path, "run.sh")).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it("does nothing when the include list is empty", async () => {
    const events: unknown[] = [];
    const vcs = new VcsAdapter(root, (t, p) => events.push({ t, p }));
    await vcs.createWorktree("w10", undefined, []);
    expect(events.length).toBe(0);
  });

  it("never copies a nested .git (file or dir, any depth) and reports the count", async () => {
    // A vendored tree carrying its own git state: vendored/sub/.git must NOT be
    // copied (it would corrupt the worktree), but the real content around it is.
    fs.mkdirSync(path.join(root, "vendored", "sub", ".git", "refs"), { recursive: true });
    fs.writeFileSync(path.join(root, "vendored", "sub", ".git", "HEAD"), "ref: x\n");
    fs.writeFileSync(path.join(root, "vendored", "sub", "code.js"), "ok\n");
    // A nested .git as a FILE (a submodule gitlink) at a different depth.
    fs.writeFileSync(path.join(root, "vendored", ".git"), "gitdir: ../elsewhere\n");
    const events: { t: string; p: unknown }[] = [];
    const vcs = new VcsAdapter(root, (t, p) => events.push({ t, p }));

    const wt = await vcs.createWorktree("w11", undefined, ["vendored"]);

    // Real content copied; no .git anywhere in the destination.
    expect(fs.readFileSync(path.join(wt.path, "vendored", "sub", "code.js"), "utf8")).toBe("ok\n");
    expect(fs.existsSync(path.join(wt.path, "vendored", ".git"))).toBe(false);
    expect(fs.existsSync(path.join(wt.path, "vendored", "sub", ".git"))).toBe(false);
    // One summary line counting both skipped .git entries (dir + file).
    const summary = events.find(
      (e) => e.t === "WORKTREE_INCLUDE_SKIPPED" && /skipped \d+ nested \.git/.test((e.p as { message: string }).message),
    );
    expect(summary).toBeDefined();
    expect((summary!.p as { message: string }).message).toBe("worktreeInclude: skipped 2 nested .git");
  });
});
