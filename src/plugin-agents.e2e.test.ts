/**
 * End-to-end test for plugin agent registration via real plugin loading (§12.4).
 * Tests the complete cycle: load plugin with agents, copy valid ones via config.init,
 * handle invalid/escaping agents, disable/enable, and verify API surface.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { hermeticTmp } from "./test-hermetic.js";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import path from "node:path";
import fs from "node:fs/promises";
import { createCore } from "./boot.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
import { seededPermissionsRecord } from "./test-support/seed-rules.js";
import type { ResolvedModel } from "./entities/ports/model-port.js";
import type { ModelConfigEntry } from "./config/schema.js";

describe("Plugin agents e2e (§12.4, §13.9.1)", () => {
  let ws: string;
  let globalHome: string;
  let prevXdg: string | undefined;

  const seed = {
    models: { test: { model: "test-model", protocol: "openai", contextLimit: 32_000 } },
    modelSelected: "test",
    permissions: seededPermissionsRecord(),
  };

  function fakeFactory(script: () => ReturnType<typeof fakeModel>) {
    return (_r: ResolvedModel, _e: ModelConfigEntry) => script();
  }

  async function writePkg(root: string, rel: string, pkg: Record<string, unknown>, index: string): Promise<string> {
    const dir = path.join(root, rel);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
    await fs.writeFile(path.join(dir, "index.js"), index);
    return dir;
  }

  beforeEach(async () => {
    ws = hermeticTmp("plugin-agents-e2e");
    globalHome = hermeticTmp("xdg-plugin-agents");
    prevXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = globalHome;
  });

  afterEach(async () => {
    if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = prevXdg;
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(globalHome, { recursive: true, force: true });
  });

  it("(1) registers fixture plugin agents, and api.agents.list() contains none before config.init", async () => {
    // Set up plugin with good and bad agents
    const pluginDir = await writePkg(
      ws,
      "myplugin",
      {
        name: "myplugin",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true },
      },
      `export function register(core) { core.register.agents('./agents'); }`,
    );

    // Create good agent (copy from seed)
    const goodAgentDir = path.join(pluginDir, "agents", "planner");
    await fs.mkdir(goodAgentDir, { recursive: true });
    const seedPlannerJson = await fs.readFile(
      path.join(process.cwd(), "seed/agents/planner/agent.json"),
      "utf-8"
    );
    const seedPlannerPrompt = await fs.readFile(
      path.join(process.cwd(), "seed/agents/planner/prompt.md"),
      "utf-8"
    );
    await fs.writeFile(path.join(goodAgentDir, "agent.json"), seedPlannerJson);
    await fs.writeFile(path.join(goodAgentDir, "prompt.md"), seedPlannerPrompt);

    // Create bad agent (invalid JSON)
    const badAgentDir = path.join(pluginDir, "agents", "bad-agent");
    await fs.mkdir(badAgentDir, { recursive: true });
    await fs.writeFile(path.join(badAgentDir, "agent.json"), "{ invalid json");
    await fs.writeFile(path.join(badAgentDir, "prompt.md"), "# Bad Agent");

    const sessions = new InMemorySessionRepository();
    const config = { ...seed, plugins: { myplugin: { enabled: true, path: pluginDir } } };
    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(config),
      sessionRepository: sessions,
      chatModelFactory: fakeFactory(() => fakeModel().respond(new AIMessage("ok"))),
      installSignalHandlers: false,
    });

    // Wait for plugin to load
    await new Promise((r) => setTimeout(r, 400));

    // The plugin's 'planner' MUST be registered as a template (plugin loaded):
    // this makes the runtime-absence assertion below meaningful, not vacuous.
    const templateNames = (api as any).deps.agentTemplatesRegistry
      .getAll()
      .map((t: { name: string }) => t.name);
    expect(templateNames).toContain("planner");

    // (a) api.agents.list() must NOT contain 'planner' before config.init:
    // a template is never a runtime agent.
    const agentsResult = await api.agents.list();
    expect(agentsResult.ok).toBe(true);
    if (agentsResult.ok) {
      const agentNames = agentsResult.value.map((a) => a.name);
      expect(agentNames).not.toContain("planner");
    }

    await api.session.shutdown();
  });

  it("(2) config.init seeds good agent, keeps bad with reason, files exist at workspace/.voidrift/agents", async () => {
    const pluginDir = await writePkg(
      ws,
      "myplugin",
      {
        name: "myplugin",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true },
      },
      `export function register(core) { core.register.agents('./agents'); }`,
    );

    // Create good agent
    const goodAgentDir = path.join(pluginDir, "agents", "planner");
    await fs.mkdir(goodAgentDir, { recursive: true });
    const seedPlannerJson = await fs.readFile(
      path.join(process.cwd(), "seed/agents/planner/agent.json"),
      "utf-8"
    );
    const seedPlannerPrompt = await fs.readFile(
      path.join(process.cwd(), "seed/agents/planner/prompt.md"),
      "utf-8"
    );
    await fs.writeFile(path.join(goodAgentDir, "agent.json"), seedPlannerJson);
    await fs.writeFile(path.join(goodAgentDir, "prompt.md"), seedPlannerPrompt);

    // Create bad agent
    const badAgentDir = path.join(pluginDir, "agents", "bad-agent");
    await fs.mkdir(badAgentDir, { recursive: true });
    await fs.writeFile(path.join(badAgentDir, "agent.json"), "{ invalid json");
    await fs.writeFile(path.join(badAgentDir, "prompt.md"), "# Bad Agent");

    const sessions = new InMemorySessionRepository();
    const config = { ...seed, plugins: { myplugin: { enabled: true, path: pluginDir } } };
    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(config),
      sessionRepository: sessions,
      chatModelFactory: fakeFactory(() => fakeModel().respond(new AIMessage("ok"))),
      installSignalHandlers: false,
    });

    await new Promise((r) => setTimeout(r, 400));

    // (b) config.init should seed good and keep bad
    const initResult = await api.config.init({ scope: "project", dir: ws });
    expect(initResult.ok).toBe(true);
    if (initResult.ok) {
      const seeded = initResult.value.seeded ?? [];
      expect(seeded).toContain("planner");
      expect(initResult.value.kept).toBeDefined();
      expect(initResult.value.kept!.length).toBeGreaterThan(0);
      const keptBad = initResult.value.kept!.find((k) => k.name === "bad-agent");
      expect(keptBad).toBeDefined();
      expect(keptBad?.reason).toBeDefined();
      expect(keptBad?.reason!.length).toBeGreaterThan(0);
    }

    // Files should exist at workspace/.voidrift/agents/
    const goodJsonPath = path.join(ws, ".voidrift", "agents", "planner", "agent.json");
    const goodPromptPath = path.join(ws, ".voidrift", "agents", "planner", "prompt.md");
    const existsJson = await fs.stat(goodJsonPath).catch(() => null);
    const existsPrompt = await fs.stat(goodPromptPath).catch(() => null);
    expect(existsJson).not.toBeNull();
    expect(existsPrompt).not.toBeNull();

    await api.session.shutdown();
  });

  it("(3) after config.init copy, files exist; agents.list() loads at boot only", async () => {
    const pluginDir = await writePkg(
      ws,
      "myplugin",
      {
        name: "myplugin",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true },
      },
      `export function register(core) { core.register.agents('./agents'); }`,
    );

    // Create good agent
    const goodAgentDir = path.join(pluginDir, "agents", "planner");
    await fs.mkdir(goodAgentDir, { recursive: true });
    const seedPlannerJson = await fs.readFile(
      path.join(process.cwd(), "seed/agents/planner/agent.json"),
      "utf-8"
    );
    const seedPlannerPrompt = await fs.readFile(
      path.join(process.cwd(), "seed/agents/planner/prompt.md"),
      "utf-8"
    );
    await fs.writeFile(path.join(goodAgentDir, "agent.json"), seedPlannerJson);
    await fs.writeFile(path.join(goodAgentDir, "prompt.md"), seedPlannerPrompt);

    const sessions = new InMemorySessionRepository();
    const config = { ...seed, plugins: { myplugin: { enabled: true, path: pluginDir } } };
    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(config),
      sessionRepository: sessions,
      chatModelFactory: fakeFactory(() => fakeModel().respond(new AIMessage("ok"))),
      installSignalHandlers: false,
    });

    await new Promise((r) => setTimeout(r, 400));

    // Run config.init to seed
    const initResult = await api.config.init({ scope: "project", dir: ws });
    expect(initResult.ok).toBe(true);

    // agents.list() loads at boot; reindex to reload
    const reindexResult = await api.agents.reindex();
    expect(reindexResult.ok).toBe(true);
    if (reindexResult.ok) {
      const registered = reindexResult.value.registered ?? [];
      expect(registered).toContain("planner");
    }

    // Files should exist
    const goodJsonPath = path.join(ws, ".voidrift", "agents", "planner", "agent.json");
    const jsonExists = await fs.stat(goodJsonPath).catch(() => null);
    expect(jsonExists).not.toBeNull();

    await api.session.shutdown();
  });

  it("(4) second init: good is in kept (collision) and file bytes are unchanged", async () => {
    const pluginDir = await writePkg(
      ws,
      "myplugin",
      {
        name: "myplugin",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true },
      },
      `export function register(core) { core.register.agents('./agents'); }`,
    );

    // Create good agent
    const goodAgentDir = path.join(pluginDir, "agents", "planner");
    await fs.mkdir(goodAgentDir, { recursive: true });
    const seedPlannerJson = await fs.readFile(
      path.join(process.cwd(), "seed/agents/planner/agent.json"),
      "utf-8"
    );
    const seedPlannerPrompt = await fs.readFile(
      path.join(process.cwd(), "seed/agents/planner/prompt.md"),
      "utf-8"
    );
    await fs.writeFile(path.join(goodAgentDir, "agent.json"), seedPlannerJson);
    await fs.writeFile(path.join(goodAgentDir, "prompt.md"), seedPlannerPrompt);

    const sessions = new InMemorySessionRepository();
    const config = { ...seed, plugins: { myplugin: { enabled: true, path: pluginDir } } };
    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(config),
      sessionRepository: sessions,
      chatModelFactory: fakeFactory(() => fakeModel().respond(new AIMessage("ok"))),
      installSignalHandlers: false,
    });

    await new Promise((r) => setTimeout(r, 400));

    // First init
    const first = await api.config.init({ scope: "project", dir: ws });
    expect(first.ok).toBe(true);

    // Verify files exist before taking bytes
    const goodJsonPath = path.join(ws, ".voidrift", "agents", "planner", "agent.json");
    const jsonExists = await fs.stat(goodJsonPath).catch(() => null);
    expect(jsonExists).not.toBeNull();

    // Capture file bytes after first init
    const bytesAfterFirst = await fs.readFile(goodJsonPath);

    // Second init should report collision
    const secondInit = await api.config.init({ scope: "project", dir: ws });
    expect(secondInit.ok).toBe(true);
    if (secondInit.ok) {
      // Good should be in kept due to collision
      expect(secondInit.value.kept).toBeDefined();
      const keptGood = secondInit.value.kept!.find((k) => k.name === "planner");
      expect(keptGood).toBeDefined();
      expect(keptGood?.reason).toContain("already exists");
    }

    // Verify file bytes are unchanged
    const bytesAfterSecond = await fs.readFile(goodJsonPath);
    expect(bytesAfterFirst).toEqual(bytesAfterSecond);

    await api.session.shutdown();
  });

  it("(5) escaping ../ dir and in-package symlink register nothing, ERROR_OCCURRED emitted", async () => {
    // Read a valid seed agent to plant outside the plugin dir.
    const seedPlannerJson = await fs.readFile(
      path.join(process.cwd(), "seed/agents/planner/agent.json"),
      "utf-8"
    );
    const seedPlannerPrompt = await fs.readFile(
      path.join(process.cwd(), "seed/agents/planner/prompt.md"),
      "utf-8"
    );

    // --- Case A: plugin registers '../outside' (path traversal) ---
    // Plant a VALID agent 'escape' at <ws>/outside/escape so that WITHOUT the
    // confinement check init would seed 'escape'. The agent name must equal its
    // directory name for the manifest to validate.
    const escapeDir = path.join(ws, "outside", "escape");
    await fs.mkdir(escapeDir, { recursive: true });
    await fs.writeFile(
      path.join(escapeDir, "agent.json"),
      seedPlannerJson.replace(/"name":\s*"planner"/, '"name": "escape"')
    );
    await fs.writeFile(path.join(escapeDir, "prompt.md"), seedPlannerPrompt);

    const pluginA = await writePkg(
      ws,
      "plugin-a",
      {
        name: "plugin-a",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true },
      },
      `export function register(core) { core.register.agents('../outside'); }`,
    );

    // --- Case B: in-package symlink <plugin>/agents -> <ws>/outside ---
    // The plugin registers './agents', but that directory is a symlink escaping
    // the package. resolveInside must reject it via realpath.
    const pluginB = await writePkg(
      ws,
      "plugin-b",
      {
        name: "plugin-b",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true },
      },
      `export function register(core) { core.register.agents('./agents'); }`,
    );
    await fs.symlink(path.join(ws, "outside"), path.join(pluginB, "agents"), "dir");

    const errorEvents: Array<{ source: string; message: string }> = [];

    const sessions = new InMemorySessionRepository();
    const config = {
      ...seed,
      plugins: {
        "plugin-a": { enabled: true, path: pluginA },
        "plugin-b": { enabled: true, path: pluginB },
      },
    };
    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(config),
      sessionRepository: sessions,
      chatModelFactory: fakeFactory(() => fakeModel().respond(new AIMessage("ok"))),
      installSignalHandlers: false,
    });

    api.events.subscribe("ERROR_OCCURRED", (e) => {
      errorEvents.push(e.payload as { source: string; message: string });
    });

    await new Promise((r) => setTimeout(r, 400));

    // No agent template was registered by either plugin: confinement rejected
    // both the `../` traversal and the symlink-escaping `./agents`.
    const templates = (api as any).deps.agentTemplatesRegistry.getAll();
    expect(templates.length).toBe(0);

    // The boot-time confinement errors fire before a post-boot subscription can
    // observe them. Re-register both plugins (disable → enable) while the
    // subscriber is live: register.agents runs again, so the confinement path
    // (resolveInside → null → ERROR_OCCURRED) is exercised under observation.
    for (const id of ["plugin-a", "plugin-b"]) {
      expect((await api.plugins.disable(id)).ok).toBe(true);
    }
    errorEvents.length = 0;
    for (const id of ["plugin-a", "plugin-b"]) {
      expect((await api.plugins.enable(id, "project")).ok).toBe(true);
    }
    await new Promise((r) => setTimeout(r, 400));

    // Still nothing registered, and each re-registration emitted an agents error.
    expect((api as any).deps.agentTemplatesRegistry.getAll().length).toBe(0);
    const agentErrors = errorEvents.filter((e) => e.source === "agents");
    expect(agentErrors.length).toBeGreaterThanOrEqual(2);

    // config.init offers nothing: no seeded 'escape' and no seeded 'planner'.
    const initResult = await api.config.init({ scope: "project", dir: ws });
    expect(initResult.ok).toBe(true);
    if (initResult.ok) {
      const seeded = initResult.value.seeded ?? [];
      expect(seeded).not.toContain("escape");
      expect(seeded).not.toContain("planner");
      expect(seeded.length).toBe(0);
    }

    await api.session.shutdown();
  });

  it("(6) disable removes templates (copied files untouched); re-enable re-offers", async () => {
    const pluginDir = await writePkg(
      ws,
      "myplugin",
      {
        name: "myplugin",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true },
      },
      `export function register(core) { core.register.agents('./agents'); }`,
    );

    // Create good agent
    const goodAgentDir = path.join(pluginDir, "agents", "planner");
    await fs.mkdir(goodAgentDir, { recursive: true });
    const seedPlannerJson = await fs.readFile(
      path.join(process.cwd(), "seed/agents/planner/agent.json"),
      "utf-8"
    );
    const seedPlannerPrompt = await fs.readFile(
      path.join(process.cwd(), "seed/agents/planner/prompt.md"),
      "utf-8"
    );
    await fs.writeFile(path.join(goodAgentDir, "agent.json"), seedPlannerJson);
    await fs.writeFile(path.join(goodAgentDir, "prompt.md"), seedPlannerPrompt);

    const sessions = new InMemorySessionRepository();
    const config = { ...seed, plugins: { myplugin: { enabled: true, path: pluginDir } } };
    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(config),
      sessionRepository: sessions,
      chatModelFactory: fakeFactory(() => fakeModel().respond(new AIMessage("ok"))),
      installSignalHandlers: false,
    });

    await new Promise((r) => setTimeout(r, 400));

    // First init seeds planner.
    const first = await api.config.init({ scope: "project", dir: ws });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.seeded ?? []).toContain("planner");

    const goodJsonPath = path.join(ws, ".voidrift", "agents", "planner", "agent.json");
    const seededStat = await fs.stat(goodJsonPath).catch(() => null);
    expect(seededStat).not.toBeNull();
    const bytesAfterSeed = await fs.readFile(goodJsonPath);

    // Disable the plugin: its templates are unregistered, but copied files are
    // never touched (§12.4 integration test).
    const disableResult = await api.plugins.disable("myplugin");
    expect(disableResult.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 200));

    // The copied file is still present and byte-identical after disable.
    const statAfterDisable = await fs.stat(goodJsonPath).catch(() => null);
    expect(statAfterDisable).not.toBeNull();
    const bytesAfterDisable = await fs.readFile(goodJsonPath);
    expect(bytesAfterDisable).toEqual(bytesAfterSeed);

    // No templates remain while disabled.
    expect((api as any).deps.agentTemplatesRegistry.getAll().length).toBe(0);

    // Remove the copied directory, then init again WHILE DISABLED: planner is
    // NOT offered because the template source is gone.
    await fs.rm(path.join(ws, ".voidrift", "agents", "planner"), { recursive: true });
    const whileDisabled = await api.config.init({ scope: "project", dir: ws });
    expect(whileDisabled.ok).toBe(true);
    if (whileDisabled.ok) {
      expect(whileDisabled.value.seeded ?? []).not.toContain("planner");
    }

    // Re-enable: templates are registered again and init re-offers planner
    // (the copied file was removed, so it is a fresh seed, not a collision).
    const enableResult = await api.plugins.enable("myplugin", "project");
    expect(enableResult.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect((api as any).deps.agentTemplatesRegistry.getAll().length).toBeGreaterThan(0);

    const afterEnable = await api.config.init({ scope: "project", dir: ws });
    expect(afterEnable.ok).toBe(true);
    if (afterEnable.ok) {
      expect(afterEnable.value.seeded ?? []).toContain("planner");
    }

    await api.session.shutdown();
  });
});
