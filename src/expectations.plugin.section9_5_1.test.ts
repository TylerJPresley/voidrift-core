/**
 * §9.5.1 expectation seam on the scoped CoreAPI (core-blueprint.md §9.5.1,
 * §12.4, invariant 27). These tests drive the REAL path a plugin takes:
 *  - `core.expectations.register({ scope, predicted })` registers a prediction;
 *  - `core.register.planScope(id, …)` opens the auto-approval grant;
 *  - `core.register.clearPlanScope(id)` CLOSES the scope → the core reads the
 *    scope's journal write targets, compares, and emits ONE masked surprise;
 *  - an honest or empty prediction, a `**` prediction, and a `clear` before
 *    close emit nothing;
 *  - the plugin surface exposes NO journal read (invariant 27) — the comparison
 *    influences no decision: a write matching `predicted` but NOT the scope's
 *    `writeGlobs` still ASKS at Guardian.
 *
 * The CoreServices wiring mirrors boot.ts: `registerExpectation`/`clearExpectation`
 * map to a REAL `Expectations` use-case, and `closeExpectation` drives its
 * `closeScope`. The journal is an in-memory `readScopeTargets` (what the core's
 * `makeScopeTargetsReader` adapter produces from the mutation journal).
 */
import { describe, it, expect } from "vitest";
import { EventBus, type EventEnvelope } from "./entities/event-bus.js";
import { RegistryStore } from "./entities/registry/registry-store.js";
import { Guardian, builtinGuardrails, type GuardedCall } from "./entities/guardian.js";
import { Plugins, type CoreServices, type ScopedCoreApi } from "./use-cases/plugins.js";
import { Expectations } from "./use-cases/expectations.js";
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

/** CoreServices wired like boot.ts: Guardian for scopes, a REAL Expectations for
 * the prediction seam fed by an in-memory scope→targets journal reader. */
function servicesFor(guardian: Guardian, expectations: Expectations): CoreServices {
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
    registerExpectation: (scope, predicted) => expectations.register({ scope, predicted }),
    clearExpectation: (scope) => expectations.clear(scope),
    closeExpectation: (scope) => void expectations.closeScope(scope).catch(() => undefined),
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
  const table: Record<string, ResolvedPlugin> = {};
  for (const id of Object.keys(registers)) table[id] = resolved(id);
  return {
    resolve: (e: { id: string }) => table[e.id] ?? null,
    licenseScan: () => ({ ok: true }),
    importRegister: async (r: ResolvedPlugin) => registers[r.meta.id] ?? (() => {}),
    scanCandidates: () => [],
  } as unknown as PluginLoader;
}

function makeRig(
  targetsByScope: Record<string, string[]>,
  registers: Record<string, (core: ScopedCoreApi) => void>,
) {
  const bus = new EventBus();
  const warnings: EventEnvelope[] = [];
  bus.subscribe("WARNING_EMITTED", (e) => warnings.push(e));
  const guardian = new Guardian(builtinGuardrails());
  let journalReads = 0;
  const expectations = new Expectations({
    bus,
    readScopeTargets: async (scopeId) => {
      journalReads++;
      return targetsByScope[scopeId] ?? [];
    },
    sessionId: () => "s1",
  });
  const entries: Record<string, PluginEntry> = {};
  for (const id of Object.keys(registers)) entries[id] = { enabled: true };
  let current = { ...entries };
  const plugins = new Plugins({
    bus,
    loader: loaderFor(registers),
    services: servicesFor(guardian, expectations),
    registryStore: new RegistryStore(),
    getPlugins: () => current,
    setPlugins: async (next) => {
      current = next;
      return { ok: true as const, value: next };
    },
  });
  return { plugins, guardian, warnings, journalReads: () => journalReads };
}

const write = (path: string): GuardedCall => ({ tool: "write_file", args: { path } });
const surprises = (warnings: EventEnvelope[]) =>
  warnings.filter((w) => (w.payload as { category?: string }).category === "surprise");

