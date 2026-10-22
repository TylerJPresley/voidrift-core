/**
 * The chat direct-write lane at the ONE decision point (core-blueprint.md §3.1).
 * Drives the SAME shared `createDecisionMiddleware` the engine uses. Asserts the
 * block happens BEFORE any approval prompt (the resolver is never called), the
 * guidance tool result carries `cause: 'lane_limit'`, the `LANE_LIMIT_REACHED`
 * event fires once per turn, read-class calls and safe-listed `execute_command`
 * are never counted, and a non-lane agent / worker is never limited.
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
import { LaneCounter, CHAT_LANE_LIMITS } from "../entities/chat-lane.js";

/** A chat-like lane-limited top-level agent: holds write tools + task, workers
 * "all", `unlisted: allow` so every write auto-approves WITHOUT a resolver (so a
 * test can tell a lane BLOCK — no resolver — from a normal approval). */
const CHAT: AgentDefinition = {
  name: "chat",
  description: "d",
  kind: "top-level",
  systemPrompt: "",
  tools: ["*"],
  workers: "all",
  unlisted: "allow",
  confirm: true,
};

/** A non-lane agent: fans out, no direct write tools (like vibe). */
const VIBE_NOWRITE: AgentDefinition = {
  name: "vibe",
  description: "d",
  kind: "top-level",
  systemPrompt: "",
  tools: ["read_file", "glob_files", "task"],
  workers: "all",
  unlisted: "allow",
  confirm: true,
};

function cfg(over: Partial<Config> = {}): Config {
  return ConfigSchema.parse({ ...over });
}

