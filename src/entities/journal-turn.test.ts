/**
 * Mutation journal — TURN level and hardening unit tests (core-blueprint.md
 * §10.11). Covers the net-change-per-target turn flush, the first-before-blob
 * immediacy, the no-net-change note, worker aggregation, the seq-race mutex, and
 * the content-addressed store validators. Pure/in-memory — no disk.
 */
import { describe, it, expect } from "vitest";
import { JournalRecorder, type FlushReader } from "../use-cases/journal-recorder.js";
import { InMemoryJournalStore } from "../adapters/repositories/in-memory-journal-store.js";
import type { JournalStore } from "./ports/journal-store.js";
import { blobHash, isBlobSha, sanitizeJournalErrorMessage, JOURNAL_LIMITS, type JournalEntry } from "./journal.js";

/** A recorder at `turn` level over an in-memory store, with a flush reader
 * backed by a mutable file map (so we can simulate shell-made changes). */
function turnRecorder(files: Map<string, Buffer>) {
  const store = new InMemoryJournalStore();
  const reader: FlushReader = async (p) => files.get(p) ?? null;
  const rec = new JournalRecorder({ store, getLevel: () => "turn", readTargetAtFlush: reader });
  return { store, rec };
}

const base = {
  sessionId: "sess0001",
  turn: 4,
  tool: "write_file" as const,
  target: "a.txt",
};

