/**
 * Engine behavior tests (core-blueprint.md §3, §9.5) — approval modes and
 * failure paths over a per-test temp workspace. Deterministic and offline.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { BaseChatModel, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import path from "node:path";
import fs from "node:fs/promises";
import { createCore } from "../boot.js";
import { InMemoryConfigStore } from "../adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "../adapters/repositories/session-repository.js";
import type { ResolvedModel } from "../entities/ports/model-port.js";
import type { ModelConfigEntry } from "../config/schema.js";
import { seededPermissionsRecord } from "../test-support/seed-rules.js";

/**
 * A minimal chat model that returns a fixed first response, then throws a fixed
 * error on every subsequent call. Used to drive the confirm()/resume failure
 * path deterministically (fakeModel cannot queue a success then a throw).
 * `bindTools` returns `this` because the model emits a fixed tool call.
 */
class SequencingModel extends BaseChatModel {
  private calls = 0;
  constructor(
    private readonly first: AIMessage,
    private readonly thenThrow: Error,
    params: BaseChatModelParams = {},
  ) {
    super(params);
  }
  _llmType(): string {
    return "sequencing-fake";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    this.calls += 1;
    if (this.calls === 1) return { generations: [{ text: "", message: this.first }] };
    throw this.thenThrow;
  }
}

// The seeded allow list (§13.8) makes the read built-ins free — read-class is
// NOT a permission input (§9), so a read needs an allow rule like anything else.
const seed = {
  models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "t",
  permissions: seededPermissionsRecord(),
};

function factory(script: () => ReturnType<typeof fakeModel>) {
  return (_r: ResolvedModel, _e: ModelConfigEntry) => script();
}

/** Cores created in a test, drained in afterEach so a late best-effort obs write
 * (§10.3) never races the workspace rmdir. */
const trackedCores: { session: { shutdown: () => Promise<void> } }[] = [];
async function trackedCreateCore(opts: Parameters<typeof createCore>[0]): ReturnType<typeof createCore> {
  const ready = await createCore(opts);
  trackedCores.push(ready.api);
  return ready;
}
async function drainTrackedCores(): Promise<void> {
  for (const c of trackedCores) await c.session.shutdown().catch(() => undefined);
  trackedCores.length = 0;
}

