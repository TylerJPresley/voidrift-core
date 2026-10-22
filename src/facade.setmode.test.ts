/**
 * session.setMode — host-only conversation-mode control (core-blueprint.md §2.7,
 * §14.6). Full `createCore` integration: mode cycle + event, idle-only refusal,
 * idempotent same-mode call, resume starts in `chat`, process-start
 * `autoApprove` starts in `vibe`, and `AUTO_APPROVE_FORBIDDEN` when the managed
 * layer forbids `vibe`, plus a send request never selecting a mode.
 */
import { describe, it, expect } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import { createCore } from "./boot.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
import { InMemoryFileSystem } from "./adapters/in-memory-filesystem.js";
import { createMemoryCheckpointer } from "./adapters/checkpointer.js";
import type { EventEnvelope } from "./entities/event-bus.js";

const seed = { models: { test: { model: "test-model", protocol: "openai", contextLimit: 32_000 } }, modelSelected: "test" };

/** Register the seeded top-level agents a `setMode` cycles over (they are
 * programmatic here since the in-memory FS carries no seeded agents folder):
 * `research` (unlisted deny), `vibe` (unlisted allow, confirm), plus a project
 * agent `audit` (unlisted ask). The built-in `chat` is always present. */
async function seedAgents(api: Awaited<ReturnType<typeof createCore>>["api"]) {
  await api.agents.create({ name: "research", description: "r", kind: "top-level", systemPrompt: "research", tools: ["*"], workers: "all", unlisted: "deny", order: 20 });
  await api.agents.create({ name: "vibe", description: "v", kind: "top-level", systemPrompt: "vibe", tools: ["*"], workers: "all", unlisted: "allow", confirm: true, order: 30 });
  await api.agents.create({ name: "audit", description: "a project agent", kind: "top-level", systemPrompt: "audit", tools: ["read_file"], workers: "all", unlisted: "ask", order: 40 });
}

async function makeCore(opts: { startAgent?: string } = {}) {
  const sessions = new InMemorySessionRepository();
  const core = await createCore({
    workspaceRoot: "/ws",
    configStore: new InMemoryConfigStore(seed),
    sessionRepository: sessions,
    checkpointer: createMemoryCheckpointer(),
    chatModelFactory: () => fakeModel().respond(new AIMessage("x")),
    ...(opts.startAgent ? { startAgent: opts.startAgent } : {}),
  });
  await seedAgents(core.api);
  return { ...core, sessions };
}

