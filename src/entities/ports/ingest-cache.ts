/**
 * The ingest digest cache port (core-blueprint.md §8.7).
 *
 * The digest fan-out writes one line-anchored digest per (contentHash, purpose,
 * params) key; a second ingest of an unchanged source for the same purpose and
 * parameters is a cache HIT and dispatches no workers. The concrete fs adapter
 * stores each digest at `<workspaceRoot>/.voidrift/cache/ingest/<key>.json`,
 * owner-only (dir 0700, files 0600), atomic (unique temp + rename), with an
 * integrity hash INSIDE the file verified on read — a tampered or planted file
 * is ignored and DELETED. Total size is bounded by `limits.ingest.cacheMaxBytes`
 * with oldest-first eviction (a LIMIT_HIT fires when it evicts). The cache dir
 * is a PROTECTED control path for file-WRITE tools (§9.4): only the core writes
 * it, never a model file tool or the shell.
 *
 * `get`/`put` are synchronous (small JSON files, written on the core thread like
 * the other `.voidrift/cache` stores); `stats` reports the current size for
 * doctor and tests. This port is host-internal: nothing here is a model tool.
 */
import type { Digest } from "../ingest-digest.js";

/** Current cache occupancy (§8.7). */
export interface IngestCacheStats {
  /** Number of cached digests. */
  entries: number;
  /** Total bytes on disk (the sum of stored file sizes). */
  bytes: number;
}

export interface IngestCache {
  /**
   * Return the digest for `key`, or `null` on a miss. A file whose integrity
   * hash does not verify (tampered or planted) is treated as a miss AND deleted
   * — a corrupt entry never deserializes into a trusted digest.
   */
  get(key: string): Digest | null;

  /**
   * Store `digest` under its own `digestKey(...)`. Overwrites an existing entry
   * for the same key (idempotent). Enforces the byte cap by evicting the oldest
   * entries first; an eviction fires one `LIMIT_HIT` for `ingest.cacheMaxBytes`.
   */
  put(digest: Digest): void;

  /** The current occupancy. */
  stats(): IngestCacheStats;
}
