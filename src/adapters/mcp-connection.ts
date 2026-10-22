/**
 * The production MCP connection factory (core-blueprint.md §8.4).
 *
 * Wraps an `@modelcontextprotocol/sdk` `Client` over a single transport —
 * `StdioClientTransport` for a stdio server, `StreamableHTTPClientTransport`
 * for an http server — behind the `McpConnection` seam the use-case depends on.
 * This adapter is the ONLY place the core touches the MCP SDK (§1 substrate
 * contract). `$VAR` in a stdio `env` resolves from the host environment here.
 *
 * We drive the SDK `Client` DIRECTLY rather than through
 * `@langchain/mcp-adapters` `MultiServerMCPClient`: that wrapper spawned
 * MULTIPLE child processes per stdio server and its `close()` left children
 * alive after `session.shutdown()` (verified by the §8.4 real-stdio E2E — a
 * zombie-child defect). Owning exactly one transport per connection means one
 * child, and `close()` terminates it deterministically (stdin end → SIGTERM →
 * SIGKILL inside the SDK transport). The child's stderr is PIPED (not
 * inherited) so a chatty server never corrupts the host's stdout/stderr.
 *
 * It is exercised against live servers; unit tests inject an in-process stub
 * through the seam (`McpConnection`) instead (§15.3).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpConnectAuth, McpConnection, McpServerConfig, McpToolDescriptor } from "../entities/mcp/mcp-types.js";
import { flattenMcpContent } from "../entities/tool-eviction.js";
import { limitDefault } from "../entities/limits.js";
import { coreVersion } from "../version.js";

/** Resolve `$VAR` references in a stdio server's env from the host (§8.4). */
export function resolveEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = v.startsWith("$") ? (process.env[v.slice(1)] ?? "") : v;
  }
  return out;
}

/** Build the one SDK transport for a server config. The config holds only
 * non-secret parameters; the Authorization header comes from `auth`, resolved
 * from the `CredentialStore` at connect and never read from a config file. */
export function buildTransport(config: McpServerConfig, auth?: McpConnectAuth): Transport {
  const transport = config.transport === "http-sse" ? "http" : config.transport;
  if (transport === "http") {
    const headers: Record<string, string> = { ...(config.headers ?? {}) };
    if (auth?.authorizationHeader) headers["Authorization"] = auth.authorizationHeader;
    const opts: Record<string, unknown> = {};
    if (Object.keys(headers).length) opts["requestInit"] = { headers };
    if (auth?.oauthProvider) opts["authProvider"] = auth.oauthProvider;
    return new StreamableHTTPClientTransport(new URL(config.url ?? ""), opts) as unknown as Transport;
  }
  const params: Record<string, unknown> = {
    command: config.command ?? "",
    // Discard the child's stderr: keep it off the host's stdout/stderr so a
    // chatty server never corrupts a `--prompt` run, and never leave an
    // undrained pipe that could block the child from exiting on close.
    stderr: "ignore",
  };
  if (config.args) params["args"] = config.args;
  const env = resolveEnv(config.env);
  if (env) params["env"] = env;
  return new StdioClientTransport(params as never) as unknown as Transport;
}

/** Pure function returning the MCP Client info object with the current core version. */
export function mcpClientInfo(name: string): { name: string; version: string } {
  return {
    name: `voidrift:${name}`,
    version: coreVersion(),
  };
}

/** The default production factory. The use-case resolves `auth` from the
 * `CredentialStore` before calling in, so no secret reaches this adapter from
 * config (§8.4). */
export async function connectMcpServer(
  name: string,
  config: McpServerConfig,
  auth?: McpConnectAuth,
): Promise<McpConnection> {
  const client = new Client(mcpClientInfo(name));
  const transport = buildTransport(config, auth);
  await client.connect(transport as never);
  return new SdkConnection(client as unknown as McpSdkClient);
}

/** The minimal SDK Client surface this adapter uses. */
export interface McpSdkClient {
  listTools(): Promise<{
    tools: {
      name: string;
      description?: string;
      inputSchema?: unknown;
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
        title?: string;
      };
    }[];
  }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<{ content: unknown; isError?: boolean }>;
  getInstructions?(): string | undefined;
  setNotificationHandler?(schema: unknown, handler: () => void): void;
  close(): Promise<void>;
}

/** An `McpConnection` backed by an SDK `Client` over one transport. */
export class SdkConnection implements McpConnection {
  /** The per-image/resource byte cap (`tools.imageMaxBytes`, §13.11) named in
   * the omitted-binary marker; defaults to the registry default. */
  private readonly imageMaxBytes: number;
  constructor(private readonly sdk: McpSdkClient, imageMaxBytes?: number) {
    this.imageMaxBytes = imageMaxBytes ?? limitDefault("tools.imageMaxBytes");
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const res = await this.sdk.listTools();
    return (res.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? {},
      readOnlyHint: t.annotations?.readOnlyHint === true,
      ...(t.annotations?.destructiveHint !== undefined ? { destructiveHint: t.annotations.destructiveHint } : {}),
      ...(t.annotations?.idempotentHint !== undefined ? { idempotentHint: t.annotations.idempotentHint } : {}),
      ...(t.annotations?.openWorldHint !== undefined ? { openWorldHint: t.annotations.openWorldHint } : {}),
      ...(t.annotations?.title !== undefined ? { title: t.annotations.title } : {}),
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    const res = await this.sdk.callTool({ name, arguments: args });
    // §8.4/§8.3 — flatten through the ONE policy helper so an image/resource
    // block is replaced by a bounded marker (its base64 NEVER embedded); text
    // blocks pass through and ride the normal string eviction gate downstream.
    const content = flattenMcpContent(res.content, { imageMaxBytes: this.imageMaxBytes });
    return { content, isError: res.isError === true };
  }

  instructions(): string | undefined {
    return this.sdk.getInstructions?.();
  }

  onToolsChanged(handler: () => void): () => void {
    // The SDK surfaces a tools/list_changed notification; wire it when the
    // client exposes a handler seam. A no-op unsubscribe otherwise.
    try {
      this.sdk.setNotificationHandler?.({ method: "notifications/tools/list_changed" }, handler);
    } catch {
      /* notification seam not present on this transport */
    }
    return () => undefined;
  }

  async close(): Promise<void> {
    // Closes the SDK Client, which closes its transport: for stdio this ends
    // the child's stdin then SIGTERM/SIGKILLs it, so no child survives (§8.4).
    await this.sdk.close();
  }
}
