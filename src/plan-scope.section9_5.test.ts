/**
 * §9.5 plan-scope seam — exposed on the scoped CoreAPI (core-blueprint.md §9.5,
 * §12.4). The seam maps onto `Guardian.registerScope`/`clearScope` under a
 * plugin-qualified identifier. These tests prove, against a REAL Guardian:
 *  - a registered scope auto-approves a matching non-read call;
 *  - it NEVER relaxes a force-ask (`git push --force` still force-asks);
 *  - clearing removes the auto-approval;
 *  - one plugin's scope is isolated from another's (qualified by plugin id), so
 *    plugin B cannot clear plugin A's scope.
 *
 * The scoped `register.planScope`/`clearPlanScope` wiring is the SAME boot wiring
 * `createCore` installs (services → Guardian), reconstructed here so the test is
 * a tight unit over the seam, deterministic and offline.
 */
import { describe, it, expect } from "vitest";
import { EventBus } from "./entities/event-bus.js";
import { RegistryStore } from "./entities/registry/registry-store.js";
import { Guardian, builtinGuardrails, type GuardedCall } from "./entities/guardian.js";
import { Plugins, type CoreServices, type ScopedCoreApi } from "./use-cases/plugins.js";
import type { PluginEntry } from "./config/schema.js";
import {
  DEFAULT_SHELL_SAFE,
  DEFAULT_SHELL_FORCE_ASK,
  DEFAULT_SHELL_EQUIVALENTS,
} from "./config/schema.js";
import type { ResolvedPlugin, PluginLoader } from "./adapters/plugin-loader.js";

const lists = {
  safe: DEFAULT_SHELL_SAFE,
  forceAsk: DEFAULT_SHELL_FORCE_ASK,
  equivalents: DEFAULT_SHELL_EQUIVALENTS,
  deny: [] as string[],
};

/** The boot wiring (boot.ts): services → Guardian, plugin-qualified identifier. */
function servicesFor(guardian: Guardian): CoreServices {
  const noop = (): void => {};
  return {
    registerCommand: noop,
    unregisterCommand: noop,
    registerTool: noop,
    unregisterTool: noop,
    registerPrompt: noop,
    overridePrompt: noop,
    extendPrompt: noop,
    removePrompt: noop,
    registerContextProvider: () => "ctx:0",
    unregisterContextProvider: noop,
    registerModelProvider: noop,
    unregisterModelProvider: noop,
    registerExporter: () => "exp:0",
    unregisterExporter: noop,
    registerPanel: () => "panels.x",
    unregisterPanel: noop,
    registerAgent: noop,
    registerGuardrail: noop,
    registerScope: (pluginId, id, scope) => {
      const key = `${pluginId}:${id}`;
      guardian.registerScope(key, scope);
      return key;
    },
    unregisterScope: (pluginId, id) => guardian.clearScope(`${pluginId}:${id}`),
    unregisterScopeKey: (key) => guardian.clearScope(key),
    registerExpectation: () => {},
    clearExpectation: () => {},
    closeExpectation: () => {},
    registerChunker: () => "chunker:0",
    unregisterChunker: () => {},
    runInNewSession: async () => ({ status: "completed" }),
    workspace: { files: async () => [], readText: async () => null, currentInput: () => "", focusPaths: () => [] },
  };
}

function resolved(id: string): ResolvedPlugin {
  return {
    entryKey: id,
    realPath: `/real/${id}`,
    manifest: { name: id, version: "1.0.0", license: "MIT", voidrift: { plugin: true } },
    meta: { id, name: id, version: "1.0.0", description: "", active: true, license: "MIT" },
  } as unknown as ResolvedPlugin;
}

function loaderFor(registers: Record<string, (core: ScopedCoreApi) => void>): PluginLoader {
  const ids = Object.keys(registers);
  const table: Record<string, ResolvedPlugin> = {};
  for (const id of ids) table[id] = resolved(id);
  return {
    resolve: (e: { id: string }) => table[e.id] ?? null,
    licenseScan: () => ({ ok: true }),
    importRegister: async (r: ResolvedPlugin) => registers[r.meta.id] ?? (() => {}),
    scanCandidates: () => [],
  } as unknown as PluginLoader;
}

