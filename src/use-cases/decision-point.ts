/**
 * The ONE decision point (core-blueprint.md §9.1, §15.1#4) — shared factory.
 *
 * Every tool call — the orchestrator's, a dispatched worker's, the reviewer's,
 * a plugin-dispatched worker's — passes the SAME gate before it runs: unknown-
 * tool reject (§8.1), the managed-layer gate (§13.5), Warden (§9.1 step 4, a
 * final deny before Guardian), Guardian over the SAME `resolveRules(config,
 * sessionRules)` the engine uses (§9.1 step 5, deny > ask > allow; force-ask
 * immune to grants/allow/plan-scope, §9.3), guardrails (§9.1 step 6), then
 * execute bracketed by TOOL_STARTED/TOOL_FINISHED (§8.1), §8.3 large-result
 * eviction, and §10.10 secret masking. Reads are free (§9).
 *
 * This is `createMiddleware({ name: "voidrift-decision-point", wrapToolCall })`
 * built from explicit deps and a `CallerContext`, so the engine and the
 * subagents use-case share ONE implementation — nothing is copied (§15.1#4,
 * §1 rule 10). The only thing that varies is HOW an `ask` resolves: the engine
 * suspends with a durable LangGraph `interrupt`; a worker follows §9.5 (fan-out
 * grant, policy_only fail-fast, out_of_band pause via `session.confirm`). That
 * variation is the injected `AskResolver`; the gate order is identical.
 */
import { ToolMessage } from "@langchain/core/messages";
import { realpathSync } from "node:fs";
import { createMiddleware } from "langchain";
import { Guardian, type GuardrailContext, type GuardianOutcome, type ShellLists } from "../entities/guardian.js";
import { Warden } from "../entities/warden.js";
import type { ToolRegistry } from "../entities/tool-registry.js";
import type { EventBus } from "../entities/event-bus.js";
import type { Config, PermissionRule } from "../config/schema.js";
import { maskText, maskSecrets } from "./secret-mask.js";
import { exactMatchValue } from "../entities/exact-allow.js";
import { limitDefault } from "../entities/limits.js";
import { applyResultPolicy } from "../entities/tool-eviction.js";
import { unlistedOf } from "../entities/subagents.js";
import { sanitizeJournalErrorMessage } from "../entities/journal.js";
import { classifyCommand, commandSegmentVerdicts, commandAllowCovers, type ShellClass } from "../entities/guardian.js";
import {
  laneLimited,
  laneTarget,
  laneGuidance,
  DIRECT_WRITE_TOOLS,
  type LaneCounter,
} from "../entities/chat-lane.js";
import { estimateTokens } from "../entities/context/budget.js";
import {
  readLaneApplies,
  DIRECT_READ_TOOLS,
  type ReadLaneCounter,
} from "../entities/read-lane.js";
import { type BaseMessage } from "@langchain/core/messages";
import type { LoopHealth } from "../entities/loop-health.js";
import { toolCounts } from "./tool-counts.js";
import { coerceStringArrays, validateToolArgs } from "../entities/tool-args.js";

/** Resolve a path's real location (symlinks followed) for the `rm -rf`
 * within-workdir symlink guard (§D1.4). Throws on a non-existent path so
 * `rm-workdir` shrinks to the existing prefix; never consults `process.cwd()`. */
function realpathNative(p: string): string {
  return realpathSync.native(p);
}

/**
 * The denied command or path for a PERMISSION_DENIED event (§9.5, §14.6 `target`).
 * For a shell tool (`execute_command`/`wait`) it is the `command`; for a file
 * tool it is the `path`. MASKED through the one shared secret masker (§9.6/§10.10)
 * so a secret in the action never lands in the log; bounded exactly as the
 * approval prompt bounds its action text — the prompt emits the full masked
 * action (no length truncation), so `target` is likewise the full masked value.
 * Returns undefined when no single action target is known (so the field is
 * simply absent rather than null).
 */
function deniedTarget(args: Record<string, unknown>): string | undefined {
  const raw =
    typeof args["command"] === "string"
      ? args["command"]
      : typeof args["path"] === "string"
        ? args["path"]
        : undefined;
  return raw === undefined ? undefined : maskText(raw);
}

/**
 * The caller context a decision point runs under (§9.1). The orchestrator runs
 * with just a `sessionId`; a dispatched worker adds its `workerId`, the
 * fan-out's `fanoutId` (for the grant), and the resolved `approvalMode` so an
 * `ask` maps to the right §9.5 outcome. The scope on every event carries both
 * `session` and (for a worker) `worker`.
 */
export interface CallerContext {
  sessionId: string;
  workerId?: string;
  fanoutId?: string;
  approvalMode: "interactive" | "policy_only" | "out_of_band" | "headless";
}

/** How an `ask` resolves (§9.5). The gate hands the resolver the call, the
 * inferred patterns, whether it is a force-ask, and the caller context. */
export interface AskRequest {
  call: { tool: string; args: Record<string, unknown> };
  forceAsk: boolean;
  /** The force-ask family, when `forceAsk` (§9.5): `auto_approve` auto-approves
   * `"shell"` and a plain ask, never `"ssrf"` or `"plugin-install"`. */
  forceAskKind: "shell" | "ssrf" | "plugin-install" | "control-file" | "outside-workspace" | undefined;
  inferredPatterns: string[] | undefined;
  /** The per-segment ask/ok verdicts of a COMPOUND shell command (§6.1, §9.3),
   * computed ONCE at the gate from the shared splitter + classification and the
   * live allow rules. Display-only metadata a host shows to point at the asking
   * piece; the gate decided over the whole command. Absent for a single-segment
   * command or a non-shell tool. */
  segments?: import("../entities/guardian.js").SegmentVerdict[];
  ctx: CallerContext;
}

/** The resolver's answer. `allow` runs the call; `reject` denies it (the model
 * sees a rejection); `edit` runs it with the edited args. */
export interface AskResolution {
  decision: "allow" | "reject" | "edit";
  editedArgs?: Record<string, unknown>;
}

/** Resolve an `ask` for the caller (engine `interrupt` or §9.5 worker path). */
export type AskResolver = (req: AskRequest) => Promise<AskResolution>;

/** owner D2a — a force-ask is rememberable-as-exact only when its literal value
 * is at most this long; a longer command/host/package value is not offered as a
 * saved rule (a huge saved pattern is unwieldy and unlikely to match again). The
 * default is the `permissions.exactRememberMaxChars` registry limit (§13.11, a
 * SAFETY limit a project may only LOWER); a use-case passes the effective value
 * from the injected `LimitsPort`. */
export function exactRememberMaxCharsDefault(): number {
  return limitDefault("permissions.exactRememberMaxChars");
}

