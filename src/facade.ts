/**
 * The CoreAPI facade (core-blueprint.md §2).
 *
 * The single entry point every consumer calls. Each operation validates input,
 * delegates to the capability that owns it, and returns a DTO or `Result<T>` —
 * no entity instance and no LangChain/LangGraph type crosses it (§1 rule 4).
 * Namespaces not yet built in slice 1 return a typed `NOT_IMPLEMENTED` CoreError
 * so the surface is complete and later slices extend rather than add (§2.2).
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyControlPath } from "./entities/protected-paths.js";
import {
  buildSessionExport,
  renderJson,
  renderMarkdown,
  normalizeOutPath,
  type MaskSummary,
  type ExportMessage,
  type ExportToolCall,
  type ExportWrite,
  type RawExportInput,
} from "./use-cases/session-export.js";
import { CONTENT_ARG_KEYS } from "./entities/journal.js";
import type { EventBus, EventEnvelope, EventScope } from "./entities/event-bus.js";
import type { ConfigCapability } from "./entities/config-capability.js";
import type { ModelProviderAdapter } from "./adapters/model-provider.js";
import type { Warden } from "./entities/warden.js";
import type { ToolRegistry, ToolDefinition, ToolExecutor } from "./entities/tool-registry.js";
import type { Guardian, Guardrail } from "./entities/guardian.js";
import type { SessionRepository } from "./entities/ports/session-repository.js";
import { isValidSessionId } from "./adapters/repositories/session-repository.js";
import { resolveWithinRoot } from "./entities/staging-manifest.js";
import { purgeDir } from "./adapters/fs-purge.js";
import type { VcsPort } from "./entities/ports/vcs-port.js";
import type { StagingPort } from "./entities/ports/staging-port.js";
import type { FileSystemPort } from "./entities/ports/host.js";
import { Session, type SessionMetadata, type ApprovalMode, type SessionMode } from "./entities/session.js";
import { DocumentRegistry } from "./entities/document-registry.js";
import type { DocumentEntry } from "./entities/session.js";
import type { ApprovalResponse, PendingApproval } from "./entities/approvals.js";
import { Engine, type TurnResult, type RunTurnOptions } from "./use-cases/engine.js";
import { validateResponseSchema } from "./entities/structured-output.js";
import { extractImagePaths } from "./entities/image-attachment.js";
import { Subagents } from "./use-cases/subagents.js";
import { Expectations } from "./use-cases/expectations.js";
import { makeScopeTargetsReader } from "./adapters/repositories/scope-targets-reader.js";
import { maskValue, maskText } from "./use-cases/secret-mask.js";
import { sanitizeTrustedText, SANITIZED_PATH_MAX, SANITIZED_PATH_LIST_MAX, HARNESS_NOTE_MAX, boundHarnessNote } from "./entities/rollback.js";
import { type NamingPort, sessionNameMaxChars } from "./entities/ports/naming-port.js";
import type { Memory } from "./use-cases/memory.js";
import type { MemoryProvider } from "./entities/memory/memory-provider.js";
import type {
  AgentDefinition,
  AgentToolInfo,
  WorkerInfo,
  WorkerStreamEvent,
} from "./entities/subagents.js";
import { deriveAgentClass, unlistedOf, workerAllowed } from "./entities/subagents.js";
import { builtinChatAgent } from "./entities/builtin-chat.js";
import type { DispatchRequest, FanoutResult } from "./use-cases/subagents.js";
import {
  coreError,
  err,
  ErrorCode,
  ok,
  CoreErrorException,
  type CoreError,
  type Result,
} from "./entities/errors.js";
import type { Config, ConfigLayer } from "./config/schema.js";
import { validateGlobPattern } from "./entities/glob-validate.js";
import type { Skills, SkillDTO } from "./use-cases/skills.js";
import type { Prompts, PromptDTO } from "./use-cases/prompts.js";
import type { Plugins, ContextProvider, ContextLayer, PluginCommandHandler } from "./use-cases/plugins.js";
import type { RegistryStore, RegistryEntry } from "./entities/registry/registry-store.js";
import { CORE_NAMESPACE, PANELS_KEY_PREFIX, DATASETS_KEY_PREFIX } from "./entities/registry/registry-store.js";
import { validatePanelDeclaration } from "./entities/registry/panel-schema.js";
import {
  validateDatasetDeclaration,
  type DatasetDeclaration,
  type DatasetField,
  type Row,
} from "./entities/registry/dataset-schema.js";
import type { PluginMeta } from "./entities/plugins/plugin-meta.js";
import type { SkillScope } from "./entities/skills/skill.js";
import type { WorkspaceMap } from "./use-cases/workspace-map.js";
import type { AgentDiscoveryPort } from "./entities/agent-manifest.js";

export type ApprovalHandler = (req: PendingApproval) => Promise<ApprovalResponse>;

export interface SendRequest {
  input: string;
  payload?: Record<string, unknown>;
  configOverrides?: Partial<Config>;
  approvalMode?: ApprovalMode;
  /** §3.8 — a Zod schema or a JSON Schema object requesting a typed result.
   * Validated and size-capped at the boundary; the typed value is returned in
   * `TurnResult.structured`. An invalid schema is an `INVALID_INPUT` result. */
  responseSchema?: unknown;
}

export interface SessionInfo {
  id: string;
  name: string;
  summary: string;
  lastActiveAt: string;
  sizeBytes: number;
  workspace: string;
}

export interface ResumedSession {
  info: SessionInfo;
  status: string;
  pending?: PendingApproval[];
  staleDocuments: string[];
}

export interface HousekeepingNotice {
  idleSessions: number;
  idleDays: number;
}

/** A render-ready agent manifest DTO (§2.2 `agents.*`, §3.1). No entity/LangChain
 * type crosses the facade (§1 rule 4). */
export interface AgentInfo {
  name: string;
  description: string;
  active: boolean;
  reviewer: boolean;
  /** Top-level agents are orchestrators the user switches between; workers never
   * delegate (§3.1). */
  kind: "top-level" | "worker";
  /** The agent's resolved §8.2 tool names (§8.1). */
  tools: string[];
  /** The cascade source this agent resolved from (§3.1 project > global >
   * builtin); "builtin" for the built-in `chat`, an absent-source programmatic
   * registration reports "project". */
  source: "builtin" | "global" | "project";
  /** The `agent.json` file this agent was discovered from (§3.1); ABSENT for the
   * built-in `chat`. */
  file?: string;
  /** The worker's class, DERIVED from its tool list (§3.1, §9): "write" when it
   * holds any write-class tool (or an unknown tool — fail closed), else "read".
   * A reviewer is always "read". */
  class: "read" | "write";
  /** For a TOP-LEVEL agent: the workers it may dispatch (an allow list or "all")
   * (§3.1). Absent for a worker. */
  workers?: string[] | "all";
  /** For a TOP-LEVEL agent: what happens to a dispatch not on `workers` (§3.1). */
  unlisted?: "deny" | "ask" | "allow";
  /** For a TOP-LEVEL agent: the Shift+Tab cycle order (§3.1). */
  order?: number;
  /** For a TOP-LEVEL agent: the optional display label shown in the status bar
   * bracket (§3.1); the client falls back to `name` when absent. */
  label?: string;
  /** For a TOP-LEVEL agent: whether entering it needs a one-time confirmation
   * (§3.1); always true when `unlisted` is `allow`. */
  confirm?: boolean;
}

/** A render-ready document-registry DTO (§4.5, §2.2 `documents.*`). */
export interface DocumentInfo {
  path: string;
  name: string;
  trust: "live" | "snapshot" | "cached";
  lines: number;
  hash: string;
  stale: boolean;
  turnAdded: number;
}

/** A render-ready persisted-chain message DTO (§5.4 `loadMessages`). */
export interface MessageDTO {
  role: string;
  content: string;
  toolCallId?: string;
}

/** A render-ready dataset-listing DTO (§12.7 `datasets.list`): the registered
 * name, its description, and the declared default fields (no rows). */
export interface DatasetInfo {
  name: string;
  description: string;
  fields?: DatasetField[];
}

/** Everything the facade needs, wired by boot. */
export interface FacadeDeps {
  bus: EventBus;
  config: ConfigCapability;
  model: ModelProviderAdapter;
  warden: Warden;
  guardian: Guardian;
  registry: ToolRegistry;
  sessions: SessionRepository;
  workspaceRoot: string;
  /** The VCS adapter (§7.3) backing `workspace.branch`/`workspace.diff`. */
  vcs: VcsPort;
  /** The durable staging layer (§7.4); `session.delete` removes a session's
   * owned staging folders through it (§5.8). */
  staging: StagingPort;
  /** The workspace filesystem port (§8.2) backing `workspace.files` and the
   * document registry reads (§4.5). Reads are free (§9). */
  fileSystem: FileSystemPort;
  makeEngine: (turnMetadata?: () => string[]) => Engine;
  /** Read an effective limit value (§13.11); read fresh so a config edit takes
   * effect. Used for the rollback harness-note caps (ROLL3). Optional: absent in
   * tests (falls back to the entity defaults). */
  getLimit?: (key: string) => number;
  /** Emit ONE `LIMIT_HIT` for a key through the runtime `LimitsPort` (§13.11):
   * used by the §3.8 response-schema boundary (a `safety`/`deny` size bound).
   * Returns the one-line notice. Optional: absent in tests. */
  limitHit?: (key: string, observed?: number, session?: string) => string;
  /**
   * §9.5 — the unattended-approval countdown timer seam. Schedules `fire` after
   * `ms` and returns a cancel function. The interactive confirm loop uses it to
   * race an `onApproval` wait against the `limits.approval.autoDenySeconds`
   * countdown WITHOUT a real sleep in tests: a fake clock drives `fire`
   * deterministically. Defaults to `setTimeout`/`clearTimeout` (boot). Absent in
   * a pure in-memory test → the real-timer default is used. */
  setApprovalTimer?: (ms: number, fire: () => void) => () => void;
  /**
   * Resolve the session's active top-level agent definition by name (§2.7),
   * supplied by the facade from the shared Subagents registry. The engine and
   * every worker read it LIVE to drive the prompt overlay, the bound tool set,
   * the dispatchable workers, and the `unlisted` posture. Returns undefined for
   * an unknown name (the engine then falls back to the complete tool set).
   */
  getActiveAgent?: (mode: string) => AgentDefinition | undefined;
  /**
   * Build the shared Subagents use-case (§7); lazily constructed by the facade.
   * The facade supplies `getSessionRules` so the merge gate resolves against the
   * same ruleset the engine uses — config permissions plus the active
   * orchestrator session's live session-scoped rules (§15.1#4).
   */
  makeSubagents: (
    getSessionRules: () => import("./config/schema.js").PermissionRule[],
    getOwnerSessionId?: () => string,
    getApprovalMode?: () => import("./entities/session.js").ApprovalMode,
    getActiveAgent?: () => AgentDefinition | undefined,
  ) => Subagents;
  /** The resolved process-start active top-level agent (§2.1, §2.7): the host's
   * `CoreOptions.startAgent` (the CLI's headless selection — first `deny`, or
   * first `allow` under `--enable-write`). When set, a NEW or RESUMED session
   * starts in this agent instead of the built-in `chat`. It is fixed for the
   * process; `session.setMode` is the only way to change the active agent
   * mid-session. The removed `autoApprove` alias no longer exists. */
  startAgent?: string;
  /** The approval mode a NEW or RESUMED session is created with (§2.5, §8):
   * the host's `CoreOptions.startSessionApprovalMode`. Omitted → `interactive`.
   * Headless sets `"headless"` so every session the run creates — including a
   * routine's separate `runInNewSession` — never asks (cli §8). A per-send
   * `approvalMode` still overrides it for one turn. */
  startSessionApprovalMode?: import("./entities/session.js").ApprovalMode;
  /** The managed-layer `autoApproveAllowed` control (§13.5): false forbids
   * entering an `unlisted: allow` agent through `session.setMode` (and refuses
   * an `allow` start agent at construction) with `AUTO_APPROVE_FORBIDDEN`. */
  autoApproveAllowed?: () => boolean;
  /** The shared Memory capability (§6), constructed by boot. */
  memory: Memory;
  /** The Skills capability (§12.1), constructed by boot. */
  skills: Skills;
  /** The Manuals capability (§12.8), constructed by boot. */
  manuals: import("./use-cases/manuals.js").Manuals;
  /** The Prompts capability (§12.2), constructed by boot. */
  prompts: Prompts;
  /** The Plugins capability (§12.4), constructed by boot. */
  plugins: Plugins;
  /** The namespaced registry store (§12.5), shared with the plugins' scoped API. */
  registryStore: RegistryStore;
  /** Register an observability exporter into the writer's live set (§10.8). The
   * facade seam and the plugins' scoped seam both route here, so one exporter
   * set feeds the writer. */
  registerExporter: (exporter: import("./entities/observability/obs-record.js").ObsExporter) => void;
  /** §8.7 — the live set of plugin-contributed INGEST chunkers, read by the
   * Ingest use-case through the internal `chunkers()` accessor. A registered
   * chunker that `matches` a source wins over the builtins (core stays
   * parser-free). Absent → no plugin chunkers (builtins only). */
  chunkers?: () => import("./entities/chunker.js").Chunker[];
  /** Registered plugin commands by name (§12.4). routines bind through here. */
  commands: Map<string, { pluginId: string; handler: PluginCommandHandler }>;
  /** The context-provider registrar + reader shared with the engine (§4, §12.4). */
  contextProviders: {
    register(layer: ContextLayer, provider: ContextProvider): void;
    blocks(layer: ContextLayer): string[];
  };
  onApproval?: ApprovalHandler;
  output?: (text: string) => void;
  /** The observability writer (§10), constructed by boot. Backs the
   * `observability` namespace query/tail and is closed on shutdown (§14). */
  obsWriter: import("./use-cases/obs-writer.js").ObsWriter;
  /** The MCP client (§8.4), constructed by boot. Backs the `mcp` namespace and
   * its servers are disconnected on shutdown (§14). */
  mcpClient: import("./use-cases/mcp-client.js").McpClient;
  /** The workspace-map use-case (§8.2): the structural index behind
   * `workspace.map` and the `workspace_map` tool, hash-cached (§8.2). */
  workspaceMap: WorkspaceMap;
  /** The filesystem agent-discovery port (§3.1, §7.1) backing `agents.reindex`.
   * Discovers manifests from `.voidrift/agents/` (workspace) and the global dir;
   * builtin/plugin manifests register through `register.agent`. */
  agentDiscovery: AgentDiscoveryPort;
  /** Agent templates registry (§12.4, §13.9.1): tracks plugin-registered agent
   * templates for discovery during config.init and cleanup on plugin disable. */
  agentTemplatesRegistry: import("./adapters/agent-templates-registry.js").AgentTemplatesRegistry;
  /** The host-only `config.init` use-case (§13.9.1). Bound to the `config`
   * namespace's `init` method; it is NOT a model tool and NOT on the plugin
   * ScopedCoreApi. */
  configInit: import("./use-cases/config-init.js").ConfigInit;
  /** The host-only `config.doctor` runner (§13.9.2). Bound to the `config`
   * namespace's `doctor` method; it is NOT a model tool and NOT on the plugin
   * ScopedCoreApi. Optional — a core built without it runs the host-level
   * `doctorConfigHome` path instead (the CLI binds that directly). */
  configDoctor?: (
    opts?: import("./use-cases/config-doctor.js").DoctorOptions,
  ) => Promise<import("./use-cases/config-doctor.js").DoctorReport>;
  /** The host-only `config.access` runner (§7.4). Bound to the `config`
   * namespace's `access` method; it is NOT a model tool and NOT on the plugin
   * ScopedCoreApi. Optional — a core built without it has `config.access`
   * return an INTERNAL error (the CLI binds the host-level
   * `accessReportConfigHome` directly). */
  configAccess?: (
    opts?: { agent?: string },
  ) => Promise<import("./use-cases/access-report.js").AccessReport>;
  /** The mutation journal store (§10.11). HOST-ONLY: backs `session.journal`
   * read access for a future revert plan. It is NOT a model tool, NOT on any
   * allow list, and absent from the plugin ScopedCoreApi. Optional — a core
   * built without a journal simply exposes an empty journal. */
  journalStore?: import("./entities/ports/journal-store.js").JournalStore;
  /** The rollback service (§10.12). HOST-ONLY: backs `session.moves/undo/redo/
   * goto`. NOT a model tool, NOT on any allow list, absent from the plugin
   * ScopedCoreApi — the same posture as `config.init` and the journal read API.
   * Optional — a core built without it reports rollback as disabled. */
  rollback?: import("./use-cases/rollback.js").RollbackService;
  /** The session-naming port (§5.5). After a completed turn the facade asks it
   * to propose a short name; `null` keeps the previous name. Optional — absent →
   * the first-line fallback only (no passive model call). Boot injects the real
   * implementation over `transientChatModel` when the host did NOT inject a
   * custom `chatModelFactory`; with a custom factory the default is a NO-OP
   * unless a `namingPort` is injected explicitly (so finite scripted fixtures
   * are never perturbed). */
  namingPort?: NamingPort;
}

function newId(): string {
  return randomBytes(4).toString("hex");
}

/** §9.5 — the default unattended-approval countdown timer: a real
 * `setTimeout`/`clearTimeout`. Injected via `FacadeDeps.setApprovalTimer` so a
 * test drives the countdown with a fake clock and never sleeps for real. The
 * timer is `unref`'d so a pending countdown never keeps the process alive. */
function defaultApprovalTimer(ms: number, fire: () => void): () => void {
  const t = setTimeout(fire, ms);
  (t as { unref?: () => void }).unref?.();
  return () => clearTimeout(t);
}

function toInfo(m: SessionMetadata): SessionInfo {
  return {
    id: m.id,
    // §5.5 — a stored name is attacker-influenced (an old/planted session file):
    // scrub control/ANSI/OSC/bidi + a forged `[harness note]` out of every name
    // a host lists or shows, through the shared trusted-channel sanitizer.
    name: sanitizeTrustedText(m.name, sessionNameMaxChars()),
    summary: m.summary,
    lastActiveAt: m.lastActiveAt,
    sizeBytes: m.sizeBytes,
    workspace: m.workspace,
  };
}

