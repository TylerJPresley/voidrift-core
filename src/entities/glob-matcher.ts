/**
 * The one glob matcher Guardian, Warden, and the scope seam share (§9.2).
 *
 * A pattern without a path separator matches a command (`*` = match-anything,
 * so `git *` covers `git commit x`); a pattern with a separator is a path glob
 * (`*` within a segment, `**` across segments). Keeping one matcher means path
 * and command matching never diverge.
 */

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Compile a command glob (no path separator): `*` → `.*`. */
function commandToRegex(pattern: string): RegExp {
  const parts = pattern.split("*").map(escapeRegex);
  return new RegExp("^" + parts.join(".*") + "$");
}

/** Compile a path glob: `**` across segments, `*` within a segment. */
function pathToRegex(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const two = pattern.slice(i, i + 2);
    if (two === "**") {
      out += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      out += "[^/]*";
      i += 1;
    } else {
      out += escapeRegex(pattern[i]!);
      i += 1;
    }
  }
  return new RegExp("^" + out + "$");
}

/** True when `value` matches `pattern` under the shared glob semantics (§9.2). */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const isPath = pattern.includes("/");
  const re = isPath ? pathToRegex(pattern) : commandToRegex(pattern);
  return re.test(value);
}

/**
 * The length cap a tool-name glob rule may not exceed (§9.2). A rule's `tool`
 * field may be a glob matched against the call's TOOL NAME (`mcp_github_*`,
 * `mcp_*`); the cap keeps a pathological pattern from driving the regex compiler
 * and mirrors the model-supplied-glob cap at the §8.2 tool boundary
 * (`MAX_GLOB_PATTERN_LENGTH`, builtin.ts) — an order of magnitude below any real
 * tool-name glob.
 */
export const MAX_TOOL_GLOB_LENGTH = 1024;

/**
 * True when a rule's `tool` field (a glob) matches the call's tool NAME (§9.2,
 * §8.4). `"*"` matches any tool; an exact name matches exactly; a `*` wildcard
 * matches a run of characters (so `mcp_github_*` covers every tool of that
 * server and `mcp_*` every MCP tool). The pattern is anchored and every regex
 * metacharacter is escaped (tool names and server/tool segments are
 * server-controlled, §8.4), reusing the shared command-glob compiler. An
 * over-long pattern never matches (fail-closed) — it can neither allow nor deny.
 */
export function toolNameGlobMatch(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  if (pattern.length > MAX_TOOL_GLOB_LENGTH) return false;
  // Tool names contain no path separator, so the command-glob compiler (escapes
  // metacharacters, anchors `^…$`, `*` → `.*`) is the exact tool-name semantics.
  if (pattern.includes("/")) return false;
  return commandToRegex(pattern).test(toolName);
}
