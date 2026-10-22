/**
 * LIMITS WAVE 3b — the lane, tool-round, export, and sequence-detector limits
 * are registry-backed (core-blueprint.md §13.11). For each: the DEFAULT equals
 * today's value (behaviour byte-identical), a registry OVERRIDE changes real
 * behaviour, and a LIMIT_HIT fires at the decision point when a lane limit bites.
 *
 * Pure/deterministic, offline.
 */
import { describe, it, expect } from "vitest";
import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { z } from "zod";

import { LaneCounter, CHAT_LANE_LIMITS } from "../entities/chat-lane.js";
import { ReadLaneCounter, READ_LANE_LIMITS } from "../entities/read-lane.js";
import { deriveRecursionLimit, ToolRoundCounter, roundBudgetNote } from "../entities/tool-round.js";
import { buildSessionExport, EXPORT_LIMITS, type RawExportInput } from "./session-export.js";
import { SequenceDetector } from "../entities/observability/sequence-detector.js";
import { limitDefault } from "../entities/limits.js";
import { LimitsCapability } from "./limits-capability.js";
import { resolveLimits } from "../entities/limits-resolve.js";
import { EventBus } from "../entities/event-bus.js";
import { createDecisionMiddleware, type DecisionPointDeps, type CallerContext, type AskResolver } from "./decision-point.js";
import { ToolRegistry } from "../entities/tool-registry.js";
import { Guardian, builtinGuardrails } from "../entities/guardian.js";
import { Warden } from "../entities/warden.js";
import { ConfigSchema, type Config } from "../config/schema.js";
import type { AgentDefinition } from "../entities/subagents.js";

// ---------------------------------------------------------------------------
// Defaults equal today's values (the registry is the single source of truth).
// ---------------------------------------------------------------------------

