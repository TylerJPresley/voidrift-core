/**
 * The core-owned built-in tool suite (core-blueprint.md §8.1, §8.2).
 *
 * These are VoidRift's OWN Zod-defined, single-source tools (§1 rule 5), bound
 * to the agent under the EXACT §8.2 names with the EXACT §8.2 argument fields —
 * `read_file {path, offset?, limit?, format?}`, `glob_files {pattern}`,
 * `workspace_map {path?, depth?}`, `search_contents {pattern, path?, include?}`,
 * `write_file {path, content}`, `edit_file {path, search, replace}`, and
 * `execute_command {command, timeout?}`. They are NOT deepagents' built-in
 * `read_file`/`glob`/`grep`/`execute`/`file_path` surface.
 *
 * The model sees exactly these tools. Execution delegates to deepagents'
 * `LocalShellBackend` (substrate §1.3, D1 "per-worker backend"), so the proven
 * filesystem/shell I/O is reused unchanged while the model-facing names and
 * argument fields are the blueprint's. The decision point and §9.3 force-ask
 * key off these core names; the registry's `readOnly` flag is derived here as
 * INTERNAL CLASSIFICATION (isolation, worker binding, display) and is NEVER a
 * permission input (§9) — the allow list alone decides what prompts.
 */
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { LocalShellBackend } from "deepagents";
import type { ToolDefinition, ToolExecutor } from "../entities/tool-registry.js";
import type { ToolRegistry } from "../entities/tool-registry.js";
import { RESEARCHER_SAVE_NOTES_SCHEMA } from "./research-notes.js";
import { SAVE_MEMORY_SCHEMA, LIST_MEMORY_SCHEMA, DELETE_MEMORY_SCHEMA } from "./memory-tools.js";
import { TASK_SCHEMA } from "./task-tool.js";
import { INGEST_SCHEMA, INGEST_TOOL_NAME } from "./ingest-tool.js";
import { validateGlobPattern } from "../entities/glob-validate.js";
import { classifyReadPath, type ControlPathContext } from "../entities/protected-paths.js";
import { runCommand } from "../adapters/command-runner.js";
import type { LimitsPort } from "../entities/ports/limits-port.js";
import type { RunCache } from "../entities/ports/run-cache.js";

/** The §8.2 argument schemas — the single source for binding and validation. */
export const READ_FILE_SCHEMA = z.object({
  path: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
  format: z.enum(["full", "concise"]).optional(),
});
export const GLOB_FILES_SCHEMA = z.object({ pattern: z.string() });
export const WORKSPACE_MAP_SCHEMA = z.object({
  path: z.string().optional(),
  depth: z.number().optional(),
});
export const SEARCH_CONTENTS_SCHEMA = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  include: z.string().optional(),
});

/** §8.2 — the DEFAULT wall-clock budget for a `search_contents` content search
 * before it falls back to a bounded glob-based FILENAME search (capped at
 * `limits.tools.searchFallbackMax`). The effective budget is the registry limit
 * `limits.tools.searchTimeoutMs` read live through the limits port; this constant
 * is the fallback default when no port is wired (behaviour byte-identical at the
 * default). */
export const SEARCH_CONTENTS_TIMEOUT_MS = 10_000;

export const WRITE_FILE_SCHEMA = z.object({ path: z.string(), content: z.string() });
export const EDIT_FILE_SCHEMA = z.object({
  path: z.string(),
  search: z.string(),
  replace: z.string(),
});
export const EXECUTE_COMMAND_SCHEMA = z.object({
  command: z.string(),
  timeout: z.number().optional(),
});
/**
 * `wait { seconds?, check?, interval?, timeout? }` (§8.2) — pauses the calling
 * agent without spending model tokens. Either sleeps `seconds`, or polls the
 * shell command `check` every `interval` seconds until it exits 0 or `timeout`
 * elapses. Its `check` runs a shell command and is classified EXACTLY like
 * `execute_command` at the one decision point (§9.3): the decision point maps
 * `check`→`command` onto the GUARD copy only (the tool still receives `check`),
 * so the guardian and exact-allow stay unchanged. A single wait is bounded by
 * `toolWaitMaxSeconds`; a longer request is clamped and the result says so
 * (gated as execution, not read-only). */
export const WAIT_SCHEMA = z.object({
  seconds: z.number().optional(),
  check: z.string().optional(),
  interval: z.number().optional(),
  timeout: z.number().optional(),
});
/** `web_fetch { url }` (§8.2) — a network action, gated (not read-only). */
export const WEB_FETCH_SCHEMA = z.object({ url: z.string() });

