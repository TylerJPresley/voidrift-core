/**
 * The PIPELINE-LEVEL bracketing guarantee (core-blueprint.md §8.1, §9.1, §14.6).
 *
 * EVERY tool call the model emits — in the orchestrator OR a worker — produces
 * exactly ONE `TOOL_STARTED` and exactly ONE `TOOL_FINISHED`, whatever the
 * outcome: ok, tool error, permission denied, compliance block, managed-layer
 * failure, unknown tool, or invalid arguments. A denied or invalid call never
 * executes yet is still bracketed (`status: "error"` + a one-line summary); a
 * `PERMISSION_DENIED`/`COMPLIANCE_BLOCKED` still fires alongside. Drives the SAME
 * shared `createDecisionMiddleware` the engine and the subagents use-case share
 * (§15.1#4), so the one implementation covers both the orchestrator and worker
 * paths. Also asserts: the string→string[] coercion reaches the executor, the
 * invalid-argument message is field+issue only (no stack/path, ≤500), and the
 * model-bound schema is untouched.
 */
import { describe, it, expect } from "vitest";
import { ToolMessage } from "@langchain/core/messages";
import { z } from "zod";
import {
  createDecisionMiddleware,
  type DecisionPointDeps,
  type CallerContext,
  type AskResolver,
} from "./decision-point.js";
import { ToolRegistry } from "../entities/tool-registry.js";
import { EventBus } from "../entities/event-bus.js";
import { Guardian, builtinGuardrails } from "../entities/guardian.js";
import { Warden, type WardenPolicy } from "../entities/warden.js";
import { ConfigSchema, type Config } from "../config/schema.js";
import type { AgentDefinition } from "../entities/subagents.js";
import { seededAllowRules } from "../test-support/seed-rules.js";

function cfg(over: Partial<Config> = {}): Config {
  return ConfigSchema.parse({ ...over });
}

const CHAT: AgentDefinition = {
  name: "chat",
  description: "d",
  kind: "top-level",
  systemPrompt: "",
  tools: ["*"],
  workers: "all",
  unlisted: "ask",
};

/** A string-array schema (like `save_memory.keywords`) to prove the central
 * coercion reaches the executor and leaves the bound schema unchanged. */
const KW_SCHEMA = z.object({ title: z.string(), keywords: z.array(z.string()).optional() });

function makeRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  const ok = async () => ({ content: "ok", status: "success" as const });
  r.register({ name: "execute_command", description: "d", schema: z.object({ command: z.string() }), readOnly: false, origin: "builtin" }, ok);
  r.register({ name: "read_file", description: "d", schema: z.object({ path: z.string() }), readOnly: true, origin: "builtin" }, ok);
  r.register({ name: "save_memory", description: "d", schema: KW_SCHEMA, readOnly: false, origin: "builtin" }, ok);
  return r;
}

function deps(over: Partial<DecisionPointDeps> = {}): DecisionPointDeps {
  return {
    guardian: new Guardian(builtinGuardrails()),
    warden: new Warden({ mode: "off" }),
    bus: new EventBus(),
    registry: makeRegistry(),
    getConfig: () => cfg(),
    getActiveAgent: () => CHAT,
    tempDir: "/no/such",
    window: 32_000,
    getSessionRules: () => seededAllowRules(),
    guardrailState: () => ({ readPaths: new Set(), stalePaths: new Set() }),
    ...over,
  };
}

interface Ev {
  type: string;
  payload: Record<string, unknown>;
}

/** Run one call through the shared middleware and collect its events. The
 * handler executes only when the gate lets the call through; a denied/invalid
 * call never reaches it. */
async function run(
  d: DecisionPointDeps,
  ctx: CallerContext,
  name: string,
  args: Record<string, unknown>,
  opts: { resolver?: AskResolver; handlerStatus?: "success" | "error" } = {},
): Promise<{ result: ToolMessage; events: Ev[]; handlerRan: boolean }> {
  const events: Ev[] = [];
  d.bus.subscribe("*", (e) => events.push({ type: e.type, payload: e.payload as Record<string, unknown> }));
  const resolver: AskResolver = opts.resolver ?? (async () => ({ decision: "allow" as const }));
  const mw = createDecisionMiddleware(d, ctx, resolver);
  let handlerRan = false;
  const request = { toolCall: { name, args, id: `${name}-1` }, state: { messages: [] } };
  const handler = async () => {
    handlerRan = true;
    return new ToolMessage({ content: "executed", tool_call_id: `${name}-1`, status: opts.handlerStatus ?? ("success" as const) });
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await (mw as any).wrapToolCall(request, handler)) as ToolMessage;
  return { result, events, handlerRan };
}