describe("defaults equal today's in-code values (§13.11)", () => {
  it("lane defaults match the registry", () => {
    expect(CHAT_LANE_LIMITS.writeCallsPerTurn).toBe(limitDefault("lane.writeCallsPerTurn"));
    expect(CHAT_LANE_LIMITS.distinctTargetsPerTurn).toBe(limitDefault("lane.distinctTargetsPerTurn"));
    expect(CHAT_LANE_LIMITS.toolResultContextShare).toBe(limitDefault("lane.writeContextShare"));
    expect(READ_LANE_LIMITS.readCallsPerTurn).toBe(limitDefault("lane.readCallsPerTurn"));
    expect(READ_LANE_LIMITS.toolResultContextShare).toBe(limitDefault("lane.readContextShare"));
    // The historical literals.
    expect(CHAT_LANE_LIMITS.writeCallsPerTurn).toBe(8);
    expect(CHAT_LANE_LIMITS.distinctTargetsPerTurn).toBe(5);
    expect(CHAT_LANE_LIMITS.toolResultContextShare).toBeCloseTo(0.35);
    expect(READ_LANE_LIMITS.readCallsPerTurn).toBe(8);
    expect(READ_LANE_LIMITS.toolResultContextShare).toBeCloseTo(0.25);
  });

  it("recursion derivation defaults to 2*rounds+5", () => {
    expect(deriveRecursionLimit(15)).toBe(35);
    expect(limitDefault("toolRounds.recursionFactor")).toBe(2);
    expect(limitDefault("toolRounds.recursionMargin")).toBe(5);
    expect(limitDefault("toolRounds.wrapUpRatio")).toBeCloseTo(0.8);
  });

  it("export defaults are 64 KiB / 16 MiB", () => {
    expect(EXPORT_LIMITS.perResultBytes).toBe(64 * 1024);
    expect(EXPORT_LIMITS.documentBytes).toBe(16 * 1024 * 1024);
    expect(EXPORT_LIMITS.perResultBytes).toBe(limitDefault("export.perResultBytes"));
    expect(EXPORT_LIMITS.documentBytes).toBe(limitDefault("export.documentBytes"));
  });

  it("sequence detector per-session cap defaults to 3", () => {
    expect(limitDefault("sequence.maxSignalsPerSession")).toBe(3);
    expect(limitDefault("sequence.maxSignalsPerTurn")).toBe(1);
    expect(limitDefault("sequence.minDistinctSessions")).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// A limit OVERRIDE changes real behaviour.
// ---------------------------------------------------------------------------

describe("an override changes real behaviour (pure entities)", () => {
  it("chat lane: lowering writeCallsPerTurn blocks sooner", () => {
    const c = new LaneCounter();
    const limits = { writeCallsPerTurn: 2, distinctTargetsPerTurn: 5, toolResultContextShare: 0.35 };
    expect(c.check(0, "a.txt", limits).blocked).toBe(false);
    c.recordExecuted("a.txt");
    expect(c.check(0, "b.txt", limits).blocked).toBe(false);
    c.recordExecuted("b.txt");
    const d = c.check(0, "c.txt", limits);
    expect(d.blocked).toBe(true);
    expect(d.which).toBe("writeCalls");
  });

  it("chat lane: lowering writeContextShare blocks at a lower share", () => {
    const c = new LaneCounter();
    const limits = { writeCallsPerTurn: 8, distinctTargetsPerTurn: 5, toolResultContextShare: 0.1 };
    expect(c.check(0.1, "a.txt", limits).blocked).toBe(false); // at the cap, allowed
    const d = c.check(0.11, "a.txt", limits);
    expect(d.blocked).toBe(true);
    expect(d.which).toBe("contextShare");
  });

  it("read lane: lowering readCallsPerTurn fires the note sooner", () => {
    const c = new ReadLaneCounter();
    const limits = { readCallsPerTurn: 2, toolResultContextShare: 0.25 };
    c.recordRead();
    expect(c.noteFor(0, limits)).toBeNull();
    c.recordRead();
    expect(c.noteFor(0, limits)).not.toBeNull(); // count 2 >= 2
  });

  it("tool-round: a different factor/margin changes the recursion ceiling", () => {
    expect(deriveRecursionLimit(10, 3, 1)).toBe(31);
    expect(deriveRecursionLimit(10, 1, 0)).toBe(10);
  });

  it("tool-round: a higher wrap-up ratio queues the note later", () => {
    const c = new ToolRoundCounter(() => 10, () => 0.9);
    for (let i = 0; i < 8; i++) c.recordRound();
    expect(c.takeNote()).toBeNull(); // 8 < ceil(10*0.9)=9
    c.recordRound();
    expect(c.takeNote()).toBe(roundBudgetNote(9, 10));
  });

  it("export: lowering perResultBytes truncates a summary that fit at the default", () => {
    const summary = "y".repeat(2000);
    const input: RawExportInput = {
      session: { id: "s", name: "n", agent: "chat", createdAt: "t", lastActiveAt: "t", turns: 1 },
      models: ["m"],
      totals: { tokensIn: 0, tokensOut: 0 },
      messages: [
        { role: "assistant", turn: 1, time: "t", text: "hi", toolCalls: [{ tool: "read_file", args: {}, result: { summary, truncated: false } }] },
      ],
      workspaceRoot: "/w",
    };
    const atDefault = buildSessionExport(input, true);
    expect(atDefault.masking.truncatedResults).toBe(0);
    const lowered = buildSessionExport(input, true, { perResultBytes: 100, documentBytes: EXPORT_LIMITS.documentBytes });
    expect(lowered.masking.truncatedResults).toBe(1);
    expect(lowered.messages[0]!.toolCalls![0]!.result!.truncated).toBe(true);
  });

  it("sequence detector: maxSignalsPerSession caps how many signals a session raises", () => {
    const mk = (cap: number): SequenceDetector =>
      new SequenceDetector(1, 6, "sess", { maxSignalsPerSession: cap, maxSignalsPerTurn: 10, minDistinctSessions: 1 });
    // Three distinct, non-overlapping mutating two-step procedures, EACH in its
    // own turn (so the cross-turn `fired` guard never blocks a different one).
    const seqs = [
      ["write_file", "edit_file"],
      ["execute_command", "task"],
      ["save_memory", "delete_memory"],
    ];
    const run = (det: SequenceDetector): number => {
      let signals = 0;
      for (const sig of seqs) {
        det.beginTurn();
        for (const s of sig) det.observe(stepRecord(s, "ok"));
        signals += det.flushTurnSignals().length;
      }
      return signals;
    };
    const capped = run(mk(1));
    const open = run(mk(10));
    expect(capped).toBe(1); // the per-session cap stops at exactly 1
    expect(open).toBeGreaterThan(1); // without the low cap, more procedures surface
  });
});

/** A completed tool ObsRecord for a given step signature `tool(shape)`. */
function stepRecord(signature: string, status: "ok" | "error"): import("../entities/observability/obs-record.js").ObsRecord {
  const paren = signature.indexOf("(");
  const tool = paren >= 0 ? signature.slice(0, paren) : signature;
  const spanId = `${signature}-${Math.random()}`;
  // Pending then completed so stepFromRecord forms the step with no args shape.
  return {
    schemaVersion: 1,
    source: "tool",
    status,
    name: tool,
    spanId,
    traceId: "sess",
    time: new Date().toISOString(),
    attributes: {},
  } as unknown as import("../entities/observability/obs-record.js").ObsRecord;
}

// ---------------------------------------------------------------------------
// LIMIT_HIT fires at the decision point when a lane limit bites.
// ---------------------------------------------------------------------------

const CHAT: AgentDefinition = { name: "chat", description: "d", kind: "top-level", systemPrompt: "", tools: ["*"], workers: "all", unlisted: "allow", confirm: true };

function cfg(): Config {
  return ConfigSchema.parse({});
}

function limitsPort(overrides: Record<string, unknown>, bus: EventBus): LimitsCapability {
  const resolved = resolveLimits([{ layer: "session", limits: overrides }]);
  return new LimitsCapability(resolved, bus, { session: "s" });
}

function laneDeps(over: Partial<DecisionPointDeps>): DecisionPointDeps {
  const registry = new ToolRegistry();
  registry.register(
    { name: "write_file", description: "d", schema: z.object({ path: z.string(), content: z.string() }), readOnly: false, origin: "builtin" },
    async () => ({ content: "wrote", status: "success" }),
  );
  registry.register(
    { name: "read_file", description: "d", schema: z.object({ path: z.string() }), readOnly: true, origin: "builtin" },
    async () => ({ content: "read", status: "success" }),
  );
  return {
    guardian: new Guardian(builtinGuardrails()),
    warden: new Warden({ mode: "off" }),
    bus: new EventBus(),
    registry,
    getConfig: () => cfg(),
    tempDir: "/no/such",
    window: 1000,
    getSessionRules: () => [],
    guardrailState: () => ({ readPaths: new Set(), stalePaths: new Set() }),
    ...over,
  };
}

function runCall(d: DecisionPointDeps, ctx: CallerContext, name: string, args: Record<string, unknown>, stateMessages: BaseMessage[] = []) {
  const resolver: AskResolver = async () => ({ decision: "allow" as const });
  const mw = createDecisionMiddleware(d, ctx, resolver);
  const request = { toolCall: { name, args, id: `${name}-${Math.random()}` }, state: { messages: stateMessages } };
  const handler = async (req: { toolCall: { id: string } }) =>
    new ToolMessage({ content: "executed", tool_call_id: req.toolCall.id, status: "success" as const });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mw as any).wrapToolCall(request, handler) as Promise<ToolMessage>;
}

const ctxOrch: CallerContext = { sessionId: "s", approvalMode: "policy_only" };

describe("LIMIT_HIT at the decision point when a lane limit bites (§13.11)", () => {
  it("emits LIMIT_HIT naming lane.writeCallsPerTurn when the write lane blocks", async () => {
    const bus = new EventBus();
    const hits: { key: string }[] = [];
    bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string }));
    const limits = limitsPort({ lane: { writeCallsPerTurn: 1 } }, bus);
    const lane = new LaneCounter();
    const d = laneDeps({ bus, getActiveAgent: () => CHAT, laneCounter: () => lane, limits });
    // First write passes, second is blocked (cap 1).
    await runCall(d, ctxOrch, "write_file", { path: "a.txt", content: "x" });
    const blocked = await runCall(d, ctxOrch, "write_file", { path: "b.txt", content: "y" });
    expect((blocked.additional_kwargs as { cause?: string }).cause).toBe("lane_limit");
    expect(hits.some((h) => h.key === "lane.writeCallsPerTurn")).toBe(true);
  });

  it("emits LIMIT_HIT naming lane.readCallsPerTurn when the read-lane note fires", async () => {
    const bus = new EventBus();
    const hits: { key: string }[] = [];
    bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string }));
    const limits = limitsPort({ lane: { readCallsPerTurn: 2 } }, bus);
    const readLane = new ReadLaneCounter();
    const d = laneDeps({ bus, getActiveAgent: () => CHAT, readLaneCounter: () => readLane, limits });
    // Two reads reach the cap; the 3rd result carries the note + LIMIT_HIT.
    await runCall(d, ctxOrch, "read_file", { path: "f0.txt" });
    await runCall(d, ctxOrch, "read_file", { path: "f1.txt" });
    const third = await runCall(d, ctxOrch, "read_file", { path: "f2.txt" });
    expect(String(third.content)).toContain("[harness note] You have read");
    expect(hits.some((h) => h.key === "lane.readCallsPerTurn")).toBe(true);
  });
});
