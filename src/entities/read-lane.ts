/**
 * The read lane (core-blueprint.md §3.3).
 *
 * A top-level agent that holds direct read-class tools AND `task` with workers
 * (the built-in `chat`) is nudged toward fan-out when it reads heavily on its
 * own. After 8 direct read-class tool calls in one turn, or once the turn's own
 * tool results exceed 25% of the model's context window, the harness appends ONE
 * harness note to the NEXT tool result, once per turn. The note blocks nothing,
 * changes no permission, and does not apply to a worker, `research`, or `vibe`;
 * it is recorded in the trail and its thresholds are INTERNAL CONSTANTS.
 *
 * Pure entity logic: the counter holds per-turn state and decides; the decision
 * point drives it and the engine resets it per turn and on `setMode`. No
 * infrastructure imports — it mirrors the chat lane (§3.1).
 */
import type { AgentDefinition } from "./subagents.js";
import { TASK_TOOL_NAME, toolMatchesAgentList, workerAllowed } from "./subagents.js";
import { limitDefault } from "./limits.js";

/** The read lane's two mechanical thresholds, resolved per turn.
 * `readCallsPerTurn` is the direct read-class calls before the note;
 * `toolResultContextShare` is the fraction of the model's context window
 * consumed by the turn's own tool results that also triggers it. The pure
 * entity takes these as a parameter; the decision point reads them from the
 * limits registry (`lane.readCallsPerTurn`, `lane.readContextShare`, §13.11). */
export interface ReadLaneLimits {
  readCallsPerTurn: number;
  toolResultContextShare: number;
}

/**
 * The read lane's DEFAULT thresholds (§3.3) — the registry defaults for
 * `lane.readCallsPerTurn` / `lane.readContextShare` (§13.11), read from the ONE
 * registry so there is no second source of truth. The decision point passes the
 * live effective values; this constant is the fallback when no registry port is
 * wired.
 */
export const READ_LANE_LIMITS: ReadLaneLimits = {
  readCallsPerTurn: limitDefault("lane.readCallsPerTurn"),
  toolResultContextShare: limitDefault("lane.readContextShare"),
};

/**
 * The direct read-class tool names the read lane counts (§3.3): `read_file`,
 * `glob_files`, `search_contents`, `workspace_map`. These are the local
 * exploration built-ins — a heavy run of them is what fan-out replaces. Web
 * tools are not counted (they are not local exploration), matching the spec's
 * "read N files directly" wording.
 */
export const DIRECT_READ_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "glob_files",
  "search_contents",
  "workspace_map",
]);

/**
 * WHO the read lane applies to (§3.3): a top-level agent that (a) holds at least
 * one direct read-class tool AND (b) can delegate (holds `task` and has a
 * non-empty `workers` allowance). NOT keyed on an agent name: the built-in
 * `chat` qualifies (`["*"]`, `workers: "all"`); `research` holds no direct read
 * tool (pure orchestrator) so it never applies; `vibe` holds no direct read tool
 * either. A worker is never a top-level agent and never passes here.
 */
export function readLaneApplies(agent: AgentDefinition | undefined): boolean {
  if (!agent || agent.kind !== "top-level") return false;
  const tools = agent.tools;
  const hasRead = [...DIRECT_READ_TOOLS].some((t) => toolMatchesAgentList(t, tools));
  if (!hasRead) return false;
  const hasTask = toolMatchesAgentList(TASK_TOOL_NAME, tools);
  if (!hasTask) return false;
  const canDispatch =
    agent.workers === "all" ||
    (Array.isArray(agent.workers) && agent.workers.length > 0) ||
    (agent.workers === undefined && workerAllowed(agent, ""));
  return canDispatch;
}

/** The pinned harness-note wording (§3.3). `<N>` is the direct read count so
 * far this turn. */
export function readLaneNote(reads: number): string {
  return (
    `You have read ${reads} files directly. ` +
    `For broad exploration dispatch read-only workers in ONE \`task\` call using \`tasks\`.`
  );
}

/**
 * The per-turn read-lane counter (§3.3). Counts direct read-class calls made
 * this turn and emits the ONE note the FIRST time a threshold is crossed. The
 * decision point records each direct read AFTER it executes (`recordRead`) and
 * asks `noteFor` whether the NEXT tool result should carry the note. Resets at
 * the start of each turn and on `setMode` (`reset`).
 */
export class ReadLaneCounter {
  private reads = 0;
  private noteEmitted = false;

  /** Reset at the start of a turn and on `setMode` (§3.3). */
  reset(): void {
    this.reads = 0;
    this.noteEmitted = false;
  }

  /** The direct read-class calls counted this turn. */
  get count(): number {
    return this.reads;
  }

  /** Record an executed direct read-class call (§3.3). Only called AFTER a call
   * runs, so a denied/rejected read never counts. */
  recordRead(): void {
    this.reads += 1;
  }

  /**
   * Decide whether the note should be appended to the tool result just produced
   * (§3.3). Returns the note text ONCE per turn — the first time either the
   * read-count threshold is met or the tool-result context share exceeds the
   * cap — and null thereafter (and when under both thresholds). `contextShare`
   * is the turn's own tool-result tokens over the model's window, measured by
   * the caller which knows both.
   */
  noteFor(contextShare: number, limits: ReadLaneLimits = READ_LANE_LIMITS): string | null {
    if (this.noteEmitted) return null;
    const crossed =
      this.reads >= limits.readCallsPerTurn ||
      contextShare > limits.toolResultContextShare;
    if (!crossed) return null;
    this.noteEmitted = true;
    return readLaneNote(this.reads);
  }
}
