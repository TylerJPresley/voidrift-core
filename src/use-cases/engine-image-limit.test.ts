/**
 * tools.imageMaxBytes conformance (core-blueprint.md §13.11, §3.3): an image
 * attachment over the per-image byte cap is REFUSED (deny/safety bound), and the
 * refusal — previously silent on the port — now emits EXACTLY ONE `LIMIT_HIT`
 * naming the canonical key, with the model-visible message carrying the notice.
 *
 * Driven over the real Engine with a scripted vision model and an in-memory
 * FileSystemPort. Mutation-proof (two): a within-cap image fires NO hit
 * (drop/always), and an over-cap refusal fires the hit exactly once (emit-twice).
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { BaseChatModel, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import fs from "node:fs/promises";
import { EventBus } from "../entities/event-bus.js";
import { Guardian, builtinGuardrails } from "../entities/guardian.js";
import { Warden } from "../entities/warden.js";
import { ToolRegistry } from "../entities/tool-registry.js";
import { builtinToolDefinitions } from "../tools/builtin.js";
import { ConfigSchema } from "../config/schema.js";
import { Engine, type EngineDeps } from "./engine.js";
import { Session } from "../entities/session.js";
import { createMemoryCheckpointer } from "../adapters/checkpointer.js";
import { InMemoryFileSystem } from "../adapters/in-memory-filesystem.js";
import { resolveLimits, type LimitLayerInput } from "../entities/limits-resolve.js";
import { LimitsCapability } from "./limits-capability.js";

const seed = { models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } }, modelSelected: "t" };

class VisionModel extends BaseChatModel {
  _llmType(): string {
    return "scripted-vision";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    return { generations: [{ text: "ok", message: new AIMessage("ok") }] };
  }
  constructor(params: BaseChatModelParams = {}) {
    super(params);
  }
}

let ws: string;
beforeEach(() => {
  ws = hermeticTmp("engine-image-limit");
});
afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function make(limitLayers: LimitLayerInput[]) {
  const config = ConfigSchema.parse(seed);
  const registry = new ToolRegistry();
  for (const t of builtinToolDefinitions()) registry.register(t.def, t.exec);
  const bus = new EventBus();
  const hits: { key: string; value: number; observed?: number }[] = [];
  bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string; value: number; observed?: number }));
  const limits = new LimitsCapability(resolveLimits(limitLayers), bus, { session: "s1" });
  const vfs = new InMemoryFileSystem();
  vfs.binaries.set("shot.png", png);
  const extra: Partial<EngineDeps> = { vision: true, workspaceFileSystem: vfs, limits, bus };
  const engine = new Engine({
    chatModel: new VisionModel(),
    modelName: "t",
    registry,
    guardian: new Guardian(builtinGuardrails()),
    warden: new Warden({ mode: "off" }),
    checkpointer: createMemoryCheckpointer(),
    bus,
    getConfig: () => config,
    workspaceRoot: ws,
    tempDir: "/nonexistent-temp",
    window: 32_000,
    maxOutputTokens: null,
    modelId: "t",
    protocol: "openai",
    ...extra,
  });
  const session = new Session({
    id: "s1",
    name: "n",
    summary: "",
    workspace: ws,
    startedAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    turnCount: 0,
    sizeBytes: 0,
    namePinned: false,
  });
  return { engine, session, hits };
}

describe("tools.imageMaxBytes — deny: over-cap image refused with ONE LIMIT_HIT (§13.11)", () => {
  it("an over-cap image is refused and fires exactly one hit naming the key", async () => {
    const { engine, session, hits } = make([{ layer: "project", limits: { tools: { imageMaxBytes: 4 } } }]);
    const res = await engine.runTurn(session, "look", { imagePaths: ["shot.png"] });
    // refused: the turn fails and the one-notice hit names the key.
    expect(res.status).toBe("failed");
    const k = hits.filter((h) => h.key === "tools.imageMaxBytes");
    expect(k).toHaveLength(1);
    expect(k[0]!.value).toBe(4);
  });

  it("a within-cap image fires NO imageMaxBytes hit (mutation-proof: always-emit)", async () => {
    const { engine, session, hits } = make([{ layer: "project", limits: { tools: { imageMaxBytes: 1024 } } }]);
    const res = await engine.runTurn(session, "look", { imagePaths: ["shot.png"] });
    expect(res.status).toBe("completed");
    expect(hits.filter((h) => h.key === "tools.imageMaxBytes")).toHaveLength(0);
  });
});
