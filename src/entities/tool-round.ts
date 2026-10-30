/**
 * The per-turn tool-round budget (core-blueprint.md §3.3 limit wrap-up, §3.6).
 *
 * `turnMaxToolRounds` is the ENFORCED per-turn ceiling on model→tools rounds (a
 * round = one model response that calls at least one tool). At 80% of the rounds
 * the harness appends ONE note telling the model to answer now or delegate; at
 * the limit the turn ends `limit_reached` and ALWAYS carries a result (the last
 * assistant text, or a generated summary). The engine derives LangGraph's
 * `recursionLimit` from this with a margin unless `turnRecursionLimit` is
 * explicitly set.
 *
 * Pure entity logic: the counter holds per-turn state; the engine's round
 * middleware drives it and the decision point appends the wrap-up note to the
 * next tool result. The derivation factor/margin (`toolRounds.recursionFactor`,
 * `toolRounds.recursionMargin`) and the wrap-up ratio (`toolRounds.wrapUpRatio`)
 * come from the one limits registry (§13.11); no infrastructure imports.
 */
import { limitDefault } from "./limits.js";

/** Derive the LangGraph recursion ceiling from the tool-round budget (§3.6):
 * `factor * rounds + margin`, leaving room for the interleaved model + tool
 * super-steps plus a margin. `factor`/`margin` default to the registry values
 * (`toolRounds.recursionFactor` = 2, `toolRounds.recursionMargin` = 5); the
 * engine passes the live effective values. Used when `turnRecursionLimit` is not
 * explicitly set. */
export function deriveRecursionLimit(
  maxToolRounds: number,
  factor: number = limitDefault("toolRounds.recursionFactor"),
  margin: number = limitDefault("toolRounds.recursionMargin"),
): number {
  return factor * maxToolRounds + margin;
}

/**
 * The effective LangGraph recursion ceiling for a dispatched WORKER (§7.2, §3.6):
 * the explicit `subagentRecursionLimit` override when set, otherwise DERIVED from
 * `turnMaxToolRounds` with the SAME margin as the orchestrator's
 * `turnRecursionLimit` (via `deriveRecursionLimit`) — budgets are set per tier,
 * never assumed to inherit. A worker's ROUND budget is `turnMaxToolRounds`, the
 * orchestrator's default. `0`/non-positive maps to a large finite ceiling, never
 * passed as 0 (mirroring the orchestrator). */
export function workerRecursionLimit(
  turnMaxToolRounds: number,
  subagentRecursionLimit: number | undefined,
  factor?: number,
  margin?: number,
): number {
  const base =
    subagentRecursionLimit !== undefined
      ? subagentRecursionLimit
      : deriveRecursionLimit(turnMaxToolRounds, factor, margin);
  return base <= 0 ? 1_000_000 : base;
}

/** The 80%-of-budget harness note (§3.3). `used`/`max` are the rounds so far and
 * the ceiling. */
export function roundBudgetNote(used: number, max: number): string {
  return `Tool budget nearly used (${used} of ${max} rounds). Answer now with what you have, or delegate the rest.`;
}

/** The CLI/headless notice text shown when the limit ends the turn (§3.3). */
export function limitNotice(max: number): string {
  return `Step limit reached (${max}). Say continue to resume.`;
}

/** The generated wrap-up summary when the model produced NO assistant text and
 * the limit was reached (§3.3): it states the limit, the rounds used, and the
 * tools called. Kept short and domain-neutral. */
export function limitSummary(rounds: number, max: number, tools: readonly string[]): string {
  const uniqueTools = [...new Set(tools.filter((t) => t.length > 0))];
  const toolPart = uniqueTools.length > 0 ? ` Tools called: ${uniqueTools.join(", ")}.` : "";
  return (
    `The turn stopped at the tool-round limit (${rounds} of ${max} rounds used) ` +
    `before producing a final answer.${toolPart} Say continue to resume.`
  );
}

/**
 * The per-turn tool-round counter (§3.3). Counts model→tools rounds, emits the
 * one 80% note (once per turn), and reports when the limit is reached. Reset at
 * the start of each turn and on `setMode`.
 */
export class ToolRoundCounter {
  private rounds = 0;
  private noteEmitted = false;
  private pendingNote: string | null = null;

  /**
   * @param getMax        live `turnMaxToolRounds` ceiling.
   * @param getWrapUpRatio live `toolRounds.wrapUpRatio` (§13.11); the fraction of
   *                       the budget at which the wrap-up note is queued.
   *                       Defaults to the registry value.
   */
  constructor(
    private readonly getMax: () => number,
    private readonly getWrapUpRatio: () => number = () => limitDefault("toolRounds.wrapUpRatio"),
  ) {}

  /** Reset at the start of a turn and on `setMode`. */
  reset(): void {
    this.rounds = 0;
    this.noteEmitted = false;
    this.pendingNote = null;
  }

  /** The rounds counted this turn. */
  get count(): number {
    return this.rounds;
  }

  /** The configured ceiling for this turn. */
  get max(): number {
    return Math.max(1, this.getMax());
  }

  /**
   * Record one completed model→tools round (§3.3). Called by the round
   * middleware AFTER a model response that called at least one tool. When the
   * count crosses 80% of the ceiling the one-per-turn 80% note is queued for the
   * next tool result. Returns `atLimit: true` once the ceiling is reached, so
   * the middleware ends the loop with a result.
   */
  recordRound(): { atLimit: boolean } {
    this.rounds += 1;
    const max = this.max;
    const noteAt = Math.ceil(max * this.getWrapUpRatio());
    if (!this.noteEmitted && this.rounds >= noteAt && this.rounds < max) {
      this.noteEmitted = true;
      this.pendingNote = roundBudgetNote(this.rounds, max);
    }
    return { atLimit: this.rounds >= max };
  }

  /** True once the ceiling is reached. */
  get atLimit(): boolean {
    return this.rounds >= this.max;
  }

  /** Take the pending 80% note (once), for the decision point to append to the
   * next tool result. */
  takeNote(): string | null {
    const n = this.pendingNote;
    this.pendingNote = null;
    return n;
  }
}