function makePlugins(guardian: Guardian, registers: Record<string, (core: ScopedCoreApi) => void>) {
  const entries: Record<string, PluginEntry> = {};
  for (const id of Object.keys(registers)) entries[id] = { enabled: true };
  let current = { ...entries };
  return new Plugins({
    bus: new EventBus(),
    loader: loaderFor(registers),
    services: servicesFor(guardian),
    registryStore: new RegistryStore(),
    getPlugins: () => current,
    setPlugins: async (next) => {
      current = next;
      return { ok: true as const, value: next };
    },
  });
}

const write = (path: string): GuardedCall => ({ tool: "write_file", args: { path } });
const exec = (command: string): GuardedCall => ({ tool: "execute_command", args: { command } });

describe("§9.5 plan-scope seam on the scoped CoreAPI", () => {
  it("register.planScope auto-approves a matching non-read write; clearPlanScope removes it", async () => {
    // Given a real Guardian and a plugin that registers a plan-scope on load
    const guardian = new Guardian(builtinGuardrails());
    let api: ScopedCoreApi | undefined;
    const plugins = makePlugins(guardian, {
      a: (core) => {
        api = core;
        core.register.planScope("step-1", { writeGlobs: ["src/**"], executePatterns: [] });
      },
    });
    await plugins.loadAll();

    // When evaluating a matching write with NO permission rule → allow (auto-approved)
    expect(guardian.evaluate(write("src/app.ts"), [], lists).decision).toBe("allow");
    // A non-matching write still asks
    expect(guardian.evaluate(write("docs/readme.md"), [], lists).decision).toBe("ask");

    // When the plugin clears its scope
    api!.register.clearPlanScope("step-1");
    // Then the matching write asks again
    expect(guardian.evaluate(write("src/app.ts"), [], lists).decision).toBe("ask");
  });

  it("a plan-scope NEVER relaxes a force-ask", async () => {
    // Given a scope that (wrongly) tries to cover a dangerous command
    const guardian = new Guardian(builtinGuardrails());
    const plugins = makePlugins(guardian, {
      a: (core) => core.register.planScope("step-1", { writeGlobs: [], executePatterns: ["git push *"] }),
    });
    await plugins.loadAll();
    // When a force-ask command is evaluated → it still force-asks, scope ignored
    const outcome = guardian.evaluate(exec("git push --force"), [], lists);
    expect(outcome.decision).toBe("ask");
    expect(outcome.forceAsk).toBe(true);
  });

  it("one plugin's scope is isolated: plugin B cannot clear plugin A's scope", async () => {
    // Given two plugins each registering a scope under the SAME local id "step-1"
    const guardian = new Guardian(builtinGuardrails());
    let apiB: ScopedCoreApi | undefined;
    const plugins = makePlugins(guardian, {
      a: (core) => core.register.planScope("step-1", { writeGlobs: ["a/**"], executePatterns: [] }),
      b: (core) => {
        apiB = core;
        core.register.planScope("step-1", { writeGlobs: ["b/**"], executePatterns: [] });
      },
    });
    await plugins.loadAll();
    // Both scopes are live and independent
    expect(guardian.evaluate(write("a/x.ts"), [], lists).decision).toBe("allow");
    expect(guardian.evaluate(write("b/x.ts"), [], lists).decision).toBe("allow");

    // When plugin B clears "step-1" (its own)
    apiB!.register.clearPlanScope("step-1");
    // Then only B's scope is gone; A's survives (qualified by plugin id)
    expect(guardian.evaluate(write("b/x.ts"), [], lists).decision).toBe("ask");
    expect(guardian.evaluate(write("a/x.ts"), [], lists).decision).toBe("allow");
  });

  it("disable tears down a plugin's live scope", async () => {
    const guardian = new Guardian(builtinGuardrails());
    const plugins = makePlugins(guardian, {
      a: (core) => core.register.planScope("step-1", { writeGlobs: ["a/**"], executePatterns: [] }),
    });
    await plugins.loadAll();
    expect(guardian.evaluate(write("a/x.ts"), [], lists).decision).toBe("allow");
    await plugins.disable("a");
    expect(guardian.evaluate(write("a/x.ts"), [], lists).decision).toBe("ask");
  });
});
