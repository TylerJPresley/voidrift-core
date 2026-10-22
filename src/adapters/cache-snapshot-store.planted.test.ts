/**
 * Planted-snapshot integrity tests (core-blueprint.md §10.12, §9.4).
 *
 * The HIGH-security review: `.voidrift/cache/snapshots/<session>/` can ship
 * inside a cloned, untrusted repo. A planted manifest + a blob named
 * sha256("PWNED") must restore NOTHING; tampered/foreign-key/foreign-workspace
 * state must be ignored; a wrong-content blob under a valid-looking name must
 * fail its re-hash; the happy path must still resume across a simulated process
 * restart with the PERSISTED key; the key file is 0600; a read-only global dir
 * degrades to an in-memory key (resume starts empty).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import { createHash, randomBytes, createHmac } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CacheSnapshotStore } from "./cache-snapshot-store.js";
import { canonicalJson, ROLLBACK_KEY_FILE } from "./rollback-integrity.js";
import type { Move } from "../entities/rollback.js";

const SID = "aabbccdd";

let ws: string;
let cfg: string; // a writable global config dir for the persisted key

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "vr-planted-ws-"));
  cfg = await fs.mkdtemp(path.join(os.tmpdir(), "vr-planted-cfg-"));
});
afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
  await fs.rm(cfg, { recursive: true, force: true });
});

function snapshotsDir(): string {
  return path.join(ws, ".voidrift", "cache", "snapshots", SID);
}
function plant(rel: string, content: string): void {
  const abs = path.join(snapshotsDir(), rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
function sha256(s: string): string {
  return createHash("sha256").update(Buffer.from(s)).digest("hex");
}

/** Plant the exact proven PoC: a manifest claiming a modified `victim.txt` whose
 * before-blob is sha256("PWNED") and a blob file of that name holding "PWNED". */
function plantPoC(opts: { hmac?: string } = {}): Move {
  const blobSha = sha256("PWNED");
  plant(`blobs/${blobSha}`, "PWNED");
  const manifest: Record<string, unknown> = {
    id: 1,
    turn: 1,
    method: "cache",
    paths: [{ path: "victim.txt", kind: "modified", restorable: true, before: blobSha, after: blobSha }],
  };
  if (opts.hmac !== undefined) manifest.hmac = opts.hmac;
  plant("moves/1.json", JSON.stringify(manifest));
  plant(
    "timeline.json",
    JSON.stringify({ version: 2, moves: [{ id: 1, sessionId: SID, turn: 1, time: "t", summary: "s", conversation: { beforeCheckpointId: null, afterCheckpointId: "cp-1" }, files: { method: "cache", paths: manifest.paths, notUndoable: [] } }], pointer: 1, ...(opts.hmac !== undefined ? { hmac: opts.hmac } : {}) }),
  );
  return {
    id: 1,
    sessionId: SID,
    turn: 1,
    time: "t",
    summary: "s",
    conversation: { beforeCheckpointId: null, afterCheckpointId: "cp-1" },
    files: { method: "cache", paths: [{ path: "victim.txt", kind: "modified", restorable: true }], notUndoable: [] },
  };
}