function deps(over: Partial<DecisionPointDeps>): DecisionPointDeps {
  const registry = new ToolRegistry();
  registry.register(
    { name: "execute_command", description: "d", schema: z.object({ command: z.string() }), readOnly: false, origin: "builtin" },
    async () => ({ content: "ran", status: "success" }),
  );
  registry.register(
    { name: "write_file", description: "d", schema: z.object({ path: z.string(), content: z.string() }), readOnly: false, origin: "builtin" },
    async () => ({ content: "wrote", status: "success" }),
  );
  registry.register(
    { name: "edit_file", description: "d", schema: z.object({ path: z.string() }), readOnly: false, origin: "builtin" },
    async () => ({ content: "edited", status: "success" }),
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

/** Invoke the middleware's wrapToolCall with a crafted request + handler. The
 * `state.messages` carry prior tool results for the context-share measurement. */
function run(
  d: DecisionPointDeps,
  ctx: CallerContext,
  name: string,
  args: Record<string, unknown>,
  opts: { resolver?: AskResolver; stateMessages?: BaseMessage[] } = {},
) {
  const resolver: AskResolver = opts.resolver ?? (async () => ({ decision: "allow" as const }));
  const mw = createDecisionMiddleware(d, ctx, resolver);
  const request = {
    toolCall: { name, args, id: `${name}-1` },
    state: { messages: opts.stateMessages ?? [] },
  };
  const handler = async () => new ToolMessage({ content: "executed", tool_call_id: `${name}-1`, status: "success" as const });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mw as any).wrapToolCall(request, handler) as Promise<ToolMessage>;
}

const ctxOrch: CallerContext = { sessionId: "s", approvalMode: "policy_only" };
const ctxWorker: CallerContext = { sessionId: "s", workerId: "w1", approvalMode: "policy_only" };

describe("chat direct-write lane at the ONE decision point (§3.1)", () => {
  it("allows exactly 8 write_file calls; the 9th is BLOCKED before any approval prompt with lane_limit guidance", async () => {
    const lane = new LaneCounter();
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const bus = new EventBus();
    bus.subscribe("*", (e) => events.push({ type: e.type, payload: e.payload as Record<string, unknown> }));
    let resolverCalls = 0;
    const d = deps({ bus, getActiveAgent: () => CHAT, laneCounter: () => lane });
    const resolver: AskResolver = async () => {
      resolverCalls += 1;
      return { decision: "allow" as const };
    };
    // 8 writes to the SAME file (so distinctTargets is not the limiter): all run.
    for (let i = 0; i < 8; i++) {
      const r = await run(d, ctxOrch, "write_file", { path: "a.txt", content: `${i}` }, { resolver });
      expect(r.status).toBe("success");
    }
    // The 9th is blocked: guidance result, cause lane_limit, NOTHING executed.
    const blocked = await run(d, ctxOrch, "write_file", { path: "a.txt", content: "9" }, { resolver });
    expect(blocked.status).toBe("error");
    expect(String(blocked.content)).toContain("Direct-write limit reached for this turn (8 write calls)");
    expect((blocked.additional_kwargs as Record<string, unknown>)["cause"]).toBe("lane_limit");
    // The block happened BEFORE any prompt: the resolver was NOT called by it
    // (under `unlisted: allow` writes auto-approve without the resolver anyway,
    // so resolverCalls stays 0 throughout — the key assertion is it never grew).
    expect(resolverCalls).toBe(0);
    // Exactly one LANE_LIMIT_REACHED, naming the crossed limit.
    const laneEvents = events.filter((e) => e.type === "LANE_LIMIT_REACHED");
    expect(laneEvents.length).toBe(1);
    expect(laneEvents[0]!.payload["which"]).toBe("writeCalls");
    // No PERMISSION_DENIED for the block (it is not a permission denial).
    expect(events.filter((e) => e.type === "PERMISSION_DENIED").length).toBe(0);
  });

  it("the approval resolver is NEVER called when a write is lane-blocked (ask posture)", async () => {
    const lane = new LaneCounter();
    // Pre-fill the counter to the write-call limit so the next write blocks.
    for (let i = 0; i < CHAT_LANE_LIMITS.writeCallsPerTurn; i++) lane.recordExecuted("a.txt");
    let resolverCalls = 0;
    const askAgent: AgentDefinition = { ...CHAT, unlisted: "ask", confirm: false };
    const d = deps({ getActiveAgent: () => askAgent, laneCounter: () => lane });
    const resolver: AskResolver = async () => {
      resolverCalls += 1;
      return { decision: "allow" as const };
    };
    const blocked = await run(d, ctxOrch, "write_file", { path: "b.txt", content: "x" }, { resolver });
    expect(blocked.status).toBe("error");
    expect((blocked.additional_kwargs as Record<string, unknown>)["cause"]).toBe("lane_limit");
    expect(resolverCalls).toBe(0); // blocked BEFORE the prompt
  });

  it("emits LANE_LIMIT_REACHED only ONCE per turn even across multiple blocked writes", async () => {
    const lane = new LaneCounter();
    for (let i = 0; i < CHAT_LANE_LIMITS.writeCallsPerTurn; i++) lane.recordExecuted("a.txt");
    const events: string[] = [];
    const bus = new EventBus();
    bus.subscribe("LANE_LIMIT_REACHED", () => events.push("x"));
    const d = deps({ bus, getActiveAgent: () => CHAT, laneCounter: () => lane });
    await run(d, ctxOrch, "write_file", { path: "a.txt", content: "9" });
    await run(d, ctxOrch, "write_file", { path: "a.txt", content: "10" });
    expect(events.length).toBe(1);
  });

  it("blocks the 6th DISTINCT file but allows re-touching an already-touched file", async () => {
    const lane = new LaneCounter();
    const d = deps({ getActiveAgent: () => CHAT, laneCounter: () => lane });
    for (let i = 0; i < CHAT_LANE_LIMITS.distinctTargetsPerTurn; i++) {
      const r = await run(d, ctxOrch, "write_file", { path: `f${i}.txt`, content: "x" });
      expect(r.status).toBe("success");
    }
    // Re-touch an already-touched file: allowed (not a new distinct target), and
    // still under the 8-call limit (6th call). Uses write_file to avoid the
    // unrelated unread-edit guardrail.
    const reedit = await run(d, ctxOrch, "write_file", { path: "f0.txt", content: "y" });
    expect(reedit.status).toBe("success");
    // A 6th distinct file: blocked.
    const blocked = await run(d, ctxOrch, "write_file", { path: "f5.txt", content: "x" });
    expect(blocked.status).toBe("error");
    expect(String(blocked.content)).toContain("distinct files");
  });

  it("blocks the next write when tool-result context share crosses 0.35", async () => {
    const lane = new LaneCounter();
    const d = deps({ getActiveAgent: () => CHAT, laneCounter: () => lane, window: 1000 });
    // A prior tool result of ~360 tokens (1440 chars / 4) → share 0.36 > 0.35.
    const bigTool = new ToolMessage({ content: "y".repeat(1440), tool_call_id: "prev" });
    const blocked = await run(d, ctxOrch, "write_file", { path: "a.txt", content: "x" }, { stateMessages: [bigTool] });
    expect(blocked.status).toBe("error");
    expect(String(blocked.content)).toContain("% of context used by tool results");
  });

  it("NEVER blocks a read-class call, even past the write-call limit", async () => {
    const lane = new LaneCounter();
    for (let i = 0; i < CHAT_LANE_LIMITS.writeCallsPerTurn; i++) lane.recordExecuted("a.txt");
    const d = deps({ getActiveAgent: () => CHAT, laneCounter: () => lane });
    // read_file is seeded-free in the real harness; here with no allow rule under
    // `unlisted: allow` it auto-approves. Either way the LANE never touches it.
    const r = await run(d, ctxOrch, "read_file", { path: "a.txt" });
    expect(r.status).toBe("success");
  });

  it("does NOT count a safe-listed execute_command (e.g. `git status`)", async () => {
    const lane = new LaneCounter();
    const d = deps({ getActiveAgent: () => CHAT, laneCounter: () => lane });
    // `git status` is on the seeded safe list → classified safe → a READ, never
    // counted. Run it 12 times; none count, so a following write still runs.
    for (let i = 0; i < 12; i++) {
      const r = await run(d, ctxOrch, "execute_command", { command: "git status" });
      expect(r.status).toBe("success");
    }
    const w = await run(d, ctxOrch, "write_file", { path: "a.txt", content: "x" });
    expect(w.status).toBe("success"); // not blocked — the safe commands did not count
  });

  it("counts a non-safe execute_command as a direct write", async () => {
    const lane = new LaneCounter();
    const d = deps({ getActiveAgent: () => CHAT, laneCounter: () => lane });
    // The SAME non-safe command eight times (one distinct target, so the
    // write-call limit — not the distinct-target limit — is the limiter): the
    // 9th is blocked by the 8-write-call limit.
    for (let i = 0; i < 8; i++) {
      const r = await run(d, ctxOrch, "execute_command", { command: "touch build.out" });
      expect(r.status).toBe("success");
    }
    const blocked = await run(d, ctxOrch, "execute_command", { command: "touch build.out" });
    expect(blocked.status).toBe("error");
    expect(String(blocked.content)).toContain("8 write calls");
  });

  it("NEVER limits a non-lane agent (vibe: no direct write tools)", async () => {
    const lane = new LaneCounter();
    for (let i = 0; i < CHAT_LANE_LIMITS.writeCallsPerTurn; i++) lane.recordExecuted("a.txt");
    const d = deps({ getActiveAgent: () => VIBE_NOWRITE, laneCounter: () => lane });
    // Even with the counter pre-filled, a vibe write is not lane-limited (the
    // lane does not apply to vibe at all).
    const r = await run(d, ctxOrch, "write_file", { path: "a.txt", content: "x" });
    expect(r.status).toBe("success");
  });

  it("NEVER limits a WORKER (workerId set), even under a lane-limited parent", async () => {
    // A worker's decision middleware passes NO laneCounter; even if one were
    // wired, the orchestrator-only guard (`!ctx.workerId`) excludes a worker.
    const lane = new LaneCounter();
    for (let i = 0; i < CHAT_LANE_LIMITS.writeCallsPerTurn; i++) lane.recordExecuted("a.txt");
    const d = deps({ getActiveAgent: () => CHAT, laneCounter: () => lane });
    const r = await run(d, ctxWorker, "write_file", { path: "a.txt", content: "x" });
    expect(r.status).toBe("success");
  });

  it("NEVER blocks the task dispatch tool", async () => {
    const lane = new LaneCounter();
    for (let i = 0; i < CHAT_LANE_LIMITS.writeCallsPerTurn; i++) lane.recordExecuted("a.txt");
    const registry = new ToolRegistry();
    registry.register(
      { name: "task", description: "d", schema: z.object({ description: z.string(), subagent_type: z.string() }), readOnly: false, origin: "builtin" },
      async () => ({ content: "dispatched", status: "success" }),
    );
    const d = deps({ registry, getActiveAgent: () => CHAT, laneCounter: () => lane });
    const r = await run(d, ctxOrch, "task", { description: "do it", subagent_type: "implementer" });
    expect(r.status).toBe("success");
  });
});
