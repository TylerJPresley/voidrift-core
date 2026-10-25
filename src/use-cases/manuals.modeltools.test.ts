import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createCore } from "../boot.js";
import { InMemoryConfigStore } from "../adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "../adapters/repositories/session-repository.js";
import { createMemoryCheckpointer } from "../adapters/checkpointer.js";
import { BaseMessage, AIMessage } from "@langchain/core/messages";
import { BaseChatModel, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { hermeticTmp } from "../test-hermetic.js";
import fs from "node:fs/promises";
import type { ResolvedModel } from "../entities/ports/model-port.js";
import type { ModelConfigEntry } from "../config/schema.js";

const seed = { models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } }, modelSelected: "t" };

/** A model that records bound tool names and executes a scripted tool call. */
class ScriptedModel extends BaseChatModel {
  boundToolNames: string[] = [];
  private calls = 0;

  constructor(
    private readonly toolCall: { name: string; args: Record<string, unknown> } | null,
    params: BaseChatModelParams = {},
  ) {
    super(params);
  }

  _llmType(): string {
    return "scripted-fake";
  }

  override bindTools(tools: { name: string }[]): this {
    this.boundToolNames = tools.map((t) => t.name);
    return this;
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    this.calls += 1;
    if (this.calls === 1 && this.toolCall) {
      return {
        generations: [
          {
            text: "",
            message: new AIMessage({
              content: "",
              tool_calls: [{ id: "c1", name: this.toolCall.name, args: this.toolCall.args }],
            }),
          },
        ],
      };
    }
    return { generations: [{ text: "done", message: new AIMessage("done") }] };
  }
}

function factory(model: ScriptedModel) {
  return (_r: ResolvedModel, _e: ModelConfigEntry) => model as unknown as BaseChatModel;
}

async function makeCore(model: ScriptedModel) {
  return createCore({
    workspaceRoot: ws,
    configStore: new InMemoryConfigStore(seed),
    sessionRepository: new InMemorySessionRepository(),
    checkpointer: createMemoryCheckpointer(),
    chatModelFactory: factory(model),
  });
}

let ws: string;
const cores: Awaited<ReturnType<typeof createCore>>["api"][] = [];

describe("manuals — modelTools() binding (§8.1, §12.8)", () => {
  beforeEach(async () => {
    ws = hermeticTmp("manuals-modeltools");
  });

  afterEach(async () => {
    for (const api of cores) {
      // Shutdown all sessions via session facade
      try {
        // The session.shutdown() method with no args should shutdown all
        await (api.session as any).shutdown?.().catch(() => undefined);
      } catch {
        // Ignore errors
      }
    }
    cores.length = 0;
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("(a) read_manual is bound to the model when createCore builds the agent", async () => {
    const model = new ScriptedModel(null);
    const ready = await makeCore(model);
    cores.push(ready.api);

    const created = await ready.api.session.create({});
    const sessionId = created.ok ? created.value.id : "";

    // Send a message and the model reports its bound tools.
    await ready.api.session.send(sessionId, { input: "what tools do you have?" });

    // Verify that read_manual was bound to the model.
    expect(model.boundToolNames).toContain("read_manual");
  });
});
