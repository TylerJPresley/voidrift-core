/**
 * The control-file force-ask at the ONE decision point (owner S1): posture
 * matrix. An ask-class control file (AGENTS.md, an agent prompt) is a
 * `control-file` force-ask — never auto-approved. Under `ask` it prompts; under
 * `deny` it is denied; under `allow` (vibe) it still prompts (NOT auto-approved,
 * like ssrf/plugin-install); a headless run denies-and-continues.
 */
import { describe, it, expect } from "vitest";
import { ToolMessage } from "@langchain/core/messages";
import { z } from "zod";
import { createDecisionMiddleware, type DecisionPointDeps, type CallerContext, type AskResolver } from "./decision-point.js";
import { ToolRegistry } from "../entities/tool-registry.js";
import { EventBus } from "../entities/event-bus.js";
import { Guardian, builtinGuardrails } from "../entities/guardian.js";
import { Warden } from "../entities/warden.js";
import { ConfigSchema, type Config } from "../config/schema.js";
import type { AgentDefinition } from "../entities/subagents.js";

const agent = (unlisted: "ask" | "deny" | "allow"): AgentDefinition => ({
  name: unlisted,
  description: "d",
  kind: "top-level",
  systemPrompt: "",
  tools: ["*"],
  workers: "all",
  unlisted,
  ...(unlisted === "allow" ? { confirm: true } : {}),
});

function cfg(over: Partial<Config> = {}): Config {
  return ConfigSchema.parse({ ...over });
}

function deps(over: Partial<DecisionPointDeps>): DecisionPointDeps {
  const registry = new ToolRegistry();
  registry.register(
    { name: "write_file", description: "d", schema: z.object({ path: z.string(), content: z.string() }), readOnly: false, origin: "builtin" },
    async () => ({ content: "wrote", status: "success" }),
  );
  return {
    guardian: new Guardian(builtinGuardrails()),
    warden: new Warden({ mode: "off" }),
    bus: new EventBus(),
    registry,
    getConfig: () => cfg(),
    tempDir: "/no/such",
    workspaceRoot: "/ws",
    globalConfigDir: "/home/u/.config/voidrift",
    home: "/home/u",
    window: 32_000,
    getSessionRules: () => [],
    guardrailState: () => ({ readPaths: new Set(), stalePaths: new Set() }),
    ...over,
  };
}

function run(d: DecisionPointDeps, ctx: CallerContext, resolver: AskResolver) {
  const mw = createDecisionMiddleware(d, ctx, resolver);
  const request = { toolCall: { name: "write_file", args: { path: "AGENTS.md", content: "x" }, id: "w-1" } };
  const handler = async () => new ToolMessage({ content: "executed", tool_call_id: "w-1", status: "success" as const });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mw as any).wrapToolCall(request, handler) as Promise<ToolMessage>;
}

describe("control-file force-ask — posture matrix (owner S1)", () => {
  it("ask posture: prompts the resolver with forceAskKind control-file", async () => {
    let kind: string | undefined;
    const d = deps({ getActiveAgent: () => agent("ask") });
    const res = await run(d, { sessionId: "s", approvalMode: "interactive" }, async (req) => {
      kind = req.forceAskKind;
      return { decision: "allow" as const };
    });
    expect(kind).toBe("control-file");
    expect(res.status).toBe("success");
  });

  it("deny posture: denies outright, no prompt", async () => {
    let asked = false;
    const d = deps({ getActiveAgent: () => agent("deny") });
    const res = await run(d, { sessionId: "s", approvalMode: "interactive" }, async () => {
      asked = true;
      return { decision: "allow" as const };
    });
    expect(asked).toBe(false);
    expect(res.status).toBe("error");
  });

  it("allow posture (vibe): STILL prompts — a control-file force-ask is never auto-approved", async () => {
    let asked = false;
    const d = deps({ getActiveAgent: () => agent("allow") });
    const res = await run(d, { sessionId: "s", approvalMode: "interactive" }, async () => {
      asked = true;
      return { decision: "reject" as const };
    });
    expect(asked).toBe(true);
    expect(res.status).toBe("error"); // rejected → the write never ran
  });

  it("headless: denied-and-continue (the resolver rejects without asking a human)", async () => {
    const events: string[] = [];
    const bus = new EventBus();
    bus.subscribe("*", (e) => events.push(e.type));
    const d = deps({ bus, getActiveAgent: () => agent("allow") });
    // A headless resolver rejects (mirrors the engine's headless no-ask path).
    const res = await run(d, { sessionId: "s", approvalMode: "headless" }, async () => ({ decision: "reject" as const }));
    expect(res.status).toBe("error");
    expect(events).toContain("PERMISSION_DENIED");
  });

  it("deny-class control file under any posture is denied outright", async () => {
    const d = deps({ getActiveAgent: () => agent("allow") });
    const mw = createDecisionMiddleware(d, { sessionId: "s", approvalMode: "interactive" }, async () => ({ decision: "allow" as const }));
    const request = { toolCall: { name: "write_file", args: { path: ".voidrift/config.json", content: "x" }, id: "w-2" } };
    const handler = async () => new ToolMessage({ content: "x", tool_call_id: "w-2", status: "success" as const });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await (mw as any).wrapToolCall(request, handler)) as ToolMessage;
    expect(res.status).toBe("error");
    expect(String(res.content)).toMatch(/config\.set/);
  });
});
