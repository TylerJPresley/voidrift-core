/**
 * §8.7 — the `register.chunker` seam end to end at the use-case layer: a plugin
 * registering a chunker through the loader lands in a store the Ingest use-case
 * reads (`core.chunkers()`), `pickChunker` then chooses it for a matching path,
 * and its failures are contained / its output validated at use (`safeChunk`).
 */
import { describe, it, expect } from "vitest";
import { Plugins, type CoreServices } from "./plugins.js";
import type { ResolvedPlugin, PluginLoader } from "../adapters/plugin-loader.js";
import { RegistryStore } from "../entities/registry/registry-store.js";
import { EventBus } from "../entities/event-bus.js";
import type { PluginEntry } from "../config/schema.js";
import { pickChunker, safeChunk, genericChunker, type Chunker } from "../entities/chunker.js";

type RegisterFn = (core: unknown, options?: unknown) => void | Promise<void>;

function resolved(id: string): ResolvedPlugin {
  return {
    entryKey: id,
    realPath: `/real/${id}`,
    manifest: { name: id, version: "1.0.0", license: "MIT", voidrift: { plugin: true } },
    meta: { id, name: id, version: "1.0.0", description: "", active: true, license: "MIT" },
  } as unknown as ResolvedPlugin;
}

function fakeLoader(register: RegisterFn, id = "p"): PluginLoader {
  return {
    resolve: (e: { id: string }) => (e.id === id ? resolved(id) : null),
    licenseScan: () => ({ ok: true }),
    importRegister: async () => register,
    scanCandidates: () => [],
  } as unknown as PluginLoader;
}

/** A store that mirrors boot's chunkerStore wiring, exposed as `chunkers()`. */
function makeServicesWithStore(store: Map<string, Chunker>): CoreServices {
  let seq = 0;
  return {
    registerCommand: () => {},
    unregisterCommand: () => {},
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
    registerDataset: () => "datasets.x",
    unregisterDataset: () => {},
    registerAgent: () => {},
    registerGuardrail: () => {},
    registerScope: (p, i) => `${p}:${i}`,
    unregisterScope: () => {},
    unregisterScopeKey: () => {},
    registerExpectation: () => {},
    clearExpectation: () => {},
    closeExpectation: () => {},
    registerChunker: (pluginId, def) => {
      const key = `${pluginId}:chunker:${seq++}`;
      store.set(key, def as Chunker);
      return key;
    },
    unregisterChunker: (key) => void store.delete(key),
    registerPluginDocs: async () => {},
    unregisterPluginDocs: () => {},
    runInNewSession: async () => ({}),
    workspace: { files: async () => [], readText: async () => null, currentInput: () => "", focusPaths: () => [], cacheDir: () => "/tmp/cache", hashFor: () => null, pluginFiles: { list: async () => [], read: async () => null, write: async () => {}, remove: async () => {} } },
  };
}

function makePlugins(store: Map<string, Chunker>, register: RegisterFn) {
  const plugins = new Plugins({
    bus: new EventBus(),
    loader: fakeLoader(register),
    services: makeServicesWithStore(store),
    registryStore: new RegistryStore(),
    getPlugins: (): Record<string, PluginEntry> => ({ p: { enabled: true } }),
    setPlugins: async (n) => ({ ok: true as const, value: n }),
  });
  return plugins;
}

describe("register.chunker through the loader (§8.7)", () => {
  it("a registered chunker is chosen by pickChunker for a matching path", async () => {
    const store = new Map<string, Chunker>();
    const tsChunker: Chunker = {
      id: "ts-ast",
      matches: (p) => p.endsWith(".ts"),
      chunk: (t) => [{ startLine: 1, endLine: t.split("\n").length, text: t }],
    };
    await makePlugins(store, (core: any) => core.register.chunker(tsChunker)).loadAll();

    const live = [...store.values()]; // what `core.chunkers()` returns
    expect(live).toHaveLength(1);
    expect(pickChunker("mod.ts", "const x = 1", live).id).toBe("ts-ast");
    // a non-matching path still falls to a builtin
    expect(pickChunker("readme.md", "# h", live).id).toBe("markdown");
  });

  it("an invalid chunker output is rejected and falls back to the builtin (contained at use)", async () => {
    const store = new Map<string, Chunker>();
    const bad: Chunker = {
      id: "gappy",
      matches: () => true,
      chunk: () => [{ startLine: 2, endLine: 2, text: "x" }], // does not cover from line 1
    };
    await makePlugins(store, (core: any) => core.register.chunker(bad)).loadAll();

    const text = ["a", "b", "c"].join("\n");
    const picked = pickChunker("x.bin", "", [...store.values()]);
    expect(picked.id).toBe("gappy");
    const result = safeChunk(picked, text, 100);
    expect(result.fellBack).toBe(true);
    expect(result.chunker).toBe(genericChunker.id);
  });

  it("a throwing chunker is contained and falls back", async () => {
    const store = new Map<string, Chunker>();
    const boom: Chunker = {
      id: "boom",
      matches: () => true,
      chunk: () => {
        throw new Error("kaboom");
      },
    };
    await makePlugins(store, (core: any) => core.register.chunker(boom)).loadAll();

    const picked = pickChunker("x.bin", "", [...store.values()]);
    const result = safeChunk(picked, "a\nb", 100);
    expect(result.fellBack).toBe(true);
    expect(result.chunker).toBe(genericChunker.id);
    expect(result.reason).toContain("kaboom");
  });
});
