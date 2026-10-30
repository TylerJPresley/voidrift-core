/**
 * Subagent entities and DTOs (core-blueprint.md §3.1, §7.1–§7.2).
 *
 * Pure types and the registration assertion that keeps recursion structurally
 * impossible. No LangChain/LangGraph type appears here (§1 rule 4) and no
 * infrastructure is imported — this is the entity layer the subagents use-case
 * and the facade both read.
 */
import type { StructuredToolInterface } from "@langchain/core/tools";

/**
 * One tool row in the `/tools` panel (§8.1 `agents.tools`, FX-F). The effective
 * tool the ACTIVE top-level agent would run with: the tool `name` and
 * `description`, where it came from (`origin`), and whether it is allow-listed
 * (runs without asking) or will `ask` at the decision point. Purely descriptive
 * — a display DTO, never a permission input (§9).
 */
export interface AgentToolInfo {
  name: string;
  description: string;
  /** Built-in, a loaded plugin, or an approved MCP server tool (§8.1, §8.4). */
  origin: "builtin" | "plugin" | "mcp";
  /** `allow` = runs without asking (allow-listed, or a free read-class built-in);
   * `ask` = prompts at the decision point until allow-listed (§9). */
  status: "allow" | "ask";
}
import { globMatch } from "./glob-matcher.js";

/** The lifecycle of a dispatched worker (§7.2). */
export type WorkerStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "needs_review"
  | "reviewed"
  | "merged"
  | "aborted"
  | "skipped"
  // §3.3/§7.2 — the worker reached its tool-round budget (`turnMaxToolRounds`).
  // Terminal and NEVER an empty failure: the result carries the worker's last
  // assistant text, or a generated summary of the rounds used and the tools
  // called. A consumer treats it as a completed worker, not an error (the CLI
  // shows it as done, CLI §6.3).
  | "limit_reached";

/** A worker's structured return (§7.2). */
export interface WorkerResult {
  status: WorkerStatus;
  summary: string;
  artifacts?: string[];
  /** The worker's worktree path, in a git repo (§7.3). */
  worktree?: string;
  /** The recovery branch, when a merge conflict/failure preserved work (§7.3). */
  recoveryBranch?: string;
}

/** What resume restores about dispatched workers (§2.4, §5.3, §7.2). */
export interface WorkInFlight {
  workers: {
    workerId: string;
    status: WorkerStatus;
    /** The worker's worktree path, in a git repo (§7.3). */
    worktree?: string;
    /** The worker's staging folder, with no repo (§7.4 — later slice seam). */
    staging?: string;
  }[];
}

/** The DTO `subagents.list`/`subagents.status` expose (§7.2). */
export interface WorkerInfo {
  workerId: string;
  agent: string;
  status: WorkerStatus;
  summary?: string;
  worktree?: string;
  /** The worker's staging run id, with no repo (§7.4). */
  staging?: string;
  recoveryBranch?: string;
  pendingApproval: boolean;
  /** The batch task id this worker ran (§7.2 batch form), when dispatched as part
   * of a `task` batch; the consolidated tool result keys results back by it.
   * Absent for a direct `api.subagents.dispatch` with no per-request id. */
  taskId?: string;
}

/** One live stream event for a worker, keyed by worker id (§7.2). */
export interface WorkerStreamEvent {
  workerId: string;
  kind: "status" | "tool" | "summary";
  status?: WorkerStatus;
  tool?: string;
  text?: string;
}

/**
 * A VoidRift agent definition (§3.1). One definition maps to one isolated
 * `SubAgent` worker. `tools` are resolved §8.2 tool names; the use-case binds
 * the executable tool instances over the worker's per-worktree backend.
 *
 * `model` is a STRING config endpoint key (§11, invariant 14): no LangChain type
 * crosses the CoreAPI method/DTO surface. The use-case resolves the key to the
 * bound model internally via the model port; an unknown key is a typed
 * `MODEL_NOT_CONFIGURED` error. Omitted means the single active endpoint.
 */
