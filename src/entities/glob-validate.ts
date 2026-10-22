/**
 * Model-supplied glob pattern validator (security-audit S5 / GHSA-vfj7-8cjw-p6xm).
 *
 * `braces`/`micromatch`/`fast-glob` carry an UNPATCHED advisory
 * (GHSA-vfj7-8cjw-p6xm): a deeply-nested or unbalanced-brace pattern expands to
 * an enormous set / drives catastrophic backtracking, a resource-exhaustion DoS.
 * `braces` 3.0.3 is the latest published release and still carries it; there is
 * NO upstream fix to pin (checked: no patched `braces`/`micromatch`/`fast-glob`
 * exists). The ONLY reachable entry is a glob string the MODEL supplies to a
 * tool (`glob_files {pattern}`, `search_contents {include}`, `workspace_map`,
 * and `workspace.files`), all of which flow into deepagents → fast-glob →
 * micromatch → braces. This module is the MITIGATION: a cheap structural
 * validator applied at the tool boundary BEFORE the pattern reaches any glob
 * library, rejecting the pathological shapes the advisory needs while leaving
 * every legitimate workspace glob untouched.
 *
 * The checks are O(n) over the pattern (microseconds), never expand braces, and
 * fail CLOSED (reject) on anything suspicious:
 *   - longer than `MAX_GLOB_PATTERN_LENGTH` (the existing cap),
 *   - more than 8 `{` or more than 8 `}` in total,
 *   - brace nesting depth > 3,
 *   - unbalanced braces,
 *   - more than 20 `*`/`?`/`[` metacharacters,
 *   - more than 32 path segments,
 *   - a NUL or newline (never valid in a path, a classic injection char).
 */

/** The pattern-length cap (an order of magnitude below `braces.MAX_LENGTH` of
 * 10000; a real workspace glob is far shorter). */
export const MAX_GLOB_PATTERN_LENGTH = 1024;

const MAX_BRACES = 8;
const MAX_BRACE_DEPTH = 3;
const MAX_METACHARS = 20;
const MAX_SEGMENTS = 32;

/**
 * Validate a model-supplied glob/include pattern. Returns a human reason string
 * when the pattern is REJECTED, or `null` when it is safe to pass to a glob
 * library. Pure and O(n). The caller surfaces the reason as a tool error
 * `glob pattern rejected: <reason>`.
 */
export function validateGlobPattern(pattern: string): string | null {
  if (pattern.length > MAX_GLOB_PATTERN_LENGTH) {
    return `too long (max ${MAX_GLOB_PATTERN_LENGTH} characters)`;
  }
  if (pattern.includes("\0") || pattern.includes("\n") || pattern.includes("\r")) {
    return "contains a NUL or newline";
  }

  let open = 0;
  let close = 0;
  let depth = 0;
  let maxDepth = 0;
  let meta = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "{") {
      open++;
      depth++;
      if (depth > maxDepth) maxDepth = depth;
    } else if (ch === "}") {
      close++;
      if (depth > 0) depth--;
      else return "unbalanced braces"; // a `}` with no matching `{`
    } else if (ch === "*" || ch === "?" || ch === "[") {
      meta++;
    }
  }
  if (open > MAX_BRACES || close > MAX_BRACES) {
    return `too many braces (max ${MAX_BRACES} each of '{' and '}')`;
  }
  if (open !== close) {
    return "unbalanced braces";
  }
  if (maxDepth > MAX_BRACE_DEPTH) {
    return `brace nesting too deep (max ${MAX_BRACE_DEPTH})`;
  }
  if (meta > MAX_METACHARS) {
    return `too many glob metacharacters (max ${MAX_METACHARS})`;
  }
  const segments = pattern.split("/").length;
  if (segments > MAX_SEGMENTS) {
    return `too many path segments (max ${MAX_SEGMENTS})`;
  }
  return null;
}