export class CoreAPI {
  /** Live, in-process sessions, keyed by id. */
  private readonly live = new Map<string, Session>();
  /**
   * Host-set launch defaults applied to every NEW session (§2.1, §2.5, §8),
   * overriding the construction-time `CoreOptions.startAgent` /
   * `startSessionApprovalMode`. The headless CLI sets these AFTER boot (once it
   * has read `agents.list()` to pick the first `unlisted: deny`/`allow` start
   * agent and knows the run is headless), so a routine's separate
   * `runInNewSession` inherits the same agent and never-ask posture. Undefined
   * fields fall back to the construction-time options. */
  private launchAgentOverride: string | undefined;
  private launchApprovalOverride: import("./entities/session.js").ApprovalMode | undefined;
  /**
   * The session currently driving work (the orchestrator for any fan-out it
   * dispatches). Its live session-scoped rules feed the shared Subagents merge
   * gate so a session-scoped `merge_worktree` rule binds the merge exactly as it
   * binds every other write (§15.1#4).
   */
  private activeSession: Session | undefined;

  /**
   * In-flight turn promises, keyed by session id (§14.3 step 1). A turn runs
   * inline inside `send`/`confirm`; shutdown awaits any still running — bounded
   * by `turnShutdownGraceMs` — so its `TURN_COMPLETE`/`TURN_CANCELLED`/`ERROR`
   * spans are emitted into a still-open writer before the writer closes.
   */
  private readonly inFlightTurns = new Map<string, Promise<unknown>>();

  /**
   * §3.3/§5.2 — the ONE shared `AbortController` per in-flight turn, keyed by
   * session id. Created at the start of `send`/`confirm` and threaded into the
   * engine (→ `agent.stream`'s `config.signal`), so `session.cancel` aborts the
   * in-flight model HTTP request and every bound tool/worker through the single
   * signal — no second cancel path. Cleared in the turn's `finally`. */
  private readonly turnAborts = new Map<string, AbortController>();

  /**
   * One-shot `workspace.inject(label, content)` context, per session (§4.2).
   * Each block is masked by the secret detector on the way in (§1 rule 15,
   * §10.10) and drained at the start of the next turn so it rides exactly once.
   */
  private readonly injected = new Map<string, string[]>();

  /** The active agent definition name (§2.2 `agents.activate`); undefined when
   * the orchestrator default is active. Core-scoped selection, not session
   * state. */
  private activeAgentName?: string;

  /** §5.5 — in-flight passive naming calls (one may be pending per session). A
   * headless exit / shutdown awaits these within a short cap and aborts them;
   * they never block a turn or its result. */
  private readonly namingInFlight = new Map<string, Promise<void>>();
  /** §5.5 — aborts any pending naming call on shutdown. */
  private readonly namingAbort = new AbortController();
  /** §5.5 — the turnCount at which each session was last (re-)named, so the
   * model is called only when the conversation grew by ≥1 completed turn since
   * the last evaluation. */
  private readonly lastNamedTurnCount = new Map<string, number>();

