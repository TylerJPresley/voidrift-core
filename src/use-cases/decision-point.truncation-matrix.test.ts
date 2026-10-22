/**
 * The ONE truncation / by-reference policy — the matrix test (core-blueprint.md
 * §8.3 "one policy, every path", §8.2, §7.2, §13.11).
 *
 * The external research maintained outside this repository (see core-blueprint.md §8.3)
 * found the worst real failure is TWO code paths with different caps — a second
 * path (the Gemini-CLI ACP bypass) escaped the output cap and blew the window.
 * This matrix proves VoidRift has exactly ONE gate: an oversized result produced
 * on EVERY content path — a direct built-in tool, a worker tool, an MCP tool, a
 * plugin tool, `execute_command` shell output, a `web_fetch`/`web_search`
 * result, and a `read_file` body — routes through the SAME decision-point
 * eviction helper (`applyResultPolicy`) and each yields:
 *   - a head/tail excerpt + a cache handle the model can read,
 *   - a `TOOL_RESULT_EVICTED` notice (the LIMIT_HIT / BY_REFERENCE equivalent
 *     naming the cache path),
 *   - a bounded size in the next model request (far under the window),
 *   - the FULL masked body written to the owner session's cache (readable for
 *     the current session only),
 * and NONE bypasses. Driving the shared `createDecisionMiddleware` directly (no
 * fork, §15.1#4) is exactly how each path reaches the model: the engine, the
 * MCP client, the plugin registry, and the subagents use-case all bind their
 * tools through this one middleware.
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
import { estimateTokens } from "../entities/context/budget.js";

/** A 4k window: 10% ⇒ ~400-token (~1600-char) eviction threshold. */
function cfg(over: Partial<Config> = {}): Config {
  return ConfigSchema.parse({ contextToolResultPct: 10, ...over });
}

const ctx: CallerContext = { sessionId: "sess1234", approvalMode: "interactive" };

/** An in-memory eviction cache standing in for the filesystem adapter's
 * `writeEvictedResult` — the FULL masked body lands here, keyed by (session,
 * name), and is readable back (the "current session only" read). */
function makeCache() {
  const store = new Map<string, string>();
  return {
    store,
    write: async (sessionId: string, name: string, content: string) => {
      store.set(`${sessionId}/${name}`, content);
    },
  };
}

function deps(over: Partial<DecisionPointDeps>, cache = makeCache()): DecisionPointDeps {
  const registry = new ToolRegistry();
  return {
    guardian: new Guardian(builtinGuardrails()),
    warden: new Warden({ mode: "off" }),
    bus: new EventBus(),
    registry,
    getConfig: () => cfg(),
    tempDir: "/no/such",
    window: 4_000,
    getSessionRules: () => [
      // Free every tool in the matrix so the gate reaches execute + eviction
      // (the point under test is the eviction gate, not the permission prompt).
      { tool: "*", decision: "allow", priority: 100, source: "user" },
    ],
    guardrailState: () => ({ readPaths: new Set(), stalePaths: new Set() }),
    writeEvictedResult: cache.write,
    ...over,
  };
}

async function run(
  d: DecisionPointDeps,
  name: string,
  result: ToolMessage,
  resolver: AskResolver = async () => ({ decision: "allow" as const }),
) {
  const mw = createDecisionMiddleware(d, ctx, resolver);
  const request = { toolCall: { name, args: {}, id: `${name}-1` } };
  const handler = async () => result;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mw as any).wrapToolCall(request, handler) as Promise<ToolMessage>;
}

/** One oversized body, ~40k chars over many lines (far over the ~1600-char
 * threshold), carrying a secret that MUST be masked in the handle and cache. */
const SECRET = "Authorization: Bearer sk-liv" + "e-abcdefghijklmnop1234567890";
function oversized(): string {
  return SECRET + "\n" + Array.from({ length: 4_000 }, (_, i) => `data row ${i} ${"x".repeat(10)}`).join("\n");
}

/**
 * The matrix: each entry is ONE content path, named by its origin and a
 * representative tool. The origin drives how the engine/clients register the
 * tool, but they ALL bind through this one middleware, so the gate is identical.
 */
const MATRIX: { kind: string; tool: string; origin: "builtin" | "mcp" | "plugin"; readOnly: boolean }[] = [
  { kind: "direct built-in tool", tool: "search_contents", origin: "builtin", readOnly: true },
  { kind: "execute_command shell output", tool: "execute_command", origin: "builtin", readOnly: false },
  { kind: "web_fetch result", tool: "web_fetch", origin: "builtin", readOnly: true },
  { kind: "web_search result", tool: "web_search", origin: "builtin", readOnly: true },
  { kind: "read_file body", tool: "read_file", origin: "builtin", readOnly: true },
  { kind: "MCP tool result", tool: "mcp_acme_query", origin: "mcp", readOnly: false },
  { kind: "plugin tool result", tool: "plug_report", origin: "plugin", readOnly: false },
];

