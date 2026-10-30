/**
 * Boot limits wiring (core-blueprint.md §13.11): createCore builds ONE
 * LimitsCapability from the layered config and injects it as the LimitsPort into
 * the use-cases. Proven through the exemplar: a project `limits.memory.
 * projectChars` override changes a real project-context load (the boot-wired
 * Memory reads AGENTS.md through the injected port) and emits one LIMIT_HIT with
 * the RESOLVED value — i.e. the same port boot wired is the one in effect.
 */
import { describe, it, expect } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import { createCore } from "./boot.js";
import { InMemoryFileSystem } from "./adapters/in-memory-filesystem.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
import { createMemoryCheckpointer } from "./adapters/checkpointer.js";
import type { Memory } from "./use-cases/memory.js";

const BASE_CONFIG = {
  models: { local: { model: "local-model", protocol: "openai", contextLimit: 32000 } },
  modelSelected: "local",
};

async function boot(fs: InMemoryFileSystem, limits?: Record<string, unknown>) {
  return createCore({
    workspaceRoot: "/ws",
    fileSystem: fs,
    sessionRepository: new InMemorySessionRepository(),
    configStore: new InMemoryConfigStore(limits ? { ...BASE_CONFIG, limits } : BASE_CONFIG),
    checkpointer: createMemoryCheckpointer(),
    chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
  });
}

describe("createCore limits wiring (§13.11)", () => {
  it("a project limits.memory.projectChars override changes a real project-context load through createCore", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile("AGENTS.md", "x".repeat(400));
    const { api } = await boot(fs, { memory: { projectChars: 50 } });
    const hits: { key: string; value: number }[] = [];
    api.events.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string; value: number }));
    const mem = (api as unknown as { deps: { memory: Memory } }).deps.memory;
    const ctx = await mem.projectContext();
    // The injected port's resolved value (50) — NOT the registry default (8000) —
    // bounds the load, so the 400-char AGENTS.md is truncated.
    expect(ctx.truncated).toBe(true);
    expect(ctx.limit).toBe(50);
    const hit = hits.find((h) => h.key === "memory.projectChars");
    expect(hit, "a LIMIT_HIT for memory.projectChars should fire").toBeDefined();
    expect(hit?.value).toBe(50);
    await api.session.shutdown();
  });

  it("the fit-test default (ingest.fitFraction × window) applies when projectChars is unset: no truncation, no LIMIT_HIT", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile("AGENTS.md", "x".repeat(400));
    const { api } = await boot(fs);
    const hits: unknown[] = [];
    api.events.subscribe("LIMIT_HIT", (e) => hits.push(e.payload));
    const mem = (api as unknown as { deps: { memory: Memory } }).deps.memory;
    const ctx = await mem.projectContext();
    expect(ctx.overflow).toBe(false);
    // budget = ingest.fitFraction (0.4) × window (32000 tokens) × 4 chars.
    expect(ctx.limit).toBe(Math.floor(0.4 * 32000) * 4);
    expect(hits.length).toBe(0);
    await api.session.shutdown();
  });

  it("a config edit re-resolves the one port (CONFIG_RESOLVED): the new bound takes effect", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile("AGENTS.md", "x".repeat(400));
    const { api } = await boot(fs, { memory: { projectChars: 8000 } });
    const mem = (api as unknown as { deps: { memory: Memory } }).deps.memory;
    expect((await mem.projectContext()).overflow).toBe(false);
    // Lower the bound via the config capability (session overlay) and re-resolve.
    const cfg = (api as unknown as { deps: { config: { setProcessOverlay: (o: Record<string, unknown>) => void } } }).deps.config;
    cfg.setProcessOverlay({ limits: { memory: { projectChars: 50 } } });
    const ctx = await mem.projectContext();
    expect(ctx.truncated).toBe(true);
    expect(ctx.limit).toBe(50);
    await api.session.shutdown();
  });
});
