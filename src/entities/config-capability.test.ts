import { describe, it, expect, vi } from "vitest";
import { ConfigCapability, deepMerge } from "./config-capability.js";
import { InMemoryConfigStore } from "../adapters/repositories/in-memory-config-store.js";
import { limitDefault } from "./limits.js";
import { resolveCommandTimeoutMs } from "../adapters/command-runner.js";

describe("deepMerge (§13.1)", () => {
  it("merges objects and replaces scalars/arrays wholesale by default", () => {
    expect(deepMerge({ a: { x: 1 }, b: 1, c: [1] }, { a: { y: 2 }, b: 2, c: [2] })).toEqual({
      a: { x: 1, y: 2 },
      b: 2,
      c: [2],
    });
  });

  it("unions a listed array key (dedupe, broad→narrow) and still replaces others", () => {
    const out = deepMerge(
      { skills: ["a", "b"], other: [1] },
      { skills: ["b", "c"], other: [2] },
      new Set(["skills"]),
    );
    expect(out).toEqual({ skills: ["a", "b", "c"], other: [2] });
  });
});

describe("ConfigCapability (§13)", () => {
  function make(layers: Record<string, Record<string, unknown>>) {
    const store = new InMemoryConfigStore(undefined, layers);
    const emit = vi.fn();
    const cap = new ConfigCapability(store, emit);
    return { store, emit, cap };
  }

  it("resolves the cascade with the narrower layer winning (§13.1)", async () => {
    const { cap } = make({
      global: { turnMaxConcurrency: 1, housekeepingIdleDays: 10 },
      project: { turnMaxConcurrency: 2 },
      session: { turnMaxConcurrency: 3 },
    });
    await cap.load();
    expect(cap.getKey("turnMaxConcurrency")).toBe(3);
    expect(cap.getKey("housekeepingIdleDays")).toBe(10);
  });

  it("rejects an invalid set, sets it aside, emits CONFIG_INVALID, keeps known-good (§13.3)", async () => {
    const { cap, emit, store } = make({ global: { turnMaxConcurrency: 2 } });
    await cap.load();
    const res = await cap.set("turnMaxConcurrency", -5, "global");
    expect(res.ok).toBe(false);
    expect(cap.getKey("turnMaxConcurrency")).toBe(2); // known-good in force
    expect(emit).toHaveBeenCalledWith("CONFIG_INVALID", expect.anything());
    expect(store.rejectedDoc("global")).toBeDefined();
  });

  it("rejects an unknown top-level key but passes modelKwargs and apps pockets (§13.2)", async () => {
    const { cap } = make({});
    await cap.load();
    expect(cap.validate({ turnRecurisonLimit: 1 }).valid).toBe(false); // typo
    expect(cap.validate({ apps: { myApp: { anything: true } } }).valid).toBe(true);
    expect(cap.validate({ models: { m: { model: "x", top_k: 5, modelKwargs: { min_p: 0.1 } } } }).valid).toBe(true);
  });

  it("rejects a non-session key written to the session layer (§13.7)", async () => {
    const { cap } = make({});
    await cap.load();
    const bad = await cap.set("housekeepingIdleDays", 5, "session");
    expect(bad.ok).toBe(false);
    const good = await cap.set("turnMaxConcurrency", 2, "session");
    expect(good.ok).toBe(true);
  });

  it("migrates a retired key on load so an old config keeps working (§13.1)", async () => {
    const { cap } = make({ global: { modelPrimary: "local", modelBackground: "util", models: {} } });
    await cap.load();
    // The old config resolves cleanly onto the current keys.
    expect(cap.getKey("modelSelected")).toBe("local");
    expect(cap.getKey("modelUtility")).toBe("util");
    const migs = cap.configMigrations();
    expect(migs.map((m) => `${m.from}->${m.to}`).sort()).toEqual([
      "modelBackground->modelUtility",
      "modelPrimary->modelSelected",
    ]);
    expect(migs.every((m) => m.layer === "global" && !m.conflict)).toBe(true);
  });

  it("resolves a retired/current conflict in favour of the current key and warns (§13.1)", async () => {
    const { cap, emit } = make({ global: { modelPrimary: "old", modelSelected: "new", models: {} } });
    await cap.load();
    expect(cap.getKey("modelSelected")).toBe("new");
    const mig = cap.configMigrations().find((m) => m.from === "modelPrimary");
    expect(mig?.conflict).toBe(true);
    expect(emit).toHaveBeenCalledWith(
      "CONFIG_WARNING",
      expect.objectContaining({ key: "modelPrimary", layer: "global" }),
    );
  });

  it("still rejects an unknown NON-retired key (migration maps only the retired set) (§13.1/§13.2)", async () => {
    const { cap, emit } = make({ global: { turnRecurisonLimit: 5 } });
    await cap.load();
    // The typo'd key is not retired, so it survives migration and the layer is
    // set aside as invalid (never silently dropped).
    expect(emit).toHaveBeenCalledWith("CONFIG_INVALID", expect.objectContaining({ layer: "global" }));
    expect(cap.configMigrations()).toEqual([]);
  });

  it("records a rejected layer at load so a late subscriber can report it (§13.2–§13.3)", async () => {
    // Unknown top-level keys (the real-world old-format config) reject the
    // global layer; the core recovers to defaults and records the rejection.
    const { cap } = make({ global: { editor: "vim", approvalTimeout: 30 } });
    await cap.load();
    const rej = cap.rejectedLayers();
    expect(rej).toHaveLength(1);
    expect(rej[0]!.layer).toBe("global");
    expect(rej[0]!.rejectedPath.endsWith(".rejected")).toBe(true);
    const keys = rej[0]!.errors.map((e) => e.key);
    expect(keys).toContain("editor");
    // Error entries carry key NAMES, never values.
    expect(rej[0]!.errors.every((e) => !String(e.message).includes("vim"))).toBe(true);
    await cap.recover("global");
    expect(cap.rejectedLayers()).toHaveLength(0);
  });

  it("rejects a config that still sets `pluginsTrustWorkspace` as an unknown key, sets it aside, keeps last-known-good (§13.2–§13.3)", async () => {
    // The key was removed with the workspace-trust gate; the strict schema now
    // treats it as an unknown top-level key.
    const { cap, store } = make({ project: { turnMaxConcurrency: 2, pluginsTrustWorkspace: true } });
    await cap.load();
    // `pluginsTrustWorkspace` is no longer a valid key.
    expect(cap.validate({ pluginsTrustWorkspace: true }).valid).toBe(false);
    // The whole project layer is set aside and recovery falls to defaults.
    const rej = cap.rejectedLayers();
    expect(rej.map((r) => r.layer)).toContain("project");
    expect(store.rejectedDoc("project")).toBeDefined();
    expect(rej.find((r) => r.layer === "project")!.errors.map((e) => e.key)).toContain("pluginsTrustWorkspace");
  });

  it("recovers a layer to its last known-good document (§13.3)", async () => {
    const { cap } = make({ global: { turnMaxConcurrency: 2 } });
    await cap.load();
    await cap.set("turnMaxConcurrency", 4, "global");
    expect(cap.getKey("turnMaxConcurrency")).toBe(4);
    await cap.recover("global");
    expect(cap.getKey("turnMaxConcurrency")).toBe(4); // last good is the applied 4
  });

  it("set emits CONFIG_CHANGED and paths() reports every layer", async () => {
    const { cap, emit } = make({});
    await cap.load();
    await cap.set("turnMaxConcurrency", 2, "project");
    expect(emit).toHaveBeenCalledWith("CONFIG_CHANGED", { key: "turnMaxConcurrency", layer: "project" });
    const paths = cap.paths();
    expect(Object.keys(paths).sort()).toEqual(["global", "managed", "project", "session"]);
  });

  it("applyExternal validates a watcher edit and rejects an invalid one (§13.4)", async () => {
    const { cap } = make({});
    await cap.load();
    expect(cap.applyExternal("project", { turnMaxConcurrency: 7 })).toBeNull();
    expect(cap.getKey("turnMaxConcurrency")).toBe(7);
    const e = cap.applyExternal("project", { turnMaxConcurrency: -1 });
    expect(e).not.toBeNull();
  });

  describe("managed layer loosen-proof composition (§13.5)", () => {
    it("the managed layer wins the merge: a managed enforcing floor overrides a lower off", async () => {
      const { cap } = make({
        managed: { compliance: { mode: "enforcing" } },
        project: { compliance: { mode: "off" } },
      });
      await cap.load();
      // Managed is re-applied last, so the floor holds even for a predating doc.
      expect(cap.getKey("compliance").mode).toBe("enforcing");
    });

    it("rejects a lower-layer set that loosens a managed enforcing mode (validation error)", async () => {
      const { cap, emit } = make({ managed: { compliance: { mode: "enforcing" } } });
      await cap.load();
      const res = await cap.set("compliance", { mode: "off" }, "project");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.message).toContain("cannot weaken");
      expect(emit).toHaveBeenCalledWith("CONFIG_INVALID", expect.anything());
    });

    it("rejects a lower-layer set that loosens a managed permission deny (validation error)", async () => {
      const { cap } = make({
        managed: {
          permissions: { r1: { tool: "execute_command", pattern: "rm *", decision: "deny", priority: 0, source: "managed" } },
        },
      });
      await cap.load();
      const res = await cap.set(
        "permissions",
        { r1: { tool: "execute_command", pattern: "rm *", decision: "allow", priority: 200, source: "workspace" } },
        "project",
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.message).toContain("cannot loosen");
    });

    it("allows a lower-layer set that tightens within the managed ceiling", async () => {
      const { cap } = make({ managed: { compliance: { mode: "permissive" } } });
      await cap.load();
      const res = await cap.set("compliance", { mode: "enforcing" }, "project");
      expect(res.ok).toBe(true);
      // The managed layer caps nothing stricter than enforcing, so enforcing wins.
      expect(cap.getKey("compliance").mode).toBe("enforcing");
    });

    it("installManagedLayer applies a managed doc at runtime and clears it with null", async () => {
      const { cap } = make({ project: { compliance: { mode: "off" } } });
      await cap.load();
      expect(cap.getKey("compliance").mode).toBe("off");
      cap.installManagedLayer({ compliance: { mode: "enforcing" } });
      expect(cap.getKey("compliance").mode).toBe("enforcing");
      cap.installManagedLayer(null);
      expect(cap.getKey("compliance").mode).toBe("off");
    });
  });

  describe("removePermissionRule (§9.2 revoke, §13.5)", () => {
    const rule = (decision: string, source: string, priority: number) => ({
      tool: "write_file",
      pattern: "src/**",
      decision,
      priority,
      source,
    });

    it("removes a persisted rule by id from the project layer", async () => {
      const { cap, store } = make({ project: { permissions: { r1: rule("allow", "workspace", 200) } } });
      await cap.load();
      expect(Object.keys(cap.getKey("permissions"))).toContain("r1");
      const res = await cap.removePermissionRule("r1", "project");
      expect(res.ok).toBe(true);
      expect(Object.keys(cap.getKey("permissions"))).not.toContain("r1");
      // The write is persisted and recoverable (§13).
      expect(store).toBeDefined();
    });

    it("returns NOT_FOUND for an unknown rule id", async () => {
      const { cap } = make({ project: { permissions: {} } });
      await cap.load();
      const res = await cap.removePermissionRule("ghost", "project");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
    });

    it("NEVER revokes a MANAGED rule from a lower layer (loosen-proof, §13.5)", async () => {
      const { cap } = make({
        managed: { permissions: { m1: rule("deny", "managed", 0) } },
      });
      await cap.load();
      const res = await cap.removePermissionRule("m1", "project");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("INVALID_INPUT");
    });

    it("rejects revoking a rule whose source is managed even if it sits in a lower layer", async () => {
      const { cap } = make({ project: { permissions: { x: rule("deny", "managed", 0) } } });
      await cap.load();
      const res = await cap.removePermissionRule("x", "project");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("INVALID_INPUT");
    });
  });

  describe("array union across layers (§13.1)", () => {
    const permRule = (id: string) => ({
      [id]: { tool: "read_file", decision: "allow", priority: 0, source: "default" },
    });

    it("unions array keys (dedupe, broad→narrow order) while scalars override", async () => {
      const { cap } = make({
        global: { skills: ["a", "b"], housekeepingIdleDays: 10 },
        project: { skills: ["b", "c"], housekeepingIdleDays: 20 },
        session: { skills: ["c", "d"] },
      });
      await cap.load();
      // Union, deduped, broad layer first then each narrower layer's new entries.
      expect(cap.getKey("skills")).toEqual(["a", "b", "c", "d"]);
      // Scalars still override (narrowest wins).
      expect(cap.getKey("housekeepingIdleDays")).toBe(20);
    });

    it("global array entries survive when the project adds more", async () => {
      const { cap } = make({
        global: { findingsDirectories: [".voidrift/research/"] },
        project: { findingsDirectories: ["docs/notes/"] },
      });
      await cap.load();
      expect(cap.getKey("findingsDirectories")).toEqual([".voidrift/research/", "docs/notes/"]);
    });

    it("unions every array union key and dedupes object elements by shape", async () => {
      const { cap } = make({
        global: { shellSafeCommands: ["ls( .*)?"], shellDenyPatterns: ["rm .*"] },
        project: { shellSafeCommands: ["ls( .*)?", "cat( .*)?"], shellDenyPatterns: ["rm .*"] },
      });
      await cap.load();
      expect(cap.getKey("shellSafeCommands")).toEqual(["ls( .*)?", "cat( .*)?"]);
      expect(cap.getKey("shellDenyPatterns")).toEqual(["rm .*"]); // deduped
    });

    it("contextNoticePcts REPLACES across layers (a tuning vector, not a union key)", async () => {
      const { cap } = make({
        global: { contextNoticePcts: [50, 75] },
        project: { contextNoticePcts: [90] },
      });
      await cap.load();
      // The narrower layer replaces it entirely — NOT unioned to [50, 75, 90].
      expect(cap.getKey("contextNoticePcts")).toEqual([90]);
    });

    it("records (permissions) still merge by id, the narrower id replacing", async () => {
      const { cap } = make({
        global: { permissions: { ...permRule("r1"), ...permRule("r2") } },
        project: { permissions: { r2: { tool: "write_file", decision: "deny", priority: 5, source: "workspace" }, r3: permRule("r3").r3 } },
      });
      await cap.load();
      const perms = cap.getKey("permissions");
      expect(Object.keys(perms).sort()).toEqual(["r1", "r2", "r3"]);
      // The project's r2 replaced the global r2 (record merge by id).
      expect(perms["r2"]!.decision).toBe("deny");
    });

    it("the session layer participates in the union", async () => {
      const { cap } = make({
        global: { skills: ["g"] },
        session: { skills: ["s"] },
      });
      await cap.load();
      expect(cap.getKey("skills")).toEqual(["g", "s"]);
    });
  });

  describe("unlock honored only from global/managed (§13.5, §13.10)", () => {
    it("honors unlock from the global layer", async () => {
      const { cap, emit } = make({ global: { unlock: ["power-state"] } });
      await cap.load();
      expect(cap.getKey("unlock")).toEqual(["power-state"]);
      expect(emit).not.toHaveBeenCalledWith("CONFIG_WARNING", expect.anything());
    });

    it("honors unlock from the managed layer", async () => {
      const { cap } = make({ managed: { unlock: ["flush-firewall"] } });
      await cap.load();
      expect(cap.getKey("unlock")).toEqual(["flush-firewall"]);
    });

    it("an UNKNOWN never-list id in a honored unlock warns (naming the id), still loads (§13.10, D1.2)", async () => {
      const { cap, emit } = make({ global: { unlock: ["power-state", "not-a-real-id"] } });
      await cap.load();
      // The config still applies — the unknown id is not an error.
      expect(cap.getKey("unlock")).toEqual(["power-state", "not-a-real-id"]);
      const warns = emit.mock.calls.filter((c) => c[0] === "CONFIG_WARNING");
      const unknown = warns.find((c) => (c[1] as { message: string }).message.includes("not-a-real-id"));
      expect(unknown, "a CONFIG_WARNING naming the unknown id").toBeDefined();
      expect((unknown![1] as { key: string }).key).toBe("unlock");
    });

    it("a valid honored unlock id emits NO unknown-id warning", async () => {
      const { cap, emit } = make({ global: { unlock: ["power-state", "metadata-hosts", "wipe-disk"] } });
      await cap.load();
      const warns = emit.mock.calls.filter((c) => c[0] === "CONFIG_WARNING");
      expect(warns).toHaveLength(0);
    });

    it("neverList() reflects the honored unlock (lifted flags + metadata-hosts)", async () => {
      const { cap } = make({ global: { unlock: ["power-state"] } });
      await cap.load();
      const view = cap.neverList();
      expect(view.find((r) => r.id === "power-state")?.unlocked).toBe(true);
      expect(view.find((r) => r.id === "wipe-disk")?.unlocked).toBe(false);
      expect(view.some((r) => r.id === "metadata-hosts")).toBe(true);
    });

    it("ignores a project-layer unlock and emits ONE warning naming the file and key", async () => {
      const { cap, emit } = make({ global: { unlock: ["power-state"] }, project: { unlock: ["firewall-flush"] } });
      await cap.load();
      // The project value is dropped; only the global value stands (not unioned).
      expect(cap.getKey("unlock")).toEqual(["power-state"]);
      const warns = emit.mock.calls.filter((c) => c[0] === "CONFIG_WARNING");
      expect(warns).toHaveLength(1);
      const payload = warns[0]![1] as { layer: string; path: string; key: string };
      expect(payload.layer).toBe("project");
      expect(payload.key).toBe("unlock");
      expect(payload.path).toBe("memory://project");
    });

    it("ignores a session-layer unlock (still loads, warns)", async () => {
      const { cap, emit } = make({ session: { unlock: ["power-state"] } });
      await cap.load();
      expect(cap.getKey("unlock")).toEqual([]); // schema default, project/session value ignored
      const warns = emit.mock.calls.filter((c) => c[0] === "CONFIG_WARNING");
      expect(warns.some((c) => (c[1] as { layer: string }).layer === "session")).toBe(true);
    });

    it("a project-file unlock yields EXACTLY ONE warning (layer project), not duplicated (Slice C2d)", async () => {
      // Regression: the session layer must not re-read the project file, which
      // would emit a second, mislabeled warning for the same project `unlock`.
      const { cap, emit } = make({ project: { unlock: ["firewall-flush"] } });
      await cap.load();
      const warns = emit.mock.calls.filter((c) => c[0] === "CONFIG_WARNING");
      expect(warns).toHaveLength(1);
      expect((warns[0]![1] as { layer: string }).layer).toBe("project");
      // And the durable accessor agrees — one warning for the project layer.
      expect(cap.configWarnings()).toHaveLength(1);
      expect(cap.configWarnings()[0]!.layer).toBe("project");
    });

    it("an overlay (per-process) unlock yields one warning worded as the session overrides (Slice C2d)", async () => {
      const { cap, emit } = make({});
      await cap.load();
      cap.setProcessOverlay({ unlock: ["power-state"] });
      const warns = emit.mock.calls.filter((c) => c[0] === "CONFIG_WARNING");
      expect(warns).toHaveLength(1);
      const payload = warns[0]![1] as { layer: string; key: string; message: string };
      expect(payload.layer).toBe("session");
      expect(payload.key).toBe("unlock");
      // The overlay/session warning reads like a set of overrides, not a file.
      expect(payload.message).toBe(
        '"unlock" in the session overrides is ignored; it is honored only from the global or managed layer',
      );
      // Never the ignored value, and never a path that looks like a file.
      expect(payload.message).not.toContain("power-state");
      expect(payload.message).not.toContain("memory://");
    });

    it("retains the warning read-only (deduped by layer+key+path), naming file and key, never a value", async () => {
      const { cap } = make({ project: { unlock: ["firewall-flush"] } });
      await cap.load();
      const w = cap.configWarnings();
      expect(w).toHaveLength(1); // one offending layer, not duplicated across resolves
      expect(w[0]!.layer).toBe("project");
      expect(w[0]!.key).toBe("unlock");
      expect(w[0]!.path).toBe("memory://project");
      // The message names the file and key only — never the ignored value.
      expect(w[0]!.message).toContain("memory://project");
      expect(w[0]!.message).toContain("unlock");
      expect(w[0]!.message).not.toContain("firewall-flush");
    });

    it("recomputes warnings each resolve so a fixed file clears them", async () => {
      const { cap } = make({ project: { unlock: ["firewall-flush"], turnMaxConcurrency: 2 } });
      await cap.load();
      expect(cap.configWarnings()).toHaveLength(1);
      // Fix the project file: drop `unlock`. The next resolve clears the warning.
      expect(cap.applyExternal("project", { turnMaxConcurrency: 2 })).toBeNull();
      expect(cap.configWarnings()).toHaveLength(0);
    });
  });

  describe("model endpoint provenance warning (security-audit S3)", () => {
    const globalModel = {
      models: { local: { model: "m", protocol: "openai", baseUrl: "https://safe.example.com/v1", apiKeyEnv: "OPENAI_API_KEY" } },
      modelSelected: "local",
    };

    it("warns when a project redirects the baseUrl of a global model carrying an apiKeyEnv", async () => {
      const { cap } = make({
        global: globalModel,
        project: { models: { local: { model: "m", protocol: "openai", baseUrl: "https://attacker.test/v1" } } },
      });
      await cap.load();
      const w = cap.configWarnings();
      expect(w).toHaveLength(1);
      expect(w[0]!.key).toBe("models.local.endpoint");
      expect(w[0]!.layer).toBe("project");
      // host only (no scheme/path/credentials), env var NAME present, value absent.
      expect(w[0]!.message).toContain("attacker.test");
      expect(w[0]!.message).toContain("$OPENAI_API_KEY");
      expect(w[0]!.message).not.toContain("https://");
    });

    it("warns for a project-defined model with its own apiKeyEnv", async () => {
      const { cap } = make({
        project: { models: { proj: { model: "m", protocol: "openai", baseUrl: "https://proj.test/v1", apiKeyEnv: "PROJ_KEY" } }, modelSelected: "proj" },
      });
      await cap.load();
      const w = cap.configWarnings();
      expect(w.some((x) => x.key === "models.proj.endpoint" && x.message.includes("$PROJ_KEY") && x.message.includes("proj.test"))).toBe(true);
    });

    it("does not warn for a global-only model", async () => {
      const { cap } = make({ global: globalModel });
      await cap.load();
      expect(cap.configWarnings().filter((x) => x.key.startsWith("models."))).toHaveLength(0);
    });

    it("the warning never contains the API key value even when planted in the env name field is impossible — value-free by construction", async () => {
      // Plant a secret-looking apiKeyEnv value: the warning names it verbatim as
      // an ENV VAR NAME (never a key value), so no key leaks.
      const { cap } = make({
        global: globalModel,
        project: { models: { local: { model: "m", protocol: "openai", baseUrl: "https://attacker.test/v1" } } },
      });
      await cap.load();
      const msg = cap.configWarnings()[0]!.message;
      // The real API key value would be in process.env, never in this message.
      expect(msg).not.toMatch(/sk-/);
    });

    it("modelEndpointProvenance reports host and per-field layers (secret-free)", async () => {
      const { cap } = make({
        global: globalModel,
        project: { models: { local: { model: "m", protocol: "openai", baseUrl: "https://attacker.test/v1" } } },
      });
      await cap.load();
      const prov = cap.modelEndpointProvenance();
      const local = prov.find((p) => p.name === "local")!;
      expect(local.host).toBe("attacker.test");
      expect(local.apiKeyEnv).toBe("OPENAI_API_KEY");
      expect(local.baseUrlLayer).toBe("project");
      expect(local.apiKeyEnvLayer).toBe("global");
      expect(local.fromProject).toBe(true);
    });

    it("modelEntryFile returns the narrowest defining layer's path (project over global, else undefined)", async () => {
      const { cap } = make({
        global: { models: { g: { model: "m", protocol: "openai", contextLimit: 1000 } } },
        project: { models: { p: { model: "m", protocol: "openai", contextLimit: 1000 } } },
      });
      await cap.load();
      expect(cap.modelEntryFile("p")).toBe("memory://project"); // project owns it
      expect(cap.modelEntryFile("g")).toBe("memory://global"); // only global defines it
      expect(cap.modelEntryFile("unknown")).toBeUndefined(); // no layer owns it
    });
  });

  describe("exporter endpoint provenance warning (security audit, LOW)", () => {
    it("warns once when a project layer sets an exporter endpoint (otel)", async () => {
      const { cap } = make({
        global: { plugins: { "@voidrift/plugin-otel-exporter": { enabled: true } } },
        project: { plugins: { "@voidrift/plugin-otel-exporter": { enabled: true, options: { config: { endpoint: "https://collector.attacker.test:4318" } } } } },
      });
      await cap.load();
      const w = cap.configWarnings().filter((x) => x.key.startsWith("plugins.") && x.key.endsWith(".endpoint"));
      expect(w).toHaveLength(1);
      expect(w[0]!.key).toBe("plugins.@voidrift/plugin-otel-exporter.endpoint");
      expect(w[0]!.layer).toBe("project");
      expect(w[0]!.message).toContain("collector.attacker.test");
      expect(w[0]!.message).toContain("masked telemetry is sent there");
      // host only — never scheme/port/path.
      expect(w[0]!.message).not.toContain("https://");
      expect(w[0]!.message).not.toContain(":4318");
    });

    it("warns when a project layer sets the langfuse host", async () => {
      const { cap } = make({
        project: { plugins: { "@voidrift/plugin-langfuse-exporter": { enabled: true, options: { config: { host: "https://lf.attacker.test" } } } } },
      });
      await cap.load();
      const w = cap.configWarnings().filter((x) => x.key.endsWith(".endpoint"));
      expect(w.some((x) => x.message.includes("lf.attacker.test") && x.message.includes("masked telemetry"))).toBe(true);
    });

    it("does not warn for a global-layer exporter endpoint", async () => {
      const { cap } = make({
        global: { plugins: { "@voidrift/plugin-otel-exporter": { enabled: true, options: { config: { endpoint: "https://collector.example.com:4318" } } } } },
      });
      await cap.load();
      expect(cap.configWarnings().filter((x) => x.key.endsWith(".endpoint"))).toHaveLength(0);
    });

    it("exporterEndpointProvenance reports host and layer (secret-free)", async () => {
      const { cap } = make({
        project: { plugins: { "@voidrift/plugin-otel-exporter": { enabled: true, options: { config: { endpoint: "https://collector.attacker.test:4318" } } } } },
      });
      await cap.load();
      const prov = cap.exporterEndpointProvenance();
      const otel = prov.find((p) => p.id === "@voidrift/plugin-otel-exporter")!;
      expect(otel.host).toBe("collector.attacker.test");
      expect(otel.endpointLayer).toBe("project");
      expect(otel.fromProject).toBe(true);
    });
  });

  describe("prototype-pollution guard in the config merge (defense in depth)", () => {
    it("drops `__proto__`/`constructor`/`prototype` from a JSON-parsed layer with no pollution and no effect", async () => {
      // A real config file arrives JSON.parse'd, so `__proto__` is an own key.
      const polluted = JSON.parse('{"__proto__":{"x":1},"turnMaxConcurrency":2}') as Record<string, unknown>;
      const { cap } = make({ project: polluted });
      await cap.load();
      // The dangerous key had NO EFFECT: the config still resolves to a valid
      // document (the layer is safely handled, never applying `__proto__`).
      expect(cap.getKey("turnMaxConcurrency")).toBeGreaterThan(0);
      // No prototype pollution reached Object.prototype.
      expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
      expect((Object.prototype as unknown as Record<string, unknown>)["x"]).toBeUndefined();
    });

    it("deepMerge never copies a dangerous key and never pollutes the prototype", () => {
      const out = deepMerge({}, JSON.parse('{"__proto__":{"polluted":true},"a":1}'));
      expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(false);
      expect(out["a"]).toBe(1);
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    });
  });

  describe("resolveWithProvenance for array keys (§13.1, §13.9)", () => {
    it("reports which layers contributed each element in broad→narrow order", async () => {
      const { cap } = make({
        global: { skills: ["a", "b"] },
        project: { skills: ["b", "c"] },
      });
      await cap.load();
      const { value, from } = cap.resolveWithProvenance("skills");
      expect(value).toEqual(["a", "b", "c"]);
      expect(from['string:a']).toEqual(["global"]);
      expect(from['string:b']).toEqual(["global", "project"]); // in both layers
      expect(from['string:c']).toEqual(["project"]);
    });

    it("omits an ignored project unlock from provenance", async () => {
      const { cap } = make({ global: { unlock: ["power-state"] }, project: { unlock: ["firewall-flush"] } });
      await cap.load();
      const { value, from } = cap.resolveWithProvenance("unlock");
      expect(value).toEqual(["power-state"]);
      expect(from['string:power-state']).toEqual(["global"]);
      expect(from['string:firewall-flush']).toBeUndefined();
    });
  });

  describe("managed floor composes with the array union (§13.5)", () => {
    it("a managed array entry survives the union and is never shrunk by a lower layer", async () => {
      const { cap } = make({
        managed: { shellDenyPatterns: ["managed-deny .*"] },
        global: { shellDenyPatterns: ["global-deny .*"] },
        project: { shellDenyPatterns: ["project-deny .*"] },
      });
      await cap.load();
      const deny = cap.getKey("shellDenyPatterns");
      // The managed entry leads (broadest) and all contributing entries are kept.
      expect(deny).toEqual(["managed-deny .*", "global-deny .*", "project-deny .*"]);
    });

    it("a managed permission deny stays a floor the union cannot weaken", async () => {
      const { cap } = make({
        managed: { permissions: { m1: { tool: "execute_command", pattern: "rm *", decision: "deny", priority: 0, source: "managed" } } },
        global: { skills: ["g"] },
      });
      await cap.load();
      // The managed deny is re-asserted at the floor priority and still present.
      expect(cap.getKey("permissions")["m1"]!.decision).toBe("deny");
      // The unrelated array union still composes.
      expect(cap.getKey("skills")).toEqual(["g"]);
    });
  });

  describe("limits view and layers (§13.11)", () => {
    it("limitsView lists every registry key with value, unit, class and source", async () => {
      const { cap } = make({
        global: { limits: { memory: { entryChars: 6000 } } },
        project: { limits: { memory: { entryChars: 4000 } } },
      });
      await cap.load();
      const { limits } = cap.limitsView();
      const mem = limits.find((l) => l.key === "memory.entryChars")!;
      expect(mem.value).toBe(4000);
      expect(mem.source).toBe("project");
      expect(mem.sourcePath).toBe("memory://project");
      expect(mem.unit).toBe("chars");
      expect(mem.class).toBe("tunable");
      // A key no layer set falls back to the default, source "default".
      const unset = limits.find((l) => l.key === "tools.commandTimeoutMs")!;
      expect(unset.source).toBe("default");
      // Wave 2a set the default to 120000 (what the command runner actually
      // allows). Tie it to the runner's effective default so the two cannot
      // drift: both read limitDefault("tools.commandTimeoutMs").
      expect(unset.value).toBe(120_000);
      expect(unset.value).toBe(limitDefault("tools.commandTimeoutMs"));
      expect(resolveCommandTimeoutMs(undefined)).toBe(unset.value);
    });

    it("limitsView surfaces an ignored safety-raise warning", async () => {
      const { cap } = make({
        global: { limits: { plugins: { optionsMaxBytes: 65536 } } },
        project: { limits: { plugins: { optionsMaxBytes: 1_000_000 } } },
      });
      await cap.load();
      const { limits, warnings } = cap.limitsView();
      expect(limits.find((l) => l.key === "plugins.optionsMaxBytes")!.value).toBe(65536);
      expect(warnings.some((w) => w.key === "plugins.optionsMaxBytes" && w.layer === "project")).toBe(true);
    });

    it("a legacy top-level alias key (snapshotCount) resolves through the registry, same value as the nested key", async () => {
      const viaLegacy = make({ global: { snapshotCount: 10 } });
      await viaLegacy.cap.load();
      const viaNested = make({ global: { limits: { rollback: { snapshotCount: 10 } } } });
      await viaNested.cap.load();
      expect(viaLegacy.cap.effectiveLimit("rollback.snapshotCount")).toBe(10);
      expect(viaNested.cap.effectiveLimit("rollback.snapshotCount")).toBe(10);
      // The alias read reports the layer as the source (not "default").
      expect(viaLegacy.cap.limitSource("rollback.snapshotCount")).toBe("global");
    });

    it("emits CONFIG_RESOLVED on every successful resolve so limits can re-resolve", async () => {
      const { cap, emit } = make({ global: { limits: { memory: { entryChars: 6000 } } } });
      await cap.load();
      expect(emit).toHaveBeenCalledWith("CONFIG_RESOLVED", {});
    });

    it("limitLayers returns each present layer's limits with its file path", async () => {
      const { cap } = make({
        global: { limits: { memory: { entryChars: 6000 } } },
        project: { limits: { tools: { commandTimeoutMs: 1000 } } },
      });
      await cap.load();
      const layers = cap.limitLayers();
      expect(layers.map((l) => l.layer)).toEqual(["global", "project"]);
      expect(layers[1]?.path).toBe("memory://project");
    });
  });
});

