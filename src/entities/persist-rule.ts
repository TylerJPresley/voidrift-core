/**
 * Build the exact persisted allow rule and its deterministic id (§9.2, Slice C3).
 *
 * The CORE — never a host — builds the rule the user approved to persist. For a
 * shell/file/url tool the chosen suggestion is a command/path/url GLOB carried
 * in the rule's `pattern`, with the exact tool name in `tool`. For an MCP or
 * plugin tool (origin `mcp`/`plugin`) there is no value to match, so the C1
 * shape is a TOOL-NAME glob in `tool` with NO `pattern` (the matcher tests the
 * `tool` glob against the call's tool name).
 *
 * A PERSISTED rule is always `{ decision: "allow", priority: 0, source:
 * "workspace" }`. The id is deterministic and readable so an identical approval
 * is idempotent (same id ⇒ a no-op merge, never a duplicate):
 * `allow-<tool>-<first 8 hex of sha256(tool + "\u0000" + pattern)>`.
 */
import { createHash } from "node:crypto";
import type { PermissionRule } from "../config/schema.js";

/** A persisted rule and its deterministic id. */
export interface PersistRuleResult {
  id: string;
  rule: PermissionRule;
}

/**
 * Build the persisted allow rule the user chose (§9.2). `toolName` is the exact
 * tool the request carried; `chosenPattern` is the already-validated suggestion
 * (one of the request's `inferredPatterns`, or the exact tool name/value);
 * `isToolNameRule` is true for an MCP/plugin tool whose rule matches on the
 * `tool` glob with no `pattern`. `exact` (owner D2a) marks a force-ask lift
 * rule: the saved rule carries `exact: true` and its pattern is the LITERAL
 * value (whole command / `name@version` / host), so a glob rule and an exact
 * rule on the same string never collide (the id hashes `exact` too).
 */
export function buildPersistRule(
  toolName: string,
  chosenPattern: string,
  isToolNameRule: boolean,
  exact = false,
): PersistRuleResult {
  const rule: PermissionRule = isToolNameRule
    ? { tool: chosenPattern, decision: "allow", priority: 0, source: "workspace" }
    : {
        tool: toolName,
        pattern: chosenPattern,
        ...(exact ? { exact: true } : {}),
        decision: "allow",
        priority: 0,
        source: "workspace",
      };
  const idTool = isToolNameRule ? chosenPattern : toolName;
  const matchValue = isToolNameRule ? "" : chosenPattern;
  // Hash the exactness marker too (owner D2a) so an exact rule and a glob rule
  // on the same tool+string get DISTINCT ids and never merge into one another.
  const hash = createHash("sha256")
    .update(`${idTool}\u0000${matchValue}\u0000${exact ? "exact" : ""}`)
    .digest("hex")
    .slice(0, 8);
  // Keep the id readable: lowercase the tool segment and replace any character
  // outside [a-z0-9-] so the id is a safe, stable config key.
  const toolSlug = idTool.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "tool";
  return { id: `allow-${toolSlug}-${hash}`, rule };
}
