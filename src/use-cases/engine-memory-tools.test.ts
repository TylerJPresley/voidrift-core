/**
 * Real-path memory-tool tests (core-blueprint.md §6.2, §6.4, §8.2, §15.1#12):
 * a scripted model calls `save_memory` / `delete_memory` through the ENGINE and
 * the effect is observed on disk and in the next turn's head.
 *
 *   • save_memory {type:note} → entry written, MEMORY_SAVED emitted, and the
 *     summary rides the memory index in the next turn's system prompt;
 *   • save_memory {type:identity} → MEMORY_TYPE_FORBIDDEN, nothing written, even
 *     under an `unlisted: allow` agent;
 *   • a body carrying an API key is persisted masked;
 *   • the memory tools run WITHOUT a prompt under a `deny`-unlisted agent;
 *   • delete_memory removes an entry.
 *
 * Deterministic and offline over a per-test temp workspace.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AIMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { BaseChatModel, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import fs from "node:fs/promises";
import { createCore } from "../boot.js";
import { InMemoryConfigStore } from "../adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "../adapters/repositories/session-repository.js";
import { createMemoryCheckpointer } from "../adapters/checkpointer.js";
import { seedConfigDocument } from "../config/seed.js";
import type { ResolvedModel } from "../entities/ports/model-port.js";
import type { ModelConfigEntry } from "../config/schema.js";

const seed = seedConfigDocument();

/** A model that emits a scripted tool call on its first generation, records the
 * last system prompt text, then returns a final message so the turn completes. */
class ScriptModel extends BaseChatModel {
  systemText = "";
  private calls = 0;
  constructor(
    private readonly toolCall: { name: string; args: Record<string, unknown> } | null,
    params: BaseChatModelParams = {},
  ) {
    super(params);
  }
  _llmType(): string {
    return "script-fake";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const sys = messages.find((m) => m instanceof SystemMessage) as SystemMessage | undefined;
    if (sys) {
      this.systemText = Array.isArray(sys.content)
        ? (sys.content as { text?: string }[]).map((b) => b.text ?? "").join("\n")
        : String(sys.content);
    }
    this.calls += 1;
    if (this.calls === 1 && this.toolCall) {
      return {
        generations: [{ text: "", message: new AIMessage({ content: "", tool_calls: [{ id: "c1", name: this.toolCall.name, args: this.toolCall.args }] }) }],
      };
    }
    return { generations: [{ text: "done", message: new AIMessage("done") }] };
  }
}

function factory(model: ScriptModel) {
  return (_r: ResolvedModel, _e: ModelConfigEntry) => model as unknown as BaseChatModel;
}

let ws: string;
const cores: { session: { shutdown: () => Promise<void> } }[] = [];

async function makeCore(model: ScriptModel, configSeed: Record<string, unknown> = seed) {
  return createCore({
    workspaceRoot: ws,
    configStore: new InMemoryConfigStore(configSeed),
    sessionRepository: new InMemorySessionRepository(),
    checkpointer: createMemoryCheckpointer(),
    chatModelFactory: factory(model),
  });
}

