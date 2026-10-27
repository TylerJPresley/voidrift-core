/**
 * The Plugins capability (core-blueprint.md §12.4) — the use-case layer.
 *
 * `config.plugins` is the authoritative load list; only listed, enabled entries
 * load. The loader adapter resolves entries (dedup by real path), scans licenses
 * at discovery (a copyleft dependency is rejected, `register` never called), and
 * imports `register`. Each plugin gets a scoped CoreAPI that tags every
 * registration with its id and namespaces its registry access, so contributions
 * are attributable and torn down wholesale on disable. A plugin that throws on
 * discovery, register, or a handler is contained and logged via `ERROR_OCCURRED`
 * — it never crashes the core. `list` reports listed plugins plus best-effort
 * `node_modules` candidates (`active: false`); `enable` writes a candidate's
 * entry into `config.plugins`, `disable` sets `enabled: false`, both hot-reload.
 */
import type { EventBus, EventEnvelope, EventScope } from "../entities/event-bus.js";
import type { PluginLoader, ResolvedPlugin } from "../adapters/plugin-loader.js";
import { toPluginMeta, isPermissiveLicense, type PluginMeta } from "../entities/plugins/plugin-meta.js";
import type { RegistryStore, RegistryEntry } from "../entities/registry/registry-store.js";
import { isReservedNamespace, isReservedKey } from "../entities/registry/registry-store.js";
import { isReservedPluginShortName } from "../entities/registry/registry-persistence.js";
import { isMetadataHost } from "../entities/never-list.js";
import type { Chunker } from "../entities/chunker.js";
import { limitDefault } from "../entities/limits.js";
import { coreError, err, ok, ErrorCode, type Result } from "../entities/errors.js";
import type { ConfigLayer, PluginEntry } from "../config/schema.js";
import type { PluginRegistryPort, PluginInstallerPort } from "../entities/ports/plugin-registry-port.js";
import {
  NpmSearchResponseSchema,
  NpmPackumentSchema,
  toSearchResult,
  toReview,
  satisfiesRange,
  isExactVersion,
  isSafeNpmArg,
  isDefaultListable,
  validateRegistryUrl,
  type PluginSearchResult,
  type PluginReview,
} from "../entities/plugins/plugin-registry.js";

/** The gate a user-initiated discovery op passes through — the ONE decision
 * point, built by boot from managed gate → Warden → Guardian, exactly as
 * `mcp.approve` does (§8.4, §12.4.1). `search`/`inspect` pass as a network read;
 * `install` passes as a HIGH-RISK write+exec+network action carrying the review.
 * A non-`allow` decision refuses the op. */
export type PluginGate = (
  op: "plugins_search" | "plugins_inspect" | "plugins_install",
  detail: { review?: PluginReview; name?: string },
) => Promise<{ decision: "allow" | "deny" | "ask"; reason?: string }>;

/** The discovery/install dependencies (§12.4.1). Optional so a core built
 * without a registry client still exposes list/enable/disable; the three
 * discovery ops then return a clear "not configured" error. */
export interface PluginDiscoveryDeps {
  registryClient: PluginRegistryPort;
  installer: PluginInstallerPort;
  /** The configured registry origin (validated https/loopback, §12.4.1). */
  getRegistryUrl: () => string;
  /** The host `@voidrift/core` version, for the peer-range mismatch flag. */
  hostCoreVersion: string;
  /** The resolved install store dir for a scope (§12.4.1). */
  installDirFor: (scope: "global" | "project") => string;
  gate: PluginGate;
  /** Network timeout and response byte cap for registry reads (§12.4.1). */
  networkTimeoutMs: number;
  searchMaxBytes: number;
  installTimeoutMs: number;
  installMaxBytes: number;
}

/**
 * The core services a scoped CoreAPI delegates to, each paired with the teardown
 * the capability runs on disable. The facade supplies this so the capability
 * never imports the facade (dependency inward, §1).
 */
