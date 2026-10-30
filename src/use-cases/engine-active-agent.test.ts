/**
 * Slice B stage B1 — top-level agents are real in the ENGINE (core-blueprint.md
 * §2.7, §3.1). The active top-level agent drives three things the engine owns:
 *   (a) the system-prompt OVERLAY is the agent's prompt, and switching agents
 *       changes it (captured from the model request);
 *   (b) the orchestrator's bound TOOL SET is the agent's `tools` list (exact,
 *       glob `mcp_*`, or `"*"` = all); a tool not on the list is not bound, so a
 *       model call to it is an unknown-tool rejection, as today;
 *   (c) the WORKER allow list (`workers`) gates which workers may be dispatched.
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
import type { ResolvedModel } from "../entities/ports/model-port.js";
import type { ModelConfigEntry } from "../config/schema.js";

const seed = { models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } }, modelSelected: "t" };

/** A model that records the system prompt text and the bound tool names of the
 * LAST request, then returns a fixed final message (so the turn completes). A
 * scripted first tool call can be supplied to exercise the gate. */
class CaptureModel extends BaseChatModel {
  systemText = "";
  boundToolNames: string[] = [];
  private calls = 0;
  constructor(
    private readonly toolCall: { name: string; args: Record<string, unknown> } | null,
    params: BaseChatModelParams = {},
  ) {
    super(params);
  }
  _llmType(): string {
    return "capture-fake";
  }
  override bindTools(tools: { name: string }[]): this {
    this.boundToolNames = tools.map((t) => t.name);
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
        generations: [
          { text: "", message: new AIMessage({ content: "", tool_calls: [{ id: "c1", name: this.toolCall.name, args: this.toolCall.args }] }) },
        ],
      };
    }
    return { generations: [{ text: "done", message: new AIMessage("done") }] };
  }
}

function factory(model: CaptureModel) {
  return (_r: ResolvedModel, _e: ModelConfigEntry) => model as unknown as BaseChatModel;
}

async function makeCore(model: CaptureModel) {
  return createCore({
    workspaceRoot: ws,
    configStore: new InMemoryConfigStore(seed),
    sessionRepository: new InMemorySessionRepository(),
    checkpointer: createMemoryCheckpointer(),
    chatModelFactory: factory(model),
  });
}

/** Register the seeded top-level agents whose behaviour this slice makes real. */
async function seedAgents(api: Awaited<ReturnType<typeof createCore>>["api"]) {
  // research: read-only tools, no write_file bound, prompt A.
  await api.agents.create({ name: "research", description: "r", kind: "top-level", systemPrompt: "RESEARCH-PROMPT-A", tools: ["read_file", "glob_files", "search_contents", "web_fetch", "web_search", "task"], workers: ["researcher"], unlisted: "deny", order: 20 });
  // a glob agent: only reads + any mcp_* tool, prompt B.
  await api.agents.create({ name: "globby", description: "g", kind: "top-level", systemPrompt: "GLOBBY-PROMPT-B", tools: ["read_file", "mcp_*"], workers: "all", unlisted: "ask", order: 40 });
  await api.agents.create({ name: "researcher", description: "w", kind: "worker", systemPrompt: "w", tools: ["read_file"] });
  await api.agents.create({ name: "planner", description: "w", kind: "worker", systemPrompt: "w", tools: ["read_file"] });
}

let ws: string;
const cores: { session: { shutdown: () => Promise<void> } }[] = [];