describe("engine — in-turn memory tools (§6.2, §6.4, §8.2)", () => {
  beforeEach(() => {
    ws = hermeticTmp("memory-tools");
  });
  afterEach(async () => {
    for (const c of cores) await c.session.shutdown().catch(() => undefined);
    cores.length = 0;
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("save_memory{note} writes, emits MEMORY_SAVED, and its summary rides the next turn's index", async () => {
    const model = new ScriptModel({ name: "save_memory", args: { title: "Use pnpm", body: "This repo uses pnpm, not npm.", type: "note" } });
    const ready = await makeCore(model);
    cores.push(ready.api);
    const saved: string[] = [];
    ready.api.events.subscribe("MEMORY_SAVED", (e) => saved.push((e.payload as { id: string }).id));
    const created = await ready.api.session.create({});
    const id = created.ok ? created.value.id : "";

    const res = await ready.api.session.send(id, { input: "learn this" });
    expect(res.ok && res.value.status).toBe("completed");
    expect(saved).toContain("use-pnpm");

    const list = await ready.api.memory.list();
    expect(list.ok && list.value.some((m) => m.id === "use-pnpm")).toBe(true);

    // Next turn: the summary appears in the memory index in the head.
    model.systemText = "";
    await ready.api.session.send(id, { input: "now what" });
    expect(model.systemText).toContain("Memory index");
    expect(model.systemText).toContain("use-pnpm");
  });

  it("save_memory{identity} is MEMORY_TYPE_FORBIDDEN and writes nothing, even under unlisted: allow", async () => {
    const model = new ScriptModel({ name: "save_memory", args: { title: "Who", body: "You are X", type: "identity" } });
    const ready = await makeCore(model);
    cores.push(ready.api);
    // An unlisted: allow top-level agent (confirm required to enter).
    await ready.api.agents.create({ name: "vibe", description: "v", kind: "top-level", systemPrompt: "VIBE", tools: ["*"], workers: "all", unlisted: "allow", confirm: true, order: 30 });
    const saved: string[] = [];
    ready.api.events.subscribe("MEMORY_SAVED", (e) => saved.push((e.payload as { id: string }).id));
    const created = await ready.api.session.create({});
    const id = created.ok ? created.value.id : "";
    await ready.api.session.setMode(id, "vibe", { confirmed: true });

    const res = await ready.api.session.send(id, { input: "rewrite identity" });
    expect(res.ok && res.value.status).toBe("completed");
    expect(saved).toHaveLength(0);
    const list = await ready.api.memory.list();
    expect(list.ok && list.value).toHaveLength(0);
  });

  it("a scripted vibe run with the SEEDED vibe tool list calls save_memory end-to-end: file written, no 'not a valid tool' (§6.2, F1)", async () => {
    // Regression for the HIGH finding: the seeded `vibe` manifest omitted the
    // memory tools, so a headless --enable-write (vibe) run got
    // "save_memory is not a valid tool". Drive a vibe-posture agent whose tools
    // are EXACTLY the shipped seed manifest's list (read from the template file,
    // not retyped), prove save_memory binds and writes.
    const fsSync = await import("node:fs");
    const { seedAgentsDir } = await import("../test-support/seed-agents.js");
    const manifest = JSON.parse(
      fsSync.readFileSync(`${seedAgentsDir()}/vibe/agent.json`, "utf8"),
    ) as { tools: string[] };
    expect(manifest.tools).toContain("save_memory"); // the fix is in the template

    const model = new ScriptModel({ name: "save_memory", args: { title: "Vibe note", body: "learned under vibe", type: "note" } });
    const ready = await makeCore(model);
    cores.push(ready.api);
    await ready.api.agents.create({ name: "vibe", description: "v", kind: "top-level", systemPrompt: "VIBE", tools: manifest.tools, workers: "all", unlisted: "allow", confirm: true, order: 30 });
    await ready.api.agents.create({ name: "researcher", description: "w", kind: "worker", systemPrompt: "w", tools: ["read_file"] });
    const created = await ready.api.session.create({});
    const id = created.ok ? created.value.id : "";
    await ready.api.session.setMode(id, "vibe", { confirmed: true });

    const res = await ready.api.session.send(id, { input: "save a note" });
    expect(res.ok && res.value.status).toBe("completed");
    // The tool bound and ran — no unknown-tool rejection surfaced.
    expect(JSON.stringify(res)).not.toContain("not a valid tool");
    const list = await ready.api.memory.list();
    expect(list.ok && list.value.some((m) => m.id === "vibe-note")).toBe(true);
  });

  it("an API-key-shaped body is persisted MASKED", async () => {
    const secret = "ghp_01" + "23456789abcdefghijABCDEFGHIJ0123";
    const model = new ScriptModel({ name: "save_memory", args: { title: "Token", body: `token ${secret}`, type: "note" } });
    const ready = await makeCore(model);
    cores.push(ready.api);
    const created = await ready.api.session.create({});
    const id = created.ok ? created.value.id : "";
    await ready.api.session.send(id, { input: "save token" });

    const list = await ready.api.memory.list();
    expect(list.ok).toBe(true);
    if (list.ok) {
      const entry = list.value.find((m) => m.id === "token");
      expect(entry).toBeDefined();
      expect(entry!.body).not.toContain(secret);
    }
  });

  it("the memory tools run WITHOUT a prompt under a deny-unlisted agent", async () => {
    const model = new ScriptModel({ name: "save_memory", args: { title: "Note1", body: "a learned fact", type: "note" } });
    const ready = await makeCore(model);
    cores.push(ready.api);
    // research: unlisted: deny, but lists save_memory in its tools.
    await ready.api.agents.create({ name: "research", description: "r", kind: "top-level", systemPrompt: "RESEARCH", tools: ["read_file", "save_memory", "list_memory", "delete_memory", "task"], workers: ["researcher"], unlisted: "deny", order: 20 });
    await ready.api.agents.create({ name: "researcher", description: "w", kind: "worker", systemPrompt: "w", tools: ["read_file"] });
    const asked: unknown[] = [];
    ready.api.events.subscribe("PERMISSION_REQUESTED", (e) => asked.push(e.payload));
    const created = await ready.api.session.create({});
    const id = created.ok ? created.value.id : "";
    await ready.api.session.setMode(id, "research");

    const res = await ready.api.session.send(id, { input: "record a note" });
    expect(res.ok && res.value.status).toBe("completed");
    // Allow-listed: no approval was asked, and the write landed.
    expect(asked).toHaveLength(0);
    const list = await ready.api.memory.list();
    expect(list.ok && list.value.some((m) => m.id === "note1")).toBe(true);
  });

  it("delete_memory removes an entry", async () => {
    // Pre-seed an entry through the facade, then the model deletes it.
    const model = new ScriptModel({ name: "delete_memory", args: { id: "scratch" } });
    const ready = await makeCore(model);
    cores.push(ready.api);
    await ready.api.memory.edit({ title: "scratch", type: "note", scope: "workspace", body: "temp" });
    const before = await ready.api.memory.list();
    expect(before.ok && before.value.some((m) => m.id === "scratch")).toBe(true);
    const created = await ready.api.session.create({});
    const id = created.ok ? created.value.id : "";
    await ready.api.session.send(id, { input: "delete it" });
    const list = await ready.api.memory.list();
    expect(list.ok && list.value.some((m) => m.id === "scratch")).toBe(false);
  });
});