export interface CoreServices {
  registerCommand(pluginId: string, name: string, handler: PluginCommandHandler): void;
  unregisterCommand(name: string): void;
  registerTool(pluginId: string, def: unknown, exec: unknown): void;
  unregisterTool(name: string): void;
  registerPrompt(pluginId: string, key: string, content: string): void;
  overridePrompt(pluginId: string, key: string, content: string): void;
  extendPrompt(pluginId: string, key: string, content: string): void;
  removePrompt(key: string): void;
  registerContextProvider(pluginId: string, layer: ContextLayer, provider: ContextProvider): string;
  unregisterContextProvider(id: string): void;
  registerModelProvider(pluginId: string, protocol: string, factory: unknown): void;
  unregisterModelProvider(protocol: string): void;
  registerExporter(pluginId: string, exporter: unknown): string;
  unregisterExporter(id: string): void;
  /** Store a panel declaration under the reserved `panels.{name}` core key
   * (§12.5, panels-blueprint §3); returns the key for wholesale teardown. */
  registerPanel(pluginId: string, name: string, definition: unknown): string;
  unregisterPanel(key: string): void;
  /** Store a dataset declaration under the reserved `datasets.{name}` core key
   * (§12.5, §12.7); returns the key for wholesale teardown. A validation failure
   * throws a typed CoreError the loader contains like any plugin failure. */
  registerDataset(pluginId: string, name: string, declaration: unknown): string;
  unregisterDataset(key: string): void;
  registerAgent(pluginId: string, manifest: unknown): void;
  registerGuardrail(pluginId: string, guardrail: unknown): void;
  /**
   * Register (or replace) a §9.5 plan-scope under a plugin-qualified identifier,
   * mapping onto `Guardian.registerScope`. The capability qualifies `id` with
   * `pluginId` so one plugin cannot register or clear another's scope. A scope
   * NEVER relaxes a force-ask or a hard-deny — that invariant lives in Guardian
   * (§9.3, §9.5) and is unaffected. Returns the qualified key for teardown.
   */
  registerScope(pluginId: string, id: string, scope: { writeGlobs: string[]; executePatterns: string[] }): string;
  /** Clear a §9.5 plan-scope the plugin registered, by plugin id + identifier (§9.5). */
  unregisterScope(pluginId: string, id: string): void;
  /** Clear a §9.5 plan-scope by its already-qualified key (teardown, §9.5). */
  unregisterScopeKey(key: string): void;
  /**
   * Register a §9.5.1 expectation (prediction vs journal) for a scope. Plugin-
   * callable: the plugin registers the prediction and renders the result the
   * core hands back; the journal read at close is core-internal and NEVER
   * reachable here (invariant 27). `scope` is the UNQUALIFIED scope identifier
   * (the plan step id) — the same id the plugin passes to `planScope` — so the
   * comparison binds to the right journal entries.
   */
  registerExpectation(scope: string, predicted: string[]): void;
  /** Clear a §9.5.1 expectation for a scope WITHOUT comparison (no surprise
   * report) — the plugin's explicit `core.expectations.clear` (§9.5.1). */
  clearExpectation(scope: string): void;  /** CLOSE a §9.5.1 expectation scope: read the scope's journal targets,
   * compare, and emit the one surprise report. The core drives this when the
   * plan-scope grant is cleared (`clearPlanScope`). Core-internal journal read. */
  closeExpectation(scope: string): void;
  /**
   * Register a §8.7 structure-aware INGEST chunker contributed by a plugin.
   * Returns a plugin-qualified key for wholesale teardown. The stored chunkers
   * are read by the Ingest use-case through the core's internal `chunkers()`
   * accessor; a registered chunker that `matches` a source wins over the builtin
   * chunkers (so a plugin AST chunker overrides a builtin for its extension). A
   * chunker is untrusted code: its output is validated and its failures
   * contained at use time (§8.7), not here.
   */
  registerChunker(pluginId: string, def: unknown): string;
  /** Remove a §8.7 plugin chunker by its qualified key (teardown). */
  unregisterChunker(key: string): void;
  /**
   * Register all *.md files from a directory as plugin-contributed documentation (§12.8).
   * Source is forced to the plugin id. Errors are contained; on unload, all docs for this
   * plugin are removed via `unregisterPluginDocs`.
   */
  registerPluginDocs(pluginId: string, dir: string, pluginRealPath: string): Promise<void>;
  /** Unregister all docs contributed by a plugin (called on plugin teardown, §12.8). */
  unregisterPluginDocs(pluginId: string): void;
  /**
   * Start a NEW session and send a first prompt (§12.3). A routine runs clean
   * every time; the host-facing `session.command("routine", id)` reaches this.
   * Returns the DTO result of the turn.
   */
  runInNewSession(firstPrompt: string, opts?: { name?: string }): Promise<unknown>;
  /** The read-only workspace surface the scoped API exposes as `core.workspace`
   * (retrieval-blueprint §3). Plugin-only; never a model tool. */
  workspace: WorkspaceSurface;
}

export type ContextLayer = "agent" | "void" | "rift";
export type ContextProvider = () => string | string[];
export type PluginCommandHandler = (args: unknown) => unknown | Promise<unknown>;

/**
 * The narrow, READ-ONLY workspace surface a plugin reaches through
 * `core.workspace` (retrieval-blueprint §3, §5; core §8). It is NOT a model tool
 * and never appears in any tool list — it is a plugin-only seam the retrieval
 * plugin drives its index from, and from which it reads the current turn's
 * input and the session's focus (recently read/edited files) so a synchronous
 * context provider can be fed from pre-resolved data (core §4 sync-snapshot).
 *
 * Every rule lives HERE (core side), never in the plugin: containment via the
 * FileSystemPort (no `..`, no symlink escape, realpath-checked), the same ignore
 * mechanism the glob/map tools use, and these fixed exclusions — `node_modules`,
 * `.git`, `.voidrift`, secret-looking names (`.env*`, `*.pem`, `*.key`,
 * `id_rsa*`, `*credentials*`, `.npmrc`, `.netrc`), binary files (a NUL byte in
 * the first 8 KiB), files larger than 1 MiB, and at most 20,000 files per
 * listing. Paths are returned workspace-relative and sanitized.
 */
export interface WorkspaceSurface {
  /** Workspace-relative, sanitized, ignore/exclusion-filtered paths; an optional
   * glob narrows the listing. Capped at 20,000 entries. */
  files(opts?: { pattern?: string }): Promise<string[]>;
  /** Read a file's UTF-8 text with its content hash, or null when the path is
   * excluded, binary, oversized, or unreadable. `maxBytes` defaults to 1 MiB. */
  readText(path: string, opts?: { maxBytes?: number }): Promise<{ text: string; hash: string } | null>;
  /** The latest user-message text of the active session (the turn input a
   * context provider would see), or "" when there is none. A synchronous
   * snapshot (core §4). */
  currentInput(): string;
  /** The session's current focus: files recently read or edited in the active
   * session (the document registry's read set), workspace-relative. */
  focusPaths(): string[];
  /**
   * Return (and lazily create) the owner-only cache directory for a plugin
   * `namespace`: `<workspace>/.voidrift/cache/<namespace>/` (retrieval §4).
   * Directories are created `0700`. The `namespace` must be a lowercase slug
   * and the path is always inside the workspace cache root — a traversal,
   * absolute, or non-slug argument is REFUSED (throws). The cache dir is harness
   * state: a protected control path for the model's file/shell tools (§9.4) and
   * excluded from rollback snapshots (§10.12). Only the owning plugin writes it.
   */
  cacheDir(namespace: string): string;
  /**
   * The surface's own content hash of a workspace file, SYNCHRONOUSLY from the
   * hash cache `readText` populates, or `null` when the path is unknown, outside
   * the workspace, or excluded by the same gitignore/secret rules `readText`
   * applies. A `null` marks a persisted index entry stale → rebuild. No async
   * read — safe inside a synchronous context provider.
   */
  hashFor(path: string): string | null;
}


