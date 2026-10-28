import { describe, it, expect, beforeEach } from "vitest";
import { Plugins, type PluginsDeps } from "./plugins.js";
import { PluginEntrySchema } from "../config/schema.js";
import type { ResolvedLimits } from "../entities/limits-resolve.js";
import { resolveLimits } from "../entities/limits-resolve.js";
import { limitDefault } from "../entities/limits.js";
import type { EventBus } from "../entities/event-bus.js";
import type { PluginLoader } from "../adapters/plugin-loader.js";
import type { RegistryStore } from "../entities/registry/registry-store.js";
import { ok } from "../entities/errors.js";

// Mock helpers
const mockEventBus = (): EventBus => ({
  register: () => {},
  subscribe: () => () => {},
  emit: () => {},
  isRegistered: () => false,
  subs: new Map(),
  registered: new Map(),
} as any);

const mockLoader = (): PluginLoader => ({
  resolve: () => null,
  licenseScan: () => ({ ok: true }),
  scanCandidates: () => [],
  readManifest: () => null,
  readInstalledManifest: () => null,
  readInstalledIntegrity: () => null,
  importRegister: async () => async () => {},
} as unknown as PluginLoader);

const mockRegistry = (): RegistryStore => ({
  set: () => {},
  get: () => undefined,
  query: () => [],
  remove: () => {},
  removeNamespace: () => {},
} as unknown as RegistryStore);

describe("Plugin options size limit with layered action (§12.4, §13.11)", () => {
  let deps: PluginsDeps;
  let resolvedLimits: ResolvedLimits;

  beforeEach(() => {
    // Set up default resolved limits with warn action (the default from the registry)
    resolvedLimits = resolveLimits([
      {
        layer: "global",
        limits: {
          "plugins.optionsMaxBytes": {
            value: 64 * 1024,
            action: "warn" as const,
          },
        },
      },
    ]);

    deps = {
      bus: mockEventBus(),
      loader: mockLoader(),
      services: {
        registerCommand: () => {},
        unregisterCommand: () => {},
        registerTool: () => {},
        unregisterTool: () => {},
        registerPrompt: () => {},
        overridePrompt: () => {},
        extendPrompt: () => {},
        removePrompt: () => {},
        registerContextProvider: () => "",
        unregisterContextProvider: () => {},
        registerModelProvider: () => {},
        unregisterModelProvider: () => {},
        registerExporter: () => "",
        unregisterExporter: () => {},
        registerPanel: () => "",
        unregisterPanel: () => {},
        registerDataset: () => "",
        unregisterDataset: () => {},
        registerAgent: () => {},
        registerGuardrail: () => {},
        registerScope: () => "",
        unregisterScope: () => {},
        unregisterScopeKey: () => {},
        registerExpectation: () => {},
        clearExpectation: () => {},
        closeExpectation: () => {},
        registerChunker: () => "",
        unregisterChunker: () => {},
        registerPluginDocs: async () => {},
        unregisterPluginDocs: () => {},
        registerPluginAgents: async () => {},
        unregisterPluginAgents: () => {},
        runInNewSession: async () => ({}),
        workspace: {
          files: async () => [],
          readText: async () => null,
          currentInput: () => "",
          focusPaths: () => [],
          cacheDir: () => "",
          hashFor: () => null,
        },
      } as any,
      registryStore: mockRegistry(),
      getPlugins: () => ({}),
      setPlugins: async () => ok({}),
      getLimit: (key: string) => {
        const entry = resolvedLimits.values.get(key);
        if (entry) return entry.value;
        return limitDefault(key);
      },
      getLimitAction: (key: string) => {
        const entry = resolvedLimits.values.get(key);
        return entry?.action ?? "warn";
      },
    };
  });

  it("(a) accepts 100 KiB options with default warn action, loads plugin, emits LIMIT_HIT", async () => {
    const big = "x".repeat(100 * 1024);
    const testEmitted: any[] = [];

    const bus = {
      ...mockEventBus(),
      emit: (type: string, payload: any) => {
        if (type === "LIMIT_HIT") testEmitted.push(payload);
      },
    } as any;

    deps.bus = bus;

    const mockResolved = {
      entryKey: "test-plugin",
      realPath: "/path/to/plugin",
      manifest: { name: "test-plugin", version: "1.0.0", voidrift: { plugin: true } },
      meta: { id: "test-plugin", name: "test-plugin", version: "1.0.0", description: "" },
    };

    let registerCalled = false;
    let optionsReceived: any = null;

    (deps.loader as any).resolve = () => mockResolved;
    (deps.loader as any).licenseScan = () => ({ ok: true });
    (deps.loader as any).importRegister = async () => async (_core: any, options: any) => {
      registerCalled = true;
      optionsReceived = options;
    };

    deps.getPlugins = () => ({ "test-plugin": { enabled: true, options: { data: big } } });

    const plugins = new Plugins(deps);
    await plugins.loadAll();

    expect(registerCalled).toBe(true);
    expect(optionsReceived).toEqual({ data: big });
    expect(testEmitted.length).toBe(1);
    expect(testEmitted[0]).toMatchObject({
      key: "plugins.optionsMaxBytes",
      action: "warn",
    });
  });

  it("(c) malformed options (not serializable) are rejected at schema time", async () => {
    // This test verifies that the schema still rejects non-objects at config
    // validation time. Non-serializable options cannot reach the plugin load path.
    // The schema should be enforced by the config validation layer before
    // loadAll is called.
    const result = PluginEntrySchema.safeParse({
      enabled: true,
      options: "not-an-object" as any,
    });
    expect(result.success).toBe(false);
    // The schema validates that options is a record (object), so a string is rejected
    expect((result as any).error.issues[0]?.message).toMatch(/(record|object|expected)/i);
  });

  it("(d) accepts 20 KiB options without emitting LIMIT_HIT", async () => {
    const small = "x".repeat(20 * 1024);
    const testEmitted: any[] = [];

    const bus = {
      ...mockEventBus(),
      emit: (type: string, payload: any) => {
        if (type === "LIMIT_HIT") testEmitted.push(payload);
      },
    } as any;

    deps.bus = bus;

    const mockResolved = {
      entryKey: "test-plugin",
      realPath: "/path/to/plugin",
      manifest: { name: "test-plugin", version: "1.0.0", voidrift: { plugin: true } },
      meta: { id: "test-plugin", name: "test-plugin", version: "1.0.0", description: "" },
    };

    let registerCalled = false;
    let optionsReceived: any = null;

    (deps.loader as any).resolve = () => mockResolved;
    (deps.loader as any).licenseScan = () => ({ ok: true });
    (deps.loader as any).importRegister = async () => async (_core: any, options: any) => {
      registerCalled = true;
      optionsReceived = options;
    };

    deps.getPlugins = () => ({ "test-plugin": { enabled: true, options: { data: small } } });

    const plugins = new Plugins(deps);
    await plugins.loadAll();

    expect(registerCalled).toBe(true);
    expect(optionsReceived).toEqual({ data: small });
    expect(testEmitted.length).toBe(0); // No LIMIT_HIT
  });
});