describe("JournalRecorder — turn level net change (§10.11)", () => {
  it("created-then-deleted in the turn → one turn-net entry with 'no net change', no blobs", async () => {
    const files = new Map<string, Buffer>();
    const { rec } = turnRecorder(files);
    // create (before missing, after present)
    await rec.record({ ...base, args: { path: "a.txt", content: "hi" }, result: ok(), beforeMissing: true, after: Buffer.from("hi") });
    // delete (the file is gone at flush: not in `files`)
    await rec.record({ ...base, args: { path: "a.txt" }, tool: "execute_command", target: "a.txt", result: ok() });
    const nets = await rec.flushTurn("sess0001", 4);
    expect(nets.length).toBe(1);
    expect(nets[0]!.tool).toBe("turn-net");
    expect(nets[0]!.note).toBe("no net change");
    expect(nets[0]!.blobs).toBeUndefined();
  });

  it("edited 5 times → one entry with first-before + last-after and actions:5", async () => {
    const files = new Map<string, Buffer>();
    files.set("a.txt", Buffer.from("v5")); // final content at flush
    const { rec } = turnRecorder(files);
    for (let i = 1; i <= 5; i++) {
      await rec.record({
        ...base,
        args: { path: "a.txt", content: `v${i}` },
        result: ok(),
        ...(i === 1 ? { before: Buffer.from("v0") } : { before: Buffer.from(`v${i - 1}`) }),
        after: Buffer.from(`v${i}`),
      });
    }
    const [net] = await rec.flushTurn("sess0001", 4);
    expect(net!.actions).toBe(5);
    expect(net!.blobs?.before).toBe(blobHash(Buffer.from("v0"))); // FIRST before
    expect(net!.blobs?.after).toBe(blobHash(Buffer.from("v5"))); // LAST after (read at flush)
  });

  it("two targets → two turn-net entries", async () => {
    const files = new Map<string, Buffer>([
      ["a.txt", Buffer.from("A2")],
      ["b.txt", Buffer.from("B2")],
    ]);
    const { rec } = turnRecorder(files);
    await rec.record({ ...base, target: "a.txt", args: { path: "a.txt", content: "A2" }, result: ok(), before: Buffer.from("A1"), after: Buffer.from("A2") });
    await rec.record({ ...base, target: "b.txt", args: { path: "b.txt", content: "B2" }, result: ok(), before: Buffer.from("B1"), after: Buffer.from("B2") });
    const nets = await rec.flushTurn("sess0001", 4);
    expect(nets.map((n) => n.target).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("created in the turn → turn-net has no `before`", async () => {
    const files = new Map([["a.txt", Buffer.from("new")]]);
    const { rec } = turnRecorder(files);
    await rec.record({ ...base, args: { path: "a.txt", content: "new" }, result: ok(), beforeMissing: true, after: Buffer.from("new") });
    const [net] = await rec.flushTurn("sess0001", 4);
    expect(net!.blobs?.before).toBeUndefined();
    expect(net!.blobs?.after).toBe(blobHash(Buffer.from("new")));
  });

  it("deleted at turn end → turn-net has no `after`", async () => {
    const files = new Map<string, Buffer>(); // gone at flush
    const { rec } = turnRecorder(files);
    await rec.record({ ...base, args: { path: "a.txt", content: "x" }, result: ok(), before: Buffer.from("old"), after: Buffer.from("x") });
    const [net] = await rec.flushTurn("sess0001", 4);
    expect(net!.blobs?.before).toBe(blobHash(Buffer.from("old")));
    expect(net!.blobs?.after).toBeUndefined();
  });

  it("final content equals first → 'no net change'", async () => {
    const files = new Map([["a.txt", Buffer.from("same")]]);
    const { rec } = turnRecorder(files);
    await rec.record({ ...base, args: { path: "a.txt", content: "diff" }, result: ok(), before: Buffer.from("same"), after: Buffer.from("diff") });
    const [net] = await rec.flushTurn("sess0001", 4);
    expect(net!.note).toBe("no net change");
    expect(net!.blobs).toBeUndefined();
  });

  it("at `turn` level the PER-ACTION entry carries NO before/after blobs", async () => {
    const files = new Map([["a.txt", Buffer.from("x")]]);
    const { rec, store } = turnRecorder(files);
    await rec.record({ ...base, args: { path: "a.txt", content: "x" }, result: ok(), before: Buffer.from("old"), after: Buffer.from("x") });
    const perAction = (await store.list("sess0001")).find((e) => e.tool === "write_file");
    expect(perAction).toBeDefined();
    expect(perAction!.blobs).toBeUndefined();
  });

  it("at `action` level a text target writes NO turn-net entry (per-action blobs instead)", async () => {
    const store = new InMemoryJournalStore();
    const rec = new JournalRecorder({ store, getLevel: () => "action" });
    await rec.record({ ...base, args: { path: "a.txt", content: "x" }, result: ok(), before: Buffer.from("old"), after: Buffer.from("x") });
    const nets = await rec.flushTurn("sess0001", 4);
    expect(nets.length).toBe(0); // nothing aggregated at action level for a text target
  });

  it("the first-before blob is in the store IMMEDIATELY, before any flush (interrupted turn)", async () => {
    const files = new Map([["a.txt", Buffer.from("later")]]);
    const { rec, store } = turnRecorder(files);
    await rec.record({ ...base, args: { path: "a.txt", content: "new" }, result: ok(), before: Buffer.from("original"), after: Buffer.from("new") });
    // NO flush — simulate the process being killed. The before blob is revertible.
    const sha = blobHash(Buffer.from("original"));
    expect(await store.getBlob("sess0001", sha)).toEqual(Buffer.from("original"));
  });

  it("the flush reads the ACTUAL file (a shell-made change is captured, not the last tool args)", async () => {
    const files = new Map([["a.txt", Buffer.from("shell-rewrote-this")]]);
    const { rec } = turnRecorder(files);
    // write_file put "fromtool"; a later shell command rewrote the file.
    await rec.record({ ...base, args: { path: "a.txt", content: "fromtool" }, result: ok(), before: Buffer.from("old"), after: Buffer.from("fromtool") });
    const [net] = await rec.flushTurn("sess0001", 4);
    expect(net!.blobs?.after).toBe(blobHash(Buffer.from("shell-rewrote-this")));
  });

  it("worker writes aggregate per (workerId, target) and flush on the worker's run end", async () => {
    const files = new Map([["w.txt", Buffer.from("W2")]]);
    const { rec } = turnRecorder(files);
    await rec.record({ ...base, workerId: "f1-w1", target: "w.txt", args: { path: "w.txt", content: "W2" }, result: ok(), before: Buffer.from("W1"), after: Buffer.from("W2") });
    // Orchestrator flush (workerId undefined) does NOT flush the worker's target.
    const orchestrator = await rec.flushTurn("sess0001", 4, { workerId: undefined });
    expect(orchestrator.length).toBe(0);
    // The worker's own flush emits it with its workerId.
    const workerNets = await rec.flushTurn("sess0001", 4, { workerId: "f1-w1" });
    expect(workerNets.length).toBe(1);
    expect(workerNets[0]!.workerId).toBe("f1-w1");
    expect(workerNets[0]!.target).toBe("w.txt");
  });
});

describe("JournalRecorder — seq race (§10.11)", () => {
  it("50 parallel appends produce unique, monotonic seqs", async () => {
    const store = new InMemoryJournalStore();
    const rec = new JournalRecorder({ store, getLevel: () => "off" });
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        rec.record({ sessionId: "sess0001", turn: 1, tool: "execute_command", args: { command: `c${i}` }, target: `c${i}`, result: ok() }),
      ),
    );
    const seqs = (await store.list("sess0001")).map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs.length).toBe(50);
    expect(new Set(seqs).size).toBe(50); // all unique
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1)); // monotonic 1..50
  });
});

