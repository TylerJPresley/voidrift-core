/**
 * The MCP client (core-blueprint.md §8.4).
 *
 * Built on the connection seam (`McpConnection`), satisfied in production by
 * `@langchain/mcp-adapters` `MultiServerMCPClient` / an SDK `Client`, and in
 * tests by an in-process stub paired through `InMemoryTransport`. The core adds
 * configuration, the single decision point over every MCP tool call, and
 * lifecycle:
 *
 *  - on connect, list the server's tools and expose each as `mcp_<server>_<tool>`
 *    in the tool registry (§8.1) with `readOnly: false` ALWAYS. A server's
 *    `readOnlyHint` is a DISPLAY-only untrusted descriptor and NEVER a permission
 *    input (§9): every MCP tool is gated and asks until an allow rule covers it,
 *    so nothing an MCP server exposes bypasses Warden/Guardian.
 *  - a `tools/list_changed` notification re-lists and emits `RESOURCE_CHANGED`
 *    `{ path: "mcp:<server>", type: "mcp" }` (§8.4).
 *  - a connection failure is NON-FATAL: the server stays listed with no live
 *    tools, status `error`, and `ERROR_OCCURRED { source: "mcp" }` is emitted —
 *    the core never throws out of a server failure (§8.4).
 *  - a server's instructions are injected as turn metadata prefixed by the
 *    server name (DATA, never authority, §1 rule 15).
 *  - `saveConfig` / `removeConfig` go through the config capability so they are
 *    validated and recoverable, never written to disk raw (§13).
 */
import { z } from "zod";
import type { EventBus } from "../entities/event-bus.js";
import type { ToolRegistry } from "../entities/tool-registry.js";
import {
  McpServerConfigSchema,
  mcpAuthKey,
  type McpConnectAuth,
  type McpConnection,
  type McpServerConfig,
  type McpServerInfo,
  type McpToolDescriptor,
} from "../entities/mcp/mcp-types.js";
import type { CredentialStore } from "../entities/ports/credential-store.js";
import { CredentialStoreOAuthProvider } from "../adapters/mcp-oauth-provider.js";
import { isSecretHeader, maskValue, maskText } from "./secret-mask.js";
import { coreError, err, ok, type Result } from "../entities/errors.js";
import type { ConfigLayer } from "../config/schema.js";
import {
  approvalDiff,
  evaluatePins,
  sanitizeDescription,
  type ApprovalDiffEntry,
  type EvaluatedTool,
  type McpPinRecord,
  type McpPinStore,
} from "../entities/mcp/mcp-pins.js";
import type { McpToolInfo } from "../entities/mcp/mcp-types.js";
import type { LimitsPort } from "../entities/ports/limits-port.js";
import { limitDefault } from "../entities/limits.js";

/** A connection factory: resolve `$VAR` in env, open a transport with the
 * resolved (store-backed) auth, return a connection — or throw, which the
 * caller turns into a non-fatal error (§8.4). */
export type McpConnectionFactory = (
  name: string,
  config: McpServerConfig,
  auth?: McpConnectAuth,
) => Promise<McpConnection>;

export interface McpClientDeps {
  bus: EventBus;
  registry: ToolRegistry;
  connect: McpConnectionFactory;
  getConfigs: () => Record<string, McpServerConfig>;
  saveConfig: (name: string, config: McpServerConfig, layer: ConfigLayer) => Promise<Result<unknown>>;
  removeConfig: (name: string, layer: ConfigLayer) => Promise<Result<unknown>>;
  /** The credential store that holds HTTP Authorization headers and OAuth tokens
   * off disk (§8.4). Absent when no store is selectable; connect then proceeds
   * without auth and a server that requires it fails non-fatally. */
  credentials?: CredentialStore;
  /** The durable pin store (§8.4). Absent in a pure unit harness disables
   * pinning (every listed tool exposes directly) — production always wires it. */
  pinStore?: McpPinStore;
  /**
   * Resolve `mcp.approve` through the ONE decision point as a gated write
   * (tool-name key `mcp_approve`, default ask, §8.4). The full masked diff
   * rides the request; `allow` re-pins and rebinds, `reject`/a policy_only
   * fail-fast leaves the pins untouched. Absent treats approve as not gated
   * (unit harness only).
   */
  approveGate?: (server: string, diff: ApprovalDiffEntry[]) => Promise<{ decision: "allow" | "reject"; reason?: string }>;
  /**
   * The upper bound (ms) on a single connect+listTools handshake (§8.4). On
   * expiry the transport is closed, the server is set `error` with a NAME-only
   * `lastError`, and `ERROR_OCCURRED { source: "mcp" }` is emitted — so a hung
   * server never stays silently `disconnected`. Defaults to the limits registry
   * `mcp.connectTimeoutMs` (10 s) read via `limits`, else the registry default;
   * overridable for tests.
   */
  connectTimeoutMs?: number;
  /** §13.11 — the limits port; `mcp.connectTimeoutMs` is read from it when no
   * explicit `connectTimeoutMs` is set. Absent falls back to the registry
   * default so a pure unit harness needs no port. */
  limits?: LimitsPort;
}

