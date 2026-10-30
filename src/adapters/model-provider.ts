/**
 * The model provider adapter (core-blueprint.md §11.2).
 *
 * Resolves the active endpoint from config and builds a LangChain
 * `BaseChatModel` by protocol: `openai` (and any OpenAI-compatible `baseUrl`) →
 * `ChatOpenAI`, `anthropic` → `ChatAnthropic`, `google` →
 * `ChatGoogleGenerativeAI`. A missing/unknown selected entry surfaces at the
 * first turn as `MODEL_NOT_CONFIGURED` (§3.3); the window must be known or
 * resolution fails with `ENDPOINT_WINDOW_UNKNOWN` (§4.8). One harness first-byte
 * watchdog and retry across providers (§11.5); the client constructor timeout is
 * the watchdog's 5× cap so the SDK timeout never fires before the watchdog.
 *
 * This adapter is the one place the use-case layer's model seam touches a
 * provider SDK. Tests inject a `fakeModel()` through the factory seam instead.
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { ModelInfo, ModelPort, ResolvedModel } from "../entities/ports/model-port.js";
import type { Config, ModelConfigEntry } from "../config/schema.js";
import { CoreErrorException, coreError, ErrorCode } from "../entities/errors.js";
import { WATCHDOG_CAP_MULTIPLE } from "../entities/model-error.js";
import { bundledCountTokens, type CountTokensFn } from "./count-tokens.js";

/** A factory that builds a chat model from a resolved entry — the provider seam (§11.7). */
export type ChatModelFactory = (resolved: ResolvedModel, entry: ModelConfigEntry) => BaseChatModel;

/** Uniform network settings applied to every bundled provider (§11.5, §3.6). */
export interface NetworkSettings {
  /** Per-request timeout in ms (`networkModelTimeout`). */
  timeout: number;
  /** Model-request retries at the network boundary (`networkModelMaxRetries`). */
  maxRetries: number;
}

/**
 * A plugin provider factory (§11.7): a protocol value → a bound LangChain
 * client. Either a bare `build` function (the original form) or an object
 * `{ build, countTokens? }` carrying the OPTIONAL exact input-token count for
 * the context pipeline's near-threshold check (§4.8). A function form has no
 * `countTokens` — the pipeline falls back to the measured-ratio estimate.
 */
export type ProviderFactory =
  | ((entry: ModelConfigEntry) => BaseChatModel)
  | {
      build(entry: ModelConfigEntry): BaseChatModel;
      countTokens?(entry: ModelConfigEntry, messages: import("@langchain/core/messages").BaseMessage[], tools: import("../entities/tool-registry.js").ToolDefinition[]): Promise<number | null>;
    };

/** Normalize a `ProviderFactory` to its build function (§11.7). */
function buildFn(f: ProviderFactory): (entry: ModelConfigEntry) => BaseChatModel {
  return typeof f === "function" ? f : (entry) => f.build(entry);
}

/** The bundled protocol names a plugin cannot shadow (§11.7). Bundled wins. */
export const BUNDLED_PROTOCOLS: ReadonlySet<string> = new Set(["openai", "anthropic", "google"]);

/** Known provider windows, used when an entry omits `contextLimit` (§11.2). */
const KNOWN_WINDOWS: Record<string, number> = {
  "gpt-4o": 128_000,
  "claude-3-5-sonnet": 200_000,
};

export class ModelProviderAdapter implements ModelPort {
  private selected: string | undefined;
  private cachedModel: BaseChatModel | null = null;
  private cachedFor: string | null = null;
  /** Plugin-registered provider factories, keyed by protocol (§11.7). A bundled
   * protocol is reserved and never shadowed; registering one is a no-op. */
  private readonly providers = new Map<string, ProviderFactory>();

  constructor(
    private readonly getConfig: () => Config,
    private readonly emit: (type: string, payload: unknown) => void,
    private readonly factory: ChatModelFactory = defaultChatModelFactory,
  ) {
    this.selected = this.getConfig().modelSelected;
  }

  /**
   * Register a plugin provider under a protocol (§11.7). A bundled protocol
   * (openai/anthropic/google) is reserved — bundled wins — so a registration
   * for one is ignored and the bundled client stands.
   */
  registerProvider(protocol: string, factory: ProviderFactory): void {
    if (BUNDLED_PROTOCOLS.has(protocol)) return;
    this.providers.set(protocol, factory);
  }

  /** Remove a plugin provider on disable (§11.7, §12.4). */
  unregisterProvider(protocol: string): void {
    this.providers.delete(protocol);
    // Drop a cached client built from this provider so resolution re-resolves.
    this.cachedModel = null;
    this.cachedFor = null;
  }

