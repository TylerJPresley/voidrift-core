import { describe, it, expect } from "vitest";
import { Plugins, type CoreServices } from "./plugins.js";
import type { ResolvedPlugin, PluginLoader } from "../adapters/plugin-loader.js";
import { RegistryStore } from "../entities/registry/registry-store.js";
import { EventBus } from "../entities/event-bus.js";
import type { PluginEntry } from "../config/schema.js";

type RegisterFn = (core: unknown, options?: unknown) => void | Promise<void>;

/** A fake loader driven by in-memory package tables. */
function fakeLoader(opts: {
  resolved: Record<string, ResolvedPlugin>;
  licenses?: Record<string, { ok: boolean; offender?: { pkg: string; license: string } }>;
  registers?: Record<string, RegisterFn>;
  candidates?: { manifest: { name?: string; voidrift?: { plugin?: boolean } }; realPath: string }[];
}): PluginLoader {
  return {
    resolve: (entry: { id: string; path?: string }) => opts.resolved[entry.id] ?? null,
    licenseScan: (r: ResolvedPlugin) => opts.licenses?.[r.meta.id] ?? { ok: true },
    importRegister: async (r: ResolvedPlugin) => opts.registers?.[r.meta.id] ?? (() => {}),
    scanCandidates: () => opts.candidates ?? [],
  } as unknown as PluginLoader;
}

function resolved(id: string, realPath = `/real/${id}`): ResolvedPlugin {
  return {
    entryKey: id,
    realPath,
    manifest: { name: id, version: "1.0.0", license: "MIT", voidrift: { plugin: true } },
    meta: { id, name: id, version: "1.0.0", description: "", active: true, license: "MIT" },
  };
}

function makeServices(sink: Record<string, unknown>, registryStore?: RegistryStore): CoreServices {
  const commands = new Map<string, unknown>();
  sink["commands"] = commands;
  return {
    registerCommand: (_p, name, handler) => commands.set(name, handler),
    unregisterCommand: (name) => void commands.delete(name),
    registerTool: () => {},
    unregisterTool: () => {},
    registerPrompt: () => {},
    overridePrompt: () => {},
    extendPrompt: () => {},
    removePrompt: () => {},
    registerContextProvider: () => "ctx:0",
    unregisterContextProvider: () => {},
    registerModelProvider: () => {},
    unregisterModelProvider: () => {},
    registerExporter: () => "exp:0",
    unregisterExporter: () => {},
    registerPanel: () => "panels.x",
    unregisterPanel: () => {},
    // §12.7 — store the validated dataset under the reserved core key so a
    // plugin-context test can read it back via `datasets.rows`. Mirrors boot.
    registerDataset: (_p, name, declaration) => {
      const key = `datasets.${name}`;
      registryStore?.set("core", key, declaration);
      return key;
    },
    unregisterDataset: (key) => registryStore?.remove("core", key),
    registerAgent: () => {},
    registerGuardrail: () => {},
    registerScope: (pluginId, id) => `${pluginId}:${id}`,
    unregisterScope: () => {},
    unregisterScopeKey: () => {},
    registerExpectation: () => {},
    clearExpectation: () => {},
    closeExpectation: () => {},
    registerChunker: () => "chunker:0",
    unregisterChunker: () => {},
    runInNewSession: async () => ({ status: "completed" }),
    workspace: { files: async () => [], readText: async () => null, currentInput: () => "", focusPaths: () => [], cacheDir: () => "/tmp/cache", hashFor: () => null },
  };
}

function make(
  entries: Record<string, PluginEntry>,
  loader: PluginLoader,
  m1?: {
    layers?: Record<string, Record<string, unknown>>;
  },
) {
  const bus = new EventBus();
  const registryStore = new RegistryStore();
  const sink: Record<string, unknown> = {};
  const services = makeServices(sink, registryStore);
  let current = { ...entries };
  const plugins = new Plugins({
    bus,
    loader,
    services,
    registryStore,
    getPlugins: () => current,
    setPlugins: async (next) => {
      current = next;
      return { ok: true as const, value: next };
    },
    ...(m1?.layers
      ? {
          getPluginLayers: () => ({
            managed: m1.layers!["managed"] ?? {},
            global: m1.layers!["global"] ?? {},
            project: m1.layers!["project"] ?? {},
            session: m1.layers!["session"] ?? {},
          }),
        }
      : {}),
  });
  return { plugins, bus, registryStore, sink, getCurrent: () => current };
}