export interface AgentDefinition {
  name: string;
  description: string;
  /** Top-level agents are the orchestrators the user switches between; workers
   * never delegate (§3.1). Absent for a programmatic registration → treated as
   * a worker for class/dispatch purposes. */
  kind?: "top-level" | "worker";
  systemPrompt: string;
  /** Resolved §8.2 tool names the worker may use. */
  tools: string[];
  /** Optional per-agent model: a config endpoint key resolved internally (§11).
   * A string only — never a model instance — so no library type crosses the
   * public surface (§1 rule 4, invariant 14). */
  model?: string;
  /** Whether this agent is a read-only reviewer (read tools only, §7.5). A
   * programmatic registration may still set it; filesystem agents derive their
   * class from the tool list instead. */
  reviewer?: boolean;
  // ── top-level only (§3.1) ──────────────────────────────────────────────────
  /** The workers a top-level agent may dispatch (an allow list, or "all"). */
  workers?: string[] | "all";
  /** What happens to a dispatch of a worker NOT on `workers` (§3.1). */
  unlisted?: "deny" | "ask" | "allow";
  /** Required `true` when `unlisted` is `allow` (§3.1). */
  confirm?: boolean;
  /** Shift+Tab cycle order (§3.1); lower first. */
  order?: number;
  /** An optional display label (§3.1). */
  label?: string;
  /** Which cascade source this definition resolved from (§3.1 project >
   * global > builtin). Set by discovery; absent for a programmatic registration. */
  source?: "builtin" | "global" | "project";
  /** The absolute `agent.json` path this definition was discovered from (§3.1);
   * absent for the built-in `chat` and programmatic registrations. Surfaced by
   * `agents.list` so `/access`/`doctor` can name the file per layer. */
  filePath?: string;
}

/**
 * The write-class §8.2 tool names (§3.1, §9). A worker holding ANY of these can
 * change state and is therefore write-class. Any tool NOT in the read-class set
 * is also treated as write (the unknown is write — fail closed, §9).
 *
 * NOTE on `web_fetch`: the tool registry marks it `readOnly: false` because a
 * network URL is SSRF-gated at the decision point, but a public GET changes NO
 * state. For WORKER classification (§3.1) a read-only fetch is a read, so
 * `web_fetch` is read-class here — matching the blueprint's researcher, which is
 * read-class and holds `web_fetch`. Both notions are INTERNAL CLASSIFICATION,
 * NEVER a permission input (§9): the registry's `readOnly` drives SSRF display
 * and the write/read CLASS here drives dispatch gating and isolation; neither
 * decides whether a call prompts — the allow list does.
 */
export const WRITE_CLASS_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "execute_command",
]);

/** The read-class §8.2 + skills/memory tool names a worker may hold and stay
 * read-class (§3.1). `web_fetch` is read-class for classification (a public GET
 * changes no state; see WRITE_CLASS_TOOLS). Everything else is treated as write
 * (fail closed, §9). */
export const READ_CLASS_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "glob_files",
  "workspace_map",
  "search_contents",
  "web_fetch",
  "web_search",
  "list_skills",
  "load_skill",
  // §8.7 — `ingest` reads a source and fans out read-only summarizer workers;
  // it changes nothing, so it is read-class (free at the gate, allow-listed).
  "ingest",
  // §12.8 — reads only the registered manual, never the filesystem.
  "read_manual",
  // §8.6 — THE SINGLE EXEMPTION from the write-class/mutating list. A worker
  // that holds `researcher_save_notes` stays READ-class, so it gets NO isolation
  // (no worktree) and dispatching it from the read-only `research` agent is NOT a
  // write dispatch. This is safe precisely because the tool's writes are confined
  // to the configured `findingsDirectories` under the real session root (not a
  // worktree) — the research notes a researcher is meant to leave. No other write
  // tool is exempt.
  "researcher_save_notes",
]);

