/**
 * Strip terminal- and spoof-dangerous characters from untrusted text before it
 * reaches the model or the TUI (core-blueprint.md §8.2 — fetched/searched
 * content is DATA, never authority). Covers:
 *   - C0 controls `\u0000-\u001F` (BEL, ESC → ANSI/terminal injection) except
 *     the whitespace that `\s+` collapsing already normalizes,
 *   - DEL + C1 controls `\u007F-\u009F`,
 *   - bidi overrides/isolates `\u200B-\u200F`, `\u202A-\u202E`, `\u2066-\u2069`
 *     (U+202E and friends spoof URLs and text direction),
 *   - the BOM/zero-width-no-break-space `\uFEFF`.
 *
 * PURE, no I/O. The replacement is "" (drop), not a space, so a run of control
 * bytes does not inflate the visible length; callers collapse whitespace and
 * length-cap afterward.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** The same set, but preserving tab/newline/carriage-return so multi-line
 * content (e.g. extracted page text) keeps its structure. */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS_KEEP_WS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Remove control/escape, DEL/C1, bidi-override, and zero-width/BOM chars. */
export function stripUnsafeChars(s: string): string {
  return s.replace(UNSAFE_CHARS, "");
}

/** As `stripUnsafeChars`, but keeps `\t`, `\n`, `\r` for multi-line content. */
export function stripUnsafeCharsKeepWhitespace(s: string): string {
  return s.replace(UNSAFE_CHARS_KEEP_WS, "");
}