  constructor(private readonly deps: FacadeDeps) {
    // §10.12 — wire the rollback conversation-tip writer. The RollbackService
    // owns the all-or-nothing per-step traversal (file half then conversation
    // tip, reversing the file half if the tip write fails); it calls back here
    // to write the tip because the facade owns session resolution + the engine.
    this.deps.rollback?.setWriteTip(async (sessionId, target) => {
      const session = this.live.get(sessionId) ?? (await this.rehydrate(sessionId));
      if (!session) {
        throw new CoreErrorException(coreError(ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} not found`));
      }
      await this.deps.makeEngine().writeConversationTip(session, target.checkpointId);
    });
    // §10.12 — restore the session CONTEXT half + RESET derived caches on every
    // traversal, from the target move's recorded context (null = session start).
    this.deps.rollback?.setRestoreContext(async (sessionId, context) => {
      const session = this.live.get(sessionId) ?? (await this.rehydrate(sessionId));
      if (!session) return;
      this.restoreSessionContext(session, context);
    });
  }

  /**
   * Restore the session CONTEXT half and RESET the conversation-derived caches on
   * a rollback traversal (§10.12). `context` is the TARGET move's recorded
   * context, or `null` for pointer 0 (session start).
   *
   * Per-field classification of session state that lives OUTSIDE the checkpoint:
   *   - rollingSummary  — RESTORE from the move (null → cleared). It is
   *     injected into every request (context-pipeline deriveView), so a stale
   *     summary would describe now-undone turns.
   *   - usageAnchor     — RESTORE from the move. Backs the context% meter and
   *     cost totals; must match the target move.
   *   - readPaths       — RESET. The "read the file first" guard must not trust a
   *     read from an undone turn (the harness note tells the model to re-read).
   *   - stalePaths      — RESET. Staleness is re-derived from the restored tree.
   *   - documents       — RESET. The document registry/manifest is rebuilt from
   *     the restored files, not from undone reads.
   *   - lane (counters) — RESET. The per-turn direct-write lane is turn-scoped;
   *     a traversal starts a clean accounting (it also resets each turn/setMode).
   *   - metadata.rollingSummary — mirrored from the restored rollingSummary so a
   *     later resume reloads the restored value.
   * LEAVE untouched (explicitly NOT undone): the memory/reflection/suggestion
   * stores and all observability counters — they record what happened, not the
   * reversible working state. The per-turn tool-result cache is checkpoint-
   * derived (the full result stays on disk, §8.3) and the reset registry +
   * re-read guard above already prevent trusting an undone read.
   */
  private restoreSessionContext(
    session: Session,
    context: import("./entities/rollback.js").MoveContext | null,
  ): void {
    // RESTORE — context state injected into every request.
    if (context?.rollingSummary !== undefined) {
      session.rollingSummary = {
        summary: context.rollingSummary,
        // The folded-through turn is re-derived on the next compaction; keep a
        // marker so deriveView treats the restored summary as active.
        foldedThroughTurn: session.rollingSummary?.foldedThroughTurn ?? session.turn,
        updatedAt: new Date().toISOString(),
      };
    } else {
      // null context (session start) or a move with no summary → no summary
      // applied; the model re-reads/re-folds.
      delete session.rollingSummary;
    }
    if (session.rollingSummary) session.metadata.rollingSummary = session.rollingSummary;
    else delete session.metadata.rollingSummary;
    if (context?.usageAnchor !== undefined) session.usageAnchor = context.usageAnchor;
    else delete session.usageAnchor;
    // RESET — conversation-derived caches that must not trust an undone turn.
    session.readPaths = new Set<string>();
    session.stalePaths = new Set<string>();
    session.documents = new Map();
    session.lane.reset();
    session.readLane.reset();
    // Persist the reset/restored state so a later resume reloads it.
    void this.mirror(session).catch(() => undefined);
  }

  // ── session ──────────────────────────────────────────────────────────────
  readonly session = {
    /** Host-only (§2.1, §8): set the launch defaults every NEW session inherits
     * — the start agent and the approval posture. The headless CLI calls this
     * after boot, once it has selected the start agent, so a routine's separate
     * `runInNewSession` runs under the same agent and never-ask posture. */
    setLaunchDefaults: (defaults: { agent?: string; approvalMode?: ApprovalMode }): void =>
      this.setLaunchDefaults(defaults),
    /**
     * Start a NEW session whose first prompt is `firstPrompt` (§12.3, §5.7) — a
     * routine runs clean every time, never inheriting a prior conversation. It
     * DOES inherit the process launch posture (§2.5, §8): the new session is
     * created with the effective start agent and the turn runs with the
     * effective start approval mode, so a headless `--routine` NEVER asks and can
     * never reach `waiting_for_approval`/exit 5, exactly like `--prompt`. The TUI
     * leaves the posture `interactive`, so interactive `/routine run` still asks.
     * This is the ONE implementation; the plugin ScopedCoreApi's
     * `session.runInNewSession` delegates here (core §12.4). Returns the turn DTO
     * or the CoreError.
     */
    runInNewSession: async (firstPrompt: string, opts?: { name?: string }): Promise<TurnResult | CoreError> => {
      const created = await this.session.create({ ...(opts?.name ? { name: opts.name } : {}) });
      if (!created.ok) return created.error;
      const mode = this.effectiveStartApprovalMode();
      const sent = await this.session.send(created.value.id, {
        input: firstPrompt,
        ...(mode ? { approvalMode: mode } : {}),
      });
      return sent.ok ? sent.value : sent.error;
    },
    create: async (opts?: { name?: string; config?: Partial<Config> }): Promise<Result<SessionInfo>> => {
      const now = new Date().toISOString();
      const meta: SessionMetadata = {
        id: newId(),
        name: opts?.name ?? "untitled",
        summary: "idle",
        workspace: this.deps.workspaceRoot,
        startedAt: now,
        lastActiveAt: now,
        turnCount: 0,
        sizeBytes: 0,
        namePinned: Boolean(opts?.name),
      };
      const session = new Session(meta);
      // §2.7 — a new session starts in `chat`, unless the host selected a
      // process-start active agent (§2.1): `CoreOptions.startAgent`, or the
      // deprecated `autoApprove` alias resolved to the first `unlisted: allow`
      // top-level agent by `order`.
      { const sa = this.effectiveStartAgent(); if (sa) session.mode = sa; }
      // §2.5/§8 — a new session inherits the process launch posture when the host
      // set one (headless → never asks); the TUI omits it, leaving `interactive`.
      { const am = this.effectiveStartApprovalMode(); if (am) session.approvalMode = am; }
      this.live.set(session.id, session);
      await this.mirror(session);
      return ok(toInfo(meta));
    },

    resume: async (id: string): Promise<Result<ResumedSession>> => {
      const persisted = await this.deps.sessions.load(id);
      if (!persisted) {
        return err(coreError(ErrorCode.SESSION_NOT_FOUND, `session ${id} not found`));
      }
      // §5.5 — a stored name is attacker-influenced (an old or planted session
      // file): scrub it through the shared trusted-channel sanitizer before it
      // is loaded, stored, or shown.
      persisted.metadata.name = sanitizeTrustedText(persisted.metadata.name, sessionNameMaxChars());
      const session = new Session(persisted.metadata);
      // §2.7 — the active agent is NOT persisted and NOT inherited by resume: a
      // resumed session starts in `chat`, unless the host selected a process-
      // start active agent (§2.1): `CoreOptions.startAgent` / `autoApprove` alias.
      { const sa = this.effectiveStartAgent(); if (sa) session.mode = sa; }
      session.sessionRules = persisted.sessionRules;
      session.approvalMode = persisted.approvalMode;
      session.pending = persisted.pending;
      session.lastStatus = persisted.lastStatus;
      session.turns = persisted.turns ?? [];
      if (persisted.metadata.rollingSummary) session.rollingSummary = persisted.metadata.rollingSummary;
      for (const d of persisted.documents) {
        session.registerDocument(d);
        if (d.stale) session.markStale(d.path);
        else session.markRead(d.path);
      }
      this.live.set(session.id, session);
      // On-resume staleness check: re-hash each persisted document (§5.3). In
      // slice 1 the mirror already carries the stale flag; the live set honors it.
      const staleDocuments = persisted.documents.filter((d) => d.stale).map((d) => d.path);
      this.deps.bus.emit("SESSION_RESUMED", { sessionId: id }, { session: id });
      return ok({
        info: toInfo(session.metadata),
        status: session.lastStatus,
        pending: session.pending,
        staleDocuments,
      });
    },

    list: async (): Promise<SessionInfo[]> => {
      const metas = await this.deps.sessions.list();
      return metas.map(toInfo);
    },

    /**
     * The HOST-ONLY mutation journal read API (§10.11). Not a model tool, not on
     * any allow list, and absent from the plugin ScopedCoreApi — the same host-
     * only posture as `config.init`. `list` returns entry METADATA only (no blob
     * bytes); `blob` returns a RAW blob by sha for a future revert plan. When no
     * journal store is wired, `list` is empty and `blob` is null.
     */
    journal: {
      list: async (
        sessionId: string,
        opts?: { limit?: number; afterSeq?: number },
      ): Promise<import("./entities/journal.js").JournalEntry[]> => {
        if (!this.deps.journalStore) return [];
        // The fs store validates the session id (§10.11 / LOW-1); an invalid id
        // yields an empty list rather than throwing out of the host-only API.
        try {
          return await this.deps.journalStore.list(sessionId, opts);
        } catch {
          return [];
        }
      },
      blob: async (sessionId: string, sha: string): Promise<Buffer | null> => {
        if (!this.deps.journalStore) return null;
        // The store validates `sha` (64-hex) and verifies integrity on read; a
        // bad/tampered sha throws there. Host-only read API — surface null for an
        // invalid id rather than throwing out of the facade.
        try {
          return await this.deps.journalStore.getBlob(sessionId, sha);
        } catch {
          return null;
        }
      },
    },

    /**
     * The HOST-ONLY rollback operations (§10.12). `moves` reports the timeline;
     * `undo`/`redo`/`goto` step the user's main working tree between turns. NOT
     * model tools, NOT on any allow list, absent from the plugin ScopedCoreApi
     * — the same host-only posture as `config.init` and `session.journal`. They
     * run only while the session is IDLE (a running turn refuses `SESSION_BUSY`);
     * an unknown goto id answers `NOT_FOUND`. After a successful restore a masked
     * SYSTEM note is appended to the conversation so the model re-reads the
     * restored files.
     */
    moves: async (
      sessionId: string,
    ): Promise<Result<import("./use-cases/rollback.js").MovesReport>> => {
      if (!this.deps.rollback) return ok({ enabled: false });
      const session = this.live.get(sessionId) ?? (await this.rehydrate(sessionId));
      if (!session) return err(coreError(ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} not found`));
      return ok(await this.deps.rollback.moves(sessionId));
    },

    undo: async (
      sessionId: string,
      opts?: { confirmOverwrite?: string[] },
    ): Promise<Result<import("./use-cases/rollback.js").RollbackOutcome>> =>
      this.applyRollback(sessionId, "undo", undefined, opts),

    redo: async (
      sessionId: string,
      opts?: { confirmOverwrite?: string[] },
    ): Promise<Result<import("./use-cases/rollback.js").RollbackOutcome>> =>
      this.applyRollback(sessionId, "redo", undefined, opts),

    goto: async (
      sessionId: string,
      id: number,
      opts?: { confirmOverwrite?: string[] },
    ): Promise<Result<import("./use-cases/rollback.js").RollbackOutcome>> =>
      this.applyRollback(sessionId, "goto", id, opts),

    rename: async (id: string, name: string): Promise<Result<SessionInfo>> => {
      const session = this.live.get(id) ?? (await this.rehydrate(id));
      if (!session) return err(coreError(ErrorCode.SESSION_NOT_FOUND, `session ${id} not found`));
      session.metadata.name = name;
      session.metadata.namePinned = true;
      await this.mirror(session);
      return ok(toInfo(session.metadata));
    },

    delete: async (
      id: string,
    ): Promise<Result<{ reclaimedBytes: number; remainingBranches: string[] }>> => {
      // §5.8 / D27 — remove EVERYTHING the session owns: in-memory state, the
      // session cache, its owned staging folders, and its `voidrift-run-*`
      // worktrees/branches. No refusal, no force, no special case for the current
      // or a paused session. Recovery branches are the user's work and stay; the
      // result lists the remaining ones.
      //
      // DESTRUCTIVE SAFETY. The id is validated FIRST — a bad id deletes NOTHING
      // and returns a typed error. Every path is derived from the VALIDATED 8-hex
      // id joined under a fixed harness-owned root and checked for containment
      // with the ONE `resolveWithinRoot` (no second containment impl); removal is
      // symlink-safe (`fs.rm` unlinks a symlink, never its target — `purgeDir`).
      //
      // ORDERING. Cancel in-flight work first; then remove cache, staging, and
      // worktrees, collecting any sub-step failure NON-FATALLY (WARNING_EMITTED);
      // the session partition is removed LAST so a failed delete can be retried —
      // while the partition still exists the session reappears in `list`/`resume`.
      if (!isValidSessionId(id)) {
        return err(coreError(ErrorCode.INVALID_INPUT, `invalid session id: ${JSON.stringify(id)}`, { field: "id" }));
      }
      const live = this.live.get(id);
      const persisted = live ? null : await this.deps.sessions.load(id);
      if (!live && !persisted) {
        // A missing session is NOT_FOUND with NO filesystem effect (§5.8).
        return err(coreError(ErrorCode.SESSION_NOT_FOUND, `session ${id} not found`));
      }

      // 1) Cancel any work in flight (the one shared cancel path, §3.3).
      await this.session.cancel(id);

      let reclaimedBytes = 0;
      const remainingBranches: string[] = [];
      const warn = (step: string, e: unknown): void => {
        // Non-fatal, never silent (§5.8): one sub-step's failure never aborts the
        // others; it is reported and collected, and the delete proceeds.
        this.deps.bus.emit(
          "WARNING_EMITTED",
          { category: "session", source: `delete:${step}`, pattern: String(e) },
          { session: id },
        );
      };

      // 2) Remove the session cache `.voidrift/cache/session/{id}/` — containment
      // proven against the fixed cache root, then a symlink-safe recursive purge.
      try {
        const cacheRoot = path.join(this.deps.workspaceRoot, ".voidrift", "cache", "session");
        const cacheDir = resolveWithinRoot(cacheRoot, id);
        if (cacheDir !== null) reclaimedBytes += purgeDir(cacheDir);
      } catch (e) {
        warn("cache", e);
      }

      // 2b) Remove the pass-by-reference run cache `.voidrift/cache/run/{id}/`
      // (§7.2 — the run cache is cleaned with its session), containment-proven
      // against the fixed run-cache root like the session cache above.
      try {
        const runRoot = path.join(this.deps.workspaceRoot, ".voidrift", "cache", "run");
        const runDir = resolveWithinRoot(runRoot, id);
        if (runDir !== null) reclaimedBytes += purgeDir(runDir);
      } catch (e) {
        warn("run-cache", e);
      }

      // 3) Remove the staging folders OWNED BY this session (ownership proven from
      // each manifest's recorded sessionId, §5.8) — never a folder we cannot prove.
      try {
        const staged = await this.deps.staging.removeForSession(id);
        reclaimedBytes += staged.reclaimedBytes;
      } catch (e) {
        warn("staging", e);
      }

      // 4) Remove this session's worktrees + `voidrift-run-*` branches (bounded);
      // preserve `voidrift-recovery-*` and report the remaining ones (§5.8).
      try {
        const wt = await this.deps.vcs.removeWorktreesForSession(id);
        reclaimedBytes += wt.reclaimedBytes;
        remainingBranches.push(...wt.remainingRecoveryBranches);
      } catch (e) {
        warn("worktrees", e);
      }

      // Drop live/in-memory state before the partition is gone.
      reclaimedBytes += live?.metadata.sizeBytes ?? persisted?.metadata.sizeBytes ?? 0;
      this.live.delete(id);
      this.injected.delete(id);
      if (this.activeSession?.id === id) this.activeSession = undefined;

      // 5) Remove the partition LAST (id-validated in the repository) so a failed
      // delete can be retried — the session stays listed/resumable until here.
      try {
        await this.deps.sessions.remove(id);
      } catch (e) {
        warn("partition", e);
      }

      this.deps.bus.emit("SESSION_DELETED", { id, reclaimedBytes, remainingBranches }, { session: id });
      return ok({ reclaimedBytes, remainingBranches });
    },

    send: async (sessionId: string, req: SendRequest): Promise<Result<TurnResult>> => {
      if (!req || typeof req.input !== "string" || req.input.trim() === "") {
        return err(coreError(ErrorCode.EMPTY_MESSAGE, "message is empty", { field: "input" }));
      }
      const session = this.live.get(sessionId) ?? (await this.rehydrate(sessionId));
      if (!session) return err(coreError(ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} not found`));
      if (session.turnActive) {
        return err(coreError(ErrorCode.TURN_ACTIVE, "a turn is already active on this session"));
      }
      // §2.5/§2.7/§9.5 — a `send` request can NEVER select the host-only
      // `auto_approve` posture or a conversation mode: `vibe`/`auto_approve` and
      // any `mode` field are rejected, so only `session.setMode` (host-only) and
      // the process-start option change the mode.
      const reqMode = (req as { mode?: unknown }).mode;
      if (reqMode !== undefined) {
        return err(coreError(ErrorCode.INVALID_INPUT, "a send request cannot select a conversation mode", { field: "mode" }));
      }
      if ((req.approvalMode as string) === "auto_approve") {
        return err(coreError(ErrorCode.INVALID_INPUT, "auto_approve cannot be selected by a send request", { field: "approvalMode" }));
      }
      if (req.approvalMode) session.approvalMode = req.approvalMode;

      // A turn runs only with a resolved model (§3.3).
      try {
        this.deps.model.resolve();
      } catch (e) {
        const ce = e instanceof CoreErrorException ? e.error : coreError(ErrorCode.MODEL_NOT_CONFIGURED, String(e));
        this.deps.bus.emit("ERROR_OCCURRED", { source: "engine", message: ce.message }, { session: sessionId });
        return err(ce);
      }

      // §3.8 — validate and size-cap a requested response schema at the boundary
      // BEFORE the turn starts; an invalid schema is a typed INVALID_INPUT result
      // (no model call). The schema itself is never logged (§3.8d).
      const runOptions: RunTurnOptions = {};
      if (req.responseSchema !== undefined) {
        const v = validateResponseSchema(req.responseSchema, this.deps.config.effectiveLimit("tools.responseSchemaMaxBytes"));
        if (!v.ok) {
          // §13.11 — `tools.responseSchemaMaxBytes` is a `safety`/`deny` size
          // bound (a huge schema is a DoS/parse surface): the refusal was
          // previously silent on the port. When the size cap is what bit, emit
          // EXACTLY ONE LIMIT_HIT naming the key + raise path. A layer may set
          // the action to `warn`, but this is a safety/download-class bound — it
          // keeps refusing and still emits the hit (§13.11).
          if (v.reason === "responseSchema exceeds the size cap") {
            const cap = this.deps.config.effectiveLimit("tools.responseSchemaMaxBytes");
            const notice = this.deps.limitHit?.("tools.responseSchemaMaxBytes", cap, sessionId);
            return err(coreError(ErrorCode.INVALID_INPUT, notice ?? v.reason, { field: "responseSchema" }));
          }
          return err(coreError(ErrorCode.INVALID_INPUT, v.reason, { field: "responseSchema" }));
        }
        runOptions.responseSchema = v.value;
      }
      // §3.3 / cli §3.7 — image attachment paths arrive as structured input in
      // `SendRequest.payload.images` (a string or string[]).
      const imagePaths = extractImagePaths(req.payload);
      if (imagePaths.length > 0) runOptions.imagePaths = imagePaths;

      session.turnActive = true;
      this.activeSession = session;
      // Record the turn input for the read-only plugin workspace surface
      // (retrieval-blueprint §5 per-turn prefetch); a synchronous provider reads
      // it as a pre-resolved snapshot (core §4).
      session.lastUserInput = req.input;
      // Track this turn so shutdown can await it within the grace (§14.3 step 1).
      let sendSettle!: () => void;
      this.inFlightTurns.set(sessionId, new Promise<void>((r) => (sendSettle = r)));
      // §3.3/§5.2 — one shared AbortController for this turn; `session.cancel`
      // aborts it to stop the in-flight model request and every tool/worker.
      const turnAbort = new AbortController();
      this.turnAborts.set(sessionId, turnAbort);
      runOptions.signal = turnAbort.signal;
      try {
        // §10.6 — seed the session's sequence detector from this workspace's prior
        // sessions at the real session-start boundary, BEFORE live observation (after the turn-active mark, so a concurrent send is still rejected), so
        // the cross-session repeated-sequence count is non-zero in production. The
        // call is idempotent per session (the writer guards with a `seeded` set),
        // bounded, and best-effort: a failure never blocks the turn.
        await this.deps.obsWriter
          .seedSequencesFromPriorSessions(session.id, this.deps.workspaceRoot)
          .catch((e) => this.deps.output?.(`obs sequence seed: ${e instanceof Error ? e.message : String(e)}`));
        // §10.6 — mark a new live turn on the sequence detector so a repeated
        // procedure counts toward the "three distinct turns" qualifier and the
        // per-turn signal cap resets.
        this.deps.obsWriter.beginSequenceTurn(session.id);
        const engine = this.deps.makeEngine(() => this.drainInjected(sessionId));
        let result = await engine.runTurn(session, req.input, runOptions);
        // Interactive mode: resolve asks via the host callback, then confirm.
        while (
          result.status === "waiting_for_approval" &&
          session.approvalMode === "interactive" &&
          this.deps.onApproval &&
          result.pending &&
          result.pending.length > 0
        ) {
          // §3.3/§5.2 — a cancel while waiting on an approval resolves the wait
          // as cancelled: race the host's approval against the turn's shared
          // signal so the pending ask never hangs the cancelled turn.
          if (turnAbort.signal.aborted) {
            result = { status: "cancelled", text: "", toolsUsed: [], model: result.model, usage: result.usage, pending: [] };
            session.pending = [];
            break;
          }
          const cancelledMarker = Symbol("cancelled");
          const autoDeniedMarker = Symbol("auto-denied");
          // §9.5 — the unattended-approval countdown. When
          // `limits.approval.autoDenySeconds` is non-zero, a pending interactive
          // prompt left unanswered past the countdown AUTO-DENIES (deny-and-
          // continue, the same fail-closed outcome as a reject), recorded in the
          // trail as PERMISSION_RESOLVED `decision: "reject"` by `engine.confirm`.
          // The default `0` disables it and the ask waits (or the
          // `permissionsApprovalTimeoutMs` seam governs). The countdown is armed
          // PER prompt and cancelled the moment a human answers or the turn is
          // cancelled, so it never fires against an answered or abandoned ask.
          const autoDenySeconds = this.deps.getLimit?.("approval.autoDenySeconds") ?? 0;
          const setTimer = this.deps.setApprovalTimer ?? defaultApprovalTimer;
          let cancelAutoDeny: (() => void) | undefined;
          const autoDenyRace =
            autoDenySeconds > 0
              ? new Promise<typeof autoDeniedMarker>((r) => {
                  cancelAutoDeny = setTimer(autoDenySeconds * 1000, () => r(autoDeniedMarker));
                })
              : null;
          const raced = await Promise.race([
            this.deps.onApproval(result.pending[0]!),
            new Promise<typeof cancelledMarker>((r) => {
              if (turnAbort.signal.aborted) return r(cancelledMarker);
              turnAbort.signal.addEventListener("abort", () => r(cancelledMarker), { once: true });
            }),
            ...(autoDenyRace ? [autoDenyRace] : []),
          ]);
          // A human answered or the turn was cancelled first: cancel the pending
          // countdown so a late fire never resolves a settled race.
          cancelAutoDeny?.();
          if (raced === cancelledMarker) {
            result = { status: "cancelled", text: "", toolsUsed: [], model: result.model, usage: result.usage, pending: [] };
            session.pending = [];
            break;
          }
          if (raced === autoDeniedMarker) {
            // §9.5 — auto-deny: confirm the pending ask as a REJECT (the normal
            // denial event) so the turn continues exactly as on a human reject.
            result = await engine.confirm(
              session,
              { requestId: result.pending[0]!.id, decision: "reject" },
              turnAbort.signal,
            );
            continue;
          }
          result = await engine.confirm(session, raced, turnAbort.signal);
        }
        session.metadata.turnCount += 1;
        session.metadata.lastActiveAt = new Date().toISOString();
        session.metadata.summary =
          result.status === "waiting_for_approval" ? "waiting for your approval" : "idle";
        // §5.5 — set the first-turn name fallback immediately, then (on a
        // completed turn) schedule the passive, non-blocking model re-evaluation.
        this.autoName(session, req.input, result.status === "completed");
        // §5.1/§5.4 — record the per-turn snapshot (turns.json): the turn's
        // durable checkpoint id and chain length, the move's conversation half
        // (§10.12). Only a completed turn writes a checkpoint (§5.2), so a
        // suspension records none.
        if (result.status === "completed") {
          const ck = await engine.latestCheckpoint(session).catch(() => null);
          if (ck) {
            session.recordTurn({
              turn: session.turn,
              timestamp: session.metadata.lastActiveAt,
              agentId: this.activeAgentName ?? "orchestrator",
              messageCount: ck.messageCount,
              checkpointId: ck.checkpointId,
            });
          }
        }
        await this.mirror(session);
        return ok(result);
      } finally {
        session.turnActive = false;
        this.inFlightTurns.delete(sessionId);
        this.turnAborts.delete(sessionId);
        sendSettle();
        // §6.7/§10.6 — the turn is settled (idle): DRAFT any recorded repeated-
        // sequence candidates now, one at a time, best-effort, NEVER mid-turn.
        // Skipped in a headless run unless reflection is explicitly enabled there
        // (a headless `send` uses the `headless` approval mode and does not draft
        // skill suggestions). Fire-and-forget so it never delays the reply.
        if (session.approvalMode !== "headless") {
          void this.deps.obsWriter
            .drainSequenceCandidates(session.id)
            .catch((e) => this.deps.output?.(`obs sequence draft: ${e instanceof Error ? e.message : String(e)}`));
        }
      }
    },

    confirm: async (sessionId: string, response: ApprovalResponse): Promise<Result<TurnResult>> => {
      const session = this.live.get(sessionId) ?? (await this.rehydrate(sessionId));
      if (!session) return err(coreError(ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} not found`));
      if (session.pending.length === 0) {
        return err(coreError(ErrorCode.NO_PENDING_APPROVAL, "no pending approval to confirm"));
      }
      session.turnActive = true;
      this.activeSession = session;
      let confirmSettle!: () => void;
      this.inFlightTurns.set(sessionId, new Promise<void>((r) => (confirmSettle = r)));
      const turnAbort = new AbortController();
      this.turnAborts.set(sessionId, turnAbort);
      try {
        const engine = this.deps.makeEngine();
        const result = await engine.confirm(session, response, turnAbort.signal);
        session.metadata.lastActiveAt = new Date().toISOString();
        session.metadata.summary = result.status === "waiting_for_approval" ? "waiting for your approval" : "idle";
        await this.mirror(session);
        return ok(result);
      } finally {
        session.turnActive = false;
        this.inFlightTurns.delete(sessionId);
        this.turnAborts.delete(sessionId);
        confirmSettle();
      }
    },

    cancel: async (sessionId: string): Promise<Result<void>> => {
      const session = this.live.get(sessionId);
      if (session) {
        session.turnActive = false;
        // §3.3/§5.2 — abort the turn's ONE shared signal: this closes the
        // in-flight model HTTP request, stops the retry backoff, kills running
        // tool work (execute_command process group, web_fetch/MCP, `wait`), and
        // cancels dispatched workers and THEIR model calls and tools — all
        // through the single AbortSignal threaded into `agent.stream`. Idempotent:
        // a second cancel finds no live controller and only re-flips the flag.
        const turnAbort = this.turnAborts.get(sessionId);
        if (turnAbort && !turnAbort.signal.aborted) turnAbort.abort();
        this.deps.bus.emit("TURN_CANCELLED", { sessionId }, { session: sessionId });
      }
      return ok(undefined);
    },

    /**
     * Change the session's conversation mode (§2.7). HOST-ONLY: this lives on
     * the facade's `session` namespace and is absent from the scoped CoreAPI a
     * plugin receives, is never a model tool, and is unreachable through MCP, a
     * routine, or a skill — the mode is runtime state only the host selects.
     *
     * Accepted only while the session is IDLE (no running turn, no pending
     * approval); otherwise `MODE_CHANGE_REFUSED` and the mode is unchanged.
     * Entering `vibe` fails with `AUTO_APPROVE_FORBIDDEN` when the managed layer
     * sets `autoApproveAllowed: false` (§13.5) — the same prohibition that makes
     * `CoreOptions.autoApprove` refuse construction. A same-mode call is
     * idempotent (it still emits/audits `{ from, to }` with equal values). Every
     * accepted change emits `SESSION_MODE_CHANGED { from, to }` (§14.6) and
     * writes an audit record (§10, via the obs writer). The core never prompts:
     * any confirmation before entering `vibe` is a client concern.
     */
    setMode: async (
      sessionId: string,
      mode: SessionMode,
      opts?: { confirmed?: boolean },
    ): Promise<Result<{ from: SessionMode; to: SessionMode }>> => {
      if (typeof mode !== "string" || mode.trim() === "") {
        return err(coreError(ErrorCode.INVALID_INPUT, `setMode requires a top-level agent name`, { field: "mode" }));
      }
      const session = this.live.get(sessionId) ?? (await this.rehydrate(sessionId));
      if (!session) return err(coreError(ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} not found`));
      // §2.7 — idle only: no running turn and no pending approval.
      if (session.turnActive || session.pending.length > 0) {
        return err(
          coreError(
            ErrorCode.MODE_CHANGE_REFUSED,
            "cannot change the active agent while a turn is running or an approval is pending",
          ),
        );
      }
      // §2.7 — the name must be a currently loaded top-level agent.
      const topLevel = this.topLevelAgents();
      const def = topLevel.find((d) => d.name === mode);
      if (!def) {
        const names = topLevel.map((d) => d.name).join(", ");
        return err(
          coreError(ErrorCode.NOT_FOUND, `no top-level agent named "${mode}"; valid agents: ${names}`, {
            field: "mode",
            details: { validAgents: topLevel.map((d) => d.name) },
          }),
        );
      }
      // §2.7/§13.5 — entering an `unlisted: allow` agent requires the managed
      // layer to permit it (the same prohibition as `CoreOptions.autoApprove`).
      const isAllow = unlistedOf(def) === "allow";
      if (isAllow && this.deps.autoApproveAllowed && !this.deps.autoApproveAllowed()) {
        return err(
          coreError(
            ErrorCode.AUTO_APPROVE_FORBIDDEN,
            `entering "${def.name}" is forbidden by the managed layer (autoApproveAllowed: false)`,
          ),
        );
      }
      // §2.7 — entering an agent whose definition has `confirm: true` REQUIRES
      // `opts.confirmed === true`; otherwise a typed error names the missing
      // confirmation (the TUI/host asks the user and re-calls with confirmed).
      if (def.confirm === true && opts?.confirmed !== true) {
        // §2.7/§13.5 — the details name the agent's provenance so a client can
        // show who defined this autonomy gate (a cloned repo can ship its own
        // `.voidrift/agents/vibe` or override `chat`/`research`). `source` is
        // the cascade layer (an absent source → a session/programmatic
        // registration); `file` is the discovered `agent.json` path (absent for
        // the built-in `chat` and programmatic registrations).
        const source: "builtin" | "global" | "project" | "session" = def.source ?? "session";
        return err(
          coreError(
            ErrorCode.CONFIRMATION_REQUIRED,
            `entering "${def.name}" requires confirmation (call setMode with { confirmed: true })`,
            {
              field: "mode",
              details: {
                agent: def.name,
                source,
                ...(def.filePath !== undefined ? { file: def.filePath } : {}),
              },
            },
          ),
        );
      }
      const from = session.mode;
      session.mode = mode;
      // §10.11 — an agent switch is one of the ways a turn can "end": flush the
      // mutation journal's turn-net entries for the targets touched so far so the
      // net change is recorded at the boundary.
      await this.deps.makeEngine().flushJournalTurn(session).catch(() => undefined);
      // §3.1 — a switch of the active top-level agent resets the chat direct-
      // write lane counters (the lane is keyed on the agent's tools/workers, not
      // its name, so a switch starts a fresh lane budget).
      session.lane.reset();
      session.readLane.reset();
      // §6.7 — a mode switch must not later draft a candidate recorded under the
      // previous agent; drop the recorded-but-undrafted queue.
      this.deps.obsWriter.clearSequenceCandidates(sessionId);
      this.deps.bus.emit("SESSION_MODE_CHANGED", { from, to: mode }, { session: sessionId });
      return ok({ from, to: mode });
    },

    clear: async (sessionId: string): Promise<Result<SessionInfo>> => {
      // A fresh session; the prior session's files stay on disk (§5.4).
      const prior = this.live.get(sessionId);
      // §6.7 — drop the prior session's recorded-but-undrafted candidates so a
      // `/new` never drafts stale work.
      this.deps.obsWriter.clearSequenceCandidates(sessionId);
      const workspace = prior?.metadata.workspace ?? this.deps.workspaceRoot;
      const now = new Date().toISOString();
      const meta: SessionMetadata = {
        id: newId(),
        name: "untitled",
        summary: "idle",
        workspace,
        startedAt: now,
        lastActiveAt: now,
        turnCount: 0,
        sizeBytes: 0,
        namePinned: false,
      };
      const session = new Session(meta);
      this.live.set(session.id, session);
      await this.mirror(session);
      return ok(toInfo(meta));
    },

    command: async (name: string, args?: unknown): Promise<Result<unknown>> => {
      const entry = this.deps.commands.get(name);
      if (!entry) return err(coreError(ErrorCode.NOT_FOUND, `command "${name}" is not registered`, { field: "name" }));
      try {
        return ok(await entry.handler(args));
      } catch (e) {
        return err(coreError(ErrorCode.INVALID_INPUT, e instanceof Error ? e.message : String(e)));
      }
    },
    listCommands: async (): Promise<Result<string[]>> => ok([...this.deps.commands.keys()].sort()),

    housekeeping: async (): Promise<HousekeepingNotice> => this.computeHousekeeping(),

    shutdown: async (): Promise<void> => {
      // §14.3 shutdown, fixed order so nothing is left half-written:
      // 1) Cancel in-flight work cleanly — give any running turn the grace
      //    period (`turnShutdownGraceMs`) to finish so its TURN_COMPLETE/
      //    TURN_CANCELLED/ERROR spans are emitted into a STILL-OPEN writer; past
      //    the grace, cancel the session (abort through its shared signal, §5.2).
      const graceMs = this.deps.config.effectiveLimit("turn.shutdownGraceMs");
      const pending = [...this.inFlightTurns.entries()];
      if (pending.length > 0) {
        const graced = Promise.all(pending.map(([, p]) => p));
        const timedOut = Symbol("grace");
        const raced = await Promise.race([
          graced.then(() => undefined),
          new Promise<typeof timedOut>((r) => setTimeout(() => r(timedOut), graceMs)),
        ]);
        if (raced === timedOut) {
          for (const [id] of pending) await this.session.cancel(id).catch(() => undefined);
          await graced.catch(() => undefined);
        }
      }
      // §5.5 — a pending passive naming call must not outlive shutdown: await
      // any in-flight ones within a short cap, then abort so none lingers.
      const naming = [...this.namingInFlight.values()];
      if (naming.length > 0) {
        await Promise.race([
          Promise.all(naming).then(() => undefined),
          new Promise<void>((r) => setTimeout(r, 5000)),
        ]).catch(() => undefined);
      }
      this.namingAbort.abort();
      // 2) Flush pending async writes — mirror every live session's state
      //    synchronously (document registry, memory ids, metadata/stats, staging,
      //    §5.2) and (in the writer close below) drain exporter buffers.
      // §10.11 — a shutdown is one of the ways a turn can end: flush each live
      // session's turn-net journal entries first so nothing aggregated for the
      // turn is lost (the first-before blobs are already stored at first touch).
      for (const s of this.live.values()) {
        await this.deps.makeEngine().flushJournalTurn(s).catch(() => undefined);
      }
      for (const s of this.live.values()) await this.mirror(s);
      this.live.clear();
      // §5.2 — drain any accepted-but-unfinished partition writes (an off-turn
      // naming mirror still landing, a just-issued save) so no rename is in
      // flight when the process exits; a SIGTERM mid-write then leaves either the
      // old or the new file, never a torn `turns.json`.
      await this.deps.sessions.drain?.().catch(() => undefined);
      // 2b/4) Close connections — drain and close the observability writer (which
      //    reaches quiescence and flushes exporters, §10.3), then disconnect every
      //    live MCP server (idempotent, best-effort). The checkpoint (step 3) is
      //    already written at the turn boundary; shutdown writes no partial one.
      await this.deps.obsWriter.close().catch(() => undefined);
      for (const server of this.deps.mcpClient.list()) {
        if (server.status === "connected") await this.deps.mcpClient.disconnect(server.name).catch(() => undefined);
      }
    },

    // seams
    compact: async (sessionId?: string): Promise<Result<{ turnsFolded: number }>> => {
      if (!sessionId) return err(coreError(ErrorCode.SESSION_NOT_FOUND, "session id is required"));
      const session = this.live.get(sessionId) ?? (await this.rehydrate(sessionId));
      if (!session) return err(coreError(ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} not found`));
      const engine = this.deps.makeEngine();
      const turnsFolded = await engine.compact(session);
      await this.mirror(session);
      return ok({ turnsFolded });
    },
    loadMessages: async (id?: string): Promise<Result<MessageDTO[]>> => {
      // §5.4 — never throws across the boundary: an unreadable/empty chain or a
      // missing session returns an empty list rather than an error.
      if (id !== undefined && typeof id !== "string") return ok([]);
      try {
        const session = id
          ? this.live.get(id) ?? (await this.rehydrate(id))
          : this.activeSession ?? [...this.live.values()][0];
        if (!session) return ok([]);
        const chain = await this.deps.makeEngine().loadChain(session);
        return ok(chain.map((m) => this.toMessageDTO(m)));
      } catch {
        return ok([]);
      }
    },