  /**
   * §4.8, §11.7 — the OPTIONAL exact input-token count capability for the ACTIVE
   * endpoint, or `undefined` when the protocol offers none. A plugin provider in
   * object form may expose its own `countTokens`; otherwise the bundled set
   * wires it for Anthropic (`count_tokens`) and the OpenAI-compatible
   * `/tokenize`, and leaves it unset elsewhere (Google, Bedrock). The capability
   * reaches ONLY the active endpoint's own `baseUrl` with its own key.
   */
  countTokensFn(): CountTokensFn | undefined {
    const resolved = this.resolve();
    const entry = this.entry(resolved.name)!;
    const provider = this.providers.get(resolved.protocol);
    if (provider && typeof provider !== "function" && provider.countTokens) {
      const ct = provider.countTokens.bind(provider);
      // §4.8 — a plugin provider's count is NOT declared exact; it defaults to
      // false, so the estimate margin is kept on it.
      return Object.assign(
        (messages: import("@langchain/core/messages").BaseMessage[], tools: import("../entities/tool-registry.js").ToolDefinition[]) =>
          ct(entry, messages, tools),
        { exact: false },
      ) as CountTokensFn;
    }
    if (provider) return undefined; // a plugin function-form provider has no count
    return bundledCountTokens(entry);
  }

  private entry(name: string): ModelConfigEntry | undefined {
    return this.getConfig().models[name];
  }

