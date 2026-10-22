/**
 * The context pipeline use-case (core-blueprint.md §4) — the derived view without
 * channel mutation, budget reporting, the two-step compaction, failure handling,
 * and the fraction mapping. Deterministic and offline.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { HumanMessage, AIMessage, ToolMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { EventBus, type EventEnvelope } from "../entities/event-bus.js";
import { Session, type SessionMetadata } from "../entities/session.js";
import { ContextPipeline } from "./context-pipeline.js";
import { clearedToolPlaceholder, makeSummarizer, messageText } from "./context-pipeline.js";
import { emptySnapshot, type ContextSnapshot, type EnvironmentFacts } from "../entities/context/snapshot.js";
import { SUMMARY_MARKER } from "../entities/context/compaction.js";
import type { SizingPercents } from "../entities/context/budget.js";

const env: EnvironmentFacts = {
  cwd: "/ws",
  workspaceRoot: "/ws",
  gitBranch: "main",
  gitDirty: "clean",
  platform: "linux",
  osRelease: "6.1.0",
  shell: "/bin/bash",
  date: "2026-10-21T16:10:01-05:00",
  timeZone: "UTC",
  sessionId: "s1",
  agentMode: "chat",
  model: "m",
  contextLimit: 16_000,
  maxOutputTokens: 2000,
  vision: false,
  parallelToolCalls: null,
  turnMaxConcurrency: 4,
  ingestParallel: 4,
  toolRoundsUsed: 0,
  toolRoundsLimit: 15,
  remainingContextPct: 0,
  maxReadLines: 2000,
  cacheDir: ".voidrift/cache/",
  workers: [],
};

const percents: SizingPercents = {
  activeBudgetPct: 20,
  compactionPct: 40,
  safetyNetPct: 80,
  headBudgetPct: 10,
  noticePcts: [],
};

/** A tight active budget so only the final-turn anchor stays verbatim (§4.8). */
const tightPercents: SizingPercents = { ...percents, activeBudgetPct: 1 };

function session(): Session {
  const meta: SessionMetadata = {
    id: "s1", name: "n", summary: "", workspace: "/ws", startedAt: "t",
    lastActiveAt: "t", turnCount: 0, sizeBytes: 0, namePinned: false,
  };
  return new Session(meta);
}

function pipeline(
  s: Session,
  bus: EventBus,
  opts: { snapshot?: ContextSnapshot; summarize?: (p: string, m: number) => Promise<string>; percents?: SizingPercents } = {},
) {
  return new ContextPipeline(s, {
    bus,
    getPercents: () => opts.percents ?? percents,
    getWindow: () => 16_000,
    getOutputReservation: () => 2000,
    buildSnapshot: () => opts.snapshot ?? emptySnapshot(env),
    getToolSchemaText: () => "read_file: reads",
    ...(opts.summarize ? { summarize: opts.summarize } : {}),
  });
}

function capture(bus: EventBus): EventEnvelope[] {
  const events: EventEnvelope[] = [];
  bus.subscribe("*", (e) => events.push(e));
  return events;
}