/** `web_search { query }` (§8.2) — a network action, gated (not read-only).
 * The schema is `{ query }` ONLY: the model never supplies a provider, an
 * `endpoint`, or a `url`; those come from config alone (§13.9). `strict()`
 * rejects any extra field (an attempt to inject an endpoint fails validation). */
export const WEB_SEARCH_SCHEMA = z.object({ query: z.string() }).strict();

/** The §8.2 suite as registry definitions — the one `readOnly` classification
 * (§8.1), consumed by the decision point's auto-approve set and `agents.tools`. */
export function builtinToolDefinitions(): { def: ToolDefinition; exec: ToolExecutor }[] {
  const notRouted: ToolExecutor = async () => ({
    content: "built-in tool executed by the agent runtime",
    status: "success",
  });
  const defs: ToolDefinition[] = [
    { name: "read_file", description: "Read a workspace file.", schema: READ_FILE_SCHEMA, readOnly: true },
    { name: "glob_files", description: "Return workspace paths matching a glob.", schema: GLOB_FILES_SCHEMA, readOnly: true },
    { name: "workspace_map", description: "Return a directory tree with extracted symbols.", schema: WORKSPACE_MAP_SCHEMA, readOnly: true },
    { name: "search_contents", description: "Regex content search across the workspace.", schema: SEARCH_CONTENTS_SCHEMA, readOnly: true },
    { name: "write_file", description: "Create or overwrite a workspace file.", schema: WRITE_FILE_SCHEMA, readOnly: false },
    { name: "edit_file", description: "A single exact search-and-replace in a workspace file.", schema: EDIT_FILE_SCHEMA, readOnly: false },
    { name: "execute_command", description: "Run a shell command in the workspace root.", schema: EXECUTE_COMMAND_SCHEMA, readOnly: false },
    // §8.2 — `wait` pauses the agent (sleep, or poll a `check` command). It is
    // NOT read-only: its `check` runs a shell command, gated and classified
    // exactly like `execute_command` (§9.3). The seeded allow list frees a plain
    // sleep-only `wait`; a `check` carrying a dangerous command still force-asks.
    { name: "wait", description: "Pause the agent: sleep for `seconds`, or poll the shell command `check` every `interval` seconds until it succeeds or `timeout` elapses.", schema: WAIT_SCHEMA, readOnly: false },
    { name: "web_fetch", description: "Fetch a URL, extract readable content, and cache it.", schema: WEB_FETCH_SCHEMA, readOnly: false },
    { name: "web_search", description: "Search the web and return up to 8 ranked results.", schema: WEB_SEARCH_SCHEMA, readOnly: false },
    // §8.6 — the research-notes tool. It WRITES (readOnly: false → gated at the
    // one decision point like every write), but its writes are confined to the
    // configured `findingsDirectories`; the seeded allow rule frees it so the
    // read-only `research` agent (unlisted: deny) runs it without a prompt.
    { name: "researcher_save_notes", description: "Save research notes as a Markdown file inside a configured findings directory.", schema: RESEARCHER_SAVE_NOTES_SCHEMA, readOnly: false },
    // §6.2/§8.2 — the in-turn memory tools. `save_memory` WRITES the two
    // agent-owned types (readOnly: false → gated at the one decision point like
    // every tool), but it only ever targets `.voidrift/memory/` or the global
    // memory dir (not protected paths); the seeded allow rules free all three so
    // the agent curates its own memory without a prompt (§6.4, §13.8). The
    // capability hard-refuses `identity`/`project` regardless of any allow rule.
    // `list_memory` is read-only; `delete_memory` removes an entry.
    { name: "save_memory", description: "Record a durable fact you learned this turn as agent-owned memory (note or user-model).", schema: SAVE_MEMORY_SCHEMA, readOnly: false },
    { name: "list_memory", description: "List all memory entries with id, type, scope, title and summary.", schema: LIST_MEMORY_SCHEMA, readOnly: true },
    { name: "delete_memory", description: "Delete a memory entry by its id.", schema: DELETE_MEMORY_SCHEMA, readOnly: false },
    // §3.1/§7 — the model-callable `task` dispatch tool. Registered so it passes
    // the ONE decision point like every tool (unknown-tool reject applies to an
    // unregistered name, §9.1); its `readOnly: false` is an INTERNAL FACT only
    // (never a permission input — the allow list decides prompting; the seeded
    // list frees `task` so a `chat`/`research`/`vibe` dispatch runs free). It is
    // bound by the engine's orchestrator path over the shared Subagents dispatch,
    // never here (its executor is not the `notRouted` stub); a worker never holds
    // it (§7.1). The real instance's schema/description come from `task-tool.ts`.
    { name: "task", description: "Delegate a unit of work to a specialized worker agent.", schema: TASK_SCHEMA, readOnly: false },
    // §8.7 — the model-callable `ingest` tool. Registered here (like `task`) so
    // the ONE decision point KNOWS the name — `registry.get("ingest")` returns a
    // def instead of null, so a call is gated like every tool rather than
    // rejected as an unknown tool (§9.1 step 1). It is READ-class (`readOnly:
    // true` — the seeded allow rule frees it so it never prompts, §13.8). Like
    // `task`, its executor here is the `notRouted` stub: the REAL instance is
    // bound by the engine's orchestrator path over the wired Ingest use-case,
    // ONLY to a delegating top-level agent (chat/research/vibe); a non-delegating
    // agent never has it bound and a call falls back to the unknown-tool reject.
    { name: INGEST_TOOL_NAME, description: "Ingest a file or URL too big to read whole: summarize it into one line-anchored digest.", schema: INGEST_SCHEMA, readOnly: true },
  ];  return defs.map((def) => ({ def: { ...def, origin: "builtin" as const }, exec: notRouted }));
}

