/**
 * GAP 4 (structured output, §3.8) and GAP 5 (vision attach, §3.3) at the engine
 * level. Deterministic and offline over scripted BaseChatModels and an in-memory
 * FileSystemPort — no network, no provider SDK.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { BaseChatModel, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { z } from "zod";
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
import { validateResponseSchema } from "../entities/structured-output.js";
import { ErrorCode } from "../entities/errors.js";

const seed = { models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } }, modelSelected: "t" };

/** A scripted model that, when a structured-output tool is bound (a tool whose
 * name is NOT a core tool), emits a tool_call to it with the supplied args — so
 * the toolStrategy path produces a structured response deterministically. Also
 * records the content of each request's last human message for vision asserts. */
class ScriptedModel extends BaseChatModel {
  lastContent: unknown = null;
  boundToolNames: string[] = [];
  private emitted = false;
  constructor(
    private readonly structuredArgs: Record<string, unknown> | null,
    private readonly coreToolNames: Set<string>,
    params: BaseChatModelParams = {},
    private readonly jsonContent: string | null = null,
  ) {
    super(params);
  }
  _llmType(): string {
    return "scripted";
  }
  override bindTools(tools: { name: string }[]): this {
    this.boundToolNames = tools.map((t) => t.name);
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const lastHuman = [...messages].reverse().find((m) => m.getType() === "human");
    if (lastHuman) this.lastContent = lastHuman.content;
    // providerStrategy path: return native JSON content the strategy parses.
    if (this.jsonContent !== null) {
      return { generations: [{ text: this.jsonContent, message: new AIMessage(this.jsonContent) }] };
    }
    const structuredTool = this.boundToolNames.find((n) => !this.coreToolNames.has(n));
    if (this.structuredArgs && structuredTool && !this.emitted) {
      this.emitted = true;
      return {
        generations: [
          {
            text: "",
            message: new AIMessage({ content: "", tool_calls: [{ id: "s1", name: structuredTool, args: this.structuredArgs }] }),
          },
        ],
      };
    }
    return { generations: [{ text: "plain answer", message: new AIMessage("plain answer") }] };
  }
}

function coreToolNameSet(): Set<string> {
  return new Set(builtinToolDefinitions().map((t) => t.def.name));
}

let ws: string;

function makeEngine(model: BaseChatModel, extra: Partial<EngineDeps> = {}) {
  const config = ConfigSchema.parse(seed);
  const registry = new ToolRegistry();
  for (const t of builtinToolDefinitions()) registry.register(t.def, t.exec);
  const bus = new EventBus();
  const events: { type: string; payload: unknown }[] = [];
  bus.subscribe("*", (e) => events.push({ type: e.type, payload: e.payload }));
  const engine = new Engine({
    chatModel: model,
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
    id: "sess-sv-" + Math.random().toString(36).slice(2, 8),
    name: "n",
    summary: "",
    workspace: ws,
    startedAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    turnCount: 0,
    sizeBytes: 0,
    namePinned: false,
  });
  return { engine, session, events };
}

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

beforeEach(() => {
  ws = hermeticTmp("engine-sv");
});
afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

