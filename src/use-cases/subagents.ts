/**
 * The Subagents use-case (core-blueprint.md §7).
 *
 * The orchestrator fans out isolated workers, each in its own git worktree
 * (§7.3), converges their results, dispatches a distinct read-only reviewer in
 * fresh context (§7.5), and applies work through the two gates — the reviewer's
 * required PASS and then the Guardian-gated merge, with a fan-out grant that
 * auto-approves the fan-out's merges (§7.5, §9.5). A Warden deny is final and
 * runs before Guardian; a hard deny is never overridden by a grant.
 *
 * Workers are compiled WITHOUT the subagent/`task` middleware, so a worker holds
 * no dispatch tool and recursion is structurally impossible (§7.1, substrate
 * assumption 2); registration asserts this and rejects a bad definition. Each
 * worker runs under its own `subagentRecursionLimit` as its LangGraph
 * `recursionLimit` (§7.2, §3.6); fan-out concurrency is bounded by
 * `turnMaxConcurrency` (the LangGraph `maxConcurrency` option, substrate
 * assumption 7). A single shared `AbortSignal` reaches every worker, so a cancel
 * mid-fan-out aborts them all and preserves their worktrees as recovery
 * artifacts (§3.3, §15.1#1).
 *
 * The use-case may depend on LangChain/LangGraph (§1 rule 4); no such type
 * crosses the facade — the facade reads the DTOs in `entities/subagents.ts`.
 */
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { createAgent, createMiddleware } from "langchain";
import type { ResponseFormat } from "langchain";
import {
  validateResponseSchema,
  selectStrategy,
  validateStructuredValue,
} from "../entities/structured-output.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { LocalShellBackend } from "deepagents";
import {
  overflowGuardSpec,
  contextOverflowOf,
  type ContextOverflow,
} from "../entities/context/model-guard.js";
import { workerUsageSpec } from "../entities/context/worker-usage.js";
import { CoreErrorException, coreError, ErrorCode } from "../entities/errors.js";
import { Guardian, type GuardedCall, type ShellLists } from "../entities/guardian.js";
import { Warden } from "../entities/warden.js";
import type { EventBus } from "../entities/event-bus.js";
import type { ToolRegistry } from "../entities/tool-registry.js";
import type { Config, PermissionRule } from "../config/schema.js";
import type { ApprovalResponse, PendingApproval } from "../entities/approvals.js";
import type { ApprovalMode } from "../entities/session.js";
import type { VcsPort, Worktree } from "../entities/ports/vcs-port.js";
import type { StagingApplyResult, StagingPort } from "../entities/ports/staging-port.js";
import { buildCoreTools, buildStagedTools, buildMcpModelTools, buildPluginModelTools } from "../tools/builtin.js";
import { buildWebTools } from "../tools/web-tools.js";
import { buildResearchNotesTool } from "../tools/research-notes.js";
import { fenceSummary } from "../tools/task-tool.js";
import { stripUnsafeCharsKeepWhitespace } from "../entities/untrusted-text.js";
import type { HttpPort } from "../entities/ports/http-port.js";
import type { FileSystemPort } from "../entities/ports/host.js";
import type { ProviderHandler } from "./web-search.js";
import { maskSecrets, maskText } from "./secret-mask.js";
import { resolveRules } from "./engine.js";
import { hostAllowedByExact } from "../entities/exact-allow.js";
import { METADATA_HOSTS_ID } from "../entities/never-list.js";
import { LoopHealth, type LoopHealthLimits } from "../entities/loop-health.js";
import { limitDefault } from "../entities/limits.js";
import { limitMarker, type LimitsPort } from "../entities/ports/limits-port.js";
import type { RunCache, RunCacheKind } from "../entities/ports/run-cache.js";
import {
  createDecisionMiddleware,
  computeForceAskFields,
  type AskRequest,
  type AskResolution,
  type CallerContext,
  type DecisionPointDeps,
} from "./decision-point.js";
import {
  assertResolvedWorkerTools,
  assertWorkerToolset,
  deriveAgentClass,
  toolMatchesAgentList,
  unlistedOf,
  workerAllowed,
  TASK_TOOL_NAME,
  type AgentDefinition,
  type AgentToolInfo,
  type WorkerInfo,
  type WorkerResult,
  type WorkerStatus,
  type WorkerStreamEvent,
  type WorkInFlight,
} from "../entities/subagents.js";

/**
 * The single source of truth for the reviewer's read-only allowed tool set
 * (§7.5). A reviewer runs in fresh context with reads only; this security-
 * relevant invariant has one definition so `resolveTools()` and `buildWorker()`
 * cannot drift apart.
 */
export const REVIEWER_READONLY_TOOLS = ["read_file", "glob_files", "workspace_map", "search_contents"] as const;

/** A single worker's dispatch request (§7.2). */
export interface DispatchRequest {
  agent: string;
  task: string;
  /** The batch task id (§7.2 batch form), present when this request is one entry
   * of a `task` batch. Stamped onto the resulting `WorkerInfo.taskId` so the tool
   * keys the consolidated result back by id. Absent for a direct single dispatch. */
  id?: string;
  /** Ids of OTHER requests in the same batch that must finish (status `merged`/
   * `reviewed`/`succeeded`) before this one starts (§7.2). A failed or cancelled
   * dependency marks this request `skipped`. Resolved only within the batch; the
   * task-tool has already validated the ids, acyclicity, and the allowance. */
  dependsOn?: string[];
  /** §3.8 — an optional per-dispatch result schema (Zod or JSON Schema). When
   * present, the worker runs with a `responseFormat` and its typed result is
   * JSON-serialized into the tool result that converges to the orchestrator. */
  resultSchema?: unknown;
  /**
   * §8.7 — an INTERNAL dispatch for the fixed seeded `summarizer` worker (the
   * Ingest fan-out). When set, the active agent's `workers` allowance is NOT
   * consulted for THIS request (the ingest path dispatches `summarizer`
   * regardless of what the model's agent lists), but EVERY other gate still
   * applies (posture is moot — `summarizer` is read-class, so no write dispatch;
   * isolation, cancel, the fan-out grant, journal/obs are unchanged). The
   * model-callable `task` tool NEVER sets this, so a model cannot widen its own
   * dispatch surface. Guarded to the literal `summarizer` agent so it can lift
   * nothing else.
   */
  internal?: boolean;
}

/** The outcome of a whole fan-out (§7.2, §7.5). */
export interface FanoutResult {
  fanoutId: string;
  workers: WorkerInfo[];
}

export interface SubagentsDeps {
  chatModel: BaseChatModel;
  guardian: Guardian;
  warden: Warden;
  bus: EventBus;
  vcs: VcsPort;
  /** §13.11 — the limits port. When present the task caps (brief, dep summary,
   * journal fan-out) are read from the registry and a LIMIT_HIT is emitted on a
   * clip. Absent → registry defaults (byte-identical to the old constants). */
  limits?: LimitsPort;
  /** §7.2 — the run cache for pass-by-reference. When present a dependency
   * summary or dependent brief over its bound is stored whole and the dependent
   * receives a head + handle readable with `read_file` rather than a mid-text
   * clip; absent → the inline clip + marker fallback. */
  runCache?: RunCache;
  /** The durable staging layer for the no-repo writer path (§7.4). */
  staging: StagingPort;
  getConfig: () => Config;
  workspaceRoot: string;
  /** §8.4/§9.4 — the global config dir and home, forwarded to the worker's
   * decision point for control-file classification. */
  globalConfigDir?: string;
  home?: string;
  sessionId: string;
  /**
   * The id of the session that OWNS this fan-out's worktrees/staging folders
   * (§5.8). Recorded in each worktree `.meta.json` and staging manifest so
   * `session.delete` can prove ownership before removing them. The subagents
   * instance is shared and long-lived while the active session changes, so this
   * is resolved per dispatch; it falls back to `sessionId` when unset.
   */
  getOwnerSessionId?: () => string;
  /**
   * Whether approvals can be resolved interactively. A non-interactive worker
   * (unattended routine, §9.5) that reaches an unresolved approval fails fast
   * unless its scope was declared trusted up front (§7.5).
   */
  interactive: boolean;
  /** Scopes declared trusted up front for a non-interactive run (§7.5). */
  trustedScopes?: Set<string>;
  /**
   * The orchestrator session's live Guardian rules (§9.2). The merge gate
   * resolves against the SAME ruleset the engine's decision point uses — config
   * permissions PLUS these session-scoped rules — so a session-scoped
   * `merge_worktree` rule binds the merge exactly as it binds every other write
   * (§15.1#4). Absent (undefined) means no session layer: config rules only.
   */
  getSessionRules?: () => PermissionRule[];
  /**
   * The model for the read-only reviewer (§7.5). The reviewer runs in fresh
   * context, distinct from the worker; a separate model keeps the reviewer's
   * verdict independent of the worker. Falls to `chatModel` when unset.
   */
  reviewerModel?: BaseChatModel;
  /**
   * Resolve a per-agent model endpoint KEY (`AgentDefinition.model`, a string)
   * to a bound model (§11, invariant 14). The public DTO carries only the string
   * key; this construction-time seam does the LangChain-typed resolution
   * internally, so no library type crosses the method surface. Returns undefined
   * for an unknown key, which registration rejects as `MODEL_NOT_CONFIGURED`.
   * Absent means every agent uses the single active endpoint.
   */
  resolveModel?: (key: string) => BaseChatModel | undefined;
  /**
   * The §8.1 tool registry — the SAME one the engine's decision point reads for
   * read-only classification and unknown-tool reject (§15.1#4). A worker's tool
   * calls pass through the shared decision point built from it.
   */
  registry: ToolRegistry;
  /** The §8.2 temp-dir prefix the write guardrail blocks (§9.4). */
  tempDir: string;
  /** The resolved endpoint window, for a worker's §8.3 result eviction. */
  window: number;
  /**
   * The resolved endpoint output reservation (§4.8), for the shared §4.10
   * overflow guard a worker's model call passes through. When both the window
   * and this are known (>0), a worker request that would overflow is refused
   * with `CONTEXT_OVERFLOW` and the model is never called (invariant 9). Null
   * when the endpoint does not declare it (the guard is then a no-op).
   */
  maxOutputTokens?: number | null;
  /** The managed-layer gate (§13.5): a worker's gated call is denied with
   * `managed_layer_unavailable` while the managed layer is unavailable. */
  managedGate?: () => { reason: string } | null;
  /**
   * Persist a worker's FULL masked evicted result under the PARENT session's
   * cache dir (§8.3, §7): a worker never writes outside
   * `.voidrift/cache/session/<parentId>/`. Absent disables eviction.
   */
  writeEvictedResult?: (sessionId: string, name: string, content: string) => Promise<void>;
  /** The orchestrator session's current approval mode (§9.5), resolved per
   * dispatch; drives how a worker's `ask` fails fast or pauses. Defaults to
   * interactive when unset. */
  getApprovalMode?: () => ApprovalMode;
  /**
   * The mutation journal recorder (§10.11). A worker's writes journal into the
   * SESSION's journal (via the shared decision point: `sessionId` is the session
   * and `workerId` the worker), with the worktree-relative target. Present when
   * a journal is wired by boot; absent disables worker journaling. */
  journal?: import("./journal-recorder.js").JournalRecorder;
  /** Read a file target's RAW before-state bytes relative to the worker's tree
   * root (§10.11), null when it does not exist. Present with `journal`. */
  readWorkerTargetBytes?: (rootDir: string, relPath: string) => Promise<Buffer | null>;
  /** §10.11/§9.5.1 — the active plan-scope id a worker's journaled write stamps
   * as its `planStep` (recorded metadata ONLY — it influences NO permission,
   * scope, approval or loop decision, invariant 27), so the surprise seam binds
   * a scope's prediction to the writes a dispatched worker drove (plan steps are
   * commonly executed by workers). Undefined → no plan-scope grant is live and
   * the worker's entry carries no `planStep`. */
  getActiveScopeId?: () => string | undefined;
  /**
   * The orchestrator session's CURRENT active top-level agent (§2.7), read LIVE
   * per dispatch/tool call so a worker runs under the PARENT session's active
   * agent and can never loosen it (§9.7): a worker under an `unlisted: deny`
   * agent is denied writes too, a worker under an `unlisted: allow` agent
   * inherits the auto-approve posture, and the agent's `workers` allow list
   * gates which workers may be dispatched (§3.1). Omitted → the built-in `chat`
   * (an `ask` agent with `workers: "all"`). */
  getActiveAgent?: () => AgentDefinition | undefined;
  /** The effective (cascaded) `webSearch` config, so a worker's `web_search`
   * is gated against the same endpoint as the orchestrator's (§8.2, §9.3).
   * Absent → the gate reads config directly. */
  resolveWebSearch?: () => import("../config/schema.js").WebSearchConfig;
  /**
   * The HTTP seam a worker's `web_fetch`/`web_search` reach the network through
   * (§8.2) — the SAME `HttpPort` the orchestrator's engine uses, so a worker's
   * web calls run over the SAME SSRF controls, DNS/redirect re-checks, timeout,
   * and masking. A worker binds the web tools only when its definition lists
   * them; absent means no web tool is bound (a pure in-memory test with no
   * network). Web tools are READ tools (§3.1): they create no isolation.
   */
  http?: HttpPort;
  /** §8.6 — a `FileSystemPort` rooted at the REAL session workspace root (NOT a
   * worker worktree), over which a worker's `researcher_save_notes` writes land
   * in the user's tree confined to `findingsDirectories`. A worker binds the tool
   * only when its definition lists it; absent means it is not bound. */
  notesFileSystem?: FileSystemPort;
  /** Plugin-registered web-search providers merged over the built-ins (§8.5),
   * so a worker's `web_search` reaches the same providers as the orchestrator. */
  webSearchProviders?: () => Record<string, ProviderHandler>;
  /**
   * Surface a worker's `ask` as a §9.5 PendingApproval carrying `workerId` and
   * the FULL action, and resolve it (interactive host callback / durable
   * `out_of_band` pause resumed by `session.confirm`). Absent means no
   * interactive resolution is possible, so an unresolved ask fails fast.
   */
  requestWorkerApproval?: (pending: PendingApproval) => Promise<ApprovalResponse>;
}

