/**
 * Decision-point MCP gating tests (core-blueprint.md §8.4, §9.1).
 *
 * Read-class is NOT a permission input (§9): EVERY call — a built-in read, an
 * MCP tool, a plugin tool — passes the managed-layer gate, Warden, and Guardian
 * identically. An MCP tool is ALWAYS gated (its `readOnlyHint` is a display-only
 * untrusted hint, never read-only for permission). This drives the ONE shared
 * `createDecisionMiddleware` directly (no fork, §15.1#4).
 */
import { describe, it, expect } from "vitest";
import { ToolMessage } from "@langchain/core/messages";
import { z } from "zod";
import { createDecisionMiddleware, type DecisionPointDeps, type CallerContext, type AskResolver } from "./decision-point.js";
import { ToolRegistry } from "../entities/tool-registry.js";
import { EventBus } from "../entities/event-bus.js";
import { Guardian, builtinGuardrails } from "../entities/guardian.js";
import { Warden, loadPolicy } from "../entities/warden.js";
import { ConfigSchema, type Config } from "../config/schema.js";

function cfg(over: Partial<Config> = {}): Config {
  return ConfigSchema.parse({ ...over });
}

const ctx: CallerContext = { sessionId: "s", approvalMode: "interactive" };

function deps(over: Partial<DecisionPointDeps>): DecisionPointDeps {
  const registry = new ToolRegistry();
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

/** Invoke the middleware's wrapToolCall with a crafted request + handler. */
async function run(
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

describe("§8.4 — MCP tools always pass managed gate + Warden", () => {
  it("a read-only MCP tool still passes the managed gate (denied when managed unavailable)", async () => {
    const registry = new ToolRegistry();
    registry.register({ name: "mcp_acme_search", description: "d", schema: z.object({}), readOnly: true, origin: "mcp" }, async () => ({ content: "x", status: "success" }));
    const d = deps({ registry, managedGate: () => ({ reason: "layer invalid" }) });
    const res = await run(d, "mcp_acme_search", {});
    expect(res.status).toBe("error");
    expect(String(res.content)).toContain("managed_layer_unavailable");
  });

  it("a built-in read tool is ALSO denied when the managed layer is unavailable (read-class not a permission input, §9)", async () => {
    const registry = new ToolRegistry();
    registry.register({ name: "read_file", description: "d", schema: z.object({}), readOnly: true, origin: "builtin" }, async () => ({ content: "x", status: "success" }));
    const d = deps({ registry, managedGate: () => ({ reason: "layer invalid" }) });
    const res = await run(d, "read_file", {});
    expect(res.status).toBe("error");
    expect(String(res.content)).toContain("managed_layer_unavailable");
  });

  it("a read-only MCP tool is blocked by an enforcing Warden deny (no Guardian ask, but Warden still runs)", async () => {
    const registry = new ToolRegistry();
    registry.register({ name: "mcp_acme_search", description: "d", schema: z.object({}), readOnly: true, origin: "mcp" }, async () => ({ content: "x", status: "success" }));
    const warden = new Warden({ mode: "enforcing" });
    warden.setPolicy(loadPolicy({ rules: [{ match: "mcp_acme_search", kind: "tool", effect: "block" }] }));
    const d = deps({ registry, warden });
    const res = await run(d, "mcp_acme_search", {});
    expect(res.status).toBe("error");
    expect(String(res.content)).toContain("blocked by compliance");
  });

  it("an MCP tool is ALWAYS gated at Guardian — a read-only hint never skips the ask (§8.4, §9)", async () => {
    // DELIBERATE FLIP (§8.4, decision C1.3): an MCP tool is registered
    // `readOnly: false` ALWAYS; a `readOnlyHint` is a display-only untrusted hint
    // and never a permission input, so the tool asks until an allow rule covers
    // it — the old `trust && hint → free` shortcut is gone.
    const registry = new ToolRegistry();
    registry.register({ name: "mcp_acme_search", description: "d", schema: z.object({}), readOnly: false, origin: "mcp" }, async () => ({ content: "x", status: "success" }));
    let asked = false;
    const d = deps({ registry });
    const res = await run(d, "mcp_acme_search", {}, async () => { asked = true; return { decision: "allow" as const }; });
    expect(asked).toBe(true); // always gated → asks
    expect(res.status).toBe("success");
  });

  it("an `mcp_acme_*` tool-name allow rule frees the MCP tool without a prompt (§9.2)", async () => {
    const registry = new ToolRegistry();
    registry.register({ name: "mcp_acme_search", description: "d", schema: z.object({}), readOnly: false, origin: "mcp" }, async () => ({ content: "x", status: "success" }));
    let asked = false;
    const d = deps({ registry, getSessionRules: () => [{ tool: "mcp_acme_*", decision: "allow", priority: 100, source: "user" }] });
    const res = await run(d, "mcp_acme_search", {}, async () => { asked = true; return { decision: "allow" as const }; });
    expect(asked).toBe(false); // allow rule matched → no prompt
    expect(res.status).toBe("success");
  });

  it("a non-read MCP tool is gated at Guardian (ask) and a reject denies it", async () => {
    const registry = new ToolRegistry();
    registry.register({ name: "mcp_acme_apply", description: "d", schema: z.object({}), readOnly: false, origin: "mcp" }, async () => ({ content: "x", status: "success" }));
    const d = deps({ registry });
    const res = await run(d, "mcp_acme_apply", {}, async () => ({ decision: "reject" as const }));
    expect(res.status).toBe("error");
    expect(String(res.content)).toContain("rejected");
  });

  it("a plugin tool is ALSO gated by the managed layer — denied when managed is unavailable (§9, read-class not a permission input)", async () => {
    const registry = new ToolRegistry();
    registry.register({ name: "plug_read", description: "d", schema: z.object({}), readOnly: true, origin: "plugin" }, async () => ({ content: "x", status: "success" }));
    const d = deps({ registry, managedGate: () => ({ reason: "layer invalid" }) });
    const res = await run(d, "plug_read", {});
    expect(res.status).toBe("error");
    expect(String(res.content)).toContain("managed_layer_unavailable");
  });
});