describe("§9.5.1 expectation seam on the scoped CoreAPI", () => {
  it("a scope that writes an unpredicted target emits exactly one masked surprise at clearPlanScope close", async () => {
    let api: ScopedCoreApi | undefined;
    const rig = makeRig(
      { "step-1": ["src/app.ts", "TOKEN=ghp_ab" + "cdefghijklmnopqrstuvwxyz0123456789"] },
      {
        plan: (core) => {
          api = core;
          core.expectations.register({ scope: "step-1", predicted: ["src/**"] });
          core.register.planScope("step-1", { writeGlobs: ["src/**"], executePatterns: [] });
        },
      },
    );
    await rig.plugins.loadAll();
    // When the plan closes the scope (step advanced): the grant is cleared AND
    // the expectation is compared.
    api!.register.clearPlanScope("step-1");
    await Promise.resolve();

    const s = surprises(rig.warnings);
    expect(s).toHaveLength(1);
    const payload = s[0]!.payload as { pattern: string; count: number };
    expect(payload.count).toBe(1);
    expect(payload.pattern).not.toContain("ghp_ab" + "cdefghijklmnopqrstuvwxyz0123456789");
    expect(payload.pattern).toContain("«redacted");
    expect(rig.journalReads()).toBe(1);
  });

  it("an honest prediction emits none; an empty prediction emits none and reads no journal", async () => {
    let apiHonest: ScopedCoreApi | undefined;
    const honest = makeRig(
      { "step-1": ["src/app.ts", "src/lib.ts"] },
      { plan: (core) => { apiHonest = core; core.expectations.register({ scope: "step-1", predicted: ["src/**"] }); core.register.planScope("step-1", { writeGlobs: ["src/**"], executePatterns: [] }); } },
    );
    await honest.plugins.loadAll();
    apiHonest!.register.clearPlanScope("step-1");
    await Promise.resolve();
    expect(surprises(honest.warnings)).toHaveLength(0);

    let apiEmpty: ScopedCoreApi | undefined;
    const empty = makeRig(
      { "step-1": ["out/x.ts"] },
      { plan: (core) => { apiEmpty = core; core.expectations.register({ scope: "step-1", predicted: [] }); core.register.planScope("step-1", { writeGlobs: [], executePatterns: [] }); } },
    );
    await empty.plugins.loadAll();
    apiEmpty!.register.clearPlanScope("step-1");
    await Promise.resolve();
    expect(surprises(empty.warnings)).toHaveLength(0);
    expect(empty.journalReads()).toBe(0); // empty registers nothing → no journal read
  });

  it("a `**` prediction emits no surprise (low-value by breadth, not a surprise)", async () => {
    let api: ScopedCoreApi | undefined;
    const rig = makeRig(
      { "step-1": ["src/a.ts", "pkg/b.ts", "docs/c.md"] },
      { plan: (core) => { api = core; core.expectations.register({ scope: "step-1", predicted: ["**"] }); core.register.planScope("step-1", { writeGlobs: ["**"], executePatterns: [] }); } },
    );
    await rig.plugins.loadAll();
    api!.register.clearPlanScope("step-1");
    await Promise.resolve();
    expect(surprises(rig.warnings)).toHaveLength(0);
  });

  it("clear(scope) before close emits nothing and reads no journal", async () => {
    let api: ScopedCoreApi | undefined;
    const rig = makeRig(
      { "step-1": ["out/x.ts"] },
      { plan: (core) => { api = core; core.expectations.register({ scope: "step-1", predicted: ["src/**"] }); core.register.planScope("step-1", { writeGlobs: ["src/**"], executePatterns: [] }); } },
    );
    await rig.plugins.loadAll();
    api!.expectations.clear("step-1");
    api!.register.clearPlanScope("step-1");
    await Promise.resolve();
    expect(surprises(rig.warnings)).toHaveLength(0);
    expect(rig.journalReads()).toBe(0);
  });

  it("INVARIANT 27: a write matching `predicted` but NOT the scope's writeGlobs still ASKS at Guardian (a prediction grants nothing)", async () => {
    const rig = makeRig(
      {},
      {
        plan: (core) => {
          // Predict a broad set, but grant a NARROW scope.
          core.expectations.register({ scope: "step-1", predicted: ["**"] });
          core.register.planScope("step-1", { writeGlobs: ["src/**"], executePatterns: [] });
        },
      },
    );
    await rig.plugins.loadAll();
    // A write inside the grant auto-approves.
    expect(rig.guardian.evaluate(write("src/app.ts"), [], lists).decision).toBe("allow");
    // A write the PREDICTION covers (`**`) but the GRANT does not still asks —
    // the prediction granted nothing (invariant 27).
    expect(rig.guardian.evaluate(write("docs/readme.md"), [], lists).decision).toBe("ask");
  });

  it("INVARIANT 27 (structural): the plugin ScopedCoreApi.expectations exposes no journal read", async () => {
    let api: ScopedCoreApi | undefined;
    const rig = makeRig({}, { plan: (core) => { api = core; } });
    await rig.plugins.loadAll();
    const keys = Object.keys(api!.expectations);
    expect(keys.sort()).toEqual(["clear", "register"]);
    // No journal/read surface leaked onto the scoped api.
    expect(api).not.toHaveProperty("journal");
  });
});
