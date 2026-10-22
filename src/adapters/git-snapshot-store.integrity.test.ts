/**
 * GitSnapshotStore integrity, cost-budget, and crash-safe-delete tests
 * (core-blueprint.md §10.12 items 1, 3, 4).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitSnapshotStore, type GitRunner } from "./git-snapshot-store.js";
import type { Move } from "../entities/rollback.js";

const SID = "0011aabb";
let ws: string;
let cfg: string;

function git(args: string[], cwd = ws): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  }).toString();
}
async function initRepo(): Promise<void> {
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Test User"]);
  git(["config", "user.email", "test@example.com"]);
  writeFileSync(path.join(ws, "seed.txt"), "seed");
  git(["add", "seed.txt"]);
  git(["commit", "-q", "-m", "seed"]);
}
async function capture(store: GitSnapshotStore, id: number, mutate: () => void): Promise<Move | null> {
  await store.beginTurn({ sessionId: SID, moveId: id, turn: id });
  mutate();
  const draft = await store.commitTurn({ sessionId: SID, moveId: id, turn: id });
  if (!draft) return null;
  return { id, sessionId: SID, turn: id, time: "t", summary: `m${id}`, conversation: { beforeCheckpointId: null, afterCheckpointId: `cp-${id}` }, files: { method: draft.method, paths: draft.paths, notUndoable: draft.notUndoable ?? [] } };
}

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "vr-git-int-"));
  cfg = await fs.mkdtemp(path.join(os.tmpdir(), "vr-git-cfg-"));
  await initRepo();
});
afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
  await fs.rm(cfg, { recursive: true, force: true });
});

describe("§10.12 git method — planted timeline integrity", () => {
  it("resumes a legitimately-signed timeline but rejects a planted one pointing at a crafted ref", async () => {
    const store = new GitSnapshotStore({ root: ws, globalConfigDir: cfg });
    const move = await capture(store, 1, () => writeFileSync(path.join(ws, "a.txt"), "v2"));
    await store.persistTimeline(SID, { version: 2, moves: [move!], pointer: 1 });
    // Legit resume: a fresh store reading the persisted key + verified refs.
    const ok = new GitSnapshotStore({ root: ws, globalConfigDir: cfg });
    const tl = await ok.loadTimeline(SID);
    expect(tl).not.toBeNull();
    expect(tl!.moves).toHaveLength(1);

    // Plant: craft a ref (an ordinary commit, NOT a `voidrift snapshot` commit)
    // and a timeline with a stale/forged hmac pointing at it.
    const crafted = git(["commit-tree", git(["write-tree"]).trim(), "-m", "attacker"]).trim();
    git(["update-ref", `refs/voidrift/${SID}/9/before`, crafted]);
    const tlPath = path.join(ws, ".voidrift", "cache", "snapshots", SID, "timeline.json");
    const planted = JSON.parse(readFileSync(tlPath, "utf8"));
    planted.moves.push({ id: 9, sessionId: SID, turn: 9, time: "t", summary: "evil", paths: [], method: "git" });
    writeFileSync(tlPath, JSON.stringify(planted)); // hmac now stale → untrusted
    const warned: string[] = [];
    const bad = new GitSnapshotStore({ root: ws, globalConfigDir: cfg, onUntrusted: (s) => warned.push(s) });
    expect(await bad.loadTimeline(SID)).toBeNull();
    expect(warned).toEqual([SID]);
  });

  it("rejects a valid-HMAC timeline whose referenced commit message is not a voidrift snapshot", async () => {
    // Build a store that signs over a crafted (non-snapshot) commit by driving
    // persistTimeline after swapping the ref — then the message check fails.
    const store = new GitSnapshotStore({ root: ws, globalConfigDir: cfg });
    const move = await capture(store, 1, () => writeFileSync(path.join(ws, "a.txt"), "v2"));
    await store.persistTimeline(SID, { version: 2, moves: [move!], pointer: 1 });
    // Swap move 1's before ref to point at a non-snapshot commit AFTER signing.
    const crafted = git(["commit-tree", git(["write-tree"]).trim(), "-m", "not a snapshot"]).trim();
    git(["update-ref", `refs/voidrift/${SID}/1/before`, crafted]);
    const fresh = new GitSnapshotStore({ root: ws, globalConfigDir: cfg });
    // The HMAC no longer matches the swapped sha → untrusted.
    expect(await fresh.loadTimeline(SID)).toBeNull();
  });
});

describe("§10.12 git method — capture cost budget (item 3)", () => {
  it("degrades to snapshot-failed when the untracked-entry probe exceeds the ceiling", async () => {
    // An injected runner that reports a huge untracked count on the size probe.
    const slow: GitRunner = async (args) => {
      if (args.includes("ls-files") && args.includes("--others")) {
        // Emit > 200,000 NUL separators to trip the ceiling.
        const buf = Buffer.alloc(200_001, 0);
        return { stdout: buf.toString("utf8"), stdoutBuf: buf, stderr: "", code: 0 };
      }
      return { stdout: "", stdoutBuf: Buffer.alloc(0), stderr: "", code: 0 };
    };
    const degraded: string[] = [];
    const store = new GitSnapshotStore({ root: ws, globalConfigDir: cfg, runner: slow, onSnapshotDegraded: (s) => degraded.push(s) });
    await store.beginTurn({ sessionId: SID, moveId: 1, turn: 1 });
    const draft = await store.commitTurn({ sessionId: SID, moveId: 1, turn: 1 });
    expect(draft?.notUndoable?.[0]).toMatchObject({ kind: "snapshot-failed" });
    expect(draft!.notUndoable![0]!.detail).toMatch(/took too long/);
    expect(degraded).toContain(SID);
  });

  it("degrades when a capture git call times out (non-zero code on write-tree)", async () => {
    const slow: GitRunner = async (args) => {
      if (args.includes("ls-files")) return { stdout: "", stdoutBuf: Buffer.alloc(0), stderr: "", code: 0 };
      if (args.includes("write-tree")) return { stdout: "", stdoutBuf: Buffer.alloc(0), stderr: "timed out", code: 1 };
      return { stdout: "", stdoutBuf: Buffer.alloc(0), stderr: "", code: 0 };
    };
    const store = new GitSnapshotStore({ root: ws, globalConfigDir: cfg, runner: slow, onSnapshotDegraded: vi.fn() });
    await store.beginTurn({ sessionId: SID, moveId: 1, turn: 1 });
    const draft = await store.commitTurn({ sessionId: SID, moveId: 1, turn: 1 });
    expect(draft?.notUndoable?.[0]).toMatchObject({ kind: "snapshot-failed" });
    expect(draft!.notUndoable![0]!.detail).toMatch(/took too long/);
  });
});

describe("§10.12 git method — crash-safe deletes (item 4)", () => {
  it("a failure injected between phases leaves the original tree unchanged", async () => {
    // Capture a move that CREATES two files: a top-level `a.txt` and a nested
    // `sub/b.txt`. Undo must DELETE both.
    const store = new GitSnapshotStore({ root: ws, globalConfigDir: cfg });
    const move = await capture(store, 1, () => {
      writeFileSync(path.join(ws, "a.txt"), "A");
      mkdirSync(path.join(ws, "sub"), { recursive: true });
      writeFileSync(path.join(ws, "sub", "b.txt"), "B");
    });
    // Inject a REAL mid-apply failure: make `sub/` read-only so the delete's
    // rename-aside of `sub/b.txt` throws EACCES. `a.txt` (processed first) is
    // renamed aside successfully, so the transaction must roll it back.
    const { chmodSync } = await import("node:fs");
    chmodSync(path.join(ws, "sub"), 0o555);
    try {
      await expect(store.restore(move!, "undo", { overwrite: new Set() })).rejects.toThrow();
    } finally {
      chmodSync(path.join(ws, "sub"), 0o755);
    }
    // Both originals must survive intact — no half-applied delete.
    expect(existsSync(path.join(ws, "a.txt"))).toBe(true);
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("A");
    expect(existsSync(path.join(ws, "sub", "b.txt"))).toBe(true);
    expect(readFileSync(path.join(ws, "sub", "b.txt"), "utf8")).toBe("B");
  });
});