/** The force-ask presentation fields a PendingApproval carries (§9.5, owner
 * D2a): whether the ask may be remembered, whether only as an exact rule, and
 * the inferred patterns (the single exact value when `exactOnly`). ONE builder
 * so the engine `interrupt` and the §9.5 worker path produce identical fields —
 * no second copy (§15.1#4, §1 rule 10). PURE. */
export interface ForceAskFields {
  rememberable: boolean;
  exactOnly: boolean;
  inferredPatterns: string[] | undefined;
}

/** Compute the §9.5/owner-D2a remember fields for an ask. A plain ask is a
 * rememberable glob; a force-ask is rememberable ONLY as an exact rule, and only
 * when its literal value is unmasked (no secret) and ≤ `exactRememberMaxChars`
 * (the DP1 safety limit, default from the registry); otherwise it is NOT
 * rememberable. PURE — no I/O, no events. */
export function computeForceAskFields(
  req: AskRequest,
  exactRememberMaxChars: number = exactRememberMaxCharsDefault(),
): ForceAskFields {
  let rememberable = !req.forceAsk;
  let exactOnly = false;
  let inferredPatterns = req.inferredPatterns;
  if (req.forceAsk) {
    const exactValue = exactMatchValue(req.call.tool, req.call.args);
    if (exactValue !== null) {
      const masked = maskText(exactValue);
      if (masked === exactValue && exactValue.length <= exactRememberMaxChars) {
        rememberable = true;
        exactOnly = true;
        inferredPatterns = [exactValue];
      }
    }
  }
  return { rememberable, exactOnly, inferredPatterns };
}

/** The scope on an event — session always, worker when a worker made the call. */
function scopeOf(ctx: CallerContext): { session: string; worker?: string } {
  return ctx.workerId ? { session: ctx.sessionId, worker: ctx.workerId } : { session: ctx.sessionId };
}

/**
 * The deps the one decision point reads (§9.1). The same set serves the engine
 * and a worker; the engine passes its session's live state, a worker passes its
 * own fresh read/stale state and the PARENT session for the §8.3 cache (§7).
 */
export interface DecisionPointDeps {
  guardian: Guardian;
  warden: Warden;
  bus: EventBus;
  registry: ToolRegistry;
  getConfig: () => Config;
  /** §13.11 — the limits port, for registry-backed eviction sizing (CTX12 per
   * excerpt-line cap). Absent → the registry default (byte-identical). */
  limits?: import("../entities/ports/limits-port.js").LimitsPort;
  /** The managed-layer gate (§13.5); null when gated actions are enabled. */
  managedGate?: () => { reason: string } | null;
  /** The §8.2 temp-dir prefix the write guardrail blocks. */
  tempDir: string;
  /** The workspace root, so the protected-control-file guardrail normalizes an
   * absolute path before comparing it (§8.4). */
  workspaceRoot?: string;
  /** The global config dir (`voidriftConfigDir()`) and the home dir, so the
   * control-file classification (§8.4, §9.4) resolves `~`/`$HOME`/`$XDG_CONFIG_HOME`
   * and the global config dir's protected files/dirs. Absent → the project-only
   * control-file classification applies. */
  globalConfigDir?: string;
  home?: string;
  /** The resolved endpoint window, for §8.3 eviction sizing. */
  window: number;
  /** §8.3/§8.7/§4.8 — the LIVE available token budget (`window − used − output
   * reservation`, `ContextPipeline.availableBudget`) the eviction fit test runs
   * against (`limits.ingest.fitFraction` of this). Absent → falls back to the
   * static `window` (tests, standalone use). */
  availableTokens?: () => number;
  /** The live session-scoped rules merged with config permissions (§9.1). */
  getSessionRules: () => PermissionRule[];
  /** The guardrail state (read/stale paths) for the unread/stale guardrail. */
  guardrailState: () => { readPaths: Set<string>; stalePaths: Set<string> };
  /** Record a read/write mark for the unread/stale guardrail (§9.1 step 8). */
  markRead?: (path: string) => void;
  /** Persist the FULL masked evicted result under the (parent) session cache
   * (§8.3); absent disables eviction. The sessionId is the cache owner. */
  writeEvictedResult?: (sessionId: string, name: string, content: string) => Promise<void>;
  /** The §8.3 cache owner session id (the PARENT for a worker, §7). Defaults to
   * the caller's sessionId. */
  evictionOwnerSessionId?: (ctx: CallerContext) => string;
  /**
   * The session's active top-level agent (§2.7), resolved LIVE on every call so
   * a `session.setMode` takes effect on the next tool call and a worker/routine
   * reads the current active agent (§9.7). This is the ONE place the agent's
   * `unlisted` posture is enforced (§9.1 step 5): `deny` denies every non-read,
   * non-safe action outright with read-only guidance (the old `research`
   * posture); `allow` is the auto-approve posture (the old `vibe`); `ask` is the
   * normal path (the old `chat`). Omitted → an `ask` posture. A worker resolves
   * the PARENT session's active agent and can never loosen it.
   */
  getActiveAgent?: () => import("../entities/subagents.js").AgentDefinition | undefined;
  /**
   * The chat direct-write lane counter for this caller (§3.1). Present only for
   * the ORCHESTRATOR (the engine wires it); absent for a worker — a worker's
   * writes never count against the orchestrator and the lane never applies to a
   * worker. When present AND the active top-level agent is `laneLimited`, a
   * direct write call is checked against the per-turn limits BEFORE any approval
   * prompt; a crossed limit blocks the next direct write with delegate guidance
   * (`cause: 'lane_limit'`), never a permission denial. Read-class calls and the
   * `task` tool are never blocked. The engine resets the counter at the start of
   * each turn and on `setMode`.
   */
  laneCounter?: () => LaneCounter;
  /**
   * The read-lane counter for this caller (§3.3). Present only for the
   * ORCHESTRATOR (the engine wires it); absent for a worker — the read lane
   * never applies to a worker. When present AND the active top-level agent
   * `readLaneApplies` (holds direct read tools AND can delegate), the harness
   * counts direct read-class calls this turn and appends ONE harness note to the
   * NEXT tool result once a threshold is crossed (8 reads, or tool results past
   * 25% of the window). It blocks nothing and changes no permission.
   */
  readLaneCounter?: () => ReadLaneCounter;
  /**
   * The tool-round limit-wrap note source (§3.3). Present only for the
   * ORCHESTRATOR. Returns the queued 80%-of-budget note (once) so the decision
   * point appends it to the NEXT tool result; null when none is pending. It
   * blocks nothing and changes no permission.
   */
  roundNote?: () => string | null;
  /**
   * The mutation journal recorder (§10.11). Present when a journal is wired
   * (the engine/subagents pass it); absent disables journaling (unit tests that
   * do not exercise it). When present, EVERY write action — `write_file`,
   * `edit_file`, `researcher_save_notes`, a non-safe `execute_command`, a
   * merge/apply, and every MCP/plugin tool — appends ONE entry at the moment it
   * executes. Reads never journal. See `recordJournal` below for the FAIL-CLOSED
   * ordering.
   */
  journal?: import("./journal-recorder.js").JournalRecorder;
  /** The current turn number for a journal entry (§10.11); defaults to 0. */
  getTurn?: () => number;
  /** §10.11/§9.5.1 — the active plan-scope id a journaled write stamps as its
   * `planStep` (recorded metadata ONLY — it never influences a permission,
   * scope, approval, or loop decision, invariant 27), so the surprise seam can
   * bind a scope's prediction to the writes it drove. Undefined → no grant is
   * live and the entry carries no `planStep`. */
  getActiveScopeId?: () => string | undefined;
  /** Read the RAW before-state bytes of a file target right before a write
   * executes (§10.11), or null when the target does not exist. Present with
   * `journal`; the engine/worker supplies a reader rooted at its own tree. */
  readTargetBytes?: (relPath: string) => Promise<Buffer | null>;
  /**
   * The rollback capture hook (§10.12). Present when a snapshot store is wired
   * (the engine passes it for the ORCHESTRATOR only — a worker's writes happen
   * in a worktree and are NOT snapshotted; a merge into the main tree is the
   * move). On the FIRST write of a turn the engine's `beginTurn` has already
   * run; the decision point only NOTES each write (the cache method attributes
   * paths; the git method ignores it). A snapshot failure NEVER blocks the
   * user's write.
   */
  rollback?: {
    noteWrite: (input: import("../entities/ports/snapshot-store.js").NoteWriteInput) => Promise<void>;
    beginTurn: (sessionId: string, turn: number) => Promise<void>;
    sessionId: string;
  };
  /**
   * The per-caller loop-health counter (§3.4). Present for the orchestrator and
   * each worker (the engine/subagents build one per caller); absent disables
   * loop-health detection (unit tests that do not exercise it). The decision
   * point calls `observe` AFTER every gated call executes and, on a detection,
   * appends the corrective nudge to the model-facing tool result and emits
   * `WARNING_EMITTED { category: "loop", source }`. Counters reset per turn (the
   * engine's `reset`), so a worker never trips on the orchestrator's history.
   */
  loopHealth?: () => LoopHealth;
}