describe("§8.3 — ONE truncation/by-reference policy across every content path", () => {
  for (const entry of MATRIX) {
    it(`${entry.kind} (${entry.tool}): oversized → head/tail + handle + TOOL_RESULT_EVICTED, bounded, cached, masked, none bypasses`, async () => {
      const cache = makeCache();
      const registry = new ToolRegistry();
      registry.register(
        { name: entry.tool, description: "d", schema: z.object({}).loose(), readOnly: entry.readOnly, origin: entry.origin },
        async () => ({ content: "unused", status: "success" as const }),
      );
      const evicted: { tool: string; path: string; size: number; excerpt: string }[] = [];
      const d = deps({ registry, writeEvictedResult: cache.write }, cache);
      d.bus.subscribe("TOOL_RESULT_EVICTED", (e) => evicted.push(e.payload as never));

      const body = oversized();
      const res = await run(
        d,
        entry.tool,
        new ToolMessage({ content: body, tool_call_id: `${entry.tool}-1`, status: "success", name: entry.tool }),
      );

      const handle = String(res.content);
      // 1) head/tail excerpt + a cache handle the model can read.
      expect(handle).toContain("evicted");
      expect(handle).toContain(".voidrift/cache/session/sess1234/");
      expect(handle).toMatch(/read_file/);
      expect(handle).toContain("lines omitted");
      // 2) a LIMIT_HIT/BY_REFERENCE-equivalent notice fired once naming the path.
      expect(evicted).toHaveLength(1);
      expect(evicted[0]!.path).toContain(".voidrift/cache/session/sess1234/");
      // 3) the next model request is BOUNDED — the handle is far under the window
      //    threshold and far smaller than the full body (no window blow-up).
      expect(estimateTokens(handle)).toBeLessThan(400); // < 10% of the 4k window
      expect(handle.length).toBeLessThan(body.length / 4);
      // 4) the FULL masked body is readable from the owner session's cache.
      const cached = cache.store.get(`sess1234/${res.artifact!.path.split("/").pop()}`);
      expect(cached).toBeDefined();
      expect(cached!.length).toBeGreaterThan(body.length / 2); // the whole thing, not a clip
      // 5) the artifact rides the ToolMessage but is NEVER in the model-facing text.
      expect(res.artifact).toMatchObject({ size: expect.any(Number), hash: expect.any(String) });
      expect(handle).not.toContain(res.artifact!.hash);
      // 6) the secret is masked in BOTH the handle and the cached body (§10.10).
      expect(handle).not.toContain("sk-liv" + "e-abcdefghijklmnop1234567890");
      expect(cached).not.toContain("sk-liv" + "e-abcdefghijklmnop1234567890");
      // 7) the tool name survives eviction (§8.3/§14.6 — observability/toolsUsed).
      expect(res.name).toBe(entry.tool);
    });
  }

  it("a SMALL result on any path is returned UNCHANGED (zero behavior change, no bypass either way)", async () => {
    const registry = new ToolRegistry();
    registry.register(
      { name: "mcp_acme_query", description: "d", schema: z.object({}).loose(), readOnly: false, origin: "mcp" },
      async () => ({ content: "unused", status: "success" as const }),
    );
    const evicted: unknown[] = [];
    const d = deps({ registry });
    d.bus.subscribe("TOOL_RESULT_EVICTED", (e) => evicted.push(e.payload));
    const res = await run(
      d,
      "mcp_acme_query",
      new ToolMessage({ content: "a short result", tool_call_id: "mcp_acme_query-1", status: "success", name: "mcp_acme_query" }),
    );
    expect(String(res.content)).toBe("a short result");
    expect(res.artifact).toBeUndefined();
    expect(evicted).toHaveLength(0);
  });

  it("a worker tool result routes through the SAME gate and caches under the PARENT (owner) session, not the worker", async () => {
    const cache = makeCache();
    const registry = new ToolRegistry();
    registry.register(
      { name: "search_contents", description: "d", schema: z.object({}).loose(), readOnly: true, origin: "builtin" },
      async () => ({ content: "unused", status: "success" as const }),
    );
    const workerCtx: CallerContext = { sessionId: "worker-xyz", workerId: "w1", approvalMode: "policy_only" };
    const d = deps(
      {
        registry,
        writeEvictedResult: cache.write,
        // §7 — the eviction cache owner for a worker is the PARENT session.
        evictionOwnerSessionId: () => "parent-sess",
      },
      cache,
    );
    const evicted: { path: string }[] = [];
    d.bus.subscribe("TOOL_RESULT_EVICTED", (e) => evicted.push(e.payload as never));
    const mw = createDecisionMiddleware(d, workerCtx, async () => ({ decision: "allow" as const }));
    const body = oversized();
    const handler = async () =>
      new ToolMessage({ content: body, tool_call_id: "search_contents-1", status: "success", name: "search_contents" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await (mw as any).wrapToolCall({ toolCall: { name: "search_contents", args: {}, id: "search_contents-1" } }, handler)) as ToolMessage;
    const handle = String(res.content);
    expect(handle).toContain(".voidrift/cache/session/parent-sess/");
    expect(evicted[0]!.path).toContain("parent-sess");
    // The worker's own session id never owns the blob.
    expect(cache.store.has(`worker-xyz/${res.artifact!.path.split("/").pop()}`)).toBe(false);
    expect(cache.store.has(`parent-sess/${res.artifact!.path.split("/").pop()}`)).toBe(true);
  });
});