/** The scoped CoreAPI surface a plugin's `register(core)` receives (§12.4). */
export interface ScopedCoreApi {
  readonly pluginId: string;
  register: {
    command(name: string, handler: PluginCommandHandler): void;
    tool(def: unknown, exec: unknown): void;
    prompt(key: string, content: string): void;
    overridePrompt(key: string, content: string): void;
    extendPrompt(key: string, content: string): void;
    contextProvider(layer: ContextLayer, provider: ContextProvider): void;
    modelProvider(protocol: string, factory: unknown): void;
    exporter(exporter: unknown): void;
    panel(name: string, definition: unknown): void;
    /**
     * Register a read-only DATASET (§12.7) the panels read through. `rows` is a
     * ZERO-argument reader returning plain JSON-serializable objects; the core
     * validates the declaration, stores it under the reserved `datasets.{name}`
     * key, masks every row before it leaves the core, and serves it to clients
     * via `datasets.rows`. A validation failure is contained and logged like any
     * plugin failure; the dataset is simply absent. Torn down on disable.
     */
    dataset(name: string, declaration: unknown): void;
    agent(manifest: unknown): void;
    guardrail(guardrail: unknown): void;
    /**
     * Register a §8.7 structure-aware INGEST chunker. A `Chunker` splits a
     * source into line-anchored chunks the ingest fan-out summarizes in
     * parallel; a registered chunker that `matches(path, head)` wins over the
     * core's builtin chunkers for that source (so a plugin can add e.g. a
     * tree-sitter chunker while the core stays parser-free). The chunker is
     * untrusted: the core VALIDATES its output (contiguous, covering,
     * ascending, bounded) and CONTAINS a throw — falling back to the builtin
     * with a warning — at use time (§8.7). Torn down with the plugin on disable.
     */
    chunker(chunker: Chunker): void;
    /**
     * Register (or replace) a §9.5 plan-scope under `id`. The identifier is
     * qualified by the plugin id internally, so one plugin cannot touch
     * another's scope. The scope auto-approves a matching non-read call BEFORE
     * Guardian's rules — but NEVER a force-ask or a hard-deny (§9.3, §9.5). It is
     * not persisted across sessions and is torn down with the plugin on disable.
     */
    planScope(id: string, scope: { writeGlobs: string[]; executePatterns: string[] }): void;
    /** Clear a §9.5 plan-scope the plugin registered (§9.5). */
    clearPlanScope(id: string): void;
    /**
     * Register all *.md files from a directory as plugin-contributed documentation (§12.8).
     * The source is forced to the plugin id (the caller cannot choose it).
     * On disable, all docs registered by this plugin are removed from the registry.
     * Returns void on success (errors are contained and logged).
     */
    docs(dir: string): void;
  };
  /**
   * The §9.5.1 expectation seam (prediction vs journal). Plugin-callable: the
   * plugin registers a prediction for a scope and clears it, and the core hands
   * the coverage result back at close. The journal read is CORE-INTERNAL and
   * absent here — a plugin can never read the journal (invariant 27). Fits
   * "plugins use only the CoreAPI surface" (§1 rule 10).
   */
  expectations: {
    /** Register a prediction for a scope (`scope` is the UNQUALIFIED plan step
     * id, the same id passed to `register.planScope`). An empty `predicted`
     * registers nothing. */
    register(req: { scope: string; predicted: string[] }): void;
    /** Clear a scope's prediction (no comparison runs). */
    clear(scope: string): void;
  };
  registry: {
    set(key: string, value: unknown): void;
    get(key: string): unknown;
    query(prefix: string): RegistryEntry[];
    remove(key: string): void;
  };
  events: {
    register(name: string): void;
    subscribe(type: string | "*", handler: (e: EventEnvelope) => void, opts?: { scope?: EventScope }): () => void;
    emit(key: string, payload: unknown, scope?: EventScope): void;
  };
  /** Start a new session with a first prompt (§12.3) — routines run clean. */
  session: {
    runInNewSession(firstPrompt: string, opts?: { name?: string }): Promise<unknown>;
  };
  /** A narrow, READ-ONLY workspace surface (retrieval-blueprint §3, §5). NOT a
   * model tool and absent from every tool list — a plugin-only seam. */
  workspace: WorkspaceSurface;
  /** A tiny READ-ONLY network-safety surface (§9.3). Lets a plugin that ships
   * telemetry (the exporters) reject a cloud instance-metadata endpoint WITHOUT
   * importing core internals — the single source of truth for the metadata host
   * list stays in the core's never-list. */
  network: NetworkSurface;
  /** §13.11 — a READ-ONLY accessor for the effective value of a registry limit
   * key. A plugin reads an effective (layered/resolved) value; it can never SET
   * a limit. An unknown key throws (a programming error). A plugin should pass a
   * safe fallback for when it runs against an older core without this surface. */
  limits: LimitsSurface;
}

/** The read-only limits helpers a plugin reaches through `core.limits` (§13.11).
 * READ ONLY: a plugin may read an effective value but never set one. */
export interface LimitsSurface {
  /** The effective value of a registry limit key (post-cascade). Throws on an
   * unknown key. */
  get(key: string): number;
}

/** The read-only network-safety helpers a plugin reaches through `core.network`
 * (§9.3). A single method today: is a host a cloud instance-metadata address?
 * Backed by the core's never-list `isMetadataHost`, so a plugin never duplicates
 * (or drifts from) that security-weighted list. */
export interface NetworkSurface {
  /** True when `host` (a hostname or IP literal, brackets optional) is a cloud
   * instance-metadata address (169.254.169.254, fd00:ec2::254,
   * metadata.google.internal, …). */
  isMetadataHost(host: string): boolean;
}

/** What one loaded plugin contributed, for wholesale teardown (§12.4). */
interface Contributions {
  commands: string[];
  tools: string[];
  prompts: string[];
  contextProviders: string[];
  modelProviders: string[];
  exporters: string[];
  panels: string[];
  datasets: string[];
  scopes: string[];
  chunkers: string[];
  unsubscribes: (() => void)[];
}

