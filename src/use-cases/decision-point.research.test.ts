/**
 * research & vibe conversation modes — the ONE decision point (core-blueprint.md
 * §2.7, §9.1 step 5, §9.7). Drives the SAME shared `createDecisionMiddleware`
 * the engine and workers use (no fork, §15.1#4), via the live `getSessionMode`.
 *
 * research TIGHTENS only: reads, memory reads, safe-listed shell, and public
 * web_fetch/web_search pass WITHOUT a prompt; every write/edit/delete, a
 * non-safe command, an untrusted-MCP read tool, a plugin write tool, and
 * anything that would otherwise ask is DENIED OUTRIGHT with the read-only
 * guidance — never prompted. Hard denies, the managed gate, Warden, guardrails,
 * SSRF ranges, and masking bind exactly as in chat. vibe == auto_approve.
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
import { Warden, loadPolicy } from "../entities/warden.js";
import { ConfigSchema, type Config } from "../config/schema.js";
import type { AgentDefinition } from "../entities/subagents.js";
import { seededAllowRules } from "../test-support/seed-rules.js";

const GUIDANCE = "this agent is read-only — switch to a top-level agent that allows changes to make changes";
/** The corrected wording for a NON-write tool merely absent from the allow list
 * (FX-E): it was never about write posture. `<tool>` is interpolated. */
const notListed = (tool: string): string =>
  `"${tool}" is not on the allow list; add an allow rule or use an agent that allows it`;

/** Seeded top-level agents whose `unlisted` posture drives the decision point
 * (§2.7, §9.7): they replace the former closed chat/research/vibe modes. */
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
const RESEARCH = agent("research", "deny");
const CHAT = agent("chat", "ask");
const VIBE = agent("vibe", "allow");

function cfg(over: Partial<Config> = {}): Config {
  return ConfigSchema.parse({ ...over });
}
const ctx: CallerContext = { sessionId: "s", approvalMode: "policy_only" };

function makeRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  const ok = async () => ({ content: "ok", status: "success" as const });
  // reads (readOnly: true)
  r.register({ name: "read_file", description: "d", schema: z.object({ path: z.string() }), readOnly: true, origin: "builtin" }, ok);
  r.register({ name: "glob_files", description: "d", schema: z.object({ pattern: z.string() }), readOnly: true, origin: "builtin" }, ok);
  r.register({ name: "search_contents", description: "d", schema: z.object({ query: z.string() }), readOnly: true, origin: "builtin" }, ok);
  // writes / execute / network
  r.register({ name: "write_file", description: "d", schema: z.object({ path: z.string(), content: z.string() }), readOnly: false, origin: "builtin" }, ok);
  r.register({ name: "edit_file", description: "d", schema: z.object({ path: z.string() }), readOnly: false, origin: "builtin" }, ok);
  r.register({ name: "execute_command", description: "d", schema: z.object({ command: z.string() }), readOnly: false, origin: "builtin" }, ok);
  r.register({ name: "web_fetch", description: "d", schema: z.object({ url: z.string() }), readOnly: false, origin: "builtin" }, ok);
  r.register({ name: "web_search", description: "d", schema: z.object({ query: z.string().optional(), url: z.string().optional() }), readOnly: false, origin: "builtin" }, ok);
  r.register({ name: "plugins_install", description: "d", schema: z.object({ name: z.string() }), readOnly: false, origin: "builtin" }, ok);
  // §8.6 — the research-notes WRITE tool (readOnly: false → gated), freed by the
  // seeded allow rule so a `deny`-posture research agent runs it without a prompt.
  r.register({ name: "researcher_save_notes", description: "d", schema: z.object({ path: z.string(), content: z.string(), mode: z.enum(["create", "append"]).optional() }), readOnly: false, origin: "builtin" }, ok);
  // an UNTRUSTED MCP read tool: not read-only in the registry (trust+hint gate
  // it, §8.4), so research denies it.
  r.register({ name: "mcp_srv_list", description: "d", schema: z.object({}), readOnly: false, origin: "mcp" }, ok);
  // a plugin WRITE tool.
  r.register({ name: "plugin_do_write", description: "d", schema: z.object({}), readOnly: false, origin: "plugin" }, ok);
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
    // The seeded allow list (§13.8) is what makes the read built-ins and the
    // safe `execute_command` patterns free — read-class is NOT a permission
    // input (§9). Research still reads/fetches freely BECAUSE of these rules.
    getSessionRules: () => seededAllowRules(),
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