describe("Engine approval modes (§9.5)", () => {
  let ws: string;
  beforeEach(async () => {
    ws = hermeticTmp("engine");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
  });
  afterEach(async () => {
    await drainTrackedCores();
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("interactive mode resolves an ask through onApproval and completes the turn", async () => {
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "write_file", args: { path: "i.txt", content: "yo" } }])
        .respond(new AIMessage("interactive done"));
    const { api } = await trackedCreateCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
      onApproval: async (req) => {
        expect(req.tool).toBe("write_file");
        return { requestId: req.id, decision: "approve" };
      },
    });
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "write i.txt", approvalMode: "interactive" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.status).toBe("completed");
    expect(await fs.readFile(path.join(ws, "i.txt"), "utf8")).toBe("yo");
  });

  it("policy_only fails fast on an unresolved ask → waiting_for_approval with pending, resumable (the write never runs until confirmed)", async () => {
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "write_file", args: { path: "p.txt", content: "no" } }])
        .respond(new AIMessage("after approve"));
    const { api } = await trackedCreateCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
    });
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "write", approvalMode: "policy_only" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // §2.5/§9.5 — the unresolved ask fails fast: the run ends
      // waiting_for_approval carrying the PendingApproval, NOT auto-rejected
      // and NOT auto-completed.
      expect(res.value.status).toBe("waiting_for_approval");
      expect(res.value.pending?.[0]?.tool).toBe("write_file");
      expect(res.value.pending?.[0]?.args).toMatchObject({ path: "p.txt", content: "no" });
    }
    // The pending approval survives: the write has not run.
    expect(await fs.readFile(path.join(ws, "p.txt"), "utf8").catch(() => null)).toBeNull();
    // It is durably resumable: a later confirm resolves it and the write lands.
    const reqId = res.ok ? res.value.pending![0]!.id : "";
    const done = await api.session.confirm(id, { requestId: reqId, decision: "approve" });
    expect(done.ok).toBe(true);
    if (done.ok) expect(done.value.status).toBe("completed");
    expect(await fs.readFile(path.join(ws, "p.txt"), "utf8")).toBe("no");
  });

  it("a plain policy ask carries no forceAskKind; a shell force-ask surfaces forceAskKind on the pending (§9.5)", async () => {
    // Plain ask: write_file gated by a user `ask` rule — no force-ask family.
    const plainSeed = {
      ...seed,
      permissions: { aw: { tool: "write_file", decision: "ask", priority: 100, source: "user" } },
    };
    const plain = await trackedCreateCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(plainSeed),
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(() =>
        fakeModel()
          .respondWithTools([{ name: "write_file", args: { path: "a.txt", content: "x" } }])
          .respond(new AIMessage("done")),
      ),
    });
    const pc = await plain.api.session.create({});
    const pcid = pc.ok ? pc.value.id : "";
    const pres = await plain.api.session.send(pcid, { input: "write", approvalMode: "policy_only" });
    expect(pres.ok).toBe(true);
    if (pres.ok) {
      expect(pres.value.status).toBe("waiting_for_approval");
      expect(pres.value.pending?.[0]?.tool).toBe("write_file");
      // A plain ask has no force-ask family.
      expect(pres.value.pending?.[0]?.forceAskKind).toBeUndefined();
    }

    // Shell force-ask: a history-destroying `git push --force` is a §9.3 force-ask
    // (kind "shell") that names NO filesystem path, so it classifies `shell` and
    // not `outside-workspace`; even a broad allow for execute_command cannot
    // satisfy it (force-ask beats the allow).
    const shellSeed = {
      ...seed,
      permissions: {
        es: { tool: "execute_command", pattern: "*", decision: "allow", priority: 100, source: "workspace" },
      },
    };
    const shell = await trackedCreateCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(shellSeed),
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(() =>
        fakeModel()
          .respondWithTools([{ name: "execute_command", args: { command: "git push --force origin main" } }])
          .respond(new AIMessage("done")),
      ),
    });
    const sc = await shell.api.session.create({});
    const scid = sc.ok ? sc.value.id : "";
    const sres = await shell.api.session.send(scid, { input: "clean", approvalMode: "policy_only" });
    expect(sres.ok).toBe(true);
    if (sres.ok) {
      expect(sres.value.status).toBe("waiting_for_approval");
      expect(sres.value.pending?.[0]?.tool).toBe("execute_command");
      // The force-ask family rides the pending for a non-interactive host to explain.
      expect(sres.value.pending?.[0]?.forceAskKind).toBe("shell");
    }

    // Outside-workspace force-ask (§4.4/§9.3): an absolute path OUTSIDE the
    // workspace root is force-asked with kind "outside-workspace" — the agent
    // never silently reaches outside the workspace through the shell, even under
    // a broad execute_command allow.
    const ow = await trackedCreateCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(shellSeed),
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(() =>
        fakeModel()
          .respondWithTools([{ name: "execute_command", args: { command: "cat /etc/hosts" } }])
          .respond(new AIMessage("done")),
      ),
    });
    const oc = await ow.api.session.create({});
    const ocid = oc.ok ? oc.value.id : "";
    const ores = await ow.api.session.send(ocid, { input: "peek", approvalMode: "policy_only" });
    expect(ores.ok).toBe(true);
    if (ores.ok) {
      expect(ores.value.status).toBe("waiting_for_approval");
      expect(ores.value.pending?.[0]?.tool).toBe("execute_command");
      expect(ores.value.pending?.[0]?.forceAskKind).toBe("outside-workspace");
    }
  });

  it("a persisted session rule from an approval auto-approves a later identical call", async () => {
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "write_file", args: { path: "once.txt", content: "a" } }])
        .respondWithTools([{ name: "write_file", args: { path: "once.txt", content: "b" } }])
        .respond(new AIMessage("twice done"));
    const { api } = await trackedCreateCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
      onApproval: async (req) => ({
        requestId: req.id,
        decision: "approve",
        remember: "session",
        chosenPattern: "once.txt",
      }),
    });
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "write twice", approvalMode: "interactive" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.status).toBe("completed");
    // The second identical write auto-approved via the persisted session rule.
    expect(await fs.readFile(path.join(ws, "once.txt"), "utf8")).toBe("b");
  });

  it("a persisted SESSION rule for an MCP tool is a TOOL-NAME glob that frees later matching MCP calls (§8.4, §9.2)", async () => {
    // An MCP/plugin tool has no command/path/url value, so its persisted rule is
    // a tool-name glob in the `tool` FIELD (no `pattern`). A later call to ANY
    // tool of that server auto-approves without a second prompt.
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "mcp_acme_apply", args: { x: 1 } }])
        .respondWithTools([{ name: "mcp_acme_list", args: {} }])
        .respond(new AIMessage("twice done"));
    const added: { tool: string; pattern?: string }[] = [];
    let prompts = 0;
    const { api } = await trackedCreateCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
      onApproval: async (req) => {
        prompts++;
        return { requestId: req.id, decision: "approve", remember: "session", chosenPattern: "mcp_acme_*" };
      },
    });
    // Register two MCP-origin tools (no server/connection needed for the gate path).
    api.register.tool(
      { name: "mcp_acme_apply", description: "d", schema: { parse: (v: unknown) => v } as never, readOnly: false, origin: "mcp" },
      async () => ({ content: "applied", status: "success" }),
    );
    api.register.tool(
      { name: "mcp_acme_list", description: "d", schema: { parse: (v: unknown) => v } as never, readOnly: false, origin: "mcp" },
      async () => ({ content: "listed", status: "success" }),
    );
    api.events.subscribe("PERMISSION_RULE_ADDED", (e) => added.push(e.payload as { tool: string; pattern?: string }));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "two mcp calls", approvalMode: "interactive" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.status).toBe("completed");
    // Exactly ONE prompt — the first apply; the second (a DIFFERENT tool of the
    // same server) was covered by the persisted `mcp_acme_*` tool-name rule.
    expect(prompts).toBe(1);
    // The persisted rule is a tool-name glob (the `tool` field), with NO pattern.
    expect(added).toHaveLength(1);
    expect(added[0]!.tool).toBe("mcp_acme_*");
    expect(added[0]!.pattern).toBeUndefined();
  });

  it("a model error ends the turn as failed with ERROR_OCCURRED", async () => {
    const script = () => fakeModel(); // empty queue → throws when invoked
    const { api } = await trackedCreateCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
    });
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    let errored = false;
    api.events.subscribe("ERROR_OCCURRED", () => (errored = true));
    const res = await api.session.send(id, { input: "go" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.status).toBe("failed");
    expect(errored).toBe(true);
  });

  it("B4 (§10.10): MODEL_ERROR and ERROR_OCCURRED mask a secret in the raw provider message", async () => {
    // A provider/proxy error whose body echoes the request authorization header
    // and an api key — the exact shape §10.10 names as an event-bus egress leak.
    const SECRET = "Authorization: Bearer sk-abc" + "def0123456789abcdef0123456789";
    const script = () => fakeModel().alwaysThrow(new Error(`upstream 401: ${SECRET}`));
    const { api } = await trackedCreateCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
    });
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const modelErrors: string[] = [];
    const errorOccurred: string[] = [];
    api.events.subscribe("MODEL_ERROR", (e) => modelErrors.push(String((e.payload as { message?: unknown }).message ?? "")));
    api.events.subscribe("ERROR_OCCURRED", (e) => errorOccurred.push(String((e.payload as { message?: unknown }).message ?? "")));
    const res = await api.session.send(id, { input: "go" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.status).toBe("failed");
    // The raw secret must appear in NO emitted event payload.
    const all = [...modelErrors, ...errorOccurred];
    expect(all.length).toBeGreaterThan(0);
    for (const m of all) {
      expect(m).not.toContain("sk-abc" + "def0123456789abcdef0123456789");
      expect(m).not.toContain("Bearer sk-");
    }
    // And the stable redaction marker is present (the detector ran).
    expect(all.some((m) => m.includes("«redacted:"))).toBe(true);
  });

  it("B4 (§10.10): the confirm() resume path masks a secret in the raw provider message", async () => {
    // The resume (confirm) path is a distinct egress from runTurn: a first model
    // call requests a write (suspends on the ask in policy_only), then the resumed
    // model call throws a provider error whose body echoes the authorization
    // header. The secret must never reach a live ERROR_OCCURRED subscriber.
    const SECRET = "Authorization: Bearer sk-abc" + "def0123456789abcdef0123456789";
    // A sequencing model: the first call returns a write tool call (so the turn
    // suspends on the ask in policy_only); every later call (the resume) throws
    // the secret-bearing provider error. fakeModel cannot sequence a success
    // then a throw, so a tiny BaseChatModel does it.
    const seqModel = new SequencingModel(
      new AIMessage({ content: "", tool_calls: [{ name: "write_file", args: { path: "r.txt", content: "x" }, id: "tc-1" }] }),
      new Error(`upstream 401: ${SECRET}`),
    );
    const { api } = await trackedCreateCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: () => seqModel as unknown as ReturnType<typeof fakeModel>,
    });
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const errorOccurred: string[] = [];
    api.events.subscribe("ERROR_OCCURRED", (e) => errorOccurred.push(String((e.payload as { message?: unknown }).message ?? "")));
    const first = await api.session.send(id, { input: "write", approvalMode: "policy_only" });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.status).toBe("waiting_for_approval");
    const reqId = first.ok ? first.value.pending![0]!.id : "";
    const done = await api.session.confirm(id, { requestId: reqId, decision: "approve" });
    expect(done.ok).toBe(true);
    if (done.ok) expect(done.value.status).toBe("failed");
    // The raw secret must appear in NO emitted ERROR_OCCURRED payload.
    expect(errorOccurred.length).toBeGreaterThan(0);
    for (const m of errorOccurred) {
      expect(m).not.toContain("sk-abc" + "def0123456789abcdef0123456789");
      expect(m).not.toContain("Bearer sk-");
    }
    expect(errorOccurred.some((m) => m.includes("«redacted:"))).toBe(true);
  });

describe("Engine decision point (§9.1)", () => {
  let ws: string;
  beforeEach(async () => {
    ws = hermeticTmp("engdp");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
  });
  afterEach(async () => {
    await drainTrackedCores();
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("a deny rule short-circuits the write and the loop continues to completion; tools bracket with events", async () => {
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "write_file", args: { path: "d.txt", content: "x" } }])
        .respond(new AIMessage("handled denial"));
    const store = new InMemoryConfigStore({
      ...seed,
      permissions: { "deny-all-writes": { tool: "write_file", pattern: "*", decision: "deny", priority: 300, source: "session" } },
    });
    const { api } = await trackedCreateCore({
      workspaceRoot: ws,
      configStore: store,
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
    });
    const started: string[] = [];
    const denied: string[] = [];
    api.events.subscribe("TOOL_STARTED", (e) => started.push((e.payload as { name: string }).name));
    api.events.subscribe("PERMISSION_DENIED", (e) => denied.push((e.payload as { tool: string }).tool));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "write", approvalMode: "policy_only" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.status).toBe("completed");
    // The write was denied before execution; the file never appeared.
    expect(await fs.readFile(path.join(ws, "d.txt"), "utf8").catch(() => null)).toBeNull();
    expect(denied).toContain("write_file");
    // A free read would bracket; here only the denied write was attempted (no TOOL_STARTED).
    expect(started).not.toContain("write_file");
  });

  it("a free read brackets with TOOL_STARTED and TOOL_FINISHED", async () => {
    await fs.writeFile(path.join(ws, "r.txt"), "readable");
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "read_file", args: { path: "r.txt" } }])
        .respond(new AIMessage("read done"));
    const { api } = await trackedCreateCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
    });
    const starts: string[] = [];
    const finishes: string[] = [];
    api.events.subscribe("TOOL_STARTED", (e) => starts.push((e.payload as { name: string }).name));
    api.events.subscribe("TOOL_FINISHED", (e) => finishes.push((e.payload as { name: string }).name));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "read r.txt" });
    expect(res.ok).toBe(true);
    expect(starts).toContain("read_file");
    expect(finishes).toContain("read_file");
  });

  it("§14.6 a real glob_files over 60 files emits TOOL_FINISHED.lines=60", async () => {
    // Given — 60 real files in the workspace so glob '*' returns 60 entries,
    // the exact shape of the reproduced bug (a big result the summary caps).
    for (let i = 0; i < 60; i++) await fs.writeFile(path.join(ws, `f${i}.txt`), "x");
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "glob_files", args: { pattern: "f*.txt" } }])
        .respond(new AIMessage("globbed"));
    const { api } = await trackedCreateCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
    });
    let finished: { name: string; lines?: number } | undefined;
    api.events.subscribe("TOOL_FINISHED", (e) => {
      const p = e.payload as { name: string; lines?: number };
      if (p.name === "glob_files") finished = p;
    });
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "glob all" });
    expect(res.ok).toBe(true);
    // The event counts the FULL result, not the capped summary.
    // MUTATION: counting the 500-char summary would report far fewer than 60.
    expect(finished?.lines).toBe(60);
  });
});

