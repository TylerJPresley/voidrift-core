/**
 * FX-F — the `/tools` panel (facade `agents.tools` → `Subagents.resolvedTools`)
 * must show the ACTIVE top-level agent's EFFECTIVE tool set: the built-ins,
 * plugin tools and approved MCP tools the agent's `tools` list resolves to, with
 * each tool's ORIGIN and whether it is allow-listed (free) or will ask. The bug
 * was that `["*"]` never expanded (a plain Set match) and the resolver ignored
 * the registry, so every panel read `[]` ("(nothing to show)").
 *
 * Offline/deterministic: a `ToolRegistry` seeded with the built-ins plus one
 * plugin and one bindable MCP tool; no model, no network, no worktree.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import os from "node:os";
import path from "node:path";
import { Guardian, builtinGuardrails } from "../entities/guardian.js";
import { Warden } from "../entities/warden.js";
import { EventBus } from "../entities/event-bus.js";
import { ToolRegistry } from "../entities/tool-registry.js";
import { builtinToolDefinitions } from "../tools/builtin.js";
import { ConfigSchema, type Config } from "../config/schema.js";
import { seededPermissionsRecord } from "../test-support/seed-rules.js";
import type { VcsPort, Worktree, MergeResult } from "../entities/ports/vcs-port.js";
import { Subagents, type SubagentsDeps } from "./subagents.js";
import type { AgentDefinition } from "../entities/subagents.js";

/** A no-op VCS — the panel resolver never creates a worktree. */
class NoVcs implements VcsPort {
  isRepo(): boolean {
    return false;
  }
  async createWorktree(): Promise<Worktree> {
    throw new Error("unused");
  }
  async removeWorktree(): Promise<void> {}
  async mergeWorktree(): Promise<MergeResult> {
    return { status: "clean", conflicts: [] };
  }
  async currentBranch(): Promise<string> {
    return "main";
  }
  async startBranchWatch(): Promise<void> {}
  async bootCleanup(): Promise<string[]> {
    return [];
  }
}

function cfg(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({ permissions: seededPermissionsRecord(), ...overrides });
}

/** The built-ins plus one plugin tool and one bindable (approved) MCP tool. */
function registryWithExtras(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const t of builtinToolDefinitions()) reg.register(t.def, t.exec);
  reg.register(
    { name: "plan_set", description: "plugin tool", schema: z.object({}), readOnly: false, origin: "plugin" },
    async () => ({ content: "", status: "success" }),
  );
  reg.register(
    { name: "mcp_fs_read", description: "mcp tool", schema: z.object({}), readOnly: true, origin: "mcp" },
    async () => ({ content: "", status: "success" }),
    true,
  );
  return reg;
}

function deps(partial: Partial<SubagentsDeps> = {}): SubagentsDeps {
  const bus = new EventBus();
  return {
    chatModel: new FakeListChatModel({ responses: ["done"] }),
    guardian: new Guardian(builtinGuardrails()),
    warden: new Warden({ mode: "off" }),
    bus,
    staging: {} as never,
    registry: registryWithExtras(),
    tempDir: path.join(os.tmpdir(), "no-such"),
    window: 32_000,
    getConfig: () => cfg(),
    workspaceRoot: path.join(os.tmpdir(), "fxf-ws"),
    sessionId: "orchestrator",
    interactive: true,
    vcs: new NoVcs(),
    ...partial,
  };
}

const chatAgent: AgentDefinition = { name: "chat", description: "d", kind: "top-level", systemPrompt: "", tools: ["*"], workers: "all", unlisted: "ask" };
const researchAgent: AgentDefinition = { name: "research", description: "d", kind: "top-level", systemPrompt: "", tools: ["*"], workers: "all", unlisted: "deny" };

describe("FX-F — /tools panel resolves the active agent's effective tools", () => {
  let sa: Subagents;
  beforeEach(() => {
    sa = new Subagents(deps());
  });

  it("a [\"*\"] agent (chat) expands to a NON-EMPTY tool set — not []", () => {
    sa.register(chatAgent);
    const names = sa.resolvedTools("chat").map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
  });

  it("research ([\"*\"]) is non-empty too", () => {
    sa.register(researchAgent);
    expect(sa.resolvedTools("research").length).toBeGreaterThan(0);
  });

  it("includes plugin and MCP tools, each with its origin", () => {
    sa.register(chatAgent);
    const rows = sa.resolvedTools("chat");
    expect(rows.find((t) => t.name === "plan_set")?.origin).toBe("plugin");
    expect(rows.find((t) => t.name === "mcp_fs_read")?.origin).toBe("mcp");
    expect(rows.find((t) => t.name === "read_file")?.origin).toBe("builtin");
  });

  it("tags each tool allow-listed vs ask (seeded read-class free, un-listed write asks)", () => {
    sa.register(chatAgent);
    const rows = sa.resolvedTools("chat");
    expect(rows.find((t) => t.name === "read_file")?.status).toBe("allow");
    expect(rows.find((t) => t.name === "write_file")?.status).toBe("ask");
  });

  it("honors an exact name and a glob entry (mcp_*) — not just \"*\"", () => {
    sa.register({ name: "narrow", description: "d", kind: "top-level", systemPrompt: "", tools: ["read_file", "mcp_*"], workers: "all", unlisted: "ask" });
    const names = sa.resolvedTools("narrow").map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("mcp_fs_read");
    expect(names).not.toContain("write_file");
  });

  it("an unknown agent resolves to [] (unchanged)", () => {
    expect(sa.resolvedTools("ghost")).toEqual([]);
  });
});
