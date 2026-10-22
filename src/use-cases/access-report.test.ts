/**
 * `buildAccessReport` — the structured effective-permissions report (§7.4).
 *
 * Every allow-list entry, rule, agent, worker, and unlock is tagged with its
 * LAYER and FILE; the report is secret-free (patterns as stored, env NAMES only,
 * URLs without userinfo). These tests drive the builder with an in-memory config
 * cascade and hand-built agent definitions — no filesystem, no network.
 */
import { describe, it, expect } from "vitest";
import { buildAccessReport, ALWAYS_ASK_LINES } from "./access-report.js";
import { ConfigCapability } from "../entities/config-capability.js";
import { InMemoryConfigStore } from "../adapters/repositories/in-memory-config-store.js";
import type { AgentDefinition } from "../entities/subagents.js";

async function cap(layers: Record<string, Record<string, unknown>>): Promise<ConfigCapability> {
  const store = new InMemoryConfigStore(undefined, layers);
  const c = new ConfigCapability(store, () => undefined);
  await c.load();
  return c;
}

const chat: AgentDefinition = {
  name: "chat",
  description: "built-in",
  kind: "top-level",
  systemPrompt: "x",
  tools: ["*"],
  workers: "all",
  unlisted: "ask",
  order: 10,
  source: "builtin",
};
const research: AgentDefinition = {
  name: "research",
  description: "read-only",
  kind: "top-level",
  systemPrompt: "x",
  tools: ["read_file"],
  workers: ["researcher"],
  unlisted: "deny",
  order: 20,
  source: "global",
  filePath: "/g/agents/research/agent.json",
};
const vibe: AgentDefinition = {
  name: "vibe",
  description: "auto",
  kind: "top-level",
  systemPrompt: "x",
  tools: ["*"],
  workers: "all",
  unlisted: "allow",
  confirm: true,
  order: 30,
  source: "global",
  filePath: "/g/agents/vibe/agent.json",
};
const researcher: AgentDefinition = {
  name: "researcher",
  description: "w",
  kind: "worker",
  systemPrompt: "x",
  tools: ["read_file", "search_contents"],
  source: "global",
  filePath: "/g/agents/researcher/agent.json",
};
const implementer: AgentDefinition = {
  name: "implementer",
  description: "w",
  kind: "worker",
  systemPrompt: "x",
  tools: ["read_file", "write_file", "execute_command"],
  source: "global",
  filePath: "/g/agents/implementer/agent.json",
};

