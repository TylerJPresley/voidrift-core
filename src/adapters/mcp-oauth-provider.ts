/**
 * The MCP OAuth client provider, backed by a `CredentialStore` (core-blueprint.md §8.4).
 *
 * An authenticated HTTP MCP server authorizes through the MCP SDK's own OAuth
 * client provider (Authorization Code with PKCE). This adapter implements the
 * SDK's `OAuthClientProvider` seam over the `CredentialStore` port: every secret
 * the flow produces — client information, the OAuth tokens, and the PKCE code
 * verifier — is persisted through the store (keychain or AES-256-GCM file),
 * never to a config file, a log, or an approval payload (§8.4, §10.10). Server
 * configuration carries only the non-secret parameters (issuer/clientId/
 * scopes/redirect).
 *
 * The provider is passed to the MCP SDK's HTTP transport as its
 * `authProvider`; the transport drives the flow and reads the current token
 * through `tokens()` before each request. This is the adapter layer — the only
 * place the core touches the MCP SDK auth surface (§1 substrate contract).
 */
import type { CredentialStore } from "../entities/ports/credential-store.js";
import { mcpOAuthKey, type McpOAuthConfig } from "../entities/mcp/mcp-types.js";

/** The minimal non-secret client metadata the SDK's OAuth flow reads. */
interface OAuthClientMetadata {
  redirect_uris: string[];
  client_name: string;
  scope?: string;
  token_endpoint_auth_method: "none";
}

/**
 * A `CredentialStore`-backed MCP `OAuthClientProvider` (Authorization Code +
 * PKCE). Structurally compatible with the SDK's `OAuthClientProvider`; typed
 * loosely at the seam so the core does not depend on the SDK's internal token
 * types (§1 rule 4). All secret state round-trips through the store under
 * `mcp:<server>:oauth:*` keys.
 */
export class CredentialStoreOAuthProvider {
  constructor(
    private readonly server: string,
    private readonly config: McpOAuthConfig,
    private readonly store: CredentialStore,
  ) {}

  get redirectUrl(): string | undefined {
    return this.config.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: this.config.redirect ? [this.config.redirect] : [],
      client_name: `voidrift:${this.server}`,
      ...(this.config.scopes?.length ? { scope: this.config.scopes.join(" ") } : {}),
      token_endpoint_auth_method: "none",
    };
  }

  /** Pre-registered static client information, or persisted DCR output. */
  async clientInformation(): Promise<Record<string, unknown> | undefined> {
    const stored = await this.read("client");
    if (stored) return stored as Record<string, unknown>;
    return this.config.clientId ? { client_id: this.config.clientId } : undefined;
  }

  async saveClientInformation(info: unknown): Promise<void> {
    await this.write("client", info);
  }

  async tokens(): Promise<Record<string, unknown> | undefined> {
    return (await this.read("tokens")) as Record<string, unknown> | undefined;
  }

  async saveTokens(tokens: unknown): Promise<void> {
    await this.write("tokens", tokens);
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.store.set(mcpOAuthKey(this.server, "verifier"), verifier);
  }

  async codeVerifier(): Promise<string> {
    const v = await this.store.get(mcpOAuthKey(this.server, "verifier"));
    if (v === null) throw new Error(`no PKCE code verifier stored for mcp server ${this.server}`);
    return v;
  }

  async saveDiscoveryState(state: unknown): Promise<void> {
    await this.write("discovery", state);
  }

  async discoveryState(): Promise<Record<string, unknown> | undefined> {
    return (await this.read("discovery")) as Record<string, unknown> | undefined;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    const parts = scope === "all" ? ["client", "tokens", "verifier", "discovery"] : [scope];
    await Promise.all(parts.map((p) => this.store.delete(mcpOAuthKey(this.server, p))));
  }

  /**
   * Begin the authorization redirect. Headless by default: the authorization
   * URL is stored under `mcp:<server>:oauth:authorize-url` so a host that drives
   * an interactive flow can pick it up. The PKCE verifier is already persisted
   * by `saveCodeVerifier` at this point, so no secret is dropped.
   */
  async redirectToAuthorization(url: URL): Promise<void> {
    await this.store.set(mcpOAuthKey(this.server, "authorize-url"), url.toString());
  }

  private async read(part: string): Promise<unknown | undefined> {
    const raw = await this.store.get(mcpOAuthKey(this.server, part));
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  private async write(part: string, value: unknown): Promise<void> {
    await this.store.set(mcpOAuthKey(this.server, part), JSON.stringify(value));
  }
}
