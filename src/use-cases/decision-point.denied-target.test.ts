/**
 * PERMISSION_DENIED carries the masked `target` (core-blueprint.md §9.5, §14.6).
 * A never-list denial and a read-only-posture denial both emit the denied
 * command/path, and a secret in the command is masked before it leaves the
 * process (§9.6/§10.10). Reuses the shared decision middleware (no fork).
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
import { Warden } from "../entities/warden.js";
import { ConfigSchema, type Config } from "../config/schema.js";
import type { AgentDefinition } from "../entities/subagents.js";
import { seededAllowRules } from "../test-support/seed-rules.js";

function cfg(over: Partial<Config> = {}): Config {
  return ConfigSchema.parse({ ...over });
}
const ctx: CallerContext = { sessionId: "s", approvalMode: "policy_only" };

function agent(name: string, unlisted: "deny" | "ask" | "allow"): AgentDefinition {
  return {
    name,
    description: "d",
    kind: "top-level",
    systemPrompt: "",
    tools: ["*"],
    workers: "all",
    unlisted,
    ...(unlisted === "allow" ? { confirm: true } : {}),
  };
}

function makeRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  const ok = async () => ({ content: "ok", status: "success" as const });
  r.register({ name: "execute_command", description: "d", schema: z.object({ command: z.string() }), readOnly: false, origin: "builtin" }, ok);
  r.register({ name: "write_file", description: "d", schema: z.object({ path: z.string(), content: z.string() }), readOnly: false, origin: "builtin" }, ok);
  return r;
}

function deps(over: Partial<DecisionPointDeps> = {}): DecisionPointDeps {
  return {
    guardian: new Guardian(builtinGuardrails()),
    warden: new Warden({ mode: "off" }),
    bus: new EventBus(),
    registry: makeRegistry(),
    getConfig: () => cfg(),
    tempDir: "/no/such",
    window: 32_000,
    getSessionRules: () => seededAllowRules(),
    guardrailState: () => ({ readPaths: new Set(), stalePaths: new Set() }),
    ...over,
  };
}

function run(d: DecisionPointDeps, name: string, args: Record<string, unknown>, resolver: AskResolver = async () => ({ decision: "allow" as const })) {
  const mw = createDecisionMiddleware(d, ctx, resolver);
  const request = { toolCall: { name, args, id: `${name}-1` } };
  const handler = async () => new ToolMessage({ content: "executed", tool_call_id: `${name}-1`, status: "success" as const });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mw as any).wrapToolCall(request, handler) as Promise<ToolMessage>;
}

describe("PERMISSION_DENIED target (§9.5, §14.6)", () => {
  it("a never-list denial emits the command as target", async () => {
    const bus = new EventBus();
    const denied: Record<string, unknown>[] = [];
    bus.subscribe("PERMISSION_DENIED", (e) => denied.push(e.payload as Record<string, unknown>));
    const res = await run(deps({ bus, getActiveAgent: () => agent("chat", "ask") }), "execute_command", { command: "shutdown now" });
    expect(res.status).toBe("error");
    expect(denied).toHaveLength(1);
    expect(denied[0]!["target"]).toBe("shutdown now");
  });

  it("masks a secret in the denied command's target", async () => {
    const bus = new EventBus();
    const denied: Record<string, unknown>[] = [];
    bus.subscribe("PERMISSION_DENIED", (e) => denied.push(e.payload as Record<string, unknown>));
    // A never-list command carrying an API-key-shaped token: the target must be
    // masked (the raw key never appears in the event).
    const key = "AKIA" + "ABCDEFGHIJKLMNOP";
    await run(deps({ bus, getActiveAgent: () => agent("chat", "ask") }), "execute_command", { command: `shutdown now # ${key}` });
    const target = String(denied[0]!["target"]);
    expect(target).not.toContain(key);
    expect(target).toContain("«redacted:");
  });

  it("a read-only-posture denial emits the target too (write under a deny agent)", async () => {
    const bus = new EventBus();
    const denied: Record<string, unknown>[] = [];
    bus.subscribe("PERMISSION_DENIED", (e) => denied.push(e.payload as Record<string, unknown>));
    const res = await run(deps({ bus, getSessionRules: () => [], getActiveAgent: () => agent("research", "deny") }), "write_file", { path: "a.ts", content: "x" });
    expect(res.status).toBe("error");
    expect(denied[0]!["cause"]).toBe("read_only_posture");
    expect(denied[0]!["target"]).toBe("a.ts");
  });
});
