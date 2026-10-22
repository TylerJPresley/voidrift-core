/**
 * The read lane at the ONE decision point (core-blueprint.md §3.3). Drives the
 * SAME shared `createDecisionMiddleware` the engine uses. Asserts the harness
 * note lands on the NEXT tool result after 8 direct reads (once per turn), that
 * it never appears under the threshold, and that it never applies to a worker,
 * `research`, or `vibe`.
 */
import { describe, it, expect } from "vitest";
import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import { createDecisionMiddleware, type DecisionPointDeps, type CallerContext, type AskResolver } from "./decision-point.js";
import { ToolRegistry } from "../entities/tool-registry.js";
import { EventBus } from "../entities/event-bus.js";
import { Guardian, builtinGuardrails } from "../entities/guardian.js";
import { Warden } from "../entities/warden.js";
import { ConfigSchema, type Config } from "../config/schema.js";
import type { AgentDefinition } from "../entities/subagents.js";
import { ReadLaneCounter, READ_LANE_LIMITS, readLaneNote } from "../entities/read-lane.js";

/** A chat-like read-lane agent: direct read tools + task + workers. */
const CHAT: AgentDefinition = { name: "chat", description: "d", kind: "top-level", systemPrompt: "", tools: ["*"], workers: "all", unlisted: "allow", confirm: true };
/** The pure-orchestrator research: no direct read tools. */
const RESEARCH: AgentDefinition = { name: "research", description: "d", kind: "top-level", systemPrompt: "", tools: ["task", "researcher_save_notes"], workers: ["researcher"], unlisted: "allow", confirm: true };
/** vibe: no direct read tools. */
const VIBE: AgentDefinition = { name: "vibe", description: "d", kind: "top-level", systemPrompt: "", tools: ["task", "write_file"], workers: "all", unlisted: "allow", confirm: true };

function cfg(over: Partial<Config> = {}): Config {
  return ConfigSchema.parse({ ...over });
}

function deps(over: Partial<DecisionPointDeps>): DecisionPointDeps {
  const registry = new ToolRegistry();
  registry.register(
    { name: "read_file", description: "d", schema: z.object({ path: z.string() }), readOnly: true, origin: "builtin" },
    async () => ({ content: "read", status: "success" }),
  );
  registry.register(
    { name: "glob_files", description: "d", schema: z.object({ pattern: z.string() }), readOnly: true, origin: "builtin" },
    async () => ({ content: "globbed", status: "success" }),
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

function run(
  d: DecisionPointDeps,
  ctx: CallerContext,
  name: string,
  args: Record<string, unknown>,
  opts: { stateMessages?: BaseMessage[] } = {},
) {
  const resolver: AskResolver = async () => ({ decision: "allow" as const });
  const mw = createDecisionMiddleware(d, ctx, resolver);
  const request = { toolCall: { name, args, id: `${name}-${Math.random()}` }, state: { messages: opts.stateMessages ?? [] } };
  const handler = async (req: { toolCall: { id: string } }) =>
    new ToolMessage({ content: "executed", tool_call_id: req.toolCall.id, status: "success" as const });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mw as any).wrapToolCall(request, handler) as Promise<ToolMessage>;
}

const ctxOrch: CallerContext = { sessionId: "s", approvalMode: "policy_only" };
const ctxWorker: CallerContext = { sessionId: "s", workerId: "w1", approvalMode: "policy_only" };

function noteCount(r: ToolMessage): number {
  return String(r.content).includes("[harness note] You have read") ? 1 : 0;
}

describe("read lane at the ONE decision point (§3.3)", () => {
  it("appends the note on the 9th tool result after 8 direct reads, once per turn", async () => {
    const readLane = new ReadLaneCounter();
    const d = deps({ getActiveAgent: () => CHAT, readLaneCounter: () => readLane });
    // 8 reads — none carries the note (thresholds not yet crossed at check-time).
    for (let i = 0; i < READ_LANE_LIMITS.readCallsPerTurn; i++) {
      const r = await run(d, ctxOrch, "read_file", { path: `f${i}.txt` });
      expect(noteCount(r)).toBe(0);
    }
    // The 9th call: count is already 8 → the note lands here, exactly once.
    const ninth = await run(d, ctxOrch, "read_file", { path: "f8.txt" });
    expect(String(ninth.content)).toContain(`[harness note] ${readLaneNote(8)}`);
    // The 10th does NOT carry it again (once per turn).
    const tenth = await run(d, ctxOrch, "read_file", { path: "f9.txt" });
    expect(noteCount(tenth)).toBe(0);
  });

  it("fires on tool-result context share over 25% before the read-count threshold", async () => {
    const readLane = new ReadLaneCounter();
    const d = deps({ getActiveAgent: () => CHAT, readLaneCounter: () => readLane, window: 100 });
    // A heavy prior tool result (>25% of the 100-token window) already in state
    // crosses the share threshold immediately, so the FIRST read carries it.
    const big = new ToolMessage({ content: "x".repeat(400), tool_call_id: "prev", status: "success" });
    const first = await run(d, ctxOrch, "read_file", { path: "a.txt" }, { stateMessages: [big] });
    expect(String(first.content)).toContain("[harness note] You have read");
  });

  it("never applies to a worker", async () => {
    const readLane = new ReadLaneCounter();
    // A worker passes a readLaneCounter? No — the engine omits it for workers.
    // Even if one were present, ctx.workerId gates it out.
    const d = deps({ getActiveAgent: () => CHAT, readLaneCounter: () => readLane });
    for (let i = 0; i < 12; i++) {
      const r = await run(d, ctxWorker, "read_file", { path: `f${i}.txt` });
      expect(noteCount(r)).toBe(0);
    }
  });

  it("never applies to research or vibe (no direct read tools)", async () => {
    for (const agent of [RESEARCH, VIBE]) {
      const readLane = new ReadLaneCounter();
      const d = deps({ getActiveAgent: () => agent, readLaneCounter: () => readLane });
      for (let i = 0; i < 12; i++) {
        const r = await run(d, ctxOrch, "read_file", { path: `f${i}.txt` });
        expect(noteCount(r)).toBe(0);
      }
    }
  });

  it("does not fire under the threshold", async () => {
    const readLane = new ReadLaneCounter();
    const d = deps({ getActiveAgent: () => CHAT, readLaneCounter: () => readLane });
    for (let i = 0; i < 5; i++) {
      const r = await run(d, ctxOrch, "read_file", { path: `f${i}.txt` });
      expect(noteCount(r)).toBe(0);
    }
  });
});