interface LoadedPlugin {
  meta: PluginMeta;
  realPath: string;
  contributions: Contributions;
  /** The config layer the enabled entry came from (§12.4.1), for `list`. */
  source: ConfigLayer;
  /** Whether the entry supplied a non-empty `options` object (§12.4) — surfaced
   * value-free by `plugins.list`, `voidrift access`, and `voidrift doctor`. */
  hasOptions: boolean;
}

export interface PluginsDeps {
  bus: EventBus;
  loader: PluginLoader;
  services: CoreServices;
  registryStore: RegistryStore;
  getPlugins: () => Record<string, PluginEntry>;
  /** Persist a plugins change through the config capability (validated, §13). */
  setPlugins: (entries: Record<string, PluginEntry>, layer: ConfigLayer) => Promise<Result<unknown>>;
  /**
   * The raw `plugins` record of each config layer, for load-time provenance
   * (§12.4.1). Lets `loadAll` report which layer each plugin came from (`source`
   * on `plugins.list`) and log a project-layer load at info level. Absent in
   * older callers → every entry's source defaults to `global`; boot always
   * supplies it.
   */
  getPluginLayers?: () => Record<ConfigLayer, Record<string, unknown>>;
  /** Discovery/install deps (§12.4.1); absent in a core with no registry client. */
  discovery?: PluginDiscoveryDeps;
  /** §13.11 — read-only access to an effective limit value for the plugin
   * `core.limits.get(key)` surface. Returns the layered/resolved value; a plugin
   * can only READ (never set). Absent → `core.limits.get` returns the registry
   * default (so a plugin has a safe default when the accessor is unwired). */
  getLimit?: (key: string) => number;
}

export class Plugins {
  private readonly loaded = new Map<string, LoadedPlugin>();
  /** Last successful search page per query, for 429/oversized/offline fallback (§12.4.1). */
  private readonly searchCache = new Map<string, PluginSearchResult[]>();

  constructor(private readonly deps: PluginsDeps) {}

  /** Load every listed, enabled plugin at boot (§12.4, §14.1). */
  async loadAll(): Promise<void> {
    const entries = this.deps.getPlugins();
    // Per-layer provenance (§12.4.1): the layer each enabled entry comes from is
    // recorded for `plugins.list` (`source`) and logged when a project-layer
    // plugin loads, so a project `.voidrift/config.json` that enables a plugin is
    // VISIBLE. There is NO workspace-trust gate: a project-layer plugin loads
    // exactly like a global one (records merge by id; the narrower layer replaces
    // the same id). Visibility, not a load-time gate, is the safeguard.
    // Dedup by real path: a package entry and a path entry to the same dir are one.
    const seenRealPaths = new Set<string>();
    for (const [id, entry] of Object.entries(entries)) {
      if (!entry.enabled) continue;
      const source = this.sourceOf(id);
      const resolved = this.resolveAndGuard(id, entry);
      if (!resolved) continue;
      if (seenRealPaths.has(resolved.realPath)) continue;
      seenRealPaths.add(resolved.realPath);
      await this.loadResolved(resolved, source, entry.options ?? {});
    }
  }

  /**
   * The config layer that supplied an enabled plugin entry (§12.4.1), narrowest
   * first (session → project → global → managed). Used for `plugins.list`
   * `source` and for logging a project-layer load. Defaults to `global` when no
   * layer provenance is available (older callers).
   */
  private sourceOf(id: string): ConfigLayer {
    const layers = this.deps.getPluginLayers?.();
    if (!layers) return "global";
    for (const layer of ["session", "project", "global", "managed"] as const) {
      if (id in (layers[layer] ?? {})) return layer;
    }
    return "global";
  }

  /**
   * Resolve an entry and run the license gate (§12.4). Returns the resolved
   * plugin only when it resolves and passes the license scan; a rejection is
   * logged via `ERROR_OCCURRED` and returns null.
   */
  private resolveAndGuard(id: string, entry: PluginEntry): ResolvedPlugin | null {
    let resolved: ResolvedPlugin | null;
    try {
      resolved = this.deps.loader.resolve({ id, ...(entry.path !== undefined ? { path: entry.path } : {}) });
    } catch (e) {
      this.logError(`plugin "${id}" failed to resolve: ${String(e)}`);
      return null;
    }
    if (!resolved) {
      this.logError(`plugin "${id}" could not be resolved`);
      return null;
    }
    // Reserved-namespace guard (§12.5): a plugin whose id equals or collides with
    // a reserved core namespace is rejected at discovery — its register is never
    // called. The id is the package name verbatim, so a package named "core"
    // would otherwise reach the core's structural registry entries.
    if (isReservedNamespace(resolved.meta.id)) {
      this.logError(`plugin "${id}" rejected: id "${resolved.meta.id}" collides with a reserved core namespace`);
      return null;
    }
    // Reserved-shortname guard (§12.5, STAGE 1b): a plugin whose short name
    // is one of the reserved folder names is rejected at registration to prevent
    // shadowing install artifacts.
    if (isReservedPluginShortName(resolved.meta.id)) {
      this.logError(`plugin "${id}" rejected: short name is reserved (§12.5)`);
      return null;
    }
    const scan = this.deps.loader.licenseScan(resolved);
    if (!scan.ok) {
      const o = scan.offender!;
      this.logError(`plugin "${id}" rejected: ${o.pkg} has non-permissive license "${o.license}"`);
      return null;
    }
    return resolved;
  }