interface LiveWorker {
  workerId: string;
  agent: string;
  status: WorkerStatus;
  summary?: string;
  worktree?: Worktree;
  /** The worker's staging run id, with no repo (§7.4). */
  staging?: string;
  recoveryBranch?: string;
  pendingApproval: boolean;
  stream: WorkerStreamEvent[];
  /** The batch task id this worker ran (§7.2 batch form), or undefined for a
   * direct single dispatch with no per-request id. */
  taskId?: string;
}

/** The §8.2 shell tool a staged worker cannot hold (§7.4 no-shell limit, D5). */
const SHELL_TOOL = "execute_command";

/**
 * §13.11 — the task caps are registry keys read via the injected `LimitsPort`:
 *   task.briefMaxChars (TASK1), task.depSummaryMaxChars (TASK3),
 *   task.journalFanoutMaxPaths (TASK5).
 * `JOURNAL_FANOUT_MAX_PATHS` stays a harness invariant but is now sourced from
 * the registry default so there is one place to see every rigid limit.
 */

let fanoutSeq = 0;
let workerSeq = 0;
let workerApprovalSeq = 0;

export class Subagents {
  /** Registered worker definitions, by name (§7.1). */
  private readonly agents = new Map<string, AgentDefinition>();
  /** Live workers across fan-outs, by worker id (§7.2). */
  private readonly workers = new Map<string, LiveWorker>();
  /** The one shared abort controller per fan-out (§3.3). */
  private readonly controllers = new Map<string, AbortController>();
  /**
   * A merge critical section (§7.5). Merges touch the shared base working tree,
   * so they apply sequentially — one at a time — even when workers converge in
   * parallel. This serializes `git merge` against the base and closes the
   * index.lock race, mirroring §7.4's per-run critical section for staged apply.
   */
  private mergeChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SubagentsDeps) {}

  /** §13.11 — the effective value of a limit key (the port when wired, else the
   * registry default). One place so every task cap is registry-backed. */
  private limit(key: string): number {
    return this.deps.limits ? this.deps.limits.get(key) : limitDefault(key);
  }

  /** The session that owns a dispatched worker's worktree/staging folder (§5.8),
   * resolved per dispatch; falls back to the construction `sessionId`. */
  private ownerSessionId(): string {
    return this.deps.getOwnerSessionId?.() ?? this.deps.sessionId;
  }

  /** Run `fn` inside the merge critical section (§7.5). */
  private serializeMerge<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mergeChain.then(fn, fn);
    // Keep the chain alive regardless of fn's outcome.
    this.mergeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Register a worker agent definition (§7.1). Rejects any definition whose
   * declared toolset names the dispatch tool, and re-checks the resolved tool
   * instances, so a worker can never dispatch (substrate assumption 2).
   */
  register(def: AgentDefinition): void {
    // §7.1 — the no-task-tool rule binds WORKERS; top-level agents (the
    // orchestrators: chat/research/vibe) hold `task` by design. A programmatic
    // registration with no `kind` is treated as a worker (fail closed).
    const isWorker = def.kind !== "top-level";
    if (isWorker) {
      assertWorkerToolset(def);
      const resolved = this.resolveTools(def);
      assertResolvedWorkerTools(def.name, resolved);
    }
    // §11 / invariant 14 — a per-agent `model` is a config endpoint key. An
    // unknown key is rejected at registration with a typed MODEL_NOT_CONFIGURED
    // (only when a resolver is wired; absent means the single active endpoint).
    if (def.model && this.deps.resolveModel && this.deps.resolveModel(def.model) === undefined) {
      throw new CoreErrorException(
        coreError(ErrorCode.MODEL_NOT_CONFIGURED, `agent "${def.name}" references unknown model endpoint "${def.model}"`, { field: "model" }),
      );
    }
    this.agents.set(def.name, def);
    this.deps.bus.emit("AGENT_REGISTERED", { name: def.name }, { session: this.deps.sessionId });
  }

  /** List live workers (§7.2). */
  list(): WorkerInfo[] {
    return [...this.workers.values()].map((w) => this.toInfo(w));
  }

  /** A worker's status (§7.2). */
  status(workerId: string): WorkerInfo | null {
    const w = this.workers.get(workerId);
    return w ? this.toInfo(w) : null;
  }

  /** A worker's live stream, keyed by worker id (§7.2). */
  stream(workerId: string): WorkerStreamEvent[] {
    return this.workers.get(workerId)?.stream ?? [];
  }

  /** Every registered agent definition, in stable name order (§3.1, §2.2). */
  definitions(): AgentDefinition[] {
    return [...this.agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A registered agent definition by name, or null (§2.2 `agents.get`). */
  getDefinition(name: string): AgentDefinition | null {
    return this.agents.get(name) ?? null;
  }

  /** Remove a registered agent definition (§2.2 `agents.deactivate`). Returns
   * whether a definition was present. */
  removeDefinition(name: string): boolean {
    return this.agents.delete(name);
  }

  /**
   * Drop every definition that carries a cascade `source` (built-in, global, or
   * project) ahead of a reindex (§3.1/§12.1), so a removed agent directory
   * disappears. Programmatic/plugin registrations (no `source`) are kept — they
   * are not rediscovered. */
  clearDiscovered(): void {
    for (const [name, def] of this.agents) {
      if (def.source !== undefined) this.agents.delete(name);
    }
  }

  /** The resolved tool definitions an agent would run with (§8.1 `agents.tools`),
   * read-only reviewers resolving to the read-only set (§7.5).
   *
   * The ACTIVE top-level agent's EFFECTIVE tool set for the `/tools` panel
   * (FX-F): resolved from the SAME registry the engine binds from (built-ins +
   * plugin tools + APPROVED MCP tools), filtered by the agent's `tools` list
   * through `toolMatchesAgentList` so `"*"`, a glob (`mcp_*`), and an exact name
   * all expand correctly (the old plain-Set match returned `[]` for `["*"]`).
   * A read-only reviewer resolves to the read-only built-ins. Each row carries
   * its `origin` and whether it is allow-listed (`allow`) or will `ask` — purely
   * descriptive, never a permission input (§9).
   */
  resolvedTools(name: string): AgentToolInfo[] {
    const def = this.agents.get(name);
    if (!def) return [];
    const defs = this.deps.registry.list();
    const mcpBindable = new Set(this.deps.registry.mcpModelEntries().map((e) => e.def.name));
    const rules = Object.values(this.deps.getConfig().permissions ?? {});
    // A tool runs WITHOUT asking when a permission rule allows it by name with
    // no command pattern (or a `*` pattern), i.e. a plain tool-level allow. The
    // seeded list frees the read-class tools this way (§13.8). Exact-command
    // allows (an `execute_command` pattern) gate specific commands, not the tool
    // as a whole, so they do not flip a tool to "allow" here.
    const allowListed = (tool: string): boolean =>
      rules.some((r) => r.decision === "allow" && r.tool === tool && (r.pattern === undefined || r.pattern === "*"));

    const rows: AgentToolInfo[] = [];
    for (const d of defs) {
      const origin = (d.origin ?? "builtin") as AgentToolInfo["origin"];
      // An MCP tool that is not yet APPROVED/bindable is a quarantine stub — not
      // part of the agent's effective, callable set (§8.4). Skip it.
      if (origin === "mcp" && !mcpBindable.has(d.name)) continue;
      // A reviewer resolves to the read-only built-ins only (§7.5); otherwise the
      // agent's own `tools` list decides (the engine never filters out `task`).
      const matched = def.reviewer
        ? d.readOnly && origin === "builtin"
        : d.name === TASK_TOOL_NAME || toolMatchesAgentList(d.name, def.tools);
      if (!matched) continue;
      // §9 — a read-class built-in/plugin tool is free at the gate; an approved
      // MCP tool's Guardian ask is skipped when it is read-only. Everything else
      // asks unless a plain tool-level allow rule frees it.
      const free = allowListed(d.name) || (d.readOnly && origin !== "mcp") || (origin === "mcp" && d.readOnly);
      rows.push({
        name: d.name,
        description: d.description ?? "",
        origin,
        status: free ? "allow" : "ask",
      });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** What resume restores about dispatched workers (§7.2, §5.3). */
  workInFlight(): WorkInFlight {
    return {
      workers: [...this.workers.values()].map((w) => ({
        workerId: w.workerId,
        status: w.status,
        ...(w.worktree ? { worktree: w.worktree.path } : {}),
        ...(w.staging ? { staging: w.staging } : {}),
      })),
    };
  }

  /**
   * Fan out a batch of workers, converge, verify, and apply through the two
   * gates (§7.2, §7.5). Concurrency is bounded by `turnMaxConcurrency` unless
   * the caller passes an explicit `maxConcurrency` (the ingest fan-out passes its
   * own `effectiveIngestParallel` cap, §8.7) — the value is clamped to [1, …].
   * A fan-out grant is opened at dispatch and cleared when the fan-out concludes.
   * An optional `externalSignal` (the turn's `AbortSignal`, §3.3) aborts this
   * fan-out's workers when it fires, so a session cancel reaches a worker
   * dispatched by the model-callable `task` tool (§7, §15.1#1).
   */
  async dispatch(
    requests: DispatchRequest[],
    externalSignal?: AbortSignal,
    maxConcurrency?: number,
  ): Promise<FanoutResult> {
    const fanoutId = `fanout-${(++fanoutSeq).toString(36)}`;
    const controller = new AbortController();
    this.controllers.set(fanoutId, controller);
    // Link the turn's signal: an already-aborted or later-aborting external
    // signal aborts this fan-out's shared controller (cancel semantics §15.1#1).
    const onExternalAbort = (): void => this.cancel(fanoutId);
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
    // §7.5 / §9.5 — the fan-out grant auto-approves this fan-out's merges, bounded
    // to the fan-out and cleared when it concludes.
    this.deps.guardian.grantFanout(fanoutId);
    this.deps.bus.emit("FANOUT_STARTED", { fanoutId, count: requests.length }, { session: this.ownerSessionId() });

    const concurrency = Math.max(1, maxConcurrency ?? this.deps.getConfig().turnMaxConcurrency);
    const liveWorkers: LiveWorker[] = [];
    try {
      await this.runBatch(fanoutId, requests, concurrency, controller.signal, liveWorkers);
    } finally {
      if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
      this.deps.guardian.clearFanout(fanoutId);
      this.controllers.delete(fanoutId);
      this.deps.bus.emit("FANOUT_CONCLUDED", { fanoutId }, { session: this.ownerSessionId() });
    }
    // Return in the GIVEN request order (§7.2) so the consolidated result matches
    // the batch declaration regardless of completion order.
    const byTask = new Map<string, LiveWorker>();
    const unkeyed: LiveWorker[] = [];
    for (const w of liveWorkers) {
      if (w.taskId !== undefined) byTask.set(w.taskId, w);
      else unkeyed.push(w);
    }
    const ordered: LiveWorker[] = requests.map((req, i) =>
      req.id !== undefined ? byTask.get(req.id) ?? unkeyed[i]! : unkeyed[i] ?? liveWorkers[i]!,
    );
    return { fanoutId, workers: (ordered.every(Boolean) ? ordered : liveWorkers).map((w) => this.toInfo(w)) };
  }

  /**
   * Run a fan-out batch honoring the intra-batch dependency graph (§7.2). Tasks
   * with no unmet dependency start together, bounded by a REAL semaphore sized to
   * `turnMaxConcurrency` (never a `Promise.all` of everything). A dependent starts
   * only once ALL its dependencies have finished, its brief prefixed with their
   * bounded summaries; a dependency that failed or was cancelled marks the
   * dependent `skipped` without dispatching it, and its siblings are unaffected.
   * Every task settles — no rejection escapes — so the whole batch always returns.
   *
   * A batch with no `dependsOn` and no `id` (a direct `api.subagents.dispatch`)
   * reduces to a flat bounded fan-out: every task is immediately ready.
   */
  private async runBatch(
    fanoutId: string,
    requests: DispatchRequest[],
    concurrency: number,
    signal: AbortSignal,
    out: LiveWorker[],
  ): Promise<void> {
    // Index by id so dependents can read their dependencies' outcomes. A request
    // with no id (direct dispatch) uses its array index as a synthetic key so the
    // bookkeeping is uniform; such a request can never be depended upon.
    const keyOf = (req: DispatchRequest, i: number): string => req.id ?? `#${i}`;
    const outcomes = new Map<string, { done: boolean; ok: boolean; worker: LiveWorker }>();
    const settled = new Map<string, Promise<void>>();

    // A real counting semaphore: at most `concurrency` workers run at once (§7.2).
    let active = 0;
    const waiters: (() => void)[] = [];
    const acquire = async (): Promise<void> => {
      if (active < concurrency) {
        active++;
        return;
      }
      await new Promise<void>((resolve) => waiters.push(resolve));
      active++;
    };
    const release = (): void => {
      active--;
      const next = waiters.shift();
      if (next) next();
    };

    const runTask = async (req: DispatchRequest, i: number): Promise<void> => {
      const key = keyOf(req, i);
      const deps = req.dependsOn ?? [];
      // Wait for every dependency to settle (they are the same batch, validated
      // acyclic by the task-tool, so this never deadlocks).
      await Promise.all(deps.map((d) => settled.get(d) ?? Promise.resolve()));

      // A failed/cancelled dependency skips this task WITHOUT dispatching it; its
      // siblings are unaffected (§7.2).
      const failedDep = deps.find((d) => outcomes.get(d)?.ok === false);
      if (failedDep) {
        const w = this.newWorker(fanoutId, req.agent, req.id);
        w.summary = `skipped: dependency "${failedDep}" did not complete`;
        this.transition(w, "skipped");
        outcomes.set(key, { done: true, ok: false, worker: w });
        out.push(w);
        return;
      }
      // An already-fired cancel skips an unstarted task (§7.2 / §3.3).
      if (signal.aborted) {
        const w = this.newWorker(fanoutId, req.agent, req.id);
        this.transition(w, "aborted");
        outcomes.set(key, { done: true, ok: false, worker: w });
        out.push(w);
        return;
      }

      // Prefix the finished dependencies' bounded summaries into the brief (§7.2).
      const prefixed = this.prefixDependencySummaries(req, deps, outcomes);
      // §13.11 deny: a dependency summary over its deny cap fails this stage and
      // does NOT deliver the oversize content; siblings are unaffected.
      if ("deny" in prefixed) {
        const w = this.newWorker(fanoutId, req.agent, req.id);
        w.summary = `failed: ${prefixed.deny}`;
        this.transition(w, "failed");
        outcomes.set(key, { done: true, ok: false, worker: w });
        out.push(w);
        return;
      }
      const brief = prefixed.brief;

      await acquire();
      let w: LiveWorker;
      try {
        w = await this.runWorker(fanoutId, { ...req, task: brief }, signal, req.id);
      } finally {
        release();
      }
      const ok = w.status === "merged" || w.status === "reviewed" || w.status === "succeeded";
      outcomes.set(key, { done: true, ok, worker: w });
      out.push(w);
    };

    // Register every task's settled promise first (so a dependent can await a
    // dependency that starts later), then let the scheduler run them all; the
    // semaphore — not registration order — bounds how many run at once.
    requests.forEach((req, i) => settled.set(keyOf(req, i), runTask(req, i)));
    await Promise.all(settled.values());
  }

  /** Store sanitized worker text WHOLE in the run cache and emit one
   * BY_REFERENCE trail record (§7.2, §14.6). The stored copy is DATA the
   * dependent reads later via `read_file`; it is stripped of terminal-/spoof
   * chars and secret-masked before storage. Returns the handle + byte size, or
   * null when no run cache is wired (the caller falls back to the inline clip). */
  private storeByRef(kind: RunCacheKind, raw: string, what: string, key: string): { handle: string; bytes: number } | null {
    if (!this.deps.runCache) return null;
    const safe = maskText(stripUnsafeCharsKeepWhitespace(raw));
    const { handle, bytes } = this.deps.runCache.store(kind, safe);
    this.deps.bus.emit("BY_REFERENCE", { what, bytes, key }, { session: this.ownerSessionId() });
    return { handle, bytes };
  }

  /** Prefix a dependent's dependencies' bounded summaries into its brief (§7.2).
   * Within `task.depSummaryMaxChars` a summary passes whole; over it, with a run
   * cache wired, the WHOLE summary is stored and the dependent gets the bounded
   * head plus a `read_file` handle (never a mid-text cut), else the inline clip +
   * marker. The combined brief is likewise bounded at `task.briefMaxChars` by
   * reference. A LIMIT_HIT fires once per site. */
  private prefixDependencySummaries(
    req: DispatchRequest,
    deps: string[],
    outcomes: Map<string, { worker: LiveWorker }>,
  ): { brief: string } | { deny: string } {
    if (deps.length === 0) return { brief: req.task };
    const depMax = this.limit("task.depSummaryMaxChars");
    const briefMax = this.limit("task.briefMaxChars");
    const session = this.ownerSessionId();
    const parts: string[] = [];
    for (const d of deps) {
      // §8.2 — a dependency's summary is untrusted model text: strip terminal-/
      // spoof-dangerous characters and fence it as clearly delimited DATA so a
      // forged instruction/result row inside it cannot be read as authority in
      // the dependent's brief. §7.2 — over task.depSummaryMaxChars pass by
      // reference (store whole + handle) rather than clip; emit one LIMIT_HIT.
      const rawSummary = outcomes.get(d)?.worker.summary ?? "";
      let clipped = rawSummary.slice(0, depMax);
      if (rawSummary.length > depMax) {
        const r = this.deps.limits?.hit("task.depSummaryMaxChars", rawSummary.length, { what: `dependency "${d}" summary truncated`, session });
        // §13.11 deny: the dependent stage fails and the oversize summary is NOT
        // delivered; the caller marks the worker failed with this notice.
        if (r?.action === "deny") return { deny: r.notice };
        const stored = this.storeByRef("dep-summary", rawSummary, `dependency "${d}" summary`, "task.depSummaryMaxChars");
        clipped += stored
          ? `\n[summary continues: ${stored.bytes} bytes at ${stored.handle} — read it with read_file]`
          : `\n${limitMarker("task.depSummaryMaxChars", rawSummary.length)}`;
      }
      const summary = fenceSummary(clipped);
      if (summary) parts.push(`Result of "${d}":\n${summary}`);
    }
    if (parts.length === 0) return { brief: req.task };
    const combined = `${parts.join("\n\n")}\n\n${req.task}`;
    if (combined.length <= briefMax) return { brief: combined };
    this.deps.limits?.hit("task.briefMaxChars", combined.length, { what: "dependent brief truncated", session });
    const stored = this.storeByRef("brief", combined, "dependent brief", "task.briefMaxChars");
    return { brief: combined.slice(0, briefMax) + (stored
      ? `\n[brief continues: ${stored.bytes} bytes at ${stored.handle} — read it with read_file]`
      : `\n${limitMarker("task.briefMaxChars", combined.length)}`) };
  }

  /** §7 — the engine's `task` tool entry point: fan out from a live turn with
   * the turn's `AbortSignal`. A thin alias over `dispatch` so the facade exposes
   * a turn-scoped name distinct from the direct `api.subagents.dispatch`. */
  async dispatchFromTurn(
    requests: DispatchRequest[],
    signal?: AbortSignal,
    maxConcurrency?: number,
  ): Promise<FanoutResult> {
    return this.dispatch(requests, signal, maxConcurrency);
  }

  /** Cancel a fan-out: abort every worker through the one shared signal and
   * preserve their worktrees as recovery artifacts (§3.3, §15.1#1). */
  cancel(fanoutId: string): void {
    const controller = this.controllers.get(fanoutId);
    if (controller) controller.abort();
    for (const w of this.workers.values()) {
      if (w.status === "running") {
        this.transition(w, "aborted");
        if (w.worktree) this.deps.vcs.preserveWorktree(w.worktree); // preserve, do not delete
      }
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private resolveTools(def: AgentDefinition): StructuredToolInterface[] {
    // Build the §8.2 core tools over a backend; the worker's worktree roots it
    // at dispatch time. Reviewers get read tools only (§7.5).
    const backend = new LocalShellBackend({ rootDir: this.deps.workspaceRoot });
    const cfg = this.deps.getConfig();
    const all = buildCoreTools(backend, {
      workspaceMaxReadLines: cfg.workspaceMaxReadLines,
      workspaceMapDepth: cfg.workspaceMapDepth,
      toolWaitMaxSeconds: cfg.toolWaitMaxSeconds,
      ...(this.deps.limits ? { limits: this.deps.limits } : {}),
      readGuard: {
        ctx: {
          workspaceRoot: this.deps.workspaceRoot,
          ...(this.deps.globalConfigDir ? { globalConfigDir: this.deps.globalConfigDir } : {}),
          ...(this.deps.home ? { home: this.deps.home } : {}),
        },
        sessionId: () => this.ownerSessionId(),
      },
    });
    const allowed = def.reviewer
      ? new Set<string>(REVIEWER_READONLY_TOOLS)
      : new Set(def.tools);
    const tools = all.filter((t) => allowed.has(t.name));
    // §8.2 — a worker that lists `web_fetch`/`web_search` binds them too (the
    // researcher's web tools), over the SAME HttpPort path. A reviewer never does.
    if (!def.reviewer) {
      for (const t of this.webToolsFor(def, backend)) tools.push(t);
      for (const t of this.notesToolFor(def)) tools.push(t);
    }
    return tools;
  }

  /**
   * Build the §8.2 web tools (`web_fetch`/`web_search`) a worker's definition
   * lists, over the SAME `HttpPort` seam the orchestrator uses (§8.2, §15.1#4) —
   * the SAME SSRF controls, DNS/redirect re-checks, timeout, and masking, gated
   * at the SAME single decision point (worker context, session mode, the §13.9
   * configured-search-endpoint exemption for `web_search` only). A worker that
   * does not list them gets none; with no `http` seam (an in-memory test) none
   * are bound. Web tools are READ tools and create no isolation (§3.1).
   */
  private webToolsFor(def: AgentDefinition, backend: LocalShellBackend): StructuredToolInterface[] {
    if (!this.deps.http) return [];
    const listed = new Set(def.tools);
    if (!listed.has("web_fetch") && !listed.has("web_search")) return [];
    const built = buildWebTools({
      http: this.deps.http,
      backend,
      timeoutMs: this.deps.getConfig().webFetchTimeoutMs,
      mask: maskText,
      ...(this.deps.limits ? { limits: this.deps.limits } : {}),
      resolveWebSearch: () => this.deps.resolveWebSearch?.() ?? this.deps.getConfig().webSearch,
      // owner D2a — a worker honors the SAME exact/cidr host lift as the
      // orchestrator (config permissions + the parent session rules).
      allowHost: (host) =>
        hostAllowedByExact(host, resolveRules(this.deps.getConfig(), this.deps.getSessionRules?.() ?? [])),
      // owner D2c — metadata hosts are never-liftable unless `metadata-hosts` is
      // in the honored unlock (config.unlock is already only global/managed).
      metadataUnlocked: this.deps.getConfig().unlock.includes(METADATA_HOSTS_ID),
      ...(this.deps.webSearchProviders ? { extraProviders: () => this.deps.webSearchProviders!() } : {}),
      onSearchWarning: () => {
        this.deps.bus.emit("WARNING_EMITTED", { category: "fallback", source: "web" }, { session: this.ownerSessionId() });
      },
    });
    return built.filter((t) => listed.has(t.name));
  }

  /**
   * Build the §8.6 `researcher_save_notes` tool a worker's definition lists, over
   * a `FileSystemPort` rooted at the REAL session workspace root (`workspaceRoot`,
   * NEVER the worker's worktree `rootDir`) so research notes land in the user's
   * tree, not a throwaway worktree. The tool is read-class (entities/subagents
   * `READ_CLASS_TOOLS`), so a worker that holds it stays read-class — NO isolation
   * and NOT a write dispatch (§3.1, §8.6). A worker that does not list it, a
   * reviewer, or a run with no `notesFileSystem` seam gets none.
   */
  private notesToolFor(def: AgentDefinition): StructuredToolInterface[] {
    if (!this.deps.notesFileSystem) return [];
    if (!new Set(def.tools).has("researcher_save_notes")) return [];
    return [
      buildResearchNotesTool({
        fs: this.deps.notesFileSystem,
        getFindingsDirectories: () => this.deps.getConfig().findingsDirectories,
        ...(this.deps.limits ? { limits: this.deps.limits } : {}),
      }),
    ];
  }

  /** Build an isolated worker agent rooted at its worktree (§7.1, §7.3), or over
   * the durable staging layer when there is no repo (§7.4). Every worker — the
   * reviewer included — is compiled WITH the ONE shared decision-point
   * middleware, so a worker's `write_file`/`edit_file`/`execute_command` passes
   * Warden → managed gate → Guardian → guardrails exactly as the orchestrator's
   * do (§9.1, §15.1#4); nothing bypasses the point. */
  private buildWorker(
    def: AgentDefinition,
    rootDir: string,
    ctx: { fanoutId: string; workerId: string; worker?: string; taskId?: string },
    stagingRun?: string,
    modelOverride?: BaseChatModel,
    responseFormat?: ResponseFormat,
  ): ReturnType<typeof createAgent> {
    const backend = new LocalShellBackend({ rootDir });
    const cfg = this.deps.getConfig();
    const toolCfg = {
      workspaceMaxReadLines: cfg.workspaceMaxReadLines,
      workspaceMapDepth: cfg.workspaceMapDepth,
      toolWaitMaxSeconds: cfg.toolWaitMaxSeconds,
      ...(this.deps.limits ? { limits: this.deps.limits } : {}),
      // §9.4/§10.11/§10.12 — read-path guard scoped to the OWNER session so a
      // worker's read_file cannot read the journal, rollback snapshots,
      // rollback.key, or another session's run-cache blobs.
      readGuard: {
        ctx: {
          workspaceRoot: this.deps.workspaceRoot,
          ...(this.deps.globalConfigDir ? { globalConfigDir: this.deps.globalConfigDir } : {}),
          ...(this.deps.home ? { home: this.deps.home } : {}),
        },
        sessionId: () => this.ownerSessionId(),
      },
    };
    // §7.4 — a staged (no-repo) worker binds the staged tool suite: read-through
    // reads, writes that never touch disk, and NO `execute_command` (the no-shell
    // limit is structural in the toolset). A staged reviewer reads through staging
    // too (read-through), so it verifies the staged changes, not stale disk.
    const all = stagingRun
      ? buildStagedTools(
          backend,
          {
            read: (p) => this.deps.staging.read(stagingRun, p),
            stageWrite: (p, content) => this.deps.staging.stageWrite(stagingRun, p, content),
          },
          toolCfg,
        )
      : buildCoreTools(backend, toolCfg);
    const allowed = def.reviewer
      ? new Set<string>(REVIEWER_READONLY_TOOLS)
      : new Set(def.tools);
    const tools = all.filter((t) => allowed.has(t.name));
    // §8.2 — a worker that lists `web_fetch`/`web_search` binds them over the
    // SAME HttpPort path (SSRF/DNS/redirect/timeout/masking) and the SAME single
    // decision point. A reviewer never gets them (read-only review set, §7.5).
    if (!def.reviewer) {
      for (const t of this.webToolsFor(def, backend)) tools.push(t);
      for (const t of this.notesToolFor(def)) tools.push(t);
    }
    // §8.4 / §15.1#4 — a worker binds the SAME approved MCP tools (from the one
    // shared registry) its manifest allows, routed through the SAME executors
    // and the SAME decision middleware. A quarantined/pending tool is excluded
    // by `mcpModelEntries()`, so it is unavailable to a worker exactly as to the
    // orchestrator; a reviewer (read-only manifest) gets none unless listed.
    if (!def.reviewer) {
      for (const t of buildMcpModelTools(this.deps.registry, { workspaceRoot: rootDir, sessionId: this.deps.sessionId })) {
        if (allowed.has(t.name)) tools.push(t);
      }
    }
    // §12.4 — a worker binds the plugin-contributed tools (origin `plugin`) its
    // manifest names, honouring names and globs (`retrieval_*`) via the shared
    // `toolMatchesAgentList`. A reviewer (read-only) gets none. Each call still
    // passes the one decision point (ASKS until allow-listed, §9).
    if (!def.reviewer) {
      for (const t of buildPluginModelTools(this.deps.registry, { workspaceRoot: rootDir, sessionId: this.deps.sessionId })) {
        if (toolMatchesAgentList(t.name, def.tools)) tools.push(t);
      }
    }
    // A worker is compiled WITHOUT the subagent/task middleware — it holds no
    // dispatch tool (§7.1). Re-assert on the resolved instances.
    assertResolvedWorkerTools(def.name, tools);
    // §11 / invariant 14 — `def.model` is a STRING endpoint key resolved
    // internally to the bound model; an internal reviewer override (a
    // construction-time BaseChatModel, never a public DTO) takes precedence. An
    // unknown key is caught at registration (MODEL_NOT_CONFIGURED); here it has
    // already been validated, so a miss falls back to the active endpoint.
    const model = modelOverride ?? this.resolveAgentModel(def) ?? this.deps.chatModel;
    // §4.10 / invariant 9 — a worker's model call passes the SAME shared overflow
    // guard as the orchestrator's (its context is its own fresh context against
    // the same endpoint window): a request that would overflow is refused with
    // `CONTEXT_OVERFLOW` and the provider is never called. Built from the shared
    // `overflowGuardSpec` entity so no call site reimplements it (§15.1#4).
    return createAgent({
      model,
      tools,
      middleware: [this.overflowMiddleware(ctx.workerId), this.workerUsageMiddleware(def, ctx), this.workerToolStatusMiddleware(ctx.workerId), this.workerDecisionMiddleware(ctx, rootDir)],
      ...(responseFormat ? { responseFormat } : {}),
    });
  }

  /** §10.14/§10.7 — a `wrapModelCall` middleware that emits ONE `MODEL_USAGE`
   * per worker model call onto the bus, scoped to the PARENT (owner) session and
   * attributed to the worker (`agent` = worker name, plus `taskId`), so the
   * stats builder rolls the fan-out's cost into the parent totals AND the
   * `byAgent` buckets (§10.14) without double-counting the orchestrator's own
   * usage. A reviewer's worker name is its `def.name` (`<worker>-reviewer`). */
  private workerUsageMiddleware(def: AgentDefinition, ctx: { workerId: string; worker?: string; taskId?: string }) {
    const workerName = ctx.worker ?? def.name;
    const modelName = def.model ?? this.deps.getConfig().modelSelected ?? "(worker)";
    const spec = workerUsageSpec({
      emit: (u) =>
        this.deps.bus.emit(
          "MODEL_USAGE",
          {
            name: modelName,
            usage: {
              promptTokens: u.promptTokens,
              inputSum: u.promptTokens,
              completionTokens: u.completionTokens,
              totalMs: u.genMs,
              ...(u.genMs > 0 ? { genMs: u.genMs } : {}),
              ...(u.cacheReadTokens > 0 ? { cacheReadTokens: u.cacheReadTokens } : {}),
            },
            estimated: u.estimated,
            agent: workerName,
            ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
          },
          { session: this.ownerSessionId(), worker: ctx.workerId },
        ),
    });
    return createMiddleware(spec as Parameters<typeof createMiddleware>[0]);
  }

  /** The shared §4.10 overflow guard as a `wrapModelCall` middleware for a worker
   * (invariant 9). Emits `CONTEXT_OVERFLOW` and throws, so a worker whose request
   * would overflow fails with the reason the orchestrator sees — never a send. */
  private overflowMiddleware(workerId: string) {
    const spec = overflowGuardSpec({
      emit: (o) => this.emitOverflow(workerId, o),
      getLimits: () => ({ limit: this.deps.window, maxOutputTokens: this.deps.maxOutputTokens ?? null }),
    });
    return createMiddleware(spec as Parameters<typeof createMiddleware>[0]);
  }

  /** Emit `CONTEXT_OVERFLOW` scoped to the session + worker (§4.10). */
  private emitOverflow(workerId: string, o: ContextOverflow): void {
    this.deps.bus.emit(
      "CONTEXT_OVERFLOW",
      { estimatedInput: o.estimatedInput, maxOutputTokens: o.maxOutputTokens, limit: o.limit, message: o.message },
      { session: this.ownerSessionId(), worker: workerId },
    );
  }

  /**
   * §7.2/§14.6 — a `wrapToolCall` middleware that emits ONE
   * `WORKER_STATUS_CHANGED { status: "running", tool }` as the worker begins each
   * tool call, so the live fan-out monitor shows the current tool (Run/Search/…)
   * for the whole call, not just the row's dispatch state. The worker is already
   * `running`; this carries the tool name on the same terminal→owner scope. It
   * never gates (the one decision point, next in the chain, does) and never
   * changes the worker's status, only annotates it with the active tool. A
   * worker whose row has gone (defensive) is a no-op.
   */
  private workerToolStatusMiddleware(workerId: string) {
    const spec = {
      name: "voidrift-worker-tool-status",
      wrapToolCall: async (
        request: { toolCall: { name: string } },
        handler: (r: unknown) => unknown,
      ) => {
        const w = this.workers.get(workerId);
        if (w && w.status === "running") this.transition(w, "running", request.toolCall.name);
        return handler(request);
      },
    };
    return createMiddleware(spec as Parameters<typeof createMiddleware>[0]);
  }

  /**
   * Resolve an agent definition's `model` endpoint KEY (§11, invariant 14) to a
   * bound model via the construction-time `resolveModel` seam, or undefined when
   * the def names no key (use the active endpoint). The public DTO holds only the
   * string key; the LangChain-typed resolution happens here, internal to the
   * use-case, so no library type crosses the method surface.
   */
  private resolveAgentModel(def: AgentDefinition): BaseChatModel | undefined {
    if (!def.model) return undefined;
    return this.deps.resolveModel?.(def.model);
  }

  /**
   * The ONE decision-point middleware for a worker (§9.1, §15.1#4), built from
   * the SAME shared factory the engine uses. The caller context carries the
   * worker and fan-out ids and the orchestrator's approval mode; an `ask`
   * resolves per §9.5 (`resolveWorkerAsk`). A worker's §8.3 eviction writes to
   * the PARENT session's cache (§7); its guardrail read/stale state is fresh per
   * worker (its worktree is its own tree).
   */
  private workerDecisionMiddleware(ctx: { fanoutId: string; workerId: string }, rootDir: string) {
    // Fresh per-worker guardrail state — a worker's reads/writes are its own.
    const readPaths = new Set<string>();
    const stalePaths = new Set<string>();
    const parentSessionId = this.ownerSessionId();
    // §3.4 — each worker gets its OWN loop-health counter for the life of its
    // dispatch (one turn's worker run), so a worker's repeated calls never trip
    // the orchestrator's counter and vice versa (worker isolation). The limits
    // are the same live §3.6 config thresholds.
    const loopHealth = new LoopHealth((): LoopHealthLimits => {
      const c = this.deps.getConfig();
      return {
        maxConsecutiveErrors: c.turnLoopMaxConsecutiveErrors,
        maxIdenticalCalls: c.turnLoopMaxIdenticalCalls,
        fingerprintRepeats: c.turnLoopFingerprintRepeats,
        fingerprintWindow: c.turnLoopFingerprintWindow,
      };
    });
    const deps: DecisionPointDeps = {
      guardian: this.deps.guardian,
      warden: this.deps.warden,
      bus: this.deps.bus,
      registry: this.deps.registry,
      getConfig: this.deps.getConfig,
      ...(this.deps.limits ? { limits: this.deps.limits } : {}),
      ...(this.deps.managedGate ? { managedGate: this.deps.managedGate } : {}),
      ...(this.deps.getActiveAgent ? { getActiveAgent: this.deps.getActiveAgent } : {}),
      tempDir: this.deps.tempDir,
      // §D1.5 — the worker's workdir is its OWN tree: a worktree worker passes
      // its worktree `rootDir`; a read/in-place worker passes the main workspace
      // (`rootDir` === `this.deps.workspaceRoot`). The `rm -rf` within-workdir
      // refinement and the protected-control-file guardrail both key off this.
      workspaceRoot: rootDir,
      ...(this.deps.globalConfigDir ? { globalConfigDir: this.deps.globalConfigDir } : {}),
      ...(this.deps.home ? { home: this.deps.home } : {}),
      window: this.deps.window,
      getSessionRules: () => this.deps.getSessionRules?.() ?? [],
      guardrailState: () => ({ readPaths, stalePaths }),
      markRead: (p) => {
        readPaths.add(p);
        stalePaths.delete(p);
      },
      ...(this.deps.writeEvictedResult ? { writeEvictedResult: this.deps.writeEvictedResult } : {}),
      // §7/§8.3 — a worker evicts into the PARENT session's cache dir.
      evictionOwnerSessionId: () => parentSessionId,
      // §10.11 — a worker's writes journal into the SESSION's journal (sessionId
      // is the session, workerId the worker; set on the CallerContext below) with
      // the worktree-relative target. `readTargetBytes` reads a file's before-
      // state within the worker's OWN tree (`rootDir`). `turn` is 0 here — a
      // worker turn number is not tracked separately from the session.
      ...(this.deps.journal ? { journal: this.deps.journal } : {}),
      // §10.11/§9.5.1 — the active plan-scope id a worker's journaled write
      // stamps as its `planStep` (metadata ONLY, invariant 27), so a surprise
      // caused by a worker is visible to the scope-targets reader. A plan step
      // is commonly executed by a dispatched worker, so this is the main path.
      ...(this.deps.getActiveScopeId ? { getActiveScopeId: this.deps.getActiveScopeId } : {}),
      ...(this.deps.journal && this.deps.readWorkerTargetBytes
        ? { readTargetBytes: (relPath: string) => this.deps.readWorkerTargetBytes!(rootDir, relPath) }
        : {}),
      // §3.4 — the worker's own loop-health counter (worker isolation).
      loopHealth: () => loopHealth,
    };
    const callerCtx: CallerContext = {
      sessionId: this.ownerSessionId(),
      workerId: ctx.workerId,
      fanoutId: ctx.fanoutId,
      approvalMode: this.deps.getApprovalMode?.() ?? "interactive",
    };
    return createDecisionMiddleware(deps, callerCtx, (req) => this.resolveWorkerAsk(req));
  }

  /**
   * Resolve a worker's `ask` per §9.5. A force-ask is immune to every grant and
   * never auto-runs. The fan-out grant satisfies ONLY a non-force-ask (and only
   * while the fan-out is live). With no grant: an interactive host callback
   * surfaces a PendingApproval carrying `workerId` + the FULL action and resolves
   * it (an `out_of_band` pause is durable, resumed by `session.confirm`);
   * `policy_only`/non-interactive with no trusted scope fails fast (reject → the
   * model sees a rejection and the fan-out fails fast).
   */
  private async resolveWorkerAsk(req: AskRequest): Promise<AskResolution> {
    const fanoutId = req.ctx.fanoutId ?? "";
    // The fan-out grant satisfies a non-force-ask (§7.5/§9.3) — never a force-ask.
    if (!req.forceAsk && this.deps.guardian.hasFanoutGrant(fanoutId)) {
      return { decision: "allow" };
    }
    // No grant. Try an interactive/out-of-band approval if one can be answered.
    const mode = req.ctx.approvalMode;
    const canInteract = (mode === "interactive" || mode === "out_of_band") && this.deps.requestWorkerApproval;
    if (canInteract) {
      const safeArgs = maskSecrets(req.call.args);
      // ONE shared builder (decision-point) so the worker ask carries the SAME
      // force-ask presentation fields the engine's own ask does (§9.5, owner
      // D2a): forceAsk(Kind), rememberable, exactOnly, and the masked inferred
      // patterns. A host MUST never batch a force-ask (any forceAskKind) — it is
      // routed to the single-action dialog, one decision each.
      const fields = computeForceAskFields(req, this.deps.limits?.get("permissions.exactRememberMaxChars"));
      const safePatterns = (fields.inferredPatterns ?? []).map(maskText);
      const safeSegments = req.segments?.map((s) => ({ text: maskText(s.text), decision: s.decision }));
      const pending: PendingApproval = {
        id: `appr-w-${++workerApprovalSeq}`,
        tool: req.call.tool,
        args: safeArgs,
        ...(req.ctx.workerId ? { workerId: req.ctx.workerId } : {}),
        choices: ["approve", "edit", "reject"],
        mode,
        rememberable: fields.rememberable,
        ...(fields.exactOnly ? { exactOnly: true } : {}),
        ...(fields.inferredPatterns ? { inferredPatterns: safePatterns } : {}),
        ...(req.forceAsk ? { forceAsk: true } : {}),
        ...(req.forceAskKind ? { forceAskKind: req.forceAskKind } : {}),
        ...(safeSegments && safeSegments.length > 0 ? { segments: safeSegments } : {}),
      };
      this.deps.bus.emit(
        "PERMISSION_REQUESTED",
        { tool: req.call.tool, args: safeArgs, requestId: pending.id, inferredPatterns: safePatterns, ...(req.ctx.workerId ? { worker: req.ctx.workerId } : {}) },
        { session: this.ownerSessionId(), ...(req.ctx.workerId ? { worker: req.ctx.workerId } : {}) },
      );
      const resume = await this.deps.requestWorkerApproval!(pending);
      this.deps.bus.emit(
        "PERMISSION_RESOLVED",
        { requestId: resume.requestId ?? pending.id, decision: resume.decision },
        { session: this.ownerSessionId(), ...(req.ctx.workerId ? { worker: req.ctx.workerId } : {}) },
      );
      if (resume.decision === "reject") return { decision: "reject" };
      if (resume.decision === "edit" && resume.editedArgs) return { decision: "edit", editedArgs: resume.editedArgs };
      return { decision: "allow" };
    }
    // Non-interactive and no grant: only a declared trusted scope lets a
    // non-force-ask through; otherwise fail fast (§7.5, §9.5).
    if (!req.forceAsk && (this.deps.trustedScopes?.has(req.call.tool) ?? false)) {
      return { decision: "allow" };
    }
    return { decision: "reject" };
  }

  private newWorker(fanoutId: string, agent: string, taskId?: string): LiveWorker {
    const workerId = `${fanoutId}-w${(++workerSeq).toString(36)}`;
    const w: LiveWorker = { workerId, agent, status: "running", pendingApproval: false, stream: [], ...(taskId !== undefined ? { taskId } : {}) };
    this.workers.set(workerId, w);
    // §4.4 (cli) — the CLI builds its per-worker fan-out rows from these events;
    // carry the worker's agent and its batch task id so a row maps to its
    // `tasks[]` entry regardless of completion order.
    this.deps.bus.emit(
      "WORKER_STATUS_CHANGED",
      { workerId, status: w.status, agent, ...(taskId !== undefined ? { taskId } : {}) },
      { session: this.ownerSessionId(), worker: workerId },
    );
    w.stream.push({ workerId, kind: "status", status: w.status });
    return w;
  }

  private transition(w: LiveWorker, status: WorkerStatus, tool?: string): void {
    w.status = status;
    this.deps.bus.emit(
      "WORKER_STATUS_CHANGED",
      { workerId: w.workerId, status, agent: w.agent, ...(w.taskId !== undefined ? { taskId: w.taskId } : {}), ...(tool ? { tool } : {}) },
      { session: this.ownerSessionId(), worker: w.workerId },
    );
    w.stream.push({ workerId: w.workerId, kind: "status", status, ...(tool ? { tool } : {}) });
  }

  /** Run one worker end-to-end: dispatch, verify, apply through the two gates. */
  private async runWorker(fanoutId: string, req: DispatchRequest, signal: AbortSignal, taskId?: string): Promise<LiveWorker> {
    let w: LiveWorker | undefined;
    try {
      w = await this.runWorkerInner(fanoutId, req, signal, taskId);
      return w;
    } finally {
      // §10.11 — a worker's run ending is one of the ways a turn can end: flush
      // the worker's turn-net journal entries (its writes aggregate per
      // (workerId, target)). The flush reads each target's actual content from
      // the worker's OWN tree (`rootDir`) so a shell-made change is captured; the
      // parent turn end flushes any straggler as a backstop. No journal → no-op.
      if (this.deps.journal && w) {
        const rootDir = w.worktree?.path ?? this.deps.workspaceRoot;
        const reader = this.deps.readWorkerTargetBytes;
        await this.deps.journal
          .flushTurn(this.deps.sessionId, 0, {
            workerId: w.workerId,
            ...(reader ? { reader: (p: string) => reader(rootDir, p) } : {}),
          })
          .catch(() => undefined);
      }
    }
  }

  private async runWorkerInner(fanoutId: string, req: DispatchRequest, signal: AbortSignal, taskId?: string): Promise<LiveWorker> {
    const def = this.agents.get(req.agent);
    const w = this.newWorker(fanoutId, req.agent, taskId);
    if (!def) {
      w.summary = `unknown agent: ${req.agent}`;
      this.transition(w, "failed");
      return w;
    }
    if (signal.aborted) {
      this.transition(w, "aborted");
      return w;
    }

    // §2.7c/§3.1 — the active top-level agent's `workers` allow list gates which
    // workers may be dispatched. A worker not in the list is DENIED before
    // anything is created (no worktree, no staging, no branch), with a clear
    // message listing the allowed workers. Read live from the PARENT session's
    // active agent so a `session.setMode` changes the allow list; a worker can
    // never loosen it. `workers: "all"` (and the built-in `chat`) allows any.
    const parentAgent = this.deps.getActiveAgent?.();
    // §8.7 — an INTERNAL summarizer dispatch (the Ingest fan-out) bypasses the
    // active agent's `workers` allowance for the LITERAL `summarizer` worker
    // only. Every other gate still applies. The model-callable `task` tool never
    // sets `internal`, so this never widens what a model can dispatch.
    const internalSummarizer = req.internal === true && req.agent === "summarizer";
    if (!internalSummarizer && !workerAllowed(parentAgent, req.agent)) {
      const allowed = parentAgent?.workers === "all" || parentAgent?.workers === undefined
        ? "all"
        : (parentAgent.workers as string[]).join(", ") || "(none)";
      const guidance = `worker "${req.agent}" is not dispatchable by the active agent "${parentAgent?.name ?? "chat"}"; allowed workers: ${allowed}`;
      w.summary = guidance;
      this.deps.bus.emit("PERMISSION_DENIED", { tool: "task", reason: guidance }, { session: this.ownerSessionId(), worker: w.workerId });
      this.transition(w, "failed");
      return w;
    }

    // §3.1 / §7.1 — only a WRITE-CLASS worker gets isolation. A READ-CLASS
    // worker (reads, skills/memory, and the READ web tools — class derived from
    // its tool list by `deriveAgentClass`) runs against the MAIN tree with a
    // read-only backend: NO worktree, NO staging (no branch, no directory, no
    // `.meta.json`), nothing to merge or apply. Its result is its summary. A
    // reviewer is read-class by construction (§7.5).
    const workerClass = deriveAgentClass(def);
    let worktree: Worktree | undefined;
    let rootDir = this.deps.workspaceRoot;
    if (workerClass === "read") {
      // Run in place against the main tree; create no isolation.
      const result = await this.invokeAgent(def, rootDir, req.task, signal, { fanoutId, workerId: w.workerId, worker: def.name, ...(taskId ? { taskId } : {}) }, undefined, req.resultSchema);
      if (signal.aborted) {
        this.transition(w, "aborted");
        return w;
      }
      w.summary = result.summary;
      this.transition(w, result.ok ? "merged" : "failed");
      return w;
    }

    // §9.5 / §9.7 — dispatching a WRITE-CLASS worker is a WRITE call: DENIED
    // outright under an `unlisted: deny` agent (the old `research` posture)
    // BEFORE any isolation is created (no worktree, no staging, no branch,
    // nothing to merge). A read-class dispatch is a READ, allowed under any
    // agent. The posture is read LIVE from the parent session's active agent and
    // can never be loosened by a fan-out grant or plan scope.
    if (unlistedOf(parentAgent) === "deny") {
      const guidance =
        "this agent can fan out read-only workers; switch to a top-level agent that allows changes to dispatch workers that change things";
      w.summary = guidance;
      this.deps.bus.emit("PERMISSION_DENIED", { tool: "task", reason: guidance }, { session: this.ownerSessionId(), worker: w.workerId });
      this.transition(w, "failed");
      return w;
    }

    // §7.3 step 1 — a WRITE-CLASS worker gets a worktree per worker inside a git
    // repo; the worker's backend is rooted there. With NO repo (§7.4) the worker
    // stages through the durable read-through staging layer instead, and cannot
    // run shell (nothing isolated to run it in). A worker needing both writes and
    // shell runs alone, in place.
    const isRepo = this.deps.vcs.isRepo();
    if (isRepo) {
      // Worktree creation touches the base repo (index.lock), so serialize it
      // with merges through the one critical section.
      worktree = await this.serializeMerge(() =>
        this.deps.vcs.createWorktree(w.workerId, this.ownerSessionId(), this.deps.getConfig().worktreeInclude),
      );
      w.worktree = worktree;
      rootDir = worktree.path;
    } else if (def.tools.includes(SHELL_TOOL)) {
      // §7.4 no-shell-staged-worker limit (D5): a worker that writes AND needs
      // shell cannot be staged (nothing to run shell in) and so runs ALONE, in
      // place, with no staging and no parallel sibling. It writes to disk directly.
      // This slice stages pure-write workers; a write+shell worker is the in-place
      // path. We mark it so apply skips staging for it.
      // (left in place: rootDir stays the workspace root, no staging area)
    } else {
      // §7.4 — create this run's durable staging folder; the worker's writes land
      // here through the staged tool backend, reads check staging first then disk.
      const area = await this.deps.staging.createArea(w.workerId, this.ownerSessionId());
      w.staging = area.run;
    }

    // Dispatch the worker under its own recursion budget (§7.2, §3.6).
    const result = await this.invokeAgent(def, rootDir, req.task, signal, { fanoutId, workerId: w.workerId, worker: def.name, ...(taskId ? { taskId } : {}) }, w.staging, req.resultSchema);
    if (signal.aborted) {
      this.transition(w, "aborted");
      if (worktree) this.deps.vcs.preserveWorktree(worktree);
      // §7.4 / §3.3 — a cancelled staged worker preserves its staging folder as a
      // recovery artifact (offered apply/discard on resume); it is NOT discarded.
      return w;
    }
    if (!result.ok) {
      w.summary = result.summary;
      this.transition(w, "failed");
      if (worktree) {
        const recoveryBranch = await this.deps.vcs.abandonWorktree(worktree);
        w.recoveryBranch = recoveryBranch;
      } else if (w.staging) {
        await this.deps.staging.discard(w.staging);
      }
      return w;
    }
    w.summary = result.summary;
    this.transition(w, "needs_review");

    // §7.5 gate 1 — a distinct read-only reviewer in fresh context. The worker
    // never grades itself. A reviewer FAIL (incl. an unreachable/unsure Judge
    // seam) blocks the merge.
    const pass = await this.review(def, rootDir, req.task, signal, { fanoutId, workerId: w.workerId }, w.staging);
    if (!pass) {
      this.transition(w, "failed");
      if (worktree) {
        const recoveryBranch = await this.deps.vcs.abandonWorktree(worktree);
        w.recoveryBranch = recoveryBranch;
      } else if (w.staging) {
        await this.deps.staging.discard(w.staging);
      }
      return w;
    }
    this.transition(w, "reviewed");

    // §7.5 gate 2 — the merge is an ordinary Guardian-gated write. The fan-out
    // grant auto-approves it; a hard deny / Warden deny still blocks. Merges run
    // inside the merge critical section so parallel workers apply sequentially.
    if (worktree) {
      const wt = worktree;
      const done = await this.serializeMerge(async () => {
        const decision = await this.gateMerge(fanoutId, wt);
        if (decision === "deny") {
          w.summary = `${w.summary} [merge blocked by policy]`;
          this.transition(w, "failed");
          const recoveryBranch = await this.deps.vcs.abandonWorktree(wt);
          w.recoveryBranch = recoveryBranch;
          return true;
        }
        if (decision === "ask" && !this.canAutoResolve(fanoutId)) {
          // A non-interactive worker reaching an unresolved approval fails fast
          // unless its scope was declared trusted up front (§7.5).
          w.summary = `${w.summary} [merge needs approval; non-interactive — failing fast]`;
          this.transition(w, "failed");
          const recoveryBranch = await this.deps.vcs.abandonWorktree(wt);
          w.recoveryBranch = recoveryBranch;
          return true;
        }
        const merge = await this.deps.vcs.mergeWorktree(wt);
        if (!merge.merged) {
          if (merge.recoveryBranch) w.recoveryBranch = merge.recoveryBranch;
          w.summary = `${w.summary} [merge conflict: work preserved on ${merge.recoveryBranch}]`;
          this.transition(w, "failed");
          return true;
        }
        // §10.11 — the merge SUCCEEDED: journal one entry per merged path with an
        // undo hint naming the previous HEAD (README: /undo names the previous
        // HEAD). Never on a refusal/conflict (handled above).
        await this.journalFanoutWrite(
          "merge_worktree",
          merge.mergedPaths ?? [],
          merge.previousHead ? `previous HEAD ${merge.previousHead} — reset the working tree there to revert this merge` : "merged into the working tree",
        );
        return false;
      });
      if (done) return w;
    } else if (w.staging) {
      // §7.4 gate 2 — staged apply is an ordinary Guardian-gated write, resolved
      // through the SAME one decision point as a merge. The apply runs inside the
      // per-run critical section (serializeMerge) so parallel staged workers apply
      // sequentially, each file through the two re-hash checks.
      const run = w.staging;
      const done = await this.serializeMerge(async () => {
        const decision = await this.gateApply(fanoutId, run);
        if (decision === "deny") {
          w.summary = `${w.summary} [apply blocked by policy]`;
          this.transition(w, "failed");
          await this.deps.staging.discard(run);
          return true;
        }
        if (decision === "ask" && !this.canAutoResolve(fanoutId)) {
          w.summary = `${w.summary} [apply needs approval; non-interactive — failing fast]`;
          this.transition(w, "failed");
          // Preserve the staging folder for later apply/discard (not discarded).
          return true;
        }
        const applyResult = await this.deps.staging.apply(run);
        if (applyResult.blocked.length > 0) {
          // A changed base is a CONFLICT; a staged/manifest hash mismatch is
          // UNRELIABLE. Either reports to the orchestrator and is NOT applied;
          // the orchestrator re-dispatches against current files (§7.4). The
          // staging folder is kept so the report is actionable.
          w.summary = `${w.summary} ${this.describeBlocked(applyResult)}`;
          this.transition(w, "failed");
          return true;
        }
        // §10.11 — the apply SUCCEEDED: journal one entry per applied path. With
        // no repo there is no undo beyond the conversation (§7.4), named in the
        // hint. Never on a blocked/failed apply (handled above).
        await this.journalFanoutWrite(
          "apply_staging",
          applyResult.applied,
          "no repo: no undo beyond the conversation",
        );
        return false;
      });
      if (done) return w;
    }
    this.transition(w, "merged");
    return w;
  }

  /** Invoke the worker agent and extract a structured result. */
  private async invokeAgent(
    def: AgentDefinition,
    rootDir: string,
    task: string,
    signal: AbortSignal,
    ctx: { fanoutId: string; workerId: string; worker?: string; taskId?: string },
    stagingRun?: string,
    resultSchema?: unknown,
  ): Promise<{ ok: boolean; summary: string }> {
    try {
      // §3.8 — a per-dispatch result schema makes the worker run with a
      // `responseFormat` (the portable toolStrategy, which works on any
      // tool-calling model) so its typed result can be JSON-serialized into the
      // tool result that converges to the orchestrator. An invalid schema is
      // ignored (the worker runs normally) — the orchestrator validated it at
      // the task-tool boundary; this is defense in depth.
      let responseFormat: ResponseFormat | undefined;
      let validated: ReturnType<typeof validateResponseSchema> | undefined;
      if (resultSchema !== undefined) {
        validated = validateResponseSchema(resultSchema, this.deps.limits?.get("tools.responseSchemaMaxBytes"));
        if (validated.ok) responseFormat = selectStrategy(validated.value, "tool").format;
      }
      const agent = this.buildWorker(def, rootDir, ctx, stagingRun, undefined, responseFormat);
      const cfg = this.deps.getConfig();
      const invokeResult = (await agent.invoke(
        { messages: [{ role: "user", content: task }] },
        { recursionLimit: cfg.subagentRecursionLimit, signal },
      )) as { messages: BaseMessage[]; structuredResponse?: unknown };
      // §3.8 — a valid typed result is JSON-serialized as the summary that
      // converges to the orchestrator; otherwise the worker's final text.
      if (validated?.ok) {
        const check = validateStructuredValue(validated.value, invokeResult.structuredResponse);
        if (check.ok) return { ok: true, summary: JSON.stringify(check.value) };
      }
      const summary = this.lastText(invokeResult.messages ?? []);
      return { ok: true, summary };
    } catch (e) {
      if (signal.aborted) return { ok: false, summary: "aborted" };
      // §4.10 / invariant 9 — the shared overflow guard refused this worker's
      // request (the model was never called). Fail with the reason so the
      // orchestrator sees CONTEXT_OVERFLOW, not a generic worker error.
      const overflow = contextOverflowOf(e);
      if (overflow) {
        return { ok: false, summary: `CONTEXT_OVERFLOW: ${overflow.message} (estimate ${overflow.estimatedInput} + maxOutput ${overflow.maxOutputTokens} > limit ${overflow.limit})` };
      }
      return { ok: false, summary: `worker error: ${String(e)}` };
    }
  }

  /**
   * Dispatch a distinct read-only reviewer worker in fresh context against the
   * worker's worktree (§7.5). The reviewer resolves deterministic criteria
   * directly; the Judge-MCP routing for typed-verdict criteria is a seam (Judge
   * is a later component) and an unreachable/unsure Judge path counts as a
   * failed review. Returns true on PASS.
   */
  private async review(def: AgentDefinition, rootDir: string, task: string, signal: AbortSignal, ctx: { fanoutId: string; workerId: string }, stagingRun?: string): Promise<boolean> {
    const reviewerDef: AgentDefinition = {
      name: `${def.name}-reviewer`,
      description: "read-only reviewer",
      systemPrompt:
        "You are a read-only reviewer. Verify the work against the task using only read tools. " +
        "Reply with PASS if it meets the task, otherwise FAIL with the reason.",
      tools: [],
      reviewer: true,
    };
    try {
      // §7.5 — the reviewer's model is a construction-time BaseChatModel seam
      // (`reviewerModel`), passed as an INTERNAL override, never through the
      // public `AgentDefinition.model` string key (invariant 14).
      const agent = this.buildWorker(reviewerDef, rootDir, { fanoutId: ctx.fanoutId, workerId: `${ctx.workerId}-reviewer` }, stagingRun, this.deps.reviewerModel);
      const cfg = this.deps.getConfig();
      const result = (await agent.invoke(
        { messages: [{ role: "user", content: `Task: ${task}\nReview the work.` }] },
        { recursionLimit: cfg.subagentRecursionLimit, signal },
      )) as { messages: BaseMessage[] };
      const verdict = this.lastText(result.messages ?? []);
      // Deterministic criterion: PASS present, FAIL absent (§7.5 direct path).
      return /\bPASS\b/i.test(verdict) && !/\bFAIL\b/i.test(verdict);
    } catch {
      // An unreachable/unsure Judge or reviewer error counts as a failed review
      // (§7.5 seam). Fail closed.
      return false;
    }
  }

  /**
   * The Guardian gate for a merge (§7.5 gate 2). The merge is an ordinary
   * Guardian-gated write (§9): Warden runs first and is final, then the SAME
   * `guardian.evaluate(...)` the engine's `wrapToolCall` uses decides the write.
   * The fan-out grant is consulted ONLY to satisfy a non-force-ask `ask`, so a
   * grant can never override a hard deny, a Warden deny, or a force-ask.
   * Returns the resolved decision for the merge write.
   */
  private async gateMerge(fanoutId: string, worktree: Worktree): Promise<"allow" | "ask" | "deny"> {
    const call: GuardedCall = {
      tool: "merge_worktree",
      args: { branch: worktree.branch, path: worktree.path },
    };
    return this.gateWrite(fanoutId, call);
  }

  /**
   * The Guardian gate for a staged apply (§7.4, §7.5 gate 2). Applying staged
   * work is an ordinary Guardian-gated write (§9), routed through the SAME single
   * decision point as a merge via `gateWrite`. The `apply_staging` tool name keys
   * the write so a rule can bind it exactly as it binds `merge_worktree`.
   */
  private async gateApply(fanoutId: string, run: string): Promise<"allow" | "ask" | "deny"> {
    const call: GuardedCall = {
      tool: "apply_staging",
      // The approval prompt states there is no repo and therefore no undo beyond
      // the conversation (§7.4): surfaced in the args a frontend renders.
      args: { run, noRepo: true, note: "no repo: no undo beyond the conversation" },
    };
    return this.gateWrite(fanoutId, call);
  }

  /**
   * The one decision point for a fan-out apply/merge write (§7.4, §7.5 gate 2,
   * §9): Warden runs first and is final, then the SAME `guardian.evaluate(...)`
   * the engine's `wrapToolCall` uses decides the write. The fan-out grant is
   * consulted ONLY to satisfy a non-force-ask `ask`, so a grant can never override
   * a hard deny, a Warden deny, or a force-ask.
   */
  private async gateWrite(fanoutId: string, call: GuardedCall): Promise<"allow" | "ask" | "deny"> {
    const cfg = this.deps.getConfig();
    // §9.5 / §9.7 — `merge_worktree` and `apply_staging` are WRITES: DENIED
    // under an `unlisted: deny` agent through the SAME single decision point the
    // engine uses (the active agent read LIVE from the parent session). This
    // cannot be bypassed by a fan-out grant or plan scope — the deny is decided
    // here, BEFORE the grant is ever consulted below. A worker inherits the live
    // active agent and can never loosen it.
    if (unlistedOf(this.deps.getActiveAgent?.()) === "deny") {
      this.deps.bus.emit(
        "PERMISSION_DENIED",
        { tool: call.tool, reason: "this agent is read-only — switch to a top-level agent that allows changes to make changes" },
        { session: this.ownerSessionId() },
      );
      return "deny";
    }
    // §7.5 / §9.1 step 4 — Warden first. A deny is final and runs before Guardian.
    const w = await this.deps.warden.evaluate({ tool: call.tool, args: call.args });
    if (w.effect === "block") {
      this.deps.bus.emit(
        "COMPLIANCE_BLOCKED",
        { action: call.tool, rule: w.rule, version: w.version },
        { session: this.ownerSessionId() },
      );
      return "deny";
    }
    // §7.5 / §9.1 step 5 — the one decision point: priority-sorted rules,
    // pattern/path matching, and force-ask immunity all live in Guardian. The
    // ruleset is the SAME one the engine's decision point resolves — config
    // permissions PLUS the orchestrator session's live session-scoped rules — so
    // a session-scoped `merge_worktree` rule binds the merge exactly as it binds
    // every other write (§15.1#4).
    const rules = resolveRules(cfg, this.deps.getSessionRules?.() ?? []);
    const lists: ShellLists = {
      safe: cfg.shellSafeCommands,
      forceAsk: cfg.shellForceAskPatterns,
      equivalents: cfg.shellEquivalents,
      deny: cfg.shellDenyPatterns,
    };
    const outcome = this.deps.guardian.evaluate(call, rules, lists);
    if (outcome.decision === "deny") {
      this.deps.bus.emit("PERMISSION_DENIED", { tool: call.tool, reason: outcome.reason ?? "denied by rule" }, { session: this.ownerSessionId() });
      return "deny";
    }
    if (outcome.decision === "allow") return "allow";
    // decision === "ask": the fan-out grant auto-approves ONLY a non-force-ask
    // (§9.3) — a force-ask is immune to grants, so a grant can never satisfy it.
    if (!outcome.forceAsk && this.deps.guardian.hasFanoutGrant(fanoutId)) return "allow";
    return "ask";
  }

  /** Whether an `ask` can be auto-resolved without an interactive prompt (§7.5). */
  private canAutoResolve(_fanoutId: string): boolean {
    if (this.deps.interactive) return true;
    // Non-interactive: only a declared trusted scope lets it proceed. Both the
    // merge write and the staged-apply write qualify (§7.5, §7.4).
    const trusted = this.deps.trustedScopes;
    return (trusted?.has("merge_worktree") ?? false) || (trusted?.has("apply_staging") ?? false);
  }

  /**
   * §10.11 — journal a SUCCEEDED fan-out write (a worktree merge or a staged
   * apply). ONE entry per merged/applied relative path (bounded by
   * `JOURNAL_FANOUT_MAX_PATHS`), each carrying the tool name (`merge_worktree` /
   * `apply_staging`), the `target` path, the ok result, the active plan-scope id
   * as `planStep` (metadata ONLY, invariant 27 — it grants nothing), and an undo
   * hint (the previous HEAD for a merge, the no-undo note for a no-repo apply).
   * Reuses the SAME `JournalRecorder.record` the decision point uses, so content
   * capture follows `mutationLogLevel` with the existing size limits — these are
   * non-file tools, so the recorder stores metadata only (no blobs), matching how
   * a shell/MCP write is recorded. Never called on a refused/failed write. A
   * record failure is swallowed (it does not undo an already-applied merge); the
   * decision point's own writes carry the fail-closed path.
   */
  private async journalFanoutWrite(tool: "merge_worktree" | "apply_staging", paths: string[], undoHint: string): Promise<void> {
    if (!this.deps.journal) return;
    const sessionId = this.ownerSessionId();
    const planStep = this.deps.getActiveScopeId?.();
    // De-dup and cap: one entry per distinct path, at most the fixed cap. A merge
    // that touched more than the cap records a final summary entry so the count
    // is never silently lost.
    const distinct = [...new Set(paths.filter((p) => typeof p === "string" && p !== ""))];
    const maxPaths = this.limit("task.journalFanoutMaxPaths");
    const capped = distinct.slice(0, maxPaths);
    for (const target of capped) {
      await this.deps.journal
        .record({
          sessionId,
          turn: 0,
          ...(planStep ? { planStep } : {}),
          tool,
          args: { path: target },
          target,
          result: { status: "ok", summary: tool === "merge_worktree" ? "merged into working tree" : "applied to working tree" },
          undoHint,
        })
        .catch(() => undefined);
    }
    if (distinct.length > capped.length) {
      await this.deps.journal
        .record({
          sessionId,
          turn: 0,
          ...(planStep ? { planStep } : {}),
          tool,
          args: { cappedPaths: distinct.length - capped.length },
          target: "",
          result: {
            status: "ok",
            summary: `${distinct.length - capped.length} further path(s) beyond the ${maxPaths}-path journal cap`,
          },
          undoHint,
        })
        .catch(() => undefined);
    }
  }

  /** A compact description of blocked staged files for the orchestrator (§7.4). */
  private describeBlocked(result: StagingApplyResult): string {
    const conflicts = result.blocked.filter((b) => !b.ok && b.reason === "conflict").map((b) => (b.ok ? "" : b.path));
    const unreliable = result.blocked.filter((b) => !b.ok && b.reason === "unreliable").map((b) => (b.ok ? "" : b.path));
    const escaped = result.blocked.filter((b) => !b.ok && b.reason === "escape").map((b) => (b.ok ? "" : b.path));
    const parts: string[] = [];
    if (conflicts.length > 0) parts.push(`[apply conflict: base changed for ${conflicts.join(", ")} — re-dispatch]`);
    if (unreliable.length > 0) parts.push(`[apply unreliable: staged file disagrees with manifest for ${unreliable.join(", ")} — not applied]`);
    if (escaped.length > 0) parts.push(`[apply refused: ${escaped.join(", ")} escapes the workspace — not applied]`);
    return parts.join(" ");
  }

  /**
   * Recovery on resume/boot (§7.4): an unfinished staging folder is offered to the
   * user as APPLY or DISCARD through the one decision point. Returns, per run, the
   * decision taken and (for apply) the result. A folder whose apply is denied by
   * policy is preserved for a later choice, never silently dropped.
   */
  async recoverStaging(): Promise<{ run: string; decision: "applied" | "discarded" | "kept"; result?: StagingApplyResult }[]> {
    const out: { run: string; decision: "applied" | "discarded" | "kept"; result?: StagingApplyResult }[] = [];
    for (const run of await this.deps.staging.listRuns()) {
      // Recovery is an OFFER (apply or discard), not a fan-out — the apply write
      // is resolved through the one decision point against config/session rules
      // (§7.4, §9). No auto-grant: the user chooses, or an allow rule / interactive
      // approval lets it through; a non-interactive run with no trusted scope keeps
      // the folder for a later choice (nothing is silently applied or dropped).
      const decision = await this.gateApply("recover", run);
      this.deps.bus.emit("STAGING_RECOVERY_OFFERED", { run, decision }, { session: this.deps.sessionId });
      if (decision === "deny") {
        await this.deps.staging.discard(run);
        out.push({ run, decision: "discarded" });
        continue;
      }
      if (decision === "ask" && !this.canAutoResolve("recover")) {
        out.push({ run, decision: "kept" });
        continue;
      }
      const result = await this.deps.staging.apply(run);
      out.push({ run, decision: "applied", result });
    }
    return out;
  }

  private lastText(messages: BaseMessage[]): string {
    const last = [...messages].reverse().find((m) => m instanceof AIMessage) as AIMessage | undefined;
    if (!last) return "";
    return typeof last.content === "string" ? last.content : JSON.stringify(last.content);
  }

  private toInfo(w: LiveWorker): WorkerInfo {
    return {
      workerId: w.workerId,
      agent: w.agent,
      status: w.status,
      ...(w.summary !== undefined ? { summary: w.summary } : {}),
      ...(w.worktree ? { worktree: w.worktree.path } : {}),
      ...(w.staging ? { staging: w.staging } : {}),
      ...(w.recoveryBranch ? { recoveryBranch: w.recoveryBranch } : {}),
      pendingApproval: w.pendingApproval,
      ...(w.taskId !== undefined ? { taskId: w.taskId } : {}),
    };
  }

  /** Build a WorkerResult DTO for a worker (§7.2). */
  resultOf(workerId: string): WorkerResult | null {
    const w = this.workers.get(workerId);
    if (!w) return null;
    return {
      status: w.status,
      summary: w.summary ?? "",
      ...(w.worktree ? { worktree: w.worktree.path } : {}),
      ...(w.recoveryBranch ? { recoveryBranch: w.recoveryBranch } : {}),
    };
  }
}