describe("journal store validators (§10.11 / LOW-1, LOW-2)", () => {
  it("isBlobSha accepts exactly 64 lowercase hex and rejects traversal/upper/short/NUL", () => {
    expect(isBlobSha("a".repeat(64))).toBe(true);
    expect(isBlobSha("../../etc/passwd")).toBe(false);
    expect(isBlobSha("A".repeat(64))).toBe(false); // uppercase
    expect(isBlobSha("abc")).toBe(false); // short
    expect(isBlobSha("a".repeat(63) + "\u0000")).toBe(false); // NUL
  });

  it("getBlob rejects an invalid sha before any lookup", async () => {
    const store = new InMemoryJournalStore();
    await expect(store.getBlob("sess0001", "../../etc/passwd")).rejects.toThrow(/invalid blob sha/);
  });

  it("sanitizeJournalErrorMessage drops an out-of-workspace path and caps length", () => {
    const msg = sanitizeJournalErrorMessage(new Error("EACCES: open '/etc/shadow' failed"), "/ws");
    expect(msg).not.toContain("/etc/shadow");
    expect(msg).toContain("<path>");
    // An in-workspace path is kept.
    const inside = sanitizeJournalErrorMessage(new Error("open /ws/a.txt failed"), "/ws");
    expect(inside).toContain("/ws/a.txt");
    // Capped at 200 chars.
    expect(sanitizeJournalErrorMessage(new Error("x".repeat(500))).length).toBe(200);
  });

  it("over-cap limit constant is 1 MiB (sanity for the DoS bound)", () => {
    expect(JOURNAL_LIMITS.perTargetContentBytes).toBe(1024 * 1024);
  });
});

describe("JournalRecorder — retention pins live-aggregator blobs (§10.11, G3-LOW-1)", () => {
  it("a tiny retention budget does NOT evict a first-before blob the live turn still holds", async () => {
    // Budget sized so that with BOTH blobs present (9 + 10 = 19 bytes) retention
    // must evict down to <= 10 bytes. The OLDEST blob is the first-before of
    // a.txt; without pinning it would be evicted mid-turn.
    const store = new TinyBudgetJournalStore(10);
    const rec = new JournalRecorder({ store, getLevel: () => "turn" });

    const firstBefore = Buffer.from("ORIGINAL!"); // 9 bytes, the OLDEST blob
    const firstSha = blobHash(firstBefore);
    await rec.record({
      ...base,
      args: { path: "a.txt", content: "new" },
      result: ok(),
      before: firstBefore,
      after: Buffer.from("new"),
    });

    // A SECOND target with its own first-before blob (10 bytes) drives another
    // append → retention runs mid-turn. Total 19 > 10 budget forces an eviction;
    // the oldest (a.txt's first-before) would go first WITHOUT pinning.
    await rec.record({
      ...base,
      target: "b.txt",
      args: { path: "b.txt", content: "B-new" },
      result: ok(),
      before: Buffer.from("BBBBBBBBBB"), // 10 bytes
      after: Buffer.from("B-new"),
    });

    // The pinned first-before blob SURVIVES until the turn-net entry references it.
    expect(await store.getBlob("sess0001", firstSha)).toEqual(firstBefore);

    // After flush the aggregator no longer pins it; the turn-net entry references it.
    const nets = await rec.flushTurn("sess0001", 4);
    const aNet = nets.find((n) => n.target === "a.txt");
    expect(aNet!.blobs?.before).toBe(firstSha);
  });
});

describe("JournalRecorder — turn-net target cap (§10.11, G3-LOW-2)", () => {
  it("2,050 targets → 2,000 turn-net entries + ONE turn-net-cap note for the 50 over the cap", async () => {
    const total = JOURNAL_LIMITS.turnNetMaxTargets + 50; // 2,050
    const files = new Map<string, Buffer>();
    for (let i = 0; i < total; i++) files.set(`t${i}.txt`, Buffer.from(`v${i}`));
    const { rec, store } = turnRecorder(files);
    for (let i = 0; i < total; i++) {
      await rec.record({
        ...base,
        target: `t${i}.txt`,
        args: { path: `t${i}.txt`, content: `v${i}` },
        result: ok(),
        beforeMissing: true,
        after: Buffer.from(`v${i}`),
      });
    }
    const nets = await rec.flushTurn("sess0001", 4);
    const turnNets = nets.filter((n) => n.tool === "turn-net");
    const caps = nets.filter((n) => n.tool === "turn-net-cap");
    expect(turnNets.length).toBe(JOURNAL_LIMITS.turnNetMaxTargets); // 2,000 netted
    expect(caps.length).toBe(1); // exactly ONE cap note
    expect(caps[0]!.call["cappedTargets"]).toBe(50);
    expect(caps[0]!.note).toBe("turn-net target cap exceeded");

    // Every over-cap target still has its per-action metadata entry in the store.
    const all = await store.list("sess0001");
    const overCapActions = all.filter((e) => e.tool === "write_file" && e.blobs === undefined);
    expect(overCapActions.length).toBe(total); // all 2,050 per-action metadata entries
  });
});

