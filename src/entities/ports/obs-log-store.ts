/**
 * The observability log store port (core-blueprint.md §10.3).
 *
 * Append-only NDJSON, one file per session, in a dual layer: a workspace log
 * receiving every record and a global log receiving only `status:error` records.
 * The concrete adapter owns size-based rotation (seal at `logMaxSizeMB`, drop the
 * oldest sealed segment first) and optional age-based dropping (`logMaxAgeDays`).
 * Writes and rotation are best-effort: a filesystem failure is logged once and
 * swallowed, never a crash (§10.3). This port is engine-internal; no DTO here
 * crosses the facade.
 */

/** A persisted NDJSON line as read back from a session's trail. */
export interface ObsLogStore {
  /** Append one serialized record line to the session's workspace log, rotating
   * by size when the write would cross the budget. */
  appendWorkspace(sessionId: string, line: string): Promise<void>;
  /** Append one serialized record line to the global error log. */
  appendGlobal(sessionId: string, line: string): Promise<void>;
  /** Read the session's workspace trail newest-first, across all live/sealed
   * segments, as raw NDJSON lines. */
  readWorkspace(sessionId: string): Promise<string[]>;
  /** Await every append the store has accepted but not yet written to disk — the
   * per-path append queue the adapter serializes writes through (§10.3). A clean
   * shutdown drains this after the writer reaches quiescence so a queued-but-
   * unwritten record never lands after a workspace teardown. Optional: a store
   * that writes synchronously (an in-memory test store) needs no drain. */
  drain?(): Promise<void>;
}
