import { describe, it, expect, vi } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { ModelProviderAdapter, defaultChatModelFactory } from "./model-provider.js";
import { ConfigSchema, type Config } from "../config/schema.js";

function config(partial: Partial<Config>): Config {
  return ConfigSchema.parse(partial);
}

describe("ModelProviderAdapter (§11.2)", () => {
  it("resolves the selected endpoint with its window", () => {
    const cfg = config({ models: { local: { model: "m", protocol: "openai", baseUrl: "http://x/v1", contextLimit: 8000 } }, modelSelected: "local" });
    const m = new ModelProviderAdapter(() => cfg, vi.fn(), () => fakeModel());
    const r = m.resolve();
    expect(r.name).toBe("local");
    expect(r.contextLimit).toBe(8000);
    expect(r.baseUrl).toBe("http://x/v1");
  });

  it("throws MODEL_NOT_CONFIGURED when nothing selected or missing entry", () => {
    const none = new ModelProviderAdapter(() => config({ models: {} }), vi.fn(), () => fakeModel());
    expect(() => none.resolve()).toThrow();
    const missing = new ModelProviderAdapter(() => config({ models: {}, modelSelected: "ghost" }), vi.fn(), () => fakeModel());
    expect(() => missing.resolve()).toThrow();
  });

  it("throws ENDPOINT_WINDOW_UNKNOWN when the window is neither set nor known", () => {
    const cfg = config({ models: { x: { model: "unknown-model", protocol: "openai" } }, modelSelected: "x" });
    const m = new ModelProviderAdapter(() => cfg, vi.fn(), () => fakeModel());
    expect(() => m.resolve()).toThrow(/window/i);
  });

  it("caches the chat model per endpoint and clears on switch", () => {
    const cfg = config({
      models: { a: { model: "ma", protocol: "openai", contextLimit: 1000 }, b: { model: "mb", protocol: "openai", contextLimit: 1000 } },
      modelSelected: "a",
    });
    let built = 0;
    const m = new ModelProviderAdapter(() => cfg, vi.fn(), () => {
      built += 1;
      return fakeModel();
    });
    m.chatModel();
    m.chatModel();
    expect(built).toBe(1);
    m.switch("b");
    m.chatModel();
    expect(built).toBe(2);
  });

  it("list marks the active endpoint and emits MODEL_CHANGED on switch", () => {
    const cfg = config({ models: { a: { model: "ma", protocol: "openai", contextLimit: 1 }, b: { model: "mb", protocol: "openai", contextLimit: 1 } }, modelSelected: "a" });
    const emit = vi.fn();
    const m = new ModelProviderAdapter(() => cfg, emit, () => fakeModel());
    expect(m.list().find((e) => e.active)?.name).toBe("a");
    m.switch("b");
    expect(emit).toHaveBeenCalledWith("MODEL_CHANGED", { name: "b", protocol: "openai" });
    expect(() => m.switch("ghost")).toThrow();
  });

  it("list exposes a configured baseUrl (read-only, no credentials) and omits it when unset", () => {
    const TEST_HOST = "models.example.test";
    const cfg = config({
      models: {
        proxied: { model: "mp", protocol: "openai", baseUrl: `https://${TEST_HOST}/v1`, apiKeyEnv: "SECRET_KEY", contextLimit: 8000 },
        cloud: { model: "mc", protocol: "openai", contextLimit: 8000 },
      },
      modelSelected: "proxied",
    });
    const m = new ModelProviderAdapter(() => cfg, vi.fn(), () => fakeModel());
    const list = m.list();
    const proxied = list.find((e) => e.name === "proxied")!;
    expect(proxied.baseUrl).toBe(`https://${TEST_HOST}/v1`);
    // The DTO never carries the apiKey/apiKeyEnv — only the plain URL.
    expect(JSON.stringify(proxied)).not.toContain("SECRET_KEY");
    expect(JSON.stringify(proxied)).not.toContain("apiKey");
    // An entry with no baseUrl omits the field entirely.
    expect(list.find((e) => e.name === "cloud")!.baseUrl).toBeUndefined();
  });

  it("defaultChatModelFactory builds a client per protocol", () => {
    const openai = defaultChatModelFactory(
      { name: "a", model: "gpt", protocol: "openai", baseUrl: "http://x/v1", contextLimit: 1, vision: false },
      { model: "gpt", protocol: "openai", baseUrl: "http://x/v1" },
    );
    expect(openai).toBeDefined();
    const anthropic = defaultChatModelFactory(
      { name: "c", model: "claude", protocol: "anthropic", contextLimit: 1, vision: false },
      { model: "claude", protocol: "anthropic" },
    );
    expect(anthropic).toBeDefined();
    const google = defaultChatModelFactory(
      { name: "g", model: "gemini", protocol: "google", contextLimit: 1, vision: false },
      { model: "gemini", protocol: "google" },
    );
    expect(google).toBeDefined();
  });

  it("NEVER silently routes an unknown protocol to openai — it throws a clear error naming the protocol (§11.7, FX-D)", () => {
    expect(() =>
      defaultChatModelFactory(
        { name: "bed", model: "nova", protocol: "bedrock", contextLimit: 1, vision: false },
        { model: "nova", protocol: "bedrock" },
      ),
    ).toThrow(/protocol "bedrock"/);
    // The message points the user at enabling the plugin that provides it.
    expect(() =>
      defaultChatModelFactory(
        { name: "x", model: "m", protocol: "mystery", contextLimit: 1, vision: false },
        { model: "m", protocol: "mystery" },
      ),
    ).toThrow(/enable the plugin that provides it/);
  });

  it("the bundled protocols (openai/anthropic/google) still build their clients (§11.2 regression)", () => {
    for (const protocol of ["openai", "anthropic", "google"] as const) {
      expect(
        defaultChatModelFactory(
          { name: protocol, model: "m", protocol, contextLimit: 1, vision: false },
          { model: "m", protocol },
        ),
      ).toBeDefined();
    }
  });

  it("requests stream usage on an OpenAI-compatible client, and a config pass-through overrides it (§4.8, FX-G)", () => {
    const base = defaultChatModelFactory(
      { name: "a", model: "gpt", protocol: "openai", baseUrl: "http://x/v1", contextLimit: 1, vision: false },
      { model: "gpt", protocol: "openai", baseUrl: "http://x/v1" },
    ) as unknown as Record<string, unknown>;
    expect(base["streamUsage"]).toBe(true);
    // A user who pins streamUsage: false via config pass-through wins.
    const overridden = defaultChatModelFactory(
      { name: "a", model: "gpt", protocol: "openai", contextLimit: 1, vision: false },
      { model: "gpt", protocol: "openai", streamUsage: false } as never,
    ) as unknown as Record<string, unknown>;
    expect(overridden["streamUsage"]).toBe(false);
  });

  it("maps a positive maxOutputTokens onto the client's cap per protocol (§11.3)", () => {
    const openai = defaultChatModelFactory(
      { name: "a", model: "gpt", protocol: "openai", contextLimit: 1, maxOutputTokens: 512, vision: false },
      { model: "gpt", protocol: "openai", maxOutputTokens: 512 },
    ) as unknown as Record<string, unknown>;
    expect(openai["maxTokens"]).toBe(512);
    const anthropic = defaultChatModelFactory(
      { name: "c", model: "claude", protocol: "anthropic", contextLimit: 1, maxOutputTokens: 512, vision: false },
      { model: "claude", protocol: "anthropic", maxOutputTokens: 512 },
    ) as unknown as Record<string, unknown>;
    expect(anthropic["maxTokens"]).toBe(512);
    const google = defaultChatModelFactory(
      { name: "g", model: "gemini", protocol: "google", contextLimit: 1, maxOutputTokens: 512, vision: false },
      { model: "gemini", protocol: "google", maxOutputTokens: 512 },
    ) as unknown as Record<string, unknown>;
    expect(google["maxOutputTokens"]).toBe(512);
  });

  it("sends no cap when maxOutputTokens is absent — provider default stands (§11.3)", () => {
    const openai = defaultChatModelFactory(
      { name: "a", model: "gpt", protocol: "openai", contextLimit: 1, vision: false },
      { model: "gpt", protocol: "openai" },
    ) as unknown as Record<string, unknown>;
    // ChatOpenAI leaves maxTokens undefined when not supplied.
    expect(openai["maxTokens"]).toBeUndefined();
    const google = defaultChatModelFactory(
      { name: "g", model: "gemini", protocol: "google", contextLimit: 1, vision: false },
      { model: "gemini", protocol: "google" },
    ) as unknown as Record<string, unknown>;
    expect(google["maxOutputTokens"]).toBeUndefined();
  });

  it("lets a user pass-through maxTokens override the resolved cap (§11.3)", () => {
    const openai = defaultChatModelFactory(
      { name: "a", model: "gpt", protocol: "openai", contextLimit: 1, maxOutputTokens: 512, vision: false },
      { model: "gpt", protocol: "openai", maxOutputTokens: 512, maxTokens: 99 },
    ) as unknown as Record<string, unknown>;
    expect(openai["maxTokens"]).toBe(99);
  });

  it("passes unknown vendor keys and nested modelKwargs through verbatim (§11.3 regression)", () => {
    const modelKwargs = { chat_template_kwargs: { enable_thinking: false }, foo: { bar: [1, 2] } };
    const openai = defaultChatModelFactory(
      { name: "a", model: "gpt", protocol: "openai", contextLimit: 1, maxOutputTokens: 512, vision: false },
      { model: "gpt", protocol: "openai", maxOutputTokens: 512, modelKwargs },
    ) as unknown as Record<string, unknown>;
    // The cap is set and the nested pass-through object is unchanged, deeply.
    expect(openai["maxTokens"]).toBe(512);
    expect(openai["modelKwargs"]).toEqual(modelKwargs);
  });

  it("resolves a plugin-registered protocol as a peer via its factory (§11.7)", () => {
    const cfg = config({
      models: { bed: { model: "nova", protocol: "testbedrock", contextLimit: 32_000 } },
      modelSelected: "bed",
    });
    // The default factory would throw for an unknown protocol; the plugin
    // factory is what builds the client, proving the registered protocol is a peer.
    const m = new ModelProviderAdapter(() => cfg, vi.fn(), () => {
      throw new Error("default factory must not run for a registered protocol");
    });
    const built = fakeModel();
    let calls = 0;
    m.registerProvider("testbedrock", (entry) => {
      calls += 1;
      expect(entry.model).toBe("nova");
      return built;
    });
    expect(m.chatModel()).toBe(built);
    expect(calls).toBe(1);
    // Unregister drops the provider and the cached client; resolution re-resolves.
    m.unregisterProvider("testbedrock");
    expect(() => m.chatModel()).toThrow(/default factory must not run/);
  });

  it("reserves bundled protocol names so a plugin cannot shadow them (§11.7)", () => {
    const cfg = config({ models: { a: { model: "m", protocol: "openai", contextLimit: 1000 } }, modelSelected: "a" });
    let shadowed = 0;
    const bundledBuilt = fakeModel();
    const m = new ModelProviderAdapter(() => cfg, vi.fn(), () => bundledBuilt);
    // Registering a bundled protocol is a no-op — the bundled factory stands.
    m.registerProvider("openai", () => {
      shadowed += 1;
      return fakeModel();
    });
    expect(m.chatModel()).toBe(bundledBuilt);
    expect(shadowed).toBe(0);
  });

  it("transientChatModel builds a FRESH client each call, bypassing the cache (§5.5, §11.6)", () => {
    const cfg = config({ models: { a: { model: "ma", protocol: "openai", contextLimit: 1000 } }, modelSelected: "a" });
    let built = 0;
    const m = new ModelProviderAdapter(() => cfg, vi.fn(), () => {
      built += 1;
      return fakeModel();
    });
    // The cached path builds once and reuses; a transient build is independent.
    const cached1 = m.chatModel();
    const cached2 = m.chatModel();
    expect(cached1).toBe(cached2);
    expect(built).toBe(1);
    const t1 = m.transientChatModel();
    const t2 = m.transientChatModel();
    expect(built).toBe(3); // two more builds, one per transient call
    expect(t1).not.toBe(t2); // a fresh, independent client each time
    expect(t1).not.toBe(cached1); // never the shared cached client
  });

  it("transientChatModel resolves the active endpoint through a plugin provider too (§11.7)", () => {
    const cfg = config({ models: { bed: { model: "nova", protocol: "testbedrock", contextLimit: 32_000 } }, modelSelected: "bed" });
    const m = new ModelProviderAdapter(() => cfg, vi.fn(), () => {
      throw new Error("default factory must not run for a registered protocol");
    });
    let calls = 0;
    m.registerProvider("testbedrock", () => {
      calls += 1;
      return fakeModel();
    });
    expect(m.transientChatModel()).toBeDefined();
    expect(calls).toBe(1);
  });

  it("transientUtilityModel resolves modelUtility when set, else the selected endpoint (§11.6)", () => {
    const cfg = config({
      models: {
        main: { model: "mmain", protocol: "openai", contextLimit: 1000 },
        util: { model: "mutil", protocol: "openai", contextLimit: 1000 },
      },
      modelSelected: "main",
      modelUtility: "util",
    });
    const names: string[] = [];
    const m = new ModelProviderAdapter(() => cfg, vi.fn(), (resolved) => {
      names.push(resolved.name);
      return fakeModel();
    });
    // modelUtility set → the background call resolves the UTILITY endpoint.
    m.transientUtilityModel();
    expect(names).toEqual(["util"]);

    // modelUtility unset → it falls back to the SELECTED endpoint.
    const cfg2 = config({ models: cfg.models, modelSelected: "main" });
    const names2: string[] = [];
    const m2 = new ModelProviderAdapter(() => cfg2, vi.fn(), (resolved) => {
      names2.push(resolved.name);
      return fakeModel();
    });
    m2.transientUtilityModel();
    expect(names2).toEqual(["main"]);
  });

  it("transientUtilityModel degrades to the selected endpoint when modelUtility names no entry — no failover (§11.6)", () => {
    const cfg = config({
      models: { main: { model: "mmain", protocol: "openai", contextLimit: 1000 } },
      modelSelected: "main",
      modelUtility: "ghost",
    });
    const names: string[] = [];
    const m = new ModelProviderAdapter(() => cfg, vi.fn(), (resolved) => {
      names.push(resolved.name);
      return fakeModel();
    });
    // An invalid modelUtility resolves nothing → it uses the selected transient
    // client (a single build of "main"); it never tries a second endpoint.
    expect(m.transientUtilityModel()).toBeDefined();
    expect(names).toEqual(["main"]);
  });
});
