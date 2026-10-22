/**
 * The observability query path (core-blueprint.md §10.5).
 *
 * `liqe` parses the Lucene-like syntax (`field:value`, `AND`/`OR`/`NOT`,
 * wildcards, ranges) over the NDJSON records. One parser-and-filter helper backs
 * three callers — `observability.query`, `observability.tail`, and the
 * `query_logs` model tool (§8.2) — so a bad filter is handled identically
 * everywhere: a structured `INVALID_QUERY` carrying liqe's own message, never a
 * silent match-all and never a throw across the boundary (§10.5, §2.6).
 */
import { parse, filter as liqeFilter } from "liqe";
import type { LiqeQuery } from "liqe";
import { coreError, err, ok, type Result } from "../errors.js";
import type { ObsRecord } from "./obs-record.js";

/** The stable code a bad Liqe filter returns from every query caller (§10.5). */
export const INVALID_QUERY = "INVALID_QUERY";

/** Parse a Liqe filter, returning a structured `INVALID_QUERY` on a parse
 * error. An empty/absent filter parses to `null` (match-all). */
export function parseFilter(filterText?: string): Result<LiqeQuery | null> {
  if (filterText === undefined || filterText.trim() === "") return ok(null);
  try {
    return ok(parse(filterText));
  } catch (e) {
    return err(coreError(INVALID_QUERY, e instanceof Error ? e.message : String(e), { field: "filter" }));
  }
}

/** Apply a parsed filter (or match-all when `null`) to records. */
export function applyFilter(query: LiqeQuery | null, records: ObsRecord[]): ObsRecord[] {
  if (query === null) return records;
  // liqe's filter is typed for its own row shape; ObsRecord is a plain object.
  return liqeFilter(query, records as unknown as readonly ObsRecord[]) as ObsRecord[];
}

/**
 * A point-in-time query over an already-loaded, newest-first record set: an
 * optional ISO `since` cutoff, then the Liqe filter, then the most recent
 * `limit` records (default 100) (§10.5).
 */
export function queryRecords(
  records: ObsRecord[],
  filterText?: string,
  opts?: { limit?: number; since?: string },
): Result<ObsRecord[]> {
  const parsed = parseFilter(filterText);
  if (!parsed.ok) return parsed;
  let rows = records;
  if (opts?.since) {
    const cutoff = Date.parse(opts.since);
    if (!Number.isNaN(cutoff)) {
      rows = rows.filter((r) => Date.parse(r.timestamp) >= cutoff);
    }
  }
  const matched = applyFilter(parsed.value, rows);
  const limit = opts?.limit ?? 100;
  return ok(matched.slice(0, Math.max(0, limit)));
}
