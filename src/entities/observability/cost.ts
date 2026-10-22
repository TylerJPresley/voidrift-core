/**
 * Cost attribution (core-blueprint.md §10.7).
 *
 * `usage` rides every model span at every level. A monetary cost is derived ONLY
 * when a price is supplied — a per-model `costPer1kInput` / `costPer1kOutput`
 * from model config passthrough (§11) or an export-plugin price map. Priced → a
 * derived `cost`; unpriced → undefined, and the core never invents a rate.
 */
import type { TokenUsage } from "./obs-record.js";

export interface ModelPrice {
  costPer1kInput?: number;
  costPer1kOutput?: number;
}

/** The derived cost for a usage reading at a given price, or undefined when no
 * price is configured. */
export function deriveCost(usage: TokenUsage | undefined, price: ModelPrice | undefined): number | undefined {
  if (!usage || !price) return undefined;
  const hasInput = typeof price.costPer1kInput === "number";
  const hasOutput = typeof price.costPer1kOutput === "number";
  if (!hasInput && !hasOutput) return undefined;
  const inCost = hasInput ? (usage.inputTokens / 1000) * (price.costPer1kInput as number) : 0;
  const outCost = hasOutput ? (usage.outputTokens / 1000) * (price.costPer1kOutput as number) : 0;
  return inCost + outCost;
}
