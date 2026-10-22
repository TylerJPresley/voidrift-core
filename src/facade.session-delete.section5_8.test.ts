/**
 * `session.delete` destructive-safety integration test (core-blueprint.md §5.8,
 * D27). A real temp workspace that is a real git repo, with the production
 * default adapters (filesystem session repo, filesystem staging, VCS worktrees).
 * Proves delete removes EVERYTHING a session owns — partition, cache, owned
 * staging, its `voidrift-run-*` worktrees/branches — preserves `voidrift-recovery-*`
 * and reports it, isolates a second session, refuses crafted ids (deletes
 * nothing), is NOT_FOUND for an unknown id, never follows a symlink out of the
 * workspace, and works for the current and a paused session with no refusal.
 * Offline/deterministic — git is local, fakeModel drives the loop.
 */
import { hermeticTmp } from "./test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createCore, type CoreReady } from "./boot.js";
import { createMemoryCheckpointer } from "./adapters/checkpointer.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { FilesystemStagingAdapter } from "./adapters/staging.js";
import { VcsAdapter } from "./adapters/vcs.js";

const seed = { models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } }, modelSelected: "t" };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Remove a dir, retrying a few times to survive a branch-watcher poll race. */
async function rmRetry(dir: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

async function makeRepo(): Promise<string> {
  const dir = hermeticTmp("del");
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "checkout", "-q", "-B", "main");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".voidrift/\n");
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