describe("research mode at the ONE decision point (§9.7)", () => {
  const research = (over: Partial<DecisionPointDeps> = {}) => deps({ getActiveAgent: () => RESEARCH, ...over });

  it("allows reads WITHOUT a prompt (read_file, glob_files, search_contents)", async () => {
    for (const [name, args] of [
      ["read_file", { path: "a.ts" }],
      ["glob_files", { pattern: "**/*.ts" }],
      ["search_contents", { query: "x" }],
    ] as const) {
      let asked = false;
      const res = await run(research(), name, args, async () => {
        asked = true;
        return { decision: "allow" as const };
      });
      expect(asked, name).toBe(false);
      expect(res.status, name).toBe("success");
    }
  });

  it("allows a safe-listed shell command (git status) without a prompt", async () => {
    let asked = false;
    const res = await run(research(), "execute_command", { command: "git status" }, async () => {
      asked = true;
      return { decision: "allow" as const };
    });
    expect(asked).toBe(false);
    expect(res.status).toBe("success");
  });

  it("allows a public web_fetch / web_search without a prompt", async () => {
    const fetchRes = await run(research(), "web_fetch", { url: "https://example.com/doc" });
    expect(fetchRes.status).toBe("success");
    const searchRes = await run(research(), "web_search", { query: "docs" });
    expect(searchRes.status).toBe("success");
  });

  it("allows researcher_save_notes WITHOUT a prompt under the deny posture (seeded allow rule, §8.6)", async () => {
    // The tool WRITES (readOnly: false), but the seeded allow list frees it, so
    // the read-only research agent runs it without asking — exactly like the
    // read built-ins. It is NOT denied by the deny posture because it is allowed.
    let asked = false;
    const res = await run(research(), "researcher_save_notes", { path: ".voidrift/research/q.md", content: "x" }, async () => {
      asked = true;
      return { decision: "allow" as const };
    });
    expect(asked).toBe(false);
    expect(res.status).toBe("success");
  });

  it("DENIES writes/edits/deletes with the read-only guidance, never prompting", async () => {
    const events: string[] = [];
    const bus = new EventBus();
    bus.subscribe("PERMISSION_DENIED", (e) => events.push((e.payload as { reason: string }).reason));
    for (const [name, args] of [
      ["write_file", { path: "a.ts", content: "x" }],
      ["edit_file", { path: "a.ts" }],
      ["execute_command", { command: "rm x" }],
    ] as const) {
      let asked = false;
      const res = await run(research({ bus }), name, args, async () => {
        asked = true;
        return { decision: "allow" as const };
      });
      expect(asked, name).toBe(false);
      expect(res.status, name).toBe("error");
      expect(String(res.content), name).toContain(GUIDANCE);
    }
    expect(events.every((r) => r === GUIDANCE)).toBe(true);
  });

  it("DENIES a non-safe execute_command (npm install, git commit)", async () => {
    for (const command of ["npm install", "git commit -m x"]) {
      const res = await run(research(), "execute_command", { command });
      expect(res.status, command).toBe("error");
      expect(String(res.content), command).toContain(GUIDANCE);
    }
  });

  it("DENIES an untrusted MCP read tool and a plugin write tool", async () => {
    const mcp = await run(research(), "mcp_srv_list", {});
    expect(mcp.status).toBe("error");
    expect(String(mcp.content)).toContain(GUIDANCE);
    const plug = await run(research(), "plugin_do_write", {});
    expect(plug.status).toBe("error");
    expect(String(plug.content)).toContain(GUIDANCE);
  });

  it("DENIES an unlisted read with the ALLOW-LIST wording, not the write-posture wording (FX-E)", async () => {
    // With NO seeded rules, a read is not on the allow list, so under a `deny`
    // agent it is denied outright — read-class never exempts it (§9, item 2). But
    // the message must name the allow list, not tell the model to "make changes".
    const res = await run(research({ getSessionRules: () => [] }), "read_file", { path: "a.ts" });
    expect(res.status).toBe("error");
    expect(String(res.content)).toContain(notListed("read_file"));
    expect(String(res.content)).not.toContain("make changes");
  });

  it("still REFUSES a private/metadata-range web_fetch (SSRF never relaxed)", async () => {
    const res = await run(research(), "web_fetch", { url: "http://192.168.1.50/latest/meta-data/" });
    expect(res.status).toBe("error");
    // web_fetch is a non-write tool, so the deny carries the allow-list wording.
    expect(String(res.content)).toContain(notListed("web_fetch"));
  });

  it("a cloud-metadata web_fetch is denied by the NEVER list even in research", async () => {
    const res = await run(research(), "web_fetch", { url: "http://169.254.169.254/latest/meta-data/" });
    expect(res.status).toBe("error");
    expect(String(res.content)).toContain("never list: metadata-hosts");
  });

  it("never bypasses a Warden enforcing block in research", async () => {
    const warden = new Warden({ mode: "enforcing" });
    warden.setPolicy(loadPolicy({ rules: [{ match: "read_file", kind: "tool", effect: "block" }] }));
    const res = await run(research({ warden }), "read_file", { path: "a.ts" });
    expect(res.status).toBe("error");
    expect(String(res.content)).toContain("blocked by compliance");
  });

  it("never bypasses the managed gate in research", async () => {
    // The managed gate applies to every non-read (and every MCP call) BEFORE the
    // research gate, so even a would-be-allowed safe shell command is denied.
    const res = await run(research({ managedGate: () => ({ reason: "invalid" }) }), "execute_command", { command: "git status" });
    expect(res.status).toBe("error");
    expect(String(res.content)).toContain("managed_layer_unavailable");
  });

  it("switching back to chat restores the normal ask path", async () => {
    let asked = false;
    // getSessionMode returns chat → write_file reaches the resolver (an ask).
    const res = await run(deps({ getActiveAgent: () => CHAT }), "write_file", { path: "a.ts", content: "x" }, async () => {
      asked = true;
      return { decision: "allow" as const };
    });
    expect(asked).toBe(true);
    expect(res.status).toBe("success");
  });

  it("a worker inheriting a research session is denied a write too", async () => {
    const workerCtx: CallerContext = { sessionId: "s", workerId: "w1", fanoutId: "f1", approvalMode: "policy_only" };
    const mw = createDecisionMiddleware(research(), workerCtx, async () => ({ decision: "allow" as const }));
    const request = { toolCall: { name: "write_file", args: { path: "a.ts", content: "x" }, id: "w-1" } };
    const handler = async () => new ToolMessage({ content: "x", tool_call_id: "w-1", status: "success" as const });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await (mw as any).wrapToolCall(request, handler)) as ToolMessage;
    expect(res.status).toBe("error");
    expect(String(res.content)).toContain(GUIDANCE);
  });
});