function shellLists(config: Config): ShellLists {
  return {
    safe: config.shellSafeCommands,
    forceAsk: config.shellForceAskPatterns,
    equivalents: config.shellEquivalents,
    deny: config.shellDenyPatterns,
  };
}

/**
 * The single ruleset the one decision point evaluates (§9.1): config permission
 * rules plus the live session-scoped rules. Shared so a session-scoped rule
 * binds the orchestrator AND every worker (§15.1#4).
 */
export function resolveRules(config: Config, sessionRules: PermissionRule[]): PermissionRule[] {
  return [...Object.values(config.permissions), ...sessionRules];
}

/** The §8.2 tools emit canonical arg fields the decision point reads directly. */
function toGuardedArgs(args: Record<string, unknown>): Record<string, unknown> {
  return { ...args };
}

/**
 * Whether a call is a DIRECT WRITE the chat lane counts (§3.1 item i): a
 * `write_file`/`edit_file`, or an `execute_command` whose command is NOT
 * classified safe/equivalent-read by the Guardian's shell lists. The shell class
 * is the SAME `classifyCommand` the Guardian uses, computed ONCE here at the
 * decision point and reused — never re-parsed elsewhere. A safe/has-equivalent
 * command (e.g. `git status`) is a read and never counts.
 */
/**
 * Whether a call is a WRITE ACTION the mutation journal records (§10.11): a
 * file write/edit, `researcher_save_notes`, a `merge_worktree`/staging apply,
 * EVERY MCP or plugin tool (treated as mutating by the harness's fixed fact),
 * or an `execute_command` whose command is NOT classified safe/equivalent-read.
 * Reads (and a safe/has-equivalent command) never journal.
 */
function isWriteAction(tool: string, shellClass: ShellClass | null, registry: ToolRegistry): boolean {
  if (tool === "write_file" || tool === "edit_file" || tool === "researcher_save_notes") return true;
  if (tool === "merge_worktree" || tool === "apply_worktree" || tool === "staging_apply") return true;
  if (tool === "execute_command") return shellClass !== "safe" && shellClass !== "has-equivalent";
  const origin = registry.get(tool)?.origin;
  if (origin === "mcp" || origin === "plugin") return true;
  return false;
}

function isDirectWrite(tool: string, shellClass: ShellClass | null): boolean {
  if (tool === "write_file" || tool === "edit_file") return true;
  if (tool === "execute_command") {
    // A safe or equivalent-read command is a read; anything else (dangerous,
    // unknown, hard-deny — though a deny never reaches the lane) is a write.
    return shellClass !== "safe" && shellClass !== "has-equivalent";
  }
  return false;
}

/** The orchestrator's own tool-result tokens in the current context (§3.1 item
 * iii), over the model's window: the sum of the estimated tokens of every
 * ToolMessage in the request's messages, divided by the window. A window of 0
 * yields 0 (no share known). */
function toolResultContextShare(messages: readonly BaseMessage[] | undefined, window: number): number {
  if (!messages || window <= 0) return 0;
  let toolTokens = 0;
  for (const m of messages) {
    if (m.getType() !== "tool") continue;
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    toolTokens += estimateTokens(text);
  }
  return toolTokens / window;
}

/**
 * Build the ONE decision-point middleware for a caller (§9.1). Identical gate
 * order for the orchestrator and every worker; the `ask` resolution is the
 * injected `AskResolver`.
 */
