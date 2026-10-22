/**
 * Streamed tool-call chunk reassembly (core-blueprint.md §3.7).
 *
 * The one streaming path the engine relies on is LangChain's `AIMessageChunk`
 * accumulation (`concat`) over `.stream()` — NOT a bespoke buffer (§1
 * LangChain-first). OpenAI-compatible endpoints shard `delta.tool_calls`
 * differently: vLLM and Ollama split a call's argument JSON at different byte
 * boundaries, interleave PARALLEL calls keyed by `index`, carry the `id`/`name`
 * only on the FIRST chunk of a call, stream `reasoning`/`reasoning_content`
 * deltas separately, send a final usage chunk, and terminate with `[DONE]`.
 *
 * This drives a REAL `ChatOpenAI` over an in-process SSE server shaped like each
 * provider and asserts the accumulated chunk reassembles each tool call by index
 * into the correct whole call (name, id, parsed arguments) — the exact
 * invariant the engine depends on when LangGraph hands it the `values` snapshot.
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ChatOpenAI } from "@langchain/openai";
import { AIMessageChunk, type AIMessageChunk as AIMessageChunkT } from "@langchain/core/messages";
import { concat } from "@langchain/core/utils/stream";

/** One SSE `data:` frame for an OpenAI chat-completion chunk. */
function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const BASE = { id: "chatcmpl-x", object: "chat.completion.chunk", created: 0, model: "fake" };

interface FakeServer {
  url: string;
  close: () => Promise<void>;
}

/** Start a server that replies to the one chat-completions POST with `frames`
 * (already-serialized SSE strings), bound to 127.0.0.1:0, closed in afterEach. */
async function startServer(frames: string[]): Promise<FakeServer> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "fake", object: "model" }] }));
      return;
    }
    if (req.method === "POST" && url.startsWith("/v1/chat/completions")) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        for (const f of frames) res.write(f);
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let running: FakeServer | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

/** Stream the one completion through a REAL ChatOpenAI and reassemble with the
 * SAME `concat` accumulation LangGraph uses, returning the whole AIMessageChunk. */
async function streamAndReassemble(frames: string[]): Promise<AIMessageChunkT> {
  running = await startServer(frames);
  const model = new ChatOpenAI({
    model: "fake",
    apiKey: "sk-test",
    configuration: { baseURL: running.url },
    streaming: true,
  });
  const stream = await model.stream("hi");
  let acc: AIMessageChunkT | undefined;
  for await (const chunk of stream) {
    acc = acc === undefined ? chunk : concat(acc, chunk);
  }
  if (!acc) throw new Error("no chunk streamed");
  return acc;
}

describe("streamed tool-call reassembly (§3.7)", () => {
  it("vLLM shape: a single call whose argument JSON is split across chunks, id only on the first chunk", async () => {
    const args = JSON.stringify({ path: "src/a.ts", content: "hello world" });
    const pieces = [args.slice(0, 7), args.slice(7, 20), args.slice(20)];
    const frames = [
      sse({ ...BASE, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }),
      // First chunk of the call: id + name + first arg slice.
      sse({ ...BASE, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write_file", arguments: pieces[0] } }] }, finish_reason: null }] }),
      // Continuation chunks: arguments only, NO id, NO name (the vLLM shape).
      sse({ ...BASE, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: pieces[1] } }] }, finish_reason: null }] }),
      sse({ ...BASE, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: pieces[2] } }] }, finish_reason: null }] }),
      sse({ ...BASE, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      sse({ ...BASE, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }),
      "data: [DONE]\n\n",
    ];
    const acc = await streamAndReassemble(frames);
    expect(acc.tool_calls).toHaveLength(1);
    expect(acc.tool_calls![0]).toMatchObject({ name: "write_file", id: "call_1", args: { path: "src/a.ts", content: "hello world" } });
  });

  it("Ollama shape: two PARALLEL calls interleaved, keyed by index, argument JSON sharded", async () => {
    const a = JSON.stringify({ q: "alpha" });
    const b = JSON.stringify({ n: 42 });
    const frames = [
      sse({ ...BASE, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }),
      // Interleave: call 0 head, call 1 head, call 0 tail, call 1 tail.
      sse({ ...BASE, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c0", type: "function", function: { name: "search", arguments: a.slice(0, 5) } }] }, finish_reason: null }] }),
      sse({ ...BASE, choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "c1", type: "function", function: { name: "count", arguments: b.slice(0, 4) } }] }, finish_reason: null }] }),
      sse({ ...BASE, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: a.slice(5) } }] }, finish_reason: null }] }),
      sse({ ...BASE, choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: b.slice(4) } }] }, finish_reason: null }] }),
      sse({ ...BASE, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      sse({ ...BASE, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
      "data: [DONE]\n\n",
    ];
    const acc = await streamAndReassemble(frames);
    expect(acc.tool_calls).toHaveLength(2);
    const byName = Object.fromEntries((acc.tool_calls ?? []).map((t) => [t.name, t]));
    expect(byName["search"]).toMatchObject({ id: "c0", args: { q: "alpha" } });
    expect(byName["count"]).toMatchObject({ id: "c1", args: { n: 42 } });
  });

  it("reasoning_content deltas (vLLM/Qwen) stream separately and empty content with tool calls still reassembles", async () => {
    const args = JSON.stringify({ path: "x" });
    const frames = [
      sse({ ...BASE, choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning_content: "let me " }, finish_reason: null }] }),
      sse({ ...BASE, choices: [{ index: 0, delta: { reasoning_content: "think" }, finish_reason: null }] }),
      // Empty content, only a tool call.
      sse({ ...BASE, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "rc1", type: "function", function: { name: "read_file", arguments: args.slice(0, 4) } }] }, finish_reason: null }] }),
      sse({ ...BASE, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(4) } }] }, finish_reason: null }] }),
      sse({ ...BASE, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      sse({ ...BASE, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      "data: [DONE]\n\n",
    ];
    const acc = await streamAndReassemble(frames);
    // The tool call reassembles correctly despite empty content + reasoning.
    expect(acc.tool_calls).toHaveLength(1);
    expect(acc.tool_calls![0]).toMatchObject({ name: "read_file", id: "rc1", args: { path: "x" } });
    // The reasoning surfaced on the accumulated chunk's additional_kwargs
    // (kept out of content / tool-call args).
    const rc = (acc.additional_kwargs as Record<string, unknown>)["reasoning_content"];
    expect(typeof rc === "string" ? rc : "").toContain("let me think");
  });

  it("a plain text stream (no tool calls) reassembles to the full text with no tool_calls", async () => {
    const frames = [
      sse({ ...BASE, choices: [{ index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null }] }),
      sse({ ...BASE, choices: [{ index: 0, delta: { content: "lo!" }, finish_reason: null }] }),
      sse({ ...BASE, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      sse({ ...BASE, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      "data: [DONE]\n\n",
    ];
    const acc = await streamAndReassemble(frames);
    expect(typeof acc.content === "string" ? acc.content : "").toBe("Hello!");
    expect(acc.tool_calls ?? []).toHaveLength(0);
  });
});

// Keep the AIMessageChunk import referenced for the type guard above.
void AIMessageChunk;