describe("vibe mode == auto_approve, driven by the live session mode (§2.7, §9.5)", () => {
  it("vibe mode auto-approves a plain ask WITHOUT the process-start flag", async () => {
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const bus = new EventBus();
    bus.subscribe("*", (e) => events.push({ type: e.type, payload: e.payload as Record<string, unknown> }));
    let asked = false;
    const d = deps({ bus, getActiveAgent: () => VIBE }); // autoApprove flag NOT set
    const res = await run(d, "write_file", { path: "a.ts", content: "x" }, async () => {
      asked = true;
      return { decision: "allow" as const };
    });
    expect(asked).toBe(false);
    expect(res.status).toBe("success");
    const resolved = events.find((e) => e.type === "PERMISSION_RESOLVED");
    expect(resolved?.payload["resolver"]).toBe("auto_approve");
  });

  it("vibe still refuses an SSRF range and a plugin install (trust-expanding)", async () => {
    const d = deps({ getActiveAgent: () => VIBE });
    let kind: string | undefined;
    const res = await run(d, "web_fetch", { url: "http://127.0.0.1/" }, async (req) => {
      kind = req.forceAskKind;
      return { decision: "reject" as const };
    });
    expect(kind).toBe("ssrf");
    expect(res.status).toBe("error");
  });
});