describe("Engine wired directly (§9.1 Warden-first, §9.5 edit)", () => {
  let ws: string;
  beforeEach(async () => {
    ws = hermeticTmp("engdirect");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  async function engineWith(warden: import("../entities/warden.js").Warden, managedGate?: () => { reason: string } | null) {
    const { EventBus } = await import("../entities/event-bus.js");
    const { Guardian, builtinGuardrails } = await import("../entities/guardian.js");
    const { ToolRegistry } = await import("../entities/tool-registry.js");
    const { builtinToolDefinitions } = await import("../tools/builtin.js");
    const { ConfigSchema } = await import("../config/schema.js");
    const { Engine } = await import("./engine.js");
    const { Session } = await import("../entities/session.js");
    const bus = new EventBus();
    const registry = new ToolRegistry();
    for (const t of builtinToolDefinitions()) registry.register(t.def, t.exec);
    const config = ConfigSchema.parse(seed);
    const engine = new Engine({
      chatModel: fakeModel()
        .respondWithTools([{ name: "write_file", args: { path: "w.txt", content: "x" } }])
        .respond(new AIMessage("done")) as never,
      modelName: "t",
      registry,
      guardian: new Guardian(builtinGuardrails()),
      warden,
      ...(managedGate ? { managedGate } : {}),
      checkpointer: (await import("../adapters/checkpointer.js")).createMemoryCheckpointer(),
      bus,
      getConfig: () => config,
      workspaceRoot: ws,
      tempDir: "/nonexistent-temp",
      window: 32_000,
      maxOutputTokens: null,
      modelId: "t",
      protocol: "openai",
    });
    const session = new Session({
      id: "sess0001",
      name: "n",
      summary: "",
      workspace: ws,
      startedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      turnCount: 0,
      sizeBytes: 0,
      namePinned: false,
    });
    return { engine, session, bus };
  }

  it("Warden blocks before Guardian and emits COMPLIANCE_BLOCKED", async () => {
    const { Warden, loadPolicy } = await import("../entities/warden.js");
    const blocking = new Warden({ mode: "enforcing", source: "x" });
    // A deterministic policy rule blocks the write (§9.6), proving Warden runs
    // first and a deny is final.
    blocking.setPolicy(loadPolicy({ version: "v1", rules: [{ match: "write_file", kind: "tool", effect: "block" }] }));
    const { engine, session, bus } = await engineWith(blocking);
    const blocked: string[] = [];
    bus.subscribe("COMPLIANCE_BLOCKED", (e) => blocked.push((e.payload as { action: string }).action));
    const res = await engine.runTurn(session, "write");
    expect(res.status).toBe("completed"); // the blocked write became an error result the loop handled
    expect(blocked).toContain("write_file");
    expect(await fs.readFile(path.join(ws, "w.txt"), "utf8").catch(() => null)).toBeNull();
  });

  it("managed_layer_unavailable: an unavailable managed layer denies every gated action before Warden (§13.5)", async () => {
    const { Warden } = await import("../entities/warden.js");
    // Warden would allow (mode off), but the managed gate denies the gated write.
    const { engine, session, bus } = await engineWith(new Warden({ mode: "off" }), () => ({
      reason: "managed source unreadable",
    }));
    const denied: Array<{ tool: string; reason: string }> = [];
    bus.subscribe("PERMISSION_DENIED", (e) => denied.push(e.payload as { tool: string; reason: string }));
    const res = await engine.runTurn(session, "write");
    expect(res.status).toBe("completed"); // the denied write became an error result the loop handled
    expect(denied.some((d) => d.tool === "write_file" && d.reason === "managed_layer_unavailable")).toBe(true);
    expect(await fs.readFile(path.join(ws, "w.txt"), "utf8").catch(() => null)).toBeNull();
  });

  it("an out_of_band edit decision re-enters with edited args", async () => {
    const { Warden } = await import("../entities/warden.js");
    const { engine, session } = await engineWith(new Warden({ mode: "off" }));
    session.approvalMode = "out_of_band";
    const paused = await engine.runTurn(session, "write");
    expect(paused.status).toBe("waiting_for_approval");
    const reqId = paused.pending![0]!.id;
    const done = await engine.confirm(session, {
      requestId: reqId,
      decision: "edit",
      editedArgs: { path: "edited.txt", content: "z" },
    });
    expect(done.status).toBe("completed");
    expect(await fs.readFile(path.join(ws, "edited.txt"), "utf8")).toBe("z");
  });
});
});