export function createDecisionMiddleware(deps: DecisionPointDeps, ctx: CallerContext, askResolver: AskResolver) {
  const { guardian, warden, bus, getConfig, registry, managedGate } = deps;

  return createMiddleware({
    name: "voidrift-decision-point",
    wrapToolCall: async (request, handler) => {
      const name = request.toolCall.name;
      const rawArgs = (request.toolCall.args ?? {}) as Record<string, unknown>;
      const args = toGuardedArgs(rawArgs);
      const def = registry.get(name);
      // §8.4 — an MCP tool is never invisible to the managed gate, Warden,
      // masking, events, or the record. A tool's read-class is an INTERNAL FACT
      // (isolation, worker binding, display) and NEVER a permission input (§9):
      // every call — read built-in, write, MCP, plugin — passes the SAME gate,
      // and the seeded allow list (§13.8) is what makes the read built-ins free.
      const config = getConfig();
      // The configured web-search endpoint (§13.9), used ONLY to classify a
      // `web_search` at the gate (never model-supplied, never forwarded to the
      // executor). Read straight from the cascaded config: a private/loopback/
      // link-local/metadata endpoint force-asks on every call (§9.3), whatever
      // layer set it. Absent for the keyless default and keyed cloud providers.
      const webSearchEndpoint =
        name === "web_search" ? (config.webSearch?.endpoint ?? "") : "";
      const toolCallId = request.toolCall.id ?? `${name}-${Date.now()}`;
      const scope = scopeOf(ctx);

      // §8.1 / §9.1 — the PIPELINE-LEVEL bracketing guarantee. TOOL_STARTED is
      // emitted ONCE here, at the very top, so EVERY call the model emits —
      // success, tool error, a denial (permission, compliance, managed layer,
      // unknown tool), or invalid arguments — is bracketed by exactly one
      // TOOL_STARTED and exactly one TOOL_FINISHED, whatever the outcome. No
      // deny/invalid path can start without finishing: every `return` below
      // flows through `finish()`, the ONE place TOOL_FINISHED is emitted. This
      // same guarantee covers the worker path, which shares this middleware
      // (§15.1#4). `args` is masked downstream by the obs-writer (§10.10).
      const start = Date.now();
      bus.emit("TOOL_STARTED", { id: toolCallId, name, args }, scope);

      /** The ONE TOOL_FINISHED emit (§8.1/§14.6): status, durationMs, and a
       * one-line `summary` (the trimmed result, an eviction handle, or the
       * one-line reason when `status: "error"`) plus honest counts from the full
       * result. Every return path routes through here so a call can never start
       * without finishing. Accepts a non-`ToolMessage` handler result (a raw
       * string) too and returns the value unchanged. */
      const finish = <T>(msg: T): T => {
        const isTm = msg instanceof ToolMessage;
        const fullText = isTm ? String(msg.content) : typeof msg === "string" ? msg : "";
        const summary = fullText.slice(0, 500);
        const status = isTm && msg.status === "error" ? "error" : "success";
        const counts = isTm ? toolCounts(name, fullText, 500) : undefined;
        bus.emit(
          "TOOL_FINISHED",
          {
            id: toolCallId,
            name,
            status,
            durationMs: Date.now() - start,
            summary,
            ...(counts ? { lines: counts.lines, truncated: counts.truncated } : {}),
            ...(counts?.entries ? { entries: counts.entries } : {}),
          },
          scope,
        );
        return msg;
      };

      const deny = (reason: string): ToolMessage =>
        finish(new ToolMessage({ content: `Error: ${reason}`, tool_call_id: toolCallId, status: "error" }));

      // §8.1 / §9.1 step 1 — unknown-tool reject: a hallucinated tool never
      // executes and never reaches the gate; the error result feeds the loop.
      // A tool that exists in the harness but is NOT bound for the active agent
      // (not on its `tools` list) also arrives here as `def === null`. Emit a
      // PERMISSION_DENIED carrying `cause: "unknown_tool"` so a host can COUNT
      // the active agent's posture refusals (the read-only-run "N action(s)
      // denied" line, cli §8.3) without parsing the summary string. It is
      // bracketed with its STARTED (above) and its FINISHED (via `finish`).
      if (def === null) {
        bus.emit("PERMISSION_DENIED", { tool: name, reason: `unknown tool: ${name}`, cause: "unknown_tool" }, scope);
        return deny(`unknown tool: ${name}`);
      }

      // §8.1 / §9.1 step 1 — central, schema-driven argument pre-processing,
      // BEFORE anything else. First "liberal in what it accepts": a single
      // string the model sent for a string-ARRAY field is comma-split into the
      // array the schema expects, driven from the tool's OWN schema (string
      // arrays only), applied to the guard copy AND the raw args the handler
      // receives; the schema the model is bound to is unchanged. Then Zod-
      // validate: a call whose arguments still fail the schema after coercion is
      // caught HERE — never escaping to LangChain's ToolNode (which would emit a
      // raw-stack ToolMessage with a STARTED but no FINISHED) — and returns the
      // `invalid arguments for <tool>: <field>: <issue>` error (field + issue
      // only, ≤~500 chars, no stack, no path), bracketed and never executed.
      {
        const coerced = coerceStringArrays(args, def.schema);
        for (const k of Object.keys(coerced)) {
          if (coerced[k] !== args[k]) {
            args[k] = coerced[k];
            rawArgs[k] = coerced[k];
          }
        }
        const validation = validateToolArgs(name, args, def.schema);
        if (!validation.ok) {
          return deny(validation.message);
        }
      }

      // §13.5 / §8.4 — the managed-layer gate fails closed for EVERY call. Read-
      // class is not a permission input (§9), so a read is gated identically to
      // a write: when the managed layer is unavailable/invalid nothing runs,
      // including an MCP tool call even when hinted read-only.
      if (managedGate) {
        const gate = managedGate();
        if (gate) {
          bus.emit("PERMISSION_DENIED", { tool: name, reason: "managed_layer_unavailable" }, scope);
          return deny(`managed_layer_unavailable: ${gate.reason}`);
        }
      }

      // §9.1 step 4 — Warden first; a deny is final and runs before Guardian.
      const w = await warden.evaluate({ tool: name, args });
      if (w.effect === "block") {
        bus.emit("COMPLIANCE_BLOCKED", { action: name, rule: w.rule, version: w.version }, scope);
        return deny(`blocked by compliance: ${w.reason ?? "policy"}`);
      }

      // The guarded call Guardian evaluates. For `web_search` the model supplies
      // only `{ query }`; the gate classifies the CONFIGURED endpoint (§13.9),
      // injected here as `webSearchEndpoint` so Guardian can apply the private-
      // host always-ask with the configured-endpoint exemption (§9.3). It is
      // NEVER taken from the model and NEVER forwarded to the executor (the tool
      // schema is `{ query }` only, §8.2) — it lives only on this guard copy.
      const guardArgs =
        name === "web_search"
          ? { ...args, ...(webSearchEndpoint ? { webSearchEndpoint } : {}) }
          : name === "wait" && typeof args["check"] === "string"
            ? // §8.2/§9.3 — `wait`'s `check` IS a shell command, classified exactly
              // like `execute_command`. The guardian and exact-allow read the
              // `command` field for a `wait` carrier (unchanged), so map
              // `check`→`command` on the GUARD copy ONLY; the tool handler still
              // receives the original `{ seconds, check, interval, timeout }`.
              { ...args, command: args["check"] }
            : args;
      const call = { tool: name, args: guardArgs };

      // §9.1 step 5/6 / §9.7 — Guardian over the SAME ruleset the engine resolves
      // (config permissions + session rules), then the active top-level agent's
      // `unlisted` posture decides what to do with an `ask`. A tool's read-class
      // is NOT a permission input (§9): EVERY call — a read built-in, a write, an
      // MCP or plugin tool — is evaluated the same way, and the seeded allow list
      // (§13.8) is what makes the read built-ins free. The active agent is
      // resolved LIVE so a `session.setMode` takes effect on the next call and a
      // worker reads the PARENT session's current agent (§2.7, §9.7).
      const activeAgent = deps.getActiveAgent?.();
      const unlisted = unlistedOf(activeAgent);

      const outcome: GuardianOutcome = guardian.evaluate(
        call,
        resolveRules(config, deps.getSessionRules()),
        shellLists(config),
        {
          // `config.unlock` is already the honored value — ConfigCapability
          // strips a project/session `unlock` before resolve (§13.10), so this
          // reflects only the global/managed layers.
          unlock: new Set(config.unlock),
          // The workdir `execute_command` runs in, plumbed cleanly (never
          // process.cwd()): the orchestrator/engine passes the workspace root; a
          // worker passes its own worktree dir via its own deps.workspaceRoot.
          ...(deps.workspaceRoot ? { workdir: deps.workspaceRoot } : {}),
          ...(deps.home ? { home: deps.home } : {}),
          realpath: realpathNative,
          // §8.4/§9.4 — the control-file classification context (the file tools
          // and write-shaped shell commands classify a control-file target
          // through the ONE `classifyControlPath`).
          controlPath: {
            ...(deps.workspaceRoot ? { workspaceRoot: deps.workspaceRoot } : {}),
            ...(deps.globalConfigDir ? { globalConfigDir: deps.globalConfigDir } : {}),
            ...(deps.home ? { home: deps.home } : {}),
          },
        },
      );
      if (outcome.decision === "deny") {
        const target = deniedTarget(args);
        bus.emit("PERMISSION_DENIED", { tool: name, reason: outcome.reason ?? "denied", ...(target !== undefined ? { target } : {}) }, scope);
        return deny(`permission denied: ${outcome.reason ?? "denied by policy"}`);
      }

      // §3.1 — the chat direct-write lane. BEFORE any approval prompt (so no
      // prompt appears and nothing executes), check whether this ORCHESTRATOR
      // call crosses a per-turn lane limit. The lane applies ONLY to the
      // orchestrator (a worker passes no `laneCounter`) of a `laneLimited`
      // top-level agent (holds a direct write tool AND can delegate). The `task`
      // dispatch is never blocked. A direct write is `write_file`/`edit_file`, or
      // an `execute_command` whose command is NOT safe/equivalent-read — the
      // shell class is the SAME `classifyCommand` the Guardian uses, computed
      // ONCE here and reused. The block is NOT a permission denial: it carries
      // `cause: 'lane_limit'`, is counted in NO "N actions denied" tally, and
      // emits ONE `LANE_LIMIT_REACHED` per turn (at the first block). The counter
      // records an executed write AFTER the call runs (below), so a Guardian-
      // denied or user-rejected call never counts.
      const laneCounter = deps.laneCounter?.();
      let laneReservation: { addedTarget: boolean } | null = null;
      let laneTargetValue: string | null = null;
      if (laneCounter && !ctx.workerId && name !== "task" && DIRECT_WRITE_TOOLS.has(name) && laneLimited(activeAgent)) {
        const shellClass: ShellClass | null =
          name === "execute_command" && typeof args["command"] === "string"
            ? classifyCommand(args["command"], shellLists(config)).cls
            : null;
        if (isDirectWrite(name, shellClass)) {
          const stateMessages = (request as { state?: { messages?: BaseMessage[] } }).state?.messages;
          const share = toolResultContextShare(stateMessages, deps.window);
          laneTargetValue = laneTarget(name, args);
          // §13.11 — the lane's three limits come from the registry; the pure
          // entity decides with the live effective values (defaults byte-identical).
          const laneLimits = deps.limits
            ? {
                writeCallsPerTurn: deps.limits.get("lane.writeCallsPerTurn"),
                distinctTargetsPerTurn: deps.limits.get("lane.distinctTargetsPerTurn"),
                toolResultContextShare: deps.limits.get("lane.writeContextShare"),
              }
            : undefined;
          const decision = laneCounter.check(share, laneTargetValue, laneLimits);
          if (decision.blocked && decision.which && decision.counts) {
            if (laneCounter.claimEventOnce()) {
              bus.emit("LANE_LIMIT_REACHED", { which: decision.which, counts: decision.counts }, scope);
            }
            // §13.11 — also record the LIMIT_HIT naming the registry key that bit,
            // so the key is discoverable (the guidance text itself is unchanged).
            if (deps.limits) {
              const hitKey =
                decision.which === "writeCalls"
                  ? "lane.writeCallsPerTurn"
                  : decision.which === "distinctTargets"
                    ? "lane.distinctTargetsPerTurn"
                    : "lane.writeContextShare";
              deps.limits.hit(hitKey, undefined, { session: ctx.sessionId, what: "direct-write lane limit reached" });
            }
            // The guidance tool result the model sees; marked `lane_limit` so a
            // host never tallies it as a permission denial. Nothing executed.
            return finish(new ToolMessage({
              content: laneGuidance(decision.which, decision.counts),
              tool_call_id: toolCallId,
              status: "error",
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              additional_kwargs: { cause: "lane_limit" } as any,
            }));
          }
          // Not blocked — RESERVE the slot now (atomic under concurrent tool
          // calls in one message). Rolled back below if a user reject or a
          // guardrail denial means the call does not actually execute (§3.1#5).
          laneReservation = laneCounter.reserve(laneTargetValue);
        }
      }
      /** Roll back a lane reservation for a call that did NOT execute. */
      const releaseLane = (): void => {
        if (laneCounter && laneReservation) {
          laneCounter.release(laneTargetValue, laneReservation);
          laneReservation = null;
        }
      };
      // owner D2c — an EXACT allow rule lifted a force-ask: no prompt appears, so
      // emit WHY through the permission channel (rule id + tool only, no secret
      // value) for `/access` and the user. The call then proceeds as allowed.
      if (outcome.decision === "allow" && outcome.exactLift) {
        bus.emit(
          "PERMISSION_RESOLVED",
          {
            requestId: `exact-lift-${toolCallId}`,
            decision: "approve",
            resolver: "exact_rule",
            tool: name,
            reason: outcome.reason ?? `allowed by exact rule ${outcome.exactRuleId ?? ""}`,
            ...(outcome.exactRuleId ? { ruleId: outcome.exactRuleId } : {}),
          },
          scope,
        );
      }
      if (outcome.decision === "ask") {
        // A matching allow rule returned `allow` above; reaching here means NO
        // allow rule covered the call, so the active agent's posture decides:
        //  - `deny`  → DENY OUTRIGHT, never prompt (the old `research` posture):
        //              a call not on the allow list cannot run under a read-only
        //              agent, reads included (a seeded read rule makes a read
        //              `allow` above and never reaches here).
        //  - `allow` → the auto-approve posture (the old `vibe`): a plain ask and
        //              a `"shell"` force-ask auto-approve; an SSRF range and a
        //              trust-expanding `plugin-install` still require an answer.
        //  - `ask`   → the normal path: suspend to the resolver.
        if (unlisted === "deny") {
          // A write-class call under a read-only agent is told to switch agents;
          // a NON-write tool (a read not on the allow list) gets the accurate
          // allow-list guidance instead — it was never about write posture.
          const denyShellClass: ShellClass | null =
            name === "execute_command" && typeof args["command"] === "string"
              ? classifyCommand(args["command"], shellLists(config)).cls
              : null;
          const DENY_GUIDANCE = isWriteAction(name, denyShellClass, registry)
            ? "this agent is read-only — switch to a top-level agent that allows changes to make changes"
            : `"${name}" is not on the allow list; add an allow rule or use an agent that allows it`;
          bus.emit("PERMISSION_DENIED", { tool: name, reason: DENY_GUIDANCE, cause: "read_only_posture", ...(deniedTarget(args) !== undefined ? { target: deniedTarget(args) } : {}) }, scope);
          return deny(DENY_GUIDANCE);
        }
        const autoApprovable =
          unlisted === "allow" &&
          outcome.forceAskKind !== "ssrf" &&
          outcome.forceAskKind !== "plugin-install" &&
          outcome.forceAskKind !== "control-file";
        if (autoApprovable) {
          const requestId = `auto-approve-${toolCallId}`;
          bus.emit(
            "PERMISSION_REQUESTED",
            { tool: name, args: maskSecrets(args), requestId, inferredPatterns: (outcome.inferredPatterns ?? []).map(maskText) },
            scope,
          );
          bus.emit(
            "PERMISSION_RESOLVED",
            { requestId, decision: "approve", resolver: "auto_approve" },
            scope,
          );
        } else {
          // §6.1 — the per-segment ask/ok verdicts for a COMPOUND shell
          // command, computed ONCE here from the shared splitter + classifier
          // and the live allow rules (display-only; the gate decided over the
          // whole command above). Absent for a single-segment command or a
          // non-shell tool.
          const segments =
            name === "execute_command" && typeof args["command"] === "string"
              ? commandSegmentVerdicts(args["command"], shellLists(config), (seg) =>
                  commandAllowCovers(seg, resolveRules(config, deps.getSessionRules())),
                )
              : [];
          const resolved = await askResolver({
            call,
            forceAsk: outcome.forceAsk,
            forceAskKind: outcome.forceAskKind,
            inferredPatterns: outcome.inferredPatterns,
            ...(segments.length > 0 ? { segments } : {}),
            ctx,
          });
          if (resolved.decision === "reject") {
            releaseLane(); // the write will not execute — do not count it (§3.1#5)
            bus.emit("PERMISSION_DENIED", { tool: name, reason: "rejected" }, scope);
            return deny("permission rejected by user");
          }
          if (resolved.decision === "edit" && resolved.editedArgs) {
            Object.assign(args, resolved.editedArgs);
            Object.assign(rawArgs, resolved.editedArgs);
          }
        }
      }

      // §9.1 step 7 — guardrails run for every call after the decision allows.
      const state = deps.guardrailState();
      const gctx: GuardrailContext = {
        readPaths: state.readPaths,
        stalePaths: state.stalePaths,
        tempDir: deps.tempDir,
        ...(deps.workspaceRoot ? { workspaceRoot: deps.workspaceRoot } : {}),
      };
      const gr = guardian.runGuardrails(call, gctx);
      if (!gr.allowed) {
        releaseLane(); // the write will not execute — do not count it (§3.1#5)
        bus.emit("PERMISSION_DENIED", { tool: name, reason: gr.reason }, scope);
        return deny(gr.reason ?? "blocked by guardrail");
      }

      // §9.1 step 9 / §10.11 — the mutation journal. Determine whether this call
      // is a WRITE ACTION (one entry each, recorded at the moment it executes):
      // a file write/edit, `researcher_save_notes`, a NON-SAFE `execute_command`
      // (the Guardian shell class, computed once here), a merge/apply, or EVERY
      // MCP/plugin tool (treated as mutating). Reads never journal.
      //
      // FAIL-CLOSED ORDERING (§10.11). ONE entry per action: capture the before-
      // state of a file target BEFORE execute; a capture failure fails the write
      // closed (nothing runs). Execute. In the `finally`, append the single entry
      // (with the result). If the APPEND fails after the write already happened,
      // the tool result is replaced with a loud error naming the target so the
      // user knows the journal is incomplete.
      let journalPlan: {
        before?: Buffer;
        beforeMissing?: boolean;
        isFileTool: boolean;
      } | null = null;
      if (deps.journal) {
        const journalShellClass: ShellClass | null =
          name === "execute_command" && typeof args["command"] === "string"
            ? classifyCommand(args["command"], shellLists(config)).cls
            : null;
        if (isWriteAction(name, journalShellClass, registry)) {
          const isFileTool =
            name === "write_file" || name === "edit_file" || name === "researcher_save_notes";
          journalPlan = { isFileTool };
          if (isFileTool && deps.readTargetBytes && typeof args["path"] === "string") {
            try {
              const before = await deps.readTargetBytes(args["path"]);
              if (before === null) journalPlan.beforeMissing = true;
              else journalPlan.before = before;
            } catch (e) {
              // Pre-capture failed → fail the write closed; nothing executes.
              releaseLane();
              bus.emit("PERMISSION_DENIED", { tool: name, reason: "mutation_journal_unavailable" }, scope);
              return deny(`mutation journal unavailable: ${sanitizeJournalErrorMessage(e, deps.workspaceRoot)}`);
            }
          }
        }
      }

      // §10.12 — rollback capture. For the ORCHESTRATOR (a worker's writes are
      // worktree-local and NOT snapshotted), note each write so the cache method
      // can attribute paths; the git method captures the whole tree regardless.
      // beginTurn is idempotent (the first write opens the turn's before-snapshot
      // — the engine also opens it, but a defensive open here covers a direct
      // write path). A snapshot failure NEVER blocks the user's write.
      if (deps.rollback && !ctx.workerId) {
        const rbShellClass: ShellClass | null =
          name === "execute_command" && typeof args["command"] === "string"
            ? classifyCommand(args["command"], shellLists(config)).cls
            : null;
        if (isWriteAction(name, rbShellClass, registry)) {
          try {
            await deps.rollback.beginTurn(deps.rollback.sessionId, deps.getTurn?.() ?? 0);
            const isFileTool =
              name === "write_file" || name === "edit_file" || name === "researcher_save_notes";
            if (isFileTool && typeof args["path"] === "string") {
              await deps.rollback.noteWrite({
                sessionId: deps.rollback.sessionId,
                target: args["path"],
                beforeBytes: journalPlan?.beforeMissing
                  ? null
                  : (journalPlan?.before ??
                    (deps.readTargetBytes ? await deps.readTargetBytes(args["path"]).catch(() => null) : null)),
              });
            } else if (name === "execute_command" && typeof args["command"] === "string") {
              // A non-safe shell command whose file targets are not statically
              // attributed is a not-undoable shell effect in the cache method
              // (the git method still captures the whole tree).
              await deps.rollback.noteWrite({
                sessionId: deps.rollback.sessionId,
                target: args["command"],
                shellUnattributable: true,
                shellCommand: args["command"],
              });
            }
          } catch {
            /* a snapshot note failure never blocks the user's write */
          }
        }
      }

      // §9.1 step 8 — execute (bracketed by the TOOL_STARTED emitted at the top
      // of the pipeline and the single TOOL_FINISHED emitted via `finish`).
      const result = await handler(request);

      // §10.11 — append the single journal entry (FAIL-CLOSED). A denied/rejected
      // call never reaches here, so a denied call produces NO entry. The entry is
      // RAW (never masked) — the obs trail records only that one was appended.
      let journalError: string | null = null;
      if (deps.journal && journalPlan) {
        const rs = result instanceof ToolMessage && result.status === "error" ? "error" : "ok";
        const target =
          typeof args["path"] === "string"
            ? args["path"]
            : typeof args["command"] === "string"
              ? args["command"]
              : name;
        let after: Buffer | undefined;
        let afterUnavailable = false;
        if (journalPlan.isFileTool) {
          if (name === "write_file" && typeof args["content"] === "string") {
            after = Buffer.from(args["content"], "utf8");
          } else if (name === "researcher_save_notes" && typeof args["content"] === "string") {
            after = Buffer.from(args["content"], "utf8");
          } else if (name === "edit_file" && deps.readTargetBytes && typeof args["path"] === "string") {
            // The after-state of an edit is the post-write file content. A failed
            // read is NOT silently dropped (§10.11): mark `afterUnavailable` so
            // the entry notes it and surface the existing WARNING.
            try {
              after = (await deps.readTargetBytes(args["path"])) ?? undefined;
            } catch (e) {
              afterUnavailable = true;
              bus.emit(
                "WARNING_EMITTED",
                {
                  category: "journal",
                  source: "after-read",
                  pattern: `after-state unavailable for ${target}: ${sanitizeJournalErrorMessage(e, deps.workspaceRoot)}`,
                },
                scope,
              );
            }
          }
        }
        try {
          await deps.journal.record({
            sessionId: ctx.sessionId,
            ...(ctx.workerId ? { workerId: ctx.workerId } : {}),
            turn: deps.getTurn?.() ?? 0,
            // §10.11/§9.5.1 — stamp the ACTIVE plan-scope id (unqualified) so the
            // surprise seam binds this write to the scope that drove it. Recorded
            // metadata only; it influences no decision (invariant 27).
            ...(deps.getActiveScopeId?.() ? { planStep: deps.getActiveScopeId()! } : {}),
            tool: name,
            args,
            target,
            result: { status: rs, summary: result instanceof ToolMessage ? String(result.content).slice(0, 200) : "" },
            ...(journalPlan.before !== undefined ? { before: journalPlan.before } : {}),
            ...(journalPlan.beforeMissing ? { beforeMissing: true } : {}),
            ...(after !== undefined ? { after } : {}),
            ...(afterUnavailable ? { afterUnavailable: true } : {}),
          });
        } catch (e) {
          // §10.11 / LOW-2 — a fixed sentence + the sanitized error message (the
          // in-workspace target is named; any out-of-workspace absolute path is
          // replaced with `<path>` and the message is capped at 200 chars) so a
          // raw `String(e)` never echoes a sensitive path into model context.
          journalError = `mutation journal incomplete for target ${target}: ${sanitizeJournalErrorMessage(e, deps.workspaceRoot)}`;
          bus.emit("WARNING_EMITTED", { category: "journal", source: "append", pattern: journalError }, scope);
        }
      }
      if (journalError) {
        return finish(new ToolMessage({ content: `Error: ${journalError}`, tool_call_id: toolCallId, status: "error" }));
      }

      // §9.1 step 8 — record read/write marks for the unread/stale guardrail.
      if (typeof args["path"] === "string" && (name === "read_file" || name === "write_file" || name === "edit_file")) {
        deps.markRead?.(args["path"]);
      }

      // §8.3 — large-result eviction (ONE rule for every tool, AFTER execute).
      const ownerSessionId = deps.evictionOwnerSessionId?.(ctx) ?? ctx.sessionId;
      const evicted = await maybeEvict(deps, ownerSessionId, config, toolCallId, result, scope);
      let final = evicted ?? result;

      // §3.4 — loop-health detection over the executed-call stream. Observe this
      // call (tool name + canonicalized args, plus whether it errored) on the
      // per-caller counter; on a detection append the corrective nudge to the
      // model-facing result and surface it as an event. An exempt tool (`wait`)
      // never trips (§3.4). Reads are observed too — a stuck read-only loop (e.g.
      // the same failing `read_file` over and over) is just as much a loop; the
      // `wait` polling exemption is the one the spec carves out. The nudge is
      // injected as extra text on the tool result the model reads next, "rather
      // than letting the loop run to its ceiling".
      const loopHealth = deps.loopHealth?.();
      if (loopHealth) {
        const wasError = final instanceof ToolMessage && final.status === "error";
        const detection = loopHealth.observe(name, args, wasError);
        if (detection) {
          deps.bus.emit(
            "WARNING_EMITTED",
            { category: "loop", source: detection.detector },
            scope,
          );
          if (final instanceof ToolMessage) {
            const base = typeof final.content === "string" ? final.content : String(final.content);
            final = new ToolMessage({
              content: `${base}\n\n[harness note] ${detection.nudge}`,
              tool_call_id: final.tool_call_id,
              status: final.status === "error" ? "error" : "success",
              // Preserve the tool name (§8.3/§14.6): rebuilding without it emptied
              // the engine's `toolsUsed` entry for a nudged call.
              ...(final.name ? { name: final.name } : name ? { name } : {}),
              ...(final.artifact ? { artifact: final.artifact } : {}),
            });
          }
        }
      }

      // §3.3 — the read lane. For the ORCHESTRATOR of a top-level agent that
      // `readLaneApplies` (holds direct read tools AND can delegate), nudge
      // toward fan-out when it reads heavily on its own. The note appends to the
      // NEXT tool result once per turn, so a threshold already crossed by PRIOR
      // calls is appended HERE (before this call is recorded), and a threshold
      // this call itself crosses appends on the following result. It blocks
      // nothing, changes no permission, and never applies to a worker (which
      // passes no `readLaneCounter`), `research`, or `vibe` (no direct reads).
      const readLane = deps.readLaneCounter?.();
      if (readLane && !ctx.workerId && readLaneApplies(activeAgent)) {
        const stateMessages = (request as { state?: { messages?: BaseMessage[] } }).state?.messages;
        const share = toolResultContextShare(stateMessages, deps.window);
        // §13.11 — the read-lane thresholds come from the registry (defaults
        // byte-identical). The pure entity decides with the live effective set.
        const readLimits = deps.limits
          ? {
              readCallsPerTurn: deps.limits.get("lane.readCallsPerTurn"),
              toolResultContextShare: deps.limits.get("lane.readContextShare"),
            }
          : undefined;
        const note = readLane.noteFor(share, readLimits);
        if (note && final instanceof ToolMessage) {
          const base = typeof final.content === "string" ? final.content : String(final.content);
          final = new ToolMessage({
            content: `${base}\n\n[harness note] ${note}`,
            tool_call_id: final.tool_call_id,
            status: final.status === "error" ? "error" : "success",
            ...(final.name ? { name: final.name } : name ? { name } : {}),
            ...(final.artifact ? { artifact: final.artifact } : {}),
          });
          // §3.3/§13.11 — the read lane reaches the user as ONE line. Compute
          // the registry key that bit and its effective value FIRST, fold both
          // facts into the single WARNING_EMITTED `message`, and keep exactly one
          // LIMIT_HIT (the trail/audit record). The CLI suppresses the read-lane
          // LIMIT_HIT's own `ℹ` line so the user is not told twice (session-review
          // product finding 2); the LIMIT_HIT record itself is unchanged.
          let laneFact = "";
          if (deps.limits) {
            const readCap = deps.limits.get("lane.readCallsPerTurn");
            const hitKey = readLane.count >= readCap ? "lane.readCallsPerTurn" : "lane.readContextShare";
            const hitValue = deps.limits.get(hitKey);
            laneFact = ` (limits.${hitKey} = ${hitValue}; raise it in config)`;
          }
          deps.bus.emit(
            "WARNING_EMITTED",
            {
              category: "read-lane",
              source: "reads",
              // §14.6 — carry a human `message` so the CLI renders a dim `ℹ`
              // info line, never a bare category. ONE sentence carrying BOTH the
              // delegate nudge and the registry key/value to raise, no secrets.
              message: `Heavy direct reading this turn — consider delegating exploration to a worker batch (task).${laneFact}`,
            },
            scope,
          );
          // §13.11 — record the LIMIT_HIT naming the registry key that bit (the
          // trail record stays, exactly one). The read-count threshold takes
          // precedence when both are at/over; else the context-share key.
          if (deps.limits) {
            const readCap = deps.limits.get("lane.readCallsPerTurn");
            const hitKey = readLane.count >= readCap ? "lane.readCallsPerTurn" : "lane.readContextShare";
            deps.limits.hit(hitKey, undefined, { session: ctx.sessionId, what: "read-lane nudge" });
          }
        }
        // Record THIS direct read-class call AFTER the pending-note check, so the
        // 8th read crosses the threshold and the note lands on the 9th result.
        if (DIRECT_READ_TOOLS.has(name)) readLane.recordRead();
      }

      // §3.3 — the limit wrap-up 80% note. For the ORCHESTRATOR only, append the
      // queued "tool budget nearly used" note (once per turn) to the next tool
      // result so the model is nudged to answer or delegate before the ceiling.
      if (!ctx.workerId && deps.roundNote) {
        const rn = deps.roundNote();
        if (rn && final instanceof ToolMessage) {
          const base = typeof final.content === "string" ? final.content : String(final.content);
          final = new ToolMessage({
            content: `${base}\n\n[harness note] ${rn}`,
            tool_call_id: final.tool_call_id,
            status: final.status === "error" ? "error" : "success",
            ...(final.name ? { name: final.name } : name ? { name } : {}),
            ...(final.artifact ? { artifact: final.artifact } : {}),
          });
        }
      }

      // §8.1/§9.1 — the single TOOL_FINISHED for the executed call (summary and
      // honest counts computed inside `finish` from the full result).
      return finish(final);
    },
  });
}

