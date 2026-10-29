/**
 * Journal entry-count retention (core-blueprint.md §10.11, §13.11 JRNL5).
 *
 * Proves the entry cap end-to-end over the REAL filesystem and in-memory stores
 * and the REAL recorder: below the cap the log is untouched; at the cap the
 * OLDEST entries are evicted and the NEWEST kept, a `journal-retention` entry is
 * appended naming the evicted entry seqs, and exactly ONE `LIMIT_HIT` names the
 * key per eviction event. The fs rewrite is atomic (temp + rename) and FAILS
 * CLOSED: when the rewrite cannot complete, the original log is left intact and
 * the error surfaces.
 */
import { describe, it, expect, afterEach } from "vitest";
import { rmSync, readFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { hermeticTmp } from "../test-hermetic.js";
import { FilesystemJournalStore } from "../adapters/repositories/filesystem-journal-store.js";
import { InMemoryJournalStore } from "../adapters/repositories/in-memory-journal-store.js";
import { JournalRecorder } from "./journal-recorder.js";
import type { JournalStore } from "../entities/ports/journal-store.js";
import { type JournalEntry } from "../entities/journal.js";

const SESSION = "aabbccdd";
const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) {
    try {
      chmodSync(path.join(d, "journal", SESSION), 0o700);
    } catch {
      /* best-effort re-open for cleanup */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

function stateDir(): string {
  const d = hermeticTmp("jrnl-ret");
  cleanups.push(d);
  return d;
}

/** A recorder over a store with a fixed entry cap and a captured hit list. */
function recorderOver(
  store: JournalStore,
  maxEntries: number,
): { rec: JournalRecorder; hits: { key: string; observed: number }[] } {
  const hits: { key: string; observed: number }[] = [];
  const rec = new JournalRecorder({
    store,
    getLevel: () => "off", // metadata-only: each record appends exactly one entry
    getLimit: (key) => (key === "journal.maxEntries" ? maxEntries : 1024 * 1024),
    onLimitHit: (key, observed) => hits.push({ key, observed }),
  });
  return { rec, hits };
}

/** Record `n` plain (metadata-only) write actions in order. */
async function recordN(rec: JournalRecorder, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await rec.record({
      sessionId: SESSION,
      turn: 1,
      tool: "execute_command",
      args: { cmd: `touch f${i}` },
      target: `f${i}`,
      result: { status: "ok", summary: "" },
    });
  }
}

describe("journal entry retention — journal.maxEntries (§10.11, JRNL5)", () => {
  it("below the cap: the log is untouched and no LIMIT_HIT fires", async () => {
    const store = new FilesystemJournalStore({ stateDir: stateDir(), getLimit: () => 100 });
    const { rec, hits } = recorderOver(store, 100);
    await recordN(rec, 5);
    const all = await store.list(SESSION);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(all.some((e) => e.tool === "journal-retention")).toBe(false);
    expect(hits.length).toBe(0);
  });

  it("at the cap: evicts the oldest, keeps the newest, appends a retention entry, fires ONE hit (fs store)", async () => {
    // Cap of 3. After five writes the oldest (seq 1,2) are evicted; the newest
    // kept; a journal-retention entry names what was evicted.
    const store = new FilesystemJournalStore({ stateDir: stateDir(), getLimit: () => 3 });
    const { rec, hits } = recorderOver(store, 3);
    await recordN(rec, 5);
    const all = await store.list(SESSION);
    const seqs = all.map((e) => e.seq);
    // The two oldest original write entries are gone; the newest survive.
    expect(seqs).not.toContain(1);
    expect(seqs).not.toContain(2);
    expect(seqs).toContain(5);
    // A retention entry is present and names at least one evicted seq.
    const ret = all.filter((e) => e.tool === "journal-retention");
    expect(ret.length).toBeGreaterThanOrEqual(1);
    expect((ret[0]!.call as { evictedEntrySeqs?: number[] }).evictedEntrySeqs?.length).toBeGreaterThanOrEqual(1);
    // At least one LIMIT_HIT named the entry cap, and every hit is that key.
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.every((h) => h.key === "journal.maxEntries")).toBe(true);
  });

  it("in-memory store parity: evicts the oldest, keeps the newest, one hit", async () => {
    const store = new InMemoryJournalStore((key) => (key === "journal.maxEntries" ? 3 : 1024 * 1024));
    const { rec, hits } = recorderOver(store, 3);
    await recordN(rec, 5);
    const all = await store.list(SESSION);
    const seqs = all.map((e) => e.seq);
    expect(seqs).not.toContain(1);
    expect(seqs).not.toContain(2);
    expect(seqs).toContain(5);
    expect(all.some((e) => e.tool === "journal-retention")).toBe(true);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.every((h) => h.key === "journal.maxEntries")).toBe(true);
  });

  it("FAIL CLOSED: a failed atomic rewrite leaves the original log intact (fs store)", async () => {
    // Seed five entries directly (direct append bypasses eviction), then make the
    // session directory read-only so the atomic rewrite's temp open fails. The
    // error must surface and the original entries.jsonl must be byte-for-byte
    // intact — the same fail-closed contract as blob eviction.
    const dir = stateDir();
    const store = new FilesystemJournalStore({ stateDir: dir, getLimit: () => 3 });
    for (let i = 1; i <= 5; i++) {
      await store.append(SESSION, {
        seq: i,
        time: new Date().toISOString(),
        sessionId: SESSION,
        turn: 1,
        tool: "write_file",
        call: { path: `f${i}` },
        target: `f${i}`,
        result: { status: "ok", summary: "" },
      } satisfies JournalEntry);
    }
    const entriesFile = path.join(dir, "journal", SESSION, "entries.jsonl");
    const before = readFileSync(entriesFile, "utf8");
    const sessionDir = path.join(dir, "journal", SESSION);
    chmodSync(sessionDir, 0o500); // read + execute, NOT writable → temp open fails
    try {
      await expect(store.enforceRetention(SESSION)).rejects.toThrow();
    } finally {
      chmodSync(sessionDir, 0o700);
    }
    // The original log is byte-for-byte intact (fail closed).
    expect(readFileSync(entriesFile, "utf8")).toBe(before);
  });
});