  /** Import and register a resolved plugin, isolating any failure (§12.4). The
   * validated `plugins.<id>.options` object (or `{}`) is passed verbatim as the
   * second argument of `register(core, options)` — the seam the bundled exporter
   * and retrieval plugins read (`options.config`, `options.deps`, backends). */
  private async loadResolved(resolved: ResolvedPlugin, source: ConfigLayer = "global", options: Record<string, unknown> = {}): Promise<void> {
    if (this.loaded.has(resolved.meta.id)) return;
    const contributions = emptyContributions();
    const scoped = this.makeScoped(resolved.meta.id, contributions, resolved.realPath);
    try {
      const register = await this.deps.loader.importRegister(resolved);
      await register(scoped, options);
      this.loaded.set(resolved.meta.id, { meta: resolved.meta, realPath: resolved.realPath, contributions, source, hasOptions: Object.keys(options).length > 0 });
      // §12.4.1 — a project-layer plugin is in-process code enabled by a
      // `.voidrift/config.json`; record its load (id + layer) at info level so it
      // is visible without a new prompt.
      if (source === "project") {
        this.logInfo(`plugin "${resolved.meta.id}" loaded from the project layer`, resolved.meta.id, source);
      }
    } catch (e) {
      // Contained: tear down anything partially registered, log, never throw.
      this.teardown(contributions, resolved.meta.id);
      this.logError(`plugin "${resolved.meta.id}" failed on register: ${String(e)}`);
    }
  }

  /** Build the scoped CoreAPI for a plugin (§12.4): tagged + namespaced. */
  private makeScoped(pluginId: string, c: Contributions, realPath: string): ScopedCoreApi {
    const s = this.deps.services;
    const wrapHandler = <A extends unknown[]>(fn: (...a: A) => unknown): ((...a: A) => unknown) => {
      // A throwing plugin handler is contained (§12.4).
      return (...a: A) => {
        try {
          return fn(...a);
        } catch (e) {
          this.logError(`plugin "${pluginId}" handler threw: ${String(e)}`);
          return undefined;
        }
      };
    };
    return {
      pluginId,
      register: {
        command: (name, handler) => {
          s.registerCommand(pluginId, name, wrapHandler(handler) as PluginCommandHandler);
          c.commands.push(name);
        },
        tool: (def, exec) => {
          const name = (def as { name?: string }).name ?? "";
          s.registerTool(pluginId, def, exec);
          if (name) c.tools.push(name);
        },
        prompt: (key, content) => {
          s.registerPrompt(pluginId, key, content);
          c.prompts.push(key);
        },
        overridePrompt: (key, content) => {
          s.overridePrompt(pluginId, key, content);
          c.prompts.push(key);
        },
        extendPrompt: (key, content) => {
          s.extendPrompt(pluginId, key, content);
          c.prompts.push(key);
        },
        contextProvider: (layer, provider) => {
          const id = s.registerContextProvider(pluginId, layer, provider);
          c.contextProviders.push(id);
        },
        modelProvider: (protocol, factory) => {
          s.registerModelProvider(pluginId, protocol, factory);
          c.modelProviders.push(protocol);
        },
        exporter: (exporter) => {
          const id = s.registerExporter(pluginId, exporter);
          c.exporters.push(id);
        },
        panel: (name, definition) => {
          const key = s.registerPanel(pluginId, name, definition);
          c.panels.push(key);
        },
        dataset: (name, declaration) => {
          const key = s.registerDataset(pluginId, name, declaration);
          c.datasets.push(key);
        },
        agent: (manifest) => s.registerAgent(pluginId, manifest),
        guardrail: (guardrail) => s.registerGuardrail(pluginId, guardrail),
        chunker: (chunker) => {
          const key = s.registerChunker(pluginId, chunker);
          if (!c.chunkers.includes(key)) c.chunkers.push(key);
        },
        planScope: (id, scope) => {
          const key = s.registerScope(pluginId, id, scope);
          if (!c.scopes.includes(key)) c.scopes.push(key);
        },
        clearPlanScope: (id) => {
          s.unregisterScope(pluginId, id);
          // §9.5.1 — clearing the plan-scope grant IS the scope close; drive the
          // expectation comparison for the SAME scope id. Core-internal journal
          // read, never reachable by the plugin (invariant 27).
          s.closeExpectation(id);
        },
        docs: (dir: string) => {
          // §12.8 — register all *.md files from a directory as plugin-contributed docs.
          // Source is forced to the plugin id (the caller cannot choose it).
          // Errors are caught and logged; docs are tracked in manuals.pluginDocs for teardown.
          void (async () => {
            try {
              await s.registerPluginDocs(pluginId, dir, realPath);
            } catch (e) {
              this.logError(`plugin "${pluginId}" docs registration failed: ${String(e)}`);
            }
          })();
        },
      },
      expectations: {
        register: (req) => s.registerExpectation(req?.scope, req?.predicted),
        clear: (scope) => s.clearExpectation(scope),
      },
      registry: {
        set: (key, value) => {
          // A plugin may not write a reserved `panels.*` key directly (§12.5,
          // panels-blueprint §3); it contributes a panel only via register.panel.
          if (isReservedKey(key)) {
            this.logError(`plugin "${pluginId}" cannot registry.set a reserved key "${key}"; use register.panel`);
            return;
          }
          this.deps.registryStore.set(pluginId, key, value);
        },
        get: (key) => this.deps.registryStore.get(pluginId, key),
        query: (prefix) => this.deps.registryStore.query(pluginId, prefix),
        remove: (key) => this.deps.registryStore.remove(pluginId, key),
      },
      events: {
        register: (name) => this.deps.bus.register(name),
        subscribe: (type, handler, opts) => {
          const unsub = this.deps.bus.subscribe(
            type,
            (e) => {
              try {
                handler(e);
              } catch (err2) {
                this.logError(`plugin "${pluginId}" subscriber threw: ${String(err2)}`);
              }
            },
            { ...(opts?.scope ? { scope: opts.scope } : {}), isPlugin: true },
          );
          c.unsubscribes.push(unsub);
          return unsub;
        },
        emit: (key, payload, scope) => {
          if (this.deps.bus.isRegistered(key)) this.deps.bus.emit(key, payload, scope);
        },
      },
      session: {
        runInNewSession: (firstPrompt, opts) => s.runInNewSession(firstPrompt, opts),
      },
      // The read-only workspace surface (retrieval-blueprint §3). Delegated to the
      // core services verbatim — the rules (containment, ignore, exclusions) live
      // in the core implementation, never the plugin. Not a model tool.
      workspace: s.workspace,
      // The read-only network-safety surface (§9.3): the single source of truth
      // for cloud-metadata hosts stays in the core never-list; a plugin reaches
      // it here instead of duplicating (and drifting from) the list.
      network: { isMetadataHost: (host: string) => isMetadataHost(host) },
      // §13.11 — the read-only effective-limits accessor. A plugin reads a
      // layered value; it can never set one. Falls back to the registry default
      // when boot wired no accessor (older core), so a plugin always has a value.
      limits: { get: (key: string) => this.deps.getLimit?.(key) ?? limitDefault(key) },
    };
  }