describe("§10.12 planted snapshot — integrity binding", () => {
  it("the exact proven PoC (planted manifest + blob) restores NOTHING", async () => {
    const move = plantPoC(); // no hmac at all
    writeFileSync(path.join(ws, "victim.txt"), "original");
    const store = new CacheSnapshotStore({ workspaceRoot: ws, globalConfigDir: cfg });
    // A planted manifest with no/invalid hmac is untrusted: readManifest → null.
    const r = await store.restore(move, "undo", { overwrite: new Set() });
    expect(r.restored).toEqual([]);
    expect(readFileSync(path.join(ws, "victim.txt"), "utf8")).toBe("original");
    // And the timeline is ignored (history starts empty).
    expect(await store.loadTimeline(SID)).toBeNull();
  });

  it("emits ONE value-free warning when planted state is found", async () => {
    plantPoC();
    const warned: string[] = [];
    const store = new CacheSnapshotStore({ workspaceRoot: ws, globalConfigDir: cfg, onUntrusted: (s) => warned.push(s) });
    await store.loadTimeline(SID);
    await store.loadTimeline(SID); // a second read must not warn twice
    expect(warned).toEqual([SID]);
  });

  it("a tampered manifest field invalidates the HMAC", async () => {
    // Record a legitimate move, then tamper the on-disk manifest.
    writeFileSync(path.join(ws, "a.txt"), "v1");
    const store = new CacheSnapshotStore({ workspaceRoot: ws, globalConfigDir: cfg });
    await store.beginTurn({ sessionId: SID, moveId: 1, turn: 1 });
    await store.noteWrite({ sessionId: SID, target: "a.txt", beforeBytes: Buffer.from("v1") });
    writeFileSync(path.join(ws, "a.txt"), "v2");
    const draft = await store.commitTurn({ sessionId: SID, moveId: 1, turn: 1 });
    const move: Move = { id: 1, sessionId: SID, turn: 1, time: "t", summary: "s", conversation: { beforeCheckpointId: null, afterCheckpointId: "cp-1" }, files: { method: "cache", paths: draft!.paths, notUndoable: [] } };
    // Tamper: flip the recorded path but keep the (now stale) hmac.
    const mp = path.join(snapshotsDir(), "moves", "1.json");
    const m = JSON.parse(readFileSync(mp, "utf8"));
    m.paths[0].path = "evil.txt";
    writeFileSync(mp, JSON.stringify(m));
    const r = await store.restore(move, "undo", { overwrite: new Set() });
    expect(r.restored).toEqual([]);
    expect(existsSync(path.join(ws, "evil.txt"))).toBe(false);
  });

  it("an HMAC computed from ANOTHER key is rejected", async () => {
    const foreignKey = randomBytes(32);
    const blobSha = sha256("PWNED");
    plant(`blobs/${blobSha}`, "PWNED");
    const rest = { id: 1, turn: 1, method: "cache", paths: [{ path: "victim.txt", kind: "modified", restorable: true, before: blobSha, after: blobSha }] };
    const bound = `${canonicalJson(rest)}\n${SID}\n${realpathSync(ws)}`;
    const hmac = createHmac("sha256", foreignKey).update(bound, "utf8").digest("hex");
    plant("moves/1.json", JSON.stringify({ ...rest, hmac }));
    writeFileSync(path.join(ws, "victim.txt"), "original");
    const store = new CacheSnapshotStore({ workspaceRoot: ws, globalConfigDir: cfg });
    const move: Move = { id: 1, sessionId: SID, turn: 1, time: "t", summary: "s", conversation: { beforeCheckpointId: null, afterCheckpointId: "cp-1" }, files: { method: "cache", paths: [{ path: "victim.txt", kind: "modified", restorable: true }], notUndoable: [] } };
    const r = await store.restore(move, "undo", { overwrite: new Set() });
    expect(r.restored).toEqual([]);
    expect(readFileSync(path.join(ws, "victim.txt"), "utf8")).toBe("original");
  });

  it("a timeline copied from ANOTHER workspace path is rejected", async () => {
    // Sign a timeline bound to a DIFFERENT workspace, then plant it here.
    const otherWs = await fs.mkdtemp(path.join(os.tmpdir(), "vr-otherws-"));
    try {
      const otherStore = new CacheSnapshotStore({ workspaceRoot: otherWs, globalConfigDir: cfg });
      await otherStore.persistTimeline(SID, { version: 2, moves: [], pointer: 0 });
      const otherTl = readFileSync(path.join(otherWs, ".voidrift", "cache", "snapshots", SID, "timeline.json"), "utf8");
      plant("timeline.json", otherTl); // copy it into THIS workspace
      const store = new CacheSnapshotStore({ workspaceRoot: ws, globalConfigDir: cfg });
      expect(await store.loadTimeline(SID)).toBeNull();
    } finally {
      await fs.rm(otherWs, { recursive: true, force: true });
    }
  });

  it("a blob with WRONG content under a valid-looking name fails its re-hash", async () => {
    // Record a real move, then overwrite the blob file content (keeping its name).
    writeFileSync(path.join(ws, "a.txt"), "v1");
    const store = new CacheSnapshotStore({ workspaceRoot: ws, globalConfigDir: cfg });
    await store.beginTurn({ sessionId: SID, moveId: 1, turn: 1 });
    await store.noteWrite({ sessionId: SID, target: "a.txt", beforeBytes: Buffer.from("v1") });
    writeFileSync(path.join(ws, "a.txt"), "v2");
    const draft = await store.commitTurn({ sessionId: SID, moveId: 1, turn: 1 });
    const move: Move = { id: 1, sessionId: SID, turn: 1, time: "t", summary: "s", conversation: { beforeCheckpointId: null, afterCheckpointId: "cp-1" }, files: { method: "cache", paths: draft!.paths, notUndoable: [] } };
    // Corrupt the before-blob's content in place.
    const beforeSha = sha256("v1");
    writeFileSync(path.join(snapshotsDir(), "blobs", beforeSha), "TAMPERED");
    const r = await store.restore(move, "undo", { overwrite: new Set() });
    expect(r.restored).toEqual([]);
    expect(r.skipped).toContainEqual({ path: "a.txt", reason: "snapshot content failed its integrity check" });
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("v2");
  });

  it("the happy path resumes across a simulated process restart with the persisted key", async () => {
    writeFileSync(path.join(ws, "a.txt"), "v1");
    const s1 = new CacheSnapshotStore({ workspaceRoot: ws, globalConfigDir: cfg });
    await s1.beginTurn({ sessionId: SID, moveId: 1, turn: 1 });
    await s1.noteWrite({ sessionId: SID, target: "a.txt", beforeBytes: Buffer.from("v1") });
    writeFileSync(path.join(ws, "a.txt"), "v2");
    const draft = await s1.commitTurn({ sessionId: SID, moveId: 1, turn: 1 });
    await s1.persistTimeline(SID, { version: 2, moves: [{ id: 1, sessionId: SID, turn: 1, time: "t", summary: "s", conversation: { beforeCheckpointId: null, afterCheckpointId: "cp-1" }, files: { method: "cache", paths: draft!.paths, notUndoable: [] } }], pointer: 1 });
    // A FRESH store (new process) reading the SAME persisted key trusts it.
    const s2 = new CacheSnapshotStore({ workspaceRoot: ws, globalConfigDir: cfg });
    const tl = await s2.loadTimeline(SID);
    expect(tl).not.toBeNull();
    expect(tl!.moves).toHaveLength(1);
    const move: Move = { id: 1, sessionId: SID, turn: 1, time: "t", summary: "s", conversation: { beforeCheckpointId: null, afterCheckpointId: "cp-1" }, files: { method: "cache", paths: draft!.paths, notUndoable: [] } };
    const r = await s2.restore(move, "undo", { overwrite: new Set() });
    expect(r.restored).toEqual(["a.txt"]);
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("v1");
  });

  it("a crash-safe delete leaves the original tree unchanged on a mid-apply failure", async () => {
    // Capture a move that CREATES `a.txt` and `sub/b.txt`; undo deletes both.
    const store = new CacheSnapshotStore({ workspaceRoot: ws, globalConfigDir: cfg });
    await store.beginTurn({ sessionId: SID, moveId: 1, turn: 1 });
    await store.noteWrite({ sessionId: SID, target: "a.txt", beforeBytes: null });
    await store.noteWrite({ sessionId: SID, target: "sub/b.txt", beforeBytes: null });
    writeFileSync(path.join(ws, "a.txt"), "A");
    mkdirSync(path.join(ws, "sub"), { recursive: true });
    writeFileSync(path.join(ws, "sub", "b.txt"), "B");
    const draft = await store.commitTurn({ sessionId: SID, moveId: 1, turn: 1 });
    const move: Move = { id: 1, sessionId: SID, turn: 1, time: "t", summary: "s", conversation: { beforeCheckpointId: null, afterCheckpointId: "cp-1" }, files: { method: "cache", paths: draft!.paths, notUndoable: [] } };
    const { chmodSync } = await import("node:fs");
    chmodSync(path.join(ws, "sub"), 0o555); // read-only → the 2nd delete fails
    try {
      await expect(store.restore(move, "undo", { overwrite: new Set() })).rejects.toThrow();
    } finally {
      chmodSync(path.join(ws, "sub"), 0o755);
    }
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("A");
    expect(readFileSync(path.join(ws, "sub", "b.txt"), "utf8")).toBe("B");
  });

  it("the key file is created mode 0600", async () => {
    const store = new CacheSnapshotStore({ workspaceRoot: ws, globalConfigDir: cfg });
    await store.persistTimeline(SID, { version: 2, moves: [], pointer: 0 });
    const kp = path.join(cfg, ROLLBACK_KEY_FILE);
    expect(existsSync(kp)).toBe(true);
    expect(statSync(kp).mode & 0o777).toBe(0o600);
    expect(store.keyState()).toBe("persisted");
  });

  it("an unwritable/absent global dir degrades to an in-memory key (resume starts empty)", async () => {
    // globalConfigDir null forces the per-process in-memory key.
    const s1 = new CacheSnapshotStore({ workspaceRoot: ws, globalConfigDir: null });
    expect(s1.keyState()).toBe("in-memory");
    await s1.persistTimeline(SID, { version: 2, moves: [{ id: 1, sessionId: SID, turn: 1, time: "t", summary: "s", conversation: { beforeCheckpointId: null, afterCheckpointId: "cp-1" }, files: { method: "cache", paths: [], notUndoable: [] } }], pointer: 1 });
    // A DIFFERENT process (new store) gets a DIFFERENT in-memory key is NOT
    // guaranteed here (the key is a static shared across instances in-process),
    // so the cross-restart guarantee is expressed via a foreign key: a timeline
    // signed with one in-memory key is NOT trusted by a store whose key differs.
    // Simulate by signing with an explicit foreign key and planting it.
    const foreignKey = randomBytes(32);
    const rest = { moves: [], pointer: 0 };
    const bound = `${canonicalJson(rest)}\n${SID}\n${realpathSync(ws)}`;
    const hmac = createHmac("sha256", foreignKey).update(bound, "utf8").digest("hex");
    plant("timeline.json", JSON.stringify({ ...rest, hmac }));
    const s2 = new CacheSnapshotStore({ workspaceRoot: ws, globalConfigDir: null });
    expect(await s2.loadTimeline(SID)).toBeNull();
  });
});