    /**
     * Render a stored session as a sanitized `SessionExport` document (§10.13).
     * HOST/USER operation — NOT a model tool, NOT on any allow list, and absent
     * from the plugin ScopedCoreApi (the same posture as rollback and the
     * journal read API). READ-ONLY: it records no mutation-journal entry and is
     * not a rollback move.
     *
     * `id` is a stored session id or `"last"` (the most recent session for this
     * workspace). `format` renders JSON (default) or Markdown from the ONE
     * sanitized value. With `out` the document is written to an owner-only file
     * (0600, created parents 0700, temp+rename); the file must not exist
     * (`EXPORT_TARGET_EXISTS`), a protected control path is refused
     * (`EXPORT_TARGET_PROTECTED`), and a symlinked target is refused
     * (`EXPORT_WRITE_FAILED`). Without `out` the rendered content is returned.
     */
    export: async (
      id: string,
      opts?: { format?: "md" | "json"; out?: string; includeToolResults?: boolean },
    ): Promise<Result<{ format: "md" | "json"; path?: string; content?: string; masking: MaskSummary }>> =>
      this.exportSession(id, opts),
  };
  readonly models = {
    list: async () => ok(this.deps.model.list()),
    switch: async (name: string): Promise<Result<unknown>> => {
      try {
        return ok(this.deps.model.switch(name));
      } catch (e) {
        return err(e instanceof CoreErrorException ? e.error : coreError(ErrorCode.MODEL_NOT_CONFIGURED, String(e)));
      }
    },
    stats: async (
      sessionId?: string,
    ): Promise<Result<import("./entities/observability/stats-report.js").StatsReport>> => {
      if (sessionId !== undefined && typeof sessionId !== "string") {
        return err(coreError(ErrorCode.INVALID_INPUT, "models.stats id must be a string", { field: "sessionId" }));
      }
      // Default to the active session, else the single live session (§10.3).
      const session = sessionId
        ? this.live.get(sessionId) ?? (await this.rehydrate(sessionId))
        : this.activeSession ?? [...this.live.values()][0];
      // The live single-session report (§10.14, §11.9), scope "session", built
      // from the session's OWN per-turn model.usage records so a mid-session
      // model switch is attributed to the model that actually ran each turn —
      // not the currently resolved endpoint. No model call, no network.
      const empty: import("./entities/observability/stats-report.js").StatsReport = {
        scope: "session",
        totals: {
          turns: 0, toolCalls: 0, toolErrors: 0,
          tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensTotal: 0,
          wallMs: 0, genMs: 0, estimatedTurns: 0,
        },
        byModel: {}, byAgent: {}, byDay: {},
      };
      if (!session) return ok(empty);
      return ok(await this.deps.obsWriter.statsReportFor(session.id));
    },
    context: async (sessionId?: string): Promise<Result<unknown>> => {
      if (!sessionId) return err(coreError(ErrorCode.SESSION_NOT_FOUND, "session id is required"));
      const session = this.live.get(sessionId) ?? (await this.rehydrate(sessionId));
      if (!session) return err(coreError(ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} not found`));
      try {
        this.deps.model.resolve();
      } catch (e) {
        return err(e instanceof CoreErrorException ? e.error : coreError(ErrorCode.MODEL_NOT_CONFIGURED, String(e)));
      }
      const engine = this.deps.makeEngine();
      return ok(await engine.contextBreakdown(session));
    },
  };

  // ── config ─────────────────────────────────────────────────────────────────
  readonly config = {
    get: async (key?: keyof Config): Promise<Result<unknown>> =>
      ok(key ? this.deps.config.getKey(key) : this.deps.config.get()),
    set: async (key: string, value: unknown, layer: ConfigLayer): Promise<Result<Config>> =>
      this.deps.config.set(key, value, layer),
    validate: async (document: Record<string, unknown>) => ok(this.deps.config.validate(document)),
    recover: async (layer: ConfigLayer): Promise<Result<Config>> => this.deps.config.recover(layer),
    paths: async () => ok(this.deps.config.paths()),
    /**
     * The effective limits (§13.11) for `/config`: every registry key with its
     * resolved value, unit, class, and source layer+file, plus any ignored
     * safety-raise warnings. Numeric only; prints no secret. Host-readable.
     */
    limits: async () => ok(this.deps.config.limitsView()),
    /**
     * The config layers rejected at boot and set aside as `.rejected` (§13.2–
     * §13.3). The core recovers to defaults and keeps running; a client reads
     * this at startup to tell the user why their config did not apply — the
     * `CONFIG_INVALID` event fires during boot, before a client subscribes, so
     * this durable accessor is the reliable path. Error entries carry key names
     * only, never values.
     */
    rejections: async () => ok(this.deps.config.rejectedLayers()),
    /**
     * Non-fatal config warnings from the last resolve (an ignored project/
     * session `unlock`, §13.5/§13.10). Like `rejections`, this is read at startup
     * — the `CONFIG_WARNING` event fires during boot before a client subscribes.
     * Deduped and recomputed each resolve; messages name the file path and key
     * only, never a value. Empty when nothing was ignored.
     */
    warnings: async () => ok(this.deps.config.configWarnings()),
    /**
     * The code-level NEVER LIST with each category's lifted state under the
     * resolved (honored) `unlock` (§9.3/§13.10). Host-readable for the later
     * `/access` and `doctor`; the never list lives in CODE, this is a read-only
     * view. HOST-ONLY (not a model tool, absent from the plugin ScopedCoreApi).
     */
    neverList: async () => ok(this.deps.config.neverList()),
    /**
     * Seed and repair the installation (§13.9.1) — HOST-ONLY. Like `config.set`,
     * this is on the `config` namespace a product calls directly; it is NOT a
     * model tool and is absent from the plugin `ScopedCoreApi`, so a model turn
     * or a plugin can never seed, reset, or re-validate the installation. The
     * CLI binds `voidrift init` to it exactly as it binds `voidrift chat` to the
     * session operations.
     */
    init: async (
      opts?: import("./use-cases/config-init.js").ConfigInitOptions,
    ): Promise<Result<import("./use-cases/config-init.js").ConfigInitResult>> =>
      this.deps.configInit.run({
        ...opts,
        ...(opts?.scope === "project" && !opts.pluginAgents ? { pluginAgents: this.deps.agentTemplatesRegistry.getAll() } : {}),
      }),
    /**
     * Validate every resource and configuration (§13.9.2) — HOST-ONLY. Like
     * `config.init`, this is on the `config` namespace a product calls directly;
     * it is NOT a model tool and is absent from the plugin `ScopedCoreApi`, so a
     * model turn or a plugin can never run it. READ-ONLY: it writes nothing. The
     * CLI binds `voidrift doctor` to the host-level `doctorConfigHome` so it
     * works without a booted core; this facade method reports against the
     * already-booted cascade when a product wants it in-process.
     */
    doctor: async (
      opts?: import("./use-cases/config-doctor.js").DoctorOptions,
    ): Promise<Result<import("./use-cases/config-doctor.js").DoctorReport>> => {
      if (!this.deps.configDoctor) {
        return err(coreError(ErrorCode.INTERNAL, "config.doctor is not wired in this core build"));
      }
      return ok(await this.deps.configDoctor(opts ?? {}));
    },
    /**
     * Build the effective-permissions report (§7.4) — HOST-ONLY. Like
     * `config.doctor`, this is on the `config` namespace a product calls
     * directly; it is NOT a model tool and is absent from the plugin
     * `ScopedCoreApi`, so a model turn or a plugin can never read it. READ-ONLY
     * and secret-free: it writes nothing, opens no network, starts no session.
     * The CLI binds `voidrift access` to the host-level `accessReportConfigHome`
     * so it works without a booted core; this facade method reports against the
     * already-booted cascade for the active (or named) agent when a product
     * wants it in-process (e.g. the TUI's `/access`).
     */
    access: async (
      opts?: { agent?: string },
    ): Promise<Result<import("./use-cases/access-report.js").AccessReport>> => {
      if (!this.deps.configAccess) {
        return err(coreError(ErrorCode.INTERNAL, "config.access is not wired in this core build"));
      }
      return ok(await this.deps.configAccess(opts ?? {}));
    },
  };

  // ── workspace ──────────────────────────────────────────────────────────────
  /** The active session's id (the active one, else the single live session),
   * or undefined when none is live (§12.7). The zero-argument `context` dataset
   * reads it so `models.context(id)` can resolve the current session without a
   * client passing an id. A synchronous snapshot. */
  activeSessionId(): string | undefined {
    return (this.activeSession ?? [...this.live.values()][0])?.id;
  }

  /** The latest user-message text of the active session (the current turn's
   * input), for the read-only plugin workspace surface (retrieval-blueprint §5).
   * A synchronous snapshot; "" when there is no live session. */
  activeTurnInput(): string {
    const session = this.activeSession ?? [...this.live.values()][0];
    return session?.lastUserInput ?? "";
  }

  /** The active session's focus: files read (and so edited-then-read) this
   * session, workspace-relative (retrieval-blueprint §5). Drawn from the document
   * registry's read set — the same signal the unread/stale guardrail uses. */
  activeFocusPaths(): string[] {
    const session = this.activeSession ?? [...this.live.values()][0];
    if (!session) return [];
    return [...session.readPaths];
  }

  readonly workspace = {
    root: async (): Promise<Result<string>> => ok(this.deps.workspaceRoot),
    /**
     * The structural index the `workspace_map` tool returns, as a DTO (§8.2): a
     * directory tree with per-file line counts and extracted symbols. `depth`
     * defaults to `workspaceMapDepth`; `path` is contained to the workspace root
     * by the SAME FileSystemPort the file tools use (`PATH_ESCAPE` on an escape,
     * §8.2) — no second containment check. The symbol index is cached by path +
     * content hash under `.voidrift/cache/index/` through the one hash utility.
     */
    map: async (path?: string, depth?: number): Promise<Result<import("./entities/workspace-map.js").WorkspaceMapDTO>> => {
      if (path !== undefined && typeof path !== "string") {
        return err(coreError(ErrorCode.INVALID_INPUT, "workspace.map path must be a string", { field: "path" }));
      }
      if (depth !== undefined && (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1)) {
        return err(coreError(ErrorCode.INVALID_INPUT, "workspace.map depth must be a positive integer", { field: "depth" }));
      }
      try {
        return ok(await this.deps.workspaceMap.build(path, depth));
      } catch (e) {
        if (e instanceof CoreErrorException) return err(e.error);
        return err(coreError(ErrorCode.INTERNAL, e instanceof Error ? e.message : String(e)));
      }
    },
    /** The checked-out branch, or null outside a git repo (§7.3, §14). */
    branch: async (): Promise<Result<string | null>> => {
      try {
        return ok(await this.deps.vcs.currentBranch());
      } catch (e) {
        return err(coreError(ErrorCode.INTERNAL, e instanceof Error ? e.message : String(e)));
      }
    },
    /** Workspace-relative paths honoring ignore rules via the workspace port
     * (§7.3). Reads are free (§9); an optional glob narrows the listing. */
    files: async (pattern?: string): Promise<Result<string[]>> => {
      if (pattern !== undefined && typeof pattern !== "string") {
        return err(coreError(ErrorCode.INVALID_INPUT, "workspace.files pattern must be a string", { field: "pattern" }));
      }
      if (pattern !== undefined && pattern.trim() !== "") {
        // S5 (GHSA-vfj7-8cjw-p6xm): reject a pathological glob before the glob
        // library ever sees it.
        const bad = validateGlobPattern(pattern);
        if (bad !== null) {
          return err(coreError(ErrorCode.INVALID_INPUT, `glob pattern rejected: ${bad}`, { field: "pattern" }));
        }
      }
      try {
        const files = await this.deps.fileSystem.glob(pattern && pattern.trim() !== "" ? pattern : "**/*");
        return ok(files.sort());
      } catch (e) {
        if (e instanceof CoreErrorException) return err(e.error);
        return err(coreError(ErrorCode.INTERNAL, e instanceof Error ? e.message : String(e)));
      }
    },
    /** A unified-diff of the working tree against HEAD, through the ONE shared
     * diff utility the VCS adapter owns (§8.2, §7.3). Empty string outside a repo
     * or when the tree is clean. A read — never gated (§9). */
    diff: async (path?: string): Promise<Result<string>> => {
      if (path !== undefined && typeof path !== "string") {
        return err(coreError(ErrorCode.INVALID_INPUT, "workspace.diff path must be a string", { field: "path" }));
      }
      try {
        return ok(await this.deps.vcs.workingDiff(path));
      } catch (e) {
        return err(coreError(ErrorCode.INTERNAL, e instanceof Error ? e.message : String(e)));
      }
    },
    /** One-shot context for the next turn (§4.2): drained at the start of the
     * next turn, treated as DATA never authority (§1 rule 15), and masked by the
     * secret detector before it is persisted or exported (§10.10). */
    inject: async (label: string, content: string): Promise<Result<void>> => {
      if (typeof label !== "string" || label.trim() === "") {
        return err(coreError(ErrorCode.INVALID_INPUT, "workspace.inject requires a label", { field: "label" }));
      }
      if (typeof content !== "string") {
        return err(coreError(ErrorCode.INVALID_INPUT, "workspace.inject requires string content", { field: "content" }));
      }
      const session = this.activeSession ?? [...this.live.values()][0];
      if (!session) return err(coreError(ErrorCode.SESSION_NOT_FOUND, "no live session to inject into"));
      const masked = maskValue({ label, content }) as { label: string; content: string };
      const block = `[inject:${masked.label}]\n${masked.content}`;
      const buf = this.injected.get(session.id) ?? [];
      buf.push(block);
      this.injected.set(session.id, buf);
      return ok(undefined);
    },
  };

  // ── permissions ──────────────────────────────────────────────────────────────
  readonly permissions = {
    rules: async (): Promise<Result<unknown[]>> => ok(Object.values(this.deps.config.get().permissions)),
    approvals: async (sessionId?: string): Promise<Result<PendingApproval[]>> => {
      if (sessionId) {
        const s = this.live.get(sessionId);
        return ok(s ? s.pending : []);
      }
      return ok([...this.live.values()].flatMap((s) => s.pending));
    },
    resolve: async (sessionId: string, response: ApprovalResponse): Promise<Result<TurnResult>> =>
      this.session.confirm(sessionId, response),
    /**
     * Remove a persisted Guardian rule (§9.2 revoke). The `id` is the rule's key
     * in `permissions.rules()`; `layer` names where the rule lives — a session
     * rule in the active session's config layer (§5.6), a workspace rule in the
     * project config, a user rule in the global config. A MANAGED rule can never
     * be revoked by a lower layer (§13.5, the loosen-proof guarantee) and returns
     * an `INVALID_INPUT` error. The on-disk change is a config write that emits
     * `CONFIG_CHANGED` (§13.4); there is no dedicated rule-removal event (§14.6).
     */
    revoke: async (id?: string, layer?: "session" | "workspace" | "user"): Promise<Result<void>> => {
      if (typeof id !== "string" || id.trim() === "") {
        return err(coreError(ErrorCode.INVALID_INPUT, "permissions.revoke requires a rule id", { field: "id" }));
      }
      const scope = layer ?? "workspace";
      if (scope === "session") {
        const session = this.activeSession ?? [...this.live.values()][0];
        if (!session) return err(coreError(ErrorCode.SESSION_NOT_FOUND, "no live session to revoke a session rule from"));
        const idx = session.sessionRules.findIndex((r) => `${r.tool} ${r.pattern ?? "*"}` === id);
        if (idx < 0) return err(coreError(ErrorCode.NOT_FOUND, `no session permission rule "${id}"`, { field: "id" }));
        session.sessionRules.splice(idx, 1);
        return ok(undefined);
      }
      // workspace rules live in the project config layer; user rules in global.
      const configLayer: ConfigLayer = scope === "workspace" ? "project" : "global";
      const res = await this.deps.config.removePermissionRule(id, configLayer);
      return res.ok ? ok(undefined) : err(res.error);
    },
  };

  // ── compliance (§2.2, §9.6) ──────────────────────────────────────────────────
  readonly compliance = {
    status: async () => ok(this.deps.warden.status()),
    policies: async () => ok(this.deps.warden.policies()),
    decisions: async () => ok(this.deps.warden.decisions()),
  };

  // ── events ─────────────────────────────────────────────────────────────────
  readonly events = {
    register: (name: string): void => this.deps.bus.register(name),
    subscribe: (
      type: string | "*",
      handler: (event: EventEnvelope) => void,
      opts?: { scope?: EventScope },
    ): (() => void) => this.deps.bus.subscribe(type, handler, { ...(opts?.scope ? { scope: opts.scope } : {}), isPlugin: true }),
    emit: (key: string, payload: unknown, scope?: EventScope): void => {
      if (!this.deps.bus.isRegistered(key)) {
        // Unknown event names are rejected rather than silently created (§14.5).
        return;
      }
      this.deps.bus.emit(key, payload, scope);
    },
  };

  // ── register ─────────────────────────────────────────────────────────────────
  readonly register = {
    tool: (def: ToolDefinition, exec: ToolExecutor): void =>
      // §8.4 — a plugin tool is trusted code (§12.4): origin `plugin` keeps the
      // the same gate as every tool — it asks until an allow rule matches its name).
      this.deps.registry.register({ ...def, origin: def.origin ?? "plugin" }, exec),
    guardrail: (_g: Guardrail): void => {
      // Guardrails register with the Guardian; slice-1 Guardian takes its built-ins
      // at construction. A registration seam is present for plugins (§2.2).
    },
    command: (name: string, _description: string, handler: PluginCommandHandler): void => {
      this.deps.commands.set(name, { pluginId: CORE_NAMESPACE, handler });
    },
    agent: (manifest: AgentDefinition): CoreError | void => {
      // §7.1 — registration asserts a worker's resolved toolset contains no task
      // tool and rejects the definition otherwise. A rejection returns a
      // CoreError across the facade rather than throwing (§2.6).
      try {
        this.subagentsCore().register(manifest);
      } catch (e) {
        // Preserve a typed CoreError (e.g. MODEL_NOT_CONFIGURED, §11) thrown by
        // registration; fall back to INVALID_INPUT for a plain assertion error.
        if (e instanceof CoreErrorException) return e.error;
        return coreError(ErrorCode.INVALID_INPUT, e instanceof Error ? e.message : String(e), { field: "tools" });
      }
    },
    skill: (raw: string, name: string): CoreError | void => {
      const res = this.deps.skills.registerBuiltin(raw, name);
      if (!res.ok) return res.error;
    },
    prompt: (key: string, content: string): void => this.deps.prompts.register(key, content),
    overridePrompt: (key: string, content: string): void => this.deps.prompts.overridePrompt(key, content),
    extendPrompt: (key: string, content: string): void => this.deps.prompts.extendPrompt(key, content),
    contextProvider: (layer: ContextLayer, provider: ContextProvider): void => {
      this.deps.contextProviders.register(layer, provider);
    },
    panel: (name: string, definition: unknown): CoreError | void => {
      // The core is the panel configuration facilitator (§12.6): it validates a
      // declaration against the ONE Zod schema before storing it under the
      // reserved core `panels.{name}` key (§12.5, panels §3), returning a typed
      // CoreError naming the offending field on failure. The core validates the
      // SHAPE only — it never resolves or calls the ops a declaration names.
      const result = validatePanelDeclaration(definition);
      if (!result.ok) {
        return coreError(ErrorCode.INVALID_INPUT, `panel "${name}": ${result.error.message}`, { field: result.error.field });
      }
      this.deps.registryStore.set(CORE_NAMESPACE, `${PANELS_KEY_PREFIX}${name}`, result.value);
    },
    dataset: (name: string, declaration: unknown): CoreError | void => {
      // The core is the data facilitator for datasets (§12.7): it validates a
      // declaration against the ONE Zod schema (DATA members) plus the
      // zero-argument `rows` rule, then stores it under the reserved core
      // `datasets.{name}` key (§12.5), returning a typed CoreError naming the
      // offending field on failure. The reserved core namespace is NEVER
      // persisted, so the `rows` reader function stays in memory. A dataset name
      // is a lowercase slug `[a-z0-9-]+` (no dots). The core never calls `rows`
      // here; `datasets.rows` reads it (masked) when a client asks.
      if (typeof name !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
        return coreError(ErrorCode.INVALID_INPUT, `dataset name "${String(name)}" must be a lowercase slug ([a-z0-9-]+, no dots)`, { field: "name" });
      }
      const result = validateDatasetDeclaration(declaration);
      if (!result.ok) {
        return coreError(ErrorCode.INVALID_INPUT, `dataset "${name}": ${result.error.message}`, { field: result.error.field });
      }
      this.deps.registryStore.set(CORE_NAMESPACE, `${DATASETS_KEY_PREFIX}${name}`, result.value);
    },
    modelProvider: (protocol: string, factory: unknown): void => {
      // A protocol → factory peer of the bundled providers (§11.7); a bundled
      // name is reserved and silently ignored by the adapter.
      this.deps.model.registerProvider(protocol, factory as import("./adapters/model-provider.js").ProviderFactory);
    },
    memoryProvider: (provider: MemoryProvider): void => this.deps.memory.setProvider(provider),
    planScope: (id: string, scope: { writeGlobs: string[]; executePatterns: string[] }): void => {
      // §9.5 — a capability registers a plan-scope against an identifier, mapped
      // onto the Guardian seam under the reserved core namespace. The scope
      // auto-approves a matching non-read call before the rules, but never a
      // force-ask or hard-deny (that invariant lives in Guardian.evaluate). It is
      // never persisted across sessions and is cleared explicitly by the
      // registrant via clearPlanScope.
      this.deps.guardian.registerScope(`${CORE_NAMESPACE}:${id}`, scope);
      // §10.11 — note the UNQUALIFIED id as live so a journaled write stamps it
      // as `planStep` (recorded metadata only, invariant 27).
      this.noteActiveScope(id);
    },
    clearPlanScope: (id: string): void => {
      this.deps.guardian.clearScope(`${CORE_NAMESPACE}:${id}`);
      this.clearActiveScope(id);
      // §9.5.1 — clearing the plan-scope grant IS the scope close. Drive the
      // expectation comparison for the SAME scope id the registrant used (the
      // unqualified identifier, which is the journal's plan step): read the
      // scope's actual journal targets, compare, and emit the surprise report.
      // Fire-and-forget (the comparison influences no decision, invariant 27) and
      // isolated so a journal hiccup never breaks clearing the grant.
      void this.expectationsCore()
        .closeScope(id)
        .catch(() => undefined);
    },
    exporter: (exporter: unknown): void => {
      // An exporter receives each masked ObsRecord as it is written (§10.8); a
      // thrower is isolated and the local trail is written regardless.
      this.deps.registerExporter(exporter as import("./entities/observability/obs-record.js").ObsExporter);
    },
    docs: async (dir: string, source: string): Promise<CoreError | void> => {
      // §12.8 — register all *.md files from a directory as builtin docs.
      // This is the programmatic seam for external callers to register documentation.
      // For plugins, use the scoped CoreAPI which forces source to the plugin id.
      return this.deps.manuals.registerDir(dir, source);
    },
  };

  /** Resolve registered context-provider blocks for a layer (§4). */
  contextProviderBlocks(layer: ContextLayer): string[] {
    return this.deps.contextProviders.blocks(layer);
  }

  /**
   * §8.7 — the live set of plugin-contributed INGEST chunkers, in registration
   * order. INTERNAL: the Ingest use-case reads this to pick a structure-aware
   * chunker (a plugin chunker that `matches` wins over the core builtins, which
   * the use-case appends). It is NOT a model tool and NOT on the plugin
   * ScopedCoreApi — a plugin contributes a chunker through `register.chunker`
   * and never reads the set. Empty when no plugin registered one.
   */
  chunkers(): import("./entities/chunker.js").Chunker[] {
    return this.deps.chunkers?.() ?? [];
  }

  // ── registry (§12.5) ─────────────────────────────────────────────────────────
  // The core's structural entries live under the reserved `core` namespace a
  // plugin cannot write; plugin entries are namespaced to the plugin id by the
  // scoped CoreAPI (§12.5).
  readonly registry = {
    set: (key: string, value: unknown): void => this.deps.registryStore.set(CORE_NAMESPACE, key, value),
    get: (key: string): unknown => this.deps.registryStore.get(CORE_NAMESPACE, key),
    query: (prefix: string): RegistryEntry[] => this.deps.registryStore.query(CORE_NAMESPACE, prefix),
    remove: (key: string): void => this.deps.registryStore.remove(CORE_NAMESPACE, key),
    /** Panel declarations a client renders — every `panels.*` entry (§12.5,
     * panels-blueprint §3). The CLI reads this to discover registered panels. */
    panels: (): RegistryEntry[] => this.deps.registryStore.query(CORE_NAMESPACE, PANELS_KEY_PREFIX),
  };

  // ── datasets (§12.7) ───────────────────────────────────────────────────────
  /**
   * The read-only dataset seam behind every panel (§12.7). CoreAPI exposes
   * exactly two operations so a client that cannot import `@voidrift/core` still
   * reads them: `list()` returns the registered names with their `description`
   * and `fields`; `rows(name)` returns that dataset's current rows, secret-masked
   * (§10.10). `rows` is the ONLY path by which panel rows leave the core; it is
   * read-only (no mutating op can be a dataset). A dataset is registered through
   * `register.dataset` and stored under the reserved core `datasets.{name}` key.
   */
  readonly datasets = {
    /** The registered datasets — name, description, and declared fields (§12.7).
     * No rows are read; this is the panel-discovery listing. */
    list: async (): Promise<Result<DatasetInfo[]>> => {
      const entries = this.deps.registryStore.query(CORE_NAMESPACE, DATASETS_KEY_PREFIX);
      const out: DatasetInfo[] = entries.map((e) => {
        const decl = e.value as DatasetDeclaration;
        return {
          name: e.key.slice(DATASETS_KEY_PREFIX.length),
          description: decl.description,
          ...(decl.fields ? { fields: decl.fields } : {}),
        };
      });
      return ok(out);
    },
    /**
     * The dataset's current rows, secret-masked (§12.7, §10.10). An unknown name
     * is a typed NOT_FOUND error naming it. The reader is read-only; a throwing
     * reader is a typed INTERNAL error. The row ARRAY LENGTH and each ROW's
     * serialized SIZE are capped using the EXISTING output-bound limits — the row
     * array is capped at `tools.workspaceMaxFiles` (the max-enumerated-items
     * bound) and each row's serialized JSON at `tools.commandOutputMaxBytes` (the
     * tool-output byte cap); overflow is DROPPED and a dim notice names the key.
     * No new `limits.*` key is introduced (§12.7).
     */
    rows: async (name: string): Promise<Result<Row[]>> => {
      if (typeof name !== "string" || name.trim() === "") {
        return err(coreError(ErrorCode.INVALID_INPUT, "datasets.rows requires a dataset name", { field: "name" }));
      }
      const stored = this.deps.registryStore.get(CORE_NAMESPACE, `${DATASETS_KEY_PREFIX}${name}`);
      if (stored === null || stored === undefined) {
        return err(coreError(ErrorCode.NOT_FOUND, `dataset "${name}" is not registered`, { field: "name" }));
      }
      const decl = stored as DatasetDeclaration;
      let rows: Row[];
      try {
        rows = await decl.rows();
      } catch (e) {
        return err(coreError(ErrorCode.INTERNAL, `dataset "${name}" reader failed: ${e instanceof Error ? e.message : String(e)}`, { field: "name" }));
      }
      if (!Array.isArray(rows)) {
        return err(coreError(ErrorCode.INTERNAL, `dataset "${name}" reader did not return an array`, { field: "name" }));
      }
      // §12.7 — cap the array length (reusing `tools.workspaceMaxFiles`, the
      // max-enumerated-items output bound) and each row's serialized size
      // (reusing `tools.commandOutputMaxBytes`, the tool-output byte cap). No new
      // limits.* key. Overflow is dropped with a dim notice naming the key.
      const maxRows = this.limit("tools.workspaceMaxFiles");
      const maxRowBytes = this.limit("tools.commandOutputMaxBytes");
      let droppedForCount = 0;
      if (rows.length > maxRows) {
        droppedForCount = rows.length - maxRows;
        rows = rows.slice(0, maxRows);
      }
      let droppedForSize = 0;
      const kept: Row[] = [];
      for (const row of rows) {
        // Mask BEFORE anything leaves the core (§10.10, §12.7): every row through
        // the shared secret detector. Measure the masked serialized size.
        const masked = maskValue(row) as Row;
        const size = Buffer.byteLength(JSON.stringify(masked) ?? "", "utf8");
        if (size > maxRowBytes) {
          droppedForSize += 1;
          continue;
        }
        kept.push(masked);
      }
      if (droppedForCount > 0) {
        this.deps.output?.(`ℹ dataset "${name}": ${droppedForCount} row(s) dropped over the cap (raise limits.tools.workspaceMaxFiles)`);
      }
      if (droppedForSize > 0) {
        this.deps.output?.(`ℹ dataset "${name}": ${droppedForSize} oversized row(s) dropped (raise limits.tools.commandOutputMaxBytes)`);
      }
      return ok(kept);
    },
  };

  /** Read an effective limit value (§13.11), falling back to the config
   * capability when the host did not inject `getLimit` (tests). */
  private limit(key: string): number {
    return this.deps.getLimit?.(key) ?? this.deps.config.effectiveLimit(key);
  }

  // ── subagents (§7) ─────────────────────────────────────────────────────────
  /** The shared Subagents use-case; registration and live workers persist here. */
  private subagentsInstance?: Subagents;
  private subagentsCore(): Subagents {
    if (!this.subagentsInstance) {
      this.subagentsInstance = this.deps.makeSubagents(
        () => this.activeSession?.sessionRules ?? [],
        () => this.activeSession?.id ?? "orchestrator",
        () => this.activeSession?.approvalMode ?? "interactive",
        () => this.resolveActiveAgent(this.activeSession?.mode ?? "chat"),
      );
    }
    return this.subagentsInstance;
  }

  // ── expectations (§2.2, §9.5.1) ──────────────────────────────────────────
  /**
   * The UNQUALIFIED ids of the plan-scope grants that are currently live, in
   * registration order (§9.5.1, §10.11). A journaled write stamps the most
   * recently opened live scope id as its `planStep`, so the scope-targets reader
   * can bind a scope's prediction to the writes it drove. This is RECORDED
   * METADATA ONLY — it never influences a permission/scope/loop decision
   * (invariant 27); the auto-approval grant itself lives in the Guardian. Both
   * the direct CoreAPI `register.planScope`/`clearPlanScope` and the plugin
   * seam (boot's CoreServices, via `noteActiveScope`/`clearActiveScope`) keep
   * this list current. */
  private readonly activeScopeIds: string[] = [];

  /** Record a plan-scope id as live for journal stamping (§10.11). */
  noteActiveScope(id: string): void {
    if (typeof id !== "string" || id === "") return;
    // Re-register moves it to the end (most recent wins on stamp).
    const i = this.activeScopeIds.indexOf(id);
    if (i !== -1) this.activeScopeIds.splice(i, 1);
    this.activeScopeIds.push(id);
  }

  /** Drop a plan-scope id when its grant is cleared (§10.11). */
  clearActiveScope(id: string): void {
    const i = this.activeScopeIds.indexOf(id);
    if (i !== -1) this.activeScopeIds.splice(i, 1);
  }

  /** The active plan-scope id a journaled write should stamp as `planStep`
   * (§10.11) — the most recently opened live scope, or undefined when none is
   * live. Recorded metadata only; it influences no decision (invariant 27). */
  getActiveJournalScopeId(): string | undefined {
    return this.activeScopeIds.length > 0 ? this.activeScopeIds[this.activeScopeIds.length - 1] : undefined;
  }

  /** The prediction-vs-journal seam (§9.5.1). Kept APART from the permission
   * seam so it can never influence a decision (invariant 27): it only reads the
   * journal at scope close, compares, and emits a `WARNING_EMITTED` surprise. */
  private expectationsInstance?: Expectations;
  private expectationsCore(): Expectations {
    if (!this.expectationsInstance) {
      this.expectationsInstance = new Expectations({
        bus: this.deps.bus,
        // Core-internal journal read (§10.11): scope id → the write targets the
        // scope drove (filtered by the entry's plan step). The plugin never
        // reaches this — it registers the prediction and renders the result.
        readScopeTargets: makeScopeTargetsReader(this.deps.journalStore, () => this.activeSession?.id ?? ""),
        sessionId: () => this.activeSession?.id ?? "",
      });
    }
    return this.expectationsInstance;
  }

  /**
   * The `expectations` CoreAPI namespace (§2.2, §9.5.1). A caller — any CoreAPI
   * consumer; the Plan plugin is the first — registers a prediction for a scope
   * and clears it; the comparison and the surprise report fire at scope CLOSE,
   * which the core drives when the scope's plan-scope grant is cleared
   * (`register.planScope` → `clearPlanScope`). This surface NEVER exposes the
   * journal: the read is core-internal (§9.5.1).
   */
  readonly expectations = {
    register: (req: { scope: string; predicted: string[] }): void => this.expectationsCore().register(req),
    clear: (scope: string): void => this.expectationsCore().clear(scope),
  };

  /** CLOSE an expectation scope: read its journal targets, compare, emit the
   * surprise report (§9.5.1). Core-internal; boot wires the plugin CoreServices
   * `closeExpectation` to this when a plan-scope grant is cleared. Fire-and-
   * forget and isolated — the comparison influences no decision (invariant 27). */
  closeExpectationScope(scope: string): void {
    void this.expectationsCore()
      .closeScope(scope)
      .catch(() => undefined);
  }

  /** The effective process-start active top-level agent (§2.1, §2.7): the host's
   * `CoreOptions.startAgent` (the CLI's headless selection). Resolved lazily at
   * session time so the agent registry (populated by boot's reindex) is
   * available. Returns undefined → a new/resumed session starts in `chat`. */
  private effectiveStartAgent(): string | undefined {
    return this.launchAgentOverride ?? this.deps.startAgent;
  }

  /** The effective approval mode a NEW session is created with (§2.5, §8): the
   * host's post-boot launch override, else `CoreOptions.startSessionApprovalMode`,
   * else undefined (the session stays `interactive`). */
  effectiveStartApprovalMode(): import("./entities/session.js").ApprovalMode | undefined {
    return this.launchApprovalOverride ?? this.deps.startSessionApprovalMode;
  }

  /** The LIVE approval posture at call time (§3.3/§8.7): the active session's
   * own `approvalMode` when a session is running, else the effective launch
   * default, else `interactive`. The ingest seam reads this so a HEADLESS run
   * (the host fixes `headless` post-boot via `setLaunchDefaults`, after the
   * static `startSessionApprovalMode` was already captured) correctly suppresses
   * the background project-instructions fan-out — every embedding (CLI headless,
   * SDK, web-server) reads the real posture, not the boot-time snapshot. */
  liveApprovalMode(): import("./entities/session.js").ApprovalMode {
    return this.activeSession?.approvalMode ?? this.effectiveStartApprovalMode() ?? "interactive";
  }

  /** Host-only (§2.1, §8): set the launch defaults every NEW session inherits —
   * the start agent and the approval posture. The headless CLI calls this after
   * boot, once it has selected the start agent, so a routine's separate
   * `runInNewSession` runs under the same agent and never-ask posture. Not a
   * model tool and absent from the plugin ScopedCoreApi. */
  setLaunchDefaults(defaults: { agent?: string; approvalMode?: import("./entities/session.js").ApprovalMode }): void {
    if (defaults.agent !== undefined) this.launchAgentOverride = defaults.agent;
    if (defaults.approvalMode !== undefined) this.launchApprovalOverride = defaults.approvalMode;
  }

  /** The currently loaded top-level agent definitions (§2.7), in ascending
   * `order` then name. `setMode` validates against this, and it is how the
   * process-start agent resolves a `firstAllow` default. */
  private topLevelAgents(): AgentDefinition[] {
    return this.subagentsCore()
      .definitions()
      .filter((d) => d.kind === "top-level")
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.name.localeCompare(b.name));
  }

  /** Resolve the active top-level agent definition by name (§2.7) for the engine
   * and workers; undefined for an unknown name. Prefers a top-level definition
   * so a worker of the same name never shadows a top-level agent. */
  resolveActiveAgent(mode: string): AgentDefinition | undefined {
    const def = this.subagentsCore().getDefinition(mode);
    if (def && def.kind === "top-level") return def;
    // Fall back to the built-in chat when the name is not a top-level agent, so
    // the posture is always a known-good one (never undefined mid-session).
    return this.topLevelAgents().find((d) => d.name === mode) ?? def ?? undefined;
  }

  /** §7 — fan out worker requests through the shared `Subagents` use-case, the
   * SAME instance `api.subagents.dispatch` uses (shared registration, live
   * workers, fan-out grant, and the two gates). The engine's model-callable
   * `task` tool is bound over this; the active session's rules/id/approval-mode
   * and active agent are read live by `subagentsCore()`. */
  async dispatchForEngine(
    requests: DispatchRequest[],
    signal?: AbortSignal,
    maxConcurrency?: number,
  ): Promise<FanoutResult> {
    return this.subagentsCore().dispatchFromTurn(requests, signal, maxConcurrency);
  }

  /** §2.7c/§3.1 — the workers a top-level agent may dispatch (name + one-line
   * description), resolved from the shared registry against the agent's
   * `workers` allowance, for the `task` tool's description and valid-name error.
   * Reviewers are never dispatchable directly (they are gate 1 constructs). */
  dispatchableWorkers(agent: AgentDefinition): { name: string; description: string }[] {
    return this.subagentsCore()
      .definitions()
      .filter((d) => d.kind === "worker" && !d.reviewer && workerAllowed(agent, d.name))
      .map((d) => ({ name: d.name, description: d.description }));
  }

  /** The first top-level agent by `order` whose `unlisted` is `allow` (§2.1):
   * the target the deprecated `autoApprove` alias maps `startAgent` to. Null
   * when none exists. */
  firstAllowTopLevelAgent(): string | null {
    const found = this.topLevelAgents().find((d) => unlistedOf(d) === "allow");
    return found ? found.name : null;
  }

  readonly subagents = {
    dispatch: async (requests: DispatchRequest[]): Promise<Result<FanoutResult>> => {
      if (!Array.isArray(requests) || requests.length === 0) {
        return err(coreError(ErrorCode.INVALID_INPUT, "dispatch requires at least one worker request"));
      }
      return ok(await this.subagentsCore().dispatch(requests));
    },
    list: async (): Promise<Result<WorkerInfo[]>> => ok(this.subagentsCore().list()),
    status: async (workerId: string): Promise<Result<WorkerInfo>> => {
      const info = this.subagentsCore().status(workerId);
      if (!info) return err(coreError(ErrorCode.NOT_FOUND, `worker ${workerId} not found`));
      return ok(info);
    },
    stream: async (workerId: string): Promise<Result<WorkerStreamEvent[]>> =>
      ok(this.subagentsCore().stream(workerId)),
    cancel: async (fanoutId: string): Promise<Result<void>> => {
      this.subagentsCore().cancel(fanoutId);
      return ok(undefined);
    },
    /**
     * Recovery on resume/boot (§7.4): find unfinished staging folders and offer
     * APPLY or DISCARD through the one decision point. Returns the per-run outcome.
     */
    recoverStaging: async (): Promise<Result<Awaited<ReturnType<Subagents["recoverStaging"]>>>> =>
      ok(await this.subagentsCore().recoverStaging()),
  };

  // ── memory (§6) ───────────────────────────────────────────────────────────
  readonly memory = {
    list: async (): Promise<Result<import("./use-cases/memory.js").MemoryEntryDTO[]>> =>
      ok(this.deps.memory.list()),
    read: async (id: string): Promise<Result<import("./use-cases/memory.js").MemoryEntryDTO>> =>
      this.deps.memory.read(id),
    edit: async (input: {
      title: string;
      type: import("./entities/memory/memory-entry.js").MemoryType;
      scope: import("./entities/memory/memory-entry.js").MemoryScope;
      body: string;
      id?: string;
      summary?: string;
      keywords?: string[];
    }): Promise<Result<import("./use-cases/memory.js").MemoryEntryDTO>> => {
      if (!input || typeof input.title !== "string" || typeof input.body !== "string") {
        return err(coreError(ErrorCode.INVALID_INPUT, "memory.edit requires a title and body", { field: "title" }));
      }
      return this.deps.memory.write(input);
    },
    delete: async (id: string): Promise<Result<{ id: string }>> => this.deps.memory.delete(id),
    recall: async (query: string): Promise<Result<import("./use-cases/memory.js").RecallHit[]>> => {
      if (typeof query !== "string" || query.trim() === "") {
        return err(coreError(ErrorCode.INVALID_INPUT, "recall requires a query", { field: "query" }));
      }
      return ok(await this.deps.memory.recall(query));
    },
    suggestions: {
      list: async (): Promise<Result<import("./entities/memory/suggestion.js").SuggestionDTO[]>> =>
        ok(await this.deps.memory.listSuggestions()),
      approve: async (id: string): Promise<Result<import("./entities/memory/suggestion.js").SuggestionDTO>> =>
        this.deps.memory.approveSuggestion(id),
      reject: async (id: string): Promise<Result<import("./entities/memory/suggestion.js").SuggestionDTO>> =>
        this.deps.memory.rejectSuggestion(id),
    },
  };

  // ── agents (§2.2, §3.1, §8.1) ─────────────────────────────────────────────
  // Manifests from `register.agent` (builtin/plugin). Filesystem/global
  // discovery and persisted create/reindex are a later slice (NOT_IMPLEMENTED).
  readonly agents = {
    list: async (): Promise<Result<AgentInfo[]>> =>
      ok(this.subagentsCore().definitions().map((d) => this.toAgentInfo(d))),
    get: async (name: string): Promise<Result<AgentInfo>> => {
      if (typeof name !== "string" || name.trim() === "") {
        return err(coreError(ErrorCode.INVALID_INPUT, "agents.get requires an agent name", { field: "name" }));
      }
      const def = this.subagentsCore().getDefinition(name);
      if (!def) return err(coreError(ErrorCode.NOT_FOUND, `agent "${name}" not found`, { field: "name" }));
      return ok(this.toAgentInfo(def));
    },
    activate: async (name: string): Promise<Result<AgentInfo>> => {
      if (typeof name !== "string" || name.trim() === "") {
        return err(coreError(ErrorCode.INVALID_INPUT, "agents.activate requires an agent name", { field: "name" }));
      }
      const def = this.subagentsCore().getDefinition(name);
      if (!def) return err(coreError(ErrorCode.NOT_FOUND, `agent "${name}" not found`, { field: "name" }));
      this.activeAgentName = name;
      this.deps.bus.emit("AGENT_ACTIVATED", { name }, {});
      return ok(this.toAgentInfo(def));
    },
    deactivate: async (name?: string): Promise<Result<void>> => {
      if (name !== undefined && typeof name !== "string") {
        return err(coreError(ErrorCode.INVALID_INPUT, "agents.deactivate name must be a string", { field: "name" }));
      }
      if (!name || name === this.activeAgentName) delete this.activeAgentName;
      this.deps.bus.emit("AGENT_DEACTIVATED", { name: name ?? null }, {});
      return ok(undefined);
    },
    create: async (manifest: AgentDefinition): Promise<Result<AgentInfo>> => {
      if (!manifest || typeof manifest.name !== "string" || manifest.name.trim() === "") {
        return err(coreError(ErrorCode.INVALID_INPUT, "agents.create requires a named manifest", { field: "name" }));
      }
      if (!Array.isArray(manifest.tools)) {
        return err(coreError(ErrorCode.INVALID_INPUT, "agents.create requires a tools array", { field: "tools" }));
      }
      // §7.1 — a worker toolset holding the dispatch tool is rejected structurally.
      try {
        this.subagentsCore().register(manifest);
      } catch (e) {
        if (e instanceof CoreErrorException) return err(e.error);
        return err(coreError(ErrorCode.INVALID_INPUT, e instanceof Error ? e.message : String(e), { field: "tools" }));
      }
      return ok(this.toAgentInfo(this.subagentsCore().getDefinition(manifest.name)!));
    },
    // §3.1/§7.1/§12.1 — re-discover agent DIRECTORIES from the cascade: the
    // built-in `chat` (in CODE) first, then the global `~/.config/voidrift/agents`,
    // then the project `.voidrift/agents`. Each is `<name>/agent.json` (+ an
    // optional sibling `prompt.md`), parsed/validated with JSON + Zod (a malformed
    // directory is skipped by the adapter, never breaking discovery), and
    // registered — registration enforces the no-task-tool rule for WORKERS (§7.1)
    // and rejects+logs a worker that holds the dispatch tool. The built-in `chat`
    // is ALWAYS present with source "builtin"; a same-named global or project
    // directory OVERRIDES it (`register` is a by-name Map.set, so a later source
    // wins), and project beats global. An INVALID `chat` override is skipped and
    // degrades to the built-in with a warning; `chat` can never be removed or
    // disabled (there is no `disabled` field in the schema). Filesystem-sourced
    // definitions are rebuilt each reindex so DELETING a directory removes the
    // agent; programmatic/plugin registrations (no source) stay. Emits
    // `RESOURCE_CHANGED { type: "agent" }`.
    reindex: async (): Promise<Result<{ registered: string[]; skipped: { name: string; reason: string }[] }>> => {
      const core = this.subagentsCore();
      const registered: string[] = [];
      const skipped: { name: string; reason: string }[] = [];
      // Drop filesystem-sourced definitions so a removed directory disappears;
      // the built-in `chat` and programmatic/plugin registrations are untouched.
      core.clearDiscovered();
      // The built-in `chat` is always registered first (source "builtin"), so a
      // same-named override below replaces it and its absence restores it.
      core.register(builtinChatAgent());
      registered.push("chat");
      // Cascade order narrow-last: global then project, so a project directory
      // overrides a global one and either overrides the built-in `chat` (§3.1
      // project > global > builtin).
      for (const source of ["global", "project"] as const) {
        let result;
        try {
          result = await this.deps.agentDiscovery.discover(source);
        } catch (e) {
          this.deps.bus.emit("ERROR_OCCURRED", { source: "engine", message: `agent discovery (${source}) failed: ${e instanceof Error ? e.message : String(e)}` }, {});
          continue;
        }
        skipped.push(...result.skipped);
        for (const def of result.definitions) {
          try {
            core.register(def); // enforces the no-task-tool rule for workers (§7.1)
            registered.push(def.name);
          } catch (e) {
            // A worker holding the dispatch tool is rejected and logged, never
            // registered — discovery continues (§7.1, §12.1).
            const reason = e instanceof Error ? e.message : String(e);
            skipped.push({ name: def.name, reason });
            this.deps.bus.emit("ERROR_OCCURRED", { source: "engine", message: `agent "${def.name}" rejected: ${reason}` }, {});
          }
        }
      }
      // §3.1 — `chat` is NEVER removable: a malformed override that failed to
      // parse was skipped by discovery, so the built-in registered above stays;
      // if a syntactically-valid override replaced it but then was registered
      // and later removed, the built-in is re-registered here as the floor.
      if (!core.getDefinition("chat")) {
        core.register(builtinChatAgent());
      }
      this.deps.bus.emit("RESOURCE_CHANGED", { type: "agent" }, {});
      return ok({ registered: [...new Set(registered)].sort(), skipped });
    },
    /** The active agent's resolved toolset (§8.1); defaults to the active agent,
     * else the first registered definition (§8.1). A read — never gated (§9). */
    tools: async (agentId?: string): Promise<Result<AgentToolInfo[]>> => {
      if (agentId !== undefined && typeof agentId !== "string") {
        return err(coreError(ErrorCode.INVALID_INPUT, "agents.tools id must be a string", { field: "agentId" }));
      }
      const core = this.subagentsCore();
      const name = agentId ?? this.activeAgentName ?? core.definitions()[0]?.name;
      if (!name) return ok([]);
      return ok(core.resolvedTools(name));
    },
  };

  // ── documents (§4.5, §2.2) ─────────────────────────────────────────────────
  // The active session's document registry — a read-only view of what the agent
  // holds in context (§4.5). `load` records a gate-approved external file as a
  // snapshot; `unload` drops an entry. Reads are free (§9).
  readonly documents = {
    list: async (): Promise<Result<DocumentInfo[]>> => {
      const session = this.activeSession ?? [...this.live.values()][0];
      if (!session) return ok([]);
      return ok(this.documentInfos(session));
    },
    load: async (path: string): Promise<Result<DocumentInfo>> => {
      if (typeof path !== "string" || path.trim() === "") {
        return err(coreError(ErrorCode.INVALID_INPUT, "documents.load requires a path", { field: "path" }));
      }
      const session = this.activeSession ?? [...this.live.values()][0];
      if (!session) return err(coreError(ErrorCode.SESSION_NOT_FOUND, "no live session to load into"));
      let content: string;
      try {
        content = await this.deps.fileSystem.readFile(path);
      } catch (e) {
        if (e instanceof CoreErrorException) return err(e.error);
        return err(coreError(ErrorCode.NOT_FOUND, `cannot read "${path}": ${e instanceof Error ? e.message : String(e)}`, { field: "path" }));
      }
      const registry = new DocumentRegistry(session, (type, payload) =>
        this.deps.bus.emit(type, payload, { session: session.id }),
      );
      const entry = registry.add({ path, content, trust: "live", turn: session.turn });
      await this.mirror(session);
      return ok(this.toDocumentInfo(entry, session));
    },
    unload: async (path: string): Promise<Result<{ path: string }>> => {
      if (typeof path !== "string" || path.trim() === "") {
        return err(coreError(ErrorCode.INVALID_INPUT, "documents.unload requires a path", { field: "path" }));
      }
      const session = this.activeSession ?? [...this.live.values()][0];
      if (!session) return err(coreError(ErrorCode.SESSION_NOT_FOUND, "no live session"));
      if (!session.documents.has(path)) {
        return err(coreError(ErrorCode.NOT_FOUND, `document "${path}" not loaded`, { field: "path" }));
      }
      session.documents.delete(path);
      session.readPaths.delete(path);
      session.stalePaths.delete(path);
      this.deps.bus.emit("DOCUMENT_REGISTRY_CHANGED", { path, action: "unloaded" }, { session: session.id });
      await this.mirror(session);
      return ok({ path });
    },
  };

  // ── MCP client (§8.4) ─────────────────────────────────────────────────────
  // DTO-only: `McpServerInfo` carries no secret and no SDK/mcp-adapters type
  // (§10.10, §1 rule 4). Save/remove route through the config capability (§13).
  readonly mcp = {
    list: async (): Promise<Result<import("./entities/mcp/mcp-types.js").McpServerInfo[]>> =>
      ok(this.deps.mcpClient.list()),
    listConfigs: async (): Promise<Result<Record<string, import("./entities/mcp/mcp-types.js").McpServerConfig>>> =>
      ok(this.deps.mcpClient.listConfigs()),
    connect: async (name: string): Promise<Result<import("./entities/mcp/mcp-types.js").McpServerInfo>> => {
      if (typeof name !== "string" || name.trim() === "") {
        return err(coreError(ErrorCode.INVALID_INPUT, "mcp.connect requires a server name", { field: "name" }));
      }
      return ok(await this.deps.mcpClient.connect(name));
    },
    disconnect: async (name: string): Promise<Result<{ name: string }>> => {
      const res = await this.deps.mcpClient.disconnect(name);
      return res.ok ? ok({ name }) : res;
    },
    saveConfig: async (
      name: string,
      config: unknown,
      layer: ConfigLayer = "project",
    ): Promise<Result<import("./entities/mcp/mcp-types.js").McpServerInfo>> => {
      if (typeof name !== "string" || name.trim() === "") {
        return err(coreError(ErrorCode.INVALID_INPUT, "mcp.saveConfig requires a server name", { field: "name" }));
      }
      return this.deps.mcpClient.saveConfig(name, config, layer);
    },
    removeConfig: async (name: string, layer: ConfigLayer = "project"): Promise<Result<{ name: string }>> =>
      this.deps.mcpClient.removeConfig(name, layer),
    // §8.4 — `mcp.approve` is an ACTING op gated through the decision point as a
    // config-like write (`mcp_approve`); `trust:true` does NOT bypass it. It is
    // NOT a model-facing tool (never registered via register.tool), so a model
    // can never approve its own server's tools.
    approve: async (
      name: string,
      names?: string[],
    ): Promise<Result<import("./entities/mcp/mcp-types.js").McpServerInfo>> => {
      if (typeof name !== "string" || name.trim() === "") {
        return err(coreError(ErrorCode.INVALID_INPUT, "mcp.approve requires a server name", { field: "name" }));
      }
      return this.deps.mcpClient.approve(name, names);
    },
    // §8.4 — `mcp.pins` is a read-only listing of pins and their statuses.
    pins: async (): Promise<Result<import("./entities/mcp/mcp-types.js").McpServerInfo[]>> =>
      ok(this.deps.mcpClient.pins()),
  };

  // ── observability (§10.5) ──────────────────────────────────────────────────
  // DTO-only: `ObsRecord` is the neutral record (no LangChain type, §10.1).
  // `query` is a point-in-time read of a session trail; `tail` returns an
  // unsubscribe handle for a live, Liqe-filtered subscription (§10.5).
  readonly observability = {
    query: async (
      sessionId: string,
      filter?: string,
      opts?: { limit?: number; since?: string },
    ): Promise<Result<import("./entities/observability/obs-record.js").ObsRecord[]>> => {
      if (typeof sessionId !== "string" || sessionId.trim() === "") {
        return err(coreError(ErrorCode.SESSION_NOT_FOUND, "observability.query requires a session id", { field: "sessionId" }));
      }
      return this.deps.obsWriter.query(sessionId, filter, opts);
    },
    tail: async (
      filter: string | undefined,
      emit: (record: import("./entities/observability/obs-record.js").ObsRecord) => void,
    ): Promise<Result<() => void>> => this.deps.obsWriter.tail(filter, emit),
    stats: async (
      opts?: { days?: number; model?: string; agent?: string },
    ): Promise<Result<import("./entities/observability/stats-report.js").StatsReport>> => {
      // §2.4/§10.14 — the AGGREGATE cost/token/time report across the workspace's
      // stored session trails, optionally filtered by day cutoff, model or agent.
      // Reads local trails only: no session start, no network, no model call.
      if (opts !== undefined && (typeof opts !== "object" || opts === null)) {
        return err(coreError(ErrorCode.INVALID_INPUT, "observability.stats opts must be an object", { field: "opts" }));
      }
      if (opts?.days !== undefined && (typeof opts.days !== "number" || !Number.isFinite(opts.days) || opts.days < 0)) {
        return err(coreError(ErrorCode.INVALID_INPUT, "observability.stats days must be a non-negative number", { field: "days" }));
      }
      const build: { days?: number; model?: string; agent?: string; workspace?: string } = {};
      if (opts?.days !== undefined) build.days = opts.days;
      if (opts?.model) build.model = opts.model;
      if (opts?.agent) build.agent = opts.agent;
      if (this.deps.workspaceRoot) build.workspace = this.deps.workspaceRoot;
      return ok(await this.deps.obsWriter.aggregateStats(build));
    },
  };

  // ── skills (§12.1) ────────────────────────────────────────────────────────
  readonly skills = {
    list: async (): Promise<Result<SkillDTO[]>> => ok(this.deps.skills.list()),
    reindex: async (): Promise<Result<SkillDTO[]>> => {
      await this.deps.skills.reindex();
      return ok(this.deps.skills.list());
    },
    create: async (name: string, scope: SkillScope): Promise<Result<SkillDTO>> =>
      this.deps.skills.create(name, scope),
    rename: async (name: string, newName: string, scope: SkillScope): Promise<Result<SkillDTO>> =>
      this.deps.skills.rename(name, newName, scope),
    delete: async (name: string, scope: SkillScope): Promise<Result<{ name: string }>> =>
      this.deps.skills.delete(name, scope),
    override: async (name: string, scope: SkillScope): Promise<Result<SkillDTO>> =>
      this.deps.skills.override(name, scope),
  };

  // ── prompts (§12.2) ─────────────────────────────────────────────────────────
  readonly prompts = {
    list: async (): Promise<Result<PromptDTO[]>> => ok(this.deps.prompts.list()),
    get: async (key: string): Promise<Result<PromptDTO>> => ok(this.deps.prompts.get(key)),
    override: async (key: string, scope: "workspace" | "global"): Promise<Result<PromptDTO>> =>
      this.deps.prompts.override(key, scope),
    resetOverride: async (key: string): Promise<Result<PromptDTO>> => this.deps.prompts.resetOverride(key),
  };

  // ── plugins (§12.4) ───────────────────────────────────────────────────────
  readonly plugins = {
    list: async (): Promise<Result<PluginMeta[]>> => ok(this.deps.plugins.list()),
    enable: async (id: string, scope: ConfigLayer = "project"): Promise<Result<PluginMeta>> =>
      this.deps.plugins.enable(id, scope),
    disable: async (id: string, scope: ConfigLayer = "project"): Promise<Result<{ id: string }>> =>
      this.deps.plugins.disable(id, scope),
    scope: async (id: string): Promise<Result<{ id: string }>> => this.deps.plugins.scope(id),
    // §12.4.1 — user-initiated discovery/install, never model-facing tools.
    search: async (
      query: string,
      opts?: { size?: number; from?: number },
    ): Promise<Result<import("./entities/plugins/plugin-registry.js").PluginSearchResult[]>> =>
      this.deps.plugins.search(query, opts),
    inspect: async (
      name: string,
      version?: string,
    ): Promise<Result<import("./entities/plugins/plugin-registry.js").PluginReview>> =>
      this.deps.plugins.inspect(name, version),
    install: async (req: {
      name: string;
      version: string;
      integrity: string;
      scope: "global" | "project";
      confirm: true;
    }): Promise<Result<PluginMeta>> => this.deps.plugins.install(req),
  };

  // ── internals ────────────────────────────────────────────────────────────────

  /**
   * Render a stored session as a sanitized `SessionExport` (§10.13). READ-ONLY:
   * no journal entry, no rollback move, no model call, no network. Resolves
   * `"last"` to the most recent session for this workspace, validates `format`,
   * assembles the raw document from the stored seams (metadata, message chain,
   * journal metadata, obs token/cost), sanitizes it ONCE via the use-case, then
   * either returns the rendered content or writes an owner-only file.
   */
  private async exportSession(
    id: string,
    opts?: { format?: "md" | "json"; out?: string; includeToolResults?: boolean },
  ): Promise<Result<{ format: "md" | "json"; path?: string; content?: string; masking: MaskSummary }>> {
    if (typeof id !== "string" || id.trim() === "") {
      return err(coreError(ErrorCode.INVALID_INPUT, "export requires a session id or 'last'", { field: "id" }));
    }
    const format = opts?.format ?? "json";
    if (format !== "md" && format !== "json") {
      return err(coreError(ErrorCode.INVALID_INPUT, `unknown export format "${String(format)}" (use md or json)`, { field: "format" }));
    }
    const includeToolResults = opts?.includeToolResults !== false;

    // Resolve the session id ('last' = most recent for this workspace).
    let resolvedId = id;
    if (id === "last") {
      const metas = await this.deps.sessions.list();
      const here = metas.filter((m) => m.workspace === this.deps.workspaceRoot);
      const newest = (here.length > 0 ? here : metas).sort(
        (a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime(),
      )[0];
      if (!newest) return err(coreError(ErrorCode.SESSION_NOT_FOUND, "no stored session to export", { field: "id" }));
      resolvedId = newest.id;
    }

    const persisted = await this.deps.sessions.load(resolvedId);
    if (!persisted) {
      return err(coreError(ErrorCode.SESSION_NOT_FOUND, `session ${resolvedId} not found`, { field: "id" }));
    }

    // Assemble the RAW (pre-sanitize) document from the read-only seams.
    const raw = await this.assembleExport(resolvedId, persisted, includeToolResults);
    const doc = buildSessionExport(raw, includeToolResults, {
      perResultBytes: this.deps.config.effectiveLimit("export.perResultBytes"),
      documentBytes: this.deps.config.effectiveLimit("export.documentBytes"),
    });
    const content = format === "md" ? renderMarkdown(doc) : renderJson(doc);

    // stdout path: return the rendered content.
    if (opts?.out === undefined || opts.out === "") {
      return ok({ format, content, masking: doc.masking });
    }
    // File path: refuse an existing, protected, or symlinked target; write
    // owner-only (0600, parents 0700), temp+rename.
    const written = await this.writeExport(opts.out, content);
    if (!written.ok) return written;
    return ok({ format, path: written.value, masking: doc.masking });
  }

  /** Assemble the raw (pre-sanitize) export document from the stored session
   * state, message chain, journal metadata, and the obs token/cost totals. */
  private async assembleExport(
    sessionId: string,
    persisted: import("./entities/ports/session-repository.js").PersistedSession,
    includeToolResults: boolean,
  ): Promise<RawExportInput> {
    const meta = persisted.metadata;
    // Message chain → ExportMessage[]. Rehydrate a transient session purely to
    // load the chain; it is never persisted and is dropped after.
    const transient = new Session(meta);
    let messages: ExportMessage[] = [];
    try {
      const chain = await this.deps.makeEngine().loadChain(transient);
      messages = this.chainToExportMessages(chain, persisted.turns ?? [], includeToolResults);
    } catch {
      messages = [];
    }

    // Writes: journal METADATA only (§10.11), never captured content.
    const writes: ExportWrite[] = [];
    if (this.deps.journalStore) {
      try {
        const entries = await this.deps.journalStore.list(sessionId);
        for (const e of entries) {
          const result: ExportWrite["result"] =
            e.result.status === "ok" ? "ok" : e.result.status === "error" ? "failed" : "refused";
          writes.push({
            turn: e.turn,
            time: e.time,
            tool: e.tool,
            ...(e.planStep !== undefined ? { intent: e.planStep } : {}),
            target: e.target,
            result,
            ...(e.undoHint !== undefined ? { undoHint: e.undoHint } : {}),
          });
        }
      } catch {
        /* a journal read failure never fails the export */
      }
    }

    // Token totals, distinct model names, and cost (only when every model that
    // ran is priced, §10.7) — from the obs trail's model.usage spans.
    const { models, totals } = await this.exportTotals(sessionId);

    return {
      session: {
        id: meta.id,
        name: meta.name,
        agent: transient.mode ?? "chat",
        createdAt: meta.startedAt,
        lastActiveAt: meta.lastActiveAt,
        turns: meta.turnCount,
      },
      models,
      totals,
      messages,
      ...(writes.length > 0 ? { writes } : {}),
      home: os.homedir(),
      workspaceRoot: this.deps.workspaceRoot,
    };
  }

  /** Distinct model names, summed token totals, and cost for a stored session,
   * derived from the obs trail's `model.usage` spans (§10.3, §10.7). `cost` is
   * present only when EVERY model that produced usage is priced in config. */
  private async exportTotals(
    sessionId: string,
  ): Promise<{ models: string[]; totals: { tokensIn: number; tokensOut: number; cost?: number } }> {
    const models = new Set<string>();
    let tokensIn = 0;
    let tokensOut = 0;
    let cost = 0;
    let everyModelPriced = true;
    let sawUsage = false;
    try {
      const res = await this.deps.obsWriter.query(sessionId, "name:model.usage");
      const records = res.ok ? res.value : [];
      const cfgModels = this.deps.config.get().models ?? {};
      for (const r of records) {
        const name = r.model?.name;
        if (name) models.add(name);
        if (!r.usage) continue;
        sawUsage = true;
        tokensIn += r.usage.inputTokens ?? 0;
        tokensOut += r.usage.outputTokens ?? 0;
        // Price this span if a configured model entry carries a price (§10.7).
        const entry = name ? cfgModels[name] : undefined;
        const inRate = entry?.costPer1kInput;
        const outRate = entry?.costPer1kOutput;
        if (inRate === undefined && outRate === undefined) {
          everyModelPriced = false;
        } else {
          cost += ((r.usage.inputTokens ?? 0) / 1000) * (inRate ?? 0);
          cost += ((r.usage.outputTokens ?? 0) / 1000) * (outRate ?? 0);
        }
      }
    } catch {
      everyModelPriced = false;
    }
    const totals: { tokensIn: number; tokensOut: number; cost?: number } = { tokensIn, tokensOut };
    if (sawUsage && everyModelPriced) totals.cost = Math.round(cost * 1e6) / 1e6;
    return { models: [...models].sort(), totals };
  }

  /** Convert a persisted message chain to `ExportMessage[]` (§10.13): user /
   * assistant roles, the assistant's FINAL text (reasoning is already excluded,
   * §4.7), tool calls with args (file-content/edit bodies → `{bytes}`), tool
   * results as a bounded summary, and image placeholders (never bytes). Turn
   * numbers are assigned from the `turns.json` message-count boundaries. */
  private chainToExportMessages(
    chain: import("@langchain/core/messages").BaseMessage[],
    turns: import("./entities/session.js").TurnSnapshot[],
    includeToolResults: boolean,
  ): ExportMessage[] {
    // Build a per-index turn lookup from the cumulative messageCount boundaries.
    const boundaries = [...turns].sort((a, b) => a.messageCount - b.messageCount);
    const turnFor = (index: number): { turn: number; time: string } => {
      for (const b of boundaries) {
        if (index < b.messageCount) return { turn: b.turn, time: b.timestamp };
      }
      const last = boundaries[boundaries.length - 1];
      return { turn: last ? last.turn : 0, time: last ? last.timestamp : new Date(0).toISOString() };
    };

    const out: ExportMessage[] = [];
    // Map a tool_call_id → the ExportMessage.toolCall awaiting its result.
    const pending = new Map<string, ExportToolCall>();
    for (let i = 0; i < chain.length; i++) {
      const m = chain[i]!;
      const type = m.getType();
      const { turn, time } = turnFor(i);
      if (type === "human") {
        const { text, images } = this.extractUserContent(m.content);
        const msg: ExportMessage = { role: "user", turn, time, text };
        if (images.length > 0) msg.images = images;
        out.push(msg);
      } else if (type === "ai") {
        const text = this.extractText(m.content);
        const toolCalls = (m as { tool_calls?: { name?: string; args?: Record<string, unknown> }[] }).tool_calls ?? [];
        const msg: ExportMessage = { role: "assistant", turn, time, text };
        if (toolCalls.length > 0) {
          msg.toolCalls = toolCalls.map((tc) => {
            const call: ExportToolCall = {
              tool: tc.name ?? "",
              args: this.redactToolArgs(tc.name ?? "", tc.args ?? {}),
            };
            const idRaw = (tc as { id?: string }).id;
            if (idRaw) pending.set(idRaw, call);
            return call;
          });
        }
        out.push(msg);
      } else if (type === "tool") {
        if (!includeToolResults) continue;
        const id = (m as { tool_call_id?: string }).tool_call_id;
        const call = id ? pending.get(id) : undefined;
        if (call) {
          const summary = this.extractText(m.content);
          call.result = { summary, truncated: false };
        }
      }
      // Other roles (system) are not part of the exported conversation.
    }
    return out;
  }

  /** Replace file-content/edit bodies in tool args with `{ bytes }` (§10.13). */
  private redactToolArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
    const keys = CONTENT_ARG_KEYS[tool] ?? [];
    if (keys.length === 0) return args;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (keys.includes(k) && typeof v === "string") out[k] = { bytes: Buffer.byteLength(v, "utf8") };
      else out[k] = v;
    }
    return out;
  }

  /** The text of a message's content (string or content-block array). Reasoning
   * blocks are never persisted (§4.7); image blocks are dropped here. */
  private extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? String((p as { text?: unknown }).text ?? "") : ""))
        .join("");
    }
    return "";
  }

  /** Split a user message's content into text and image placeholders (§10.13).
   * Image bytes are never included; the byte count is derived from the data-URL. */
  private extractUserContent(content: unknown): { text: string; images: { type: "png" | "jpeg" | "gif" | "webp"; bytes: number }[] } {
    const images: { type: "png" | "jpeg" | "gif" | "webp"; bytes: number }[] = [];
    if (typeof content === "string") return { text: content, images };
    if (!Array.isArray(content)) return { text: "", images };
    const texts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const t = (part as { type?: string }).type;
      if (t === "text") {
        texts.push(String((part as { text?: unknown }).text ?? ""));
      } else if (t === "image_url" || t === "image") {
        const url = (part as { image_url?: { url?: string } }).image_url?.url ?? "";
        const comma = url.indexOf(",");
        const b64 = comma >= 0 ? url.slice(comma + 1) : "";
        const bytes = b64 ? Math.floor((b64.length * 3) / 4) : 0;
        const mimeMatch = /^data:image\/(png|jpeg|gif|webp)/.exec(url);
        const type = (mimeMatch?.[1] as "png" | "jpeg" | "gif" | "webp") ?? "png";
        images.push({ type, bytes });
      }
    }
    return { text: texts.join(""), images };
  }

  /** Write the rendered export to `out` owner-only (§10.13): refuse an existing,
   * protected, or symlinked target; create parents 0700; file 0600; temp+rename.
   * An out-of-workspace absolute path in an error is replaced by `<path>`. */
  private async writeExport(out: string, content: string): Promise<Result<string>> {
    const abs = normalizeOutPath(this.deps.workspaceRoot, out);
    // Protected control path (§9.4): refuse with EXPORT_TARGET_PROTECTED.
    const cfgPaths = this.deps.config.paths();
    const globalConfigDir = path.dirname(cfgPaths.global.path);
    const cls = classifyControlPath(abs, {
      workspaceRoot: this.deps.workspaceRoot,
      globalConfigDir,
      home: os.homedir(),
    });
    if (cls !== null) {
      return err(coreError(ErrorCode.EXPORT_TARGET_PROTECTED, `export target is a protected control path: ${this.redactOut(abs)}`, { field: "out" }));
    }
    // Publish with an ATOMIC no-overwrite (no lstat-then-rename TOCTOU, finding
    // 4): write a 0600 temp, then `fs.link(tmp, abs)` which fails EEXIST if the
    // target (a file OR a symlink) already exists — the existence check and the
    // publish are one atomic step. The temp is unlinked afterward. EEXIST maps
    // to EXPORT_TARGET_EXISTS; anything else is EXPORT_WRITE_FAILED.
    const dir = path.dirname(abs);
    const tmp = path.join(dir, `.${path.basename(abs)}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.writeFile(tmp, content, { mode: 0o600 });
      try {
        await fs.link(tmp, abs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
          return err(coreError(ErrorCode.EXPORT_TARGET_EXISTS, `export target already exists: ${this.redactOut(abs)}`, { field: "out" }));
        }
        throw e;
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
      }
      return ok(abs);
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      return err(coreError(ErrorCode.EXPORT_WRITE_FAILED, `export write failed: ${this.redactOut(e instanceof Error ? e.message : String(e))}`, { field: "out" }));
    }
  }

  /** Replace an out-of-workspace absolute path with `<path>` in a message
   * (§10.13) so an export error never leaks a path outside the workspace. */
  private redactOut(s: string): string {
    const root = this.deps.workspaceRoot;
    return s.replace(/(?:[A-Za-z]:)?(?:\/[^\s"'`]+)/g, (m) => (m === root || m.startsWith(root + "/") ? m : "<path>"));
  }


  private drainInjected(sessionId: string): string[] {
    const buf = this.injected.get(sessionId);
    if (!buf || buf.length === 0) return [];
    this.injected.delete(sessionId);
    return buf;
  }

  /** Map an agent definition to its render-ready DTO (§3.1, §8.1). */
  private toAgentInfo(def: AgentDefinition): AgentInfo {
    const kind = def.kind === "top-level" ? "top-level" : "worker";
    return {
      name: def.name,
      description: def.description,
      active: def.name === this.activeAgentName,
      reviewer: def.reviewer === true,
      kind,
      tools: this.subagentsCore().resolvedTools(def.name).map((t) => t.name),
      // §3.1 — the source the def cascaded from; a programmatic registration
      // (no source) is reported as "project" (user-registered this process).
      source: def.source ?? "project",
      ...(def.filePath !== undefined ? { file: def.filePath } : {}),
      // §3.1/§9 — class derived from the tool list (fail closed on an unknown).
      class: deriveAgentClass(def),
      // §3.1 — top-level-only orchestration fields.
      ...(kind === "top-level"
        ? {
            ...(def.workers !== undefined ? { workers: def.workers } : {}),
            ...(def.unlisted !== undefined ? { unlisted: def.unlisted } : {}),
            ...(def.order !== undefined ? { order: def.order } : {}),
            ...(def.label !== undefined ? { label: def.label } : {}),
            ...(def.confirm !== undefined ? { confirm: def.confirm } : {}),
          }
        : {}),
    };
  }

  /** Map a document entry to its render-ready DTO (§4.5). */
  private toDocumentInfo(e: DocumentEntry, session: Session): DocumentInfo {
    return {
      path: e.path,
      name: e.path.split("/").pop() ?? e.path,
      trust: e.trust,
      lines: e.lines,
      hash: e.hash,
      stale: e.stale || session.stalePaths.has(e.path),
      turnAdded: e.turnAdded,
    };
  }

  /** The active session's document registry as DTOs, stable path order (§4.5). */
  private documentInfos(session: Session): DocumentInfo[] {
    return [...session.documents.values()]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((e) => this.toDocumentInfo(e, session));
  }

  /**
   * Normalize a persisted message to the render-ready DTO (§5.4). Content is a
   * string — a string passes through, any non-string (content-block array,
   * tool-result object) is JSON-stringified. Reasoning is already excluded from
   * the persisted chain (§4.7). Secrets are masked before the DTO leaves the
   * process (§10.10).
   */
  private toMessageDTO(m: import("@langchain/core/messages").BaseMessage): MessageDTO {
    const role = m.getType();
    const raw = m.content;
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    const content = maskValue(text) as string;
    const toolCallId = (m as { tool_call_id?: string }).tool_call_id;
    return {
      role,
      content,
      ...(typeof toolCallId === "string" && toolCallId !== "" ? { toolCallId } : {}),
    };
  }

  /**
   * Apply a host-only rollback op (§10.12): idle-gate, run the service, and on a
   * successful restore append a masked SYSTEM note to the conversation so the
   * model stops assuming its earlier edits survive. `SESSION_BUSY` while a turn
   * runs; `NOT_FOUND` (with the valid id range) for an unknown goto id; nothing
   * is restored in either case.
   */
  private async applyRollback(
    sessionId: string,
    action: "undo" | "redo" | "goto",
    gotoId: number | undefined,
    opts?: { confirmOverwrite?: string[] },
  ): Promise<Result<import("./use-cases/rollback.js").RollbackOutcome>> {
    if (!this.deps.rollback) {
      return err(coreError(ErrorCode.NOT_FOUND, "rollback is not available in this build"));
    }
    const session = this.live.get(sessionId) ?? (await this.rehydrate(sessionId));
    if (!session) return err(coreError(ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} not found`));
    // §10.12 — idle only: a running turn refuses SESSION_BUSY and changes nothing.
    if (session.turnActive) {
      return err(coreError(ErrorCode.SESSION_BUSY, "rollback unavailable while a turn is running"));
    }
    // An unknown goto id → NOT_FOUND naming the valid range.
    if (action === "goto") {
      const report = await this.deps.rollback.moves(sessionId);
      if (report.enabled && report.moves) {
        const ids = report.moves.map((m) => m.id);
        const valid = ids.length > 0 ? `0..${ids[ids.length - 1]}` : "0";
        if (gotoId !== 0 && !ids.includes(gotoId!)) {
          return err(coreError(ErrorCode.NOT_FOUND, `no move with id ${gotoId}; valid range: ${valid}`, { field: "id" }));
        }
      }
    }
    const outcome =
      action === "undo"
        ? await this.deps.rollback.undo(sessionId, opts)
        : action === "redo"
          ? await this.deps.rollback.redo(sessionId, opts)
          : await this.deps.rollback.goto(sessionId, gotoId!, opts);

    // §10.12 step (f) — after a successful traversal append a masked harness
    // note on the NEW conversation tip (the service already rewrote it) stating
    // the move reached and, when files changed, which ones. Appended for EVERY
    // successful traversal (chat-only moves included) so the model stops
    // assuming its earlier edits survive.
    if (outcome.ok && outcome.toPointer !== outcome.fromPointer) {
      let note: string;
      if (outcome.restored.length > 0) {
        // Every restored path is attacker-influenced (a crafted file NAME): mask
        // any secret, THEN run the shared trusted-channel sanitizer (strips
        // control/bidi/zero-width chars, flattens newlines/tabs, neutralizes a
        // forged `[harness note]`, caps each path) so nothing in a NAME can forge
        // a second directive or rewrite terminal/text direction (§8.2, §10.12).
        const shown = outcome.restored
          .slice(0, SANITIZED_PATH_LIST_MAX)
          .map((p) => sanitizeTrustedText(maskText(p), SANITIZED_PATH_MAX));
        const more =
          outcome.restored.length > SANITIZED_PATH_LIST_MAX ? ` and ${outcome.restored.length - SANITIZED_PATH_LIST_MAX} more` : "";
        note =
          `The user rolled back to move ${outcome.toId}: ${outcome.restored.length} files were restored ` +
          `(${shown.join(", ")}${more}). Do not assume your earlier edits to those files still exist; ` +
          `re-read them before editing.`;
      } else {
        note =
          `The user rolled back to move ${outcome.toId} (no file changes). The conversation was rewound; ` +
          `earlier edits may no longer reflect the current state.`;
      }
      // Hard-bound the whole note (§10.12, ROLL3) so even many long paths cannot
      // inflate the trusted-channel message beyond its cap — the effective
      // `rollback.harnessNoteMaxChars` registry value (entity default fallback).
      const noteMax = this.deps.getLimit?.("rollback.harnessNoteMaxChars") ?? HARNESS_NOTE_MAX;
      const bounded = boundHarnessNote(note, noteMax);
      try {
        await this.deps.makeEngine().appendSystemNote(session, bounded);
      } catch {
        /* a note-append failure never fails the rollback it describes */
      }
    }
    return ok(outcome);
  }

  /** Rehydrate a session from the repository into the live set (§5.3). */
  private async rehydrate(id: string): Promise<Session | undefined> {
    const persisted = await this.deps.sessions.load(id);
    if (!persisted) return undefined;
    // §5.5 — scrub a stored (possibly planted) name through the shared sanitizer.
    persisted.metadata.name = sanitizeTrustedText(persisted.metadata.name, sessionNameMaxChars());
    const session = new Session(persisted.metadata);
    // §2.7 — the active agent is runtime state, never persisted: a rehydrated
    // session starts in `chat` unless the process-start active agent is set.
    { const sa = this.effectiveStartAgent(); if (sa) session.mode = sa; }
    session.sessionRules = persisted.sessionRules;
    session.approvalMode = persisted.approvalMode;
    session.pending = persisted.pending;
    session.lastStatus = persisted.lastStatus;
    session.turns = persisted.turns ?? [];
      if (persisted.metadata.rollingSummary) session.rollingSummary = persisted.metadata.rollingSummary;
    for (const d of persisted.documents) {
      session.registerDocument(d);
      if (d.stale) session.markStale(d.path);
      else session.markRead(d.path);
    }
    this.live.set(id, session);
    return session;
  }

  /** Mirror live session state to the repository (§5.2). */
  private async mirror(session: Session): Promise<void> {
    // Mirror the rolling-summary state into metadata (§4.9, §5.1).
    if (session.rollingSummary) session.metadata.rollingSummary = session.rollingSummary;
    await this.deps.sessions.save({
      metadata: session.metadata,
      documents: [...session.documents.values()].map((d) => ({
        ...d,
        stale: session.stalePaths.has(d.path),
      })),
      pending: session.pending,
      sessionRules: session.sessionRules,
      approvalMode: session.approvalMode,
      lastStatus: session.lastStatus,
      turns: session.turns,
    });
  }

  /**
   * Name a session (§5.5). Sets the first-turn first-line FALLBACK synchronously
   * so a name always exists, then — on a COMPLETED turn, when not user-pinned,
   * and only when the conversation grew by ≥1 completed turn since the last
   * evaluation — SCHEDULES a passive, off-turn model re-evaluation through the
   * injected `NamingPort`. The model call never blocks the turn or its result
   * (it is fire-and-forget, tracked so a headless exit / shutdown can await it
   * within a short cap and abort it). The proposed name is run through the ONE
   * shared trusted-channel sanitizer (control/ANSI/OSC/bidi stripped, a forged
   * `[harness note]` neutralized, capped at 60) before it is stored or shown; a
   * null/empty/identical result keeps the previous name. NO event is emitted
   * (§5.5): the name is read through `session.list`. A rename pins the name.
   */
  private autoName(session: Session, input: string, completed: boolean): void {
    if (session.metadata.namePinned) return;
    // The first completed/attempted turn gets the first-line fallback so a name
    // exists immediately even before (or without) a model re-evaluation.
    if (session.metadata.turnCount === 1 && (!session.metadata.name || session.metadata.name === "untitled")) {
      const nameMax = this.deps.config.effectiveLimit("session.nameMaxChars");
      const firstLine = input.split("\n")[0]!.slice(0, nameMax).trim();
      session.metadata.name = sanitizeTrustedText(firstLine, nameMax) || "untitled";
    }
    if (!completed || !this.deps.namingPort) return;
    // The passive naming call is an INTERACTIVE-session UX feature (it surfaces
    // through the session list a user browses). Non-interactive modes — headless
    // one-shot `--prompt`/`--routine`, `policy_only`, `out_of_band` — have no
    // such surface and assert exact per-turn model-request counts, so naming is
    // SKIPPED there and never perturbs a run's request count (§5.5).
    if (session.approvalMode !== "interactive") return;
    // Re-evaluate only when the conversation grew by ≥1 completed turn since the
    // last evaluation — never twice for the same turnCount.
    const last = this.lastNamedTurnCount.get(session.id) ?? 0;
    if (session.metadata.turnCount <= last) return;
    this.lastNamedTurnCount.set(session.id, session.metadata.turnCount);
    const current = session.metadata.name;
    // A short, masked summary of the latest turn is built by the engine's turn
    // tracking; use the latest rolling summary or the user input as the activity.
    const turnSummary = session.rollingSummary?.summary || input;
    const CAP_MS = this.deps.config.effectiveLimit("session.namingTimeoutMs");
    const task = (async (): Promise<void> => {
      try {
        if (session.metadata.namePinned) return;
        const proposed = await Promise.race([
          this.deps.namingPort!.suggest({ current, turnSummary }),
          new Promise<null>((r) => {
            const t = setTimeout(() => r(null), CAP_MS);
            // Abort on shutdown so the cap never outlives the process.
            this.namingAbort.signal.addEventListener("abort", () => { clearTimeout(t); r(null); }, { once: true });
          }),
        ]);
        if (this.namingAbort.signal.aborted) return;
        if (session.metadata.namePinned) return;
        if (proposed === null) return; // keep the previous name
        const clean = sanitizeTrustedText(proposed, this.deps.config.effectiveLimit("session.nameMaxChars"));
        if (clean === "" || clean === current) return; // identical/empty → keep
        session.metadata.name = clean;
        await this.mirror(session).catch(() => undefined);
      } catch {
        /* naming never throws into the turn; keep the previous name */
      } finally {
        this.namingInFlight.delete(session.id);
      }
    })();
    this.namingInFlight.set(session.id, task);
  }

  private async computeHousekeeping(): Promise<HousekeepingNotice> {
    const idleDays = this.deps.config.effectiveLimit("logs.housekeepingIdleDays");
    const cutoff = Date.now() - idleDays * 86_400_000;
    const metas = await this.deps.sessions.list();
    const idle = metas.filter((m) => new Date(m.lastActiveAt).getTime() < cutoff).length;
    return { idleSessions: idle, idleDays };
  }
}

/** The system temp dir prefix, for the temp-dir guardrail (§9.4). */
export function systemTempDir(): string {
  return path.resolve(os.tmpdir());
}
