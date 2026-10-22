/**
 * The mutation journal store port (core-blueprint.md §10.11).
 *
 * Per session, append-only. The concrete fs adapter stores entries as JSONL at
 * `<stateDir>/journal/<sessionId>/entries.jsonl` (one JSON object per line,
 * fsync'd append) and content-addressed blobs at
 * `<stateDir>/journal/<sessionId>/blobs/<sha256-hex>` (written once).
 * Directories are mode 0700, files 0600. The journal is stored RAW (unmasked),
 * the same stance as `checkpoint.db` — a revert must restore real contents.
 *
 * FAIL CLOSED (§10.11): the decision point captures the before-state, executes
 * the write, then appends the single entry. If `append` throws, the caller
 * surfaces a loud error naming the target so the user knows the journal is
 * incomplete. A blob is written BEFORE the entry that references it so an entry
 * never dangles.
 *
 * This port is host-internal: nothing here crosses the facade as a model tool.
 */
import type { JournalEntry } from "../journal.js";

export interface JournalStore {
  /**
   * Write a RAW content blob once (content-addressed by its sha256-hex). A
   * second write of the same sha is a no-op. Returns the sha. Throws on an
   * unrecoverable I/O failure so the caller can fail closed.
   */
  putBlob(sessionId: string, content: Buffer): Promise<string>;

  /** Read a RAW blob by sha, or null when absent (evicted or never stored). */
  getBlob(sessionId: string, sha: string): Promise<Buffer | null>;

  /**
   * Append one entry to the session's journal (fsync'd). The store assigns the
   * caller-provided `seq` verbatim (the caller owns sequencing). Throws on an
   * unrecoverable append failure so the caller can fail closed.
   */
  append(sessionId: string, entry: JournalEntry): Promise<void>;

  /** The next sequence number for a session (max seen + 1, starting at 1). */
  nextSeq(sessionId: string): Promise<number>;

  /**
   * List a session's entries (metadata only, no blob bytes), oldest first,
   * optionally after a sequence and bounded by a limit (§10.11 read API).
   */
  list(sessionId: string, opts?: { limit?: number; afterSeq?: number }): Promise<JournalEntry[]>;

  /**
   * Enforce retention for a session (§10.11): evict oldest blobs first until
   * blob bytes are within `JOURNAL_LIMITS.maxBlobBytes`, mark affected entries
   * `blobsEvicted`, and when the entry count exceeds `maxEntries` note it. A
   * `journal-retention` metadata entry recording what was evicted is appended by
   * the caller. Returns the evicted blob shas and affected entry seqs.
   *
   * `pinnedShas` are blobs the LIVE turn aggregator still holds (a first-before
   * or pending-after) with no referencing `turn-net` entry yet; they are NEVER
   * evicted mid-turn so the flush can still reference them (§10.11).
   */
  enforceRetention(
    sessionId: string,
    pinnedShas?: ReadonlySet<string>,
  ): Promise<{ evictedShas: string[]; blobsEvictedSeqs: number[] }>;
}
