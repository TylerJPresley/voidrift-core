/**
 * SessionStats — running totals mirrored to the session partition (§10.3, §5.2).
 *
 * Rebuilt on resume so a monitor has totals without replaying the whole log.
 */
export interface SessionStats {
  turns: number;
  /** `errors` counts tool spans that closed `error` without inflating `total` (§10.7). */
  toolCalls: { total: number; errors: number; perTool: Record<string, number> };
  tokensIn: number;
  tokensOut: number;
  /** Cumulative cache-read tokens across the session's model spans (§10.7). */
  tokensCacheRead: number;
  /** Summed measured turn wall-clock, the sum of MODEL_USAGE `totalMs` (§10.7). */
  wallMs: number;
  compactionCount: number;
  subagents: { spawned: number; completed: number; failed: number };
  averages: { tokensPerTurn: number; toolCallsPerTurn: number; msPerTurn: number };
  /** Summed monetary cost when a price is configured (§10.7); omitted otherwise. */
  cost?: number;
}

/** A fresh, zeroed stats record. */
export function emptyStats(): SessionStats {
  return {
    turns: 0,
    toolCalls: { total: 0, errors: 0, perTool: {} },
    tokensIn: 0,
    tokensOut: 0,
    tokensCacheRead: 0,
    wallMs: 0,
    compactionCount: 0,
    subagents: { spawned: 0, completed: 0, failed: 0 },
    averages: { tokensPerTurn: 0, toolCallsPerTurn: 0, msPerTurn: 0 },
  };
}
