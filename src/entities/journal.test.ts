/**
 * Mutation journal — entity + recorder unit tests (core-blueprint.md §10.11).
 *
 * Covers: content-addressing dedupe, the per-target truncation cap, retention
 * eviction (oldest-first, blobsEvicted), level semantics (off/action/turn incl.
 * the binary/over-cap fall back to turn granularity), the entry builder, and the
 * recorder's fail-closed append. Pure/in-memory — no disk.
 */
import { describe, it, expect } from "vitest";
import {
  JOURNAL_LIMITS,
  blobHash,
  isBinaryContent,
  captureBlob,
  captureGranularity,
  redactContentFields,
  planBlobRetention,
} from "./journal.js";
import { InMemoryJournalStore } from "../adapters/repositories/in-memory-journal-store.js";
import { JournalRecorder } from "../use-cases/journal-recorder.js";

describe("journal entity — content-addressing and capture (§10.11)", () => {
  it("blobHash is stable and identical content dedupes to one stored blob", async () => {
    const store = new InMemoryJournalStore();
    const a = Buffer.from("hello world");
    const sha1 = await store.putBlob("s1", a);
    const sha2 = await store.putBlob("s1", Buffer.from("hello world"));
    expect(sha1).toBe(sha2);
    expect(sha1).toBe(blobHash(a));
    // A different session is a separate store; same content, same sha.
    expect(await store.putBlob("s2", a)).toBe(sha1);
  });

  it("captureBlob clips over-cap content to the first 1 MiB and marks truncated", () => {
    const over = Buffer.alloc(JOURNAL_LIMITS.perTargetContentBytes + 10, 0x41);
    const cap = captureBlob(over);
    expect(cap.truncated).toBe(true);
    expect(cap.bytes.length).toBe(JOURNAL_LIMITS.perTargetContentBytes);
    expect(cap.sha).toBe(blobHash(over.subarray(0, JOURNAL_LIMITS.perTargetContentBytes)));

    const under = Buffer.from("small");
    expect(captureBlob(under).truncated).toBe(false);
  });

  it("isBinaryContent detects a NUL in the first 8 KiB", () => {
    expect(isBinaryContent(Buffer.from("plain text"))).toBe(false);
    expect(isBinaryContent(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
    // A NUL past the sniff window is NOT counted as binary.
    const late = Buffer.concat([Buffer.alloc(JOURNAL_LIMITS.binarySniffBytes, 0x41), Buffer.from([0x00])]);
    expect(isBinaryContent(late)).toBe(false);
  });

  it("captureGranularity: off→none, turn→turn, action→action, binary/over-cap→turn", () => {
    const text = Buffer.from("abc");
    const binary = Buffer.from([0x00]);
    const over = Buffer.alloc(JOURNAL_LIMITS.perTargetContentBytes + 1);
    expect(captureGranularity("off", text)).toBe("none");
    expect(captureGranularity("turn", text)).toBe("turn");
    expect(captureGranularity("action", text)).toBe("action");
    expect(captureGranularity("action", binary)).toBe("turn");
    expect(captureGranularity("action", over)).toBe("turn");
  });

  it("redactContentFields replaces content with {bytes,sha256} and leaves others", () => {
    const red = redactContentFields({ path: "f.txt", content: "data", mode: 1 }, ["content"]);
    expect(red["path"]).toBe("f.txt");
    expect(red["mode"]).toBe(1);
    expect(red["content"]).toEqual({ bytes: 4, sha256: blobHash(Buffer.from("data")) });
  });

  it("planBlobRetention evicts oldest first until within the byte cap", () => {
    const big = JOURNAL_LIMITS.maxBlobBytes; // make two blobs each = cap → one over
    const plan = planBlobRetention({
      blobs: [
        { sha: "old", bytes: big },
        { sha: "new", bytes: 10 },
      ],
      refs: new Map([["old", new Set([1])]]),
    });
    expect(plan.evictShas).toEqual(["old"]);
    expect([...plan.evictedEntrySeqs]).toEqual([1]);
  });

  // §13.11 (wave 3c convert) — the three journal caps are now threaded as a
  // parameter so a use-case/adapter can pass the effective registry value; the
  // JOURNAL_LIMITS table is the default (byte-identical when the arg is absent).
  it("captureBlob honors an explicit perTargetContentBytes (JRNL2 convert)", () => {
    const buf = Buffer.alloc(100, 0x41);
    const cap = captureBlob(buf, 10); // tighter than the default
    expect(cap.truncated).toBe(true);
    expect(cap.bytes.length).toBe(10);
    // A larger explicit cap keeps it whole.
    expect(captureBlob(buf, 1000).truncated).toBe(false);
  });
  it("captureGranularity honors an explicit perTargetContentBytes (JRNL2 convert)", () => {
    const buf = Buffer.alloc(100, 0x41); // text, 100 bytes
    // At the default this is `action`; with a 10-byte cap it is over-cap → turn.
    expect(captureGranularity("action", buf, 1000)).toBe("action");
    expect(captureGranularity("action", buf, 10)).toBe("turn");
  });
  it("planBlobRetention honors an explicit maxBlobBytes (JRNL3 convert)", () => {
    // Under the default both fit; a tight 15-byte cap evicts the oldest.
    const input = {
      blobs: [
        { sha: "old", bytes: 10 },
        { sha: "new", bytes: 10 },
      ],
      refs: new Map<string, Set<number>>([["old", new Set([1])]]),
    };
    expect(planBlobRetention(input, 100).evictShas).toEqual([]);
    expect(planBlobRetention(input, 15).evictShas).toEqual(["old"]);
  });
});

describe("JournalRecorder — level semantics and the entry builder (§10.11)", () => {
  const base = {
    sessionId: "s1",
    turn: 2,
    tool: "write_file",
    args: { path: "a.txt", content: "new content" },
    target: "a.txt",
    result: { status: "ok" as const, summary: "wrote" },
  };

  it("at `off`: metadata only, no blobs, content redacted from call", async () => {
    const store = new InMemoryJournalStore();
    const rec = new JournalRecorder({ store, getLevel: () => "off" });
    const entry = await rec.record({ ...base, after: Buffer.from("new content"), beforeMissing: true });
    expect(entry.blobs).toBeUndefined();
    expect(entry.tool).toBe("write_file");
    expect(entry.turn).toBe(2);
    expect(entry.call["content"]).toEqual({ bytes: 11, sha256: blobHash(Buffer.from("new content")) });
    expect(entry.undoHint).toBe("file did not exist");
    expect((await store.list("s1")).length).toBe(1);
  });

  it("at `action`: before+after blobs captured and stored, in order", async () => {
    const store = new InMemoryJournalStore();
    const rec = new JournalRecorder({ store, getLevel: () => "action" });
    const before = Buffer.from("old");
    const after = Buffer.from("new content");
    const entry = await rec.record({ ...base, before, after });
    expect(entry.blobs?.before).toBe(blobHash(before));
    expect(entry.blobs?.after).toBe(blobHash(after));
    expect(await store.getBlob("s1", entry.blobs!.before!)).toEqual(before);
    expect(await store.getBlob("s1", entry.blobs!.after!)).toEqual(after);
    expect(entry.undoHint).toContain(blobHash(before));
  });

  it("threads getLimit('journal.perTargetContentBytes') into capture (JRNL2 convert)", async () => {
    const store = new InMemoryJournalStore();
    const after = Buffer.alloc(50, 0x42);
    // A tiny effective cap (20 bytes): the 50-byte after is over-cap, so at
    // `action` it falls back to turn-net (proving captureGranularity read the
    // injected value — the 1 MiB default would have stored it per-action) and
    // the flush-time blob is clipped to the injected cap and marked truncated.
    const rec = new JournalRecorder({ store, getLevel: () => "action", getLimit: () => 20, readTargetAtFlush: async () => after });
    const entry = await rec.record({ ...base, after, beforeMissing: true });
    expect(entry.blobs).toBeUndefined(); // turn fallback → no per-action blob
    const [net] = await rec.flushTurn("s1", 2);
    expect(net!.truncated).toBe(true);
    const stored = await store.getBlob("s1", net!.blobs!.after!);
    expect(stored!.length).toBe(20);
  });

  it("at `action` a binary after-state falls back to turn-net (no per-action blobs; net on flush)", async () => {
    const store = new InMemoryJournalStore();
    const after = Buffer.from([0x00, 0x01, 0x02]);
    // The flush reads the actual file; return the binary content.
    const rec = new JournalRecorder({ store, getLevel: () => "action", readTargetAtFlush: async () => after });
    const entry = await rec.record({ ...base, after });
    // The per-action entry carries NO before/after blobs — binary → turn fallback.
    expect(entry.blobs).toBeUndefined();
    // The turn-net entry at flush carries the net after blob.
    const [net] = await rec.flushTurn("s1", 2);
    expect(net!.tool).toBe("turn-net");
    expect(net!.blobs?.after).toBe(blobHash(after));
    expect(net!.actions).toBe(1);
  });

  it("at `action` an over-cap after-state falls back to turn-net; truncated + clipped on flush", async () => {
    const store = new InMemoryJournalStore();
    const after = Buffer.alloc(JOURNAL_LIMITS.perTargetContentBytes + 100, 0x42);
    const rec = new JournalRecorder({ store, getLevel: () => "action", readTargetAtFlush: async () => after });
    const entry = await rec.record({ ...base, after });
    expect(entry.blobs).toBeUndefined();
    expect(entry.truncated).toBeUndefined();
    const [net] = await rec.flushTurn("s1", 2);
    expect(net!.truncated).toBe(true);
    const stored = await store.getBlob("s1", net!.blobs!.after!);
    expect(stored!.length).toBe(JOURNAL_LIMITS.perTargetContentBytes);
  });

  it("a non-file tool (execute_command) records metadata only, no blobs", async () => {
    const store = new InMemoryJournalStore();
    const rec = new JournalRecorder({ store, getLevel: () => "action" });
    const entry = await rec.record({
      sessionId: "s1",
      turn: 1,
      tool: "execute_command",
      args: { command: "rm x" },
      target: "rm x",
      result: { status: "ok", summary: "" },
    });
    expect(entry.blobs).toBeUndefined();
    expect(entry.tool).toBe("execute_command");
  });

  it("a worker write carries the workerId", async () => {
    const store = new InMemoryJournalStore();
    const rec = new JournalRecorder({ store, getLevel: () => "off" });
    const entry = await rec.record({ ...base, workerId: "w7" });
    expect(entry.workerId).toBe("w7");
  });
});
