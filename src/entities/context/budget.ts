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
export function estimateTokens(text: string, ratio: number = CHARS_PER_TOKEN): number {
  return Math.ceil(text.length / ratio);
}

/**
 * The measured characters-per-token ratio bounds (§4.8). The ratio is a
 * MEASURED `request chars / provider input_tokens`, kept in session metadata
 * beside the usage anchor (`usageRatio`), per session and per selected model. It
 * is clamped to `[RATIO_MIN, RATIO_MAX]` so one anomalous response (a huge
 * cached-prompt discount, or a near-zero `input_tokens`) cannot skew the next
 * estimate to a useless value. Before any measurement the ratio is
 * `CHARS_PER_TOKEN` (4). These are internal constants, not config keys (§4.8,
 * limits-vs-spec guard).
 */
export const RATIO_MIN = 1.5;
export const RATIO_MAX = 8;

/** Clamp a chars/token ratio to the internal `[1.5, 8]` band (§4.8). */
export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return CHARS_PER_TOKEN;
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio));
}

/**
 * Measure a fresh chars/token ratio from the exact request's characters and the
 * provider-reported `input_tokens` of the latest response that reported usage
 * (§4.8), clamped to `[1.5, 8]`. A non-positive `inputTokens` (no usage
 * reported) leaves the prior ratio unchanged. PURE.
 */
export function measureRatio(requestChars: number, inputTokens: number): number | undefined {
  if (!inputTokens || inputTokens <= 0 || requestChars <= 0) return undefined;
  return clampRatio(requestChars / inputTokens);
}

/**
 * The pre-flight estimate: the assembled system prompt + bound tool schemas +
 * prior persisted chain + the new message, counted at `ratio` chars/token
 * (§4.8), plus the estimate margin. `ratio` defaults to `CHARS_PER_TOKEN` (4);
 * when a measured `usageRatio` is threaded it refines the estimate
 * `ceil(chars / ratio)`.
 */
export function preflightEstimate(parts: {
  systemText: string;
  toolSchemaText: string;
  chainText: string;
  newMessage: string;
}, marginTokens: number = ESTIMATE_MARGIN_TOKENS, ratio: number = CHARS_PER_TOKEN): number {
  const chars =
    parts.systemText.length +
    parts.toolSchemaText.length +
    parts.chainText.length +
    parts.newMessage.length;
  return Math.ceil(chars / clampRatio(ratio)) + marginTokens;
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
  /** The head-size WARNING threshold (§4.2.1): when the fixed context (head +
   * bound tool schemas) passes this share of the WINDOW, one head crossing fires.
   * Not a cap — the head is never shortened or truncated (§4.2.1). */
  headWarnPct: number;
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

/**
 * The head WARNING threshold in tokens — a share of the window (§4.2.1, §4.8).
 * The fixed context (head tokens + bound tool-schema tokens) crossing this value
 * fires one `CONTEXT_THRESHOLD_CROSSED` `head` crossing. It is NOT a cap: the
 * head is never shortened or truncated (§4.2.1); the §4.10 hard stop is the only
 * refusal.
 */
export function headWarnTokens(window: number, headWarnPct: number): number {
  return Math.floor((window * headWarnPct) / 100);
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
