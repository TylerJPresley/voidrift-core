/**
 * auto_approve — the ONE decision point behaviour (core-blueprint.md §2.5,
 * §9.5). Drives the SAME shared `createDecisionMiddleware` the engine and
 * workers use (no fork, §15.1#4).
 *
 * In this mode a plain Guardian `ask` and a `"shell"` force-ask auto-answer
 * `approved` without reaching the resolver, emitting PERMISSION_RESOLVED with
 * `resolver: "auto_approve"`. It changes NOTHING else: a hard deny, the managed
 * gate, a Warden enforcing block, a guardrail, unknown-tool rejection, an SSRF
 * range, and a trust-expanding action (plugins_install) all still bind — the
 * SSRF/plugins_install force-asks fall through to the resolver and need an
 * explicit answer.
 */
import { describe, it, expect } from "vitest";
import { ToolMessage } from "@langchain/core/messages";
import { z } from "zod";
import { createDecisionMiddleware, type DecisionPointDeps, type CallerContext, type AskResolver } from "./decision-point.js";
import { ToolRegistry } from "../entities/tool-registry.js";
import { EventBus } from "../entities/event-bus.js";
import { Guardian, builtinGuardrails } from "../entities/guardian.js";
import { Warden, loadPolicy } from "../entities/warden.js";
import { ConfigSchema, type Config, type PermissionRule } from "../config/schema.js";
import type { AgentDefinition } from "../entities/subagents.js";

/** An `unlisted: allow` top-level agent — the auto-approve posture (the old
 * `vibe`). The auto-approve behaviour is now a property of this posture, not a
 * host flag (the `CoreOptions.autoApprove` alias was removed in B2). */
const VIBE: AgentDefinition = {
  name: "vibe",
  description: "d",
  kind: "top-level",
  systemPrompt: "",
  tools: ["*"],
  workers: "all",
  unlisted: "allow",
  confirm: true,
};

function cfg(over: Partial<Config> = {}): Config {
  return ConfigSchema.parse({ ...over });
}
const ctx: CallerContext = { sessionId: "s", approvalMode: "policy_only" };

function deps(over: Partial<DecisionPointDeps>): DecisionPointDeps {
  const registry = new ToolRegistry();
  registry.register(
    { name: "execute_command", description: "d", schema: z.object({ command: z.string() }), readOnly: false, origin: "builtin" },
    async () => ({ content: "ran", status: "success" }),
  );
  registry.register(
    { name: "web_fetch", description: "d", schema: z.object({ url: z.string() }), readOnly: false, origin: "builtin" },
    async () => ({ content: "fetched", status: "success" }),
  );
  registry.register(
    { name: "plugins_install", description: "d", schema: z.object({ name: z.string() }), readOnly: false, origin: "builtin" },
    async () => ({ content: "installed", status: "success" }),
  );
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
    window: 32_000,
    getSessionRules: () => [],
    guardrailState: () => ({ readPaths: new Set(), stalePaths: new Set() }),
    ...over,
  };
}

function run(
  d: DecisionPointDeps,
  name: string,
  args: Record<string, unknown>,
  resolver: AskResolver = async () => ({ decision: "allow" as const }),
) {
  const mw = createDecisionMiddleware(d, ctx, resolver);
  const request = { toolCall: { name, args, id: `${name}-1` } };
  const handler = async () => new ToolMessage({ content: "executed", tool_call_id: `${name}-1`, status: "success" as const });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mw as any).wrapToolCall(request, handler) as Promise<ToolMessage>;
}

