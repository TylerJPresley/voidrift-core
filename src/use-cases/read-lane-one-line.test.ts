/**
 * Read-lane: ONE user-visible line carrying both facts (core-blueprint.md §3.3,
 * §13.11; session-review product finding 2).
 *
 * One read-lane event reaches the user as ONE line: the WARNING_EMITTED
 * `message` carries BOTH the delegate nudge AND the registry key/value to raise.
 * Exactly ONE LIMIT_HIT is still recorded (the trail/audit record); the CLI
 * suppresses that LIMIT_HIT's own `ℹ` line (off-repo; see the summary).
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
import { ReadLaneCounter, READ_LANE_LIMITS } from "../entities/read-lane.js";
import { resolveLimits } from "../entities/limits-resolve.js";
import { LimitsCapability } from "./limits-capability.js";

const CHAT: AgentDefinition = { name: "chat", description: "d", kind: "top-level", systemPrompt: "", tools: ["*"], workers: "all", unlisted: "allow", confirm: true };

function cfg(over: Partial<Config> = {}): Config {
  return ConfigSchema.parse({ ...over });
}

function deps(over: Partial<DecisionPointDeps>): DecisionPointDeps {
  const registry = new ToolRegistry();
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

function run(d: DecisionPointDeps, ctx: CallerContext, name: string, args: Record<string, unknown>, stateMessages: BaseMessage[] = []) {
  const resolver: AskResolver = async () => ({ decision: "allow" as const });
  const mw = createDecisionMiddleware(d, ctx, resolver);
  const request = { toolCall: { name, args, id: `${name}-${Math.random()}` }, state: { messages: stateMessages } };
  const handler = async (req: { toolCall: { id: string } }) =>
    new ToolMessage({ content: "executed", tool_call_id: req.toolCall.id, status: "success" as const });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mw as any).wrapToolCall(request, handler) as Promise<ToolMessage>;
}

const ctxOrch: CallerContext = { sessionId: "s", approvalMode: "policy_only" };

describe("read-lane: one user-visible line carrying both facts (§3.3, finding 2)", () => {
  it("the WARNING_EMITTED message carries the delegate nudge AND the key/value; exactly one LIMIT_HIT", async () => {
    const bus = new EventBus();
    const warnings: Record<string, unknown>[] = [];
    const hits: Record<string, unknown>[] = [];
    bus.subscribe("WARNING_EMITTED", (e) => warnings.push(e.payload as Record<string, unknown>));
    bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as Record<string, unknown>));
    const limits = new LimitsCapability(resolveLimits([]), bus, { session: "s" });
    const readLane = new ReadLaneCounter();
    const d = deps({ getActiveAgent: () => CHAT, readLaneCounter: () => readLane, bus, limits });

    for (let i = 0; i < READ_LANE_LIMITS.readCallsPerTurn; i++) {
      await run(d, ctxOrch, "read_file", { path: `f${i}.txt` });
    }
    await run(d, ctxOrch, "read_file", { path: "f8.txt" });

    const readLaneWarnings = warnings.filter((w) => w.category === "read-lane");
    expect(readLaneWarnings).toHaveLength(1);
    // MUTATION PROOF: the pre-fix message had no limit fact; this exact string fails it.
    expect(readLaneWarnings[0]!.message).toBe(
      "Heavy direct reading this turn — consider delegating exploration to a worker batch (task). " +
        "(limits.lane.readCallsPerTurn = 8; raise it in config)",
    );
    // The LIMIT_HIT trail record stays, exactly one, naming the key.
    expect(hits).toHaveLength(1);
    expect(hits[0]!.key).toBe("lane.readCallsPerTurn");
  });
});