function bracket(events: Ev[], id: string): { started: number; finished: Ev[] } {
  const started = events.filter((e) => e.type === "TOOL_STARTED" && e.payload["id"] === id).length;
  const finished = events.filter((e) => e.type === "TOOL_FINISHED" && e.payload["id"] === id);
  return { started, finished };
}

const ORCH: CallerContext = { sessionId: "s", approvalMode: "policy_only" };
const WORKER: CallerContext = { sessionId: "s", workerId: "w1", fanoutId: "f1", approvalMode: "policy_only" };

describe.each([
  ["orchestrator", ORCH],
  ["worker", WORKER],
])("§8.1/§9.1 bracketing — %s: one STARTED + one FINISHED per outcome", (_label, ctx) => {
  it("ok call → exactly one STARTED + one FINISHED success, handler ran", async () => {
    const { result, events, handlerRan } = await run(deps(), ctx, "read_file", { path: "a.ts" });
    const b = bracket(events, "read_file-1");
    expect(b.started).toBe(1);
    expect(b.finished).toHaveLength(1);
    expect(b.finished[0]!.payload["status"]).toBe("success");
    expect(result.status).not.toBe("error");
    expect(handlerRan).toBe(true);
  });

  it("tool error → one STARTED + one FINISHED error, handler ran", async () => {
    const { events, handlerRan } = await run(deps(), ctx, "read_file", { path: "a.ts" }, { handlerStatus: "error" });
    const b = bracket(events, "read_file-1");
    expect(b.started).toBe(1);
    expect(b.finished).toHaveLength(1);
    expect(b.finished[0]!.payload["status"]).toBe("error");
    expect(handlerRan).toBe(true);
  });

  it("permission denied → one pair (error), PERMISSION_DENIED alongside, handler NOT run", async () => {
    const { result, events, handlerRan } = await run(deps(), ctx, "execute_command", { command: "shutdown now" });
    const b = bracket(events, "execute_command-1");
    expect(b.started).toBe(1);
    expect(b.finished).toHaveLength(1);
    expect(b.finished[0]!.payload["status"]).toBe("error");
    expect(String(b.finished[0]!.payload["summary"])).toContain("permission denied");
    expect(events.some((e) => e.type === "PERMISSION_DENIED")).toBe(true);
    expect(result.status).toBe("error");
    expect(handlerRan).toBe(false);
  });

  it("compliance block → one pair (error), COMPLIANCE_BLOCKED alongside, handler NOT run", async () => {
    const policy: WardenPolicy = { version: "1", hash: "h", rules: [{ match: "execute_command", kind: "tool", effect: "block" }] };
    const warden = new Warden({ mode: "enforcing" });
    warden.setPolicy(policy);
    const { events, handlerRan } = await run(deps({ warden }), ctx, "execute_command", { command: "echo hi" });
    const b = bracket(events, "execute_command-1");
    expect(b.started).toBe(1);
    expect(b.finished).toHaveLength(1);
    expect(b.finished[0]!.payload["status"]).toBe("error");
    expect(events.some((e) => e.type === "COMPLIANCE_BLOCKED")).toBe(true);
    expect(handlerRan).toBe(false);
  });

  it("managed-layer failure → one pair (error), PERMISSION_DENIED alongside, handler NOT run", async () => {
    const { events, handlerRan } = await run(deps({ managedGate: () => ({ reason: "unreadable" }) }), ctx, "read_file", { path: "a.ts" });
    const b = bracket(events, "read_file-1");
    expect(b.started).toBe(1);
    expect(b.finished).toHaveLength(1);
    expect(b.finished[0]!.payload["status"]).toBe("error");
    expect(events.some((e) => e.type === "PERMISSION_DENIED" && e.payload["reason"] === "managed_layer_unavailable")).toBe(true);
    expect(handlerRan).toBe(false);
  });

  it("unknown tool → one pair (error), PERMISSION_DENIED cause unknown_tool, handler NOT run", async () => {
    const events: Ev[] = [];
    const d = deps();
    d.bus.subscribe("*", (e) => events.push({ type: e.type, payload: e.payload as Record<string, unknown> }));
    const mw = createDecisionMiddleware(d, ctx, async () => ({ decision: "allow" as const }));
    let ran = false;
    const handler = async () => {
      ran = true;
      return new ToolMessage({ content: "x", tool_call_id: "ghost-1", status: "success" as const });
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (mw as any).wrapToolCall({ toolCall: { name: "ghost", args: {}, id: "ghost-1" }, state: { messages: [] } }, handler);
    const b = bracket(events, "ghost-1");
    expect(b.started).toBe(1);
    expect(b.finished).toHaveLength(1);
    expect(b.finished[0]!.payload["status"]).toBe("error");
    expect(events.some((e) => e.type === "PERMISSION_DENIED" && e.payload["cause"] === "unknown_tool")).toBe(true);
    expect(ran).toBe(false);
  });

  it("invalid arguments → one pair (error), formatted message, handler NOT run", async () => {
    // `path` must be a string; a number fails the schema after coercion.
    const { result, events, handlerRan } = await run(deps(), ctx, "read_file", { path: 123 as unknown as string });
    const b = bracket(events, "read_file-1");
    expect(b.started).toBe(1);
    expect(b.finished).toHaveLength(1);
    expect(b.finished[0]!.payload["status"]).toBe("error");
    expect(String(result.content)).toMatch(/^Error: invalid arguments for read_file: path: /);
    expect(String(result.content)).not.toMatch(/\n|\.ts:|\.js:|at /); // no stack, no paths
    expect(String(result.content).length).toBeLessThanOrEqual(520);
    expect(handlerRan).toBe(false);
  });
});

describe("§8.1 coercion + schema immutability (orchestrator)", () => {
  it("a comma string for a string[] field reaches the executor as an array", async () => {
    // The pipeline coerces `rawArgs` in place, so the handler (which, in the
    // engine, invokes the registered executor with `request.toolCall.args`)
    // receives the coerced array.
    const d = deps();
    const mw = createDecisionMiddleware(d, ORCH, async () => ({ decision: "allow" as const }));
    let seenArgs: Record<string, unknown> | undefined;
    const request = { toolCall: { name: "save_memory", args: { title: "t", keywords: "a, b ,,c" }, id: "save_memory-1" }, state: { messages: [] } };
    const handler = async (req: { toolCall: { args: Record<string, unknown> } }) => {
      seenArgs = req.toolCall.args;
      return new ToolMessage({ content: "saved", tool_call_id: "save_memory-1", status: "success" as const });
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await (mw as any).wrapToolCall(request, handler)) as ToolMessage;
    expect(result.status).not.toBe("error");
    expect(seenArgs!["keywords"]).toEqual(["a", "b", "c"]);
  });

  it("the tool's bound schema is UNCHANGED by the coercion (still rejects a comma string when parsed directly)", () => {
    // The model-bound schema never learned to accept a string for keywords; the
    // pipeline coerces, the schema itself is untouched.
    expect(KW_SCHEMA.safeParse({ title: "t", keywords: "a,b" }).success).toBe(false);
    expect(KW_SCHEMA.safeParse({ title: "t", keywords: ["a", "b"] }).success).toBe(true);
  });

  it("a non-string / non-array value is left untouched (number stays, fails the schema → invalid args)", async () => {
    const { result } = await run(deps(), ORCH, "save_memory", { title: "t", keywords: 5 as unknown as string });
    expect(result.status).toBe("error");
    expect(String(result.content)).toMatch(/^Error: invalid arguments for save_memory: keywords: /);
  });
});

describe("§8.1 — every STARTED in a turn has a paired FINISHED (id pairing)", () => {
  it("across a mixed turn (ok, denied, unknown, invalid) every id is bracketed exactly once", async () => {
    const d = deps();
    const events: Ev[] = [];
    d.bus.subscribe("*", (e) => events.push({ type: e.type, payload: e.payload as Record<string, unknown> }));
    const mw = createDecisionMiddleware(d, ORCH, async () => ({ decision: "allow" as const }));
    const handler = async (req: { toolCall: { id: string } }) =>
      new ToolMessage({ content: "ok", tool_call_id: req.toolCall.id, status: "success" as const });
    const calls: Array<[string, Record<string, unknown>]> = [
      ["read_file", { path: "a.ts" }],
      ["execute_command", { command: "shutdown now" }],
      ["ghost", {}],
      ["read_file", { path: 9 as unknown as string }],
    ];
    for (let i = 0; i < calls.length; i++) {
      const [name, args] = calls[i]!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (mw as any).wrapToolCall({ toolCall: { name, args, id: `c${i}` }, state: { messages: [] } }, handler);
    }
    const starts = events.filter((e) => e.type === "TOOL_STARTED");
    const finishes = events.filter((e) => e.type === "TOOL_FINISHED");
    expect(starts).toHaveLength(4);
    expect(finishes).toHaveLength(4);
    for (const s of starts) {
      expect(finishes.filter((f) => f.payload["id"] === s.payload["id"])).toHaveLength(1);
    }
  });
});