  /** Tear down a plugin's tagged contributions and its namespaced registry (§12.4). */
  private teardown(c: Contributions, pluginId: string): void {
    for (const name of c.commands) this.deps.services.unregisterCommand(name);
    for (const name of c.tools) this.deps.services.unregisterTool(name);
    for (const key of c.prompts) this.deps.services.removePrompt(key);
    for (const id of c.contextProviders) this.deps.services.unregisterContextProvider(id);
    for (const protocol of c.modelProviders) this.deps.services.unregisterModelProvider(protocol);
    for (const id of c.exporters) this.deps.services.unregisterExporter(id);
    for (const key of c.panels) this.deps.services.unregisterPanel(key);
    for (const key of c.datasets) this.deps.services.unregisterDataset(key);
    for (const key of c.scopes) this.deps.services.unregisterScopeKey(key);
    for (const key of c.chunkers) this.deps.services.unregisterChunker(key);
    // §12.8 — unregister all docs contributed by this plugin.
    this.deps.services.unregisterPluginDocs(pluginId);
    for (const unsub of c.unsubscribes) unsub();
    this.deps.registryStore.removeNamespace(pluginId);
  }

  // ── the plugins CoreAPI namespace (§2.2) ──────────────────────────────────

  /** List listed plugins plus best-effort node_modules candidates (§12.4). */
  list(): PluginMeta[] {
    const entries = this.deps.getPlugins();
    const out: PluginMeta[] = [];
    const listedIds = new Set(Object.keys(entries));
    for (const [id, entry] of Object.entries(entries)) {
      const l = this.loaded.get(id);
      // The layer that supplied the entry (§12.4.1) — the loaded record's own
      // source when loaded, else re-derived from the layer provenance.
      const source = l?.source ?? this.sourceOf(id);
      const hasOptions = Object.keys(entry.options ?? {}).length > 0;
      if (l) {
        out.push({ ...l.meta, active: entry.enabled, source, hasOptions });
      } else {
        out.push({ id, name: id, version: "0.0.0", description: "", active: false, source, hasOptions });
      }
    }
    // Candidates present in node_modules but absent from config.plugins (§12.4):
    // not enabled by any layer, so no `source`.
    for (const cand of this.deps.loader.scanCandidates()) {
      const candId = cand.manifest.name ?? "";
      if (!candId || listedIds.has(candId)) continue;
      out.push(toPluginMeta(cand.manifest, false));
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Write a plugin's entry into config.plugins and hot-reload it (§12.4). */
  async enable(id: string, scope: ConfigLayer = "project", path?: string): Promise<Result<PluginMeta>> {
    const entries = { ...this.deps.getPlugins() };
    const existing = entries[id];
    entries[id] = {
      enabled: true,
      ...(path !== undefined ? { path } : existing?.path !== undefined ? { path: existing.path } : {}),
      ...(existing?.options !== undefined ? { options: existing.options } : {}),
    };
    const set = await this.deps.setPlugins(entries, scope);
    if (!set.ok) return err(set.error);
    const resolved = this.resolveAndGuard(id, entries[id]!);
    if (!resolved) return err(coreError(ErrorCode.INVALID_INPUT, `plugin "${id}" could not be loaded`, { field: "id" }));
    await this.loadResolved(resolved, scope, entries[id]!.options ?? {});
    const l = this.loaded.get(id);
    return ok(l ? { ...l.meta, active: true, source: scope } : { ...toPluginMeta(resolved.manifest, true), source: scope });
  }

  /** Set a plugin's entry to disabled and tear it down (§12.4). */
  async disable(id: string, scope: ConfigLayer = "project"): Promise<Result<{ id: string }>> {
    const entries = { ...this.deps.getPlugins() };
    if (!entries[id]) return err(coreError(ErrorCode.NOT_FOUND, `plugin "${id}" is not listed`, { field: "id" }));
    entries[id] = { ...entries[id]!, enabled: false };
    const set = await this.deps.setPlugins(entries, scope);
    if (!set.ok) return err(set.error);
    const l = this.loaded.get(id);
    if (l) {
      this.teardown(l.contributions, id);
      this.loaded.delete(id);
    }
    return ok({ id });
  }

  /** A plugin's scoped id for registry attribution (§12.5). */
  scope(id: string): Result<{ id: string }> {
    return ok({ id });
  }

  // ── discovery, inspection, and install (§12.4.1) ──────────────────────────

  /**
   * Browse the npm registry for `@voidrift/plugin-*` packages (§12.4.1). A gated
   * network read: the one decision point must allow it. Results are validated
   * with Zod, capped at `size`, and non-`@voidrift/plugin-*` names dropped from
   * the default listing. A 429, an oversized body, or an offline error degrades
   * to the last cached page with a `WARNING_EMITTED` rather than throwing.
   */
  async search(query: string, opts?: { size?: number; from?: number }): Promise<Result<PluginSearchResult[]>> {
    const d = this.deps.discovery;
    if (!d) return err(coreError(ErrorCode.NOT_IMPLEMENTED, "plugin discovery is not configured"));
    const gate = await d.gate("plugins_search", { name: query });
    if (gate.decision !== "allow") {
      return err(coreError("PERMISSION_DENIED", `plugins.search ${gate.reason ?? "denied"}`));
    }
    const registry = validateRegistryUrl(d.getRegistryUrl());
    if (!registry) return err(coreError(ErrorCode.CONFIG_INVALID, "plugins registry URL is not https (except loopback)", { field: "pluginsRegistry" }));
    const pageDefault = this.deps.getLimit?.("plugins.listPageDefault") ?? limitDefault("plugins.listPageDefault");
    const size = Math.max(1, Math.min(opts?.size ?? pageDefault, 250));
    const from = Math.max(0, opts?.from ?? 0);
    const text = `scope:voidrift keywords:voidrift-plugin ${query}`.trim();
    const url = `${registry}/-/v1/search?text=${encodeURIComponent(text)}&size=${size}&from=${from}`;
    const cacheKey = `${text}|${size}|${from}`;

    const res = await d.registryClient.get(url, { timeoutMs: d.networkTimeoutMs, maxBytes: d.searchMaxBytes });
    const degrade = (reason: string): Result<PluginSearchResult[]> => {
      this.warnFallback(reason);
      return ok(this.searchCache.get(cacheKey) ?? []);
    };
    if (res.errored) return degrade("offline");
    if (res.status === 429) return degrade("rate-limited");
    if (res.tooLarge) return degrade("oversized");
    if (res.status < 200 || res.status >= 300) return degrade(`status ${res.status}`);

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      return degrade("malformed");
    }
    const valid = NpmSearchResponseSchema.safeParse(parsed);
    if (!valid.success) return degrade("malformed");
    const results = valid.data.objects
      .map(toSearchResult)
      .filter((r) => isDefaultListable(r.name))
      .slice(0, size);
    this.searchCache.set(cacheKey, results);
    return ok(results);
  }

  /**
   * Fetch the packument for an exact version and return a `PluginReview` — NO
   * code runs (§12.4.1). A gated network read. A typed non-`@voidrift` name is
   * inspectable but marked `verified: false`.
   */
  async inspect(name: string, version?: string): Promise<Result<PluginReview>> {
    const d = this.deps.discovery;
    if (!d) return err(coreError(ErrorCode.NOT_IMPLEMENTED, "plugin discovery is not configured"));
    if (typeof name !== "string" || name.trim() === "") {
      return err(coreError(ErrorCode.INVALID_INPUT, "plugins.inspect requires a package name", { field: "name" }));
    }
    const gate = await d.gate("plugins_inspect", { name });
    if (gate.decision !== "allow") {
      return err(coreError("PERMISSION_DENIED", `plugins.inspect ${gate.reason ?? "denied"}`));
    }
    const registry = validateRegistryUrl(d.getRegistryUrl());
    if (!registry) return err(coreError(ErrorCode.CONFIG_INVALID, "plugins registry URL is not https (except loopback)", { field: "pluginsRegistry" }));
    const url = `${registry}/${name.replace("/", "%2f")}`;
    const res = await d.registryClient.get(url, { timeoutMs: d.networkTimeoutMs, maxBytes: d.searchMaxBytes });
    if (res.errored) return err(coreError("NETWORK_ERROR", `plugins.inspect could not reach the registry`));
    if (res.tooLarge) return err(coreError("NETWORK_ERROR", `plugins.inspect response exceeded the size cap`));
    if (res.status === 404) return err(coreError(ErrorCode.NOT_FOUND, `package "${name}" was not found`, { field: "name" }));
    if (res.status < 200 || res.status >= 300) return err(coreError("NETWORK_ERROR", `plugins.inspect got status ${res.status}`));
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      return err(coreError(ErrorCode.INVALID_INPUT, "plugins.inspect got a malformed registry response"));
    }
    const valid = NpmPackumentSchema.safeParse(parsed);
    if (!valid.success) return err(coreError(ErrorCode.INVALID_INPUT, "plugins.inspect got an invalid packument"));
    // The install dir is scope-independent for display; use the global store as
    // the shown target (the client passes the real scope at install).
    const review = toReview(valid.data, {
      ...(version !== undefined ? { version } : {}),
      hostCoreVersion: d.hostCoreVersion,
      installDir: d.installDirFor("global"),
      satisfies: satisfiesRange,
    });
    if (!review) return err(coreError(ErrorCode.NOT_FOUND, `version "${version}" of "${name}" was not found`, { field: "version" }));
    return ok(review);
  }

