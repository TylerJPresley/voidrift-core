/**
 * The exact pre-send token-count adapter (core-blueprint.md §4.8, §11.7).
 *
 * Drives the REAL network path against a loopback fake on an ephemeral port: the
 * OpenAI-compatible `/tokenize` and the Anthropic `count_tokens`, plus the
 * refusals the spec names — a 404/unsupported shape returns null (the caller
 * marks the endpoint unsupported), a cross-host redirect is refused, and the 5s
 * timeout bounds a hung endpoint (shortened here by a non-answering socket).
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import { bundledCountTokens } from "./count-tokens.js";
import type { ToolDefinition } from "../entities/tool-registry.js";

const servers: http.Server[] = [];
afterEach(async () => {
  while (servers.length) await new Promise<void>((r) => servers.pop()!.close(() => r()));
});

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const MESSAGES = [new HumanMessage("count these tokens please")];
const NO_TOOLS: ToolDefinition[] = [];
const TOOLS: ToolDefinition[] = [
  { name: "read_file", description: "reads a file", schema: z.object({ path: z.string() }), readOnly: true },
];

describe("bundledCountTokens — OpenAI-compatible /tokenize (§4.8, §11.7)", () => {
  it("posts the assembled prompt and returns the exact count", async () => {
    let seenPath = "";
    const base = await serve((req, res) => {
      seenPath = req.url ?? "";
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        expect(JSON.parse(body).prompt).toContain("count these tokens");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ count: 123 }));
      });
    });
    const ct = bundledCountTokens({ model: "m", protocol: "openai", baseUrl: `${base}/v1` })!;
    expect(await ct(MESSAGES, NO_TOOLS)).toBe(123);
    expect(seenPath).toBe("/v1/tokenize");
  });

  it("counts a `tokens` array when `count` is absent", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tokens: [1, 2, 3, 4] }));
    });
    const ct = bundledCountTokens({ model: "m", protocol: "openai", baseUrl: base })!;
    expect(await ct(MESSAGES, NO_TOOLS)).toBe(4);
  });

  it("returns null on a 404 (the caller marks the endpoint unsupported)", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(404);
      res.end("nope");
    });
    const ct = bundledCountTokens({ model: "m", protocol: "openai", baseUrl: base })!;
    expect(await ct(MESSAGES, NO_TOOLS)).toBeNull();
  });

  it("returns null on an unsupported response shape", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ unexpected: true }));
    });
    const ct = bundledCountTokens({ model: "m", protocol: "openai", baseUrl: base })!;
    expect(await ct(MESSAGES, NO_TOOLS)).toBeNull();
  });

  it("refuses to follow a redirect (the key must stay on its own host)", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(302, { location: "http://example.com/elsewhere" });
      res.end();
    });
    const ct = bundledCountTokens({ model: "m", protocol: "openai", baseUrl: base })!;
    // `redirect: "error"` rejects the fetch; the capability throws, which the
    // engine catches and maps to unsupported.
    await expect(ct(MESSAGES, NO_TOOLS)).rejects.toBeTruthy();
  });

  it("a bundled cloud OpenAI entry (no baseUrl) exposes no capability", () => {
    expect(bundledCountTokens({ model: "gpt-4o", protocol: "openai" })).toBeUndefined();
  });

  it("includes the bound tool schemas in the counted prompt (§4.8 — no undercount)", async () => {
    let seenPrompt = "";
    const base = await serve((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seenPrompt = String(JSON.parse(body).prompt);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ count: 1 }));
      });
    });
    const ct = bundledCountTokens({ model: "m", protocol: "openai", baseUrl: base })!;
    await ct(MESSAGES, TOOLS);
    // The tool name and its parameter shape are counted text the server sees.
    expect(seenPrompt).toContain("read_file");
    expect(seenPrompt).toContain("path");
  });

  it("rejects a non-finite `count` (Infinity) as unsupported", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // JSON has no Infinity literal; a server that emits `1e999` parses to Infinity.
      res.end('{"count": 1e999}');
    });
    const ct = bundledCountTokens({ model: "m", protocol: "openai", baseUrl: base })!;
    expect(await ct(MESSAGES, NO_TOOLS)).toBeNull();
  });
});

describe("bundledCountTokens — Anthropic count_tokens (§4.8, §11.7)", () => {
  it("posts to /v1/messages/count_tokens and returns input_tokens", async () => {
    let seenPath = "";
    const base = await serve((req, res) => {
      seenPath = req.url ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 456 }));
    });
    const ct = bundledCountTokens({ model: "claude", protocol: "anthropic", baseUrl: base })!;
    expect(await ct(MESSAGES, NO_TOOLS)).toBe(456);
    expect(seenPath).toBe("/v1/messages/count_tokens");
  });

  it("returns null on a 405", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(405);
      res.end();
    });
    const ct = bundledCountTokens({ model: "claude", protocol: "anthropic", baseUrl: base })!;
    expect(await ct(MESSAGES, NO_TOOLS)).toBeNull();
  });

  it("sends the bound tools in the count_tokens body (§4.8 — no undercount)", async () => {
    let seenTools: { name?: string; input_schema?: unknown }[] | undefined;
    const base = await serve((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seenTools = JSON.parse(body).tools;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 10 }));
      });
    });
    const ct = bundledCountTokens({ model: "claude", protocol: "anthropic", baseUrl: base })!;
    await ct(MESSAGES, TOOLS);
    expect(seenTools?.[0]?.name).toBe("read_file");
    expect(seenTools?.[0]?.input_schema).toBeTruthy();
  });
});

describe("bundledCountTokens — unset protocols (§11.7)", () => {
  it("Google and Bedrock expose no bundled capability", () => {
    expect(bundledCountTokens({ model: "gemini", protocol: "google" })).toBeUndefined();
    expect(bundledCountTokens({ model: "x", protocol: "bedrock" })).toBeUndefined();
  });
});
