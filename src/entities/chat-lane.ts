/**
 * The chat direct-write lane (core-blueprint.md §3.1).
 *
 * "The chat direct-write lane is bounded by the harness, not judged by the
 * model." Prompting alone cannot enforce a complexity judgment — some models
 * never fan out, others over-spawn — so the lane is held to mechanical limits
 * the harness measures each turn: the number of direct write calls this turn,
 * the number of distinct files/targets touched directly, and the share of the
 * orchestrator's own context consumed by its tool results. When any limit is
 * crossed the harness BLOCKS the next direct write at the single decision point
 * (before any approval prompt) and returns guidance to delegate the rest to a
 * worker through the `task` tool. The limits are INTERNAL CONSTANTS, not config
 * keys (a key earns existence only on demonstrated need, AGENTS.md).
 *
 * This is pure entity logic: the counter holds per-turn state and the check
 * decides; the decision point drives it and the engine resets it per turn and on
 * `setMode`. No infrastructure imports.
 */
import type { AgentDefinition } from "./subagents.js";
import { WRITE_CLASS_TOOLS, TASK_TOOL_NAME, toolMatchesAgentList, workerAllowed } from "./subagents.js";
import { limitDefault } from "./limits.js";

/** The lane's three mechanical limits, resolved per turn. `writeCallsPerTurn`
 * caps executed direct write calls; `distinctTargetsPerTurn` caps distinct
 * normalized file paths / command strings; `toolResultContextShare` caps the
 * fraction of the model's context window consumed by the orchestrator's own
 * tool-result messages. The pure entity takes these as a parameter; the
 * decision point reads them from the limits registry (`lane.writeCallsPerTurn`,
 * `lane.distinctTargetsPerTurn`, `lane.writeContextShare`, §13.11). */
export interface LaneLimits {
  writeCallsPerTurn: number;
  distinctTargetsPerTurn: number;
  toolResultContextShare: number;
}

/**
 * The lane's DEFAULT mechanical limits (§3.1) — the registry defaults for
 * `lane.writeCallsPerTurn` / `lane.distinctTargetsPerTurn` /
 * `lane.writeContextShare` (§13.11), read from the ONE registry so there is no
 * second source of truth. The decision point passes the live effective values;
 * this constant is the fallback a caller may use when no registry port is wired
 * (keeping the pure entity usable in isolation).
 */
export const CHAT_LANE_LIMITS: LaneLimits = {
  writeCallsPerTurn: limitDefault("lane.writeCallsPerTurn"),
  distinctTargetsPerTurn: limitDefault("lane.distinctTargetsPerTurn"),
  toolResultContextShare: limitDefault("lane.writeContextShare"),
};

/** The direct write-class tool names the lane counts (§3.1). Same set as the
 * worker write-class tools: `write_file`, `edit_file`, `execute_command`. */
export const DIRECT_WRITE_TOOLS: ReadonlySet<string> = WRITE_CLASS_TOOLS;

/**
 * WHO the lane applies to (§3.1): the orchestrator of a top-level agent that
 * (a) holds at least one direct write-class tool (`write_file`, `edit_file`,
 * `execute_command`) on its `tools` list AND (b) can delegate — it holds the
 * `task` tool and has a non-empty `workers` allowance. It is NOT keyed on an
 * agent name: the built-in `chat` qualifies because of its tools (`["*"]`,
 * `workers: "all"`); `vibe` holds no direct write tools so it is never limited;
 * `research` holds no write-class tool. A worker is never a top-level agent and
 * never passes here. An agent that cannot delegate is never limited (there is
 * nothing to delegate to).
 */
