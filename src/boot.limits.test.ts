/*
 * Boot limits wiring (core-blueprint.md §13.11): createCore builds ONE
 * LimitsCapability from the layered config and injects it as the LimitsPort into
 * the use-cases. Proven through project context: AGENTS.md rides the head WHOLE
 * (tier 1, §6.6), and only when the merge cannot fit the window — the window-fit
 * test `ingest.fitFraction` × the endpoint window — does it overflow and emit a
 * LIMIT_HIT naming `ingest.fitFraction`, through the SAME port boot wired.
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
  it("AGENTS.md rides the head WHOLE when it fits the window: no overflow, no LIMIT_HIT", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile("AGENTS.md", "x".repeat(400));
    const { api } = await boot(fs);
    const hits: unknown[] = [];
    api.events.subscribe("LIMIT_HIT", (e) => hits.push(e.payload));
    const mem = (api as unknown as { deps: { memory: Memory } }).deps.memory;
    const ctx = await mem.projectContext();
    expect(ctx.overflow).toBe(false);
    expect(ctx.head).toContain("x".repeat(400));
    expect(hits.length).toBe(0);
    await api.session.shutdown();
  });

  it("an AGENTS.md too large for the window overflows and names ingest.fitFraction", async () => {
    const fs = new InMemoryFileSystem();
    // window 32000 tokens → budget = 0.4 × 32000 × 4 = 51200 chars. A larger
    // file cannot fit the window.
    await fs.writeFile("AGENTS.md", "x".repeat(60_000));
    const { api } = await boot(fs);
    const hits: { key: string }[] = [];
    api.events.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string }));
    const mem = (api as unknown as { deps: { memory: Memory } }).deps.memory;
    const ctx = await mem.projectContext();
    expect(ctx.overflow).toBe(true);
    // The full content is still kept whole.
    expect(ctx.full).toContain("x".repeat(60_000));
    const hit = hits.find((h) => h.key === "ingest.fitFraction");
    expect(hit, "a LIMIT_HIT for ingest.fitFraction should fire").toBeDefined();
    await api.session.shutdown();
  });

  it("a lower ingest.fitFraction override re-resolves the one port and forces overflow", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile("AGENTS.md", "x".repeat(40_000));
    const { api } = await boot(fs);
    const mem = (api as unknown as { deps: { memory: Memory } }).deps.memory;
    // At default fitFraction 0.4 (budget 51200) the 40k file fits.
    expect((await mem.projectContext()).overflow).toBe(false);
    // Lower the fraction via the config capability (session overlay): budget =
    // 0.01 × 32000 × 4 = 1280 chars → the 40k file cannot fit.
    const cfg = (api as unknown as { deps: { config: { setProcessOverlay: (o: Record<string, unknown>) => void } } }).deps.config;
    cfg.setProcessOverlay({ limits: { ingest: { fitFraction: 0.01 } } });
    const ctx = await mem.projectContext();
    expect(ctx.overflow).toBe(true);
    await api.session.shutdown();
  });
});