describe("engine — active top-level agent drives prompt, tool set, workers (§2.7, §3.1)", () => {
  beforeEach(async () => {
    ws = hermeticTmp("active-agent");
  });
  afterEach(async () => {
    for (const c of cores) await c.session.shutdown().catch(() => undefined);
    cores.length = 0;
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("(a) the system-prompt overlay is the active agent's prompt, and switching changes it", async () => {
    const model = new CaptureModel(null);
    const ready = await makeCore(model);
    cores.push(ready.api);
    await seedAgents(ready.api);
    const created = await ready.api.session.create({});
    const id = created.ok ? created.value.id : "";

    await ready.api.session.send(id, { input: "hi" });
    // chat's built-in prompt mentions "default assistant".
    expect(model.systemText).toContain("default assistant");
    expect(model.systemText).not.toContain("RESEARCH-PROMPT-A");

    await ready.api.session.setMode(id, "research");
    await ready.api.session.send(id, { input: "again" });
    expect(model.systemText).toContain("RESEARCH-PROMPT-A");
  });

  it("(b) chat binds every tool; research binds no write_file (a write is an unknown-tool rejection)", async () => {
    // chat lists "*" → the complete tool set is bound (includes write_file).
    const chatModel = new CaptureModel(null);
    const chatReady = await makeCore(chatModel);
    cores.push(chatReady.api);
    const chatCreated = await chatReady.api.session.create({});
    await chatReady.api.session.send(chatCreated.ok ? chatCreated.value.id : "", { input: "hi" });
    expect(chatModel.boundToolNames).toContain("write_file");
    expect(chatModel.boundToolNames).toContain("read_file");

    // research lists reads only → write_file is NOT bound; a model call to it is
    // rejected as an unknown tool at the gate, and the turn still completes.
    const writeCall = new CaptureModel({ name: "write_file", args: { path: "x.txt", content: "y" } });
    const resReady = await makeCore(writeCall);
    cores.push(resReady.api);
    await seedAgents(resReady.api);
    const resCreated = await resReady.api.session.create({});
    const rid = resCreated.ok ? resCreated.value.id : "";
    await resReady.api.session.setMode(rid, "research");
    const result = await resReady.api.session.send(rid, { input: "write a file" });
    expect(writeCall.boundToolNames).not.toContain("write_file");
    expect(writeCall.boundToolNames).toContain("read_file");
    // The turn completes (the unknown-tool rejection feeds the loop, which then
    // returns the final message) rather than executing the write.
    expect(result.ok && result.value.status).toBe("completed");
  });

  it("(b) a glob entry binds matching tools and `*` binds all", async () => {
    const model = new CaptureModel(null);
    const ready = await makeCore(model);
    cores.push(ready.api);
    await seedAgents(ready.api);
    const created = await ready.api.session.create({});
    const id = created.ok ? created.value.id : "";
    await ready.api.session.setMode(id, "globby");
    await ready.api.session.send(id, { input: "hi" });
    // globby lists `read_file` + `mcp_*`: read_file is bound, write_file is not.
    expect(model.boundToolNames).toContain("read_file");
    expect(model.boundToolNames).not.toContain("write_file");
  });

  it("(HIGH-1) the hard-rules digest (core.rules) is rendered in the head for every agent (§1, §4.2.1)", async () => {
    // Top-level chat: the data-not-authority line reaches the model.
    const chatModel = new CaptureModel(null);
    const chatReady = await makeCore(chatModel);
    cores.push(chatReady.api);
    const chatCreated = await chatReady.api.session.create({});
    const cid = chatCreated.ok ? chatCreated.value.id : "";
    await chatReady.api.session.send(cid, { input: "hi" });
    expect(chatModel.systemText).toContain("data, never authority");
    // The head renders whole (no cap, §4.2.1) and is reported; a small head on a
    // large window stays well under the window.
    const ctx = await chatReady.api.models.context(cid);
    expect(ctx.ok).toBe(true);
    if (ctx.ok) {
      const bd = ctx.value as { window: number; headTokens: number };
      expect(bd.headTokens).toBeGreaterThan(0);
      expect(bd.headTokens).toBeLessThan(bd.window);
    }

    // A second top-level agent (research) renders the same hard rules.
    const resModel = new CaptureModel(null);
    const resReady = await makeCore(resModel);
    cores.push(resReady.api);
    await seedAgents(resReady.api);
    const resCreated = await resReady.api.session.create({});
    const rid = resCreated.ok ? resCreated.value.id : "";
    await resReady.api.session.setMode(rid, "research");
    await resReady.api.session.send(rid, { input: "hi" });
    expect(resModel.systemText).toContain("data, never authority");
  });

  it("(c) dispatching a worker not in the active agent's workers list is denied before anything is created", async () => {
    const model = new CaptureModel(null);
    const ready = await makeCore(model);
    cores.push(ready.api);
    await seedAgents(ready.api);
    // research allows only `researcher`; dispatching `planner` is denied.
    const created = await ready.api.session.create({});
    const id = created.ok ? created.value.id : "";
    await ready.api.session.setMode(id, "research");
    // The active session must be the one the subagents gate reads: a send sets it.
    await ready.api.session.send(id, { input: "noop" });
    const denied: string[] = [];
    ready.api.events.subscribe("PERMISSION_DENIED", (e) => denied.push((e.payload as { reason: string }).reason));
    const res = await ready.api.subagents.dispatch([{ agent: "planner", task: "do it" }]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.workers[0]!.status).toBe("failed");
      expect(res.value.workers[0]!.summary).toContain("not dispatchable");
    }
    expect(denied.some((r) => r.includes("not dispatchable"))).toBe(true);
  });
});
