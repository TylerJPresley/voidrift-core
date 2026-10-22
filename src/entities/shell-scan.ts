/**
 * Windowed anchored-regex scanning (core-blueprint.md §9.3; owner D2d).
 *
 * The shell classifier's never-list and force-ask patterns are whole-string
 * anchored (`^(?:…)$`) and several lead with `.*`, so testing them against a
 * very long single segment is quadratic: a 100 KB segment took ~11 s per list.
 * That is a fail-OPEN availability defect — a model-supplied blob could stall
 * the gate. Two bounds close it:
 *
 *   1. A whole COMMAND longer than `MAX_COMMAND_LENGTH` is denied up front,
 *      before any regex runs (handled by `Guardian.evaluate`).
 *   2. Each individual SEGMENT is scanned in overlapping WINDOWS of
 *      `SCAN_WINDOW` characters (`SCAN_OVERLAP` overlap) instead of one huge
 *      string, so the regex engine only ever sees a bounded slice and the cost
 *      is linear in the segment length.
 *
 * The anchored patterns are prefix-oriented (a dangerous command begins its
 * segment, then `(?: .*)?` absorbs the rest), so window 0 — which shares the
 * segment's start — classifies a segment whose dangerous word is at its head.
 * The overlap guarantees that any dangerous command word that begins within a
 * window (and whose match the trailing `.*` completes) is wholly contained in
 * some window, so a dangerous token straddling a window boundary is still seen.
 */

/** The longest command the classifier will scan; longer is denied up front. */
export const MAX_COMMAND_LENGTH = 32768;

/** The per-segment scan window size (characters). */
export const SCAN_WINDOW = 8192;

/** The overlap between consecutive windows, so a token up to this length that
 * straddles a window boundary is still wholly inside the next window. */
export const SCAN_OVERLAP = 512;

/** Compiled-regex cache for the anchored classifier patterns. The never-list and
 * force-ask patterns are a small fixed set reused across every segment of every
 * command; compiling `^(?:…)$` once per distinct pattern (instead of per call)
 * keeps a many-segment command (e.g. `x=1;` repeated thousands of times) fast
 * (owner D2d). A pattern that fails to compile maps to null (never matches). */
const ANCHORED_CACHE = new Map<string, RegExp | null>();

/** Compile (and cache) a pattern anchored whole-string as `^(?:pattern)$`, or
 * null when the pattern is not a valid regex. */
export function anchoredRegex(pattern: string): RegExp | null {
  let re = ANCHORED_CACHE.get(pattern);
  if (re === undefined) {
    try {
      re = new RegExp("^(?:" + pattern + ")$");
    } catch {
      re = null;
    }
    ANCHORED_CACHE.set(pattern, re);
  }
  return re;
}

/**
 * Run `test` (an anchored whole-window predicate) over `value` in overlapping
 * windows and return true on the first window that matches. A value no longer
 * than `SCAN_WINDOW` is tested once, byte-for-byte as before — behavior is
 * unchanged for ordinary-length segments. Windows step by
 * `SCAN_WINDOW - SCAN_OVERLAP` so consecutive windows overlap by `SCAN_OVERLAP`.
 */
export function windowScan(value: string, test: (window: string) => boolean): boolean {
  if (value.length <= SCAN_WINDOW) return test(value);
  const step = SCAN_WINDOW - SCAN_OVERLAP;
  for (let start = 0; start < value.length; start += step) {
    if (test(value.slice(start, start + SCAN_WINDOW))) return true;
    if (start + SCAN_WINDOW >= value.length) break;
  }
  return false;
}
