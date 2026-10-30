/**
 * §8.1/§14.6 — honest tool-result counts for `TOOL_FINISHED`.
 *
 * The decision point caps `summary` to ~500 chars before it rides the event, so
 * a client that COUNTS lines of `summary` undercounts a big result (the TUI row
 * showed "33 matches" for 50 globbed files, "25 files, 8 dirs" for 25+14). The
 * counts here are computed from the FULL result text (never the capped summary),
 * carried as additive, optional numeric fields so a client renders the true
 * figure and never leaks text — counts only, no body.
 *
 * `entries` is computed ONLY for the one tool whose client count is files-vs-dirs
 * (`workspace_map`), with the SAME rule the CLI uses (a directory line ends in
 * `/`), so the client can keep its own split or use these interchangeably.
 */

/** The additive count fields folded onto `TOOL_FINISHED` (all optional). */
export interface ToolCounts {
  /** Non-empty line count of the FULL result text. */
  lines: number;
  /** True when the emitted `summary` was truncated (the full text exceeded the
   * cap), so a client with no usable count prints an honest `<n>+` form. */
  truncated: boolean;
  /** `workspace_map` only — files vs dirs by the CLI's own rule (trailing `/`
   * = a directory), computed from the full text. */
  entries?: { files: number; dirs: number };
}

/**
 * Compute the count fields from the FULL result text and the summary cap.
 * `summaryCap` is the number of chars the emitter kept in `summary`; the text is
 * truncated when it is longer than that.
 */
export function toolCounts(name: string, fullText: string, summaryCap: number): ToolCounts {
  const lines = fullText.split("\n").filter((l) => l.trim() !== "").length;
  const truncated = fullText.length > summaryCap;
  const counts: ToolCounts = { lines, truncated };
  if (name === "workspace_map") {
    let files = 0;
    let dirs = 0;
    for (const line of fullText.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      if (t.endsWith("/")) dirs++;
      else files++;
    }
    counts.entries = { files, dirs };
  }
  return counts;
}