function countLines(content: string): number {
  if (content === "") return 0;
  return content.split("\n").length;
}

/**
 * A1 (supply-chain, GHSA-vfj7-8cjw-p6xm): `glob_files {pattern}` and
 * `search_contents {include}` are MODEL-controlled strings that reach
 * deepagents' `LocalShellBackend` → fast-glob → micromatch → braces. braces
 * 3.0.3 is the latest published release and still carries the ReDoS /
 * resource-exhaustion advisory with no upstream fix to pin (S5). The ONE
 * reachable entry is a model-supplied pattern, so `validateGlobPattern`
 * (`entities/glob-validate.ts`) rejects the pathological shapes at the tool
 * boundary BEFORE they reach the backend. A legitimate workspace glob passes
 * untouched. */
function globPatternError(pattern: string, field: string): string | null {
  const reason = validateGlobPattern(pattern);
  return reason === null ? null : `Error: '${field}' glob pattern rejected: ${reason}`;
}

/**
 * A failed built-in tool returns a `ToolMessage` with `status: "error"` so the
 * decision point reports the failure (TOOL_FINISHED.status, §8.1) rather than a
 * false success. The message text is the same human string the tool produced;
 * frontends render it as an error line (cli §4.7). `config` carries the
 * `toolCall.id` LangChain binds the result to.
 */
function toolError(message: string, config?: { toolCall?: { id?: string } }): ToolMessage {
  return new ToolMessage({ content: message, tool_call_id: config?.toolCall?.id ?? "", status: "error" });
}

/** A unified diff in a fenced ```diff block (§8.2 stable contract). */
function diffBlock(path: string, before: string, after: string): string {
  const b = before.split("\n");
  const a = after.split("\n");
  const lines: string[] = ["```diff", `--- ${path}`, `+++ ${path}`];
  const max = Math.max(b.length, a.length);
  for (let i = 0; i < max; i++) {
    if (b[i] === a[i]) continue;
    if (i < b.length) lines.push(`-${b[i]}`);
    if (i < a.length) lines.push(`+${a[i]}`);
  }
  lines.push("```");
  return lines.join("\n");
}

/** Left-pad line numbers to a stable width (§8.2 read output). */
function numbered(content: string, startLine: number): string {
  const lines = content.split("\n");
  const width = String(startLine + lines.length).length;
  return lines.map((l, i) => `${String(startLine + i).padStart(width, " ")}  ${l}`).join("\n");
}

/**
 * The typed oversize note (§8.2/§8.7): a whole-file read larger than
 * `ingest.fitFraction` of the available budget returns this note — the size in
 * lines/tokens, the budget, and the two options (ingest when the agent holds it,
 * else a ranged read) — NOT a cut body. Content the model must understand is
 * never silently truncated (§4.8).
 */
function oversizeNote(path: string, lines: number, tokens: number, budget: number, offerIngest: boolean): string {
  const opts: string[] = [];
  if (offerIngest) {
    opts.push(`- ingest {path: "${path}", purpose: "<why you need it>"} — a line-anchored digest of the whole file.`);
  }
  opts.push(`- a ranged read: read_file {path: "${path}", offset, limit} — exact lines (always works).`);
  return (
    `${path} is large: ${lines} lines (~${tokens} tokens), over the available budget (~${budget} tokens; limits.ingest.fitFraction).\n` +
    `It is NOT returned cut — choose one:\n${opts.join("\n")}`
  );
}

/**
 * Build the seven core §8.2 tools over a `LocalShellBackend`. Behavior mirrors
 * the deepagents backend I/O; only names and arg fields are blueprint-conformant.
 */