  /**
   * Install a reviewed plugin (§12.4.1). Refuses a version range, an integrity
   * that does not match the reviewed one, a non-permissive license, a name that
   * fails the reserved-namespace guard, and any request without `confirm: true`.
   * A HIGH-RISK gated write+exec+network action: the one decision point must
   * allow it, carrying the `PluginReview`. On allow it inspects to bind the
   * integrity, spawns the scrubbed `npm install --ignore-scripts`, verifies the
   * installed name/version/integrity/`voidrift.plugin`/license, rolls back on any
   * mismatch, and on success enables + hot-loads. Emits `PLUGIN_INSTALLED` /
   * `PLUGIN_INSTALL_FAILED` and `RESOURCE_CHANGED { type: "plugin" }`.
   */
  async install(req: {
    name: string;
    version: string;
    integrity: string;
    scope: "global" | "project";
    confirm: true;
  }): Promise<Result<PluginMeta>> {
    const d = this.deps.discovery;
    if (!d) return err(coreError(ErrorCode.NOT_IMPLEMENTED, "plugin discovery is not configured"));
    const fail = (code: string, message: string, field?: string): Result<PluginMeta> => {
      this.deps.bus.emit("PLUGIN_INSTALL_FAILED", { name: req?.name, reason: message }, {});
      return err(coreError(code, message, field ? { field } : undefined));
    };
    if (!req || typeof req.name !== "string" || req.name.trim() === "") {
      return fail(ErrorCode.INVALID_INPUT, "plugins.install requires a package name", "name");
    }
    if (req.confirm !== true) {
      return fail("PERMISSION_DENIED", "plugins.install requires explicit confirm: true", "confirm");
    }
    // Reject a flag-like or whitespace/control name or version BEFORE any network
    // read or spawn (§12.4.1 hardening): a value starting with `-` would be read
    // by npm as an option, and whitespace/control chars never belong in a name or
    // version. argv/`shell:false` already blocks injection; this makes the refusal
    // explicit and early.
    if (!isSafeNpmArg(req.name)) {
      return fail(ErrorCode.INVALID_INPUT, `plugins.install refused: "${req.name}" is not a valid package name`, "name");
    }
    if (typeof req.version !== "string" || !isSafeNpmArg(req.version)) {
      return fail(ErrorCode.INVALID_INPUT, `plugins.install refused: "${String(req.version)}" is not a valid version`, "version");
    }
    if (!isExactVersion(req.version)) {
      return fail(ErrorCode.INVALID_INPUT, `plugins.install requires an exact version, got "${req.version}"`, "version");
    }
    if (isReservedNamespace(req.name)) {
      return fail(ErrorCode.INVALID_INPUT, `plugins.install refused: "${req.name}" collides with a reserved core namespace`, "name");
    }

    // Re-inspect to bind the reviewed integrity to a fresh packument read: the
    // install integrity must equal both the request and the registry's current
    // integrity for the exact version (§12.4.1).
    const reviewRes = await this.inspect(req.name, req.version);
    if (!reviewRes.ok) {
      return fail(reviewRes.error.code, `plugins.install could not verify "${req.name}": ${reviewRes.error.message}`, reviewRes.error.field);
    }
    const review = reviewRes.value;
    if (!review.integrity || review.integrity !== req.integrity) {
      return fail(ErrorCode.INVALID_INPUT, "plugins.install integrity does not match the reviewed package", "integrity");
    }
    if (!review.licenseAllowed) {
      return fail(ErrorCode.INVALID_INPUT, `plugins.install refused: license "${review.license}" is not permissive`, "name");
    }

    // HIGH-RISK gate carrying the review (§12.4.1).
    const gate = await d.gate("plugins_install", { review, name: req.name });
    if (gate.decision !== "allow") {
      return fail("PERMISSION_DENIED", `plugins.install ${gate.reason ?? "denied"}`);
    }

    const registry = validateRegistryUrl(d.getRegistryUrl());
    if (!registry) return fail(ErrorCode.CONFIG_INVALID, "plugins registry URL is not https (except loopback)", "pluginsRegistry");
    const installDir = d.installDirFor(req.scope);
    const installed = await d.installer.install({
      name: req.name,
      version: req.version,
      installDir,
      registry,
      timeoutMs: d.installTimeoutMs,
      maxBytes: d.installMaxBytes,
    });
    if (!installed.ok || !installed.packageDir) {
      return fail(ErrorCode.INTERNAL, `plugins.install failed: ${installed.reason ?? "unknown error"}`);
    }

    // Post-install verification against the review (§12.4.1); any mismatch rolls back.
    const verify = this.verifyInstalled(installed.packageDir, review);
    if (!verify.ok) {
      await d.installer.rollback(installDir, req.name);
      return fail(ErrorCode.INVALID_INPUT, `plugins.install verification failed: ${verify.reason}`);
    }

    // Enable + hot-load through the validated config path (§12.4). The store is
    // on the module path (§12.4 resolution order), so an id entry resolves.
    const layer: ConfigLayer = req.scope === "global" ? "global" : "project";
    const enabled = await this.enable(req.name, layer);
    if (!enabled.ok) {
      await d.installer.rollback(installDir, req.name);
      return fail(enabled.error.code, `plugins.install could not enable: ${enabled.error.message}`);
    }
    this.deps.bus.emit("PLUGIN_INSTALLED", { name: req.name, version: req.version, scope: req.scope }, {});
    this.deps.bus.emit("RESOURCE_CHANGED", { path: "plugins", type: "plugin" }, {});
    return ok(enabled.value);
  }

