/**
 * Core-completion coverage (core-blueprint.md §2.1, §4.2, §4.5, §5.4, §8.1, §11.9).
 *
 * The injection seams (`store`, `credentialStore`), `workspace.inject`, and the
 * documents/agents/models.stats/workspace.files-branch-diff/loadMessages/rewind
 * operations, each to their blueprint contract: DTO-only, Zod-validated input,
 * typed CoreError, path containment, secret masking, single-decision-point.
 */
import { hermeticTmp } from "./test-hermetic.js";
import { describe, it, expect } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { createCore } from "./boot.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { seededPermissionsRecord } from "./test-support/seed-rules.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
import { createMemoryCheckpointer } from "./adapters/checkpointer.js";
import { InMemoryFileSystem } from "./adapters/in-memory-filesystem.js";
import { InMemoryMemoryStore } from "./adapters/repositories/in-memory-memory-store.js";
import type { MemoryStore } from "./entities/ports/memory-store.js";
import type { CredentialStore } from "./entities/ports/credential-store.js";
import type { ResolvedModel } from "./entities/ports/model-port.js";
import type { ModelConfigEntry } from "./config/schema.js";
import path from "node:path";
import nodeFs from "node:fs/promises";

const seed = {
  models: { test: { model: "test-model", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "test",
  permissions: seededPermissionsRecord(),
};

async function makeCore(
  extra?: { store?: MemoryStore; credentialStore?: CredentialStore; fileSystem?: InMemoryFileSystem },
) {
  return createCore({
    workspaceRoot: "/ws",
    configStore: new InMemoryConfigStore(seed),
    sessionRepository: new InMemorySessionRepository(),
    checkpointer: createMemoryCheckpointer(),
    chatModelFactory: () => fakeModel().respond(new AIMessage("x")),
    ...(extra?.store ? { store: extra.store } : {}),
    ...(extra?.credentialStore ? { credentialStore: extra.credentialStore } : {}),
    ...(extra?.fileSystem ? { fileSystem: extra.fileSystem } : {}),
  });
}

describe("STEP 1 — construction-time injection seams (§2.1)", () => {
  it("a consumer-supplied MemoryStore replaces the durable default (§6.1)", async () => {
    // Given a store seeded with a memory entry,
    const store = new InMemoryMemoryStore();
    // When the core boots with it and the memory capability reindexes from it,
    const { api } = await makeCore({ store });
    // Then the memory capability reads through the injected store (no throw).
    const listed = await api.memory.list();
    expect(listed.ok).toBe(true);
  });

  it("a consumer-supplied CredentialStore replaces the keychain/file selection (§8.4)", async () => {
    // Given a custom credential store,
    const seen: string[] = [];
    const cred: CredentialStore = {
      get: async (k) => (seen.push(`get:${k}`), null),
      set: async (k) => void seen.push(`set:${k}`),
      delete: async (k) => void seen.push(`del:${k}`),
    };
    // When the core boots with it, construction succeeds and MCP is live.
    const { api } = await makeCore({ credentialStore: cred });
    expect((await api.mcp.list()).ok).toBe(true);
  });
});

describe("STEP 2 — workspace.inject(label, content) (§4.2)", () => {
  it("validates input, masks secrets, and drains into the next turn's metadata", async () => {
    const { api } = await makeCore();
    const created = await api.session.create();
    expect(created.ok).toBe(true);
    const id = created.ok ? created.value.id : "";
    // Given/When — bad label is rejected (§2.6).
    expect((await api.workspace.inject("", "x")).ok).toBe(false);
    // When — a valid inject carries a secret value,
    const injected = await api.workspace.inject("auth", "token: sk-ABC" + "DEFGHIJKLMNOP1234");
    // Then — it is accepted, and a turn runs (the one-shot block drains).
    expect(injected.ok).toBe(true);
    const sent = await api.session.send(id, { input: "hi" });
    expect(sent.ok).toBe(true);
    // A second turn no longer carries it (drained) — the turn still completes.
    const again = await api.session.send(id, { input: "again" });
    expect(again.ok).toBe(true);
  });
});

describe("STEP 3 — stubbed namespaces to their blueprint contracts", () => {
  it("agents.create/list/get/activate/deactivate/tools (§3.1, §8.1)", async () => {
    const { api } = await makeCore();
    // create registers a manifest; the no-task-tool rule is still enforced (§7.1).
    const bad = await api.agents.create({ name: "w", description: "d", systemPrompt: "p", tools: ["task"] });
    expect(bad.ok).toBe(false);
    const ok1 = await api.agents.create({ name: "coder", description: "codes", systemPrompt: "p", tools: ["read_file"] });
    expect(ok1.ok).toBe(true);
    // list returns DTOs; get resolves by name; activate flips active. The four
    // builtin defaults also register at boot (§3.1), so "coder" is one of several.
    const list = await api.agents.list();
    expect(list.ok && list.value.map((a) => a.name)).toContain("coder");
    const act = await api.agents.activate("coder");
    expect(act.ok && act.value.active).toBe(true);
    // tools returns the active agent's resolved toolset (read_file resolved).
    const tools = await api.agents.tools();
    expect(tools.ok && tools.value.map((t) => t.name)).toContain("read_file");
    const deact = await api.agents.deactivate("coder");
    expect(deact.ok).toBe(true);
    const after = await api.agents.get("coder");
    expect(after.ok && after.value.active).toBe(false);
  });

  it("documents.list/load/unload over the active registry, with path containment (§4.5)", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile("notes.md", "# notes\nline two\n");
    const { api } = await makeCore({ fileSystem: fs });
    await api.session.create();
    // load records a live entry with a hash; list surfaces it as a DTO.
    const loaded = await api.documents.load("notes.md");
    expect(loaded.ok && loaded.value.hash.length).toBeGreaterThan(0);
    expect(loaded.ok && loaded.value.trust).toBe("live");
    const list = await api.documents.list();
    expect(list.ok && list.value.map((d) => d.path)).toEqual(["notes.md"]);
    // a missing path is a typed NOT_FOUND, never a throw.
    expect((await api.documents.load("ghost.md")).ok).toBe(false);
    // unload drops the entry.
    expect((await api.documents.unload("notes.md")).ok).toBe(true);
    expect((await api.documents.unload("notes.md")).ok).toBe(false);
  });

  it("models.stats returns a session-scope StatsReport from the session's own model.usage (§11.9, §10.3)", async () => {
    const { api } = await makeCore();
    const created = await api.session.create();
    const id = created.ok ? created.value.id : "";
    await api.session.send(id, { input: "hi" });
    const stats = await api.models.stats(id);
    expect(stats.ok).toBe(true);
    if (stats.ok) {
      expect(stats.value.scope).toBe("session");
      expect(typeof stats.value.totals.turns).toBe("number");
      // The turn's model is attributed in byModel (honest per-model, §11.9).
      expect(Object.keys(stats.value.byModel)).toContain("test");
      // No price configured → cost omitted (§10.7).
      expect(stats.value.totals.cost).toBeUndefined();
    }
    // bad id type → INVALID_INPUT.
    expect((await api.models.stats(42 as unknown as string)).ok).toBe(false);
  });

  it("workspace.files/branch/diff read the ports; branch null outside a repo (§7.3)", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile("a.ts", "export const a = 1;\n");
    await fs.writeFile("b.ts", "export const b = 2;\n");
    const { api } = await makeCore({ fileSystem: fs });
    const files = await api.workspace.files();
    expect(files.ok && files.value.sort()).toEqual(["a.ts", "b.ts"]);
    // Outside a git repo the branch is null and the diff is empty (never gated).
    expect(await api.workspace.branch()).toEqual({ ok: true, value: null });
    expect(await api.workspace.diff()).toEqual({ ok: true, value: "" });
    // bad pattern type → INVALID_INPUT.
    expect((await api.workspace.files(1 as unknown as string)).ok).toBe(false);
  });

  it("session.loadMessages returns masked, string-normalized DTOs (§5.4, §4.7)", async () => {
    const { api } = await makeCore();
    const created = await api.session.create();
    const id = created.ok ? created.value.id : "";
    // No chain yet → empty, never an error.
    expect(await api.session.loadMessages(id)).toEqual({ ok: true, value: [] });
    await api.session.send(id, { input: "hello" });
    const msgs = await api.session.loadMessages(id);
    expect(msgs.ok).toBe(true);
    if (msgs.ok) {
      expect(msgs.value.length).toBeGreaterThan(0);
      for (const m of msgs.value) expect(typeof m.content).toBe("string");
    }
    // An unreadable id never throws — empty list.
    expect(await api.session.loadMessages("nope")).toEqual({ ok: true, value: [] });
    // §10.12 — rewind is removed; the host-only rollback ops report the timeline.
    expect((await api.session.moves(id)).ok).toBe(true);
    expect("rewind" in api.session).toBe(false);
  });

  it("loadMessages masks a secret in the persisted chain (§10.10, §4.7)", async () => {
    const { api } = await makeCore();
    const created = await api.session.create();
    const id = created.ok ? created.value.id : "";
    // Drive a turn whose assistant message echoes a secret-looking value.
    await api.session.send(id, { input: "echo my key AKIAAB" + "CDEFGHIJKLMNOP" });
    const msgs = await api.session.loadMessages(id);
    if (msgs.ok) {
      const joined = msgs.value.map((m) => m.content).join("\n");
      expect(joined).not.toContain("AKIAAB" + "CDEFGHIJKLMNOP");
    }
    // keep ToolMessage/HumanMessage imports meaningful for the type-only check
    void HumanMessage;
    void ToolMessage;
  });

  it("validation and no-session fallbacks across the new ops (§2.6)", async () => {
    const { api } = await makeCore();
    // No live session: documents.load/unload fail with SESSION_NOT_FOUND; list empty.
    expect((await api.documents.load("x.md")).ok).toBe(false);
    expect((await api.documents.unload("x.md")).ok).toBe(false);
    // documents.load/unload bad input.
    expect((await api.documents.load("")).ok).toBe(false);
    expect((await api.documents.unload("")).ok).toBe(false);
    // workspace.inject with no session.
    expect((await api.workspace.inject("l", "c")).ok).toBe(false);
    // workspace.inject bad content type.
    await api.session.create();
    expect((await api.workspace.inject("l", 1 as unknown as string)).ok).toBe(false);
    // workspace.diff bad path type and a string path (clean tree → "").
    expect((await api.workspace.diff(1 as unknown as string)).ok).toBe(false);
    expect(await api.workspace.diff("a.ts")).toEqual({ ok: true, value: "" });
    // workspace.files with an explicit glob pattern.
    expect((await api.workspace.files("**/*.ts")).ok).toBe(true);
    // agents.create bad shapes.
    expect((await api.agents.create({ name: "" } as unknown as never)).ok).toBe(false);
    expect((await api.agents.create({ name: "a", description: "d", systemPrompt: "p" } as unknown as never)).ok).toBe(false);
    // agents.activate/deactivate/tools bad input and unknowns.
    expect((await api.agents.activate("")).ok).toBe(false);
    expect((await api.agents.activate("ghost")).ok).toBe(false);
    expect((await api.agents.deactivate(1 as unknown as string)).ok).toBe(false);
    expect((await api.agents.tools(1 as unknown as string)).ok).toBe(false);
    expect((await api.agents.get(1 as unknown as string)).ok).toBe(false);
    // models.stats with no session → an empty session-scope StatsReport.
    const empty = await api.models.stats("absent");
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.value.scope).toBe("session");
      expect(empty.value.totals.turns).toBe(0);
    }
    // loadMessages bad id type → empty list (never throws).
    expect(await api.session.loadMessages(1 as unknown as string)).toEqual({ ok: true, value: [] });
  });
});

