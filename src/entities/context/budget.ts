/**
 * Token counting and budget math (core-blueprint.md §4.8).
 *
 * Token counts are taken in a fixed order of preference:
 *   1. provider-reported usage — the maximum `input_tokens` seen across the
 *      turn's rounds, since context only grows within a turn;
 *   2. a persisted usage anchor carried in session metadata;
 *   3. a conservative pre-flight estimate — assembled text at four characters
 *      per token plus a fixed 2000-token overhead margin.
 * The estimate skews high on purpose and is overridden the moment a real count
 * arrives. The working budget and all three sizing percentages derive from the
 * endpoint window (§11.2); there is no custom percent math beyond this —
 * `trimMessages` and the summarization middleware own the fractions (§4.9).
 */

import { limitDefault } from "../limits.js";

/** The fixed pre-flight estimate constants (§4.8). */
export const CHARS_PER_TOKEN = 4;
/** The registry DEFAULT estimate margin (§4.8, §13.11 `context.estimateMarginTokens`).
 * The effective per-turn value is threaded live from the limits port; this is the
 * fallback when no live value is injected (byte-identical to the former const). */
export const ESTIMATE_MARGIN_TOKENS = limitDefault("context.estimateMarginTokens");

/**
 * The output reservation ASSUMED when a model entry sets no `maxOutputTokens`
 * (§4.8, §4.10, FX-C). The overflow guard is a no-op unless the output size is
 * known, so an unset value left the pre-send hard stop disabled and the budget
 * meter free to climb past 100%. This sane default both reserves working-budget
 * space and gives the guard a known output size so an over-limit request is
 * refused with CONTEXT_OVERFLOW — WITHOUT pinning the provider's actual response
 * cap (the model adapter still only sends a cap when a positive value is set).
 * The effective per-turn value is threaded live from the limits port; this const
 * is the fallback (byte-identical to the former value).
 */
export const DEFAULT_OUTPUT_RESERVATION = limitDefault("context.defaultOutputReservation");

/**
 * The live context-budget limit values for one turn (§4.8, §13.11), created from
 * the limits port at the engine boundary and threaded into these pure functions
 * so a `limits.context.*` override changes real behaviour — WITHOUT module-level
 * mutable state. Every field is optional; an absent field falls back to the
 * registry default (byte-identical to the former module constants), so a call
 * site with no live limits (tests, standalone entities) is unchanged.
 */
export interface ContextBudgetOptions {
  /** `context.estimateMarginTokens` — pre-flight token-estimate safety margin. */
  estimateMarginTokens?: number;
  /** `context.defaultOutputReservation` — output reservation when a model sets none. */
  defaultOutputReservation?: number;
  /** `context.summaryBudgetFloor` — minimum token budget for a compaction summary. */
  summaryBudgetFloor?: number;
}

/** The effective output reservation for budget/guard math: the configured
 * `maxOutputTokens`, or the live/registry default when unset (FX-C). `defaultReservation`
 * is the live `context.defaultOutputReservation` when threaded, else the registry default. */
export function effectiveOutputReservation(
  maxOutputTokens: number | null | undefined,
  defaultReservation: number = DEFAULT_OUTPUT_RESERVATION,
): number {
  return maxOutputTokens && maxOutputTokens > 0 ? maxOutputTokens : defaultReservation;
}

/** A conservative character-based token estimate (§4.8, last resort). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * The pre-flight estimate: the assembled system prompt + bound tool schemas +
 * prior persisted chain + the new message, counted at 4 chars/token, plus a
 * fixed 2000-token margin (§4.8).
 */
export function preflightEstimate(parts: {
  systemText: string;
  toolSchemaText: string;
  chainText: string;
  newMessage: string;
}, marginTokens: number = ESTIMATE_MARGIN_TOKENS): number {
  const total =
    estimateTokens(parts.systemText) +
    estimateTokens(parts.toolSchemaText) +
    estimateTokens(parts.chainText) +
    estimateTokens(parts.newMessage);
  return total + marginTokens;
}

/**
 * Resolve used tokens by the §4.8 order of preference. `providerMaxInput` is the
 * max `input_tokens` seen this turn; `persistedAnchor` is the session-metadata
 * anchor; `estimate` is the pre-flight fallback. A value <= 0 is treated as
 * absent so a fresh turn with no usage yet falls through to the estimate.
 */
export function resolveUsedTokens(opts: {
  providerMaxInput?: number;
  persistedAnchor?: number;
  estimate: number;
}): number {
  if (opts.providerMaxInput && opts.providerMaxInput > 0) return opts.providerMaxInput;
  if (opts.persistedAnchor && opts.persistedAnchor > 0) return opts.persistedAnchor;
  return opts.estimate;
}

/** The resolved sizing percentages for an endpoint (§4.8). */
export interface SizingPercents {
  activeBudgetPct: number;
  compactionPct: number;
  safetyNetPct: number;
  headBudgetPct: number;
  noticePcts: number[];
}

/** The computed budget frame for a turn (§4.8). */
export interface BudgetFrame {
  window: number;
  headTokens: number;
  outputReservation: number;
  /** working budget = window − head tokens − output reservation (§4.8). */
  workingBudget: number;
  activeChainTokens: number;
  compactionTriggerTokens: number;
  safetyNetTriggerTokens: number;
}

/**
 * Compute the budget frame (§4.8). The head cap is a share of the WINDOW; the
 * three sizing triggers are shares of the WORKING BUDGET. The working budget
 * floors at zero so a tiny window never yields a negative frame.
 */
export function computeBudget(args: {
  window: number;
  headTokens: number;
  outputReservation: number;
  percents: SizingPercents;
}): BudgetFrame {
  const { window, headTokens, outputReservation, percents } = args;
  const workingBudget = Math.max(0, window - headTokens - outputReservation);
  return {
    window,
    headTokens,
    outputReservation,
    workingBudget,
    activeChainTokens: Math.floor((workingBudget * percents.activeBudgetPct) / 100),
    compactionTriggerTokens: Math.floor((workingBudget * percents.compactionPct) / 100),
    safetyNetTriggerTokens: Math.floor((workingBudget * percents.safetyNetPct) / 100),
  };
}

/** The head cap in tokens — a share of the window (§4.2.1, §4.8). */
export function headCapTokens(window: number, headBudgetPct: number): number {
  return Math.floor((window * headBudgetPct) / 100);
}

/**
 * Working-budget occupancy as a rounded integer percentage (§4.8). A fresh
 * session (0 used) reads 0%. Occupancy is reported against the working budget,
 * so the head and the reserved response never count toward it.
 */
export function occupancyPct(usedTokens: number, workingBudget: number): number {
  if (workingBudget <= 0) return usedTokens > 0 ? 100 : 0;
  return Math.round((usedTokens / workingBudget) * 100);
}

/**
 * The summary budget for a fold (§4.9): 20% of the folded content, floor 2000,
 * ceiling max(floor, min(5% of the window, 12000)).
 */
export function summaryBudgetTokens(
  foldedTokens: number,
  window: number,
  floorTokens: number = limitDefault("context.summaryBudgetFloor"),
): number {
  const floor = floorTokens;
  const ceiling = Math.max(floor, Math.min(Math.floor(window * 0.05), 12_000));
  const target = Math.floor(foldedTokens * 0.2);
  return Math.min(Math.max(target, floor), ceiling);
}