/**
 * Derive a worker's class from its tool list (§3.1, §9): write when it holds any
 * write-class tool OR any tool outside the known read-class set (the unknown is
 * write — fail closed), else read. A reviewer is read-class by construction
 * (§7.5), independent of its declared tools. */
export function deriveAgentClass(def: AgentDefinition): "read" | "write" {
  if (def.reviewer) return "read";
  for (const t of def.tools) {
    if (WRITE_CLASS_TOOLS.has(t)) return "write";
    if (!READ_CLASS_TOOLS.has(t)) return "write"; // unknown tool → fail closed
  }
  return "read";
}

/** The task dispatch tool name — the sole dispatch surface (§7.1). */
export const TASK_TOOL_NAME = "task";

/**
 * Whether a tool name is bound for an active top-level agent (§2.7(b), §3.1):
 * the agent's `tools` list is matched against the tool name. An entry may be an
 * exact name (`write_file`), a glob (`mcp_*`, matched by the shared glob
 * matcher), or `"*"` meaning all tools. A tool whose name matches no entry is
 * simply not bound — a model call to it is then an unknown-tool rejection, as
 * today. `task` is handled by the engine (attached to the orchestrator only) and
 * is not filtered here.
 */
export function toolMatchesAgentList(toolName: string, list: readonly string[]): boolean {
  for (const entry of list) {
    if (entry === "*") return true;
    if (entry === toolName) return true;
    // A glob entry (`mcp_*`) matches by the shared command-glob semantics.
    if (entry.includes("*") && globMatch(entry, toolName)) return true;
  }
  return false;
}

/**
 * The `unlisted` posture of an active top-level agent (§2.7, §9.0): what the
 * decision point does with a call NOT on the allow list. Defaults to `ask` (the
 * `chat` posture) for any agent that does not declare one (fail safe — never
 * auto-approve by omission). A worker definition carries no `unlisted`; a worker
 * inherits the live top-level agent's posture (§9.7), resolved by the caller.
 */
export function unlistedOf(def: AgentDefinition | undefined): "deny" | "ask" | "allow" {
  return def?.unlisted ?? "ask";
}

/**
 * Whether a top-level agent may dispatch a worker by name (§2.7(c), §3.1): the
 * agent's `workers` list is an allow list of worker names, or the literal
 * `"all"`. A `chat`-like agent with no `workers` declared defaults to `"all"`
 * (the built-in `chat` declares `workers: "all"`). Dispatching a worker not in
 * the list is denied before anything is created (§3.1).
 */
export function workerAllowed(def: AgentDefinition | undefined, worker: string): boolean {
  const list = def?.workers;
  if (list === undefined || list === "all") return true;
  return list.includes(worker);
}

/**
 * Assert a worker's resolved toolset holds no `task` tool (§7.1, substrate
 * assumption 2). A worker that could dispatch would make recursion possible, so
 * such a definition is rejected at registration. Returns the offending tool
 * name when present, else null.
 */
export function findDispatchTool(tools: { name: string }[]): string | null {
  const bad = tools.find((t) => t.name === TASK_TOOL_NAME);
  return bad ? bad.name : null;
}

/**
 * Validate an agent definition for worker compilation (§7.1). Rejects any
 * definition whose declared toolset names the dispatch tool. Pure; the use-case
 * resolves names to instances and re-checks the resolved set.
 */
export function assertWorkerToolset(def: AgentDefinition): void {
  if (def.tools.includes(TASK_TOOL_NAME)) {
    throw new Error(
      `agent "${def.name}" declares the "${TASK_TOOL_NAME}" dispatch tool; workers cannot dispatch (§7.1)`,
    );
  }
}

/** Re-check resolved tool instances before compiling a worker (§7.1). */
export function assertResolvedWorkerTools(name: string, tools: StructuredToolInterface[]): void {
  const bad = findDispatchTool(tools);
  if (bad) {
    throw new Error(
      `worker "${name}" resolved a "${bad}" dispatch tool; workers cannot dispatch (§7.1)`,
    );
  }
}
