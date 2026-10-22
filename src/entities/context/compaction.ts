/**
 * Turn grouping and compaction planning (core-blueprint.md §4.9).
 *
 * Folding works on TURNS, not loose messages, so a fold boundary never splits an
 * exchange. A turn starts at a user message and runs through everything up to the
 * next user message — the assistant's text, its tool calls, and their results. A
 * leading summary or system message, which belongs to no exchange, forms its own
 * group ahead of the first turn. This module is pure over a minimal message view
 * so it never imports LangChain into the entity layer; the middleware maps real
 * `BaseMessage`s onto `MsgView` and back.
 */

/** The marker that opens the one running summary message (§4.9). */
export const SUMMARY_MARKER = "[VOIDRIFT SUMMARY v1]";

/** A minimal message view the planner reasons over. */
export interface MsgView {
  role: "user" | "assistant" | "tool" | "system";
  /** The text content, used for marker detection and token estimates. */
  text: string;
  /** Estimated tokens for this message. */
  tokens: number;
  /** True when this is the running summary message (assistant + marker). */
  isSummary: boolean;
  /** True when this assistant message carries a cleared-tool placeholder (§4.9 step 1). */
  isTool: boolean;
}

/** A group: either the leading summary/system group or one user→next-user turn. */
export interface TurnGroup {
  /** 0 for the leading non-exchange group; 1-based turn index otherwise. */
  turn: number;
  /** Indices into the message array that belong to this group. */
  indices: number[];
  tokens: number;
  isLeading: boolean;
}

/** True when a message is the running summary (assistant role carrying the marker). */
export function isSummaryMessage(m: MsgView): boolean {
  return m.role === "assistant" && m.text.startsWith(SUMMARY_MARKER);
}

/**
 * Group messages into turns (§4.9). A leading summary/system run (before the
 * first user message) is group 0; each subsequent user message opens a turn that
 * runs to the message before the next user message.
 */
export function groupTurns(messages: MsgView[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let i = 0;

  // Leading non-exchange group: summary and/or system messages before turn 1.
  const leading: number[] = [];
  while (i < messages.length && messages[i]!.role !== "user") {
    leading.push(i);
    i++;
  }
  if (leading.length > 0) {
    groups.push({
      turn: 0,
      indices: leading,
      tokens: leading.reduce((s, idx) => s + messages[idx]!.tokens, 0),
      isLeading: true,
    });
  }

  let turn = 0;
  while (i < messages.length) {
    // messages[i] is a user message: start a turn.
    turn++;
    const indices = [i];
    i++;
    while (i < messages.length && messages[i]!.role !== "user") {
      indices.push(i);
      i++;
    }
    groups.push({
      turn,
      indices,
      tokens: indices.reduce((s, idx) => s + messages[idx]!.tokens, 0),
      isLeading: false,
    });
  }

  return groups;
}

/**
 * Select the active chain — the newest TURNS kept verbatim within
 * `activeChainTokens` (§4.8). The current turn's anchors (the last user message
 * and the last assistant group, i.e. the final turn) are always kept regardless
 * of budget. Returns the index of the first turn in the active chain (turns
 * before it are foldable). The leading group (turn 0) is never part of the
 * active chain.
 */
export function activeChainStart(groups: TurnGroup[], activeChainTokens: number): number {
  const exchanges = groups.filter((g) => !g.isLeading);
  if (exchanges.length === 0) return groups.length;

  // Always keep the final turn (the anchors).
  let kept = 0;
  let startTurn = exchanges[exchanges.length - 1]!.turn;
  for (let k = exchanges.length - 1; k >= 0; k--) {
    const g = exchanges[k]!;
    const isAnchor = k === exchanges.length - 1;
    if (isAnchor || kept + g.tokens <= activeChainTokens) {
      kept += g.tokens;
      startTurn = g.turn;
    } else {
      break;
    }
  }
  return startTurn;
}

/** The plan for a fold: which turns fold and which assistant messages clear. */
export interface CompactionPlan {
  /** The highest turn number folded (0 when nothing folds). */
  foldedThroughTurn: number;
  /** Count of turns beyond the active chain available to fold. */
  turnsFolded: number;
  /** Message indices of tool results outside the active chain (step 1 clears these). */
  clearableToolIndices: number[];
  /** Message indices of assistant work older than the active chain (step 2 folds these). */
  foldableAssistantIndices: number[];
  /** True when nothing lies beyond the active chain — compaction is a no-op (§4.9). */
  empty: boolean;
}

/**
 * Plan a compaction (§4.9). Everything in a turn before the active-chain start is
 * foldable; never the head, the user's own messages, the active chain, or the
 * leading summary group. Step 1 clears tool results in the foldable region; step
 * 2 folds the foldable assistant work. User messages are preserved verbatim and
 * are not folded.
 */
export function planCompaction(messages: MsgView[], activeChainTokens: number): CompactionPlan {
  const groups = groupTurns(messages);
  const start = activeChainStart(groups, activeChainTokens);
  const foldable = groups.filter((g) => !g.isLeading && g.turn < start);

  const clearableToolIndices: number[] = [];
  const foldableAssistantIndices: number[] = [];
  let foldedThroughTurn = 0;

  for (const g of foldable) {
    foldedThroughTurn = Math.max(foldedThroughTurn, g.turn);
    for (const idx of g.indices) {
      const m = messages[idx]!;
      if (m.role === "tool") clearableToolIndices.push(idx);
      // Fold the assistant's work; never the user's messages, never the summary.
      else if (m.role === "assistant" && !m.isSummary) foldableAssistantIndices.push(idx);
    }
  }

  const empty = foldable.length === 0;
  return {
    foldedThroughTurn,
    turnsFolded: foldable.length,
    clearableToolIndices,
    foldableAssistantIndices,
    empty,
  };
}

/**
 * Recover the fold cursor from the transcript alone by scanning for the last
 * message carrying the summary marker (§4.9). Returns -1 when none exists. The
 * metadata mirror agrees with this; the marker-scan is the authority.
 */
export function recoverSummaryIndex(messages: MsgView[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isSummaryMessage(messages[i]!)) return i;
  }
  return -1;
}
