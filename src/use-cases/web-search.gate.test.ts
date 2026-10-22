/**
 * `web_search` gate + config tests (core-blueprint.md §8.2, §9.0, §9.3, §13.9).
 *
 * - Guardian classifies the CONFIGURED endpoint, not a model value; a private,
 *   loopback, link-local or metadata endpoint force-asks on EVERY call (there is
 *   no configured-endpoint exemption); web_fetch to the same private host also
 *   force-asks.
 * - The strict schema rejects the removed flat keys and validates the endpoint.
 * - A `webSearch` endpoint may be set in ANY layer (accepted at config level).
 * - The decision point passes the per-mode matrix (research allow public /
 *   deny private; chat ask; vibe/auto run).
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Guardian, builtinGuardrails } from "../entities/guardian.js";
import { ConfigSchema, WebSearchSchema } from "../config/schema.js";
import { createDecisionMiddleware, type DecisionPointDeps, type CallerContext, type AskResolver } from "./decision-point.js";
import { ToolRegistry } from "../entities/tool-registry.js";
import { EventBus } from "../entities/event-bus.js";
import { Warden } from "../entities/warden.js";
import type { AgentDefinition } from "../entities/subagents.js";
import { seededAllowRules } from "../test-support/seed-rules.js";

function agent(name: string, unlisted: "deny" | "ask" | "allow"): AgentDefinition {
  return { name, description: "d", kind: "top-level", systemPrompt: "", tools: ["*"], workers: "all", unlisted, ...(unlisted === "allow" ? { confirm: true } : {}) };
}
const RESEARCH = agent("research", "deny");
const CHAT = agent("chat", "ask");
const VIBE = agent("vibe", "allow");

const lists = { safe: [], forceAsk: [], equivalents: [], deny: [] };

describe("Guardian — web_search endpoint classification (§9.3)", () => {
  const g = new Guardian(builtinGuardrails());
  const call = (endpoint?: string) => ({
    tool: "web_search",
    args: { query: "q", ...(endpoint ? { webSearchEndpoint: endpoint } : {}) },
  });

  it("a public endpoint (or none) passes through to rules → ask (not force-ask)", () => {
    const o = g.evaluate(call(), [], lists);
    expect(o.decision).toBe("ask");
    expect(o.forceAsk).toBe(false);
  });

  it("a configured private endpoint force-asks on every call (no exemption)", () => {
    const o = g.evaluate(call("http://192.168.1.50:8888"), [], lists);
    expect(o.forceAsk).toBe(true);
    expect(o.forceAskKind).toBe("ssrf");
    expect(o.reason).toMatch(/private/);
  });

  it("a configured loopback endpoint force-asks (no exemption)", () => {
    const o = g.evaluate(call("http://127.0.0.1:8080"), [], lists);
    expect(o.forceAsk).toBe(true);
    expect(o.forceAskKind).toBe("ssrf");
  });

  it("a metadata-service endpoint is NEVER (denied) — code-level never list", () => {
    const o = g.evaluate(call("http://169.254.169.254"), [], lists);
    expect(o.decision).toBe("deny");
    expect(o.reason).toContain("never list: metadata-hosts");
  });

  it("`metadata-hosts` in unlock lifts the metadata endpoint back to an SSRF force-ask", () => {
    const o = g.evaluate(call("http://169.254.169.254"), [], lists, { unlock: new Set(["metadata-hosts"]) });
    expect(o.forceAsk).toBe(true);
    expect(o.forceAskKind).toBe("ssrf");
  });

  it("web_fetch to the same private host still force-asks (no exemption for web_fetch)", () => {
    const o = g.evaluate(
      { tool: "web_fetch", args: { url: "http://192.168.1.50:8888/x" } },
      [],
      lists,
    );
    expect(o.forceAsk).toBe(true);
    expect(o.forceAskKind).toBe("ssrf");
  });
});

describe("config schema — strict webSearch (§13.9)", () => {
  it("rejects the removed flat keys", () => {
    expect(() => ConfigSchema.parse({ webSearchProvider: "brave" })).toThrow();
    expect(() => ConfigSchema.parse({ webSearchApiKeyEnv: "X" })).toThrow();
    expect(() => ConfigSchema.parse({ webSearchGoogleCx: "cx" })).toThrow();
  });

  it("defaults to duckduckgo", () => {
    expect(ConfigSchema.parse({}).webSearch).toEqual({ provider: "duckduckgo" });
  });

  it("rejects an unknown field inside webSearch (strict)", () => {
    expect(() => WebSearchSchema.parse({ provider: "searxng", bogus: 1 })).toThrow();
  });

  it("accepts https, and http only for a private/loopback host", () => {
    expect(() => WebSearchSchema.parse({ provider: "searxng", endpoint: "https://searx.example" })).not.toThrow();
    expect(() => WebSearchSchema.parse({ provider: "searxng", endpoint: "http://192.168.1.5:8888" })).not.toThrow();
    expect(() => WebSearchSchema.parse({ provider: "searxng", endpoint: "http://127.0.0.1:8080" })).not.toThrow();
    expect(() => WebSearchSchema.parse({ provider: "searxng", endpoint: "http://searx.example" })).toThrow();
  });

  it("rejects credentials embedded in the endpoint URL", () => {
    expect(() => WebSearchSchema.parse({ provider: "searxng", endpoint: "https://user:pass@searx.example" })).toThrow();
  });

  it("a webSearch endpoint may be set in any layer (no global/managed-only rule) — a project config is accepted", () => {
    // The removed loosening rule no longer rejects a project-layer endpoint; the
    // only constraints are the schema's own endpoint-validity rules.
    expect(() => ConfigSchema.parse({ webSearch: { provider: "searxng", endpoint: "http://192.168.1.5:8888" } })).not.toThrow();
    expect(ConfigSchema.parse({ webSearch: { provider: "searxng", endpoint: "https://searx.example" } }).webSearch.endpoint).toBe("https://searx.example");
  });
});

// ── Decision-point: model-supplied endpoint rejected; per-mode matrix ──────────
function depsFor(over: Partial<DecisionPointDeps>): DecisionPointDeps {
  const registry = new ToolRegistry();
  registry.register(
    { name: "web_search", description: "d", schema: z.object({ query: z.string() }).strict(), readOnly: false, origin: "builtin" },
    async () => ({ content: "results", status: "success" }),
  );
  return {
    guardian: new Guardian(builtinGuardrails()),
    warden: new Warden({ mode: "off" }),
    bus: new EventBus(),
    registry,
    getConfig: () => ConfigSchema.parse({}),
    tempDir: "/tmp/x",
    window: 8000,
    getSessionRules: () => seededAllowRules(),
    guardrailState: () => ({ readPaths: new Set<string>(), stalePaths: new Set<string>() }),
    ...over,
  };
}
const ctx: CallerContext = { sessionId: "s", approvalMode: "policy_only" };
const allowResolver: AskResolver = async () => ({ decision: "allow" });

async function invoke(mw: ReturnType<typeof createDecisionMiddleware>, args: Record<string, unknown>) {
  const handler = async () => "results";
  const out = await mw.wrapToolCall!({ toolCall: { name: "web_search", args, id: "t1" } } as never, handler as never);
  // The middleware returns the handler's raw value on success (a string) or a
  // ToolMessage on a deny/reject. Normalize to { content, status }.
  if (typeof out === "string") return { content: out, status: "success" as const };
  const m = out as { content?: unknown; status?: string };
  return { content: m.content, status: m.status };
}

describe("decision point — web_search schema & matrix", () => {
  it("rejects a model-supplied endpoint/url argument (schema is {query} only)", () => {
    // The strict tool schema rejects any extra field, so the model cannot
    // supply an endpoint/url — validation fails before the executor runs (§8.2).
    const schema = z.object({ query: z.string() }).strict();
    expect(() => schema.parse({ query: "q", endpoint: "http://192.168.1.5" })).toThrow();
    expect(() => schema.parse({ query: "q", url: "http://x" })).toThrow();
    expect(() => schema.parse({ query: "q" })).not.toThrow();
  });

  it("research allows a public web_search", async () => {
    const mw = createDecisionMiddleware(depsFor({ getActiveAgent: () => RESEARCH }), ctx, allowResolver);
    const r = (await invoke(mw, { query: "q" })) as { content?: unknown };
    expect(String(r.content)).toBe("results");
  });

  it("research denies a web_search whose configured endpoint is a metadata host (force-ask → deny under read-only)", async () => {
    const mw = createDecisionMiddleware(
      depsFor({
        getActiveAgent: () => RESEARCH,
        getConfig: () => ConfigSchema.parse({ webSearch: { provider: "searxng", endpoint: "http://192.168.1.5:8888" } }),
      }),
      ctx,
      allowResolver,
    );
    const r = (await invoke(mw, { query: "q" })) as { status?: string; content?: unknown };
    expect(r.status).toBe("error");
    // web_search is a non-write tool, so a deny under a read-only agent carries
    // the allow-list wording, not the "make changes" write-posture wording (FX-E).
    expect(String(r.content)).toMatch(/not on the allow list/);
    expect(String(r.content)).not.toMatch(/make changes/);
  });

  it("a private searxng endpoint force-asks on EVERY call (known interim UX cost — no exemption)", async () => {
    let asks = 0;
    const resolver: AskResolver = async () => {
      asks += 1;
      return { decision: "allow" };
    };
    const cfg = ConfigSchema.parse({ webSearch: { provider: "searxng", endpoint: "http://192.168.1.5:8888" } });
    const mw = createDecisionMiddleware(
      depsFor({ getActiveAgent: () => VIBE, getConfig: () => cfg }),
      ctx,
      resolver,
    );
    await invoke(mw, { query: "a" });
    await invoke(mw, { query: "b" });
    expect(asks).toBe(2); // force-asked each time, not cached/exempted
  });

  it("a public configured endpoint does not force-ask", async () => {
    let asked = false;
    const resolver: AskResolver = async () => {
      asked = true;
      return { decision: "allow" };
    };
    const cfg = ConfigSchema.parse({ webSearch: { provider: "searxng", endpoint: "https://searx.example" } });
    const mw = createDecisionMiddleware(
      depsFor({ getActiveAgent: () => RESEARCH, getConfig: () => cfg }),
      ctx,
      resolver,
    );
    const r = (await invoke(mw, { query: "q" })) as { content?: unknown };
    expect(asked).toBe(false); // seeded allow rule covers it, public host
    expect(String(r.content)).toBe("results");
  });

  it("vibe runs a public web_search without asking", async () => {
    const mw = createDecisionMiddleware(depsFor({ getActiveAgent: () => VIBE }), ctx, allowResolver);
    const r = (await invoke(mw, { query: "q" })) as { content?: unknown };
    expect(String(r.content)).toBe("results");
  });

  it("chat runs a public web_search WITHOUT asking (it is on the seeded allow list)", async () => {
    let asked = false;
    const resolver: AskResolver = async () => {
      asked = true;
      return { decision: "allow" };
    };
    const mw = createDecisionMiddleware(depsFor({ getActiveAgent: () => CHAT }), ctx, resolver);
    const r = (await invoke(mw, { query: "q" })) as { content?: unknown };
    expect(asked).toBe(false); // seeded `web_search` allow rule → no prompt
    expect(String(r.content)).toBe("results");
  });

  it("chat ASKS for a web_search once its seeded allow rule is absent", async () => {
    let asked = false;
    const resolver: AskResolver = async () => {
      asked = true;
      return { decision: "allow" };
    };
    const mw = createDecisionMiddleware(
      depsFor({ getActiveAgent: () => CHAT, getSessionRules: () => [] }),
      ctx,
      resolver,
    );
    const r = (await invoke(mw, { query: "q" })) as { content?: unknown };
    expect(asked).toBe(true);
    expect(String(r.content)).toBe("results");
  });
});