describe("GAP 4 — structured output (§3.8)", () => {
  it("toolStrategy path (portable protocol) runs end to end and fails closed when unsatisfied", async () => {
    const schema = validateResponseSchema(z.object({ answer: z.string() }));
    if (!schema.ok) throw new Error("bad schema");
    // protocol "anthropic" selects the portable tool strategy. The scripted
    // model produces no schema-conforming output, so after the one retry the
    // turn returns a typed STRUCTURED_OUTPUT_INVALID (never throws).
    const model = new ScriptedModel(null, coreToolNameSet());
    const { engine, session } = makeEngine(model, { protocol: "anthropic" });
    const res = await engine.runTurn(session, "q", { responseSchema: schema.value });
    expect((res.structured as { code?: string }).code).toBe(ErrorCode.STRUCTURED_OUTPUT_INVALID);
  });

  it("providerStrategy protocol parses native JSON into TurnResult.structured", async () => {
    const schema = validateResponseSchema(z.object({ answer: z.string() }));
    if (!schema.ok) throw new Error("bad schema");
    // protocol "openai" selects provider strategy; the model returns native JSON.
    const model = new ScriptedModel(null, coreToolNameSet(), {}, JSON.stringify({ answer: "p" }));
    const { engine, session } = makeEngine(model, { protocol: "openai" });
    const res = await engine.runTurn(session, "q", { responseSchema: schema.value });
    expect(res.status).toBe("completed");
    expect(res.structured).toEqual({ answer: "p" });
  });

  it("providerStrategy failure retries once, then the toolStrategy fallback also fails closed", async () => {
    const schema = validateResponseSchema(z.object({ answer: z.string() }));
    if (!schema.ok) throw new Error("bad schema");
    // First attempt (provider) yields unparseable content; the retry builds the
    // portable toolStrategy. The scripted model cannot satisfy either, so the
    // result is a typed STRUCTURED_OUTPUT_INVALID — proving the fallback path ran
    // through the loop without throwing.
    const model = new ScriptedModel(null, coreToolNameSet(), {}, "not json");
    const { engine, session } = makeEngine(model, { protocol: "openai" });
    const res = await engine.runTurn(session, "q", { responseSchema: schema.value });
    expect((res.structured as { code?: string }).code).toBe(ErrorCode.STRUCTURED_OUTPUT_INVALID);
  });

  it("invalid/absent structured output → one retry → typed STRUCTURED_OUTPUT_INVALID", async () => {
    const schema = validateResponseSchema(z.object({ answer: z.string() }));
    if (!schema.ok) throw new Error("bad schema");
    // structuredArgs null → the model never calls the structured tool, so no
    // structured value is produced on either the first attempt or the retry.
    const model = new ScriptedModel(null, coreToolNameSet());
    const { engine, session, events } = makeEngine(model, { protocol: "auto" });
    const res = await engine.runTurn(session, "q", { responseSchema: schema.value });
    expect((res.structured as { code?: string }).code).toBe(ErrorCode.STRUCTURED_OUTPUT_INVALID);
    expect(events.some((e) => e.type === "ERROR_OCCURRED")).toBe(true);
  });

  it("an ordinary turn (no schema) leaves structured undefined", async () => {
    const model = new ScriptedModel(null, coreToolNameSet());
    const { engine, session } = makeEngine(model);
    const res = await engine.runTurn(session, "hi");
    expect(res.status).toBe("completed");
    expect(res.structured).toBeUndefined();
  });

  it("the requested schema is never emitted to observability (§3.8d)", async () => {
    const schema = validateResponseSchema(z.object({ topSecretFieldName: z.string() }));
    if (!schema.ok) throw new Error("bad schema");
    const model = new ScriptedModel(null, coreToolNameSet(), {}, "not json");
    const { engine, session, events } = makeEngine(model, { protocol: "anthropic" });
    await engine.runTurn(session, "q", { responseSchema: schema.value });
    // the schema's field name never appears in any emitted event
    expect(JSON.stringify(events)).not.toContain("topSecretFieldName");
  });
});