export function buildCoreTools(
  backend: LocalShellBackend,
  cfg: {
    workspaceMaxReadLines: number;
    workspaceMapDepth: number;
    toolWaitMaxSeconds?: number;
    limits?: LimitsPort;
    /** The LIVE available token budget (§4.8): `ContextPipeline.availableBudget`
     * at call time, else the model window. A whole-file read over
     * `ingest.fitFraction` of this returns a typed oversize note, not a cut body
     * (§8.2/§8.7). Absent → no size note (small-window fallback never fires). */
    availableTokens?: () => number;
    /** True when the calling agent holds the `ingest` tool, so the oversize note
     * offers `ingest`; otherwise it offers only a ranged read (§8.7). */
    agentHasIngest?: () => boolean;
    /** §8.7/§7.2 — the run cache for `execute_command`: oversized output is
     * stored IN FULL by reference and the model gets a head+tail+handle instead
     * of a mid-stream cut (§8.2). Absent → the inline truncation fallback. */
    runCache?: RunCache;
    /** §7.2/§14.6 — report a `BY_REFERENCE` event when command output is stored
     * by reference. Optional. */
    onByReference?: (info: { what: string; bytes: number; key: string }) => void;
    /** §9.4/§10.11/§10.12 (MED) — the read-path guard for `read_file`: the
     * control-path context (workspace root, global config dir, home) and the
     * CURRENT session id. When present, a read of a read-denied control store
     * (journal, rollback snapshots, rollback.key) or ANOTHER session's run-cache
     * subtree is refused with a typed error; the current session's own run-cache
     * blobs read normally. Absent → no read guard (pure tests / staged builds). */
    readGuard?: { ctx: ControlPathContext; sessionId: () => string };
  },
): StructuredToolInterface[] {
  // §8.2/§13.11 — the per-call line cap is a registry limit (today's value).
  const readMaxLines = (): number =>
    cfg.limits ? cfg.limits.get("tools.readMaxLines") : cfg.workspaceMaxReadLines;
  // §8.7 — the fraction of the available budget a WHOLE read may occupy before a
  // digest/ranged read is recommended instead of a cut body.
  const fitFraction = (): number => (cfg.limits ? cfg.limits.get("ingest.fitFraction") : 0.5);
  const readFile = tool(
    async ({ path, offset, limit }, config) => {
      // §9.4/§10.11/§10.12 (MED) — refuse a read of a read-denied control store
      // (mutation journal, rollback snapshots, rollback.key) or ANOTHER session's
      // run-cache subtree. The current session's own run-cache blobs are allowed
      // (the handle round-trip). Classified once from the path, so a different
      // spelling cannot slip past (the ONE `classifyReadPath`).
      if (cfg.readGuard) {
        const denied = classifyReadPath(path, cfg.readGuard.ctx, cfg.readGuard.sessionId());
        if (denied === "deny") {
          return toolError(`Error: '${path}' is a protected VoidRift control path and cannot be read.`, config);
        }
      }
      const maxLines = readMaxLines();
      const ranged = offset !== undefined || limit !== undefined;
      // A RANGED read (explicit offset/limit) always works — never refused for
      // size — capped at the per-call registry line limit (§8.2).
      if (ranged) {
        const lim = Math.min(limit ?? maxLines, maxLines);
        const r = await backend.read(path, offset ?? 0, lim);
        if (r.error || typeof r.content !== "string") return toolError(`Error: File not found: ${path}`, config);
        const total = r.totalLines ?? countLines(r.content);
        const body = numbered(r.content, r.startLine ?? 1);
        const more =
          r.nextOffset === undefined
            ? ""
            : `\n\n[Showing through line ${r.endLine} of ${total}; pass offset=${r.nextOffset} to continue.]`;
        return `${path} (${total} lines)\n${body}${more}`;
      }
      // A WHOLE read: measure the file against the AVAILABLE budget (§4.8/§8.7).
      // Over `ingest.fitFraction` of it → return a typed note (size, budget, the
      // two options), NOT a cut body. Small files read whole as today.
      const whole = await backend.read(path, 0, Number.MAX_SAFE_INTEGER);
      if (whole.error || typeof whole.content !== "string") return toolError(`Error: File not found: ${path}`, config);
      const content = whole.content;
      const total = whole.totalLines ?? countLines(content);
      const tokens = Math.ceil(content.length / 4);
      const available = cfg.availableTokens ? cfg.availableTokens() : 0;
      const budget = Math.floor(fitFraction() * available);
      if (available > 0 && tokens > budget && total > maxLines) {
        const offerIngest = cfg.agentHasIngest ? cfg.agentHasIngest() : false;
        return oversizeNote(path, total, tokens, budget, offerIngest);
      }
      // Within budget (or no pipeline): read whole, capped at the per-call limit.
      const r = await backend.read(path, 0, maxLines);
      const body = numbered(typeof r.content === "string" ? r.content : content, r.startLine ?? 1);
      const more =
        r.nextOffset === undefined
          ? ""
          : `\n\n[Showing through line ${r.endLine} of ${total}; pass offset=${r.nextOffset} to continue.]`;
      return `${path} (${total} lines)\n${body}${more}`;
    },
    { name: "read_file", description: "Read a workspace file.", schema: READ_FILE_SCHEMA },
  );

  const globFiles = tool(
    async ({ pattern }, config) => {
      const bad = globPatternError(pattern, "pattern");
      if (bad) return toolError(bad, config);
      const r = await backend.glob(pattern);
      if (r.error) return toolError(`Error: ${r.error}`, config);
      const files = (r.files ?? []).map((f) => f.path).slice(0, 500);
      return files.length === 0 ? "No files matched." : files.join("\n");
    },
    { name: "glob_files", description: "Return workspace paths matching a glob.", schema: GLOB_FILES_SCHEMA },
  );

  const workspaceMap = tool(
    async ({ path }, config) => {
      if (path) {
        const bad = globPatternError(path, "path");
        if (bad) return toolError(bad, config);
      }
      const root = path && path !== "" ? path : ".";
      const r = await backend.ls(root);
      if (r.error) return toolError(`Error: ${r.error}`, config);
      const files = r.files ?? [];
      return files.length === 0 ? "(empty)" : files.map((f) => (f.is_dir ? `${f.path}/` : f.path)).join("\n");
    },
    { name: "workspace_map", description: "Return a directory tree with extracted symbols.", schema: WORKSPACE_MAP_SCHEMA },
  );

  const searchContents = tool(
    async ({ pattern, path, include }, config) => {
      if (include && (include.includes("/") || include.includes("\\"))) {
        return toolError("Error: invalid 'include': filename glob only", config);
      }
      if (include) {
        const bad = globPatternError(include, "include");
        if (bad) return toolError(bad, config);
      }
      const root = path && path !== "" ? path : ".";
      // §8.2 — the content search is bounded by a wall-clock timeout. On a
      // timeout it falls back to a glob-based FILENAME search (the pattern is
      // matched against file names, not contents), capped at
      // `limits.tools.searchFallbackMax` (default 100) results, returned with a
      // VISIBLE notice naming the cause and the limit key. The grep backend
      // offers no cancellation handle, so the timer abandons the (now-detached)
      // grep and proceeds with the bounded fallback — the tool never hangs.
      const SEARCH_TIMEOUT = Symbol("search-timeout");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const searchTimeoutMs = cfg.limits ? cfg.limits.get("tools.searchTimeoutMs") : SEARCH_CONTENTS_TIMEOUT_MS;
      const raced = await Promise.race([
        backend.grep(pattern, root, include ?? null, 100),
        new Promise<typeof SEARCH_TIMEOUT>((resolve) => {
          timer = setTimeout(() => resolve(SEARCH_TIMEOUT), searchTimeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (raced !== SEARCH_TIMEOUT) {
        const r = raced;
        if (r.error) return toolError(`Error: ${r.error}`, config);
        const matches = r.matches ?? [];
        return matches.length === 0 ? "No matches found." : matches.map((m) => `${m.path}:${m.line}:${m.text}`).join("\n");
      }
      // Timed out → bounded filename fallback.
      // §13.11 `tools.searchTimeoutMs` — emit ONE LIMIT_HIT naming the key when
      // the wall-clock budget fires (the grep is abandoned and the glob-based
      // filename fallback runs). The port dedups per key per turn.
      cfg.limits?.hit("tools.searchTimeoutMs", searchTimeoutMs, { what: "content search timed out; filename fallback" });
      const cap = cfg.limits ? cfg.limits.get("tools.searchFallbackMax") : 100;
      // Match the pattern against file names: a bare word becomes `*word*`; a
      // user-supplied glob (containing `*`/`?`) is used as-is under the root.
      const nameGlob = /[*?]/.test(pattern) ? pattern : `*${pattern}*`;
      const globPattern = root === "." ? `**/${nameGlob}` : `${root.replace(/\/+$/, "")}/**/${nameGlob}`;
      const g = await backend.glob(globPattern);
      if (g.error) {
        return toolError(`Error: content search timed out and the filename fallback failed: ${g.error}`, config);
      }
      const all = g.files ?? [];
      const names = all.map((f) => f.path).slice(0, cap);
      // §13.11 `tools.searchFallbackMax` — registered `warn`: emit ONE LIMIT_HIT
      // naming the key when the fallback drops results past the cap (alongside
      // the visible notice the model already sees).
      if (all.length > cap) {
        cfg.limits?.hit("tools.searchFallbackMax", all.length, { what: "filename fallback results capped" });
      }
      const notice =
        `ℹ the content search timed out; showing a bounded filename match instead ` +
        `(up to ${cap} results — raise limits.tools.searchFallbackMax).`;
      return names.length === 0 ? `${notice}\nNo files matched.` : `${notice}\n${names.join("\n")}`;
    },
    { name: "search_contents", description: "Regex content search across the workspace.", schema: SEARCH_CONTENTS_SCHEMA },
  );

  const writeFile = tool(
    async ({ path, content }, config) => {
      const existing = await backend.read(path, 0, Number.MAX_SAFE_INTEGER);
      const before = !existing.error && typeof existing.content === "string" ? existing.content : null;
      const r = await backend.write(path, content);
      if (r.error) return toolError(`Error: ${r.error}`, config);
      const header = `Created ${path} (${countLines(content)} lines)`;
      return before !== null ? `${header}\n${diffBlock(path, before, content)}` : header;
    },
    { name: "write_file", description: "Create or overwrite a workspace file.", schema: WRITE_FILE_SCHEMA },
  );

  const editFile = tool(
    async ({ path, search, replace }, config) => {
      if (search === "") return toolError("Error: search string cannot be empty", config);
      const existing = await backend.read(path, 0, Number.MAX_SAFE_INTEGER);
      const before = !existing.error && typeof existing.content === "string" ? existing.content : "";
      const r = await backend.edit(path, search, replace, false);
      if (r.error) {
        if (/not found/i.test(r.error)) return toolError(`Edit failed: search string not found in ${path}`, config);
        return toolError(`Error: ${r.error}`, config);
      }
      const after = before.replace(search, replace);
      return `Edited ${path}\n${diffBlock(path, before, after)}`;
    },
    { name: "edit_file", description: "A single exact search-and-replace in a workspace file.", schema: EDIT_FILE_SCHEMA },
  );

  const executeCommand = tool(
    async ({ command }, config) => {
      // §3.3/§5.2 — the turn's shared AbortSignal (`session.cancel`). The command
      // runs through VoidRift's own `runCommand` (not the deepagents backend,
      // which owns its child and exposes no handle): it spawns the child in its
      // OWN process group and, on abort or timeout, kills the WHOLE group
      // (SIGTERM then SIGKILL after a bounded grace), so a cancelled command — and
      // any background grandchildren — are gone, not left running to the backend
      // timeout. An abort before spawn spawns nothing. The observable output is
      // byte-identical to the backend (same shell, env, cwd, formatting), so the
      // §8.2 result strings below are unchanged. `backend.cwd` is the workspace
      // root (a worker's worktree at dispatch); env/timeout/caps match the
      // backend's defaults the engine and workers construct it with.
      const signal = (config as { signal?: AbortSignal } | undefined)?.signal;
      // `cwd` is public at runtime (resolved rootDir) but typed `protected` in
      // the deepagents definitions; read it through a narrow cast. For the worker
      // path this is the worktree rootDir the backend was constructed with.
      const cwd = (backend as unknown as { cwd: string }).cwd;
      const r = await runCommand(command, {
        cwd,
        ...(signal ? { signal } : {}),
        ...(cfg.limits ? { limits: cfg.limits } : {}),
        ...(cfg.runCache ? { runCache: cfg.runCache } : {}),
        ...(cfg.onByReference ? { onByReference: cfg.onByReference } : {}),
      });
      if (r.output === "Command cancelled.") {
        return new ToolMessage({ content: "Command cancelled.", tool_call_id: config?.toolCall?.id ?? "", status: "error" });
      }
      const code = r.exitCode ?? 0;
      const content = `Exit code ${code}\n${r.output}`;
      if (code !== 0) {
        return new ToolMessage({
          content,
          tool_call_id: config?.toolCall?.id ?? "",
          status: "error",
        });
      }
      return content;
    },
    { name: "execute_command", description: "Run a shell command in the workspace root.", schema: EXECUTE_COMMAND_SCHEMA },
  );

  // §8.2 — `wait`. Sleeps `seconds`, or polls `check` every `interval` seconds
  // until it exits 0 or `timeout` elapses. A single wait is bounded by
  // `toolWaitMaxSeconds` (default 300): a `seconds`/`timeout` above the cap is
  // CLAMPED and the result says so. Cancellation is honoured through the
  // LangChain `config.signal` (the turn's AbortSignal, which `session.cancel`
  // aborts): an aborted wait returns immediately. The `check` command is gated
  // ONCE at dispatch by the decision point (classified as `execute_command`),
  // never per poll, so a long poll never re-prompts. The result is an ordinary
  // tool result the agent iterates on (§8.2); no special event fires.
  const waitCap = cfg.toolWaitMaxSeconds && cfg.toolWaitMaxSeconds > 0 ? cfg.toolWaitMaxSeconds : 300;
  const sleep = (ms: number, signal?: AbortSignal): Promise<"done" | "aborted"> =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve("aborted");
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve("done");
      }, ms);
      const onAbort = (): void => {
        clearTimeout(t);
        resolve("aborted");
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  const waitTool = tool(
    async ({ seconds, check, interval, timeout }, config) => {
      const signal = (config as { signal?: AbortSignal } | undefined)?.signal;
      // Poll mode: `check` present. Otherwise sleep mode.
      if (typeof check === "string" && check.trim() !== "") {
        const requested = typeof timeout === "number" && timeout > 0 ? timeout : waitCap;
        const bound = Math.min(requested, waitCap);
        const clamped = bound < requested;
        const step = Math.max(1, typeof interval === "number" && interval > 0 ? interval : 5);
        const deadline = Date.now() + bound * 1000;
        // Same workspace root the backend uses (public at runtime, typed
        // `protected` in deepagents' defs) — read through a narrow cast.
        const cwd = (backend as unknown as { cwd: string }).cwd;
        for (;;) {
          if (signal?.aborted) return "Wait cancelled.";
          // §3.3/§5.2 — run the poll `check` through VoidRift's own group-killing
          // `runCommand` (not `backend.execute`, which orphans its child to the
          // backend's 120 s timeout on cancel). Same cwd/env as the backend; on
          // abort the whole process group dies promptly. Exit-code semantics are
          // preserved (exit 0 ends the wait); a cancelled run returns exit 1 with
          // "Command cancelled.", handled by the signal check on the next loop.
          const r = await runCommand(check, {
            cwd,
            ...(signal ? { signal } : {}),
            ...(cfg.limits ? { limits: cfg.limits } : {}),
          });
          if (signal?.aborted) return "Wait cancelled.";
          if ((r.exitCode ?? 0) === 0) {
            return `Wait: check succeeded (exit 0).${clamped ? ` (timeout clamped to ${waitCap}s)` : ""}`;
          }
          if (Date.now() >= deadline) {
            return `Wait: timed out after ${bound}s; check did not succeed.${clamped ? ` (clamped to the ${waitCap}s cap)` : ""}`;
          }
          const remainMs = deadline - Date.now();
          const naps = await sleep(Math.min(step * 1000, remainMs), signal);
          if (naps === "aborted") return "Wait cancelled.";
        }
      }
      // Sleep mode.
      const requested = typeof seconds === "number" && seconds > 0 ? seconds : 0;
      const bound = Math.min(requested, waitCap);
      const clamped = bound < requested;
      const r = await sleep(bound * 1000, signal);
      if (r === "aborted") return "Wait cancelled.";
      return `Waited ${bound}s.${clamped ? ` (clamped to the ${waitCap}s cap)` : ""}`;
    },
    { name: "wait", description: "Pause the agent: sleep for `seconds`, or poll the shell command `check` every `interval` seconds until it succeeds or `timeout` elapses.", schema: WAIT_SCHEMA },
  );

  return [readFile, globFiles, workspaceMap, searchContents, writeFile, editFile, executeCommand, waitTool];
}

/**
 * A minimal read-through staging surface the staged-worker tools bind to (§7.4).
 * The subagents use-case passes an implementation backed by a run's `StagingPort`
 * area, so a staged worker's reads check staging first then disk, and its writes
 * never touch disk — they land in the durable staging folder.
 */
export interface StagedToolBackend {
  /** Read-through: staged content when staged, else disk, else null (§7.4). */
  read(targetPath: string): Promise<string | null>;
  /** Stage a write durably (base + staged hashes, temp-and-rename) (§7.4). */
  stageWrite(targetPath: string, content: string): Promise<void>;
}

/**
 * Build the staged-worker §8.2 tool suite (§7.4). A staged worker runs with NO
 * repo and NO isolation to run shell in, so `execute_command` is deliberately
 * ABSENT — the no-shell-staged-worker limit (D5) is enforced structurally by the
 * toolset, not a runtime check. Reads (glob/map/search over disk via `backend`;
 * `read_file` read-through via `staged`) and writes (staged, never on disk) are
 * bound so the writer path is identical to the repo case except for isolation.
 */
export function buildStagedTools(
  backend: LocalShellBackend,
  staged: StagedToolBackend,
  cfg: { workspaceMaxReadLines: number; workspaceMapDepth: number; limits?: LimitsPort },
): StructuredToolInterface[] {
  // Reuse the disk-backed read-only trio (glob/map/search) unchanged.
  const diskTools = buildCoreTools(backend, cfg);
  const globFiles = diskTools.find((t) => t.name === "glob_files")!;
  const workspaceMap = diskTools.find((t) => t.name === "workspace_map")!;
  const searchContents = diskTools.find((t) => t.name === "search_contents")!;

  const readFile = tool(
    async ({ path, offset, limit }) => {
      const content = await staged.read(path);
      if (content === null) return `Error: File not found: ${path}`;
      const lines = content.split("\n");
      const start = offset ?? 0;
      const lim = limit ?? cfg.workspaceMaxReadLines;
      const slice = lines.slice(start, start + lim).join("\n");
      return `${path} (${lines.length} lines)\n${numbered(slice, start + 1)}`;
    },
    { name: "read_file", description: "Read a workspace file.", schema: READ_FILE_SCHEMA },
  );

  const writeFile = tool(
    async ({ path, content }) => {
      const before = await staged.read(path);
      await staged.stageWrite(path, content);
      const header = `Staged ${path} (${countLines(content)} lines)`;
      return before !== null ? `${header}\n${diffBlock(path, before, content)}` : header;
    },
    { name: "write_file", description: "Create or overwrite a workspace file.", schema: WRITE_FILE_SCHEMA },
  );

  const editFile = tool(
    async ({ path, search, replace }) => {
      if (search === "") return "Error: search string cannot be empty";
      const before = await staged.read(path);
      if (before === null) return `Edit failed: file not found: ${path}`;
      if (!before.includes(search)) return `Edit failed: search string not found in ${path}`;
      const after = before.replace(search, replace);
      await staged.stageWrite(path, after);
      return `Staged edit ${path}\n${diffBlock(path, before, after)}`;
    },
    { name: "edit_file", description: "A single exact search-and-replace in a workspace file.", schema: EDIT_FILE_SCHEMA },
  );

  return [readFile, globFiles, workspaceMap, searchContents, writeFile, editFile];
}

/**
 * Bind the APPROVED MCP tools (§8.4) to the model as LangChain tools.
 *
 * This is the ONE place MCP tools reach the model (SECURITY, concern #1): the
 * engine and every worker call it so a quarantined/pending tool — excluded by
 * `registry.mcpModelEntries()` — is never bound and never callable. Each tool
 * routes through the registry executor, which runs the §8.4 call-time
 * defense-in-depth (re-check status, deny if quarantined by a concurrent
 * refresh) before it ever reaches the server; the returned content/error flows
 * back through the SAME decision-point middleware every other tool passes. The
 * schema is a permissive object: the MCP server validates its own arguments.
 */
export function buildMcpModelTools(
  registry: ToolRegistry,
  ctx: { workspaceRoot: string; sessionId: string },
): StructuredToolInterface[] {
  return registry.mcpModelEntries().map(({ def, exec }) =>
    tool(
      async (args: unknown) => {
        const r = await exec(args, { workspaceRoot: ctx.workspaceRoot, sessionId: ctx.sessionId });
        return r.content;
      },
      {
        name: def.name,
        description: def.description,
        schema: def.schema,
      },
    ),
  );
}

/**
 * Bind the plugin-contributed tools (origin `plugin`, §8.1, §12.4) to the model
 * as LangChain tools. Mirrors `buildMcpModelTools`: the single place plugin
 * tools reach the model. A plugin is trusted in-process code, so every
 * registered plugin tool binds (no quarantine lifecycle); the engine's
 * per-agent `tools` filter still decides which bind for the active agent, and
 * each call passes the one decision point (a plugin tool ASKS until
 * allow-listed, §9). Each tool routes through the registry executor so a throw
 * is contained and the result flows back through the same middleware.
 */
export function buildPluginModelTools(
  registry: ToolRegistry,
  ctx: { workspaceRoot: string; sessionId: string },
): StructuredToolInterface[] {
  return registry.pluginModelEntries().map(({ def, exec }) =>
    tool(
      async (args: unknown) => {
        const r = await exec(args, { workspaceRoot: ctx.workspaceRoot, sessionId: ctx.sessionId });
        return r.content;
      },
      {
        name: def.name,
        description: def.description,
        schema: def.schema,
      },
    ),
  );
}
