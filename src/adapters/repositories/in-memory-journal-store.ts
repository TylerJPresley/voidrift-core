/**
 * In-memory mutation journal store (core-blueprint.md §10.11, §15.3).
 *
 * A deterministic `JournalStore` for unit and integration tests — no disk, no
 * fsync, no modes. It mirrors the fs adapter's SEMANTICS: content-addressed
 * write-once blobs, per-session append-only entries, monotonically increasing
 * sequence, and the same retention policy (`planBlobRetention`). Tests assert on
 * stored entries and blobs rather than the filesystem.
 */
import type { JournalStore } from "../../entities/ports/journal-store.js";
import {
  type JournalEntry,
  blobHash,
  isBlobSha,
  planBlobRetention,
  JOURNAL_LIMITS,
} from "../../entities/journal.js";

interface SessionState {
  entries: JournalEntry[];
  blobs: Map<string, Buffer>;
  /** Blob shas in first-seen (append) order, for oldest-first eviction. */
  blobOrder: string[];
  seq: number;
}

export class InMemoryJournalStore implements JournalStore {
  private readonly sessions = new Map<string, SessionState>();

  /** Optional limits accessor (§13.11) for `journal.maxBlobBytes` (JRNL3) /
   * `journal.maxEntries` (JRNL5); absent → the entity defaults. */
  constructor(private readonly getLimit?: (key: string) => number) {}

  private state(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { entries: [], blobs: new Map(), blobOrder: [], seq: 0 };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  async putBlob(sessionId: string, content: Buffer): Promise<string> {
    const sha = blobHash(content);
    const s = this.state(sessionId);
    if (!s.blobs.has(sha)) {
      s.blobs.set(sha, Buffer.from(content));
      s.blobOrder.push(sha);
    }
    return sha;
  }

  async getBlob(sessionId: string, sha: string): Promise<Buffer | null> {
    // Parity with the fs store (§10.11 / LOW-1): reject a sha that is not
    // EXACTLY 64 lowercase hex chars before any lookup.
    if (!isBlobSha(sha)) throw new Error("invalid blob sha");
    return this.state(sessionId).blobs.get(sha) ?? null;
  }

  async append(sessionId: string, entry: JournalEntry): Promise<void> {
    const s = this.state(sessionId);
    s.entries.push({ ...entry });
    if (entry.seq > s.seq) s.seq = entry.seq;
  }

  async nextSeq(sessionId: string): Promise<number> {
    return this.state(sessionId).seq + 1;
  }

  async list(sessionId: string, opts?: { limit?: number; afterSeq?: number }): Promise<JournalEntry[]> {
    const s = this.state(sessionId);
    let out = s.entries.filter((e) => (opts?.afterSeq === undefined ? true : e.seq > opts.afterSeq));
    out = out.sort((a, b) => a.seq - b.seq);
    if (opts?.limit !== undefined) out = out.slice(0, opts.limit);
    // Return copies so a caller never mutates stored state.
    return out.map((e) => ({ ...e }));
  }

  async enforceRetention(
    sessionId: string,
    pinnedShas?: ReadonlySet<string>,
  ): Promise<{ evictedShas: string[]; blobsEvictedSeqs: number[] }> {
    const s = this.state(sessionId);
    // Build live references: sha → entry seqs that reference it.
    const refs = new Map<string, Set<number>>();
    for (const e of s.entries) {
      for (const sha of [e.blobs?.before, e.blobs?.after]) {
        if (!sha) continue;
        (refs.get(sha) ?? refs.set(sha, new Set()).get(sha)!).add(e.seq);
      }
    }
    const blobs = s.blobOrder
      .filter((sha) => s.blobs.has(sha))
      .map((sha) => ({ sha, bytes: s.blobs.get(sha)!.length }));
    const plan = planBlobRetention(
      { blobs, refs, ...(pinnedShas ? { pinned: pinnedShas } : {}) },
      this.getLimit?.("journal.maxBlobBytes") ?? JOURNAL_LIMITS.maxBlobBytes,
    );
    for (const sha of plan.evictShas) {
      s.blobs.delete(sha);
      s.blobOrder = s.blobOrder.filter((x) => x !== sha);
    }
    for (const e of s.entries) {
      if (plan.evictedEntrySeqs.has(e.seq)) e.blobsEvicted = true;
    }
    // §13.11 (JRNL5) — the entry-count cap is sourced from the registry; today's
    // behaviour is a no-op on entries (never deleted for the count cap, §10.11).
    void (this.getLimit?.("journal.maxEntries") ?? JOURNAL_LIMITS.maxEntries);
    return { evictedShas: plan.evictShas, blobsEvictedSeqs: [...plan.evictedEntrySeqs] };
  }
}