describe("GAP 5 — vision attach (§3.3)", () => {
  it("a vision model gets an image content block and only mime+bytes+sha256 reach obs", async () => {
    const vfs = new InMemoryFileSystem();
    vfs.binaries.set("shot.png", png);
    const model = new ScriptedModel(null, coreToolNameSet());
    const { engine, session, events } = makeEngine(model, { vision: true, workspaceFileSystem: vfs });
    const res = await engine.runTurn(session, "look", { imagePaths: ["shot.png"] });
    expect(res.status).toBe("completed");
    // the model saw an array content with an image_url block
    const content = model.lastContent as Array<{ type: string; image_url?: { url: string } }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content.some((p) => p.type === "image_url")).toBe(true);
    // obs carries mime/bytes/sha256 but NOT image bytes
    const attached = events.find((e) => e.type === "IMAGE_ATTACHED");
    expect(attached).toBeDefined();
    const payload = attached!.payload as { mime: string; bytes: number; sha256: string };
    expect(payload.mime).toBe("image/png");
    expect(payload.bytes).toBe(png.byteLength);
    expect(payload.sha256).toMatch(/^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(Buffer.from(png).toString("base64"));
  });

  it("a non-vision model returns a typed IMAGE_NOT_SUPPORTED and never calls the model", async () => {
    const vfs = new InMemoryFileSystem();
    vfs.binaries.set("shot.png", png);
    const model = new ScriptedModel(null, coreToolNameSet());
    const { engine, session } = makeEngine(model, { vision: false, workspaceFileSystem: vfs });
    const res = await engine.runTurn(session, "look", { imagePaths: ["shot.png"] });
    expect((res.structured as { code?: string }).code).toBe(ErrorCode.IMAGE_NOT_SUPPORTED);
    expect(model.lastContent).toBeNull(); // the model was never called
  });

  it("the IMAGE_NOT_SUPPORTED message names the model, the GLOBAL defining file and the fix (model not called)", async () => {
    const vfs = new InMemoryFileSystem();
    vfs.binaries.set("shot.png", png);
    const model = new ScriptedModel(null, coreToolNameSet());
    const { engine, session } = makeEngine(model, {
      vision: false,
      workspaceFileSystem: vfs,
      resolveModelEntryFile: (name) => (name === "t" ? "~/.config/voidrift/config.json" : undefined),
    });
    const res = await engine.runTurn(session, "look", { imagePaths: ["shot.png"] });
    const s = res.structured as { code?: string; message?: string };
    expect(s.code).toBe(ErrorCode.IMAGE_NOT_SUPPORTED);
    expect(s.message).toContain('"t"'); // names the model
    expect(s.message).toContain('"vision": true to models.t'); // the exact fix keys the entry
    expect(s.message).toContain("~/.config/voidrift/config.json"); // the global defining file
    expect(s.message).toContain("/model"); // the alternative
    expect(s.message).toContain("The image was not sent.");
    expect(s.message).not.toContain("does not support images"); // the old text is gone
    expect(model.lastContent).toBeNull(); // the model was never called
  });

  it("the IMAGE_NOT_SUPPORTED message names the PROJECT defining file when the project owns the entry", async () => {
    const vfs = new InMemoryFileSystem();
    vfs.binaries.set("shot.png", png);
    const model = new ScriptedModel(null, coreToolNameSet());
    const { engine, session } = makeEngine(model, {
      vision: false,
      workspaceFileSystem: vfs,
      resolveModelEntryFile: () => "/work/project/.voidrift/config.json",
    });
    const res = await engine.runTurn(session, "look", { imagePaths: ["shot.png"] });
    const s = res.structured as { message?: string };
    expect(s.message).toContain("/work/project/.voidrift/config.json");
    expect(model.lastContent).toBeNull();
  });

  it("the message omits the file clause when no writable layer owns the entry", async () => {
    const vfs = new InMemoryFileSystem();
    vfs.binaries.set("shot.png", png);
    const model = new ScriptedModel(null, coreToolNameSet());
    const { engine, session } = makeEngine(model, {
      vision: false,
      workspaceFileSystem: vfs,
      resolveModelEntryFile: () => undefined,
    });
    const res = await engine.runTurn(session, "look", { imagePaths: ["shot.png"] });
    const s = res.structured as { code?: string; message?: string };
    expect(s.code).toBe(ErrorCode.IMAGE_NOT_SUPPORTED);
    expect(s.message).toContain('models.t'); // still keys the entry and names the fix
    expect(s.message).toContain("in your config");
    expect(model.lastContent).toBeNull();
  });

  it("refuses a non-image payload (magic-byte sniff) under a vision model", async () => {
    const vfs = new InMemoryFileSystem();
    vfs.binaries.set("doc.png", new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0, 0, 0, 0, 0, 0, 0])); // %PDF
    const model = new ScriptedModel(null, coreToolNameSet());
    const { engine, session } = makeEngine(model, { vision: true, workspaceFileSystem: vfs });
    const res = await engine.runTurn(session, "x", { imagePaths: ["doc.png"] });
    expect((res.structured as { code?: string }).code).toBe(ErrorCode.INVALID_INPUT);
    expect(model.lastContent).toBeNull();
  });

  it("refuses an oversized image (per-image cap) under a vision model", async () => {
    const vfs = new InMemoryFileSystem();
    const big = new Uint8Array(6 * 1024 * 1024);
    big.set(png.subarray(0, 8));
    vfs.binaries.set("big.png", big);
    const model = new ScriptedModel(null, coreToolNameSet());
    const { engine, session } = makeEngine(model, { vision: true, workspaceFileSystem: vfs });
    const res = await engine.runTurn(session, "x", { imagePaths: ["big.png"] });
    expect((res.structured as { code?: string }).code).toBe(ErrorCode.INVALID_INPUT);
  });

  it("refuses more than the per-message image count cap", async () => {
    const vfs = new InMemoryFileSystem();
    for (let i = 0; i < 5; i++) vfs.binaries.set(`i${i}.png`, png);
    const model = new ScriptedModel(null, coreToolNameSet());
    const { engine, session } = makeEngine(model, { vision: true, workspaceFileSystem: vfs });
    const res = await engine.runTurn(session, "x", {
      imagePaths: ["i0.png", "i1.png", "i2.png", "i3.png", "i4.png"],
    });
    expect((res.structured as { code?: string }).code).toBe(ErrorCode.INVALID_INPUT);
    expect(model.lastContent).toBeNull();
  });

  it("honors a lowered tools.imagesPerMessage from the limits port (TOOL20 convert)", async () => {
    const vfs = new InMemoryFileSystem();
    for (let i = 0; i < 3; i++) vfs.binaries.set(`i${i}.png`, png);
    const model = new ScriptedModel(null, coreToolNameSet());
    // A project-lowered cap of 2 (default is 4): 3 images must be refused, and
    // the LIMIT_HIT notice (not the hard-coded fallback) names the key.
    const limits = {
      get: (k: string) => (k === "tools.imagesPerMessage" ? 2 : k === "tools.imageMaxBytes" ? 5 * 1024 * 1024 : 0),
      hit: (key: string) => ({ notice: `too many image attachments (limits.${key} = 2). Raise it in config: limits.${key}`, action: "deny" as const, first: true }),
      resetTurn: () => {},
      action: () => "warn" as const,
    };
    const { engine, session } = makeEngine(model, { vision: true, workspaceFileSystem: vfs, limits });
    const res = await engine.runTurn(session, "x", { imagePaths: ["i0.png", "i1.png", "i2.png"] });
    const s = res.structured as { code?: string; message?: string };
    expect(s.code).toBe(ErrorCode.INVALID_INPUT);
    expect(s.message).toContain("limits.tools.imagesPerMessage");
    expect(model.lastContent).toBeNull();
  });

  it("honors a lowered tools.imageMaxBytes from the limits port (TOOL20 convert)", async () => {
    const vfs = new InMemoryFileSystem();
    // A 1 KiB image that the 5 MiB default accepts, refused under a 100-byte cap.
    const img = new Uint8Array(1024);
    img.set(png.subarray(0, 8));
    vfs.binaries.set("mid.png", img);
    const model = new ScriptedModel(null, coreToolNameSet());
    const limits = {
      get: (k: string) => (k === "tools.imageMaxBytes" ? 100 : k === "tools.imagesPerMessage" ? 4 : 0),
      hit: () => ({ notice: "", action: "deny" as const, first: false }),
      resetTurn: () => {},
      action: () => "warn" as const,
    };
    const { engine, session } = makeEngine(model, { vision: true, workspaceFileSystem: vfs, limits });
    const res = await engine.runTurn(session, "x", { imagePaths: ["mid.png"] });
    expect((res.structured as { code?: string }).code).toBe(ErrorCode.INVALID_INPUT);
  });
});