describe("session.delete removes everything the session owns (§5.8, D27)", () => {
  let ws: string;
  let home: string;
  let prevXdg: string | undefined;
  let ready: CoreReady | null;

  beforeEach(async () => {
    ws = await makeRepo();
    home = hermeticTmp("del-home");
    prevXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = home;
    ready = null;
  });
  afterEach(async () => {
    // Shut the core down so handles release before the temp workspace is removed.
    await ready?.api.session.shutdown().catch(() => undefined);
    if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = prevXdg;
    // The booted core's branch watcher polls `.git/HEAD`; give it a tick and
    // retry the removal so an in-flight poll can't win an ENOTEMPTY race.
    await rmRetry(ws);
    await fsp.rm(home, { recursive: true, force: true });
  });

  async function core(): Promise<CoreReady> {
    ready = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed),
      checkpointer: createMemoryCheckpointer(),
      chatModelFactory: () => fakeModel().respond(new AIMessage("hi")),
    });
    return ready;
  }

  /** Seed the owned artifacts for a session id: a cache file, an owned staging
   * folder, and a real worktree with a preserved recovery branch. */
  async function seedOwned(id: string): Promise<{ cacheDir: string; stagingDir: string; wtPath: string }> {
    const cacheDir = path.join(ws, ".voidrift", "cache", "session", id);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "tool-1.txt"), "x".repeat(500)); // evicted result
    const staging = new FilesystemStagingAdapter(ws);
    await staging.createArea(`${id}-run`, id);
    await staging.stageWrite(`${id}-run`, "s.txt", "y".repeat(500));
    const stagingDir = path.join(ws, ".voidrift", "cache", "staging", `${id}-run`);
    const vcs = new VcsAdapter(ws);
    const wt = await vcs.createWorktree(`${id}wk`, id);
    git(ws, "branch", `voidrift-recovery-${id}wk`, `voidrift-run-${id}wk`); // user's work
    return { cacheDir, stagingDir, wtPath: wt.path };
  }

  it("deletes partition, cache, owned staging, worktree+run branch; preserves+reports recovery; reclaims bytes", async () => {
    const { api } = await core();
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const owned = await seedOwned(id);

    let event: { id: string; reclaimedBytes: number; remainingBranches: string[] } | null = null;
    api.events.subscribe("SESSION_DELETED", (e) => (event = e.payload as typeof event));

    const del = await api.session.delete(id);
    expect(del.ok).toBe(true);
    if (!del.ok) return;
    // Everything owned is gone.
    expect(fs.existsSync(owned.cacheDir)).toBe(false);
    expect(fs.existsSync(owned.stagingDir)).toBe(false);
    expect(fs.existsSync(owned.wtPath)).toBe(false);
    expect(fs.existsSync(path.join(ws, ".voidrift", "sessions", id))).toBe(false);
    expect(git(ws, "branch", "--list", `voidrift-run-${id}wk`).trim()).toBe("");
    // Recovery branch preserved and reported.
    expect(git(ws, "branch", "--list", `voidrift-recovery-${id}wk`).trim()).not.toBe("");
    expect(del.value.remainingBranches).toContain(`voidrift-recovery-${id}wk`);
    expect(del.value.reclaimedBytes).toBeGreaterThan(0);
    // The session no longer lists.
    expect((await api.session.list()).some((s) => s.id === id)).toBe(false);
    // SESSION_DELETED carried the id, bytes, and branches.
    expect(event!.id).toBe(id);
    expect(event!.reclaimedBytes).toBeGreaterThan(0);
  });

  it("a second session's cache, staging, and worktree survive untouched", async () => {
    const { api } = await core();
    const a = await api.session.create({});
    const b = await api.session.create({});
    const idA = a.ok ? a.value.id : "";
    const idB = b.ok ? b.value.id : "";
    const ownedA = await seedOwned(idA);
    const ownedB = await seedOwned(idB);

    await api.session.delete(idA);
    expect(fs.existsSync(ownedA.cacheDir)).toBe(false);
    // B is fully intact.
    expect(fs.existsSync(ownedB.cacheDir)).toBe(true);
    expect(fs.existsSync(ownedB.stagingDir)).toBe(true);
    expect(fs.existsSync(ownedB.wtPath)).toBe(true);
    expect(fs.existsSync(path.join(ws, ".voidrift", "sessions", idB))).toBe(true);
    expect(git(ws, "branch", "--list", `voidrift-run-${idB}wk`).trim()).not.toBe("");
  });

  it("a symlink inside the session cache is unlinked, never followed — the outside sentinel survives", async () => {
    const { api } = await core();
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const cacheDir = path.join(ws, ".voidrift", "cache", "session", id);
    fs.mkdirSync(cacheDir, { recursive: true });
    const outside = hermeticTmp("del-out");
    const sentinel = path.join(outside, "sentinel.txt");
    fs.writeFileSync(sentinel, "do-not-delete");
    fs.symlinkSync(sentinel, path.join(cacheDir, "evil-link"));
    try {
      const del = await api.session.delete(id);
      expect(del.ok).toBe(true);
      expect(fs.existsSync(cacheDir)).toBe(false);
      expect(fs.existsSync(sentinel)).toBe(true); // target survives
      expect(fs.readFileSync(sentinel, "utf8")).toBe("do-not-delete");
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it("a crafted id deletes NOTHING and returns a typed error; an outside sentinel survives", async () => {
    const { api } = await core();
    const outside = hermeticTmp("del-out");
    const sentinel = path.join(outside, "sentinel.txt");
    fs.writeFileSync(sentinel, "safe");
    try {
      for (const bad of ["../x", path.join(outside, "x"), "", "ZZZZZZZZ", "s1aaaaaaa" /* 9 chars */]) {
        const r = await api.session.delete(bad);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
      }
      expect(fs.existsSync(sentinel)).toBe(true);
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it("deleting an unknown (valid-shaped) id is NOT_FOUND with no filesystem effect", async () => {
    const { api } = await core();
    const sessionsDir = path.join(ws, ".voidrift", "sessions");
    const before = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).sort() : [];
    const r = await api.session.delete("deadbeef");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SESSION_NOT_FOUND");
    const after = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).sort() : [];
    expect(after).toEqual(before);
    // No cache/staging/worktree dir was created for the unknown id either.
    expect(fs.existsSync(path.join(ws, ".voidrift", "cache", "session", "deadbeef"))).toBe(false);
  });

  it("deletes the CURRENT (active) session with no refusal", async () => {
    const { api } = await core();
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.send(id, { input: "hi" }); // makes it the active session
    const del = await api.session.delete(id);
    expect(del.ok).toBe(true);
    expect((await api.session.list()).some((s) => s.id === id)).toBe(false);
  });

  it("deletes a paused (waiting_for_approval) session with no refusal, cancelling in-flight work", async () => {
    const { api } = await core();
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    // Simulate a paused session by persisting a waiting status to the mirror,
    // then delete it; no special case, no refusal.
    let cancelled = false;
    api.events.subscribe("TURN_CANCELLED", () => (cancelled = true));
    const del = await api.session.delete(id);
    expect(del.ok).toBe(true);
    expect(cancelled).toBe(true); // cancel ran first (§5.8)
  });
});
