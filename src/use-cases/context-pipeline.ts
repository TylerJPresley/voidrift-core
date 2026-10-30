/**
 * The context pipeline (core-blueprint.md §4) — the innermost context middleware
 * (§3.5), placed last in the middleware array so it runs closest to the model and
 * owns the final system-message byte layout. No middleware writes the system
 * message after it; capability and plugin middlewares contribute through the
 * snapshot's provider blocks, never by writing the system message themselves.
 *
 * This use-case is the direction LangChain's context primitives lack: it maps
 * percentage sizing onto `trimMessages` fractions (§4.8), assembles the three
 * layers into one leading `SystemMessage` with cache-break blocks (§4.2, §4.3),
 * builds the DERIVED compaction view WITHOUT mutating the `messages` channel
 * (§4.9), tracks the budget and threshold sawtooth (§4.8), and runs the two-step
 * compaction (§4.9). It may depend on LangChain (§1 rule 4); no such type crosses
 * the facade.
 */
import { SystemMessage, HumanMessage, AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { EventBus } from "../entities/event-bus.js";
import type { Session } from "../entities/session.js";
import { DocumentRegistry } from "../entities/document-registry.js";
import { assembleHead, appendTurnMetadata, type ContentBlock, type HeadComponent } from "../entities/context/head.js";
import type { ContextSnapshot } from "../entities/context/snapshot.js";
import {
  computeBudget,
  occupancyPct,
  estimateTokens,
  resolveUsedTokens,
  summaryBudgetTokens,
  measureRatio,
  CHARS_PER_TOKEN,
  type SizingPercents,
  type BudgetFrame,
} from "../entities/context/budget.js";
import {
  ThresholdTracker,
  type ThresholdDef,
  type ContextBreakdown,
} from "../entities/context/thresholds.js";
import {
  groupTurns,
  planCompaction,
  recoverSummaryIndex,
  isSummaryMessage,
  SUMMARY_MARKER,
  type MsgView,
} from "../entities/context/compaction.js";

/** The rolling-summary state mirrored in session metadata (§4.9, §5.1). */
export interface RollingSummary {
  summary: string;
  foldedThroughTurn: number;
  updatedAt: string;
}

/** A placeholder a cleared tool result is replaced by in the derived view (§4.9 step 1). */
export function clearedToolPlaceholder(sessionId: string, index: number): string {
  return `[tool result cleared — full copy at .voidrift/cache/session/${sessionId}/tool-${index}.txt]`;
}

/** Map a `BaseMessage` to the planner's minimal view. */
function toView(m: BaseMessage): MsgView {
  const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  const type = m.getType();
  const role: MsgView["role"] =
    type === "human" ? "user" : type === "ai" ? "assistant" : type === "tool" ? "tool" : "system";
  const view: MsgView = {
    role,
    text,
    tokens: estimateTokens(text),
    isSummary: role === "assistant" && text.startsWith(SUMMARY_MARKER),
    isTool: role === "tool",
  };
  return view;
}

export interface ContextPipelineDeps {
  bus: EventBus;
  getPercents: () => SizingPercents;
  /** The endpoint window (§11.2) and output reservation (§4.8). */
  getWindow: () => number;
  getOutputReservation: () => number;
  /** Build the per-turn snapshot (§4.1); resolved once by the engine before the call. */
  buildSnapshot: () => ContextSnapshot;
  /** The visible tool-schema text, for head/estimate accounting (§4.2.2). */
  getToolSchemaText: () => string;
  /** The summarizer uses the single configured endpoint (§4.9, §11). */
  summarize?: (prompt: string, maxTokens: number) => Promise<string>;
  /** §13.11 `context.summaryBudgetFloor` — the live minimum summary token budget;
   * absent uses the registry default (byte-identical to the former constant). */
  getSummaryFloor?: () => number;
}

/**
 * The context pipeline for one session. Holds the threshold tracker so the
 * sawtooth survives across the session's turns, and the last-reported percentage
 * so `CONTEXT_BUDGET_UPDATED` fires only when the rounded int changes (§4.8).
 */
export class ContextPipeline {
  private readonly tracker = new ThresholdTracker();
  private lastReportedPct: number | null = null;
  readonly registry: DocumentRegistry;

  constructor(
    private readonly session: Session,
    private readonly deps: ContextPipelineDeps,
  ) {
    this.registry = new DocumentRegistry(session, (type, payload) =>
      deps.bus.emit(type, payload, { session: session.id }),
    );
  }

  private percents(): SizingPercents {
    return this.deps.getPercents();
  }

  /** Threshold definitions for the sawtooth, including notice bands (§4.8). */
  private thresholdDefs(): ThresholdDef[] {
    const p = this.percents();
    const defs: ThresholdDef[] = [
      { level: "compaction", pct: p.compactionPct },
      { level: "safety_net", pct: p.safetyNetPct },
    ];
    for (const n of p.noticePcts) defs.push({ level: "notice", pct: n });
    return defs;
  }

  /** The active-chain token budget mapped from `contextActiveBudgetPct` (§4.8). */
  activeChainTokens(frame: BudgetFrame): number {
    return frame.activeChainTokens;
  }

  /**
   * The fraction mapping (§4.8): `trimMessages`/summarization take fractions, not
   * token math. `keep: { fraction }` = active share; `trigger: { fraction }` =
   * compaction share. Exposed so the engine can hand them to the library and the
   * report can show the mapping.
   */
  fractions(): { keep: number; trigger: number; safetyNet: number } {
    const p = this.percents();
    return { keep: p.activeBudgetPct / 100, trigger: p.compactionPct / 100, safetyNet: p.safetyNetPct / 100 };
  }

  /** Assemble the single leading SystemMessage from the snapshot (§4.2, §4.3). */
  buildSystemMessage(snapshot: ContextSnapshot): { message: SystemMessage; blocks: ContentBlock[]; head: ReturnType<typeof assembleHead> } {
    const head = assembleHead(snapshot);
    const blocks = appendTurnMetadata(head, snapshot);
    const content = blocks.map((b) => ({ type: "text" as const, text: b.text }));
    const message = new SystemMessage({ content });
    return { message, blocks, head };
  }

  /**
   * The head-size warning (§4.2.1, §4.8, §14.6): when the FIXED context — the
   * head tokens plus the bound tool-schema tokens — passes `contextHeadWarnPct`
   * of the WINDOW, fire ONE `CONTEXT_THRESHOLD_CROSSED` `head` crossing carrying
   * the largest head components with their sizes, so the user prunes plans,
   * memories, prompts, or AGENTS.md. It cuts nothing (the head renders whole);
   * the §4.10 hard stop is the only refusal. Re-arms like the other levels — it
   * fires once on the way up and clears on the way down (§4.8). Called from the
   * context middleware per turn with the assembled head and the tool-schema text.
   */
  reportHead(head: ReturnType<typeof assembleHead>): void {
    const window = this.deps.getWindow();
    if (window <= 0) return;
    const toolSchemaTokens = estimateTokens(this.deps.getToolSchemaText());
    const fixedTokens = head.headTokens + toolSchemaTokens;
    const headPct = Math.round((fixedTokens / window) * 100);
    const warnPct = this.percents().headWarnPct;
    const components: HeadComponent[] = [
      ...head.components,
      { name: "tool schemas", tokens: toolSchemaTokens },
    ].sort((a, b) => b.tokens - a.tokens);
    const crossing = this.tracker.updateHead(headPct, warnPct, components);
    if (crossing) {
      this.deps.bus.emit("CONTEXT_THRESHOLD_CROSSED", crossing, { session: this.session.id });
    }
  }

  /**
   * The derived model-facing message view (§4.9): the full record stays intact in
   * the checkpointer; this returns a NEW array with cleared tool results and the
   * folded assistant work replaced by the one running summary. The input array is
   * never mutated — the channel rewrite is not adopted.
   */
  deriveView(messages: BaseMessage[]): BaseMessage[] {
    const summary = this.session.rollingSummary;
    if (!summary || summary.foldedThroughTurn <= 0) return messages;
    const views = messages.map(toView);
    const groups = groupTurns(views);
    const kept: BaseMessage[] = [];
    let summaryInserted = false;
    for (const g of groups) {
      if (g.isLeading) {
        for (const idx of g.indices) if (!isSummaryMessage(views[idx]!)) kept.push(messages[idx]!);
        continue;
      }
      if (g.turn <= summary.foldedThroughTurn) {
        if (!summaryInserted) {
          kept.push(new AIMessage(summary.summary));
          summaryInserted = true;
        }
        // Keep the user's own messages verbatim; drop folded assistant/tool work.
        for (const idx of g.indices) {
          if (views[idx]!.role === "user") kept.push(messages[idx]!);
        }
      } else {
        for (const idx of g.indices) kept.push(messages[idx]!);
      }
    }
    return kept;
  }

  /** Compute the budget frame for the current head (§4.8). */
  budgetFrame(headTokens: number): BudgetFrame {
    return computeBudget({
      window: this.deps.getWindow(),
      headTokens,
      outputReservation: this.deps.getOutputReservation(),
      percents: this.percents(),
    });
  }

  /** The Rift (conversation) token total over the derived view. */
  riftTokens(messages: BaseMessage[]): number {
    return messages.reduce((s, m) => s + toView(m).tokens, 0);
  }

  /**
   * The AVAILABLE budget in tokens for ingesting new content (§8.7, §4.8): the
   * endpoint window minus what the turn has already used minus the output
   * reservation — a LIVE value, never a fixed character count. `Ingest` measures
   * a file/page/output against `limits.ingest.fitFraction` of this. `usedTokens`
   * is resolved by the §4.8 order of preference (provider → anchor → estimate);
   * when omitted the caller passes the derived-view estimate. Floors at zero so a
   * tiny window never yields a negative budget.
   */
  availableBudget(messages: BaseMessage[], usedTokens?: number): number {
    const window = this.deps.getWindow();
    const reservation = this.deps.getOutputReservation();
    const used = usedTokens ?? this.resolveUsed({ estimate: this.estimatedUsed(messages) });
    return Math.max(0, window - used - reservation);
  }

  /**
   * Report occupancy as `CONTEXT_BUDGET_UPDATED` (only when the rounded int %
   * changes) and fire any `CONTEXT_THRESHOLD_CROSSED` crossings (§4.8). The
   * DISPLAYED percentage is clamped to 100% with an `over` flag (FX-C) so the
   * meter never shows past 100%; the RAW occupancy still drives the threshold
   * sawtooth (compaction/safety-net) so those keep firing as the true size
   * climbs. Returns the clamped (displayed) percentage.
   */
  report(frame: BudgetFrame, usedTokens: number): number {
    const rawPct = occupancyPct(usedTokens, frame.workingBudget);
    const pct = Math.min(100, rawPct);
    const over = rawPct > 100;
    if (this.lastReportedPct === null || pct !== this.lastReportedPct) {
      this.lastReportedPct = pct;
      this.deps.bus.emit(
        "CONTEXT_BUDGET_UPDATED",
        {
          percentage: pct,
          over,
          usedTokens,
          headTokens: frame.headTokens,
          workingBudget: frame.workingBudget,
          window: frame.window,
        },
        { session: this.session.id },
      );
    }
    for (const c of this.tracker.update(rawPct, this.thresholdDefs())) {
      this.deps.bus.emit("CONTEXT_THRESHOLD_CROSSED", c, { session: this.session.id });
    }
    return pct;
  }

  /** Resolve used tokens by the §4.8 order: provider → anchor → estimate. */
  resolveUsed(opts: { providerMaxInput?: number; estimate: number }): number {
    return resolveUsedTokens({
      ...(opts.providerMaxInput !== undefined ? { providerMaxInput: opts.providerMaxInput } : {}),
      ...(this.session.usageAnchor !== undefined ? { persistedAnchor: this.session.usageAnchor } : {}),
      estimate: opts.estimate,
    });
  }

  /**
   * The effective measured chars/token ratio for the CURRENT model (§4.8). The
   * ratio is per session AND per selected model: a ratio measured against a
   * different model is treated as absent (dropped on a model switch). Returns
   * the default `CHARS_PER_TOKEN` (4) before any measurement — so the caller can
   * tell whether the estimate rests on the measured ratio or the default, which
   * `CONTEXT_OVERFLOW.source` records. `hasMeasured` distinguishes the two.
   */
  effectiveRatio(modelId: string): { ratio: number; hasMeasured: boolean } {
    const r = this.session.usageRatio;
    if (r !== undefined && r > 0 && this.session.usageRatioModel === modelId) {
      return { ratio: r, hasMeasured: true };
    }
    return { ratio: CHARS_PER_TOKEN, hasMeasured: false };
  }

  /**
   * Record a freshly measured chars/token ratio (§4.8) from the exact request's
   * characters and the provider-reported `input_tokens`, tagged with the model
   * it was measured against. A non-positive `inputTokens` leaves the ratio
   * unchanged. Mirrors into session metadata so a resume reloads it.
   */
  recordUsageRatio(requestChars: number, inputTokens: number, modelId: string): void {
    const ratio = measureRatio(requestChars, inputTokens);
    if (ratio === undefined) return;
    this.session.usageRatio = ratio;
    this.session.usageRatioModel = modelId;
    this.session.metadata.usageRatio = ratio;
    this.session.metadata.usageRatioModel = modelId;
  }

  /** Drop the measured ratio (§4.8) — at an anchor rebase (fold) and a model
   * switch; the next provider count re-measures. */
  dropUsageRatio(): void {
    delete this.session.usageRatio;
    delete this.session.usageRatioModel;
    delete this.session.metadata.usageRatio;
    delete this.session.metadata.usageRatioModel;
  }

  /**
   * The §4.8 last-resort ESTIMATE of what fills the WORKING budget when no
   * provider/anchor count is available (FX-G): the derived conversation tokens
   * PLUS the bound tool-schema tokens. The head is excluded — it has its own cap
   * and is already subtracted from the working budget. Used by both the context
   * middleware's per-call report and `breakdown`, so the meter and
   * `models.context()` agree.
   */
  estimatedUsed(messages: BaseMessage[]): number {
    return this.riftTokens(messages) + estimateTokens(this.deps.getToolSchemaText());
  }

  /** The full `ContextBreakdown` DTO for `models.context()` (§4.8, §11.9). */
  breakdown(messages: BaseMessage[], usedTokens?: number): ContextBreakdown {
    const snapshot = this.deps.buildSnapshot();
    const { head } = this.buildSystemMessage(snapshot);
    const frame = this.budgetFrame(head.headTokens);
    const derived = this.deriveView(messages);
    const rift = this.riftTokens(derived);
    const toolSchemaTokens = estimateTokens(this.deps.getToolSchemaText());
    // §4.8 — a fresh session (no conversation, no provider count) reads 0%: the
    // breakdown's estimate is the conversation (`rift`) alone, matching the
    // documented "fresh reads 0%". The LIVE per-call meter (the context
    // middleware) additionally counts the bound tool schemas so it moves across
    // turns even when the provider reports no usage (FX-G, `estimatedUsed`); the
    // breakdown stays conversation-anchored so `models.context()` is stable.
    const used = usedTokens ?? this.resolveUsed({ estimate: rift });
    return {
      window: frame.window,
      workingBudget: frame.workingBudget,
      headTokens: head.headTokens,
      head: head.tierSplit,
      agentTokens: head.agentTokens,
      voidTokens: head.voidTokens,
      riftTokens: rift,
      toolSchemaTokens,
      usedTokens: used,
      occupancyPct: occupancyPct(used, frame.workingBudget),
    };
  }

  /**
   * Run compaction on demand (`session.compact`, §4.9). Two steps:
   *   1. clear old tool results beyond the active chain to cache pointers (no
   *      model call); the full result stays on disk (§8.3);
   *   2. if still over, fold the assistant's older work into the one running
   *      summary using the single configured endpoint.
   * Idempotent: when nothing lies beyond the active chain it returns 0, folds
   * nothing, and emits no `CONTEXT_COMPACTED`. A summarization failure is
   * non-fatal and never silent: the transcript is untouched, the standing summary
   * retained, and the failure reported via `WARNING_EMITTED`.
   */
  async compact(
    messages: BaseMessage[],
    opts: { force?: boolean } = {},
  ): Promise<{ turnsFolded: number; summary?: RollingSummary }> {
    const snapshot = this.deps.buildSnapshot();
    const { head } = this.buildSystemMessage(snapshot);
    const frame = this.budgetFrame(head.headTokens);
    const views = messages.map(toView);
    const plan = planCompaction(views, frame.activeChainTokens);

    if (plan.empty) {
      return { turnsFolded: 0 };
    }

    // Step 1 — clear old tool results (no model call). Tracked for the report;
    // the derived view (deriveView) is what the model sees, so this is accounted
    // through the fold. The full result is on disk under the session cache (§8.3).
    const clearedCount = plan.clearableToolIndices.length;

    // Step 2 — fold the assistant's older work into the one running summary.
    const foldedText = plan.foldableAssistantIndices.map((i) => views[i]!.text).join("\n\n");
    const needFold = opts.force || clearedCount === 0 || foldedText.trim() !== "";

    if (needFold && foldedText.trim() !== "" && this.deps.summarize) {
      const budget = summaryBudgetTokens(estimateTokens(foldedText), this.deps.getWindow(), this.deps.getSummaryFloor?.());
      const prior = this.session.rollingSummary?.summary ?? "";
      const prompt =
        `${SUMMARY_MARKER}\nUpdate the running summary of the assistant's older work. ` +
        `Keep it within ~${budget} tokens.\n\nPrior summary:\n${prior}\n\nNew work to fold:\n${foldedText}`;
      let summaryBody: string;
      try {
        summaryBody = await this.deps.summarize(prompt, budget);
      } catch (e) {
        // Non-fatal, never silent (§4.9): transcript untouched, summary retained.
        this.deps.bus.emit(
          "WARNING_EMITTED",
          { category: "context", source: "compaction", pattern: String(e) },
          { session: this.session.id },
        );
        return { turnsFolded: 0 };
      }
      const marked = summaryBody.startsWith(SUMMARY_MARKER) ? summaryBody : `${SUMMARY_MARKER}\n${summaryBody}`;
      const summary: RollingSummary = {
        summary: marked,
        foldedThroughTurn: plan.foldedThroughTurn,
        updatedAt: new Date().toISOString(),
      };
      this.session.rollingSummary = summary;
      // FX-C — compaction REBASES the estimate: drop the stale usage anchor so
      // the next turn's budget is measured against the shrunken derived history
      // (the old anchor + deltas would otherwise keep the pre-fold size and the
      // meter would not fall after a fold). The next real provider count re-anchors.
      delete this.session.usageAnchor;
      // §4.8 — the measured ratio is dropped at an anchor rebase too, consistently
      // with the anchor (the fold shrinks the request, so a ratio measured against
      // the pre-fold chars no longer describes it); the next provider count re-measures.
      this.dropUsageRatio();
      // A folded turn's documents are marked stale so they re-read (§4.5, §4.9).
      this.registry.markFoldedStale(plan.foldedThroughTurn);
      this.deps.bus.emit(
        "CONTEXT_COMPACTED",
        { foldedThroughTurn: plan.foldedThroughTurn, turnsFolded: plan.turnsFolded },
        { session: this.session.id },
      );
      return { turnsFolded: plan.turnsFolded, summary };
    }

    // Only tool-clearing happened and no assistant work needed folding, but a
    // region beyond the active chain existed: still a successful compaction.
    if (clearedCount > 0) {
      delete this.session.usageAnchor; // FX-C — rebase the estimate (see above)
      this.dropUsageRatio(); // §4.8 — drop the measured ratio with the anchor
      this.registry.markFoldedStale(plan.foldedThroughTurn);
      this.deps.bus.emit(
        "CONTEXT_COMPACTED",
        { foldedThroughTurn: plan.foldedThroughTurn, turnsFolded: plan.turnsFolded },
        { session: this.session.id },
      );
      return { turnsFolded: plan.turnsFolded };
    }

    return { turnsFolded: 0 };
  }

  /** Recover the fold cursor from the transcript (§4.9); -1 when none. */
  recoverCursor(messages: BaseMessage[]): number {
    return recoverSummaryIndex(messages.map(toView));
  }
}

/** Build the summarizer function from a chat model (the single configured endpoint, §4.9). */
export function makeSummarizer(invoke: (prompt: string) => Promise<string>): (prompt: string, max: number) => Promise<string> {
  return async (prompt: string, _max: number) => invoke(prompt);
}

/** A convenience: build a HumanMessage/AIMessage pair's text for estimates. */
export function messageText(m: BaseMessage): string {
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}

/** Re-exported for the engine's pre-flight hard stop (§4.10). */
export { HumanMessage };