  resolve(): ResolvedModel {
    const name = this.selected ?? this.getConfig().modelSelected;
    if (!name) {
      throw new CoreErrorException(
        coreError(ErrorCode.MODEL_NOT_CONFIGURED, "no model endpoint selected"),
      );
    }
    const entry = this.entry(name);
    if (!entry) {
      throw new CoreErrorException(
        coreError(ErrorCode.MODEL_NOT_CONFIGURED, `model endpoint "${name}" is not configured`),
      );
    }
    const window = entry.contextLimit ?? KNOWN_WINDOWS[entry.model];
    if (window === undefined) {
      throw new CoreErrorException(
        coreError(
          ErrorCode.ENDPOINT_WINDOW_UNKNOWN,
          `context window unknown for "${name}"; set contextLimit`,
          { field: "contextLimit" },
        ),
      );
    }
    return {
      name,
      model: entry.model,
      protocol: entry.protocol,
      ...(entry.baseUrl !== undefined ? { baseUrl: entry.baseUrl } : {}),
      contextLimit: window,
      ...(entry.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
      vision: entry.vision ?? false,
    };
  }

  chatModel(): BaseChatModel {
    const resolved = this.resolve();
    // Reuse one client per active endpoint so turn and resume share model state
    // (a real provider client is reused too; a scripted test model advances).
    if (this.cachedModel && this.cachedFor === resolved.name) return this.cachedModel;
    const entry = this.entry(resolved.name)!;
    // A plugin-registered protocol resolves exactly like a bundled one (§11.7):
    // its factory builds the client and the same resolve/window/cache path
    // applies. A bundled protocol is reserved, so `providers` never holds one.
    const provider = this.providers.get(resolved.protocol);
    const network: NetworkSettings = {
      // §11.5 — the client constructor timeout is the watchdog's 5× cap (the
      // ceiling of the first-byte allowance) so the provider SDK's own timeout
      // never fires before the harness watchdog, which owns the first-byte bound.
      timeout: this.getConfig().networkModelTimeout * WATCHDOG_CAP_MULTIPLE,
      maxRetries: this.getConfig().networkModelMaxRetries,
    };
    // The default factory receives the uniform network settings (§11.5); an
    // injected factory (tests, plugins) keeps the two-arg seam untouched.
    this.cachedModel = provider
      ? buildFn(provider)(entry)
      : this.factory === defaultChatModelFactory
        ? defaultChatModelFactory(resolved, entry, network)
        : this.factory(resolved, entry);
    this.cachedFor = resolved.name;
    return this.cachedModel;
  }

  /**
   * Build a FRESH client for the active endpoint, bypassing the shared cache
   * (§5.5, §11.6). The session auto-namer is a passive call to the SAME endpoint
   * as interactive turns, but it must not share the one cached client — a fresh
   * client keeps the passive call independent of the turn's model state (and, in
   * tests, of a scripted model's finite response queue). Resolution, window and
   * network settings are identical to `chatModel()`; only the cache is skipped.
   */
  transientChatModel(): BaseChatModel {
    const resolved = this.resolve();
    const entry = this.entry(resolved.name)!;
    const provider = this.providers.get(resolved.protocol);
    const network: NetworkSettings = {
      // §11.5 — the client constructor timeout is the watchdog's 5× cap (the
      // ceiling of the first-byte allowance) so the provider SDK's own timeout
      // never fires before the harness watchdog, which owns the first-byte bound.
      timeout: this.getConfig().networkModelTimeout * WATCHDOG_CAP_MULTIPLE,
      maxRetries: this.getConfig().networkModelMaxRetries,
    };
    return provider
      ? buildFn(provider)(entry)
      : this.factory === defaultChatModelFactory
        ? defaultChatModelFactory(resolved, entry, network)
        : this.factory(resolved, entry);
  }

  /**
   * Build a FRESH client for the UTILITY endpoint (§11.6) — the background/
   * non-turn calls (session naming, reflection drafting). When `modelUtility`
   * is configured and names a resolvable endpoint, those calls run against it;
   * otherwise they fall back to the SELECTED transient client. There is NO
   * failover (owner decision 2026-10-18): the endpoint is chosen ONCE here, so a
   * background call against a configured-but-failing utility endpoint fails
   * quietly at its own best-effort seam and never retries the selected endpoint.
   * An invalid/unresolvable `modelUtility` degrades to the selected client (the
   * config is still a `voidrift doctor` finding, surfaced separately).
   */
  transientUtilityModel(): BaseChatModel {
    const name = this.getConfig().modelUtility;
    if (name !== undefined && name !== (this.selected ?? this.getConfig().modelSelected)) {
      const util = this.chatModelFor(name);
      if (util) return util;
    }
    return this.transientChatModel();
  }

  /**
   * Build a bound client for a NAMED config endpoint (§11.7, invariant 14) — the
   * internal resolver a worker's `AgentDefinition.model` STRING key resolves
   * through, keeping the public DTO free of a LangChain type. Returns undefined
   * when the key is not a configured endpoint (the caller maps that to a typed
   * MODEL_NOT_CONFIGURED). The active endpoint reuses the shared cached client.
   * Not part of the `ModelPort` interface — an adapter-internal seam boot wires.
   */
  chatModelFor(name: string): BaseChatModel | undefined {
    if (name === (this.selected ?? this.getConfig().modelSelected)) return this.chatModel();
    const entry = this.entry(name);
    if (!entry) return undefined;
    const window = entry.contextLimit ?? KNOWN_WINDOWS[entry.model];
    if (window === undefined) return undefined;
    const resolved: ResolvedModel = {
      name,
      model: entry.model,
      protocol: entry.protocol,
      ...(entry.baseUrl !== undefined ? { baseUrl: entry.baseUrl } : {}),
      contextLimit: window,
      ...(entry.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
      vision: entry.vision ?? false,
    };
    const provider = this.providers.get(resolved.protocol);
    const network: NetworkSettings = {
      // §11.5 — the client constructor timeout is the watchdog's 5× cap (the
      // ceiling of the first-byte allowance) so the provider SDK's own timeout
      // never fires before the harness watchdog, which owns the first-byte bound.
      timeout: this.getConfig().networkModelTimeout * WATCHDOG_CAP_MULTIPLE,
      maxRetries: this.getConfig().networkModelMaxRetries,
    };
    return provider
      ? buildFn(provider)(entry)
      : this.factory === defaultChatModelFactory
        ? defaultChatModelFactory(resolved, entry, network)
        : this.factory(resolved, entry);
  }

  list(): ModelInfo[] {
    const models = this.getConfig().models;
    const active = this.selected ?? this.getConfig().modelSelected;
    return Object.entries(models).map(([name, e]) => ({
      name,
      model: e.model,
      protocol: e.protocol,
      active: name === active,
      // `baseUrl` is a plain URL (no credentials); a client uses it to show
      // WHICH endpoint a model failure came from. Omitted when unset.
      ...(e.baseUrl !== undefined ? { baseUrl: e.baseUrl } : {}),
    }));
  }

  switch(name: string): ResolvedModel {
    if (!this.entry(name)) {
      throw new CoreErrorException(
        coreError(ErrorCode.MODEL_NOT_CONFIGURED, `model endpoint "${name}" is not configured`),
      );
    }
    this.selected = name;
    this.cachedModel = null;
    this.cachedFor = null;
    const resolved = this.resolve();
    this.emit("MODEL_CHANGED", { name, protocol: resolved.protocol });
    return resolved;
  }
}

/**
 * The one source of truth for the per-client network options (§11, §11.5): the
 * uniform per-request `timeout` and the pinned `maxRetries: 0` that disables the
 * provider SDK's own retry (VoidRift owns the retry loop at the engine seam,
 * §3.6, §11.9). Every bundled provider — OpenAI, Anthropic, Google — spreads the
 * SAME object into its constructor, so behaviour never depends on which provider
 * is configured. A plugin provider resolving through the same factory inherits
 * it too (§11.7).
 */
export function networkClientOptions(network?: NetworkSettings): Record<string, unknown> {
  const net: Record<string, unknown> = { maxRetries: 0 };
  if (network?.timeout !== undefined) net["timeout"] = network.timeout;
  return net;
}

/**
 * The default factory, building a provider client with uniform timeout/retry
 * (§11.5). The per-request `timeout` is applied to every bundled provider
 * identically; the provider SDK's own internal retry is DISABLED (`maxRetries: 0`)
 * because VoidRift owns the retry loop at the engine's `wrapModelCall` seam
 * (§3.6, §11.9) — this is what classifies failures, emits `MODEL_ERROR` per
 * attempt, and keeps a refused connection from waiting out the provider SDK's
 * opaque minutes-long connection-error backoff (a connect refusal is not a
 * timeout and must fail fast, §3.6).
 */
export function defaultChatModelFactory(
  resolved: ResolvedModel,
  entry: ModelConfigEntry,
  network?: NetworkSettings,
): BaseChatModel {
  const apiKey = entry.apiKeyEnv ? process.env[entry.apiKeyEnv] ?? "not-needed" : "not-needed";
  const passthrough: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (
      ["model", "protocol", "baseUrl", "apiKeyEnv", "contextLimit", "maxOutputTokens", "maxConcurrency", "vision"].includes(k)
    )
      continue;
    passthrough[k] = v;
  }
  // Uniform across providers (§11.5): the same timeout, and no provider-internal
  // retry (VoidRift's engine owns retry + MODEL_ERROR, §3.6, §11.9). Assembled
  // by the one shared helper so OpenAI, Anthropic and Google receive identical
  // network options (§11 integration paragraph).
  const net = networkClientOptions(network);
  // The response cap (§11.3): a positive `maxOutputTokens` maps onto the client's
  // native option — `maxTokens` for openai/anthropic, `maxOutputTokens` for
  // google — placed BEFORE the pass-through spread so an explicit pass-through
  // key from the user's config still wins. Absent/non-positive => send nothing,
  // keeping the provider default.
  const hasCap = typeof resolved.maxOutputTokens === "number" && resolved.maxOutputTokens > 0;
  switch (resolved.protocol) {
    case "anthropic":
      return new ChatAnthropic({
        model: resolved.model,
        apiKey,
        ...net,
        ...(hasCap ? { maxTokens: resolved.maxOutputTokens } : {}),
        ...passthrough,
      });
    case "google":
      return new ChatGoogleGenerativeAI({
        model: resolved.model,
        apiKey,
        ...net,
        ...(hasCap ? { maxOutputTokens: resolved.maxOutputTokens } : {}),
        ...passthrough,
      });
    case "openai":
      return new ChatOpenAI({
        model: resolved.model,
        apiKey,
        ...net,
        ...(hasCap ? { maxTokens: resolved.maxOutputTokens } : {}),
        ...(resolved.baseUrl ? { configuration: { baseURL: resolved.baseUrl } } : {}),
        // §4.8, FX-G — request token usage on the OpenAI-compatible STREAM so the
        // context meter is driven by the provider's real `input_tokens` rather
        // than the pre-flight estimate. `streamUsage` makes the client send
        // `stream_options: { include_usage: true }` on a streaming call. A user
        // who pins their own `stream_options` (or `streamUsage`) via config
        // pass-through wins — the spread below places `...passthrough` LAST — so
        // a router that owns usage behaviour is never overridden.
        streamUsage: true,
        ...passthrough,
      });
    default:
      // §11.7, FX-D — an unknown protocol NEVER silently routes to openai. When
      // the default factory is reached for a non-bundled protocol, no enabled
      // plugin registered a provider for it, so building a ChatOpenAI client and
      // sending the call to an OpenAI endpoint (a 404 "model does not exist") is
      // wrong and hides the real cause. Fail with a clear, typed error naming the
      // protocol and the fix — enable the plugin that provides it.
      throw new CoreErrorException(
        coreError(
          ErrorCode.MODEL_NOT_CONFIGURED,
          `protocol "${resolved.protocol}" is not provided by any enabled plugin — enable the plugin that provides it`,
          { field: "protocol" },
        ),
      );
  }
}