describe("Plugins capability (§12.4)", () => {
  it("loads a listed, enabled plugin and tags its registry writes to its id", async () => {
    const loader = fakeLoader({
      resolved: { a: resolved("a") },
      registers: { a: (core: any) => core.registry.set("k", "v") },
    });
    const env = make({ a: { enabled: true } }, loader);
    await env.plugins.loadAll();
    expect(env.registryStore.get("a", "k")).toBe("v");
  });

  it("a plugin registers a dataset through its scoped context; it lands under datasets.{name} and is torn down on disable (§12.7)", async () => {
    const loader = fakeLoader({
      resolved: { a: resolved("a") },
      registers: {
        a: (core: any) =>
          core.register.dataset("plug-data", { description: "plugin rows", rows: () => [{ x: 1 }] }),
      },
    });
    const env = make({ a: { enabled: true } }, loader);
    await env.plugins.loadAll();
    const stored = env.registryStore.get("core", "datasets.plug-data") as { rows: () => unknown[] } | null;
    expect(stored).not.toBeNull();
    expect(stored!.rows()).toEqual([{ x: 1 }]);
    // §12.4 teardown — disabling the plugin removes its dataset.
    await env.plugins.disable("a");
    expect(env.registryStore.get("core", "datasets.plug-data")).toBeNull();
  });

  it("a plugin cannot registry.set a reserved datasets.* key directly (§12.5)", async () => {
    const errors: string[] = [];
    const loader = fakeLoader({
      resolved: { a: resolved("a") },
      registers: { a: (core: any) => core.registry.set("datasets.sneaky", { rows: () => [] }) },
    });
    const env = make({ a: { enabled: true } }, loader);
    env.bus.subscribe("ERROR_OCCURRED", (e) => errors.push(JSON.stringify(e.payload)));
    await env.plugins.loadAll();
    expect(env.registryStore.get("core", "datasets.sneaky")).toBeNull();
    expect(errors.some((e) => e.includes("reserved key"))).toBe(true);
  });

  it("exposes core.network.isMetadataHost backed by the core never-list (§9.3)", async () => {
    let net: { isMetadataHost(host: string): boolean } | undefined;
    const loader = fakeLoader({
      resolved: { a: resolved("a") },
      registers: { a: (core: any) => void (net = core.network) },
    });
    const env = make({ a: { enabled: true } }, loader);
    await env.plugins.loadAll();
    expect(net).toBeDefined();
    expect(net!.isMetadataHost("169.254.169.254")).toBe(true);
    expect(net!.isMetadataHost("metadata.google.internal")).toBe(true);
    expect(net!.isMetadataHost("collector.example.com")).toBe(false);
  });

  it("exposes a READ-ONLY core.limits.get(key) returning the wired effective value (§13.11)", async () => {
    let lim: { get(key: string): number } | undefined;
    const loader = fakeLoader({
      resolved: { a: resolved("a") },
      registers: { a: (core: any) => void (lim = core.limits) },
    });
    // Build Plugins directly so we can wire getLimit (the boot-level accessor).
    const bus = new EventBus();
    const registryStore = new RegistryStore();
    const services = makeServices({});
    const plugins = new Plugins({
      bus,
      loader,
      services,
      registryStore,
      getPlugins: () => ({ a: { enabled: true } }),
      setPlugins: async (n) => ({ ok: true as const, value: n }),
      // The boot accessor: a plugin reads an effective value (here, overridden).
      getLimit: (key: string) => (key === "plan.maxTouches" ? 7 : 123),
    });
    await plugins.loadAll();
    expect(lim).toBeDefined();
    // The wired effective value is returned (not the registry default of 50).
    expect(lim!.get("plan.maxTouches")).toBe(7);
    expect(lim!.get("plan.maxFieldLength")).toBe(123);
    // The surface is READ-ONLY: no `set` is present.
    expect((lim as unknown as { set?: unknown }).set).toBeUndefined();
  });

  it("core.limits.get falls back to the registry default when boot wired no accessor (§13.11)", async () => {
    let lim: { get(key: string): number } | undefined;
    const loader = fakeLoader({
      resolved: { a: resolved("a") },
      registers: { a: (core: any) => void (lim = core.limits) },
    });
    // `make` does NOT wire getLimit → the accessor must return the registry default.
    const env = make({ a: { enabled: true } }, loader);
    await env.plugins.loadAll();
    expect(lim).toBeDefined();
    expect(lim!.get("plan.maxTouches")).toBe(50); // registry default
    expect(lim!.get("tools.webSearchTitleMax")).toBe(300);
  });

  it("passes the entry's options as the second argument of register (§12.4)", async () => {
    let received: unknown;
    const loader = fakeLoader({
      resolved: { a: resolved("a") },
      registers: { a: (_core: any, options: unknown) => void (received = options) },
    });
    const env = make({ a: { enabled: true, options: { config: { endpoint: "http://127.0.0.1:4318" } } } }, loader);
    await env.plugins.loadAll();
    expect(received).toEqual({ config: { endpoint: "http://127.0.0.1:4318" } });
  });

  it("passes {} when the entry has no options, and list reports hasOptions (value-free)", async () => {
    let received: unknown = "unset";
    const loader = fakeLoader({
      resolved: { a: resolved("a"), b: resolved("b") },
      registers: {
        a: (_core: any, options: unknown) => void (received = options),
        b: () => {},
      },
    });
    const env = make(
      { a: { enabled: true }, b: { enabled: true, options: { config: { endpoint: "http://127.0.0.1:4318" } } } },
      loader,
    );
    await env.plugins.loadAll();
    expect(received).toEqual({});
    const list = env.plugins.list();
    expect(list.find((p) => p.id === "a")).toMatchObject({ hasOptions: false });
    expect(list.find((p) => p.id === "b")).toMatchObject({ hasOptions: true });
  });

  it("skips a disabled entry and dedupes two entries to the same real path", async () => {
    let registerCount = 0;
    const loader = fakeLoader({
      resolved: { a: resolved("a", "/same"), b: resolved("b", "/same") },
      registers: { a: () => void registerCount++, b: () => void registerCount++ },
    });
    const env = make({ a: { enabled: true }, b: { enabled: true } }, loader);
    await env.plugins.loadAll();
    expect(registerCount).toBe(1); // one real path = one plugin
  });

  it("rejects a plugin with a non-permissive license, never calling register", async () => {
    let registered = false;
    const errors: unknown[] = [];
    const loader = fakeLoader({
      resolved: { gpl: resolved("gpl") },
      licenses: { gpl: { ok: false, offender: { pkg: "dep", license: "GPL-3.0" } } },
      registers: { gpl: () => void (registered = true) },
    });
    const env = make({ gpl: { enabled: true } }, loader);
    env.bus.subscribe("ERROR_OCCURRED", (e) => errors.push(e.payload));
    await env.plugins.loadAll();
    expect(registered).toBe(false);
    expect(JSON.stringify(errors)).toContain("GPL-3.0");
  });

  it("rejects a plugin whose id collides with the reserved core namespace, never calling register", async () => {
    let registered = false;
    const errors: unknown[] = [];
    const loader = fakeLoader({
      resolved: { core: resolved("core") },
      registers: {
        core: (core: any) => {
          registered = true;
          // A malicious register would overwrite the core's structural entries.
          core.registry.set("panel:main", "hijacked");
        },
      },
    });
    const env = make({ core: { enabled: true } }, loader);
    // Seed a core-namespace entry to prove the plugin cannot touch it.
    env.registryStore.set("core", "panel:main", "builtin");
    env.bus.subscribe("ERROR_OCCURRED", (e) => errors.push(e.payload));
    await env.plugins.loadAll();
    expect(registered).toBe(false);
    expect(env.registryStore.get("core", "panel:main")).toBe("builtin");
    expect(JSON.stringify(errors)).toContain("reserved core namespace");
    expect(JSON.stringify(errors)).toContain("core");
  });

  it("contains a throwing register and logs ERROR_OCCURRED without crashing", async () => {
    const errors: unknown[] = [];
    const loader = fakeLoader({
      resolved: { bad: resolved("bad") },
      registers: {
        bad: () => {
          throw new Error("boom");
        },
      },
    });
    const env = make({ bad: { enabled: true } }, loader);
    env.bus.subscribe("ERROR_OCCURRED", (e) => errors.push(e.payload));
    await expect(env.plugins.loadAll()).resolves.toBeUndefined();
    expect(JSON.stringify(errors)).toContain("boom");
  });

  it("list reports a node_modules candidate as an inactive, unlisted plugin", async () => {
    const loader = fakeLoader({
      resolved: {},
      candidates: [{ manifest: { name: "cand", voidrift: { plugin: true } }, realPath: "/real/cand" }],
    });
    const env = make({}, loader);
    const list = env.plugins.list();
    expect(list.find((p) => p.id === "cand")).toMatchObject({ active: false });
  });

  it("enable writes the entry and loads; disable tears down and removes the namespace", async () => {
    const loader = fakeLoader({
      resolved: { a: resolved("a") },
      registers: { a: (core: any) => core.registry.set("k", "v") },
    });
    const env = make({}, loader);
    const en = await env.plugins.enable("a");
    expect(en.ok).toBe(true);
    expect(env.getCurrent()["a"]).toMatchObject({ enabled: true });
    expect(env.registryStore.get("a", "k")).toBe("v");

    const dis = await env.plugins.disable("a");
    expect(dis.ok).toBe(true);
    expect(env.getCurrent()["a"]).toMatchObject({ enabled: false });
    expect(env.registryStore.get("a", "k")).toBeNull();
  });

  it("disable rejects an unlisted plugin; scope returns the id", async () => {
    const env = make({}, fakeLoader({ resolved: {} }));
    expect((await env.plugins.disable("nope")).ok).toBe(false);
    expect(env.plugins.scope("x")).toMatchObject({ ok: true, value: { id: "x" } });
  });

  it("a plugin's event subscriber runs and a throwing subscriber is contained", async () => {
    const seen: unknown[] = [];
    const loader = fakeLoader({
      resolved: { a: resolved("a") },
      registers: {
        a: (core: any) => {
          core.events.subscribe("PING", (e: any) => seen.push(e.payload));
          core.events.subscribe("PING", () => {
            throw new Error("sub boom");
          });
        },
      },
    });
    const env = make({ a: { enabled: true } }, loader);
    env.bus.register("PING");
    await env.plugins.loadAll();
    expect(() => env.bus.emit("PING", { x: 1 }, {})).not.toThrow();
    expect(seen).toEqual([{ x: 1 }]);
  });

  it("list reports a loaded, enabled plugin with its real meta", async () => {
    const loader = fakeLoader({ resolved: { a: resolved("a") }, registers: { a: () => {} } });
    const env = make({ a: { enabled: true } }, loader);
    await env.plugins.loadAll();
    const meta = env.plugins.list().find((p) => p.id === "a");
    expect(meta).toMatchObject({ id: "a", active: true, license: "MIT" });
  });

  it("list reports a listed-but-unloaded entry as inactive", () => {
    const env = make({ ghost: { enabled: false } }, fakeLoader({ resolved: {} }));
    expect(env.plugins.list().find((p) => p.id === "ghost")).toMatchObject({ active: false });
  });

  it("enable fails when the plugin cannot be resolved or the license is rejected", async () => {
    const env = make({}, fakeLoader({ resolved: {} }));
    expect((await env.plugins.enable("missing")).ok).toBe(false);
  });

  it("enable fails when the config write is rejected", async () => {
    const bus = new EventBus();
    const registryStore = new RegistryStore();
    const plugins = new Plugins({
      bus,
      loader: fakeLoader({ resolved: { a: resolved("a") } }),
      services: makeServices({}),
      registryStore,
      getPlugins: () => ({}),
      setPlugins: async () => ({ ok: false as const, error: { code: "CONFIG_INVALID", message: "bad" } }),
    });
    expect((await plugins.enable("a")).ok).toBe(false);
  });

  it("enable passes an explicit path through to the config entry", async () => {
    let written: Record<string, PluginEntry> = {};
    const bus = new EventBus();
    const plugins = new Plugins({
      bus,
      loader: fakeLoader({ resolved: { a: resolved("a") }, registers: { a: () => {} } }),
      services: makeServices({}),
      registryStore: new RegistryStore(),
      getPlugins: () => written,
      setPlugins: async (next) => {
        written = next;
        return { ok: true as const, value: next };
      },
    });
    await plugins.enable("a", "project", "./local/a");
    expect(written["a"]).toMatchObject({ enabled: true, path: "./local/a" });
  });

  it("a throwing command handler is contained by the scoped wrapper", async () => {
    const sink: Record<string, unknown> = {};
    const bus = new EventBus();
    const errors: unknown[] = [];
    const plugins = new Plugins({
      bus,
      loader: fakeLoader({
        resolved: { a: resolved("a") },
        registers: {
          a: (core: any) =>
            core.register.command("boom-cmd", () => {
              throw new Error("handler boom");
            }),
        },
      }),
      services: makeServices(sink),
      registryStore: new RegistryStore(),
      getPlugins: () => ({ a: { enabled: true } }),
      setPlugins: async (n) => ({ ok: true as const, value: n }),
    });
    bus.subscribe("ERROR_OCCURRED", (e) => errors.push(e.payload));
    await plugins.loadAll();
    const handler = (sink["commands"] as Map<string, (a: unknown) => unknown>).get("boom-cmd")!;
    expect(() => handler(undefined)).not.toThrow();
    expect(JSON.stringify(errors)).toContain("handler boom");
  });

  it("the scoped events.emit drops an unregistered event name", async () => {
    let emitted = false;
    const plugins = new Plugins({
      bus: new EventBus(),
      loader: fakeLoader({
        resolved: { a: resolved("a") },
        registers: {
          a: (core: any) => {
            core.events.emit("UNREGISTERED", { x: 1 });
            core.events.register("REG");
            core.events.subscribe("REG", () => void (emitted = true));
            core.events.emit("REG", { x: 2 });
          },
        },
      }),
      services: makeServices({}),
      registryStore: new RegistryStore(),
      getPlugins: () => ({ a: { enabled: true } }),
      setPlugins: async (n) => ({ ok: true as const, value: n }),
    });
    await plugins.loadAll();
    expect(emitted).toBe(true);
  });

  it("enable fails when the config write succeeds but the plugin fails to resolve", async () => {
    let written: Record<string, PluginEntry> = {};
    const plugins = new Plugins({
      bus: new EventBus(),
      loader: fakeLoader({ resolved: {} }), // resolve returns null
      services: makeServices({}),
      registryStore: new RegistryStore(),
      getPlugins: () => written,
      setPlugins: async (n) => {
        written = n;
        return { ok: true as const, value: n };
      },
    });
    const res = await plugins.enable("a");
    expect(res.ok).toBe(false);
    expect(written["a"]).toMatchObject({ enabled: true });
  });

  it("disable fails when the config write is rejected", async () => {
    const plugins = new Plugins({
      bus: new EventBus(),
      loader: fakeLoader({ resolved: {} }),
      services: makeServices({}),
      registryStore: new RegistryStore(),
      getPlugins: () => ({ a: { enabled: true } }),
      setPlugins: async () => ({ ok: false as const, error: { code: "X", message: "no" } }),
    });
    expect((await plugins.disable("a")).ok).toBe(false);
  });

  it("a loader that throws on resolve is contained and logged", async () => {
    const errors: unknown[] = [];
    const bus = new EventBus();
    const throwingLoader = {
      resolve: () => {
        throw new Error("resolve boom");
      },
      licenseScan: () => ({ ok: true }),
      importRegister: async () => () => {},
      scanCandidates: () => [],
    } as unknown as import("../adapters/plugin-loader.js").PluginLoader;
    const plugins = new Plugins({
      bus,
      loader: throwingLoader,
      services: makeServices({}),
      registryStore: new RegistryStore(),
      getPlugins: () => ({ a: { enabled: true } }),
      setPlugins: async (n) => ({ ok: true as const, value: n }),
    });
    bus.subscribe("ERROR_OCCURRED", (e) => errors.push(e.payload));
    await plugins.loadAll();
    expect(JSON.stringify(errors)).toContain("resolve boom");
  });

  it("enable preserves an existing path entry when none is passed", async () => {
    let written: Record<string, PluginEntry> = { a: { enabled: false, path: "./kept" } };
    const plugins = new Plugins({
      bus: new EventBus(),
      loader: fakeLoader({ resolved: { a: resolved("a") }, registers: { a: () => {} } }),
      services: makeServices({}),
      registryStore: new RegistryStore(),
      getPlugins: () => written,
      setPlugins: async (n) => {
        written = n;
        return { ok: true as const, value: n };
      },
    });
    await plugins.enable("a");
    expect(written["a"]).toMatchObject({ enabled: true, path: "./kept" });
  });

  it("exercises every register seam and tears them all down on disable", async () => {
    const calls: string[] = [];
    const services: CoreServices = {
      registerCommand: (_p, n) => calls.push(`+cmd:${n}`),
      unregisterCommand: (n) => calls.push(`-cmd:${n}`),
      registerTool: (_p, def) => calls.push(`+tool:${(def as { name: string }).name}`),
      unregisterTool: (n) => calls.push(`-tool:${n}`),
      registerPrompt: (_p, k) => calls.push(`+prompt:${k}`),
      overridePrompt: (_p, k) => calls.push(`+override:${k}`),
      extendPrompt: (_p, k) => calls.push(`+extend:${k}`),
      removePrompt: (k) => calls.push(`-prompt:${k}`),
      registerContextProvider: (_p, layer) => {
        calls.push(`+ctx:${layer}`);
        return "ctx:0";
      },
      unregisterContextProvider: (id) => calls.push(`-ctx:${id}`),
      registerModelProvider: (_p, proto) => calls.push(`+model:${proto}`),
      unregisterModelProvider: (proto) => calls.push(`-model:${proto}`),
      registerExporter: () => {
        calls.push("+exp");
        return "exp:0";
      },
      unregisterExporter: (id) => calls.push(`-exp:${id}`),
      registerPanel: (_p, name) => {
        calls.push(`+panel:${name}`);
        return `panels.${name}`;
      },
      unregisterPanel: (key) => calls.push(`-panel:${key}`),
      registerDataset: (_p, name) => {
        calls.push(`+dataset:${name}`);
        return `datasets.${name}`;
      },
      unregisterDataset: (key) => calls.push(`-dataset:${key}`),
      registerAgent: () => calls.push("+agent"),
      registerGuardrail: () => calls.push("+guardrail"),
      registerScope: (pluginId, id, scope) => {
        calls.push(`+scope:${pluginId}:${id}:${scope.writeGlobs.join(",")}`);
        return `${pluginId}:${id}`;
      },
      unregisterScope: (pluginId, id) => calls.push(`-scope:${pluginId}:${id}`),
      unregisterScopeKey: (key) => calls.push(`-scopeKey:${key}`),
      registerExpectation: (scope) => calls.push(`+expect:${scope}`),
      clearExpectation: (scope) => calls.push(`-expect:${scope}`),
      closeExpectation: (scope) => calls.push(`closeExpect:${scope}`),
      registerChunker: (pluginId, def) => {
        const id = (def as { id?: string }).id ?? "?";
        calls.push(`+chunker:${pluginId}:${id}`);
        return `${pluginId}:chunker:${id}`;
      },
      unregisterChunker: (key) => calls.push(`-chunker:${key}`),
      runInNewSession: async () => ({ status: "completed" }),
      workspace: { files: async () => [], readText: async () => null, currentInput: () => "", focusPaths: () => [], cacheDir: () => "/tmp/cache", hashFor: () => null },
    };
    const scopedProbe: { hasTopLevelSetMode?: boolean; hasSessionSetMode?: boolean; sessionKeys?: string[] } = {};
    const bus = new EventBus();
    const registryStore = new RegistryStore();
    let current: Record<string, PluginEntry> = { a: { enabled: true } };
    const plugins = new Plugins({
      bus,
      loader: fakeLoader({
        resolved: { a: resolved("a") },
        registers: {
          a: (core: any) => {
            core.register.command("c", async () => "x");
            core.register.tool({ name: "t" }, async () => ({ content: "", status: "success" }));
            core.register.prompt("p", "P");
            core.register.overridePrompt("po", "PO");
            core.register.extendPrompt("pe", "PE");
            core.register.contextProvider("void", () => "block");
            core.register.modelProvider("proto", () => ({}));
            core.register.exporter({ name: "e" });
            core.register.panel("demo", { title: "Demo", columns: [{ key: "n", label: "N" }], source: "session.list" });
            core.register.agent({ id: "ag" });
            core.register.guardrail({ id: "g" });
            core.register.planScope("step-1", { writeGlobs: ["src/**"], executePatterns: [] });
            core.register.chunker({ id: "ch", matches: () => true, chunk: () => [] });
            core.registry.set("k", 1);
            // A plugin cannot registry.set a reserved panels.* key directly (§12.5).
            core.registry.set("panels.sneaky", { title: "X", columns: [{ key: "n", label: "N" }], source: "session.list" });
            // §2.7/§12.4 — the host-only `session.setMode` is ABSENT from the
            // scoped CoreApi a plugin receives: the plugin can start a clean
            // session (runInNewSession) but can NEVER select or change a
            // conversation mode (so it can never enter `vibe` or loosen the
            // host's mode). Neither `core.setMode` nor `core.session.setMode`
            // exists on the scoped surface.
            scopedProbe.hasTopLevelSetMode = typeof core.setMode !== "undefined";
            scopedProbe.hasSessionSetMode = typeof core.session?.setMode !== "undefined";
            scopedProbe.sessionKeys = Object.keys(core.session ?? {});
          },
        },
      }),
      services,
      registryStore,
      getPlugins: () => current,
      setPlugins: async (n) => {
        current = n;
        return { ok: true as const, value: n };
      },
    });
    await plugins.loadAll();
    // §2.7/§12.4 — setMode is unreachable from a plugin.
    expect(scopedProbe.hasTopLevelSetMode).toBe(false);
    expect(scopedProbe.hasSessionSetMode).toBe(false);
    expect(scopedProbe.sessionKeys).toEqual(["runInNewSession"]);
    expect(calls).toContain("+agent");
    expect(calls).toContain("+guardrail");
    expect(calls).toContain("+model:proto");
    expect(calls).toContain("+panel:demo");
    expect(calls).toContain("+scope:a:step-1:src/**");
    expect(calls).toContain("+chunker:a:ch");
    expect(registryStore.get("a", "k")).toBe(1);
    // The reserved panels.* key the plugin tried to set directly was rejected (§12.5).
    expect(registryStore.get("a", "panels.sneaky")).toBeNull();

    await plugins.disable("a");
    expect(calls).toContain("-cmd:c");
    expect(calls).toContain("-tool:t");
    expect(calls).toContain("-ctx:ctx:0");
    expect(calls).toContain("-model:proto");
    expect(calls).toContain("-exp:exp:0");
    expect(calls).toContain("-panel:panels.demo");
    expect(calls).toContain("-scopeKey:a:step-1");
    expect(calls).toContain("-chunker:a:chunker:ch");
    expect(registryStore.get("a", "k")).toBeNull();
  });

  describe("project-layer plugins load exactly like global ones (§12.4.1, no workspace-trust gate)", () => {
    it("loads a project-only plugin (no trust gate)", async () => {
      let registered = false;
      const loader = fakeLoader({ resolved: { x: resolved("x") }, registers: { x: () => void (registered = true) } });
      const env = make({ x: { enabled: true } }, loader, { layers: { project: { x: { enabled: true } } } });
      await env.plugins.loadAll();
      expect(registered).toBe(true);
    });

    it("lists a project-layer plugin with source `project`", async () => {
      const loader = fakeLoader({ resolved: { x: resolved("x") }, registers: { x: () => {} } });
      const env = make({ x: { enabled: true } }, loader, { layers: { project: { x: { enabled: true } } } });
      await env.plugins.loadAll();
      expect(env.plugins.list().find((p) => p.id === "x")).toMatchObject({ active: true, source: "project" });
    });

    it("records a project-layer load at info level with its id and layer (PLUGIN_LOADED)", async () => {
      const loaded: unknown[] = [];
      const loader = fakeLoader({ resolved: { x: resolved("x") }, registers: { x: () => {} } });
      const env = make({ x: { enabled: true } }, loader, { layers: { project: { x: { enabled: true } } } });
      env.bus.subscribe("PLUGIN_LOADED", (e) => loaded.push(e.payload));
      await env.plugins.loadAll();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toMatchObject({ id: "x", layer: "project", level: "info" });
    });

    it("lists a global-layer plugin with source `global` and does NOT emit PLUGIN_LOADED", async () => {
      const loaded: unknown[] = [];
      const loader = fakeLoader({ resolved: { g: resolved("g") }, registers: { g: () => {} } });
      const env = make({ g: { enabled: true } }, loader, { layers: { global: { g: { enabled: true } } } });
      env.bus.subscribe("PLUGIN_LOADED", (e) => loaded.push(e.payload));
      await env.plugins.loadAll();
      expect(env.plugins.list().find((p) => p.id === "g")).toMatchObject({ active: true, source: "global" });
      expect(loaded).toHaveLength(0);
    });
  });
});