  /** Verify an installed package against its review (§12.4.1): name, version,
   * integrity, `voidrift.plugin`, and a permissive license. Reuses the loader's
   * manifest read and `isPermissiveLicense` — no second scanner. */
  private verifyInstalled(packageDir: string, review: PluginReview): { ok: boolean; reason?: string } {
    const manifest = this.deps.loader.readInstalledManifest(packageDir);
    if (!manifest) return { ok: false, reason: "installed package has no readable package.json" };
    if (manifest.name !== review.name) return { ok: false, reason: `name "${manifest.name}" ≠ reviewed "${review.name}"` };
    if (manifest.version !== review.version) return { ok: false, reason: `version "${manifest.version}" ≠ reviewed "${review.version}"` };
    if (manifest.voidrift?.plugin !== true) return { ok: false, reason: "installed package is not a voidrift plugin" };
    if (!isPermissiveLicense(manifest.license)) return { ok: false, reason: `license "${manifest.license ?? "UNKNOWN"}" is not permissive` };
    const integrity = this.deps.loader.readInstalledIntegrity(packageDir);
    // Fail CLOSED (§12.4.1 hardening): the reviewed integrity was verified to be
    // present at inspect, so npm MUST have recorded a resolved-tarball integrity
    // for the install. A null here means we cannot confirm the bytes on disk are
    // the reviewed bytes — refuse rather than skip. A mismatch is a tampered or
    // swapped tarball. Either way we roll back.
    if (integrity === null) {
      return { ok: false, reason: "npm recorded no integrity for the installed package; refusing (fail closed)" };
    }
    if (integrity !== review.integrity) {
      return { ok: false, reason: "installed tarball integrity does not match the review" };
    }
    return { ok: true };
  }

  private warnFallback(reason: string): void {
    this.deps.bus.emit("WARNING_EMITTED", { category: "fallback", source: "plugins", reason }, {});
  }

  private logError(message: string): void {
    this.deps.bus.emit("ERROR_OCCURRED", { source: "plugin", message, level: "warning" }, {});
  }

  private logInfo(message: string, id: string, layer: ConfigLayer): void {
    this.deps.bus.emit("PLUGIN_LOADED", { id, layer, message, level: "info" }, {});
  }
}

function emptyContributions(): Contributions {
  return { commands: [], tools: [], prompts: [], contextProviders: [], modelProviders: [], exporters: [], panels: [], datasets: [], scopes: [], chunkers: [], unsubscribes: [] };
}
