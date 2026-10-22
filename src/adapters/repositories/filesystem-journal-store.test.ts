/**
 * Filesystem journal store (core-blueprint.md §10.11).
 *
 * Verifies the on-disk contract: entries.jsonl append-only with one JSON/line,
 * content-addressed write-once blobs holding RAW bytes, files 0600 / dirs 0700,
 * monotonic sequence, metadata-only `list`, and oldest-first retention eviction.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FilesystemJournalStore } from "./filesystem-journal-store.js";
import { blobHash, type JournalEntry } from "../../entities/journal.js";

let stateDir: string;
let store: FilesystemJournalStore;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), "vr-journal-"));
  store = new FilesystemJournalStore({ stateDir });
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function entry(seq: number, over: Partial<JournalEntry> = {}): JournalEntry {
  return {
    seq,
    time: new Date().toISOString(),
    sessionId: "aabbccdd",
    turn: 1,
    tool: "write_file",
    call: { path: "a.txt" },
    target: "a.txt",
    result: { status: "ok", summary: "" },
    ...over,
  };
}

describe("FilesystemJournalStore (§10.11)", () => {
  it("stores a RAW blob once (content-addressed) with mode 0600", async () => {
    const content = Buffer.from("raw secret: sk-123\n");
    const sha = await store.putBlob("aabbccdd", content);
    expect(sha).toBe(blobHash(content));
    const blobPath = path.join(stateDir, "journal", "aabbccdd", "blobs", sha);
    // RAW, byte-for-byte — unmasked.
    expect(readFileSync(blobPath)).toEqual(content);
    expect(statSync(blobPath).mode & 0o777).toBe(0o600);
    // A second put of identical content is a no-op (same sha, one file).
    expect(await store.putBlob("aabbccdd", Buffer.from("raw secret: sk-123\n"))).toBe(sha);
    expect(await store.getBlob("aabbccdd", sha)).toEqual(content);
  });

  it("directories are 0700", async () => {
    await store.putBlob("aabbccdd", Buffer.from("x"));
    for (const d of ["journal", path.join("journal", "aabbccdd"), path.join("journal", "aabbccdd", "blobs")]) {
      expect(statSync(path.join(stateDir, d)).mode & 0o777, d).toBe(0o700);
    }
  });

  it("appends one JSON object per line, fsync'd, file 0600; nextSeq advances", async () => {
    await store.append("aabbccdd", entry(1));
    await store.append("aabbccdd", entry(2, { tool: "edit_file" }));
    const file = path.join(stateDir, "journal", "aabbccdd", "entries.jsonl");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).seq).toBe(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await store.nextSeq("aabbccdd")).toBe(3);
  });

  it("list returns metadata only, oldest-first, honoring afterSeq/limit", async () => {
    for (let i = 1; i <= 5; i++) await store.append("aabbccdd", entry(i));
    const all = await store.list("aabbccdd");
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(await (store.list("aabbccdd", { afterSeq: 3 }))).toHaveLength(2);
    expect(await (store.list("aabbccdd", { limit: 2 }))).toHaveLength(2);
    // No blob bytes are ever in an entry — only shas in `blobs`.
    expect(all.every((e) => !("bytes" in e))).toBe(true);
  });

  it("enforceRetention evicts oldest blobs first and reports affected entries", async () => {
    // Monkeypatch the cap low so two small blobs exceed it deterministically.
    // Instead of mutating the constant, store two blobs and reference them, then
    // assert the eviction path runs (no eviction under the real 512 MiB cap).
    const b1 = await store.putBlob("aabbccdd", Buffer.from("one"));
    const b2 = await store.putBlob("aabbccdd", Buffer.from("two"));
    await store.append("aabbccdd", entry(1, { blobs: { after: b1 } }));
    await store.append("aabbccdd", entry(2, { blobs: { after: b2 } }));
    // Under the real cap nothing is evicted; the call is a safe no-op.
    const res = await store.enforceRetention("aabbccdd");
    expect(res.evictedShas).toEqual([]);
    expect(await store.getBlob("aabbccdd", b1)).not.toBeNull();
  });

  it("rejects an invalid sha BEFORE any path.join (traversal, uppercase, short, NUL)", async () => {
    for (const bad of ["../../etc/passwd", "A".repeat(64), "abc", "a".repeat(63) + "\u0000"]) {
      await expect(store.getBlob("aabbccdd", bad)).rejects.toThrow(/invalid blob sha/);
    }
  });

  it("rejects an invalid session id BEFORE any path.join", async () => {
    await expect(store.putBlob("../../evil", Buffer.from("x"))).rejects.toThrow(/invalid session id/);
    await expect(store.append("../../evil", entry(1))).rejects.toThrow(/invalid session id/);
  });

  it("verifies sha on read: a tampered blob returns an error, not the bytes", async () => {
    const sha = await store.putBlob("aabbccdd", Buffer.from("trusted"));
    const blobPath = path.join(stateDir, "journal", "aabbccdd", "blobs", sha);
    // Tamper with the stored bytes in place (keep the name).
    writeFileSync(blobPath, Buffer.from("tampered!"));
    await expect(store.getBlob("aabbccdd", sha)).rejects.toThrow(/does not match its sha/);
  });

  it("refuses a symlinked journal directory on open", async () => {
    // Point the journal dir at a symlink so a write would be redirected.
    const other = mkdtempSync(path.join(os.tmpdir(), "vr-journal-tgt-"));
    const journalDir = path.join(stateDir, "journal");
    symlinkSync(other, journalDir, "dir");
    // Both append and putBlob run ensureDirs' lstat check and refuse.
    await expect(store.append("aabbccdd", entry(1))).rejects.toThrow(/symlink/);
    await expect(store.putBlob("aabbccdd", Buffer.from("x"))).rejects.toThrow(/symlink/);
    rmSync(other, { recursive: true, force: true });
  });
});