/** §8.4 — the default connect+listTools timeout: a hung server is bounded so it
 * reports `error` rather than hanging the lazy first-turn barrier forever.
 * Kept as the registry-backed fallback when no `limits` port is wired. */
export const CONNECT_TIMEOUT_MS = limitDefault("mcp.connectTimeoutMs");

interface Live {
  config: McpServerConfig;
  connection?: McpConnection;
  status: "connected" | "error" | "disconnected";
  /** The registry names of APPROVED (bound, callable) tools only (§8.4). */
  tools: string[];
  /** Every listed tool's evaluated status against the pins (§8.4). */
  evaluated: EvaluatedTool[];
  /** Every registry name currently registered for this server (approved tools
   * plus guard stubs for pending/quarantined), so unexpose is complete. */
  registered?: string[];
  error?: string;
  unsub?: () => void;
}

/**
 * `mcp_<server>_<tool>` — the registry name for an MCP tool (§8.4).
 *
 * Server and tool segments are escaped so the `_` separator is unambiguous: a
 * plain `mcp_${server}_${tool}` concat let `{server:"a_b",tool:"c"}` and
 * `{server:"a",tool:"b_c"}` collide to the SAME registry key, so a hostile
 * server (tool names are server-controlled) could shadow another server's
 * APPROVED tool in the flat registry map (SECURITY, concern #2). Each segment
 * has `%`→`%25` and `_`→`%5F` escaped, so the only literal `_` in the key is
 * the one separator and distinct (server,tool) pairs never collide.
 */
