/**
 * MCP connection adapter unit tests (core-blueprint.md §8.4).
 *
 * The live transport is exercised against real servers (the §8.4 real-stdio
 * E2E); here the pure mapping (`buildTransport`, `resolveEnv`) and the
 * `SdkConnection` seam over a stub SDK `Client` are unit-tested offline (§15.3)
 * — no process and no network.
 *
 * DELIBERATE UPDATE: the adapter now drives the SDK `Client` DIRECTLY over one
 * transport instead of `MultiServerMCPClient` (which spawned multiple children
 * and leaked them on close — a zombie-child defect the E2E caught). So the old
 * `toConnection` plain-object mapping is replaced by `buildTransport`, which
 * returns the one SDK transport, and `SdkConnection` owns the Client whose
 * `close()` terminates the child. No security assertion is loosened: the
 * Authorization-header-only-on-the-live-transport check is preserved against
 * the built transport's request headers.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  resolveEnv,
  buildTransport,
  SdkConnection,
  type McpSdkClient,
} from "./mcp-connection.js";

describe("§8.4 — MCP connection mapping", () => {
  const saved = process.env["VR_TEST_MCP"];
  afterEach(() => {
    if (saved === undefined) delete process.env["VR_TEST_MCP"];
    else process.env["VR_TEST_MCP"] = saved;
  });

  it("resolveEnv resolves $VAR from the host and passes literals through", () => {
    process.env["VR_TEST_MCP"] = "resolved";
    expect(resolveEnv({ A: "$VR_TEST_MCP", B: "literal" })).toEqual({ A: "resolved", B: "literal" });
    expect(resolveEnv({ A: "$MISSING_VAR_XYZ" })).toEqual({ A: "" });
    expect(resolveEnv(undefined)).toBeUndefined();
  });

  it("buildTransport builds a Streamable HTTP transport for http (and the http-sse alias) and a stdio transport that pipes stderr", () => {
    const http = buildTransport({ transport: "http", url: "https://x", headers: { A: "1" } }) as unknown as { constructor: { name: string } };
    expect(http.constructor.name).toBe("StreamableHTTPClientTransport");
    const alias = buildTransport({ transport: "http-sse", url: "https://y" }) as unknown as { constructor: { name: string } };
    expect(alias.constructor.name).toBe("StreamableHTTPClientTransport");
    const stdio = buildTransport({ transport: "stdio", command: "run", args: ["--x"], env: { K: "v" } }) as unknown as {
      constructor: { name: string };
      _serverParams: { command: string; args?: string[]; env?: Record<string, string>; stderr?: string };
    };
    expect(stdio.constructor.name).toBe("StdioClientTransport");
    expect(stdio._serverParams.command).toBe("run");
    expect(stdio._serverParams.args).toEqual(["--x"]);
    expect(stdio._serverParams.env).toEqual({ K: "v" });
    // stderr is DISCARDED (ignore), never inherited — a noisy server can't
    // corrupt host output and no undrained pipe can block the child's exit.
    expect(stdio._serverParams.stderr).toBe("ignore");
  });

  it("buildTransport injects a resolved Authorization header only on the live transport (§8.4)", () => {
    const t = buildTransport(
      { transport: "http", url: "https://x", headers: { "X-Public": "ok" } },
      { authorizationHeader: "Bearer sk-abc" + "def0123456789abcdef" },
    ) as unknown as { _requestInit?: { headers?: Record<string, string> } };
    // The non-secret header is preserved and the resolved secret is merged in,
    // only here on the live connection — the config itself carried no secret.
    expect(t._requestInit?.headers).toEqual({ "X-Public": "ok", Authorization: "Bearer sk-abc" + "def0123456789abcdef" });
  });

  it("SdkConnection maps listTools (readOnlyHint), callTool content, instructions, close", async () => {
    let closed = false;
    const sdk: McpSdkClient = {
      async listTools() {
        return {
          tools: [
            { name: "search", description: "d", inputSchema: {}, annotations: { readOnlyHint: true } },
            { name: "apply" },
          ],
        };
      },
      async callTool() {
        return { content: [{ type: "text", text: "line1" }, { type: "other", data: 1 }], isError: false };
      },
      getInstructions() {
        return "be careful";
      },
      async close() {
        closed = true;
      },
    };
    const conn = new SdkConnection(sdk);
    const tools = await conn.listTools();
    expect(tools[0]).toMatchObject({ name: "search", readOnlyHint: true });
    expect(tools[1]).toMatchObject({ name: "apply", readOnlyHint: false, description: "" });
    const res = await conn.callTool("search", {});
    expect(res.content).toContain("line1");
    expect(res.isError).toBe(false);
    expect(conn.instructions()).toBe("be careful");
    const unsub = conn.onToolsChanged(() => undefined);
    unsub(); // the notification seam is a no-op unsubscribe when absent
    await conn.close();
    expect(closed).toBe(true);
  });

  it("SdkConnection handles non-array content and an isError result", async () => {
    const sdk: McpSdkClient = {
      async listTools() {
        return { tools: [] };
      },
      async callTool() {
        return { content: "plain", isError: true };
      },
      async close() {
        /* no-op */
      },
    };
    const conn = new SdkConnection(sdk);
    const res = await conn.callTool("x", {});
    expect(res.content).toBe("plain");
    expect(res.isError).toBe(true);
    expect(conn.instructions()).toBeUndefined();
  });

  it("callTool NEVER embeds an MCP image block's base64 — it emits a bounded marker (§8.4/§8.3)", async () => {
    const base64 = "A".repeat(50_000); // ~37 KiB, far over any sane inline bound
    const sdk: McpSdkClient = {
      async listTools() {
        return { tools: [] };
      },
      async callTool() {
        return {
          content: [
            { type: "text", text: "see image:" },
            { type: "image", data: base64, mimeType: "image/png" },
          ],
          isError: false,
        };
      },
      async close() {
        /* no-op */
      },
    };
    const conn = new SdkConnection(sdk);
    const res = await conn.callTool("render", {});
    // The raw base64 must NEVER reach the model-facing string (the window-blowing bypass).
    expect(res.content).not.toContain(base64);
    expect(res.content).toContain("see image:");
    expect(res.content).toContain("[mcp image");
    expect(res.content).toContain("image/png");
  });
});
