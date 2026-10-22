/**
 * Boot limits WIRING (§13.11, Wave 2a finding 1): the tools-area limits are
 * reached through the REAL boot path, not just built. Each test runs a full
 * createCore turn in which a scripted model calls the tool; a project `limits.*`
 * override changes real behaviour and emits LIMIT_HIT through the injected
 * LimitsCapability the engine wired at its tool-build sites (buildCoreTools →
 * runCommand, buildResearchNotesTool). Deterministic, offline, hermetic.
 */
import { hermeticTmp } from "./test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { BaseChatModel, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import fs from "node:fs/promises";
import path from "node:path";
import { createCore } from "./boot.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
import { createMemoryCheckpointer } from "./adapters/checkpointer.js";
import type { ResolvedModel } from "./entities/ports/model-port.js";
import type { ModelConfigEntry, Config } from "./config/schema.js";
import { seededPermissionsRecord } from "./test-support/seed-rules.js";

function baseSeed(extra: Partial<Config> = {}) {
  return {
    models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } },
    modelSelected: "t",
    permissions: seededPermissionsRecord(),
    ...extra,
  };
}

/** A scripted model: one tool call, then finish. */
class OneCallModel extends BaseChatModel {
  boundToolNames: string[] = [];
  private done = false;
  constructor(private readonly call: { name: string; args: Record<string, unknown> }, params: BaseChatModelParams = {}) {
    super(params);
  }
  _llmType(): string {
    return "one-call-fake";
  }
  override bindTools(tools: { name: string }[]): this {
    this.boundToolNames = tools.map((t) => t.name);
    return this;
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    if (this.done) return { generations: [{ text: "done", message: new AIMessage("done") }] };
    this.done = true;
    return {
      generations: [
        {
          text: "",
          message: new AIMessage({ content: "", tool_calls: [{ id: "c1", name: this.call.name, args: this.call.args }] }),
        },
      ],
    };
  }
}

function factory(model: BaseChatModel) {
  return (_r: ResolvedModel, _e: ModelConfigEntry) => model;
}

let ws: string;
const cores: { session: { shutdown: () => Promise<void> } }[] = [];

async function makeCore(model: BaseChatModel, seed: object) {
  const ready = await createCore({
    workspaceRoot: ws,
    configStore: new InMemoryConfigStore(seed),
    sessionRepository: new InMemorySessionRepository(),
    checkpointer: createMemoryCheckpointer(),
    chatModelFactory: factory(model),
    onApproval: async (req) => ({ requestId: req.id, decision: "approve" as const }),
  });
  cores.push(ready.api);
  return ready;
}

describe("boot limits wiring — tools reach the injected LimitsCapability (§13.11)", () => {
  beforeEach(async () => {
    ws = hermeticTmp("limits-wiring-e2e");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
  });
  afterEach(async () => {
    for (const c of cores) await c.session.shutdown().catch(() => undefined);
    cores.length = 0;
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("a project limits.tools.commandOutputMaxBytes override truncates execute_command output and emits LIMIT_HIT", async () => {
    // echo a string far larger than the (tiny) configured cap.
    const model = new OneCallModel({ name: "execute_command", args: { command: "printf 'x%.0s' {1..2000}" } });
    const { api } = await makeCore(model, baseSeed({ limits: { tools: { commandOutputMaxBytes: 50 } } } as unknown as Partial<Config>));
    const hits: { key: string; value: number }[] = [];
    api.events.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string; value: number }));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "run it", approvalMode: "interactive" });
    expect(res.ok).toBe(true);
    const hit = hits.find((h) => h.key === "tools.commandOutputMaxBytes");
    expect(hit, "LIMIT_HIT for the command-output cap should fire through boot").toBeDefined();
    expect(hit?.value).toBe(50);
  });

  it("no LIMIT_HIT when the command output fits the default cap (control)", async () => {
    const model = new OneCallModel({ name: "execute_command", args: { command: "echo hi" } });
    const { api } = await makeCore(model, baseSeed());
    const hits: unknown[] = [];
    api.events.subscribe("LIMIT_HIT", (e) => hits.push(e.payload));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "run it", approvalMode: "interactive" });
    expect(res.ok).toBe(true);
    expect(hits.length).toBe(0);
  });

  it("a project limits.tools.notesContentMaxBytes override refuses a large note and emits LIMIT_HIT", async () => {
    const model = new OneCallModel({
      name: "researcher_save_notes",
      args: { path: ".voidrift/research/note.md", content: "y".repeat(400), mode: "create" },
    });
    const { api } = await makeCore(
      model,
      baseSeed({
        findingsDirectories: [".voidrift/research"],
        limits: { tools: { notesContentMaxBytes: 50 } },
      } as unknown as Partial<Config>),
    );
    const hits: { key: string; value: number }[] = [];
    api.events.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string; value: number }));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "save it", approvalMode: "interactive" });
    expect(res.ok).toBe(true);
    const hit = hits.find((h) => h.key === "tools.notesContentMaxBytes");
    expect(hit, "LIMIT_HIT for the notes-content cap should fire through boot").toBeDefined();
    expect(hit?.value).toBe(50);
    // The note was refused (not written) — the cap took real effect.
    const wrote = await fs.readFile(path.join(ws, ".voidrift/research/note.md"), "utf8").then(() => true).catch(() => false);
    expect(wrote).toBe(false);
  });
});