describe("auto_approve behaviour at the ONE decision point (§9.5)", () => {
  it("auto-approves a plain ask WITHOUT calling the resolver, emitting resolver=auto_approve", async () => {
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const bus = new EventBus();
    bus.subscribe("*", (e) => events.push({ type: e.type, payload: e.payload as Record<string, unknown> }));
    let asked = false;
    const d = deps({ bus, getActiveAgent: () => VIBE });
    const res = await run(d, "write_file", { path: "a.txt", content: "x" }, async () => {
      asked = true;
      return { decision: "allow" as const };
    });
    expect(asked).toBe(false);
    expect(res.status).toBe("success");
    const resolved = events.find((e) => e.type === "PERMISSION_RESOLVED");
    expect(resolved?.payload["resolver"]).toBe("auto_approve");
    expect(resolved?.payload["decision"]).toBe("approve");
  });

  it("auto-approves a shell force-ask (dangerous command) without the resolver", async () => {
    let asked = false;
    const d = deps({ getActiveAgent: () => VIBE });
    const res = await run(d, "execute_command", { command: "git push --force" }, async () => {
      asked = true;
      return { decision: "allow" as const };
    });
    expect(asked).toBe(false);
    expect(res.status).toBe("success");
  });

  it("masks a secret in inferredPatterns on the auto-approve PERMISSION_REQUESTED (no raw secret leaves the process)", async () => {
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const bus = new EventBus();
    bus.subscribe("*", (e) => events.push({ type: e.type, payload: e.payload as Record<string, unknown> }));
    const d = deps({ bus, getActiveAgent: () => VIBE });
    const secret = "sk-ABC" + "DEF0123456789ABCDEF0123456789";
    await run(d, "execute_command", { command: `deploy --token=${secret}` });
    const requested = events.find((e) => e.type === "PERMISSION_REQUESTED");
    const patterns = (requested?.payload["inferredPatterns"] ?? []) as string[];
    expect(patterns.length).toBeGreaterThan(0);
    for (const p of patterns) expect(p).not.toContain(secret);
    // The whole-command pattern is present but masked.
    expect(patterns.some((p) => p.includes("deploy"))).toBe(true);
  });

  it("does NOT auto-approve an SSRF-range web_fetch — it still reaches the resolver (explicit answer)", async () => {
    let askedForceAskKind: string | undefined;
    const d = deps({ getActiveAgent: () => VIBE });
    const res = await run(d, "web_fetch", { url: "http://192.168.1.50/latest/meta-data/" }, async (req) => {
      askedForceAskKind = req.forceAskKind;
      return { decision: "reject" as const };
    });
    expect(askedForceAskKind).toBe("ssrf");
    expect(res.status).toBe("error"); // rejected, so the SSRF fetch never ran
  });

  it("does NOT auto-approve plugins_install — it still reaches the resolver", async () => {
    let askedForceAskKind: string | undefined;
    const d = deps({ getActiveAgent: () => VIBE });
    const res = await run(d, "plugins_install", { name: "@voidrift/plugin-x" }, async (req) => {
      askedForceAskKind = req.forceAskKind;
      return { decision: "reject" as const };
    });
    expect(askedForceAskKind).toBe("plugin-install");
    expect(res.status).toBe("error");
  });

  it("never weakens a hard deny (shellDenyPatterns)", async () => {
    const d = deps({
      getActiveAgent: () => VIBE,
      getConfig: () => cfg({ shellDenyPatterns: ["(?:\\S*/)?rm(?: .*)?"] }),
    });
    const res = await run(d, "execute_command", { command: "rm -rf /" }, async () => ({ decision: "allow" as const }));
    expect(res.status).toBe("error");
    expect(String(res.content)).toContain("permission denied");
  });

  it("never weakens an explicit deny rule on a force-ask", async () => {
    const rule: PermissionRule = { tool: "execute_command", pattern: "*", decision: "deny", priority: 500, source: "user" };
    const d = deps({ getActiveAgent: () => VIBE, getSessionRules: () => [rule] });
    const res = await run(d, "execute_command", { command: "rm -rf /" }, async () => ({ decision: "allow" as const }));
    expect(res.status).toBe("error");
  });

  it("never bypasses the managed gate", async () => {
    const d = deps({ getActiveAgent: () => VIBE, managedGate: () => ({ reason: "layer invalid" }) });
    const res = await run(d, "execute_command", { command: "rm -rf /" }, async () => ({ decision: "allow" as const }));
    expect(res.status).toBe("error");
    expect(String(res.content)).toContain("managed_layer_unavailable");
  });

  it("never bypasses a Warden enforcing block", async () => {
    const warden = new Warden({ mode: "enforcing" });
    warden.setPolicy(loadPolicy({ rules: [{ match: "execute_command", kind: "tool", effect: "block" }] }));
    const d = deps({ getActiveAgent: () => VIBE, warden });
    const res = await run(d, "execute_command", { command: "rm -rf /" }, async () => ({ decision: "allow" as const }));
    expect(res.status).toBe("error");
    expect(String(res.content)).toContain("blocked by compliance");
  });

  it("never bypasses a guardrail (protected control file)", async () => {
    const d = deps({ getActiveAgent: () => VIBE, workspaceRoot: "/ws" });
    const res = await run(d, "write_file", { path: ".voidrift/config.json", content: "x" }, async () => ({ decision: "allow" as const }));
    expect(res.status).toBe("error");
    expect(String(res.content)).toContain("protected control file");
  });

  it("never bypasses unknown-tool rejection", async () => {
    const d = deps({ getActiveAgent: () => VIBE });
    const res = await run(d, "no_such_tool", {}, async () => ({ decision: "allow" as const }));
    expect(res.status).toBe("error");
    expect(String(res.content)).toContain("unknown tool");
  });

  it("WITHOUT auto_approve, a plain ask still reaches the resolver (default behaviour unchanged)", async () => {
    let asked = false;
    const d = deps({});
    const res = await run(d, "write_file", { path: "a.txt", content: "x" }, async () => {
      asked = true;
      return { decision: "allow" as const };
    });
    expect(asked).toBe(true);
    expect(res.status).toBe("success");
  });

  it("emits PERMISSION_RESOLVED (resolver=exact_rule) when an exact rule lifts a force-ask, no prompt (owner D2c)", async () => {
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const bus = new EventBus();
    bus.subscribe("*", (e) => events.push({ type: e.type, payload: e.payload as Record<string, unknown> }));
    let asked = false;
    const rule: PermissionRule = {
      tool: "execute_command",
      pattern: "git push --force",
      exact: true,
      decision: "allow",
      priority: 0,
      source: "workspace",
    };
    const d = deps({ bus, getSessionRules: () => [rule] });
    const res = await run(d, "execute_command", { command: "git push --force" }, async () => {
      asked = true;
      return { decision: "allow" as const };
    });
    expect(asked).toBe(false); // no prompt — the exact rule lifted it
    expect(res.status).toBe("success");
    const resolved = events.find((e) => e.type === "PERMISSION_RESOLVED");
    expect(resolved?.payload["resolver"]).toBe("exact_rule");
    expect(resolved?.payload["ruleId"]).toBe("workspace:execute_command");
    expect(String(resolved?.payload["reason"])).toContain("allowed by exact rule");
    // No secret/command value is carried in the event.
    expect(JSON.stringify(resolved?.payload)).not.toContain("git push --force");
  });
});