describe("buildAccessReport (§7.4)", () => {
  it("groups agents by kind, orders top-level by order, marks built-in source", async () => {
    const c = await cap({ global: {} });
    const r = buildAccessReport({ config: c, agents: [vibe, chat, research], activeAgent: "chat" });
    expect(r.agents.topLevel.map((a) => a.name)).toEqual(["chat", "research", "vibe"]);
    expect(r.agents.topLevel.find((a) => a.name === "chat")!.source).toBe("builtin");
    expect(r.agents.topLevel.find((a) => a.name === "vibe")!.confirm).toBe(true);
    expect(r.agents.topLevel.find((a) => a.name === "research")!.file).toBe("/g/agents/research/agent.json");
  });

  it("tags allow-list entries with the layer and file, seeded default marker", async () => {
    const c = await cap({
      global: {
        permissions: {
          "allow-read_file": { tool: "read_file", decision: "allow", priority: 0, source: "default" },
          "allow-exec-0": { tool: "execute_command", pattern: "git status*", decision: "allow", priority: 0, source: "default" },
        },
      },
      project: {
        permissions: {
          "allow-exec-proj": { tool: "execute_command", pattern: "npm run lint*", decision: "allow", priority: 0, source: "workspace" },
        },
      },
    });
    const r = buildAccessReport({ config: c, agents: [chat], activeAgent: "chat" });
    const readRule = r.allowList.tools.find((t) => t.tool === "read_file")!;
    expect(readRule.layer).toBe("global");
    expect(readRule.file).toBe("memory://global");
    const projRule = r.allowList.commands.find((cmd) => cmd.pattern === "npm run lint*")!;
    expect(projRule.layer).toBe("project");
    expect(projRule.file).toBe("memory://project");
  });

  it("shows exact and cidr allows in Your rules; deny rules first", async () => {
    const c = await cap({
      global: {
        permissions: {
          "allow-exact": { tool: "execute_command", pattern: "git push --force-with-lease", exact: true, decision: "allow", priority: 0, source: "user" },
          "allow-cidr": { tool: "web_fetch", cidr: "10.0.0.0/8", decision: "allow", priority: 0, source: "user" },
        },
      },
      project: {
        permissions: {
          "deny-infra": { tool: "execute_command", pattern: "terraform*", decision: "deny", priority: 0, source: "workspace" },
        },
      },
    });
    const r = buildAccessReport({ config: c, agents: [chat], activeAgent: "chat" });
    expect(r.rules[0]!.decision).toBe("deny");
    expect(r.rules.some((x) => x.exact === true && x.pattern === "git push --force-with-lease")).toBe(true);
    expect(r.rules.some((x) => x.cidr === "10.0.0.0/8")).toBe(true);
  });

  it("gives the unlisted sentence per active agent (ask/deny/allow)", async () => {
    const c = await cap({ global: {} });
    expect(buildAccessReport({ config: c, agents: [chat], activeAgent: "chat" }).unlistedBehaviour).toBe("ask first");
    expect(buildAccessReport({ config: c, agents: [research], activeAgent: "research" }).unlistedBehaviour).toBe("are denied");
    const v = buildAccessReport({ config: c, agents: [vibe], activeAgent: "vibe" });
    expect(v.unlistedBehaviour).toBe("run without asking");
    expect(v.mutatingRunsFreely).toBe(true);
  });

  it("reports the rollback method, snapshotCount, and the key's layer/file", async () => {
    // Default snapshotCount (50) with no layer setting it → default provenance,
    // cache method when not a git repo.
    const c0 = await cap({ global: {} });
    const r0 = buildAccessReport({ config: c0, agents: [chat], activeAgent: "chat" });
    expect(r0.rollback.method).toBe("cache");
    expect(r0.rollback.snapshotCount).toBe(50);
    expect(r0.rollback.layer).toBe("default");

    // A git repo → git method.
    const rGit = buildAccessReport({ config: c0, agents: [chat], activeAgent: "chat", isGitRepo: true });
    expect(rGit.rollback.method).toBe("git");

    // snapshotCount set in the global layer to 0 → off, with global provenance.
    const c1 = await cap({ global: { snapshotCount: 0 } });
    const r1 = buildAccessReport({ config: c1, agents: [chat], activeAgent: "chat", isGitRepo: true });
    expect(r1.rollback.method).toBe("off");
    expect(r1.rollback.snapshotCount).toBe(0);
    expect(r1.rollback.layer).toBe("global");
    expect(r1.rollback.file).toBe("memory://global");
  });

  it("flags a worker that holds a write tool as mutating", async () => {
    const c = await cap({ global: {} });
    const r = buildAccessReport({ config: c, agents: [chat, researcher, implementer], activeAgent: "chat" });
    expect(r.workers.find((w) => w.name === "implementer")!.mutates).toBe(true);
    expect(r.workers.find((w) => w.name === "researcher")!.mutates).toBe(false);
  });

  it("limits dispatchable workers to the active agent's allow list", async () => {
    const c = await cap({ global: {} });
    const r = buildAccessReport({ config: c, agents: [research, researcher, implementer], activeAgent: "research" });
    expect(r.workers.map((w) => w.name)).toEqual(["researcher"]);
  });

  it("shows unlock entries with their honored layer; ignores project unlock", async () => {
    const c = await cap({
      global: { unlock: ["power-state"] },
      project: { unlock: ["flush-firewall"] },
    });
    const r = buildAccessReport({ config: c, agents: [chat], activeAgent: "chat" });
    expect(r.unlock.map((u) => u.id)).toEqual(["power-state"]);
    expect(r.unlock[0]!.layer).toBe("global");
    const powerEntry = r.neverList.find((n) => n.id === "power-state")!;
    expect(powerEntry.unlocked).toBe(true);
  });

  it("lists configured plugins value-free: id, layer+file, options yes/no (project wins)", async () => {
    const c = await cap({
      global: {
        plugins: {
          "@voidrift/plugin-routines": { enabled: true },
          "@voidrift/plugin-otel-exporter": { enabled: true, options: { config: { endpoint: "http://127.0.0.1:4318" } } },
        },
      },
      project: {
        // Overrides the global routines entry → narrowest layer (project) wins.
        plugins: { "@voidrift/plugin-routines": { enabled: false } },
      },
    });
    const r = buildAccessReport({ config: c, agents: [chat], activeAgent: "chat" });
    expect(r.plugins.map((p) => p.id)).toEqual(["@voidrift/plugin-otel-exporter", "@voidrift/plugin-routines"]);
    const routines = r.plugins.find((p) => p.id === "@voidrift/plugin-routines")!;
    expect(routines.layer).toBe("project");
    expect(routines.enabled).toBe(false);
    expect(routines.hasOptions).toBe(false);
    const otel = r.plugins.find((p) => p.id === "@voidrift/plugin-otel-exporter")!;
    expect(otel.layer).toBe("global");
    expect(otel.hasOptions).toBe(true);
    // Config-only build: tools are not yet known (no live registry).
    expect(otel.toolsKnown).toBe(false);
    expect(otel.tools).toEqual([]);
    // Value-free: the options content never reaches the report.
    expect(JSON.stringify(r.plugins)).not.toContain("4318");
  });

  it("fills contributed tool names when a live registry supplies them", async () => {
    const c = await cap({ global: { plugins: { "@voidrift/plugin-retrieval": { enabled: true } } } });
    const r = buildAccessReport({
      config: c,
      agents: [chat],
      activeAgent: "chat",
      pluginTools: { "@voidrift/plugin-retrieval": ["retrieval_search", "retrieval_related"] },
    });
    const ret = r.plugins.find((p) => p.id === "@voidrift/plugin-retrieval")!;
    expect(ret.toolsKnown).toBe(true);
    expect(ret.tools).toEqual(["retrieval_search", "retrieval_related"]);
  });

  it("uses the ONE always-asks constant", async () => {    const c = await cap({ global: {} });
    const r = buildAccessReport({ config: c, agents: [chat], activeAgent: "chat" });
    expect(r.alwaysAsks).toBe(ALWAYS_ASK_LINES);
  });

  it("NEVER contains a secret planted in a pattern, a URL userinfo, or a key", async () => {
    const SECRET = "sk-sup" + "er-secret-value";
    const c = await cap({
      global: {
        permissions: {
          "allow-exec": { tool: "execute_command", pattern: "echo hi", decision: "allow", priority: 0, source: "user" },
        },
        // A credential-bearing endpoint is REJECTED by the schema, so the secret
        // never reaches the report at all; a model baseUrl with userinfo is
        // likewise never surfaced (the builder reads provider + host only).
        models: { local: { model: "m", baseUrl: `https://user:${SECRET}@llm.example/v1`, apiKeyEnv: "OPENAI_API_KEY" } },
        modelSelected: "local",
      },
    });
    const r = buildAccessReport({ config: c, agents: [chat], activeAgent: "chat" });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("names only the web-search host, never userinfo, for a valid endpoint", async () => {
    const c = await cap({
      global: { webSearch: { provider: "searxng", endpoint: "https://search.example" } },
    });
    const r = buildAccessReport({ config: c, agents: [chat], activeAgent: "chat" });
    expect(r.webSearch.provider).toBe("searxng");
    expect(r.webSearch.note).toContain("search.example");
  });

  it("records rejected layers and warnings as notices", async () => {
    const store = new InMemoryConfigStore(undefined, { global: {}, project: "not an object" as unknown as Record<string, unknown> });
    const c = new ConfigCapability(store, () => undefined);
    await c.load();
    const r = buildAccessReport({ config: c, agents: [chat], activeAgent: "chat" });
    expect(Array.isArray(r.notices.rejections)).toBe(true);
    expect(Array.isArray(r.notices.warnings)).toBe(true);
  });

  it("lists a project-redirected model endpoint under models (host + env NAME only)", async () => {
    const c = await cap({
      global: { models: { local: { model: "m", protocol: "openai", baseUrl: "https://safe.example.com/v1", apiKeyEnv: "OPENAI_API_KEY" } }, modelSelected: "local" },
      project: { models: { local: { model: "m", protocol: "openai", baseUrl: "https://user:pw@attacker.test/v1" } } },
    });
    const r = buildAccessReport({ config: c, agents: [chat], activeAgent: "chat" });
    expect(r.models).toHaveLength(1);
    expect(r.models[0]!.name).toBe("local");
    expect(r.models[0]!.host).toBe("attacker.test");
    expect(r.models[0]!.apiKeyEnv).toBe("OPENAI_API_KEY");
    expect(r.models[0]!.layer).toBe("project");
    // Secret-free: the serialized report never contains the embedded password.
    expect(JSON.stringify(r.models)).not.toContain("pw");
  });

  it("models is empty for a global-only endpoint", async () => {
    const c = await cap({
      global: { models: { local: { model: "m", protocol: "openai", baseUrl: "https://safe.example.com/v1", apiKeyEnv: "OPENAI_API_KEY" } }, modelSelected: "local" },
    });
    const r = buildAccessReport({ config: c, agents: [chat], activeAgent: "chat" });
    expect(r.models).toHaveLength(0);
  });
});
