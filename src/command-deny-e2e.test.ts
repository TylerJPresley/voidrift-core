/**
 * execute_command deny through the REAL boot path (core-blueprint.md §13.11).
 *
 * A scripted model calls execute_command for a command whose output exceeds a
 * project `limits.tools.commandOutputMaxBytes` set to `action: "deny"`. Through
 * createCore the injected LimitsCapability makes the runner refuse AT THE BOUND:
 * the tool result is an error whose message is the one-line notice, the output
 * past the bound is not delivered, and exactly one LIMIT_HIT fires with action
 * `deny`. A warn override at the same site only truncates and the run continues.
 *
 * Linux/macOS only (POSIX process groups); skips on win32.
 */
import { hermeticTmp } from "./test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AIMessage, type BaseMessage, ToolMessage } from "@langchain/core/messages";
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

const skip = process.platform === "win32";

function baseSeed(extra: Partial<Config> = {}) {
  return {
    models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } },
    modelSelected: "t",
    permissions: seededPermissionsRecord(),
    ...extra,
  };
}

/** A scripted model: one tool call, capture the tool result, then finish. */
class CaptureModel extends BaseChatModel {
  toolResults: string[] = [];
  private done = false;
  constructor(private readonly call: { name: string; args: Record<string, unknown> }, params: BaseChatModelParams = {}) {
    super(params);
  }
  _llmType(): string {
    return "capture-fake";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    for (const m of messages) if (m instanceof ToolMessage) this.toolResults.push(String(m.content));
    if (this.done) return { generations: [{ text: "done", message: new AIMessage("done") }] };
    this.done = true;
    return {
      generations: [
        { text: "", message: new AIMessage({ content: "", tool_calls: [{ id: "c1", name: this.call.name, args: this.call.args }] }) },
      ],
    };
  }
}

function factory(model: BaseChatModel) {
  return (_r: ResolvedModel, _e: ModelConfigEntry) => model;
}

let ws: string;
const cores: { session: { shutdown: () => Promise<void> } }[] = [];

async function makeCore(model: BaseChatModel, seed: Record<string, unknown>) {
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

// A command that writes ~10 KB to stdout, over any tiny cap.
const FLOOD = `node -e "process.stdout.write('a'.repeat(10000))"`;

describe.skipIf(skip)("execute_command deny through boot (§13.11)", () => {
  beforeEach(async () => {
    ws = hermeticTmp("cmd-deny-e2e");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
  });
  afterEach(async () => {
    for (const c of cores) await c.session.shutdown().catch(() => undefined);
    cores.length = 0;
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("deny: the tool result is the refusal notice, output past the bound is not delivered, one LIMIT_HIT action deny", async () => {
    const model = new CaptureModel({ name: "execute_command", args: { command: FLOOD } });
    const { api } = await makeCore(
      model,
      baseSeed({ limits: { tools: { commandOutputMaxBytes: { value: 50, action: "deny" } } } } as unknown as Partial<Config>),
    );
    const hits: { key: string; action: string; value: number }[] = [];
    api.events.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string; action: string; value: number }));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "run it", approvalMode: "interactive" });
    expect(res.ok).toBe(true);

    const toolResult = model.toolResults.join("\n");
    expect(toolResult).toContain("limits.tools.commandOutputMaxBytes");
    // The output past the bound is NOT delivered to the model.
    expect(toolResult).not.toContain("a".repeat(100));

    const hit = hits.find((h) => h.key === "tools.commandOutputMaxBytes");
    expect(hit, "LIMIT_HIT for the command-output cap should fire through boot").toBeDefined();
    expect(hit?.action).toBe("deny");
    expect(hit?.value).toBe(50);
    expect(hits.filter((h) => h.key === "tools.commandOutputMaxBytes").length).toBe(1);
  });

  it("warn (same site): the run continues; the tool result carries the marker, one LIMIT_HIT action warn", async () => {
    const model = new CaptureModel({ name: "execute_command", args: { command: FLOOD } });
    const { api } = await makeCore(
      model,
      baseSeed({ limits: { tools: { commandOutputMaxBytes: { value: 50, action: "warn" } } } } as unknown as Partial<Config>),
    );
    const hits: { key: string; action: string }[] = [];
    api.events.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string; action: string }));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "run it", approvalMode: "interactive" });
    expect(res.ok).toBe(true);

    const toolResult = model.toolResults.join("\n");
    // Through boot a runCache is present, so oversized warn output is stored BY
    // REFERENCE (head+tail+handle), not cut inline; the run continues and the
    // handle is delivered. The key is named by the LIMIT_HIT event.
    expect(toolResult).toContain("[full output:");
    const hit = hits.find((h) => h.key === "tools.commandOutputMaxBytes");
    expect(hit?.action).toBe("warn");
  });
});
