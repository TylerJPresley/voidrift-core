/**
 * Rollback roundtrip integration (core-blueprint.md §10.12) — the RollbackService
 * wired to the REAL snapshot stores over REAL temp directories.
 *
 * The CLI's `/undo`/`/redo`/`/goto` are interactive-only and headless has no
 * slash commands, so there is no real-binary e2e path for rollback (cli-blueprint
 * §7.5, §8). This is the integration the CLI rollback stage leans on instead: it
 * drives the service exactly as the facade does — beginTurn → write → commitTurn
 * → `undo` → `redo` — and asserts the user's working tree is restored and
 * re-applied, once in a real git repo (git method) and once in a non-git dir
 * (cache method). Deterministic and offline; no model is involved because the
 * write path is the store's capture, not a tool call.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitSnapshotStore } from "../adapters/git-snapshot-store.js";
import { CacheSnapshotStore } from "../adapters/cache-snapshot-store.js";
import { RollbackService } from "./rollback.js";
import type { SnapshotStore } from "../entities/ports/snapshot-store.js";

const SID = "0011aabb";
let ws: string;

function writeRel(rel: string, content: string): void {
  const abs = path.join(ws, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
function readRel(rel: string): string | null {
  const abs = path.join(ws, rel);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

/** Build a service over a given store with an unbounded snapshot window and a
 * swallowing event sink (the events themselves are asserted elsewhere). */
function makeService(store: SnapshotStore): RollbackService {
  return new RollbackService({ store, getSnapshotCount: () => 50, emit: () => undefined });
}

/** Drive one writing turn through the service + store: beginTurn → mutate →
 * (cache) noteWrite the before-bytes → commitTurn, exactly as the engine does. */
async function turn(
  svc: RollbackService,
  store: SnapshotStore,
  id: number,
  rel: string,
  next: string,
  message: string,
): Promise<void> {
  await svc.beginTurn(SID, id);
  // Cache attribution needs the before-bytes; git ignores noteWrite.
  const beforeAbs = path.join(ws, rel);
  const before = existsSync(beforeAbs) ? readFileSync(beforeAbs) : null;
  await store.noteWrite({ sessionId: SID, target: rel, beforeBytes: before });
  writeRel(rel, next);
  await svc.commitTurn(SID, message);
}

afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

describe("§10.12 rollback roundtrip — git method (real git repo)", () => {
  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), "vr-rb-git-"));
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws, env });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: ws, env });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: ws, env });
    writeRel("a.txt", "v1");
    execFileSync("git", ["add", "a.txt"], { cwd: ws, env });
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: ws, env });
  });

  it("a turn writes a file → undo restores it → redo re-applies it", async () => {
    const store = new GitSnapshotStore({ root: ws });
    const svc = makeService(store);
    expect(store.method).toBe("git");

    await turn(svc, store, 1, "a.txt", "v2", "edit a");
    expect(readRel("a.txt")).toBe("v2");

    const undo = await svc.undo(SID);
    expect(undo.ok).toBe(true);
    expect(undo.restored).toContain("a.txt");
    expect(readRel("a.txt")).toBe("v1"); // restored to the before-turn content

    const redo = await svc.redo(SID);
    expect(redo.ok).toBe(true);
    expect(readRel("a.txt")).toBe("v2"); // re-applied
  });
});

describe("§10.12 rollback roundtrip — cache method (non-git dir)", () => {
  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), "vr-rb-cache-"));
  });

  it("a turn writes a file → undo restores it → redo re-applies it", async () => {
    const store = new CacheSnapshotStore({ workspaceRoot: ws });
    const svc = makeService(store);
    expect(store.method).toBe("cache");

    writeRel("a.txt", "v1"); // the pre-existing content the before-bytes capture sees
    await turn(svc, store, 1, "a.txt", "v2", "edit a");
    expect(readRel("a.txt")).toBe("v2");

    const undo = await svc.undo(SID);
    expect(undo.ok).toBe(true);
    expect(undo.restored).toContain("a.txt");
    expect(readRel("a.txt")).toBe("v1");

    const redo = await svc.redo(SID);
    expect(redo.ok).toBe(true);
    expect(readRel("a.txt")).toBe("v2");
  });
});
