/**
 * The run cache port (core-blueprint.md §7.2 pass-by-reference, §8.7).
 *
 * A general, session-scoped store of text blobs the harness must keep whole when
 * an inline bound would otherwise clip them: an oversized task brief, a
 * dependency's result fed to a dependent, a worker's batch result returned to the
 * orchestrator (§7.2) — and, reused by a later area, oversized `web_fetch` pages
 * and command output (§8.2). Rather than cut the text mid-content, the harness
 * `store`s the full text and hands the receiver a SHORT bounded head plus a
 * workspace-relative HANDLE readable with `read_file`; nothing is dropped
 * silently (§7.2).
 *
 * The concrete fs adapter stores each blob at
 * `<workspaceRoot>/.voidrift/cache/run/<sessionId>/<id>.txt`, owner-only (dir
 * 0700, files 0600), written atomically (unique temp + rename), with a unique id
 * (content hash + a monotonic counter) so a handle is content-addressed and two
 * stores of different text never collide. The dir is a PROTECTED control path for
 * file-WRITE tools (§9.4 `isProtectedCacheTail` — `run` is NOT a writable cache
 * subtree): only the core writes it, never a model tool or the shell. But the
 * `.txt` blobs are READABLE by the model's `read_file` (it reads any
 * workspace-relative path through the backend), so the handle round-trips.
 *
 * Total size is bounded by `limits.run.cacheMaxBytes` with oldest-first eviction
 * (a `LIMIT_HIT` fires when it evicts); a single blob over `limits.run.entryMaxBytes`
 * is itself truncated to the cap before storage (a degenerate over-cap blob never
 * blows the store) and the returned `bytes`/`lines` reflect what was stored. Reads
 * NEVER follow a symlink out of the cache dir. The store is cleaned with its
 * session: `clearSession` removes one session's dir (called on `session.delete`),
 * and the per-session cap bounds it otherwise. This port is host-internal: nothing
 * here is a model tool.
 */

/** What a stored blob represents — a task brief, a dependency summary, or a
 * batch result (§7.2). Used for the id prefix and the BY_REFERENCE `what`. */
export type RunCacheKind = "brief" | "dep-summary" | "batch-result" | "web-fetch" | "command-output";

/** The result of a `store`: the workspace-relative handle a receiver reads with
 * `read_file`, and the stored size for the BY_REFERENCE event and the head
 * footer. */
export interface RunCacheHandle {
  /** The workspace-relative path to the blob, e.g.
   * `.voidrift/cache/run/<session>/<id>.txt`. Readable with `read_file`. */
  handle: string;
  /** The byte length of the stored text. */
  bytes: number;
  /** The line count of the stored text. */
  lines: number;
}

export interface RunCache {
  /**
   * Store `text` as a blob of `kind` and return its handle. The id is unique
   * (content hash + counter) so repeated stores never collide. A blob larger
   * than `limits.run.entryMaxBytes` is truncated to the cap before storage. A
   * store that pushes the session over `limits.run.cacheMaxBytes` evicts the
   * oldest blobs first and fires one `LIMIT_HIT` for `run.cacheMaxBytes`.
   */
  store(kind: RunCacheKind, text: string): RunCacheHandle;

  /** Remove one session's run-cache dir (called on `session.delete`). */
  clearSession(sessionId: string): void;
}