describe("ContextPipeline (§4)", () => {
  let bus: EventBus;
  beforeEach(() => {
    bus = new EventBus();
  });

  it("builds one leading SystemMessage with content blocks (§4.2)", () => {
    const s = session();
    const snap = emptySnapshot(env);
    snap.systemPrompt = "You are VoidRift.";
    const p = pipeline(s, bus, { snapshot: snap });
    const { message, blocks } = p.buildSystemMessage(snap);
    expect(message).toBeInstanceOf(SystemMessage);
    expect(Array.isArray(message.content)).toBe(true);
    expect(blocks[0]!.layer).toBe("agent");
  });

  it("fresh session reports 0% occupancy with headTokens/workingBudget/window (§4.8)", () => {
    const s = session();
    const events = capture(bus);
    const p = pipeline(s, bus);
    const frame = p.budgetFrame(1000);
    p.report(frame, 0);
    const budget = events.find((e) => e.type === "CONTEXT_BUDGET_UPDATED")!;
    expect((budget.payload as { percentage: number }).percentage).toBe(0);
    expect(budget.payload).toMatchObject({ headTokens: 1000, workingBudget: frame.workingBudget, window: 16_000 });
  });

  it("emits CONTEXT_BUDGET_UPDATED only when the rounded int % changes (§4.8)", () => {
    const s = session();
    const events = capture(bus);
    const p = pipeline(s, bus);
    const frame = p.budgetFrame(1000);
    p.report(frame, 0);
    p.report(frame, 0); // same %
    const count = events.filter((e) => e.type === "CONTEXT_BUDGET_UPDATED").length;
    expect(count).toBe(1);
  });

  it("fires CONTEXT_THRESHOLD_CROSSED once and re-arms (§4.8)", () => {
    const s = session();
    const events = capture(bus);
    const p = pipeline(s, bus);
    const frame = p.budgetFrame(0); // workingBudget = 14000
    // ~41% of 14000 = 5740 → compaction (40)
    p.report(frame, Math.floor(frame.workingBudget * 0.41));
    p.report(frame, Math.floor(frame.workingBudget * 0.1)); // drop → re-arm
    p.report(frame, Math.floor(frame.workingBudget * 0.41)); // fires again
    const crossings = events.filter((e) => e.type === "CONTEXT_THRESHOLD_CROSSED");
    expect(crossings.filter((c) => (c.payload as { level: string }).level === "compaction")).toHaveLength(2);
  });

  it("fires a contextNoticePcts notice crossing (§4.8)", () => {
    const s = session();
    const events = capture(bus);
    const p = pipeline(s, bus, { percents: { ...percents, noticePcts: [25] } });
    const frame = p.budgetFrame(0);
    p.report(frame, Math.floor(frame.workingBudget * 0.3));
    const notice = events.filter((e) => e.type === "CONTEXT_THRESHOLD_CROSSED" && (e.payload as { level: string }).level === "notice");
    expect(notice).toHaveLength(1);
  });

  it("maps percentages onto trimMessages/summarization fractions (§4.8)", () => {
    const s = session();
    const p = pipeline(s, bus);
    expect(p.fractions()).toEqual({ keep: 0.2, trigger: 0.4, safetyNet: 0.8 });
  });

  it("derives the model-facing view without mutating the channel (§4.9)", async () => {
    const s = session();
    const summarize = async () => "folded summary";
    const p = pipeline(s, bus, { summarize, percents: tightPercents });
    // 3 turns; small active budget keeps only the last turn
    const chain: BaseMessage[] = [
      new HumanMessage("u1 " + "x".repeat(400)),
      new AIMessage("a1 " + "x".repeat(400)),
      new ToolMessage({ content: "tool-1 " + "x".repeat(400), tool_call_id: "c1" }),
      new HumanMessage("u2 " + "x".repeat(400)),
      new AIMessage("a2 " + "x".repeat(400)),
      new HumanMessage("u3 latest"),
      new AIMessage("a3 latest"),
    ];
    const before = chain.map((m) => m.content);
    const res = await p.compact(chain, { force: true });
    expect(res.turnsFolded).toBeGreaterThan(0);
    expect(s.rollingSummary!.summary.startsWith(SUMMARY_MARKER)).toBe(true);
    // the checkpointed record (chain) is untouched
    expect(chain.map((m) => m.content)).toEqual(before);
    // the derived view inserts the summary and keeps user messages + active chain
    const view = p.deriveView(chain);
    const texts = view.map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts.some((t) => t.startsWith(SUMMARY_MARKER))).toBe(true);
    expect(texts.some((t) => t.startsWith("u1"))).toBe(true); // user msgs stay verbatim
    expect(texts.some((t) => t.startsWith("u3"))).toBe(true); // active chain stays
    expect(texts.some((t) => t.startsWith("a1"))).toBe(false); // folded assistant gone
  });

  it("is idempotent: nothing beyond the active chain returns 0 and emits no CONTEXT_COMPACTED (§4.9)", async () => {
    const s = session();
    const events = capture(bus);
    const p = pipeline(s, bus, { summarize: async () => "x" });
    const chain: BaseMessage[] = [new HumanMessage("u1"), new AIMessage("a1")];
    const res = await p.compact(chain, { force: true });
    expect(res.turnsFolded).toBe(0);
    expect(events.find((e) => e.type === "CONTEXT_COMPACTED")).toBeUndefined();
  });

  it("a failed summarization leaves the transcript untouched and reports it (§4.9)", async () => {
    const s = session();
    const events = capture(bus);
    const summarize = async () => {
      throw new Error("boom");
    };
    const p = pipeline(s, bus, { summarize, percents: tightPercents });
    const chain: BaseMessage[] = [
      new HumanMessage("u1 " + "x".repeat(400)),
      new AIMessage("a1 " + "x".repeat(400)),
      new HumanMessage("u2 latest"),
      new AIMessage("a2 latest"),
    ];
    const res = await p.compact(chain, { force: true });
    expect(res.turnsFolded).toBe(0);
    expect(s.rollingSummary).toBeUndefined(); // standing summary retained (none)
    const warn = events.find((e) => e.type === "WARNING_EMITTED");
    expect(warn).toBeDefined();
    expect((warn!.payload as { source: string }).source).toBe("compaction");
  });

  it("marks folded turns' documents stale (§4.5, §4.9)", async () => {
    const s = session();
    const p = pipeline(s, bus, { summarize: async () => "sum", percents: tightPercents });
    p.registry.add({ path: "old.ts", content: "x", trust: "live", turn: 1 });
    const chain: BaseMessage[] = [
      new HumanMessage("u1 " + "x".repeat(400)),
      new AIMessage("a1 " + "x".repeat(400)),
      new HumanMessage("u2 latest"),
      new AIMessage("a2 latest"),
    ];
    await p.compact(chain, { force: true });
    expect(s.documents.get("old.ts")!.stale).toBe(true);
  });

  it("ContextBreakdown reports the window, budget, head split, and layer tokens (§4.8)", () => {
    const s = session();
    const snap = emptySnapshot(env);
    snap.systemPrompt = "You are VoidRift.";
    const p = pipeline(s, bus, { snapshot: snap });
    const bd = p.breakdown([new HumanMessage("hi")], undefined);
    expect(bd.window).toBe(16_000);
    expect(bd.workingBudget).toBeGreaterThan(0);
    expect(bd.head.inline).toBeGreaterThan(0);
    expect(bd.toolSchemaTokens).toBeGreaterThan(0);
    expect(bd.occupancyPct).toBeGreaterThanOrEqual(0);
  });

  it("deriveView returns the chain unchanged when there is no rolling summary (§4.9)", () => {
    const s = session();
    const p = pipeline(s, bus);
    const chain: BaseMessage[] = [new HumanMessage("u1"), new AIMessage("a1")];
    expect(p.deriveView(chain)).toBe(chain);
  });

  it("recoverCursor finds the last summary message by marker scan (§4.9)", () => {
    const s = session();
    const p = pipeline(s, bus);
    const chain: BaseMessage[] = [
      new AIMessage(`${SUMMARY_MARKER}\nold`),
      new HumanMessage("u"),
      new AIMessage(`${SUMMARY_MARKER}\nnew`),
    ];
    expect(p.recoverCursor(chain)).toBe(2);
    expect(p.recoverCursor([new HumanMessage("u")])).toBe(-1);
  });

  it("breakdown honors an explicit usedTokens anchor (§4.8)", () => {
    const s = session();
    const p = pipeline(s, bus);
    const bd = p.breakdown([new HumanMessage("hi")], 5000);
    expect(bd.usedTokens).toBe(5000);
    expect(bd.occupancyPct).toBeGreaterThan(0);
  });

  it("clearedToolPlaceholder and makeSummarizer/messageText helpers (§4.9)", async () => {
    expect(clearedToolPlaceholder("s1", 3)).toContain(".voidrift/cache/session/s1/tool-3.txt");
    const sum = makeSummarizer(async (prompt) => `echo:${prompt}`);
    expect(await sum("hello", 100)).toBe("echo:hello");
    expect(messageText(new HumanMessage("hi"))).toBe("hi");
    expect(messageText(new AIMessage({ content: [{ type: "text", text: "x" }] }))).toContain("text");
  });

  it("budgetFrame reflects per-call head tokens; resolveUsed prefers the provider count (§4.8)", () => {
    const s = session();
    s.usageAnchor = 2000;
    const p = pipeline(s, bus);
    expect(p.resolveUsed({ providerMaxInput: 7000, estimate: 10 })).toBe(7000);
    expect(p.resolveUsed({ estimate: 10 })).toBe(2000); // falls to the persisted anchor
    const frame = p.budgetFrame(1600);
    expect(frame.headTokens).toBe(1600);
    expect(p.activeChainTokens(frame)).toBe(frame.activeChainTokens);
  });
});