/**
 * §8.3 large-result eviction (the shared body). Returns a handle `ToolMessage`
 * when the result exceeds the window-derived threshold, else null. The FULL
 * masked body is written to the owner session's cache (the PARENT for a worker,
 * §7); the model receives only the bounded handle.
 */
async function maybeEvict(
  deps: DecisionPointDeps,
  ownerSessionId: string,
  config: Config,
  toolCallId: string,
  result: unknown,
  scope: { session: string; worker?: string },
): Promise<ToolMessage | null> {
  const writeEvicted = deps.writeEvictedResult;
  if (!writeEvicted) return null;
  let text: string | null = null;
  let toolCallIdForMsg = toolCallId;
  if (typeof result === "string") text = result;
  else if (result instanceof ToolMessage && typeof result.content === "string") {
    text = result.content;
    toolCallIdForMsg = result.tool_call_id || toolCallId;
    if (result.artifact && (result.artifact as { path?: unknown }).path) return null;
  }
  if (text === null) return null;

  // §8.3 — the ONE gate. Every string-shaped tool result on every path (direct,
  // worker, MCP, plugin, shell, web, read_file) routes through this one helper,
  // so no path has a private cap and none bypasses.
  const e = applyResultPolicy(text, {
    sessionId: ownerSessionId,
    availableBudget: deps.availableTokens ? deps.availableTokens() : deps.window,
    fitFraction: deps.limits ? deps.limits.get("ingest.fitFraction") : limitDefault("ingest.fitFraction"),
    headLines: config.toolsTrimHeadLines,
    tailLines: config.toolsTrimTailLines,
    mask: maskText,
  });
  if (!e) return null;
  await writeEvicted(ownerSessionId, e.name, e.maskedBody);
  deps.bus.emit(
    "TOOL_RESULT_EVICTED",
    { tool: toolCallIdForMsg, path: e.artifact.path, size: e.artifact.size, excerpt: e.handle },
    scope,
  );
  const status = result instanceof ToolMessage && result.status === "error" ? "error" : "success";
  // §8.3/§14.6 — preserve the ToolMessage `name`. The engine builds `toolsUsed`
  // (and the observability span / sequence detector read the span name) from
  // `ToolMessage.name`; rebuilding the handle without it produced an EMPTY name
  // for any tool whose result was large enough to evict (e.g. `search_contents`).
  const evictedName = result instanceof ToolMessage ? result.name : undefined;
  return new ToolMessage({
    content: e.handle,
    tool_call_id: toolCallIdForMsg,
    artifact: e.artifact,
    status,
    ...(evictedName ? { name: evictedName } : {}),
  });
}