describe("session.setMode (§2.7)", () => {
  it("cycles chat→research→vibe→chat over agent names and emits SESSION_MODE_CHANGED", async () => {
    const { api } = await makeCore();
    const changes: { from: string; to: string }[] = [];
    api.events.subscribe("SESSION_MODE_CHANGED", (e: EventEnvelope) => changes.push(e.payload as { from: string; to: string }));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";

    const r1 = await api.session.setMode(id, "research");
    expect(r1.ok && r1.value).toEqual({ from: "chat", to: "research" });
    // vibe (unlisted: allow) needs confirmation.
    const r2 = await api.session.setMode(id, "vibe", { confirmed: true });
    expect(r2.ok && r2.value).toEqual({ from: "research", to: "vibe" });
    const r3 = await api.session.setMode(id, "chat");
    expect(r3.ok && r3.value).toEqual({ from: "vibe", to: "chat" });
    expect(changes).toEqual([
      { from: "chat", to: "research" },
      { from: "research", to: "vibe" },
      { from: "vibe", to: "chat" },
    ]);
  });

  it("switches to a PROJECT-defined top-level agent by name", async () => {
    const { api } = await makeCore();
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const set = await api.session.setMode(id, "audit");
    expect(set.ok && set.value).toEqual({ from: "chat", to: "audit" });
  });

  it("a same-mode call is idempotent (still returns and emits {from:to})", async () => {
    const { api } = await makeCore();
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.setMode(id, "research");
    const again = await api.session.setMode(id, "research");
    expect(again.ok && again.value).toEqual({ from: "research", to: "research" });
  });

  it("rejects an unknown session and an unknown agent name (NOT_FOUND with valid names)", async () => {
    const { api } = await makeCore();
    const miss = await api.session.setMode("zzzzzzzz", "research");
    expect(miss.ok).toBe(false);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const bad = await api.session.setMode(id, "nope");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.code).toBe("NOT_FOUND");
      // The error lists the valid top-level agent names.
      expect(bad.error.message).toContain("chat");
    }
    // An empty name is INVALID_INPUT.
    const empty = await api.session.setMode(id, "");
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe("INVALID_INPUT");
  });

  it("rejects a WORKER name — only top-level agents are switchable", async () => {
    const { api } = await makeCore();
    await api.agents.create({ name: "wk", description: "w", kind: "worker", systemPrompt: "w", tools: ["read_file"] });
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const bad = await api.session.setMode(id, "wk");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("NOT_FOUND");
  });

  it("entering a confirm:true agent requires { confirmed: true }", async () => {
    const { api } = await makeCore();
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const noConfirm = await api.session.setMode(id, "vibe");
    expect(noConfirm.ok).toBe(false);
    if (!noConfirm.ok) expect(noConfirm.error.code).toBe("CONFIRMATION_REQUIRED");
    const confirmed = await api.session.setMode(id, "vibe", { confirmed: true });
    expect(confirmed.ok).toBe(true);
  });

  it("CONFIRMATION_REQUIRED details carry the agent's provenance (source/file)", async () => {
    // A programmatically-created agent has no cascade source or agent.json path,
    // so `source` resolves to "session" and `file` is absent (§2.7/§13.5).
    const { api } = await makeCore();
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const r = await api.session.setMode(id, "vibe");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("CONFIRMATION_REQUIRED");
      const details = r.error.details as { agent?: string; source?: string; file?: string } | undefined;
      expect(details?.agent).toBe("vibe");
      expect(details?.source).toBe("session");
      expect(details?.file).toBeUndefined();
    }
  });

  it("is refused while an approval is pending → MODE_CHANGE_REFUSED", async () => {
    const sessions = new InMemorySessionRepository();
    const now = new Date().toISOString();
    const id = "aaaaaaaa";
    // Seed a persisted session carrying a pending approval; resume loads it so
    // the live session is NOT idle (session.pending.length > 0).
    await sessions.save({
      metadata: {
        id, name: "s", summary: "waiting for your approval", workspace: "/ws",
        startedAt: now, lastActiveAt: now, turnCount: 0, sizeBytes: 0, namePinned: false,
      },
      sessionRules: [],
      documents: [],
      pending: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: "p1", tool: "write_file", args: { path: "a.ts" }, choices: ["approve", "reject"], mode: "out_of_band" } as any,
      ],
      lastStatus: "waiting_for_approval",
      approvalMode: "out_of_band",
      turns: [],
    });
    const { api } = await createCore({
      workspaceRoot: "/ws",
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: sessions,
      checkpointer: createMemoryCheckpointer(),
      chatModelFactory: () => fakeModel().respond(new AIMessage("x")),
    });
    const resumed = await api.session.resume(id);
    expect(resumed.ok).toBe(true);
    const refused = await api.session.setMode(id, "research");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("MODE_CHANGE_REFUSED");
  });

  it("a resumed session starts in chat (the active agent is not persisted)", async () => {
    const { api, sessions } = await makeCore();
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.setMode(id, "research");
    const core2 = await createCore({
      workspaceRoot: "/ws",
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: sessions,
      checkpointer: createMemoryCheckpointer(),
      chatModelFactory: () => fakeModel().respond(new AIMessage("x")),
    });
    await seedAgents(core2.api);
    const resumed = await core2.api.session.resume(id);
    expect(resumed.ok).toBe(true);
    const set = await core2.api.session.setMode(id, "research");
    expect(set.ok && set.value.from).toBe("chat");
  });

  it("process-start startAgent starts a new session in that agent", async () => {
    const { api } = await makeCore({ startAgent: "research" });
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const set = await api.session.setMode(id, "chat");
    expect(set.ok && set.value.from).toBe("research");
  });

  it("a startAgent of an unlisted:allow agent (vibe) starts the session there", async () => {
    const { api } = await makeCore({ startAgent: "vibe" });
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const set = await api.session.setMode(id, "chat");
    expect(set.ok && set.value.from).toBe("vibe");
  });

  it("entering an unlisted:allow agent is forbidden when the managed layer sets autoApproveAllowed:false", async () => {
    const fs = new InMemoryFileSystem();
    fs.files.set("managed.json", JSON.stringify({ autoApproveAllowed: false }));
    const { api } = await createCore({
      workspaceRoot: "/ws",
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      checkpointer: createMemoryCheckpointer(),
      fileSystem: fs,
      managedSource: "managed.json",
      chatModelFactory: () => fakeModel().respond(new AIMessage("x")),
    });
    await seedAgents(api);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const research = await api.session.setMode(id, "research");
    expect(research.ok).toBe(true);
    const vibe = await api.session.setMode(id, "vibe", { confirmed: true });
    expect(vibe.ok).toBe(false);
    if (!vibe.ok) expect(vibe.error.code).toBe("AUTO_APPROVE_FORBIDDEN");
  });

  it("setMode is never a model-facing tool (unreachable from the model)", async () => {
    const { api } = await makeCore();
    const tools = await api.agents.tools();
    expect(tools.ok).toBe(true);
    if (tools.ok) {
      const names = tools.value.map((t) => t.name);
      expect(names).not.toContain("setMode");
      expect(names).not.toContain("session.setMode");
      expect(names).not.toContain("session_set_mode");
      // §13.9: config.init is a HOST-ONLY op, never a model tool.
      expect(names).not.toContain("init");
      expect(names).not.toContain("config.init");
      expect(names).not.toContain("config_init");
      // §13.9.2: config.doctor is likewise HOST-ONLY, never a model tool.
      expect(names).not.toContain("doctor");
      expect(names).not.toContain("config.doctor");
      expect(names).not.toContain("config_doctor");
    }
  });

  it("a send request can never select a mode or auto_approve", async () => {
    const { api } = await makeCore();
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withMode = await api.session.send(id, { input: "hi", mode: "vibe" } as any);
    expect(withMode.ok).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withAuto = await api.session.send(id, { input: "hi", approvalMode: "auto_approve" } as any);
    expect(withAuto.ok).toBe(false);
  });
});
