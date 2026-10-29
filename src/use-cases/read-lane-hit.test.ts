/**
 * Read-lane trip LIMIT_HIT + registry actions (core-blueprint.md §13.11; owner
 * 2026-10-29).
 *
 * Owner decision: `lane.readCallsPerTurn` / `lane.readContextShare` are `warn`
 * (a non-blocking nudge). When the read lane trips at the ONE decision point it
 * emits exactly ONE `LIMIT_HIT` (action warn) naming the key AND keeps the
 * non-blocking harness note; nothing is refused (the tool result stays a
 * success). Also asserts the five flipped registry rows are `warn`.
 *
 * Pure/deterministic, offline.
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
import { getLimitSpec } from "../entities/limits.js";

const CHAT: AgentDefinition = { name: "chat", description: "d", kind: "top-level", systemPrompt: "", tools: ["*"], workers: "all", unlisted: "allow", confirm: true };

interface HitPayload {
  key: string;
  area: string;
  value: number;
  action: "warn" | "deny";
}

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

describe("read-lane trip at the ONE decision point: one LIMIT_HIT + note, no refusal (§13.11)", () => {
  it("GIVEN 8 direct reads WHEN the 9th runs THEN one LIMIT_HIT (warn) names lane.readCallsPerTurn, the note rides, and nothing is refused", async () => {
    const bus = new EventBus();
    const hits: HitPayload[] = [];
    bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as HitPayload));
    const limits = new LimitsCapability(resolveLimits([]), bus, { session: "s" });
    const readLane = new ReadLaneCounter();
    const d = deps({ getActiveAgent: () => CHAT, readLaneCounter: () => readLane, bus, limits });

    // 8 reads cross no threshold at check-time (count is recorded AFTER the check).
    for (let i = 0; i < READ_LANE_LIMITS.readCallsPerTurn; i++) {
      const r = await run(d, ctxOrch, "read_file", { path: `f${i}.txt` });
      expect(r.status).not.toBe("error");
    }
    // The 9th: count is already 8 → the note lands AND one LIMIT_HIT fires.
    const ninth = await run(d, ctxOrch, "read_file", { path: "f8.txt" });

    // No refusal: the tool result is still a success, the call executed.
    expect(ninth.status).not.toBe("error");
    expect(String(ninth.content)).toContain("executed");
    // The non-blocking note is kept.
    expect(String(ninth.content)).toContain("[harness note] You have read");
    // Exactly one LIMIT_HIT, action warn, naming the read-calls key.
    expect(hits.length).toBe(1);
    expect(hits[0]?.key).toBe("lane.readCallsPerTurn");
    expect(hits[0]?.area).toBe("lane");
    expect(hits[0]?.action).toBe("warn");
  });
});

describe("registry actions flipped to warn (owner 2026-10-29, §13.11)", () => {
  it("the five lane/toolRounds/worktree keys resolve to warn", () => {
    for (const key of [
      "lane.readCallsPerTurn",
      "lane.readContextShare",
      "toolRounds.recursionFactor",
      "toolRounds.recursionMargin",
      "worktree.includeCapBytes",
    ]) {
      expect(getLimitSpec(key)?.action).toBe("warn");
    }
  });

  it("the timeouts stay deny (a command that never times out hangs the run)", () => {
    expect(getLimitSpec("tools.commandTimeoutMs")?.action).toBe("deny");
    expect(getLimitSpec("tools.searchTimeoutMs")?.action).toBe("deny");
  });
});
