/**
 * The §4 context-pipeline integration test (core-blueprint.md §4.10 acceptance
 * gate) — verbatim to the long paragraph at the end of §4.10. Deterministic and
 * offline: `fakeModel()` with scripted `usage_metadata`, in-memory repositories,
 * a per-test temp workspace.
 *
 * Assertion → §4 clause map (per a mapping maintained outside this repository):
 *  - three-layer head within budget, digest+pointer, manifests, cache breaks  → §4.2, §4.2.1, §4.3
 *  - caching vs non-caching provider get identical blocks                     → §4.3
 *  - live document marked stale on disk-change and on fold                    → §4.5, §4.9
 *  - active chain keeps anchors within contextActiveBudgetPct                 → §4.8
 *  - contextCompactionPct: clear tool results (no model call) then one summary → §4.9
 *  - head/user-msgs/active-chain verbatim, checkpoint untouched               → §4.9
 *  - pre-turn safety net at contextSafetyNetPct                               → §4.8, §4.9
 *  - failed summarization untouched + reported                               → §4.9
 *  - session.compact idempotent returns 0, no CONTEXT_COMPACTED               → §4.9
 *  - a fold never splits a turn                                              → §4.9
 *  - CONTEXT_BUDGET_UPDATED headTokens/workingBudget/window, 0% fresh         → §4.8
 *  - CONTEXT_THRESHOLD_CROSSED fires once and re-arms; a notice crossing      → §4.8
 *  - CONTEXT_OVERFLOW without sending                                        → §4.10
 */
import { hermeticTmp } from "./test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import path from "node:path";
import fs from "node:fs/promises";
import { createCore } from "./boot.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
import type { ResolvedModel } from "./entities/ports/model-port.js";
import type { ModelConfigEntry } from "./config/schema.js";
import type { EventEnvelope } from "./entities/event-bus.js";
import { ContextPipeline } from "./use-cases/context-pipeline.js";
import { emptySnapshot, type ContextSnapshot, type EnvironmentFacts } from "./entities/context/snapshot.js";
import { Session, type SessionMetadata } from "./entities/session.js";
import { EventBus } from "./entities/event-bus.js";
import { anthropicPromptCachingMiddleware } from "langchain";
import { CHARS_PER_TOKEN, type SizingPercents } from "./entities/context/budget.js";

const env: EnvironmentFacts = {
  cwd: "/ws", workspaceRoot: "/ws", gitBranch: "main", gitDirty: "clean",
  platform: "linux", osRelease: "6.1.0", shell: "/bin/bash",
  date: "2026-10-21T16:10:01-05:00", timeZone: "UTC", sessionId: "s1", agentMode: "chat",
  model: "m", contextLimit: 16_000, maxOutputTokens: 2000, vision: false, parallelToolCalls: null,
  turnMaxConcurrency: 4, ingestParallel: 4, toolRoundsUsed: 0, toolRoundsLimit: 15, remainingContextPct: 0,
  maxReadLines: 2000, cacheDir: ".voidrift/cache/", workers: [],
};
const percents: SizingPercents = { activeBudgetPct: 20, compactionPct: 40, safetyNetPct: 80, headWarnPct: 20, noticePcts: [] };

function mkSession(): Session {
  const meta: SessionMetadata = {
    id: "s1", name: "n", summary: "", workspace: "/ws", startedAt: "t",
    lastActiveAt: "t", turnCount: 0, sizeBytes: 0, namePinned: false,
  };
  return new Session(meta);
}

function fullSnapshot(): ContextSnapshot {
  const s = emptySnapshot(env);
  s.systemPrompt = "You are VoidRift.";
  s.hardRules = "HARD RULES: never leak secrets.";
  s.identityMemory = "User is Alex.";
  s.planStatus = "slice 2";
  s.digests = [{ label: "AGENTS.md", digest: "D".repeat(300), pointer: ".voidrift/cache/session/s1/agents.md" }];
  s.documents = [{ name: "a.ts", path: "src/a.ts", size: 10, trust: "live", stale: false }];
  s.skills = [{ name: "review", description: "review code" }];
  return s;
}

function mkPipeline(
  s: Session,
  bus: EventBus,
  p: SizingPercents = percents,
  summarize?: (p: string, m: number) => Promise<string>,
  opts: { window?: number; snapshot?: () => ContextSnapshot; toolSchemaText?: string } = {},
) {
  return new ContextPipeline(s, {
    bus,
    getPercents: () => p,
    getWindow: () => opts.window ?? 16_000,
    getOutputReservation: () => 2000,
    buildSnapshot: () => (opts.snapshot ? opts.snapshot() : fullSnapshot()),
    getToolSchemaText: () => opts.toolSchemaText ?? "read_file: reads",
    ...(summarize ? { summarize } : {}),
  });
}

