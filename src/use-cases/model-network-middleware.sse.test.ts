/**
 * Real-path first-byte watchdog tests (core-blueprint.md §11.5). The shared
 * model-network middleware is driven with a handler that INVOKES the per-attempt
 * bound model, so the watchdog's `handleLLMNewToken` disarm and its abort of the
 * in-flight request are proven against:
 *   1. a REAL `ChatOpenAI` over a loopback OpenAI-compatible SSE server whose
 *      FIRST byte is delayed a controllable amount, and
 *   2. a non-OpenAI streaming `BaseChatModel` fake that emits
 *      `handleLLMNewToken`, proving the watchdog is provider-agnostic.
 * The server binds 127.0.0.1:0 and is closed in afterEach; no process is left
 * running. A tiny `networkModelTimeout` floor (200 ms) keeps the tests fast.
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ChatOpenAI } from "@langchain/openai";
import { SimpleChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessageChunk, HumanMessage } from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { createModelNetworkMiddleware, ModelCallFailed } from "./model-network-middleware.js";
import { EventBus } from "../entities/event-bus.js";

/** A loopback OpenAI-compatible SSE server that delays the FIRST streamed byte
 * by `firstByteDelayMs`, then streams a few tokens. */
interface SseServer {
  url: string;
  close: () => Promise<void>;
}
async function startSse(firstByteDelayMs: number): Promise<SseServer> {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && (req.url ?? "").startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "m", object: "model" }] }));
      return;
    }
    if (req.method === "POST" && (req.url ?? "").startsWith("/v1/chat/completions")) {
      const body: Buffer[] = [];
      req.on("data", (c: Buffer) => body.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const base = { id: "chatcmpl-x", object: "chat.completion.chunk", created: 0, model: "m" };
        const first = setTimeout(() => {
          if (res.writableEnded || res.destroyed) return;
          res.write(
            `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
        }, firstByteDelayMs);
        res.on("close", () => clearTimeout(first));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A non-OpenAI streaming model: its first chunk lands after `firstTokenMs`,
 * firing `handleLLMNewToken`, then it finishes. Honors the abort signal. */
class SlowStreamingModel extends SimpleChatModel {
  constructor(private readonly firstTokenMs: number) {
    super({});
  }
  _llmType(): string {
    return "slow-fake";
  }
  async _call(): Promise<string> {
    return "done";
  }
  async *_streamResponseChunks(
    _messages: BaseMessage[],
    options: { signal?: AbortSignal },
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const start = Date.now();
    // Wait for the first token, polling so a bound-signal abort (the watchdog)
    // interrupts promptly even if it is delivered after this call started.
    while (Date.now() - start < this.firstTokenMs) {
      if (options.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      await new Promise((r) => setTimeout(r, 10));
    }
    if (options.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    await runManager?.handleLLMNewToken("done");
    yield new ChatGenerationChunk({ text: "done", message: new AIMessageChunk("done") });
  }
}

const servers: SseServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

function deps(bus: EventBus, floorMs: number, maxRetries: number) {
  return createModelNetworkMiddleware({
    bus,
    modelName: "m",
    sessionId: "s",
    getMaxRetries: () => maxRetries,
    getFloorMs: () => floorMs,
    mask: (t) => t,
  }).wrapModelCall!;
}

/** The handler invokes the per-attempt bound model for real — this is the real
 * path the agent node takes (it binds callbacks + signal, then invokes). */
const invokeHandler = (request: { model: { invoke: (m: BaseMessage[]) => Promise<unknown> } }) =>
  request.model.invoke([new HumanMessage("hi")]) as Promise<never>;

function reqFor(model: unknown) {
  return { model, messages: [new HumanMessage("hi")], runtime: {} } as never;
}

describe("first-byte watchdog — real ChatOpenAI over loopback SSE (§11.5)", () => {
  it("first byte inside the allowance succeeds (never cut)", async () => {
    const sse = await startSse(50);
    servers.push(sse);
    const model = new ChatOpenAI({ model: "m", apiKey: "x", maxRetries: 0, streaming: true, configuration: { baseURL: sse.url } });
    // floor 1000ms, 0 tokens → 1000ms allowance; first byte at 50ms.
    const run = deps(new EventBus(), 1000, 0);
    const out = (await run(reqFor(model), invokeHandler)) as AIMessageChunk;
    expect(String(out.content)).toContain("hi");
  });

  it("first byte beyond the allowance times out, is retried, then fails with the typed error", async () => {
    const sse = await startSse(1500);
    servers.push(sse);
    const codes: string[] = [];
    const bus = new EventBus();
    bus.subscribe("MODEL_ERROR", (e) => codes.push((e.payload as { code: string }).code));
    const model = new ChatOpenAI({ model: "m", apiKey: "x", maxRetries: 0, streaming: true, configuration: { baseURL: sse.url } });
    // floor 200ms, maxRetries 1 → 2 attempts, each aborts at ~200ms before the
    // 1.5s first byte; the typed timeout keeps it retryable.
    const run = deps(bus, 200, 1);
    await expect(run(reqFor(model), invokeHandler)).rejects.toBeInstanceOf(ModelCallFailed);
    expect(codes).toEqual(["timeout", "timeout"]);
  }, 10_000);
});

describe("first-byte watchdog — non-OpenAI streaming model (§11.5)", () => {
  it("disarms on the first handleLLMNewToken from a non-OpenAI model", async () => {
    const run = deps(new EventBus(), 400, 0);
    const out = (await run(reqFor(new SlowStreamingModel(50)), invokeHandler)) as AIMessageChunk;
    expect(String(out.content)).toContain("done");
  });
});