export function laneLimited(agent: AgentDefinition | undefined): boolean {
  if (!agent || agent.kind !== "top-level") return false;
  const tools = agent.tools;
  // (a) at least one direct write-class tool is bound.
  const hasWrite = [...DIRECT_WRITE_TOOLS].some((t) => toolMatchesAgentList(t, tools));
  if (!hasWrite) return false;
  // (b) can delegate: the `task` tool is bound AND some worker is dispatchable.
  const hasTask = toolMatchesAgentList(TASK_TOOL_NAME, tools);
  if (!hasTask) return false;
  // A non-empty `workers` allowance: `"all"` or a non-empty list. An agent with
  // an empty list (or none that resolves to empty) cannot delegate.
  const canDispatch = agent.workers === "all" || (Array.isArray(agent.workers) && agent.workers.length > 0) ||
    // `workerAllowed` defaults an undeclared `workers` to "all" (the chat
    // default); respect that so a chat-like agent without `workers` still can.
    (agent.workers === undefined && workerAllowed(agent, ""));
  return canDispatch;
}

/** Which limit was crossed, for the guidance string and the event (§3.1). */
export type LaneLimitWhich = "writeCalls" | "distinctTargets" | "contextShare";

/** A lane decision for the next direct write call (§3.1). `blocked` is true when
 * a limit is already crossed; `which` and `counts` describe it for the guidance
 * and the one-per-turn event. */
export interface LaneDecision {
  blocked: boolean;
  which?: LaneLimitWhich;
  counts?: { writeCalls: number; distinctTargets: number; contextSharePct: number };
}

/** The guidance tool-result a blocked direct write returns to the model (§3.1).
 * Exactly the pinned wording; `<which>` is filled per the crossed limit. */
export function laneGuidance(which: LaneLimitWhich, counts: { writeCalls: number; distinctTargets: number; contextSharePct: number }): string {
  const detail =
    which === "writeCalls"
      ? `${counts.writeCalls} write calls`
      : which === "distinctTargets"
        ? `${counts.distinctTargets} distinct files`
        : `${counts.contextSharePct}% of context used by tool results`;
  return (
    `Direct-write limit reached for this turn (${detail}). ` +
    `Delegate the remaining changes to a worker with the task tool ` +
    `(for example the implementer), then continue.`
  );
}

/**
 * The normalized target a direct write touches (§3.1 item ii): for
 * `write_file`/`edit_file` the normalized file path; for `execute_command` the
 * command string (one distinct target per distinct command). Returns null when
 * no target can be derived (then the call still counts as a write call but adds
 * no distinct target).
 */
export function laneTarget(tool: string, args: Record<string, unknown>): string | null {
  if (tool === "write_file" || tool === "edit_file") {
    const p = args["path"];
    return typeof p === "string" ? normalizePath(p) : null;
  }
  if (tool === "execute_command") {
    const c = args["command"];
    return typeof c === "string" ? c.trim() : null;
  }
  return null;
}

/** Normalize a file path for distinct-target counting: trim, collapse `./`
 * prefix and duplicate slashes. Kept simple — it only needs to make the obvious
 * duplicates equal (`a.txt` vs `./a.txt`), not resolve the filesystem. */
function normalizePath(p: string): string {
  let v = p.trim().replace(/\/{2,}/g, "/");
  while (v.startsWith("./")) v = v.slice(2);
  return v;
}

/**
 * The per-turn lane counter (§3.1). Holds the executed direct write calls and
 * the distinct normalized targets touched this turn, and emits the one
 * `LANE_LIMIT_REACHED` event at the FIRST block per turn. The decision point
 * checks BEFORE a call executes (`check`) using counts of calls ALREADY executed
 * this turn, and records an executed write AFTER it runs (`recordExecuted`). The
 * counters reset at the start of each turn and on a `setMode` (`reset`).
 */
export class LaneCounter {
  private writeCalls = 0;
  private readonly targets = new Set<string>();
  private eventEmittedThisTurn = false;

  /** Reset at the start of a turn and on `setMode` (§3.1 item 4). */
  reset(): void {
    this.writeCalls = 0;
    this.targets.clear();
    this.eventEmittedThisTurn = false;
  }

