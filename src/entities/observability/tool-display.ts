/**
 * Tool display-name helper for human-facing observability messages (§10.6).
 *
 * A step signature is `<tool>(<shapeDigest>)` (sequence-detector.ts). A
 * WARNING_EMITTED `message` must name a pattern by the tool's friendly DISPLAY
 * name and carry no literal argument values. This maps a raw tool name (or a
 * step signature) to its display name, mirroring the CLI's own label table
 * (cli-blueprint §4.4) so the core and the CLI agree on the words. Core-side so
 * the core can build the `message` once (every emitter carries it, §14.6) and no
 * payload ever shows the bare `category` word.
 */

/** Friendly display names, mirroring the CLI's §4.4 label table. */
const TOOL_LABELS: Record<string, string> = {
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  execute_command: "Run",
  workspace_map: "Map",
  glob_files: "Glob",
  search_contents: "Search",
  web_search: "Search",
  web_fetch: "Fetch",
  save_memory: "Remember",
  list_memory: "Memories",
  delete_memory: "Memories",
  list_skills: "Skills",
  load_skill: "Load Skill",
  task: "Task",
};

/** The raw tool name a step signature carries (`read_file({path:string})` →
 * `read_file`), or the string itself when it is already a bare name. */
export function toolNameFromSignature(signature: string): string {
  const paren = signature.indexOf("(");
  return paren >= 0 ? signature.slice(0, paren) : signature;
}

/** The display name for a raw tool name (§4.4). An MCP tool
 * `mcp_<server>_<tool>` renders `MCP:<server>:<tool>`; an unmapped tool shows
 * its raw name. Never includes an argument value. */
export function toolDisplayName(name: string): string {
  if (name.startsWith("mcp_")) {
    const rest = name.slice(4);
    const idx = rest.indexOf("_");
    return idx >= 0 ? `MCP:${rest.slice(0, idx)}:${rest.slice(idx + 1)}` : `MCP:${rest}`;
  }
  return TOOL_LABELS[name] ?? name;
}

/** The display name of a step signature's tool (strips the shape digest). */
export function stepDisplayName(signature: string): string {
  return toolDisplayName(toolNameFromSignature(signature));
}