describe("Engine streaming and reasoning (§3.7, §4.7)", () => {
  let ws: string;
  beforeEach(async () => {
    ws = hermeticTmp("engstream");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
  });
  afterEach(async () => {
    await drainTrackedCores();
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("emits TOKEN_STREAM deltas then a final done, and TurnResult.text equals the accumulated text", async () => {
    const { api } = await trackedCreateCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(() => fakeModel().respond(new AIMessage("streamed answer"))),
    });
    const tokens: { token: string; done: boolean }[] = [];
    api.events.subscribe("TOKEN_STREAM", (e) => tokens.push(e.payload as { token: string; done: boolean }));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "go", approvalMode: "policy_only" });
    expect(res.ok).toBe(true);
    // At least one text delta fired with done:false, then exactly one final done:true.
    const deltas = tokens.filter((t) => !t.done);
    const dones = tokens.filter((t) => t.done);
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(dones.length).toBe(1);
    expect(deltas.map((d) => d.token).join("")).toBe("streamed answer");
    // TurnResult.text reconciles to the accumulated streamed text.
    if (res.ok) expect(res.value.text).toBe("streamed answer");
  });

  it("emits REASONING_STREAM for reasoning and keeps it OUT of the persisted messages chain (§4.7)", async () => {
    const { EventBus } = await import("../entities/event-bus.js");
    const { Guardian, builtinGuardrails } = await import("../entities/guardian.js");
    const { Warden } = await import("../entities/warden.js");
    const { ToolRegistry } = await import("../entities/tool-registry.js");
    const { builtinToolDefinitions } = await import("../tools/builtin.js");
    const { ConfigSchema } = await import("../config/schema.js");
    const { Engine } = await import("./engine.js");
    const { Session } = await import("../entities/session.js");
    const bus = new EventBus();
    const registry = new ToolRegistry();
    for (const t of builtinToolDefinitions()) registry.register(t.def, t.exec);
    const config = ConfigSchema.parse(seed);
    const reasoningMsg = new AIMessage({
      content: "final visible text",
      additional_kwargs: { reasoning_content: "secret chain of thought" },
    });
    const checkpointer = (await import("../adapters/checkpointer.js")).createMemoryCheckpointer();
    const engine = new Engine({
      chatModel: fakeModel().respond(reasoningMsg) as never,
      modelName: "t",
      registry,
      guardian: new Guardian(builtinGuardrails()),
      warden: new Warden({ mode: "off" }),
      checkpointer,
      bus,
      getConfig: () => config,
      workspaceRoot: ws,
      tempDir: "/nonexistent-temp",
      window: 32_000,
      maxOutputTokens: null,
      modelId: "t",
      protocol: "openai",
    });
    const session = new Session({
      id: "sessStream1",
      name: "n",
      summary: "",
      workspace: ws,
      startedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      turnCount: 0,
      sizeBytes: 0,
      namePinned: false,
    });
    const reasoning: { token: string; done: boolean }[] = [];
    const tokens: { token: string; done: boolean }[] = [];
    bus.subscribe("REASONING_STREAM", (e) => reasoning.push(e.payload as { token: string; done: boolean }));
    bus.subscribe("TOKEN_STREAM", (e) => tokens.push(e.payload as { token: string; done: boolean }));

    const res = await engine.runTurn(session, "think");
    expect(res.status).toBe("completed");
    // Reasoning streamed separately with its own done marker.
    expect(reasoning.filter((r) => !r.done).map((r) => r.token).join("")).toBe("secret chain of thought");
    expect(reasoning.some((r) => r.done)).toBe(true);
    // The visible text streamed as TOKEN_STREAM and is the final text.
    expect(tokens.filter((t) => !t.done).map((t) => t.token).join("")).toBe("final visible text");
    expect(res.text).toBe("final visible text");

    // The persisted chain holds the final text ONLY — no reasoning re-enters context (§4.7).
    const chain = await engine.loadChain(session);
    const chainText = JSON.stringify(chain);
    expect(chainText).toContain("final visible text");
    expect(chainText).not.toContain("secret chain of thought");
  });

  /** Build an Engine wired directly over a scripted fakeModel so a test can feed
   * arbitrary AIMessage shapes (array content, reasoning/thinking blocks) and
   * assert the stream split + §4.7 ingestion strip deterministically. */
  async function engineDirect(reply: AIMessage, id: string) {
    const { EventBus } = await import("../entities/event-bus.js");
    const { Guardian, builtinGuardrails } = await import("../entities/guardian.js");
    const { Warden } = await import("../entities/warden.js");
    const { ToolRegistry } = await import("../entities/tool-registry.js");
    const { builtinToolDefinitions } = await import("../tools/builtin.js");
    const { ConfigSchema } = await import("../config/schema.js");
    const { Engine } = await import("./engine.js");
    const { Session } = await import("../entities/session.js");
    const bus = new EventBus();
    const registry = new ToolRegistry();
    for (const t of builtinToolDefinitions()) registry.register(t.def, t.exec);
    const config = ConfigSchema.parse(seed);
    const engine = new Engine({
      chatModel: fakeModel().respond(reply) as never,
      modelName: "t",
      registry,
      guardian: new Guardian(builtinGuardrails()),
      warden: new Warden({ mode: "off" }),
      checkpointer: (await import("../adapters/checkpointer.js")).createMemoryCheckpointer(),
      bus,
      getConfig: () => config,
      workspaceRoot: ws,
      tempDir: "/nonexistent-temp",
      window: 32_000,
      maxOutputTokens: null,
      modelId: "t",
      protocol: "openai",
    });
    const session = new Session({
      id,
      name: "n",
      summary: "",
      workspace: ws,
      startedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      turnCount: 0,
      sizeBytes: 0,
      namePinned: false,
    });
    return { engine, session, bus };
  }

  it("array-content: concatenates text blocks, skips non-text blocks (chunkText array path)", async () => {
    // Content is an array with a text block plus a non-text block that carries no
    // `text` field — the non-text block must be skipped, only the text kept.
    const reply = new AIMessage({
      content: [
        { type: "text", text: "visible one" },
        { type: "image_url", image_url: { url: "x" } } as unknown as { type: string },
        { type: "text", text: " and two" },
      ] as never,
    });
    const { engine, session } = await engineDirect(reply, "sessArr1");
    const res = await engine.runTurn(session, "go");
    expect(res.status).toBe("completed");
    // Only the text blocks survive as the assistant text.
    expect(res.text).toBe("visible one and two");
    const chainText = JSON.stringify(await engine.loadChain(session));
    expect(chainText).toContain("visible one");
    expect(chainText).toContain("and two");
  });

  it("Anthropic-style reasoning/thinking content blocks stream as REASONING_STREAM and are dropped from the persisted chain (§4.7)", async () => {
    // Array content mixing a text block with Anthropic-style reasoning + thinking
    // blocks. chunkReasoning routes both to REASONING_STREAM; stripReasoning's
    // array-filter path drops them from the persisted channel; chunkText keeps text.
    const reply = new AIMessage({
      content: [
        { type: "reasoning", reasoning: "deliberation A" } as unknown as { type: string },
        { type: "text", text: "the answer" },
        { type: "thinking", thinking: "deliberation B" } as unknown as { type: string },
      ] as never,
    });
    const { engine, session, bus } = await engineDirect(reply, "sessArr2");
    const reasoning: { token: string; done: boolean }[] = [];
    const tokens: { token: string; done: boolean }[] = [];
    bus.subscribe("REASONING_STREAM", (e) => reasoning.push(e.payload as { token: string; done: boolean }));
    bus.subscribe("TOKEN_STREAM", (e) => tokens.push(e.payload as { token: string; done: boolean }));
    const res = await engine.runTurn(session, "think");
    expect(res.status).toBe("completed");
    // Both reasoning and thinking blocks streamed as reasoning, with a done marker.
    expect(reasoning.filter((r) => !r.done).map((r) => r.token).join("")).toBe("deliberation Adeliberation B");
    expect(reasoning.some((r) => r.done)).toBe(true);
    // Only the text block is the visible answer.
    expect(tokens.filter((t) => !t.done).map((t) => t.token).join("")).toBe("the answer");
    expect(res.text).toBe("the answer");
    // The persisted chain keeps the text block and drops both reasoning blocks.
    const chainText = JSON.stringify(await engine.loadChain(session));
    expect(chainText).toContain("the answer");
    expect(chainText).not.toContain("deliberation A");
    expect(chainText).not.toContain("deliberation B");
  });

  it("TURN_COMPLETE/MODEL_USAGE carry token counts from the provider usage_metadata, not zeros (cli §4.2 footer; fixes the `0 tokens` defect)", async () => {
    // The model reports usage_metadata like a real provider; the engine must
    // surface it on TURN_COMPLETE (↑in ↓out) and MODEL_USAGE (incl. cache read),
    // rather than emitting the hardcoded zeros that produced the `0 tokens` line.
    const reply = new AIMessage({
      content: "done",
      usage_metadata: {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
        input_token_details: { cache_read: 4 },
      },
    } as never);
    const { engine, session, bus } = await engineDirect(reply, "sessUsage1");
    const turnComplete: { usage: { promptTokens: number; completionTokens: number } }[] = [];
    const modelUsage: { usage: Record<string, number> }[] = [];
    bus.subscribe("TURN_COMPLETE", (e) => turnComplete.push(e.payload as never));
    bus.subscribe("MODEL_USAGE", (e) => modelUsage.push(e.payload as never));
    const res = await engine.runTurn(session, "go");
    expect(res.status).toBe("completed");
    // The returned TurnResult and the TURN_COMPLETE event both carry real counts.
    expect(res.usage.promptTokens).toBe(11);
    expect(res.usage.completionTokens).toBe(7);
    expect(turnComplete.at(-1)?.usage.promptTokens).toBe(11);
    expect(turnComplete.at(-1)?.usage.completionTokens).toBe(7);
    // MODEL_USAGE additionally carries the cache-read count for the footer `»`.
    expect(modelUsage.at(-1)?.usage["cacheReadTokens"]).toBe(4);
  });
});

