/**
 * MCP configuration and DTOs (core-blueprint.md §8.4).
 *
 * The config carries only non-secret parameters (§8.4 OAuth): stdio
 * (`command`, `args`, `env`) and Streamable HTTP (`url`, non-secret `headers`,
 * and non-secret `oauth` params). `transport` is `stdio` or `http`; `http-sse`
 * is accepted as an alias for `http`. A secret `Authorization` header (or any
 * header value the §10.10 detector flags) is NEVER written to config: on save
 * it is moved into the `CredentialStore` under `mcpAuthKey(server)` and resolved
 * back into the live transport headers only at connect. OAuth tokens are held in
 * the `CredentialStore` (§8.4), never in config. `$VAR` in a stdio `env`
 * resolves from the host environment at connect.
 */
import { z } from "zod";

/**
 * Non-secret OAuth authorization parameters for an HTTP MCP server (§8.4). These
 * declare how to authorize; they carry NO secret. Tokens obtained through the
 * Authorization-Code + PKCE flow are held in the `CredentialStore`, never here.
 */
export const McpOAuthConfigSchema = z
  .object({
    /** The authorization-server issuer / MCP server URL to authorize against. */
    issuer: z.string().optional(),
    /** A pre-registered public client id (no client secret — PKCE is used). */
    clientId: z.string().optional(),
    /** The scopes to request. */
    scopes: z.array(z.string()).optional(),
    /** The redirect URL the authorization server returns the code to. */
    redirect: z.string().optional(),
  })
  .loose();

export type McpOAuthConfig = z.infer<typeof McpOAuthConfigSchema>;

export const McpServerConfigSchema = z
  .object({
    transport: z.enum(["stdio", "http", "http-sse"]).default("stdio"),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    /** Non-secret OAuth authorization parameters (§8.4); tokens live in the store. */
    oauth: McpOAuthConfigSchema.optional(),
  })
  .loose();

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/** The server-scoped CredentialStore key for an HTTP server's Authorization
 * header (§8.4). The secret lives here, never in config. */
export function mcpAuthKey(server: string): string {
  return `mcp:${server}:authorization`;
}

/** The server-scoped CredentialStore key prefix for OAuth credentials of a
 * server (§8.4): tokens, client information, PKCE verifier, discovery state. */
export function mcpOAuthKey(server: string, part: string): string {
  return `mcp:${server}:oauth:${part}`;
}

/**
 * Auth material resolved from the `CredentialStore` by the use-case and handed
 * to the connection factory at connect (§8.4). A resolved `authorizationHeader`
 * is injected into the live transport headers; an `oauthProvider` is passed as
 * the transport `authProvider`. Neither is ever written to config.
 */
export interface McpConnectAuth {
  /** A bearer/other Authorization header value resolved from the store. */
  authorizationHeader?: string;
  /** An MCP-SDK `OAuthClientProvider` (Authorization Code + PKCE) when the
   * server declares `oauth` params; its tokens persist through the store. */
  oauthProvider?: unknown;
}

/** The lifecycle status of an MCP tool against its pin record (§8.4). */
export type McpToolStatus = "pending" | "approved" | "quarantined";

/** The `mcp.list` DTO for one server (§8.4). Carries no secret. */
export interface McpServerInfo {
  name: string;
  transport: "stdio" | "http";
  status: "connected" | "error" | "disconnected";
  /** The server's tool names (registry names `mcp_<server>_<tool>`). */
  tools: string[];
  /** Per-tool pin/exposure state (§8.4). Only `approved` tools are bound and
   * callable; `pending`/`quarantined` are listed with a reason but unbound. */
  toolStatuses?: McpToolInfo[];
  error?: string;
}

/** Per-tool exposure state for `mcp.list` / `mcp.pins` (§8.4). */
export interface McpToolInfo {
  /** The registry name `mcp_<server>_<tool>`. */
  name: string;
  status: McpToolStatus;
  /** Always false (§8.1/§9): an MCP tool is never read-only for permission
   * purposes — read-class is never a permission input, so every MCP tool is
   * gated and asks until an allow rule covers it. */
  readOnly: boolean;
  /** The server's `readOnlyHint` — a DISPLAY-only untrusted hint (§8.4); carried
   * for a UI, it never influences permissions. */
  readOnlyHint?: boolean;
  /** Why a tool is pending/quarantined (new, hash-changed), for display. */
  reason?: string;
}

/** A tool a server advertises, normalized from the MCP tool listing (§8.4). */
export interface McpToolDescriptor {
  name: string;
  description: string;
  /** JSON-schema input, adapted to a Zod schema by the registry wiring. */
  inputSchema: unknown;
  /** The server's `readOnlyHint` (§8.4) — a DISPLAY-only untrusted hint; it
   * never sets `readOnly` and never influences permissions. */
  readOnlyHint: boolean;
  /** DISPLAY-only untrusted hints (§8.4): never set readOnly, carried for a UI. */
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

/**
 * The connection seam the MCP client depends on, satisfied in production by an
 * `@modelcontextprotocol/client` `Client` wrapped over a transport (stdio or
 * Streamable HTTP) and in tests by an in-process stub paired through
 * `InMemoryTransport` (§15.3). Keeping the adapter behind this seam is what lets
 * the decision-point routing, the `mcp_<server>_<tool>` exposure, the
 * `tools/list_changed` refresh, and the non-fatal failure be tested offline.
 */
export interface McpConnection {
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }>;
  /** A server's instructions, injected as turn metadata prefixed by name (§8.4). */
  instructions(): string | undefined;
  /** Register a handler for `tools/list_changed`; returns an unsubscribe. */
  onToolsChanged(handler: () => void): () => void;
  close(): Promise<void>;
}