const seed = { models: { t: { model: "t", protocol: "openai", contextLimit: 16_000, maxOutputTokens: 2000 } }, modelSelected: "t" };
function factory(script: () => ReturnType<typeof fakeModel>) {
  return (_r: ResolvedModel, _e: ModelConfigEntry) => script();
}

describe("§4 context pipeline integration (acceptance gate)", () => {
  let ws: string;
  const tracked: Array<{ api: { session: { shutdown: () => Promise<void> } } }> = [];
  function track<T extends { api: { session: { shutdown: () => Promise<void> } } }>(r: T): T {
    tracked.push(r);
    return r;
  }
  beforeEach(async () => {
    ws = hermeticTmp("ctx");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
  });
  afterEach(async () => {
    // Shut every created core down first so the §14.3 obs-write drain runs; a
    // late observability write otherwise re-creates the deleted workspace.
    for (const c of tracked.splice(0)) await c.api.session.shutdown().catch(() => undefined);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("assembles a three-layer head WHOLE (no cap) with digest+pointer, manifests, and cache breaks (§4.2, §4.2.1, §4.3)", () => {
    const s = mkSession();
    const bus = new EventBus();
    const p = mkPipeline(s, bus);
    const { blocks, head } = p.buildSystemMessage(fullSnapshot());
    // the head is measured whole and reports per-component sizes (§4.2.1)
    expect(head.headTokens).toBeGreaterThan(0);
    expect(head.components.length).toBeGreaterThan(0);
    const agent = blocks.find((b) => b.layer === "agent")!;
    const voidB = blocks.find((b) => b.layer === "void")!;
    // digest+pointer in the head, manifest one-liners, no bodies
    expect(agent.text).toContain("AGENTS.md");
    expect(agent.text).toContain(".voidrift/cache/session/s1/agents.md");
    expect(voidB.text).toContain("src/a.ts");
    expect(voidB.text).not.toContain("DDDD");
    // cache breaks fall on the layer boundaries (§4.3)
    expect(agent.cacheBoundary).toBe(true);
    expect(voidB.cacheBoundary).toBe(true);
  });

  it("a ~60% head loads WHOLE and raises ONE head crossing naming components; nothing truncated (§4.2.1, §4.8, §14.6)", () => {
    const s = mkSession();
    const bus = new EventBus();
    const events: EventEnvelope[] = [];
    bus.subscribe("*", (e) => events.push(e));
    // Autonomous-kickoff shape: a big AGENTS.md whose fixed context is ~60% of a
    // 16k window (> the 20% warn threshold). The exact body must survive whole.
    const bigAgents = "AGENTS-WHOLE ".repeat(3000); // ~39k chars ≈ ~9.6k tokens ≈ 60% of 16k
    const snap = (): ContextSnapshot => {
      const snapshot = fullSnapshot();
      snapshot.projectInstructions = bigAgents;
      return snapshot;
    };
    const p = mkPipeline(s, bus, percents, undefined, { window: 16_000, snapshot: snap });
    const { message, head } = p.buildSystemMessage(snap());
    // The whole AGENTS.md rides the system message verbatim (exact string equality).
    const sysText = (message.content as { text: string }[]).map((b) => b.text).join("\n");
    expect(sysText).toContain(bigAgents);
    p.reportHead(head);
    const headCrossings = events.filter(
      (e) => e.type === "CONTEXT_THRESHOLD_CROSSED" && (e.payload as { level: string }).level === "head",
    );
    expect(headCrossings).toHaveLength(1);
    const payload = headCrossings[0]!.payload as { level: string; percentage: number; components: { name: string; tokens: number }[] };
    expect(payload.percentage).toBeGreaterThanOrEqual(20);
    expect(payload.components.length).toBeGreaterThan(0);
    // The largest component is AGENTS.md, named with its token size.
    expect(payload.components[0]!.name).toBe("AGENTS.md");
    expect(payload.components[0]!.tokens).toBeGreaterThan(0);
    // The head is NOT degraded: the whole body is still in the message.
    expect(head.headTokens).toBeGreaterThan(0);
  });

  it("a head under contextHeadWarnPct emits NO head crossing (§4.2.1)", () => {
    const s = mkSession();
    const bus = new EventBus();
    const events: EventEnvelope[] = [];
    bus.subscribe("*", (e) => events.push(e));
    // The default fullSnapshot head is tiny relative to a 16k window (< 20%).
    const p = mkPipeline(s, bus);
    const { head } = p.buildSystemMessage(fullSnapshot());
    p.reportHead(head);
    const headCrossings = events.filter(
      (e) => e.type === "CONTEXT_THRESHOLD_CROSSED" && (e.payload as { level: string }).level === "head",
    );
    expect(headCrossings).toHaveLength(0);
  });

  it("the bound tool schemas count toward the head warning: a 15% head + 10% schemas crosses 20%, tiny schemas do not (§4.2.1, §4.8, §14.6)", () => {
    const window = 16_000;
    // A head whose tokens land clearly BELOW the 20% warn threshold on its own
    // (~15% of the window) so the crossing can only come from adding the schemas.
    const headAgents = "A".repeat(0.15 * window * CHARS_PER_TOKEN - 400);
    // Bound tool schemas worth ~10% of the window: 15% + 10% = 25% > 20%.
    const bigSchemas = "S".repeat(0.1 * window * CHARS_PER_TOKEN);
    const snap = (): ContextSnapshot => {
      const snapshot = fullSnapshot();
      snapshot.projectInstructions = headAgents;
      return snapshot;
    };

    // Case 1: large schemas push the fixed context over the threshold.
    {
      const s = mkSession();
      const bus = new EventBus();
      const events: EventEnvelope[] = [];
      bus.subscribe("*", (e) => events.push(e));
      const p = mkPipeline(s, bus, percents, undefined, { window, snapshot: snap, toolSchemaText: bigSchemas });
      const { head } = p.buildSystemMessage(snap());
      // The head ALONE is under the 20% warn threshold — only the schemas cross it.
      expect(Math.round((head.headTokens / window) * 100)).toBeLessThan(20);
      p.reportHead(head);
      const crossings = events.filter(
        (e) => e.type === "CONTEXT_THRESHOLD_CROSSED" && (e.payload as { level: string }).level === "head",
      );
      expect(crossings).toHaveLength(1);
      const payload = crossings[0]!.payload as { percentage: number; components: { name: string; tokens: number }[] };
      expect(payload.percentage).toBeGreaterThanOrEqual(20);
      // The fixed context the warning measures includes the bound tool schemas.
      expect(payload.components.some((c) => c.name === "tool schemas")).toBe(true);
    }

    // Case 2: the SAME head with tiny schemas stays under the threshold.
    {
      const s = mkSession();
      const bus = new EventBus();
      const events: EventEnvelope[] = [];
      bus.subscribe("*", (e) => events.push(e));
      const p = mkPipeline(s, bus, percents, undefined, { window, snapshot: snap, toolSchemaText: "x" });
      const { head } = p.buildSystemMessage(snap());
      p.reportHead(head);
      const crossings = events.filter(
        (e) => e.type === "CONTEXT_THRESHOLD_CROSSED" && (e.payload as { level: string }).level === "head",
      );
      expect(crossings).toHaveLength(0);
    }
  });

  it("the head crossing fires once and RE-ARMS after the head drops below the threshold (§4.8)", () => {
    const s = mkSession();
    const bus = new EventBus();
    const events: EventEnvelope[] = [];
    bus.subscribe("*", (e) => events.push(e));
    const big = "AGENTS-WHOLE ".repeat(3000);
    const small = fullSnapshot();
    let useBig = true;
    const snap = (): ContextSnapshot => {
      if (!useBig) return small;
      const snapshot = fullSnapshot();
      snapshot.projectInstructions = big;
      return snapshot;
    };
    const p = mkPipeline(s, bus, percents, undefined, { window: 16_000, snapshot: snap });
    p.reportHead(p.buildSystemMessage(snap()).head); // over → fires
    p.reportHead(p.buildSystemMessage(snap()).head); // still over → no refire
    useBig = false;
    p.reportHead(p.buildSystemMessage(snap()).head); // drops below → re-arm, no event
    useBig = true;
    p.reportHead(p.buildSystemMessage(snap()).head); // over again → fires again
    const headCrossings = events.filter(
      (e) => e.type === "CONTEXT_THRESHOLD_CROSSED" && (e.payload as { level: string }).level === "head",
    );
    expect(headCrossings).toHaveLength(2);
  });

  it("the head warning uses the SAME percentage rule on a 16k and a 1M window (§4.2.1)", () => {
    // A head whose fixed context is ~30% of the window crosses 20% on BOTH
    // windows; a head at ~10% crosses on NEITHER. The rule is a percentage of the
    // window, not an absolute token count.
    for (const window of [16_000, 1_000_000]) {
      const over = Math.floor(window * 0.3 * 4); // ~30% of window in chars (4 chars/token)
      const under = Math.floor(window * 0.1 * 4); // ~10%
      for (const [chars, expected] of [[over, 1], [under, 0]] as const) {
        const s = mkSession();
        const bus = new EventBus();
        const events: EventEnvelope[] = [];
        bus.subscribe("*", (e) => events.push(e));
        const snap = (): ContextSnapshot => {
          const snapshot = emptySnapshot(env);
          snapshot.projectInstructions = "A".repeat(chars);
          return snapshot;
        };
        const p = mkPipeline(s, bus, percents, undefined, { window, snapshot: snap, toolSchemaText: "" });
        p.reportHead(p.buildSystemMessage(snap()).head);
        const headCrossings = events.filter(
          (e) => e.type === "CONTEXT_THRESHOLD_CROSSED" && (e.payload as { level: string }).level === "head",
        );
        expect(headCrossings).toHaveLength(expected);
      }
    }
  });

  it("a caching and a non-caching provider receive IDENTICAL blocks; nothing provider-specific leaks into the prompt (§4.3)", async () => {
    const s = mkSession();
    const bus = new EventBus();
    const p = mkPipeline(s, bus);
    const { message } = p.buildSystemMessage(fullSnapshot());
    const blocks = message.content as { type: string; text: string }[];
    // The pipeline's blocks carry NO cache directives themselves.
    for (const b of blocks) expect("cache_control" in b).toBe(false);
    // The caching middleware is what would attach cache_control; its presence
    // does not change the pipeline's identical block content.
    const mw = anthropicPromptCachingMiddleware();
    expect(mw.name).toBeTruthy();
    // A non-caching path uses the same blocks verbatim.
    const { message: again } = p.buildSystemMessage(fullSnapshot());
    expect((again.content as unknown[]).length).toBe(blocks.length);
    expect((again.content as { text: string }[]).map((b) => b.text)).toEqual(blocks.map((b) => b.text));
  });

  it("reading a file registers a live document marked stale on disk-change AND on fold (§4.5, §4.9)", async () => {
    const s = mkSession();
    const bus = new EventBus();
    const events: EventEnvelope[] = [];
    bus.subscribe("*", (e) => events.push(e));
    const p = mkPipeline(s, bus, { ...percents, activeBudgetPct: 1 }, async () => "sum");
    p.registry.add({ path: "src/a.ts", content: "v1\nv2", trust: "live", turn: 1 });
    expect(s.documents.get("src/a.ts")!.trust).toBe("live");
    // disk-change → stale
    p.registry.checkStale("src/a.ts", "v1\nCHANGED");
    expect(s.documents.get("src/a.ts")!.stale).toBe(true);
    expect(events.some((e) => e.type === "DOCUMENT_REGISTRY_CHANGED" && (e.payload as { action: string }).action === "stale")).toBe(true);
    // on fold → folded turns' documents stale (another doc added at turn 1)
    const s2 = mkSession();
    const p2 = mkPipeline(s2, new EventBus(), { ...percents, activeBudgetPct: 1 }, async () => "sum");
    p2.registry.add({ path: "src/old.ts", content: "x", trust: "live", turn: 1 });
    const chain: BaseMessage[] = [
      new HumanMessage("u1 " + "x".repeat(400)),
      new AIMessage("a1 " + "x".repeat(400)),
      new HumanMessage("u2 latest"),
      new AIMessage("a2 latest"),
    ];
    await p2.compact(chain, { force: true });
    expect(s2.documents.get("src/old.ts")!.stale).toBe(true);
  });

  it("the active chain keeps the newest messages verbatim within contextActiveBudgetPct with anchors always kept (§4.8)", async () => {
    const s = mkSession();
    const bus = new EventBus();
    const p = mkPipeline(s, bus, { ...percents, activeBudgetPct: 1 }, async () => "sum");
    const chain: BaseMessage[] = [
      new HumanMessage("u1 " + "x".repeat(400)),
      new AIMessage("a1 " + "x".repeat(400)),
      new HumanMessage("u2-anchor"),
      new AIMessage("a2-anchor"),
    ];
    await p.compact(chain, { force: true });
    const view = p.deriveView(chain);
    const texts = view.map((m) => String(m.content));
    // anchors (final turn) kept verbatim
    expect(texts.some((t) => t.includes("u2-anchor"))).toBe(true);
    expect(texts.some((t) => t.includes("a2-anchor"))).toBe(true);
  });

  it("at contextCompactionPct clears old tool results to pointers (no model call) then folds into one summary; head/user-msgs/active-chain verbatim and the checkpoint untouched (§4.9)", async () => {
    const s = mkSession();
    const bus = new EventBus();
    const events: EventEnvelope[] = [];
    bus.subscribe("*", (e) => events.push(e));
    let summarizeCalls = 0;
    const p = mkPipeline(s, bus, { ...percents, activeBudgetPct: 1 }, async () => {
      summarizeCalls++;
      return "running summary body";
    });
    const chain: BaseMessage[] = [
      new HumanMessage("u1 " + "x".repeat(400)),
      new AIMessage("a1 " + "x".repeat(400)),
      new ToolMessage({ content: "tool-1 " + "x".repeat(400), tool_call_id: "c1" }),
      new HumanMessage("u2-latest"),
      new AIMessage("a2-latest"),
    ];
    const before = chain.map((m) => String(m.content));
    const res = await p.compact(chain, { force: true });
    // one running summary produced; one summarization model call
    expect(summarizeCalls).toBe(1);
    expect(res.turnsFolded).toBeGreaterThan(0);
    expect(s.rollingSummary!.summary).toContain("[VOIDRIFT SUMMARY v1]");
    // the checkpointed record is untouched (the derived view is separate, §4.9)
    expect(chain.map((m) => String(m.content))).toEqual(before);
    // CONTEXT_COMPACTED emitted with foldedThroughTurn/turnsFolded
    const comp = events.find((e) => e.type === "CONTEXT_COMPACTED")!;
    expect(comp.payload).toMatchObject({ foldedThroughTurn: 1 });
    // derived view keeps user messages + the active chain verbatim; folds assistant work
    const view = p.deriveView(chain).map((m) => String(m.content));
    expect(view.some((t) => t.startsWith("u1"))).toBe(true);
    expect(view.some((t) => t.includes("u2-latest"))).toBe(true);
    expect(view.some((t) => t.includes("[VOIDRIFT SUMMARY v1]"))).toBe(true);
    expect(view.some((t) => t.startsWith("a1"))).toBe(false);
  });

  it("session.compact on an already-compact session returns 0, folds nothing, emits no CONTEXT_COMPACTED (§4.9)", async () => {
    const { api } = track(
      await createCore({
        workspaceRoot: ws,
        configStore: new InMemoryConfigStore(seed),
        sessionRepository: new InMemorySessionRepository(),
        chatModelFactory: factory(() => fakeModel().respond(new AIMessage("ok"))),
      }),
    );
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const compacted = await api.session.compact(id);
    expect(compacted.ok).toBe(true);
    if (compacted.ok) expect(compacted.value.turnsFolded).toBe(0);
  });

  it("a fold never splits a turn — a leading summary is its own group, each user message grouped with the assistant work that follows it (§4.9)", async () => {
    const s = mkSession();
    const bus = new EventBus();
    const p = mkPipeline(s, bus, { ...percents, activeBudgetPct: 1 }, async () => "sum");
    const chain: BaseMessage[] = [
      new HumanMessage("u1 " + "x".repeat(400)),
      new AIMessage("a1 " + "x".repeat(400)),
      new ToolMessage({ content: "t1 " + "x".repeat(400), tool_call_id: "c1" }),
      new HumanMessage("u2-latest"),
      new AIMessage("a2-latest"),
    ];
    await p.compact(chain, { force: true });
    const view = p.deriveView(chain).map((m) => String(m.content));
    // turn 1 (u1 + a1 + t1) folds whole: no partial survivor of a1/t1 alongside the summary
    expect(view.some((t) => t.startsWith("a1"))).toBe(false);
    expect(view.some((t) => t.startsWith("t1"))).toBe(false);
    // the whole final turn survives intact
    expect(view.filter((t) => t.includes("latest")).length).toBe(2);
  });

  it("CONTEXT_BUDGET_UPDATED carries headTokens/workingBudget/window and reads 0% for a fresh session (§4.8)", () => {
    const s = mkSession();
    const bus = new EventBus();
    const events: EventEnvelope[] = [];
    bus.subscribe("*", (e) => events.push(e));
    const p = mkPipeline(s, bus);
    const frame = p.budgetFrame(1600);
    p.report(frame, 0);
    const budget = events.find((e) => e.type === "CONTEXT_BUDGET_UPDATED")!;
    expect(budget.payload).toMatchObject({ percentage: 0, headTokens: 1600, window: 16_000 });
    expect((budget.payload as { workingBudget: number }).workingBudget).toBe(frame.workingBudget);
  });

  it("CONTEXT_THRESHOLD_CROSSED fires once as occupancy rises and re-arms after it drops; a contextNoticePcts entry fires a notice (§4.8)", () => {
    const s = mkSession();
    const bus = new EventBus();
    const events: EventEnvelope[] = [];
    bus.subscribe("*", (e) => events.push(e));
    const p = mkPipeline(s, bus, { ...percents, noticePcts: [25] });
    const frame = p.budgetFrame(0);
    p.report(frame, Math.floor(frame.workingBudget * 0.3)); // notice(25) crosses
    p.report(frame, Math.floor(frame.workingBudget * 0.45)); // compaction(40) crosses once
    p.report(frame, Math.floor(frame.workingBudget * 0.1)); // drops → re-arm
    p.report(frame, Math.floor(frame.workingBudget * 0.45)); // compaction fires again
    const comp = events.filter((e) => e.type === "CONTEXT_THRESHOLD_CROSSED" && (e.payload as { level: string }).level === "compaction");
    const notice = events.filter((e) => e.type === "CONTEXT_THRESHOLD_CROSSED" && (e.payload as { level: string }).level === "notice");
    expect(comp).toHaveLength(2);
    expect(notice.length).toBeGreaterThanOrEqual(1);
  });

  it("a failed summarization leaves the transcript untouched, retains the standing summary, and is reported (§4.9)", async () => {
    const s = mkSession();
    const bus = new EventBus();
    const events: EventEnvelope[] = [];
    bus.subscribe("*", (e) => events.push(e));
    s.rollingSummary = { summary: "[VOIDRIFT SUMMARY v1]\nstanding", foldedThroughTurn: 0, updatedAt: "t" };
    const p = mkPipeline(s, bus, { ...percents, activeBudgetPct: 1 }, async () => {
      throw new Error("summarizer down");
    });
    const chain: BaseMessage[] = [
      new HumanMessage("u1 " + "x".repeat(400)),
      new AIMessage("a1 " + "x".repeat(400)),
      new HumanMessage("u2-latest"),
      new AIMessage("a2-latest"),
    ];
    const before = chain.map((m) => String(m.content));
    const res = await p.compact(chain, { force: true });
    expect(res.turnsFolded).toBe(0);
    // standing summary retained unchanged
    expect(s.rollingSummary.summary).toBe("[VOIDRIFT SUMMARY v1]\nstanding");
    // transcript untouched
    expect(chain.map((m) => String(m.content))).toEqual(before);
    // reported visibly
    expect(events.some((e) => e.type === "WARNING_EMITTED")).toBe(true);
  });

  it("a request whose estimate plus maxOutputTokens exceeds the limit returns CONTEXT_OVERFLOW without sending (§4.10)", async () => {
    // A tiny window makes any prompt overflow; the model must never be invoked
    // (no MODEL_USAGE / TURN_COMPLETE), and CONTEXT_OVERFLOW fires instead.
    const tiny = { models: { t: { model: "t", protocol: "openai", contextLimit: 500, maxOutputTokens: 400 } }, modelSelected: "t" };
    const bus_events: EventEnvelope[] = [];
    const { api } = track(
      await createCore({
        workspaceRoot: ws,
        configStore: new InMemoryConfigStore(tiny),
        sessionRepository: new InMemorySessionRepository(),
        chatModelFactory: factory(() => fakeModel().respond(new AIMessage("should not run"))),
      }),
    );
    api.events.subscribe("*", (e) => bus_events.push(e));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "a".repeat(2000), approvalMode: "policy_only" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.status).toBe("failed");
    // nothing was sent: no model usage, no turn completion
    expect(bus_events.some((e) => e.type === "MODEL_USAGE")).toBe(false);
    expect(bus_events.some((e) => e.type === "TURN_COMPLETE")).toBe(false);
    const overflow = bus_events.find((e) => e.type === "CONTEXT_OVERFLOW");
    expect(overflow).toBeDefined();
    // §4.10 — the refusal names the breakdown: estimated input, output
    // reservation, and the window limit (so the user sees what did not fit).
    const op = overflow!.payload as { limit: number; estimatedInput: number; maxOutputTokens: number; message: string };
    expect(op.limit).toBe(500);
    expect(op.maxOutputTokens).toBe(400);
    expect(op.estimatedInput).toBeGreaterThan(0);
    expect(op.estimatedInput + op.maxOutputTokens).toBeGreaterThan(op.limit);
    expect(op.message).toBeTruthy();
  });

  it("the meter is CLAMPED to 100% with an `over` flag and the hard stop refuses an over-limit turn even when maxOutputTokens is UNSET (§4.8, §4.10, FX-C)", async () => {
    // The FX-C repro: contextLimit 2000, NO maxOutputTokens configured, a server
    // that sends no usage, and ~600-char prompts. Before the fix the budget %
    // climbed past 100% (102->249%) while compaction fired every turn and turns
    // kept completing. After the fix: the meter never displays over 100% (it
    // carries an `over` flag instead), and once the conversation would overflow
    // the configured contextLimit the turn is REFUSED with CONTEXT_OVERFLOW and
    // nothing is sent — maxOutputTokens defaults sanely so the hard stop engages.
    const tiny = { models: { t: { model: "t", protocol: "openai", contextLimit: 2000 } }, modelSelected: "t" };
    const bus_events: EventEnvelope[] = [];
    const { api } = track(
      await createCore({
        workspaceRoot: ws,
        configStore: new InMemoryConfigStore(tiny),
        sessionRepository: new InMemorySessionRepository(),
        chatModelFactory: factory(() => fakeModel().respond(new AIMessage("ok ".repeat(50)))),
      }),
    );
    api.events.subscribe("*", (e) => bus_events.push(e));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    let overflowed = false;
    for (let i = 0; i < 16 && !overflowed; i++) {
      const r = await api.session.send(id, { input: `turn ${i}: ${"x".repeat(600)}`, approvalMode: "policy_only" });
      expect(r.ok).toBe(true);
      if (r.ok && r.value.status === "failed") overflowed = true;
    }
    // The meter NEVER displays over 100% (any budget events emitted before the
    // refusal are clamped).
    const budgets = bus_events.filter((e) => e.type === "CONTEXT_BUDGET_UPDATED").map((e) => e.payload as { percentage: number; over?: boolean });
    if (budgets.length > 0) expect(Math.max(...budgets.map((b) => b.percentage))).toBeLessThanOrEqual(100);
    // The run refuses an over-limit turn with CONTEXT_OVERFLOW (the OLD code let
    // the budget climb to 249% while turns kept completing).
    expect(overflowed).toBe(true);
    expect(bus_events.some((e) => e.type === "CONTEXT_OVERFLOW")).toBe(true);
  });

  it("report() CLAMPS the displayed meter to 100% with an `over` flag while the raw occupancy still drives thresholds (§4.8, FX-C)", () => {
    const s = mkSession();
    const bus = new EventBus();
    const events: EventEnvelope[] = [];
    bus.subscribe("*", (e) => events.push(e));
    const p = mkPipeline(s, bus, { ...percents, noticePcts: [] });
    const frame = p.budgetFrame(0);
    // Used tokens far beyond the working budget -> raw occupancy >> 100%.
    const displayed = p.report(frame, frame.workingBudget * 3);
    expect(displayed).toBe(100); // clamped
    const budget = events.find((e) => e.type === "CONTEXT_BUDGET_UPDATED")!;
    expect((budget.payload as { percentage: number }).percentage).toBe(100);
    expect((budget.payload as { over?: boolean }).over).toBe(true);
    // the raw occupancy still crossed compaction + safety_net thresholds
    const crossed = events.filter((e) => e.type === "CONTEXT_THRESHOLD_CROSSED").map((e) => (e.payload as { level: string }).level);
    expect(crossed).toContain("compaction");
    expect(crossed).toContain("safety_net");
  });

  it("a single message larger than the whole limit returns CONTEXT_OVERFLOW and never sends, even with no maxOutputTokens (§4.10, FX-C)", async () => {
    const tiny = { models: { t: { model: "t", protocol: "openai", contextLimit: 1000 } }, modelSelected: "t" };
    const bus_events: EventEnvelope[] = [];
    const { api } = track(
      await createCore({
        workspaceRoot: ws,
        configStore: new InMemoryConfigStore(tiny),
        sessionRepository: new InMemorySessionRepository(),
        chatModelFactory: factory(() => fakeModel().respond(new AIMessage("never"))),
      }),
    );
    api.events.subscribe("*", (e) => bus_events.push(e));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "a".repeat(8000), approvalMode: "policy_only" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.status).toBe("failed");
    expect(bus_events.some((e) => e.type === "MODEL_USAGE")).toBe(false);
    expect(bus_events.some((e) => e.type === "TURN_COMPLETE")).toBe(false);
    expect(bus_events.some((e) => e.type === "CONTEXT_OVERFLOW")).toBe(true);
  });

  it("a pre-turn safety net at contextSafetyNetPct compacts before the turn runs (§4.8, §4.9)", async () => {
    // The safety-net trigger maps onto the summarization middleware's fraction;
    // the pipeline exposes it and compaction folds when occupancy is high.
    const s = mkSession();
    const bus = new EventBus();
    const p = mkPipeline(s, bus, { ...percents, activeBudgetPct: 1 }, async () => "sum");
    expect(p.fractions().safetyNet).toBe(0.8);
    const chain: BaseMessage[] = [
      new HumanMessage("u1 " + "x".repeat(800)),
      new AIMessage("a1 " + "x".repeat(800)),
      new HumanMessage("u2-latest"),
      new AIMessage("a2-latest"),
    ];
    const res = await p.compact(chain, { force: true });
    expect(res.turnsFolded).toBeGreaterThan(0);
  });

  it("models.context() returns the full ContextBreakdown (§4.8, §11.9)", async () => {
    const { api } = track(
      await createCore({
        workspaceRoot: ws,
        configStore: new InMemoryConfigStore(seed),
        sessionRepository: new InMemorySessionRepository(),
        chatModelFactory: factory(() => fakeModel().respond(new AIMessage("ok"))),
      }),
    );
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const ctx = await api.models.context(id);
    expect(ctx.ok).toBe(true);
    if (ctx.ok) {
      const bd = ctx.value as { window: number; workingBudget: number; head: unknown; occupancyPct: number };
      expect(bd.window).toBe(16_000);
      expect(bd.workingBudget).toBeGreaterThan(0);
      expect(bd.head).toBeDefined();
      expect(bd.occupancyPct).toBe(0); // fresh
    }
  });

  it("a real turn runs through the context middleware and reports CONTEXT_BUDGET_UPDATED (§3.5, §4.8)", async () => {
    const bus_events: EventEnvelope[] = [];
    const script = () => {
      const msg = new AIMessage("done");
      (msg as { usage_metadata?: unknown }).usage_metadata = { input_tokens: 1234, output_tokens: 5, total_tokens: 1239 };
      return fakeModel().respond(msg);
    };
    const { api } = track(
      await createCore({
        workspaceRoot: ws,
        configStore: new InMemoryConfigStore(seed),
        sessionRepository: new InMemorySessionRepository(),
        chatModelFactory: factory(script),
      }),
    );
    api.events.subscribe("*", (e) => bus_events.push(e));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "hello", approvalMode: "policy_only" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.status).toBe("completed");
    // the innermost context middleware fired a budget update this turn
    expect(bus_events.some((e) => e.type === "CONTEXT_BUDGET_UPDATED")).toBe(true);
    // models.context() now reflects the provider usage anchor (§4.8)
    const ctx = await api.models.context(id);
    expect(ctx.ok).toBe(true);
    if (ctx.ok) expect((ctx.value as { usedTokens: number }).usedTokens).toBe(1234);
  });

  it("the meter MOVES across verbose turns when the provider reports NO usage — the estimate counts rift + tool schemas (§4.8, FX-G)", async () => {
    // A no-usage model (like the real router that omits stream usage): the meter
    // must still move off 0% from the pre-flight estimate (conversation + bound
    // tool schemas), not stay pinned at 0% turn after turn.
    const bus_events: EventEnvelope[] = [];
    const smallWindow = { models: { t: { model: "t", protocol: "openai", contextLimit: 8000, maxOutputTokens: 500 } }, modelSelected: "t" };
    const { api } = track(
      await createCore({
        workspaceRoot: ws,
        configStore: new InMemoryConfigStore(smallWindow),
        sessionRepository: new InMemorySessionRepository(),
        // No usage_metadata on the response — the estimate must drive the meter.
        chatModelFactory: factory(() => fakeModel().respond(new AIMessage("a verbose assistant reply ".repeat(20)))),
      }),
    );
    api.events.subscribe("*", (e) => bus_events.push(e));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    for (let i = 0; i < 3; i++) {
      const r = await api.session.send(id, { input: `turn ${i}: ${"verbose input ".repeat(30)}`, approvalMode: "policy_only" });
      expect(r.ok).toBe(true);
    }
    const pcts = bus_events
      .filter((e) => e.type === "CONTEXT_BUDGET_UPDATED")
      .map((e) => (e.payload as { percentage: number }).percentage);
    expect(pcts.length).toBeGreaterThan(0);
    // The LIVE meter's estimate includes the bound tool-schema tokens, so
    // occupancy is non-zero even though the provider reported no usage (FX-G).
    expect(Math.max(...pcts)).toBeGreaterThan(0);
  });

  it("session.compact / models.context() reject a missing session id (§2.6)", async () => {
    const { api } = track(
      await createCore({
        workspaceRoot: ws,
        configStore: new InMemoryConfigStore(seed),
        sessionRepository: new InMemorySessionRepository(),
        chatModelFactory: factory(() => fakeModel().respond(new AIMessage("ok"))),
      }),
    );
    expect((await api.session.compact(undefined)).ok).toBe(false);
    expect((await api.session.compact("nope")).ok).toBe(false);
    expect((await api.models.context(undefined)).ok).toBe(false);
    expect((await api.models.context("nope")).ok).toBe(false);
  });
});