describe("Engine — summed input & generation time on MODEL_USAGE (§10.7, cli §4.2)", () => {
  let ws: string;
  beforeEach(async () => {
    ws = hermeticTmp("enggen");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  /**
   * A chat model that streams a scripted sequence of calls. Each call yields its
   * chunks through `_streamResponseChunks` (so LangGraph's `messages` mode sees
   * token deltas); the LAST chunk of each call carries that call's
   * `usage_metadata`. A tool-call turn is call 1 (a tool_call, no text) then
   * call 2 (the answer). `onStreamStart` fires once per call's first chunk so a
   * test can advance an injected clock.
   */
  async function makeStreamingModel(opts: {
    calls: {
      chunks: string[];
      toolCall?: { name: string; args: Record<string, unknown>; id: string };
      input: number;
      output: number;
    }[];
  }) {
    const { AIMessageChunk } = await import("@langchain/core/messages");
    const { ChatGenerationChunk } = await import("@langchain/core/outputs");
    const { BaseChatModel: Base } = await import("@langchain/core/language_models/chat_models");
    class StreamingScript extends (Base as typeof BaseChatModel) {
      calls = 0;
      _llmType(): string {
        return "streaming-script";
      }
      override bindTools(): this {
        return this;
      }
      async _generate(): Promise<ChatResult> {
        // Non-stream fallback (unused when streaming is available).
        const call = opts.calls[Math.min(this.calls, opts.calls.length - 1)]!;
        this.calls += 1;
        const msg = new AIMessage({
          content: call.chunks.join(""),
          ...(call.toolCall ? { tool_calls: [call.toolCall] } : {}),
          usage_metadata: { input_tokens: call.input, output_tokens: call.output, total_tokens: call.input + call.output },
        } as never);
        return { generations: [{ text: call.chunks.join(""), message: msg }] };
      }
      async *_streamResponseChunks(_messages: BaseMessage[], _options: unknown, runManager?: { handleLLMNewToken: (t: string) => Promise<void> }): AsyncGenerator<InstanceType<typeof ChatGenerationChunk>> {
        const idx = Math.min(this.calls, opts.calls.length - 1);
        const call = opts.calls[idx]!;
        this.calls += 1;
        const chunks = call.chunks.length > 0 ? call.chunks : [""];
        for (let i = 0; i < chunks.length; i++) {
          const last = i === chunks.length - 1;
          const message = new AIMessageChunk({
            content: chunks[i]!,
            ...(last && call.toolCall ? { tool_call_chunks: [{ name: call.toolCall.name, args: JSON.stringify(call.toolCall.args), id: call.toolCall.id, index: 0 }] } : {}),
            ...(last
              ? { usage_metadata: { input_tokens: call.input, output_tokens: call.output, total_tokens: call.input + call.output } }
              : {}),
          } as never);
          const gen = new ChatGenerationChunk({ text: chunks[i]!, message });
          // Fire the per-token callback the generation-time handler listens on.
          await runManager?.handleLLMNewToken(chunks[i]!);
          yield gen;
        }
      }
    }
    return new StreamingScript({});
  }

  async function engineWithModel(model: unknown, id: string, now: () => number, extraTool?: { name: string; exec: () => Promise<{ content: string; status: "success" | "error" }> }) {
    const { EventBus } = await import("../entities/event-bus.js");
    const { Guardian, builtinGuardrails } = await import("../entities/guardian.js");
    const { Warden } = await import("../entities/warden.js");
    const { ToolRegistry } = await import("../entities/tool-registry.js");
    const { builtinToolDefinitions } = await import("../tools/builtin.js");
    const { ConfigSchema } = await import("../config/schema.js");
    const { Engine } = await import("./engine.js");
    const { Session } = await import("../entities/session.js");
    const bus = new EventBus();
    const registry = new ToolRegistry();
    for (const t of builtinToolDefinitions()) registry.register(t.def, t.exec);
    if (extraTool) {
      registry.register(
        { name: extraTool.name, description: "a tool", schema: { parse: (v: unknown) => v } as never, readOnly: false, origin: "builtin" },
        async (_args: unknown, _ctx: { workspaceRoot: string; sessionId: string }) => extraTool.exec(),
      );
    }
    // Allow the custom tool without a prompt.
    const cfg = {
      ...seed,
      permissions: { ...seededPermissionsRecord(), "allow-gen-tool": { tool: extraTool?.name ?? "noop", decision: "allow", priority: 0, source: "user" } },
    };
    const config = ConfigSchema.parse(cfg);
    const engine = new Engine({
      chatModel: model as never,
      now,
      modelName: "t",
      registry,
      guardian: new Guardian(builtinGuardrails()),
      warden: new Warden({ mode: "off" }),
      checkpointer: (await import("../adapters/checkpointer.js")).createMemoryCheckpointer(),
      bus,
      getConfig: () => config,
      workspaceRoot: ws,
      tempDir: "/nonexistent-temp",
      window: 32_000,
      maxOutputTokens: null,
      modelId: "t",
      protocol: "openai",
    });
    const session = new Session({
      id, name: "n", summary: "", workspace: ws,
      startedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      turnCount: 0, sizeBytes: 0, namePinned: false,
    });
    return { engine, session, bus };
  }

  it("a two-model-call turn reports ↑ summed input (2400) ↓ summed output (70); genMs excludes tool time; peak prompt feeds the context meter", async () => {
    // The injected clock increments by 1 per read (one read per streamed chunk);
    // the tool advances it by a HUGE jump. If generation time wrongly included
    // tool execution, genMs would carry that jump. The tool boundary closes the
    // burst, so it cannot.
    const clock = { t: 0 };
    const now = () => clock.t++;
    const model = await makeStreamingModel({
      calls: [
        // Call 1: a tool call, streamed as a couple of (empty-text) chunks, input 1000, output 20.
        { chunks: ["", ""], toolCall: { name: "gen_tool", args: { x: 1 }, id: "tc-1" }, input: 1000, output: 20 },
        // Call 2: the streamed answer, input 1400, output 50.
        { chunks: ["Hel", "lo ", "there"], input: 1400, output: 50 },
      ],
    });
    const { engine, session, bus } = await engineWithModel(model, "sessGen1", now, {
      name: "gen_tool",
      exec: async () => {
        clock.t += 1_000_000; // tool execution time — MUST be excluded from genMs.
        return { content: "tool ran", status: "success" };
      },
    });
    const modelUsage: { usage: Record<string, number> }[] = [];
    const turnComplete: { usage: { promptTokens: number } }[] = [];
    bus.subscribe("MODEL_USAGE", (e) => modelUsage.push(e.payload as never));
    bus.subscribe("TURN_COMPLETE", (e) => turnComplete.push(e.payload as never));
    const res = await engine.runTurn(session, "go");
    expect(res.status).toBe("completed");
    const u = modelUsage.at(-1)!.usage;
    // ↑ summed input across the two calls (1000 + 1400), ↓ summed output (20 + 50).
    expect(u["inputSum"]).toBe(2400);
    expect(u["completionTokens"]).toBe(70);
    // The PEAK single prompt (1400) stays on promptTokens for the context meter.
    expect(u["promptTokens"]).toBe(1400);
    expect(turnComplete.at(-1)!.usage.promptTokens).toBe(1400);
    // genMs is measured and EXCLUDES the 1,000,000 tool jump (both bursts are
    // tiny counter spans), so it is far below the tool jump.
    expect(u["genMs"]).toBeGreaterThan(0);
    expect(u["genMs"]).toBeLessThan(1000);
  });

  it("a non-streamed single-chunk call omits genMs (no tok/s), still reporting summed input", async () => {
    const clock = { t: 0 };
    const now = () => clock.t++;
    // One call, ONE chunk — a non-streamed whole message: first==last, so the
    // burst span is 0 and no genMs rides the payload.
    const model = await makeStreamingModel({
      calls: [{ chunks: ["whole answer"], input: 800, output: 12 }],
    });
    const { engine, session, bus } = await engineWithModel(model, "sessGen2", now);
    const modelUsage: { usage: Record<string, number> }[] = [];
    bus.subscribe("MODEL_USAGE", (e) => modelUsage.push(e.payload as never));
    const res = await engine.runTurn(session, "go");
    expect(res.status).toBe("completed");
    const u = modelUsage.at(-1)!.usage;
    expect(u["inputSum"]).toBe(800);
    expect(u["completionTokens"]).toBe(12);
    // No generation span → no genMs key → the footer omits tok/s.
    expect(u["genMs"]).toBeUndefined();
  });
});

describe("Engine hostile-input failure paths (§3.6, §8.1, §9.1)", () => {
  let ws: string;
  beforeEach(async () => {
    ws = hermeticTmp("enghostile");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  /** Build an engine with a caller-supplied model and optional config overrides. */
  async function engineModel(
    model: unknown,
    id: string,
    configOverrides: Record<string, unknown> = {},
  ) {
    const { EventBus } = await import("../entities/event-bus.js");
    const { Guardian, builtinGuardrails } = await import("../entities/guardian.js");
    const { Warden } = await import("../entities/warden.js");
    const { ToolRegistry } = await import("../entities/tool-registry.js");
    const { builtinToolDefinitions } = await import("../tools/builtin.js");
    const { ConfigSchema } = await import("../config/schema.js");
    const { Engine } = await import("./engine.js");
    const { Session } = await import("../entities/session.js");
    const bus = new EventBus();
    const registry = new ToolRegistry();
    for (const t of builtinToolDefinitions()) registry.register(t.def, t.exec);
    const config = ConfigSchema.parse({ ...seed, ...configOverrides });
    const engine = new Engine({
      chatModel: model as never,
      modelName: "t",
      registry,
      guardian: new Guardian(builtinGuardrails()),
      warden: new Warden({ mode: "off" }),
      checkpointer: (await import("../adapters/checkpointer.js")).createMemoryCheckpointer(),
      bus,
      getConfig: () => config,
      workspaceRoot: ws,
      tempDir: "/nonexistent-temp",
      window: 32_000,
      maxOutputTokens: null,
      modelId: "t",
      protocol: "openai",
    });
    const session = new Session({
      id,
      name: "n",
      summary: "",
      workspace: ws,
      startedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      turnCount: 0,
      sizeBytes: 0,
      namePinned: false,
    });
    return { engine, session, bus };
  }

  it("rejects an UNKNOWN tool with a structured error ToolMessage and the loop continues (§8.1, §9.1 step 1)", async () => {
    // The model calls a tool the registry does not know; it must never gate for
    // approval — it returns an error result the loop continues from (§3.3).
    const model = fakeModel()
      .respondWithTools([{ name: "rm_everything", args: { all: true } }])
      .respond(new AIMessage("handled"));
    const { engine, session, bus } = await engineModel(model, "sessUnk01");
    const denied: { tool?: string; reason?: string }[] = [];
    bus.subscribe("PERMISSION_REQUESTED", (e) => denied.push(e.payload as { tool?: string }));
    const res = await engine.runTurn(session, "delete everything");
    // The run completes (loop continued), NOT waiting_for_approval.
    expect(res.status).toBe("completed");
    expect(res.text).toBe("handled");
    // No approval was ever requested for the unknown tool.
    expect(denied).toEqual([]);
    // The transcript carries a structured tool error naming the unknown tool.
    const chainText = JSON.stringify(await engine.loadChain(session));
    expect(chainText).toContain("unknown tool: rm_everything");
  });

  it("a loop that never stops ends limit_reached with a non-empty result (§3.3, §3.6)", async () => {
    // A model that ALWAYS returns a (read-only) tool call never reaches a stop
    // condition; a limit ends the turn. §3.6: that surfaces
    // RunStatus=limit_reached (exit 4), distinct from a failure (exit 1). §3.3:
    // the turn ALWAYS carries a result — a generated summary here (no final
    // assistant text) — and a CLI/headless notice.
    await fs.writeFile(path.join(ws, "loop.txt"), "x");
    let m = fakeModel();
    for (let i = 0; i < 20; i++) {
      m = m.respondWithTools([{ name: "read_file", args: { path: "loop.txt" } }]);
    }
    const { engine, session } = await engineModel(m, "sessLoop01", { turnRecursionLimit: 6 });
    const res = await engine.runTurn(session, "loop forever");
    expect(res.status).toBe("limit_reached");
    expect(res.text.length).toBeGreaterThan(0);
    expect(res.text).toContain("limit");
    expect(res.notice).toContain("Step limit reached");
  });
});

describe("Engine — shared CONTEXT_OVERFLOW guard across call sites (§4.10, invariant 9)", () => {
  let ws: string;
  beforeEach(async () => {
    ws = hermeticTmp("engovf");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
  });
  afterEach(async () => {
    await drainTrackedCores();
    await fs.rm(ws, { recursive: true, force: true });
  });

  /** A model that FAILS the test if invoked — proves nothing is sent on overflow. */
  class NeverCalled extends FakeListChatModel {
    invoked = false;
    constructor() {
      super({ responses: ["nope"] });
    }
    override async _generate(...a: Parameters<FakeListChatModel["_generate"]>): ReturnType<FakeListChatModel["_generate"]> {
      this.invoked = true;
      return super._generate(...a);
    }
  }

  async function engineWith(model: unknown, id: string, window: number, maxOut: number | null, sharedCp?: unknown) {
    const { EventBus } = await import("../entities/event-bus.js");
    const { Guardian, builtinGuardrails } = await import("../entities/guardian.js");
    const { Warden } = await import("../entities/warden.js");
    const { ToolRegistry } = await import("../entities/tool-registry.js");
    const { builtinToolDefinitions } = await import("../tools/builtin.js");
    const { ConfigSchema } = await import("../config/schema.js");
    const { Engine } = await import("./engine.js");
    const { Session } = await import("../entities/session.js");
    const bus = new EventBus();
    const registry = new ToolRegistry();
    for (const t of builtinToolDefinitions()) registry.register(t.def, t.exec);
    const config = ConfigSchema.parse(seed);
    const checkpointer = sharedCp ?? (await import("../adapters/checkpointer.js")).createMemoryCheckpointer();
    const engine = new Engine({
      chatModel: model as never,
      modelName: "t",
      registry,
      guardian: new Guardian(builtinGuardrails()),
      warden: new Warden({ mode: "off" }),
      checkpointer: checkpointer as never,
      bus,
      getConfig: () => config,
      workspaceRoot: ws,
      tempDir: "/nonexistent-temp",
      window,
      maxOutputTokens: maxOut,
      modelId: "t",
      protocol: "openai",
    });
    const session = new Session({
      id, name: "n", summary: "", workspace: ws,
      startedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      turnCount: 0, sizeBytes: 0, namePinned: false,
    });
    return { engine, session, bus, checkpointer };
  }

  it("runTurn refuses a long input with CONTEXT_OVERFLOW and never calls the model (pre-flight)", async () => {
    const never = new NeverCalled();
    const { engine, session, bus } = await engineWith(never, "ovf-run", 50, 40);
    const overflows: unknown[] = [];
    bus.subscribe("CONTEXT_OVERFLOW", (e) => overflows.push(e.payload));
    const res = await engine.runTurn(session, "x ".repeat(400));
    expect(res.status).toBe("failed");
    expect(never.invoked).toBe(false);
    expect(overflows[0]).toMatchObject({ maxOutputTokens: 40, limit: 50 });
  });

  it("the guard ARMS with a sane default output reservation when maxOutputTokens is unset (FX-C)", async () => {
    // FX-C — before the fix, an unset maxOutputTokens left the §4.10 hard stop
    // disabled (the meter then climbed past 100%). Now the output reservation
    // defaults sanely, so an over-limit turn is refused even with no configured cap.
    const never = new NeverCalled();
    const { engine, session, bus } = await engineWith(never, "ovf-default", 50, null);
    const overflows: unknown[] = [];
    bus.subscribe("CONTEXT_OVERFLOW", (e) => overflows.push(e.payload));
    const res = await engine.runTurn(session, "x ".repeat(400));
    expect(res.status).toBe("failed");
    expect(never.invoked).toBe(false);
    expect(overflows.length).toBeGreaterThanOrEqual(1);
    expect((overflows[0] as { limit: number }).limit).toBe(50);
  });

  it("confirm() of a resumed turn runs the SAME guard: an over-window resume is refused, model not called", async () => {
    // Turn 1 (big window) issues a write that suspends on approval, leaving a
    // durable interrupt. A second engine over the SAME checkpointer+session with
    // a guard-armed tiny window resumes via confirm(): the resumed model call is
    // refused by the shared guard — proving the resume path is guarded too.
    const first = fakeModel()
      .respondWithTools([{ name: "write_file", args: { path: "c.txt", content: "data to persist in the chain" } }])
      .respond(new AIMessage("done after approve"));
    const base = await engineWith(first as never, "ovf-confirm", 32_000, 1_000);
    const t1 = await base.engine.runTurn(base.session, "write c.txt please, a long-ish instruction");
    expect(t1.status).toBe("waiting_for_approval");
    const never = new NeverCalled();
    const tiny = await engineWith(never, "ovf-confirm", 10, 10, base.checkpointer);
    const overflows: unknown[] = [];
    tiny.bus.subscribe("CONTEXT_OVERFLOW", (e) => overflows.push(e.payload));
    const res = await tiny.engine.confirm(base.session, { requestId: t1.pending![0]!.id, decision: "approve" });
    expect(res.status).toBe("failed");
    expect(never.invoked).toBe(false);
    expect(overflows.length).toBeGreaterThanOrEqual(1);
  });

  it("a summarize call whose fold prompt exceeds the window is a NON-FATAL reported failure; transcript untouched, model not called", async () => {
    const never = new NeverCalled();
    const { engine, session, bus } = await engineWith(never, "ovf-sum", 60, 40);
    const warnings: unknown[] = [];
    const overflows: unknown[] = [];
    bus.subscribe("WARNING_EMITTED", (e) => warnings.push(e.payload));
    bus.subscribe("CONTEXT_OVERFLOW", (e) => overflows.push(e.payload));
    const pipeline = engine.pipeline(session);
    // A long chain to fold; force compaction. The summarizer's prompt is far over
    // a 60-token window, so the shared guard refuses it.
    const { HumanMessage } = await import("@langchain/core/messages");
    const { AIMessage } = await import("@langchain/core/messages");
    const chain = [
      new HumanMessage("turn one please do work"),
      new AIMessage("a".repeat(2000)),
      new HumanMessage("turn two"),
      new AIMessage("b".repeat(2000)),
      new HumanMessage("turn three"),
    ];
    const res = await pipeline.compact(chain, { force: true });
    // Non-fatal: nothing folded, a WARNING_EMITTED reported it, model not called.
    expect(res.turnsFolded).toBe(0);
    expect(never.invoked).toBe(false);
    expect(warnings.some((w) => (w as { source?: string }).source === "compaction")).toBe(true);
    expect(overflows.length).toBeGreaterThanOrEqual(1);
    // The standing summary is untouched (none was set).
    expect(session.rollingSummary).toBeUndefined();
  });

  // §4.8 — the meter must update on model-call COMPLETION with the real
  // input_tokens, not one round late. These drive the real engine/pipeline path
  // with a fakeModel() message carrying usage_metadata and watch the bus.
  it("emits CONTEXT_BUDGET_UPDATED on model-call completion carrying the REAL input_tokens (§4.8, post-call report)", async () => {
    // Large window like the user's `auto` endpoint: the pre-call ESTIMATE of a
    // short prompt rounds to 0%, so only a post-call report with the real
    // input_tokens moves the meter. Before the fix, no post-call event fired.
    const reply = new AIMessage({ content: "done", usage_metadata: { input_tokens: 50_000, output_tokens: 5, total_tokens: 50_005 } } as never);
    const { engine, session, bus } = await engineWith(fakeModel().respond(reply) as never, "budget-postcall", 262_144, 4_096);
    const budgets: { percentage: number; usedTokens: number }[] = [];
    bus.subscribe("CONTEXT_BUDGET_UPDATED", (e) => budgets.push(e.payload as never));
    const res = await engine.runTurn(session, "go");
    expect(res.status).toBe("completed");
    // A budget event carries the provider-reported usage, not just the estimate.
    const real = budgets.find((b) => b.usedTokens === 50_000);
    expect(real).toBeDefined();
    expect(real!.percentage).toBeGreaterThan(0);
    // The last (settled) meter value reflects the real usage.
    expect(budgets.at(-1)?.usedTokens).toBe(50_000);
  });

  it("the meter settles to the real usage WITHOUT a second round (fan-out-freeze case, §4.8)", async () => {
    // One turn, one model call: the completion report alone must surface the real
    // percentage. Before the fix the real usage only reached the footer on the
    // NEXT round's pre-call — a fan-out with no next round froze the meter at 0%.
    const reply = new AIMessage({ content: "ok", usage_metadata: { input_tokens: 120_000, output_tokens: 3, total_tokens: 120_003 } } as never);
    const { engine, session, bus } = await engineWith(fakeModel().respond(reply) as never, "budget-fanout", 262_144, 4_096);
    const budgets: { percentage: number; usedTokens: number }[] = [];
    bus.subscribe("CONTEXT_BUDGET_UPDATED", (e) => budgets.push(e.payload as never));
    await engine.runTurn(session, "go");
    const settled = budgets.at(-1)!;
    expect(settled.usedTokens).toBe(120_000);
    expect(settled.percentage).toBeGreaterThanOrEqual(40); // 120k of ~258k working budget
  });

  it("the rounded-% dedupe still holds: no two CONTEXT_BUDGET_UPDATED share a percentage (§4.8)", async () => {
    // The post-call report uses the SAME pipeline instance as the pre-call, so
    // report()'s rounded-int dedupe carries across the boundary — no event spam.
    const reply = new AIMessage({ content: "done", usage_metadata: { input_tokens: 50_000, output_tokens: 5, total_tokens: 50_005 } } as never);
    const { engine, session, bus } = await engineWith(fakeModel().respond(reply) as never, "budget-dedupe", 262_144, 4_096);
    const budgets: { percentage: number }[] = [];
    bus.subscribe("CONTEXT_BUDGET_UPDATED", (e) => budgets.push(e.payload as never));
    await engine.runTurn(session, "go");
    const pcts = budgets.map((b) => b.percentage);
    expect(new Set(pcts).size).toBe(pcts.length); // every emitted % is distinct
  });
});

describe("Engine — inline <think> reasoning stripped at ingestion (§4.7, invariant 24)", () => {
  let ws: string;
  beforeEach(async () => {
    ws = hermeticTmp("engthink");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
  });
  afterEach(async () => {
    await drainTrackedCores();
    await fs.rm(ws, { recursive: true, force: true });
  });

  async function engineReply(reply: AIMessage, id: string) {
    const { EventBus } = await import("../entities/event-bus.js");
    const { Guardian, builtinGuardrails } = await import("../entities/guardian.js");
    const { Warden } = await import("../entities/warden.js");
    const { ToolRegistry } = await import("../entities/tool-registry.js");
    const { builtinToolDefinitions } = await import("../tools/builtin.js");
    const { ConfigSchema } = await import("../config/schema.js");
    const { Engine } = await import("./engine.js");
    const { Session } = await import("../entities/session.js");
    const bus = new EventBus();
    const registry = new ToolRegistry();
    for (const t of builtinToolDefinitions()) registry.register(t.def, t.exec);
    const config = ConfigSchema.parse(seed);
    const engine = new Engine({
      chatModel: fakeModel().respond(reply) as never,
      modelName: "t", registry,
      guardian: new Guardian(builtinGuardrails()), warden: new Warden({ mode: "off" }),
      checkpointer: (await import("../adapters/checkpointer.js")).createMemoryCheckpointer(),
      bus, getConfig: () => config, workspaceRoot: ws, tempDir: "/nonexistent-temp",
      window: 32_000, maxOutputTokens: null, modelId: "t", protocol: "openai",
    });
    const session = new Session({
      id, name: "n", summary: "", workspace: ws,
      startedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      turnCount: 0, sizeBytes: 0, namePinned: false,
    });
    return { engine, session, bus };
  }

  it("inline <think> in string content: TOKEN_STREAM/text exclude it, chain holds visible text only", async () => {
    const { engine, session, bus } = await engineReply(new AIMessage("<think>secret plan</think>Hello"), "think-str");
    const reasoning: { token: string; done: boolean }[] = [];
    const tokens: { token: string; done: boolean }[] = [];
    bus.subscribe("REASONING_STREAM", (e) => reasoning.push(e.payload as { token: string; done: boolean }));
    bus.subscribe("TOKEN_STREAM", (e) => tokens.push(e.payload as { token: string; done: boolean }));
    const res = await engine.runTurn(session, "go");
    expect(res.status).toBe("completed");
    expect(res.text).toBe("Hello");
    expect(tokens.filter((t) => !t.done).map((t) => t.token).join("")).toBe("Hello");
    expect(reasoning.filter((r) => !r.done).map((r) => r.token).join("")).toBe("secret plan");
    const chainText = JSON.stringify(await engine.loadChain(session));
    expect(chainText).toContain("Hello");
    expect(chainText).not.toContain("secret plan");
  });

  it("multiple inline blocks and mixed case are all stripped from the persisted chain", async () => {
    const { engine, session } = await engineReply(new AIMessage("A<THINK>r1</THINK>B<reasoning>r2</reasoning>C"), "think-multi");
    const res = await engine.runTurn(session, "go");
    expect(res.text).toBe("ABC");
    const chainText = JSON.stringify(await engine.loadChain(session));
    expect(chainText).not.toContain("r1");
    expect(chainText).not.toContain("r2");
  });

  it("an UNTERMINATED inline block keeps prior text out of reasoning and never persists the reasoning", async () => {
    const { engine, session } = await engineReply(new AIMessage("done:<think>unfinished tail"), "think-open");
    const res = await engine.runTurn(session, "go");
    expect(res.text).toBe("done:");
    const chainText = JSON.stringify(await engine.loadChain(session));
    expect(chainText).toContain("done:");
    expect(chainText).not.toContain("unfinished tail");
  });

  it("a provider with NO reasoning is unchanged (visible text byte-identical)", async () => {
    const { engine, session } = await engineReply(new AIMessage("plain answer, no tags, 1 < 2"), "think-none");
    const res = await engine.runTurn(session, "go");
    expect(res.text).toBe("plain answer, no tags, 1 < 2");
    const chainText = JSON.stringify(await engine.loadChain(session));
    expect(chainText).toContain("plain answer, no tags, 1 < 2");
  });

  it("the NEXT request's persisted messages contain no inline think text (reasoning never re-enters)", async () => {
    const { engine, session } = await engineReply(new AIMessage("<think>do not persist me</think>visible"), "think-next");
    await engine.runTurn(session, "first");
    // The chain the next request is built from holds only the visible text.
    const chainText = JSON.stringify(await engine.loadChain(session));
    expect(chainText).toContain("visible");
    expect(chainText).not.toContain("do not persist me");
  });

  it("a trailing partial '<th' at end of stream flushes as visible text (splitter end() path)", async () => {
    const { engine, session, bus } = await engineReply(new AIMessage("answer <th"), "think-partial");
    const tokens: { token: string; done: boolean }[] = [];
    bus.subscribe("TOKEN_STREAM", (e) => tokens.push(e.payload as { token: string; done: boolean }));
    const res = await engine.runTurn(session, "go");
    // The partial '<th' never completed a tag, so it stays visible text.
    expect(res.text).toBe("answer <th");
    expect(tokens.filter((t) => !t.done).map((t) => t.token).join("")).toBe("answer <th");
  });

  it("a stream ending on a partial close-tag inside a block flushes reasoning via end() (not text)", async () => {
    // '</thi' is a partial closer held pending while inside a block; end() flushes
    // it as reasoning, never text — exercises the splitter end() reasoning path.
    const { engine, session, bus } = await engineReply(new AIMessage("visible<think>hidden</thi"), "think-closepartial");
    const reasoning: { token: string; done: boolean }[] = [];
    const tokens: { token: string; done: boolean }[] = [];
    bus.subscribe("REASONING_STREAM", (e) => reasoning.push(e.payload as { token: string; done: boolean }));
    bus.subscribe("TOKEN_STREAM", (e) => tokens.push(e.payload as { token: string; done: boolean }));
    const res = await engine.runTurn(session, "go");
    expect(res.text).toBe("visible");
    // The dangling '</thi' is reasoning (inside the block), kept out of text.
    expect(tokens.filter((t) => !t.done).map((t) => t.token).join("")).toBe("visible");
    expect(reasoning.filter((r) => !r.done).map((r) => r.token).join("")).toContain("hidden");
    const chainText = JSON.stringify(await engine.loadChain(session));
    expect(chainText).not.toContain("hidden");
  });
});

describe("Engine — multi-turn chain survives provider completion-id reuse (§5.1, resume)", () => {
  let ws: string;
  beforeEach(async () => {
    ws = hermeticTmp("engchain");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  async function engineModel(model: unknown, id: string) {
    const { EventBus } = await import("../entities/event-bus.js");
    const { Guardian, builtinGuardrails } = await import("../entities/guardian.js");
    const { Warden } = await import("../entities/warden.js");
    const { ToolRegistry } = await import("../entities/tool-registry.js");
    const { builtinToolDefinitions } = await import("../tools/builtin.js");
    const { ConfigSchema } = await import("../config/schema.js");
    const { Engine } = await import("./engine.js");
    const { Session } = await import("../entities/session.js");
    const bus = new EventBus();
    const registry = new ToolRegistry();
    for (const t of builtinToolDefinitions()) registry.register(t.def, t.exec);
    const config = ConfigSchema.parse(seed);
    const engine = new Engine({
      chatModel: model as never,
      modelName: "t", registry,
      guardian: new Guardian(builtinGuardrails()), warden: new Warden({ mode: "off" }),
      checkpointer: (await import("../adapters/checkpointer.js")).createMemoryCheckpointer(),
      bus, getConfig: () => config, workspaceRoot: ws, tempDir: "/nonexistent-temp",
      window: 32_000, maxOutputTokens: null, modelId: "t", protocol: "openai",
    });
    const session = new Session({
      id, name: "n", summary: "", workspace: ws,
      startedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      turnCount: 0, sizeBytes: 0, namePinned: false,
    });
    return { engine, session };
  }

  it("two turns whose assistant messages reuse the SAME provider id yield a full 4-message chronological chain", async () => {
    // A provider (Ollama/vLLM, and the committed fake-openai `chatcmpl-fake`)
    // reuses one completion id across turns. LangGraph's add-messages reducer
    // dedups by id: without a per-message unique id the turn-1 assistant message
    // is overwritten by turn-2's, corrupting the resume chain to [h1, a2, h2].
    // The chain must stay chronological: human1, ai1, human2, ai2.
    const model = fakeModel()
      .respond(new AIMessage({ id: "chatcmpl-fake", content: "the first assistant answer" }))
      .respond(new AIMessage({ id: "chatcmpl-fake", content: "the second assistant answer" }));
    const { engine, session } = await engineModel(model, "sessChain1");

    const t1 = await engine.runTurn(session, "the first user question");
    expect(t1.status).toBe("completed");
    const t2 = await engine.runTurn(session, "the second user question");
    expect(t2.status).toBe("completed");

    const chain = await engine.loadChain(session);
    const kinds = chain.map((m) => m.getType());
    const texts = chain.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
    expect(kinds).toEqual(["human", "ai", "human", "ai"]);
    expect(texts[0]).toContain("the first user question");
    expect(texts[1]).toContain("the first assistant answer");
    expect(texts[2]).toContain("the second user question");
    expect(texts[3]).toContain("the second assistant answer");
  });
});