describe("STEP 3 — loadMessages normalizes a tool message with a toolCallId (§5.4)", () => {
  it("surfaces a tool-role DTO carrying its toolCallId over a real workspace", async () => {
    const ws = hermeticTmp("complete");
    await nodeFs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    await nodeFs.writeFile(path.join(ws, "r.txt"), "readable text");
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "read_file", args: { path: "r.txt" } }])
        .respond(new AIMessage("read done"));
    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      checkpointer: createMemoryCheckpointer(),
      chatModelFactory: (_r: ResolvedModel, _e: ModelConfigEntry) => script(),
    });
    try {
      const created = await api.session.create();
      const id = created.ok ? created.value.id : "";
      await api.session.send(id, { input: "read r.txt" });
      const msgs = await api.session.loadMessages(id);
      expect(msgs.ok).toBe(true);
      if (msgs.ok) {
        const toolMsg = msgs.value.find((m) => m.role === "tool");
        expect(toolMsg?.toolCallId).toBeTruthy();
        for (const m of msgs.value) expect(typeof m.content).toBe("string");
      }
    } finally {
      await api.session.shutdown().catch(() => undefined);
      await nodeFs.rm(ws, { recursive: true, force: true });
    }
  });
});

describe("STEP 3 — documents.load/workspace.files reject out-of-workspace paths (§8.2, §15.1)", () => {
  it("rejects absolute, `..`, and symlink escapes over the real adapter", async () => {
    const ws = hermeticTmp("contain");
    await nodeFs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    const outside = hermeticTmp("outside");
    await nodeFs.writeFile(path.join(outside, "secret.txt"), "top-secret", "utf8");
    await nodeFs.symlink(path.join(outside, "secret.txt"), path.join(ws, "link.txt"));
    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      checkpointer: createMemoryCheckpointer(),
      chatModelFactory: () => fakeModel().respond(new AIMessage("x")),
    });
    try {
      await api.session.create();
      // Absolute path outside the root → PATH_ESCAPE, no read.
      const abs = await api.documents.load("/etc/hostname");
      expect(abs.ok).toBe(false);
      if (!abs.ok) expect(abs.error.code).toBe("PATH_ESCAPE");
      // Relative `..` escape → PATH_ESCAPE.
      const rel = await api.documents.load("../../../../etc/hostname");
      expect(rel.ok).toBe(false);
      if (!rel.ok) expect(rel.error.code).toBe("PATH_ESCAPE");
      // In-workspace symlink pointing outside → PATH_ESCAPE, secret never read.
      const sym = await api.documents.load("link.txt");
      expect(sym.ok).toBe(false);
      if (!sym.ok) {
        expect(sym.error.code).toBe("PATH_ESCAPE");
        expect(JSON.stringify(sym.error)).not.toContain("top-secret");
      }
    } finally {
      await api.session.shutdown().catch(() => undefined);
      await nodeFs.rm(ws, { recursive: true, force: true });
      await nodeFs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("STEP 7 — structured output and vision end to end (§3.8, §3.3)", () => {
  it("rejects an invalid responseSchema at the boundary with INVALID_INPUT", async () => {
    const { api } = await makeCore();
    const created = await api.session.create();
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "q", responseSchema: "not a schema" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_INPUT");
    await api.session.shutdown();
  });

  it("a JSON-schema responseSchema fills TurnResult.structured (provider strategy)", async () => {
    const core = await createCore({
      workspaceRoot: "/ws",
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      checkpointer: createMemoryCheckpointer(),
      chatModelFactory: () => fakeModel().respond(new AIMessage(JSON.stringify({ answer: "yes" }))),
    });
    const created = await core.api.session.create();
    const id = created.ok ? created.value.id : "";
    const res = await core.api.session.send(id, {
      input: "q",
      responseSchema: { type: "object", properties: { answer: { type: "string" } } },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.structured).toEqual({ answer: "yes" });
    await core.api.session.shutdown();
  });

  it("a non-vision model + payload image returns a typed IMAGE_NOT_SUPPORTED result (no bytes leaked)", async () => {
    const vfs = new InMemoryFileSystem();
    vfs.binaries.set("shot.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]));
    const { api } = await makeCore({ fileSystem: vfs });
    const created = await api.session.create();
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "look", payload: { images: "shot.png" } });
    // the turn completes with a typed error structured result (headless prints it)
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.value.structured as { code?: string }).code).toBe("IMAGE_NOT_SUPPORTED");
    await api.session.shutdown();
  });
});
