/**
 * Backup- and editor-leftover file patterns (core-blueprint.md §13.9.1, §12.1).
 *
 * The live resource directories (global and project `agents/`, `skills/`,
 * `prompts/`) are EXACT: an agent dir holds only `agent.json` and `prompt.md`; a
 * skill dir holds `SKILL.md` and its `scripts/`/`references/`/`assets/` subtrees;
 * nothing else belongs. A file whose name matches one of the patterns below —
 * the retired `.rejected`/`.previous` siblings and the common editor/VCS
 * leftovers — found inside a live directory makes STARTUP FAIL (exit 3) with the
 * fix `voidrift init --sweep`. The SAME matcher classifies a config-directory
 * ROOT leftover (`config.json.bak-*`), which doctor reports as a warn and
 * `init --sweep` moves, but which never blocks startup.
 *
 * This is the ONE source of the patterns (§13.9.1), shared by the live-directory
 * scanner (startup + doctor) and `init --sweep`, so a file is classified the
 * same everywhere. Only these patterns trigger; a legitimately-named file (e.g.
 * `notes.md`) is never matched.
 *
 * Pure: no I/O. It classifies a BASENAME only; the caller supplies the name.
 */

/**
 * The backup/editor-leftover basename patterns (§13.9.1). Each is anchored to
 * the whole basename. Order is irrelevant — a name matches if ANY pattern does.
 *   `*.rejected`     a retired set-aside copy (agents/skills/prompts)
 *   `*.rejected.N`   a retired numbered set-aside copy
 *   `*.previous`     the retired `--update` one-generation backup
 *   `*.bak*`         a backup copy (covers `.bak`, `.bak-20261020`, `.bak.1`)
 *   `*.orig`         a merge/patch leftover
 *   `*~`             an editor backup (emacs, gedit)
 *   `*.swp`          a vim swap file
 *   `*.tmp-*`        an interrupted temp write
 *   `.#*`            an emacs lock file
 */
const LEFTOVER_PATTERNS: readonly RegExp[] = [
  /\.rejected$/,
  /\.rejected\.\d+$/,
  /\.previous$/,
  /\.bak(?:[.-].*)?$/,
  /\.orig$/,
  /~$/,
  /\.swp$/,
  /\.tmp-.*$/,
  /^\.#/,
];

/** True when a BASENAME matches a backup- or editor-leftover pattern (§13.9.1).
 * A canonical name (`agent.json`, `prompt.md`, `SKILL.md`, `config.json`) and an
 * ordinary file (`notes.md`) return false. */
export function isLeftoverName(name: string): boolean {
  return LEFTOVER_PATTERNS.some((re) => re.test(name));
}
