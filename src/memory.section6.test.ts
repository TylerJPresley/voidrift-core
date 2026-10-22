/**
 * The §6 integration test (core-blueprint.md §6, the acceptance gate).
 *
 * Verbatim to intent, end-to-end through `createCore` with an injected in-memory
 * FileSystemPort (§15.3) and a scripted `fakeModel()` (deterministic, offline):
 *
 *  1. a `user-model` write at 2200 chars succeeds (read-back confirmed) while
 *     2201 returns MEMORY_BOUND_EXCEEDED (§6.3/§6.4);
 *  2. a non-persisting write returns MEMORY_WRITE_UNVERIFIED and emits no
 *     MEMORY_SAVED (§6.4);
 *  3. a directive-type entry loads into the Void layer every turn and a `note`
 *     surfaces only on a keyword match ranked filename > extension > keyword
 *     (§6.2, §4.6);
 *  4. AGENTS.md loads as project context, a nested file overrides a root one,
 *     and reading stops at the project bound (§6.6);
 *  5. reflection writes a suggestion written to the store ONLY after
 *     memory.suggestions.approve and never autonomously (§6.7);
 *  6. a registered memory provider receives secret-scrubbed inject/syncTurn/
 *     extract calls whose payloads carry no credential VALUES (§6.8, §10.10).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import { createCore } from "./boot.js";
import { createMemoryCheckpointer } from "./adapters/checkpointer.js";
import { InMemoryFileSystem } from "./adapters/in-memory-filesystem.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { EventBus } from "./entities/event-bus.js";
import { Memory } from "./use-cases/memory.js";
import { InMemoryMemoryStore } from "./adapters/repositories/in-memory-memory-store.js";
import { SuggestionsDirectory } from "./adapters/suggestions-directory.js";
import type { MemoryProvider, TurnContext, TurnRecord, SessionSummary, MemoryItem } from "./entities/memory/memory-provider.js";
import type { CoreAPI } from "./facade.js";

async function makeApi(fs: InMemoryFileSystem): Promise<{ api: CoreAPI; events: string[] }> {
  const { api } = await createCore({
    workspaceRoot: "/ws",
    fileSystem: fs,
    sessionRepository: new InMemorySessionRepository(),
    configStore: new InMemoryConfigStore({
      models: { local: { model: "local-model", protocol: "openai", contextLimit: 32000 } },
      modelSelected: "local",
    }),
    checkpointer: createMemoryCheckpointer(),
    chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
  });
  const events: string[] = [];
  api.events.register("TAP");
  // Tap all MEMORY_* events via a wildcard subscription at the facade.
  api.events.subscribe("*", (e) => events.push(e.type));
  return { api, events };
}

describe("§6 integration — memory, bounds, verified writes, typed loading", () => {
  let fs: InMemoryFileSystem;
  beforeEach(() => {
    fs = new InMemoryFileSystem();
  });

  it("1 — a 2200-char user-model write succeeds; 2201 returns MEMORY_BOUND_EXCEEDED (§6.3/§6.4)", async () => {
    const { api, events } = await makeApi(fs);
    const ok = await api.memory.edit({ title: "Prefs", type: "user-model", scope: "workspace", body: "x".repeat(2200) });
    expect(ok.ok).toBe(true);
    expect(events).toContain("MEMORY_SAVED");

    const over = await api.memory.edit({ title: "Prefs Big", type: "user-model", scope: "workspace", body: "x".repeat(2201) });
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.error.code).toBe("MEMORY_BOUND_EXCEEDED");
      expect(over.error.details).toMatchObject({ size: 2201, limit: 2200 });
    }
  });

  it("2 — a non-persisting write returns MEMORY_WRITE_UNVERIFIED and emits no MEMORY_SAVED (§6.4)", async () => {
    // Build a Memory directly over a store whose put is a no-op; prove the
    // verified-write contract the facade routes through.
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe("*", (e) => seen.push(e.type));
    const store = new InMemoryMemoryStore();
    store.put = async () => undefined;
    const memory = new Memory({
      store,
      bus,
      sessions: new InMemorySessionRepository(),
      suggestions: new SuggestionsDirectory(fs, ".voidrift/suggestions"),
      getBounds: () => ({ entryChars: 2200, projectChars: 8000, reflectionBatchSize: 3 }),
      discoverProjectFiles: async () => [],
    });
    const res = await memory.write({ title: "Ghost", type: "note", scope: "workspace", body: "did not persist" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("MEMORY_WRITE_UNVERIFIED");
    expect(seen).not.toContain("MEMORY_SAVED");
  });

  it("3 — a directive entry loads into the Void layer every turn; a note surfaces only on a keyword match ranked filename>extension>keyword (§6.2/§4.6)", async () => {
    const { api } = await makeApi(fs);
    await api.memory.edit({ title: "Working style", type: "user-model", scope: "workspace", body: "Be concise and direct." });
    await api.memory.edit({ title: "Plain lesson", type: "note", scope: "workspace", body: "plain", keywords: ["deploy"] });
    await api.memory.edit({ title: "Ext lesson", type: "note", scope: "workspace", body: "ext", keywords: [".ts"] });
    await api.memory.edit({ title: "File lesson", type: "note", scope: "workspace", body: "file", keywords: ["config.ts"] });

    // Reach the live Memory to observe the Void-layer seams the engine renders.
    const mem = (api as unknown as { deps: { memory: Memory } }).deps.memory;
    // Directive-beyond-identity (user-model) is always loaded into the head.
    expect(mem.directiveEntries().map((e) => e.title)).toContain("Working style");
    // A note surfaces ONLY on a keyword match, ranked filename > extension > plain.
    expect(mem.surfaceByKeywords("totally unrelated")).toEqual([]);
    const ranked = mem.surfaceByKeywords("open config.ts, a .ts file, then deploy");
    expect(ranked.map((e) => e.id)).toEqual(["file-lesson", "ext-lesson", "plain-lesson"]);
  });

  it("4 — AGENTS.md loads as project context; a nested file overrides a root one; reading stops at the project bound (§6.6)", async () => {
    await fs.writeFile("AGENTS.md", "ROOT: use spaces");
    await fs.writeFile("pkg/AGENTS.md", "NESTED: use tabs");
    const { api } = await createCore({
      workspaceRoot: "/ws",
      fileSystem: fs,
      sessionRepository: new InMemorySessionRepository(),
      configStore: new InMemoryConfigStore({
        models: { local: { model: "local-model", protocol: "openai", contextLimit: 32000 } },
        modelSelected: "local",
      }),
      checkpointer: createMemoryCheckpointer(),
      configOverrides: { memoryMaxProjectChars: 10_000 },
      chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
    });
    const mem = (api as unknown as { deps: { memory: Memory } }).deps.memory;
    const ctx = await mem.projectContext();
    expect(ctx.full).toContain("ROOT: use spaces");
    expect(ctx.full).toContain("NESTED: use tabs");
    // Most-specific-last: the nested rule wins by appearing after the root one.
    expect(ctx.full.indexOf("NESTED")).toBeGreaterThan(ctx.full.indexOf("ROOT"));

    // Reading stops at the project bound.
    const fs2 = new InMemoryFileSystem();
    await fs2.writeFile("AGENTS.md", "y".repeat(400));
    const { api: api2 } = await createCore({
      workspaceRoot: "/ws",
      fileSystem: fs2,
      sessionRepository: new InMemorySessionRepository(),
      configStore: new InMemoryConfigStore({
        models: { local: { model: "local-model", protocol: "openai", contextLimit: 32000 } },
        modelSelected: "local",
      }),
      checkpointer: createMemoryCheckpointer(),
      // §13.11 — the project bound now comes from the limits registry via the
      // injected port (the exemplar); the legacy `memoryMaxProjectChars` is
      // superseded for this bound.
      configOverrides: { limits: { memory: { projectChars: 100 } } },
      chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
    });
    const mem2 = (api2 as unknown as { deps: { memory: Memory } }).deps.memory;
    const bounded = await mem2.projectContext();
    expect(bounded.truncated).toBe(true);
    expect(bounded.limit).toBe(100);
  });

  it("5 — reflection writes a suggestion applied to the store ONLY after approve, never autonomously (§6.7)", async () => {
    const { api, events } = await makeApi(fs);
    const mem = (api as unknown as { deps: { memory: Memory } }).deps.memory;
    // Reflection with a scripted detector reading the session boundary.
    (mem as unknown as { deps: { readSessionTurns?: (id: string) => Promise<TurnRecord[]> } }).deps.readSessionTurns =
      async () => [{ sessionId: "s1", turn: 1, userInput: "ran pnpm", assistantText: "ok", toolsUsed: [] }];
    const written = await mem.reflect(
      "s1",
      () => [{ kind: "memory-note", title: "Use pnpm", body: "Always use pnpm here", keywords: ["pnpm"] }],
      () => "fixed",
    );
    expect(written).toHaveLength(1);
    // NOT written to the store autonomously.
    expect((await api.memory.list()).ok).toBe(true);
    const listBefore = await api.memory.list();
    expect(listBefore.ok && listBefore.value).toHaveLength(0);

    // Approve → now it is written to the store.
    const sugs = await api.memory.suggestions.list();
    expect(sugs.ok).toBe(true);
    const id = sugs.ok ? sugs.value[0]!.id : "";
    const approved = await api.memory.suggestions.approve(id);
    expect(approved.ok).toBe(true);
    const listAfter = await api.memory.list();
    expect(listAfter.ok && listAfter.value.map((e) => e.title)).toEqual(["Use pnpm"]);
    expect(events).toContain("MEMORY_SAVED");
  });

  it("6 — a registered memory provider receives secret-scrubbed inject/syncTurn/extract calls with no credential values (§6.8/§10.10)", async () => {
    const { api } = await makeApi(fs);
    const mem = (api as unknown as { deps: { memory: Memory } }).deps.memory;

    const injectSeen: TurnContext[] = [];
    const syncSeen: TurnRecord[] = [];
    const extractSeen: SessionSummary[] = [];
    const provider: MemoryProvider = {
      inject: async (c) => {
        injectSeen.push(c);
        return [] as MemoryItem[];
      },
      prefetch: async () => [],
      syncTurn: async (t) => void syncSeen.push(t),
      extract: async (s) => void extractSeen.push(s),
      mirrorWrite: async () => undefined,
      tools: () => [],
    };
    api.register.memoryProvider(provider);
    expect(mem.hasProvider()).toBe(true);

    const SECRET = "sk-liv" + "e-DEADBEEFCAFEBABE";
    await mem.providerInject({ sessionId: "s1", turn: 1, userInput: `token=${SECRET}` });
    await mem.providerSyncTurn({ sessionId: "s1", turn: 1, userInput: `token=${SECRET}`, assistantText: `bearer ${SECRET}`, toolsUsed: [] });
    await mem.providerExtract({ sessionId: "s1", name: "n", summary: `apikey=${SECRET}`, lastActiveAt: "t" });

    // Every provider payload went through the shared secret-mask seam, so the
    // provider receives records whose credential VALUES are redacted (§6.8/§10.10)
    // while the surrounding structure survives.
    expect(injectSeen).toHaveLength(1);
    expect(syncSeen).toHaveLength(1);
    expect(extractSeen).toHaveLength(1);
    // The named §6.8 acceptance point: no credential value reaches the provider.
    expect(JSON.stringify(injectSeen)).not.toContain(SECRET);
    expect(JSON.stringify(syncSeen)).not.toContain(SECRET);
    expect(JSON.stringify(extractSeen)).not.toContain(SECRET);
    // Structure survives the scrub (the variable name is kept, only the value hidden).
    expect(JSON.stringify(injectSeen)).toContain("token");
    // A deep copy, never the caller's object (so the detector redacts without
    // mutating harness state).
    const ctx = { sessionId: "s1", turn: 2, userInput: "x" };
    await mem.providerInject(ctx);
    expect(injectSeen[1]).not.toBe(ctx);
    expect(injectSeen[1]).toEqual(ctx);

    // A provider failure is logged as a warning and never crashes the session.
    const boom: MemoryProvider = { ...provider, inject: async () => { throw new Error("boom"); } };
    mem.setProvider(boom);
    await expect(mem.providerInject({ sessionId: "s1", turn: 3, userInput: "y" })).resolves.toEqual([]);
  });
});