function escapeSegment(s: string): string {
  return s.replace(/%/g, "%25").replace(/_/g, "%5F");
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp_${escapeSegment(server)}_${escapeSegment(tool)}`;
}

export class McpClient {
  private readonly servers = new Map<string, Live>();
  /** The loaded pin record (lazy); the one in-memory view of the durable file. */
  private pinRecord?: McpPinRecord;

  constructor(private readonly deps: McpClientDeps) {}

  private async loadPins(): Promise<McpPinRecord> {
    if (this.pinRecord) return this.pinRecord;
    this.pinRecord = this.deps.pinStore ? await this.deps.pinStore.load() : { servers: {} };
    return this.pinRecord;
  }

  /** Connect every configured server, non-blocking and non-fatal (§8.4). */
  async autoConnect(): Promise<void> {
    const configs = this.deps.getConfigs();
    await Promise.all(Object.entries(configs).map(([name, cfg]) => this.connect(name, cfg)));
  }

  /** Connect one server. A failure is non-fatal: listed, no live tools, status
   * `error`, `ERROR_OCCURRED { source: "mcp" }` (§8.4). Serialized per server so
   * a concurrent connect (autoConnect racing an explicit reconnect) can never
   * spawn two transports and leak a child. */
  async connect(name: string, config?: McpServerConfig): Promise<McpServerInfo> {
    // Chain onto any in-flight connect for this server so the previous one fully
    // settles (and its transport is torn down by connectInner) before the next
    // spawns — otherwise two concurrent connects leak a child.
    const prior = this.connecting.get(name);
    const run = (async () => {
      await prior?.catch(() => undefined);
      return this.connectInner(name, config);
    })();
    this.connecting.set(
      name,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private readonly connecting = new Map<string, Promise<void>>();

  private async connectInner(name: string, config?: McpServerConfig): Promise<McpServerInfo> {
    const cfg = config ?? this.deps.getConfigs()[name];
    if (!cfg) {
      return this.record(name, { config: {} as McpServerConfig, status: "error", tools: [], evaluated: [], error: "no config" });
    }
    try {
      // §8.4 — if this server is already live, tear the old connection down
      // FIRST (unsubscribe, unexpose tools, close the transport/child) so a
      // reconnect never leaks the prior child process. `connect` is idempotent.
      const prior = this.servers.get(name);
      if (prior?.connection) {
        prior.unsub?.();
        this.unexposeTools(name);
        await prior.connection.close().catch(() => undefined);
      }
      const auth = await this.resolveAuth(name, cfg);
      // §8.4 — the connect+listTools handshake is bounded: a hung server must
      // not leave the status silently `disconnected` forever (and must not hang
      // the lazy first-turn barrier). On expiry we throw a NAME-only error that
      // the catch below turns into a non-fatal `error` status; the transport is
      // closed in the timeout path so no child is leaked.
      const timeoutMs = this.deps.connectTimeoutMs ?? (this.deps.limits ? this.deps.limits.get("mcp.connectTimeoutMs") : CONNECT_TIMEOUT_MS);
      let connection: McpConnection | undefined;
      const descriptors = await this.withConnectTimeout(name, timeoutMs, async () => {
        connection = await this.deps.connect(name, cfg, auth);
        return connection.listTools();
      }, () => connection);
      const conn = connection!;
      const unsub = conn.onToolsChanged(() => void this.refresh(name));
      const live: Live = { config: cfg, connection: conn, status: "connected", tools: [], evaluated: [], unsub };
      this.servers.set(name, live);
      await this.evaluateAndExpose(name, descriptors);
      // §8.4/§14.6 — announce the status transition so a one-shot UI (the `/mcp`
      // panel) refreshes; without this the panel showed a stale `disconnected`
      // after the non-blocking boot connect completed.
      this.emitChanged(name);
      return this.toInfo(name);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // §10.10 — a transport/auth error body can echo request headers
      // (Authorization). Mask the bus egress; the in-memory status record is
      // not an egress but is masked too for a consistent surface.
      this.deps.bus.emit("ERROR_OCCURRED", { source: "mcp", server: name, message: maskText(message) }, {});
      const info = this.record(name, { config: cfg, status: "error", tools: [], evaluated: [], error: maskText(message) });
      this.emitChanged(name);
      return info;
    }
  }

  /**
   * Run the connect+listTools handshake under a hard timeout (§8.4). On expiry
   * the (possibly-open) transport is closed and a NAME-only error is thrown —
   * never the server's args/env. The losing promise is caught so a late
   * resolve/reject never becomes an unhandled rejection.
   */
  private async withConnectTimeout<T>(
    name: string,
    ms: number,
    run: () => Promise<T>,
    getConnection: () => McpConnection | undefined,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = run();
    // Absorb a late rejection from the work promise when the timeout wins, so a
    // hung/failed handshake never surfaces as an unhandled rejection.
    work.catch(() => undefined);
    try {
      return await Promise.race([
        work,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => {
            // Close whatever transport opened before listTools stalled.
            void getConnection()?.close().catch(() => undefined);
            reject(new Error(`mcp server ${name} connect timed out after ${ms}ms`));
          }, ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** §8.4/§14.6 — announce a server status transition so a live UI refreshes. */
  private emitChanged(name: string): void {
    this.deps.bus.emit("RESOURCE_CHANGED", { path: `mcp:${name}`, type: "mcp" }, {});
  }

  /**
   * Evaluate a listing against the pins (§8.4), register only APPROVED tools as
   * callable model tools (origin mcp), register pending/quarantined with a guard
   * executor so an in-flight or hallucinated call returns a structured error and
   * NEVER reaches the server, and emit MCP_TOOLS_QUARANTINED when a rug pull,
   * added-after-approval, or removed tool is detected (§14.6, global scope).
   */
  private async evaluateAndExpose(name: string, descriptors: McpToolDescriptor[]): Promise<void> {
    const pins = await this.loadPins();
    const evalResult = evaluatePins(pins.servers[name], descriptors);
    const live = this.servers.get(name);
    if (!live) return;
    this.unexposeTools(name);
    live.evaluated = evalResult.tools;
    live.tools = evalResult.tools.filter((t) => t.status === "approved").map((t) => mcpToolName(name, t.descriptor.name));
    for (const t of evalResult.tools) this.registerEvaluated(name, t);
    // Drop pins for removed tools so a later re-add is a fresh pending/quarantine.
    if (evalResult.removed.length && this.pinRecord) {
      const sp = this.pinRecord.servers[name];
      if (sp) {
        for (const r of evalResult.removed) delete sp.tools[r];
        await this.persistPins();
      }
    }
    if (evalResult.quarantined) {
      this.deps.bus.emit(
        "MCP_TOOLS_QUARANTINED",
        { server: name, changed: evalResult.changed, added: evalResult.added, removed: evalResult.removed },
        {},
      );
    }
  }

  /** Re-list a server's tools on `tools/list_changed` (§8.4). */
  private async refresh(name: string): Promise<void> {
    const live = this.servers.get(name);
    if (!live?.connection) return;
    try {
      const descriptors = await live.connection.listTools();
      await this.evaluateAndExpose(name, descriptors);
      this.deps.bus.emit("RESOURCE_CHANGED", { path: `mcp:${name}`, type: "mcp" }, {});
    } catch (e) {
      this.deps.bus.emit("ERROR_OCCURRED", { source: "mcp", server: name, message: maskText(String(e)) }, {});
    }
  }

  /** Disconnect and unregister a server's tools. */
  async disconnect(name: string): Promise<Result<void>> {
    const live = this.servers.get(name);
    if (!live) return err(coreError("NOT_FOUND", `mcp server ${name} not connected`));
    live.unsub?.();
    this.unexposeTools(name);
    try {
      await live.connection?.close();
    } catch {
      /* close is best-effort */
    }
    live.status = "disconnected";
    live.connection = undefined as never;
    live.tools = [];
    live.evaluated = [];
    this.emitChanged(name);
    return ok(undefined);
  }

  /** `mcp.list` — every configured/connected server as a DTO (§8.4). */
  list(): McpServerInfo[] {
    const names = new Set([...Object.keys(this.deps.getConfigs()), ...this.servers.keys()]);
    return [...names].map((name) => this.toInfo(name));
  }

  /** The DTO for one server, carrying trust and per-tool pin status (§8.4). */
  private toInfo(name: string): McpServerInfo {
    const live = this.servers.get(name);
    const cfg = live?.config ?? this.deps.getConfigs()[name];
    const toolStatuses: McpToolInfo[] = (live?.evaluated ?? []).map((t) => ({
      name: mcpToolName(name, t.descriptor.name),
      status: t.status,
      // §8.4/§9 — an MCP tool is ALWAYS gated: `readOnlyHint` is a DISPLAY-only
      // untrusted descriptor and never a permission input, so `readOnly` is
      // always false. The hint rides `readOnlyHint` for a UI, never here.
      readOnly: false,
      readOnlyHint: t.descriptor.readOnlyHint === true,
      ...(t.reason ? { reason: t.reason } : {}),
    }));
    return {
      name,
      transport: normalizeTransport(cfg?.transport),
      status: live?.status ?? "disconnected",
      tools: live?.tools ?? [],
      ...(toolStatuses.length ? { toolStatuses } : {}),
      ...(live?.error ? { error: live.error } : {}),
    };
  }

  /** The APPROVED tool registry names bound to the model (§8.4). Pending and
   * quarantined tools are never in this list — unbound and uncallable. */
  modelToolNames(): string[] {
    const out: string[] = [];
    for (const live of this.servers.values()) out.push(...live.tools);
    return out;
  }

  /**
   * `mcp.pins` — a read-only listing of every server's tools and their pin
   * statuses (§8.4). DTO-only; no library type.
   */
  pins(): McpServerInfo[] {
    return this.list();
  }

  /**
   * `mcp.approve(server, names?)` (§8.4). An ACTING operation gated through the
   * ONE decision point as a config-like write (`mcp_approve`, default ask); the
   * FULL masked diff of added/changed/removed rides the request. Requires the server connected and the supplied
   * names to exist in the current listing. On allow, re-pins the approved tools
   * and rebinds (only approved tools become callable).
   */
  async approve(server: string, names?: string[]): Promise<Result<McpServerInfo>> {
    const live = this.servers.get(server);
    if (!live?.connection || live.status !== "connected") {
      return err(coreError("INVALID_INPUT", `mcp server ${server} is not connected`, { field: "server" }));
    }
    const listed = new Set(live.evaluated.map((t) => t.descriptor.name));
    if (names) {
      const missing = names.filter((n) => !listed.has(n));
      if (missing.length) {
        return err(coreError("INVALID_INPUT", `unknown tool(s) on ${server}: ${missing.join(", ")}`, { field: "names" }));
      }
    }
    const pins = await this.loadPins();
    const diff = approvalDiff(pins.servers[server], live.evaluated.map((t) => t.descriptor));
    // Mask the description text in the diff through the ONE §10.10 detector
    // before it leaves the process in the approval payload.
    const maskedDiff = maskValue(diff) as ApprovalDiffEntry[];
    if (this.deps.approveGate) {
      const outcome = await this.deps.approveGate(server, maskedDiff);
      if (outcome.decision !== "allow") {
        return err(coreError("PERMISSION_DENIED", `mcp.approve ${server} ${outcome.reason ?? "rejected"}`));
      }
    }
    // Re-pin the approved set (all listed when no names, else the named subset).
    const sp = (pins.servers[server] ??= { tools: {} });
    for (const t of live.evaluated) {
      if (names && !names.includes(t.descriptor.name)) continue;
      sp.tools[t.descriptor.name] = { hash: t.hash, status: "approved" };
    }
    await this.persistPins();
    // Rebind with the fresh pins so approved tools become callable.
    await this.evaluateAndExpose(server, live.evaluated.map((t) => t.descriptor));
    return ok(this.toInfo(server));
  }

  private async persistPins(): Promise<void> {
    if (this.deps.pinStore && this.pinRecord) await this.deps.pinStore.save(this.pinRecord);
  }

  listConfigs(): Record<string, McpServerConfig> {
    return this.deps.getConfigs();
  }

  /**
   * Validate, move any secret `Authorization` header into the `CredentialStore`,
   * persist ONLY the non-secret config through the config capability, then
   * connect (§8.4, §13). A secret header is never written to `.voidrift/config.json`:
   * it is stored under `mcpAuthKey(name)` and resolved back at connect. When no
   * store is available the secret header is rejected rather than persisted raw.
   */
  async saveConfig(name: string, raw: unknown, layer: ConfigLayer = "project"): Promise<Result<McpServerInfo>> {
    const parsed = McpServerConfigSchema.safeParse(raw);
    if (!parsed.success) {
      return err(coreError("INVALID_INPUT", `invalid mcp config: ${parsed.error.message}`, { field: "config" }));
    }
    const scrubbed = await this.extractSecretHeaders(name, parsed.data);
    if (!scrubbed.ok) return scrubbed;
    const persistConfig = scrubbed.value;
    const saved = await this.deps.saveConfig(name, persistConfig, layer);
    if (!saved.ok) return saved;
    const info = await this.connect(name, persistConfig);
    return ok(info);
  }

  /**
   * Split secret headers out of a config before it is persisted (§8.4). Any
   * `Authorization` header, or any header value the §10.10 detector flags, is
   * moved into the `CredentialStore` and removed from the returned config, so
   * the persisted config carries only non-secret parameters. With no store the
   * secret cannot be held safely, so the save is rejected with guidance rather
   * than leaking the secret to disk.
   */
  private async extractSecretHeaders(name: string, config: McpServerConfig): Promise<Result<McpServerConfig>> {
    const headers = config.headers;
    if (!headers) return ok(config);
    const secret: Record<string, string> = {};
    const safe: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (isSecretHeader(key, value)) secret[key] = value;
      else safe[key] = value;
    }
    const secretKeys = Object.keys(secret);
    if (secretKeys.length === 0) return ok(config);
    if (!this.deps.credentials) {
      return err(
        coreError(
          "INVALID_INPUT",
          `mcp server ${name} config carries secret header(s) ${secretKeys.join(", ")} but no credential store is available; ` +
            `set VOIDRIFT_CREDENTIAL_KEY (or an OS keychain) so the token can be stored off disk (§8.4)`,
          { field: "headers" },
        ),
      );
    }
    // Store the Authorization value (the sole header the live transport injects
    // from the store). Any other secret-looking header is dropped from config
    // too rather than persisted raw.
    const authValue = secret["Authorization"] ?? secret[secretKeys[0]!]!;
    await this.deps.credentials.set(mcpAuthKey(name), authValue);
    const next: McpServerConfig = { ...config };
    if (Object.keys(safe).length) next.headers = safe;
    else delete next.headers;
    return ok(next);
  }

  /**
   * Resolve the auth material for a connect from the `CredentialStore` (§8.4):
   * the Authorization header stored under `mcpAuthKey`, and an OAuth provider
   * when the config declares non-secret `oauth` params. Returns `undefined` when
   * there is nothing to resolve or no store — connect then proceeds without auth.
   */
  private async resolveAuth(name: string, config: McpServerConfig): Promise<McpConnectAuth | undefined> {
    const store = this.deps.credentials;
    if (!store) return undefined;
    const transport = config.transport === "http" || config.transport === "http-sse";
    if (!transport) return undefined;
    const auth: McpConnectAuth = {};
    const header = await store.get(mcpAuthKey(name));
    if (header) auth.authorizationHeader = header;
    if (config.oauth) auth.oauthProvider = new CredentialStoreOAuthProvider(name, config.oauth, store);
    return auth.authorizationHeader || auth.oauthProvider ? auth : undefined;
  }

  async removeConfig(name: string, layer: ConfigLayer = "project"): Promise<Result<{ name: string }>> {
    await this.disconnect(name).catch(() => undefined);
    const removed = await this.deps.removeConfig(name, layer);
    if (!removed.ok) return removed;
    // Drop the server-scoped secret too, so it does not outlive the config (§8.4).
    await this.deps.credentials?.delete(mcpAuthKey(name)).catch(() => undefined);
    this.servers.delete(name);
    return ok({ name });
  }

  /** A server's instructions as turn metadata, prefixed by server name (§8.4). */
  turnMetadata(): string[] {
    const out: string[] = [];
    for (const [name, live] of this.servers) {
      const instr = live.connection?.instructions();
      if (instr) out.push(`[mcp:${name}] ${instr}`);
    }
    return out;
  }

  // ── tool registry exposure (§8.1, §8.4) ─────────────────────────────────────

  /**
   * Register ONE evaluated tool (§8.4). An `approved` tool is bound as a model
   * tool (origin `mcp`) with `readOnly: false` ALWAYS — an MCP tool is never
   * invisible to Guardian (§9): `readOnlyHint` is a DISPLAY-only untrusted
   * descriptor and never a permission input, so every MCP tool is gated and
   * asks until an allow rule covers it (§8.4). A `pending` or `quarantined`
   * tool is registered with a GUARD executor only: it is NOT in
   * `modelToolNames()` (never bound to the model), and an in-flight or
   * hallucinated call returns a structured error and NEVER reaches the server.
   */
  private registerEvaluated(server: string, t: EvaluatedTool): void {
    const name = mcpToolName(server, t.descriptor.name);
    const live = this.servers.get(server);
    (live!.registered ??= []).push(name);

    // §13.11 MCP2 — the effective (cascaded) model-facing description cap.
    const descMax = this.deps.limits ? this.deps.limits.get("mcp.descriptionMaxChars") : limitDefault("mcp.descriptionMaxChars");

    if (t.status !== "approved") {
      const reason = t.status === "quarantined" ? "tool quarantined" : "tool pending approval";
      this.deps.registry.register(
        {
          name,
          description: sanitizeDescription(t.descriptor.description, descMax),
          schema: z.object({}).loose(),
          readOnly: false,
          origin: "mcp",
        },
        async () => ({ content: `Error: ${reason}: ${name} (${t.reason ?? ""})`.trim(), status: "error" as const }),
        false,
      );
      return;
    }

    this.deps.registry.register(
      {
        name,
        description: sanitizeDescription(t.descriptor.description, descMax),
        // The server validates its own args; the registry schema is a permissive
        // object so a call is admitted and routed, then validated server-side.
        schema: z.object({}).loose(),
        // §8.1/§9 — an MCP tool is ALWAYS gated (readOnly false): a server's
        // `readOnlyHint` is an untrusted display hint, never a permission input.
        readOnly: false,
        origin: "mcp",
      },
      async (args: unknown) => {
        const current = this.servers.get(server);
        if (!current?.connection) {
          return { content: `Error: mcp server ${server} is not connected`, status: "error" as const };
        }
        // Defense in depth: a tool approved at bind time but quarantined by a
        // concurrent refresh must not reach the server (§8.4).
        const now = current.evaluated.find((e) => e.descriptor.name === t.descriptor.name);
        if (now && now.status !== "approved") {
          return { content: `Error: tool quarantined: ${name}`, status: "error" as const };
        }
        const result = await current.connection.callTool(t.descriptor.name, (args ?? {}) as Record<string, unknown>);
        return {
          content: result.content,
          status: result.isError ? ("error" as const) : ("success" as const),
        };
      },
      true,
    );
  }

  private unexposeTools(server: string): void {
    const live = this.servers.get(server);
    for (const toolName of live?.registered ?? []) this.deps.registry.unregister(toolName);
    if (live) live.registered = [];
  }

  private record(name: string, live: Live): McpServerInfo {
    this.servers.set(name, live);
    return this.toInfo(name);
  }
}

function normalizeTransport(t: string | undefined): "stdio" | "http" {
  return t === "http" || t === "http-sse" ? "http" : "stdio";
}