describe("JournalRecorder — restart mid-turn (§10.11, G3-LOW-3)", () => {
  it("a NEW recorder over the same store emits NO turn-net for the interrupted turn, but the first-before blob and per-action entries remain", async () => {
    const store = new InMemoryJournalStore();
    const rec1 = new JournalRecorder({ store, getLevel: () => "turn" });
    const firstBefore = Buffer.from("original-content");
    const firstSha = blobHash(firstBefore);
    // Write mid-turn, then simulate a process kill BEFORE any flush.
    await rec1.record({
      ...base,
      args: { path: "a.txt", content: "new" },
      result: ok(),
      before: firstBefore,
      after: Buffer.from("new"),
    });

    // RESTART: a brand-new recorder over the SAME store (in-memory aggregator is
    // lost; the store persists). Flushing the interrupted turn yields NO turn-net
    // because the aggregator state did not survive the restart.
    const rec2 = new JournalRecorder({ store, getLevel: () => "turn" });
    const nets = await rec2.flushTurn("sess0001", 4);
    expect(nets.length).toBe(0);

    // The durable evidence survives: the first-before blob is still revertible,
    // and the per-action metadata entry is still readable.
    expect(await store.getBlob("sess0001", firstSha)).toEqual(firstBefore);
    const entries = await store.list("sess0001");
    const perAction = entries.find((e) => e.tool === "write_file");
    expect(perAction).toBeDefined();
    expect(perAction!.target).toBe("a.txt");
    expect(entries.some((e) => e.tool === "turn-net")).toBe(false);
  });
});

/** A `JournalStore` wrapper with an injected tiny blob-byte budget so retention
 * would otherwise evict mid-turn (G3-LOW-1 regression). It delegates every op to
 * a real in-memory store and only overrides `enforceRetention`, re-implementing
 * oldest-first eviction against the tiny budget while honoring the `pinnedShas`
 * the recorder passes. */
class TinyBudgetJournalStore implements JournalStore {
  private readonly inner = new InMemoryJournalStore();
  private readonly order: string[] = [];
  private readonly live = new Set<string>();
  private readonly evicted = new Set<string>();
  constructor(private readonly budgetBytes: number) {}

  async putBlob(sessionId: string, content: Buffer): Promise<string> {
    const sha = await this.inner.putBlob(sessionId, content);
    if (!this.live.has(sha)) {
      this.order.push(sha);
      this.live.add(sha);
    }
    return sha;
  }
  async getBlob(sessionId: string, sha: string): Promise<Buffer | null> {
    if (this.evicted.has(sha)) return null; // model eviction: gone from the store
    return this.inner.getBlob(sessionId, sha);
  }
  append(sessionId: string, entry: JournalEntry): Promise<void> {
    return this.inner.append(sessionId, entry);
  }
  nextSeq(sessionId: string): Promise<number> {
    return this.inner.nextSeq(sessionId);
  }
  list(sessionId: string, opts?: { limit?: number; afterSeq?: number }): Promise<JournalEntry[]> {
    return this.inner.list(sessionId, opts);
  }

  async enforceRetention(
    sessionId: string,
    pinnedShas?: ReadonlySet<string>,
  ): Promise<{ evictedShas: string[]; blobsEvictedSeqs: number[]; entriesEvictedSeqs: number[] }> {
    const entries = await this.inner.list(sessionId);
    const refs = new Map<string, Set<number>>();
    for (const e of entries) {
      for (const sha of [e.blobs?.before, e.blobs?.after]) {
        if (!sha) continue;
        (refs.get(sha) ?? refs.set(sha, new Set()).get(sha)!).add(e.seq);
      }
    }
    let total = 0;
    const sizes = new Map<string, number>();
    for (const sha of this.order) {
      if (!this.live.has(sha)) continue;
      const b = await this.inner.getBlob(sessionId, sha);
      if (b) {
        sizes.set(sha, b.length);
        total += b.length;
      }
    }
    const evictedShas: string[] = [];
    const evictedSeqs = new Set<number>();
    for (const sha of this.order) {
      if (total <= this.budgetBytes) break;
      if (!this.live.has(sha)) continue;
      if (pinnedShas?.has(sha)) continue; // NEVER evict a pinned (live-aggregator) blob
      const size = sizes.get(sha);
      if (size === undefined) continue;
      // Drop the blob from the live set; a later getBlob reads through the inner
      // store, so we model eviction by forgetting it here (the recorder never
      // re-reads an evicted blob before flush).
      this.live.delete(sha);
      this.evicted.add(sha);
      evictedShas.push(sha);
      total -= size;
      for (const seq of refs.get(sha) ?? []) evictedSeqs.add(seq);
    }
    return { evictedShas, blobsEvictedSeqs: [...evictedSeqs], entriesEvictedSeqs: [] };
  }
}

function ok() {
  return { status: "ok" as const, summary: "" };
}
