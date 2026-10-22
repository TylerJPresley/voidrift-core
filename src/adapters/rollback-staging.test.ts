/**
 * Rollback staging relocation + crash recovery (core-blueprint.md §10.12 item 4,
 * RB5 LOW finding). Staging/aside files must NOT be created beside user files;
 * they live under `.voidrift/cache/snapshots/<session>/tmp/`. A SIGKILL between
 * phases is recovered by a startup sweep; a cross-device target falls back to a
 * sibling temp but registers a pending entry first.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import { existsSync, writeFileSync, readFileSync, readdirSync, renameSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyStaged, sweepSessionTmp, sessionTmpDir, type StagePlan } from "./rollback-staging.js";
import { CacheSnapshotStore } from "./cache-snapshot-store.js";
import type { Move } from "../entities/rollback.js";

const SID = "aabbccdd";
let ws: string;
beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "vr-staging-"));
});
afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

/** Every `.vr-rollback*` file anywhere under `dir` EXCEPT the protected tmp dir. */
function strayStagingFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, n.name);
      // The per-session tmp dir is where staging belongs — not "beside user files".
      if (n.isDirectory()) {
        if (n.name === "tmp") continue;
        walk(full);
      } else if (/\.vr-rollback/.test(n.name)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

describe("rollback staging relocation (§10.12 item 4, RB5)", () => {
  it("success path: no .vr-rollback* file is left beside a user file", () => {
    const tmpDir = sessionTmpDir(path.join(ws, ".voidrift", "cache", "snapshots", SID));
    writeFileSync(path.join(ws, "a.txt"), "v2");
    const plans: StagePlan[] = [{ abs: path.join(ws, "a.txt"), target: Buffer.from("v1") }];
    const restored: string[] = [];
    applyStaged(plans, { tmpDir }, { onWrite: (a) => restored.push(a), onDelete: () => {} });
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("v1");
    expect(restored).toEqual([path.join(ws, "a.txt")]);
    // No stray staging file anywhere in the workspace; tmp/ is swept clean.
    expect(strayStagingFiles(ws)).toEqual([]);
    expect(existsSync(path.join(tmpDir, "pending.json"))).toBe(false);
  });

  it("failure path: a mid-apply throw restores the original tree and leaves no stray staging file", () => {
    const tmpDir = sessionTmpDir(path.join(ws, ".voidrift", "cache", "snapshots", SID));
    writeFileSync(path.join(ws, "a.txt"), "orig-a");
    writeFileSync(path.join(ws, "b.txt"), "orig-b");
    const plans: StagePlan[] = [
      { abs: path.join(ws, "a.txt"), target: Buffer.from("new-a") },
      { abs: path.join(ws, "b.txt"), target: Buffer.from("new-b") },
    ];
    let calls = 0;
    // Throw a NON-EXDEV error on the 3rd rename (b.txt's aside), after a.txt is
    // fully applied, to force a mid-apply rollback.
    const rename = (from: string, to: string): void => {
      calls++;
      if (calls === 3) throw Object.assign(new Error("boom"), { code: "EIO" });
      renameSync(from, to);
    };
    expect(() => applyStaged(plans, { tmpDir, rename }, { onWrite: () => {}, onDelete: () => {} })).toThrow(/boom/);
    // Original tree is intact.
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("orig-a");
    expect(readFileSync(path.join(ws, "b.txt"), "utf8")).toBe("orig-b");
    // No stray staging file beside user files.
    expect(strayStagingFiles(ws)).toEqual([]);
  });

  it("crash between phases → a fresh sweep restores the original tree", () => {
    const sdir = path.join(ws, ".voidrift", "cache", "snapshots", SID);
    const tmpDir = sessionTmpDir(sdir);
    // Model the on-disk state a HARD SIGKILL leaves after phase 1 (original
    // renamed aside into tmp/, pending.json written) but before phase 2: the
    // original is MISSING and the aside is parked in tmp/.
    mkdirSync(tmpDir, { recursive: true });
    const aside = path.join(tmpDir, "a.txt.vr-rollback-bak.crash.0");
    writeFileSync(aside, "orig-a");
    writeFileSync(path.join(tmpDir, "pending.json"), JSON.stringify([{ original: path.join(ws, "a.txt"), backup: aside }]));
    // (the original a.txt does not exist — the crash happened mid-apply)
    expect(existsSync(path.join(ws, "a.txt"))).toBe(false);

    let sweptCount = 0;
    sweepSessionTmp({ tmpDir, onSwept: (c) => (sweptCount = c) });
    // The original is recovered and no leftover remains.
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("orig-a");
    expect(strayStagingFiles(ws)).toEqual([]);
    expect(existsSync(path.join(tmpDir, "pending.json"))).toBe(false);
    expect(sweptCount).toBeGreaterThan(0);
  });

  it("cross-device fallback: a staged-write EXDEV uses a sibling temp and still restores", () => {
    const tmpDir = sessionTmpDir(path.join(ws, ".voidrift", "cache", "snapshots", SID));
    writeFileSync(path.join(ws, "a.txt"), "orig-a");
    const plans: StagePlan[] = [{ abs: path.join(ws, "a.txt"), target: Buffer.from("new-a") }];
    let stagedCalls = 0;
    const rename = (from: string, to: string): void => {
      stagedCalls++;
      // 1st = aside rename (ok); 2nd = staged-content rename → EXDEV once, which
      // the apply retries via a registered sibling temp.
      if (stagedCalls === 2) throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
      renameSync(from, to);
    };
    const restored: string[] = [];
    applyStaged(plans, { tmpDir, rename }, { onWrite: (a) => restored.push(a), onDelete: () => {} });
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("new-a");
    expect(restored).toEqual([path.join(ws, "a.txt")]);
    expect(strayStagingFiles(ws)).toEqual([]);
  });
});

describe("CacheSnapshotStore relocates staging + sweeps on open (§10.12 item 4)", () => {
  it("a restore leaves no .vr-rollback* beside user files; openSession sweeps a crash leftover", async () => {
    const store = new CacheSnapshotStore({ workspaceRoot: ws });
    const abs = path.join(ws, "a.txt");
    writeFileSync(abs, "v1");
    await store.beginTurn({ sessionId: SID, moveId: 1, turn: 1 });
    await store.noteWrite({ sessionId: SID, target: "a.txt", beforeBytes: Buffer.from("v1") });
    writeFileSync(abs, "v2");
    const draft = await store.commitTurn({ sessionId: SID, moveId: 1, turn: 1 });
    const move: Move = { id: 1, sessionId: SID, turn: 1, time: "t", summary: "s", conversation: { beforeCheckpointId: null, afterCheckpointId: "cp-1" }, files: { method: "cache", paths: draft!.paths, notUndoable: [] } };
    const r = await store.restore(move, "undo", { overwrite: new Set() });
    expect(r.restored).toEqual(["a.txt"]);
    expect(readFileSync(abs, "utf8")).toBe("v1");
    expect(strayStagingFiles(ws)).toEqual([]);

    // Simulate a crash leftover and a fresh store opening the session.
    const tmpDir = sessionTmpDir(path.join(ws, ".voidrift", "cache", "snapshots", SID));
    mkdirSync(tmpDir, { recursive: true });
    const aside = path.join(tmpDir, "a.txt.vr-rollback-bak.crash.0");
    writeFileSync(aside, "recovered");
    writeFileSync(path.join(tmpDir, "pending.json"), JSON.stringify([{ original: abs, backup: aside }]));
    await fs.rm(abs);

    const counts: number[] = [];
    const fresh = new CacheSnapshotStore({ workspaceRoot: ws, onSwept: (_s, c) => counts.push(c) });
    await fresh.openSession(SID);
    expect(readFileSync(abs, "utf8")).toBe("recovered");
    expect(strayStagingFiles(ws)).toEqual([]);
    expect(counts.length).toBe(1);
    expect(counts[0]).toBeGreaterThan(0);
  });
});