  /** The counts snapshot for the guidance/event (context share filled by the
   * caller, which knows the window and the tool-result tokens). */
  countsWith(contextSharePct: number): { writeCalls: number; distinctTargets: number; contextSharePct: number } {
    return { writeCalls: this.writeCalls, distinctTargets: this.targets.size, contextSharePct };
  }

  /**
   * Decide whether the NEXT direct write call is blocked (§3.1 item 5), using
   * counts of calls ALREADY executed this turn. The next call is blocked when:
   *   - `writeCalls >= writeCallsPerTurn` (so exactly 8 are allowed, the 9th is
   *     blocked); or
   *   - the call would touch a NEW distinct target and `distinctTargets >=
   *     distinctTargetsPerTurn` (re-touching an already-counted target is NOT a
   *     new distinct target, so it is allowed up to the call limit); or
   *   - `contextShare > toolResultContextShare` (a context share above the cap
   *     blocks the next write).
   * `contextShare` is the orchestrator's own tool-result tokens over the window,
   * measured by the caller at each check. `target` is the normalized target this
   * call would touch (null when none). `limits` are the effective registry
   * values (`lane.*`, §13.11); the caller passes the live effective set, and it
   * defaults to {@link CHAT_LANE_LIMITS} when none is wired.
   */
  check(contextShare: number, target: string | null, limits: LaneLimits = CHAT_LANE_LIMITS): LaneDecision {
    const contextSharePct = Math.round(contextShare * 100);
    const counts = this.countsWith(contextSharePct);
    if (this.writeCalls >= limits.writeCallsPerTurn) {
      return { blocked: true, which: "writeCalls", counts };
    }
    if (contextShare > limits.toolResultContextShare) {
      return { blocked: true, which: "contextShare", counts };
    }
    const isNewTarget = target !== null && !this.targets.has(target);
    if (isNewTarget && this.targets.size >= limits.distinctTargetsPerTurn) {
      return { blocked: true, which: "distinctTargets", counts };
    }
    return { blocked: false };
  }

  /**
   * Record an executed direct write (§3.1 item 5). Only called AFTER a call runs
   * — a call denied by the Guardian or rejected by the user never reaches here,
   * so it does not count. Increments the write-call count and adds the distinct
   * target when present.
   */
  recordExecuted(target: string | null): void {
    this.writeCalls += 1;
    if (target !== null) this.targets.add(target);
  }

  /**
   * Reserve a slot for a direct write that has PASSED the check and is about to
   * proceed to approval/guardrails/execute (§3.1 item 5). Reserving at the check
   * — not after execute — makes the per-turn accounting atomic when a model
   * emits several direct writes in ONE message (the harness runs them
   * concurrently): without a reservation every concurrent `check` would read the
   * same pre-increment count and none would block. A reservation that does NOT
   * end up executing (a user reject or a guardrail denial, both decided AFTER the
   * check) is rolled back with `release` so those do not count (§3.1 item 5). The
   * returned target is remembered so `release` can undo the distinct-target add
   * precisely (only when this reservation first introduced it).
   */
  reserve(target: string | null): { addedTarget: boolean } {
    this.writeCalls += 1;
    const addedTarget = target !== null && !this.targets.has(target);
    if (addedTarget) this.targets.add(target);
    return { addedTarget };
  }

  /** Roll back a `reserve` for a call that did NOT execute (user reject /
   * guardrail denial), undoing exactly what the reservation added (§3.1 item 5). */
  release(target: string | null, reservation: { addedTarget: boolean }): void {
    this.writeCalls -= 1;
    if (reservation.addedTarget && target !== null) this.targets.delete(target);
  }

  /** True once per turn: returns true the FIRST time it is called after a reset
   * (so the decision point emits exactly one `LANE_LIMIT_REACHED` per turn at
   * the first block), false thereafter. */
  claimEventOnce(): boolean {
    if (this.eventEmittedThisTurn) return false;
    this.eventEmittedThisTurn = true;
    return true;
  }
}
