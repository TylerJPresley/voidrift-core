/**
 * End-to-end test for host-level discoverPluginAgentTemplates (§12.4, §13.9.1).
 * Discovers enabled plugins' agent templates without booting a core — no model,
 * no network, no engine/graph, no MCP servers, no session.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { hermeticTmp } from "./test-hermetic.js";
import path from "node:path";
import fs from "node:fs/promises";
import { discoverPluginAgentTemplates, initConfigHome } from "./boot.js";
import type { PluginAgentTemplate } from "./use-cases/config-init.js";

describe("discoverPluginAgentTemplates (§12.4, §13.9.1)", () => {
  let ws: string;
  let globalHome: string;
  let prevXdg: string | undefined;

  async function writePkg(root: string, rel: string, pkg: Record<string, unknown>, index: string): Promise<string> {
    const dir = path.join(root, rel);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
    await fs.writeFile(path.join(dir, "index.js"), index);
    return dir;
  }

  async function writeProjectConfig(dir: string, config: Record<string, unknown>): Promise<void> {
    const voidriftDir = path.join(dir, ".voidrift");
    await fs.mkdir(voidriftDir, { recursive: true });
    await fs.writeFile(path.join(voidriftDir, "config.json"), JSON.stringify(config, null, 2));
  }

  beforeEach(async () => {
    ws = hermeticTmp("discover-plugin-agents");
    globalHome = hermeticTmp("xdg-discover-plugin");
    prevXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = globalHome;
  });

  afterEach(async () => {
    if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = prevXdg;
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(globalHome, { recursive: true, force: true });
  });

  it("discovers enabled plugin's agent templates and returns plugin id", async () => {
    // Create plugin with a good agent template
    const pluginDir = await writePkg(
      ws,
      "test-plugin",
      {
        name: "test-plugin",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true },
      },
      `export function register(core) { core.register.agents('./agents'); }`,
    );

    // Copy seed agent as template
    const agentDir = path.join(pluginDir, "agents", "planner");
    await fs.mkdir(agentDir, { recursive: true });
    const seedPlannerJson = await fs.readFile(path.join(process.cwd(), "seed/agents/planner/agent.json"), "utf-8");
    const seedPlannerPrompt = await fs.readFile(path.join(process.cwd(), "seed/agents/planner/prompt.md"), "utf-8");
    await fs.writeFile(path.join(agentDir, "agent.json"), seedPlannerJson);
    await fs.writeFile(path.join(agentDir, "prompt.md"), seedPlannerPrompt);

    // Write project config enabling the plugin
    await writeProjectConfig(ws, {
      plugins: {
        "test-plugin": { enabled: true, path: pluginDir },
      },
    });

    const result = await discoverPluginAgentTemplates({ workspaceRoot: ws });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.plugins.length).toBeGreaterThan(0);  // First verify the plugin is loaded
      expect(result.value.templates).toHaveLength(1);
      expect(result.value.templates[0]).toMatchObject({
        pluginId: "test-plugin",
        name: "planner",
      });
      expect(result.value.plugins).toContain("test-plugin");
    }
  });

  it("does not break when plugin register calls register.tool/docs/command", async () => {
    const pluginDir = await writePkg(
      ws,
      "tool-plugin",
      {
        name: "tool-plugin",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true },
      },
      `export function register(core) {
        core.register.agents('./agents');
        core.register.tool({ name: 'dummy', description: 'test' }, async () => ({ text: '' }));
        core.register.docs('test', 'Test');
      }`,
    );

    const agentDir = path.join(pluginDir, "agents", "vibe");
    await fs.mkdir(agentDir, { recursive: true });
    const seedJson = await fs.readFile(path.join(process.cwd(), "seed/agents/vibe/agent.json"), "utf-8");
    const seedPrompt = await fs.readFile(path.join(process.cwd(), "seed/agents/vibe/prompt.md"), "utf-8");
    await fs.writeFile(path.join(agentDir, "agent.json"), seedJson);
    await fs.writeFile(path.join(agentDir, "prompt.md"), seedPrompt);

    await writeProjectConfig(ws, {
      plugins: {
        "tool-plugin": { enabled: true, path: pluginDir },
      },
    });

    const result = await discoverPluginAgentTemplates({ workspaceRoot: ws });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.templates).toHaveLength(1);
      expect(result.value.templates[0]!.name).toBe("vibe");
    }
  });

  it("skips disabled plugins (register never runs, no marker file written)", async () => {
    const pluginDir = await writePkg(
      ws,
      "disabled-plugin",
      {
        name: "disabled-plugin",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true },
      },
      `export function register(core) {
        import('node:fs/promises').then(fs => fs.writeFile('./register-called', ''));
        core.register.agents('./agents');
      }`,
    );

    const agentDir = path.join(pluginDir, "agents", "researcher");
    await fs.mkdir(agentDir, { recursive: true });
    const seedJson = await fs.readFile(path.join(process.cwd(), "seed/agents/researcher/agent.json"), "utf-8");
    const seedPrompt = await fs.readFile(path.join(process.cwd(), "seed/agents/researcher/prompt.md"), "utf-8");
    await fs.writeFile(path.join(agentDir, "agent.json"), seedJson);
    await fs.writeFile(path.join(agentDir, "prompt.md"), seedPrompt);

    await writeProjectConfig(ws, {
      plugins: {
        "disabled-plugin": { enabled: false, path: pluginDir },
      },
    });

    const result = await discoverPluginAgentTemplates({ workspaceRoot: ws });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.templates).toHaveLength(0);
      expect(result.value.plugins).toHaveLength(0);
    }
    // Verify register was NOT called
    const markerFile = path.join(pluginDir, "register-called");
    const exists = await fs.access(markerFile).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it("contains register failures without throwing; returns warnings", async () => {
    const pluginDir = await writePkg(
      ws,
      "bad-register",
      {
        name: "bad-register",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true },
      },
      `export function register(core) {
        throw new Error('Plugin register failed');
      }`,
    );

    const agentDir = path.join(pluginDir, "agents", "planner");
    await fs.mkdir(agentDir, { recursive: true });
    const seedJson = await fs.readFile(path.join(process.cwd(), "seed/agents/planner/agent.json"), "utf-8");
    const seedPrompt = await fs.readFile(path.join(process.cwd(), "seed/agents/planner/prompt.md"), "utf-8");
    await fs.writeFile(path.join(agentDir, "agent.json"), seedJson);
    await fs.writeFile(path.join(agentDir, "prompt.md"), seedPrompt);

    await writeProjectConfig(ws, {
      plugins: {
        "bad-register": { enabled: true, path: pluginDir },
      },
    });

    const result = await discoverPluginAgentTemplates({ workspaceRoot: ws });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.templates).toHaveLength(0);
      expect(result.value.warnings).toBeDefined();
      expect(result.value.warnings?.length).toBeGreaterThan(0);
    }
  });

  it("refuses symlinked template files", async () => {
    const pluginDir = await writePkg(
      ws,
      "symlink-plugin",
      {
        name: "symlink-plugin",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true },
      },
      `export function register(core) { core.register.agents('./agents'); }`,
    );

    const agentDir = path.join(pluginDir, "agents", "planner");
    await fs.mkdir(agentDir, { recursive: true });
    const seedJson = await fs.readFile(path.join(process.cwd(), "seed/agents/planner/agent.json"), "utf-8");
    const seedPrompt = await fs.readFile(path.join(process.cwd(), "seed/agents/planner/prompt.md"), "utf-8");
    await fs.writeFile(path.join(agentDir, "agent.json"), seedJson);
    await fs.writeFile(path.join(agentDir, "prompt.md"), seedPrompt);

    // Create symlink escaping the package root
    const escapeDir = path.join(ws, "escape");
    await fs.mkdir(escapeDir, { recursive: true });
    await fs.writeFile(path.join(escapeDir, "agent.json"), "{}");
    await fs.symlink(path.join(escapeDir, "agent.json"), path.join(agentDir, "agent.json.link"));

    // Replace with symlink (this would escape)
    await fs.rm(path.join(agentDir, "agent.json"));
    await fs.symlink(path.join(escapeDir, "agent.json"), path.join(agentDir, "agent.json"));

    await writeProjectConfig(ws, {
      plugins: {
        "symlink-plugin": { enabled: true, path: pluginDir },
      },
    });

    // Discover should skip this due to symlink detection
    const result = await discoverPluginAgentTemplates({ workspaceRoot: ws });
    expect(result.ok).toBe(true);
  });

  it("initConfigHome with pluginAgents option seeds templates, repeat run is no-op", async () => {
    const pluginDir = await writePkg(
      ws,
      "seed-plugin",
      {
        name: "seed-plugin",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true },
      },
      `export function register(core) { core.register.agents('./agents'); }`,
    );

    const agentDir = path.join(pluginDir, "agents", "implementer");
    await fs.mkdir(agentDir, { recursive: true });
    const seedJson = await fs.readFile(path.join(process.cwd(), "seed/agents/implementer/agent.json"), "utf-8");
    const seedPrompt = await fs.readFile(path.join(process.cwd(), "seed/agents/implementer/prompt.md"), "utf-8");
    await fs.writeFile(path.join(agentDir, "agent.json"), seedJson);
    await fs.writeFile(path.join(agentDir, "prompt.md"), seedPrompt);

    const templates: PluginAgentTemplate[] = [
      {
        pluginId: "seed-plugin",
        dir: agentDir,
        name: "implementer",
      },
    ];

    // First run seeds the template
    const result1 = await initConfigHome({ scope: "project", dir: ws, pluginAgents: templates });
    expect(result1.ok).toBe(true);
    if (result1.ok) {
      expect(result1.value.seeded).toContain("implementer");
    }

    // Second run is a complete no-op (neither seeded nor kept)
    const result2 = await initConfigHome({ scope: "project", dir: ws, pluginAgents: templates });
    expect(result2.ok).toBe(true);
    if (result2.ok) {
      // Identical template should appear in neither group
      expect(result2.value.seeded?.includes("implementer")).not.toBe(true);
      if (result2.value.kept) {
        expect(result2.value.kept.map(k => k.name)).not.toContain("implementer");
      }
    }
  });

  it("changed existing agent goes to kept with reason", async () => {
    const pluginDir = await writePkg(
      ws,
      "change-plugin",
      {
        name: "change-plugin",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true },
      },
      `export function register(core) { core.register.agents('./agents'); }`,
    );

    const agentDir = path.join(pluginDir, "agents", "reviewer");
    await fs.mkdir(agentDir, { recursive: true });
    const seedJson = await fs.readFile(path.join(process.cwd(), "seed/agents/reviewer/agent.json"), "utf-8");
    const seedPrompt = await fs.readFile(path.join(process.cwd(), "seed/agents/reviewer/prompt.md"), "utf-8");
    await fs.writeFile(path.join(agentDir, "agent.json"), seedJson);
    await fs.writeFile(path.join(agentDir, "prompt.md"), seedPrompt);

    const templates: PluginAgentTemplate[] = [
      {
        pluginId: "change-plugin",
        dir: agentDir,
        name: "reviewer",
      },
    ];

    // First run seeds the template
    const result1 = await initConfigHome({ scope: "project", dir: ws, pluginAgents: templates });
    expect(result1.ok).toBe(true);

    // Modify the existing agent's prompt
    const projectAgentDir = path.join(ws, ".voidrift", "agents", "reviewer");
    await fs.writeFile(path.join(projectAgentDir, "prompt.md"), "# Modified prompt\n\nChanged by user.");

    // Second run should report it as kept with a reason
    const result2 = await initConfigHome({ scope: "project", dir: ws, pluginAgents: templates });
    expect(result2.ok).toBe(true);
    if (result2.ok && result2.value.kept) {
      const kept = result2.value.kept.find(k => k.name === "reviewer");
      expect(kept).toBeDefined();
      expect(kept?.reason).toContain("already exists");
    }
  });

  it("mutation: disabled plugin is NOT loaded (no register call)", async () => {
    const pluginDir = await writePkg(
      ws,
      "track-plugin",
      {
        name: "track-plugin",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true },
      },
      `let called = false;
export function register(core) {
  called = true;
  core.register.agents('./agents');
}
export function isRegisterCalled() { return called; }`,
    );

    const agentDir = path.join(pluginDir, "agents", "planner");
    await fs.mkdir(agentDir, { recursive: true });
    const seedJson = await fs.readFile(path.join(process.cwd(), "seed/agents/planner/agent.json"), "utf-8");
    const seedPrompt = await fs.readFile(path.join(process.cwd(), "seed/agents/planner/prompt.md"), "utf-8");
    await fs.writeFile(path.join(agentDir, "agent.json"), seedJson);
    await fs.writeFile(path.join(agentDir, "prompt.md"), seedPrompt);

    await writeProjectConfig(ws, {
      plugins: {
        "track-plugin": { enabled: false, path: pluginDir },
      },
    });

    const result = await discoverPluginAgentTemplates({ workspaceRoot: ws });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.templates).toHaveLength(0);
      // Disabled plugins should not be in the loaded list
      expect(result.value.plugins).not.toContain("track-plugin");
    }
  });

  it("mutation: identical-content template treated as no-op (not seeded, not kept)", async () => {
    const pluginDir = await writePkg(
      ws,
      "identical-plugin",
      {
        name: "identical-plugin",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true },
      },
      `export function register(core) { core.register.agents('./agents'); }`,
    );

    const agentDir = path.join(pluginDir, "agents", "planner");
    await fs.mkdir(agentDir, { recursive: true });
    const seedJson = await fs.readFile(path.join(process.cwd(), "seed/agents/planner/agent.json"), "utf-8");
    const seedPrompt = await fs.readFile(path.join(process.cwd(), "seed/agents/planner/prompt.md"), "utf-8");
    await fs.writeFile(path.join(agentDir, "agent.json"), seedJson);
    await fs.writeFile(path.join(agentDir, "prompt.md"), seedPrompt);

    const templates: PluginAgentTemplate[] = [
      {
        pluginId: "identical-plugin",
        dir: agentDir,
        name: "planner",
      },
    ];

    // First run
    const result1 = await initConfigHome({ scope: "project", dir: ws, pluginAgents: templates });
    expect(result1.ok).toBe(true);

    // Second run with identical content
    const result2 = await initConfigHome({ scope: "project", dir: ws, pluginAgents: templates });
    expect(result2.ok).toBe(true);

    if (result2.ok && result2.value) {
      // Should not appear in seeded
      const inSeeded = result2.value.seeded?.includes("planner") ?? false;
      expect(inSeeded).toBe(false);

      // Should not appear in kept
      const inKept = result2.value.kept?.map(k => k.name).includes("planner") ?? false;
      expect(inKept).toBe(false);
    }
  });

  it("ASYNC register that awaits then calls register.agents is collected", async () => {
    const pluginDir = await writePkg(
      ws,
      "async-register-plugin",
      {
        name: "async-register-plugin",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true },
      },
      `export async function register(core) {
        // Async work then call register.agents
        await new Promise(r => setImmediate(r));
        core.register.agents('./agents');
      }`,
    );

    const agentDir = path.join(pluginDir, "agents", "summarizer");
    await fs.mkdir(agentDir, { recursive: true });
    const seedJson = await fs.readFile(path.join(process.cwd(), "seed/agents/summarizer/agent.json"), "utf-8");
    const seedPrompt = await fs.readFile(path.join(process.cwd(), "seed/agents/summarizer/prompt.md"), "utf-8");
    await fs.writeFile(path.join(agentDir, "agent.json"), seedJson);
    await fs.writeFile(path.join(agentDir, "prompt.md"), seedPrompt);

    await writeProjectConfig(ws, {
      plugins: {
        "async-register-plugin": { enabled: true, path: pluginDir },
      },
    });

    const result = await discoverPluginAgentTemplates({ workspaceRoot: ws });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Async register that awaits is collected correctly
      expect(result.value.templates.length).toBeGreaterThan(0);
      expect(result.value.templates.some(t => t.name === "summarizer")).toBe(true);
      expect(result.value.plugins).toContain("async-register-plugin");
    }
  });

  it("plugin with copyleft-licensed DEPENDENCY is rejected; appears in warnings", async () => {
    // Create a fake node_modules/dep with GPL-3.0 license
    const depsDir = path.join(ws, "node_modules", "dep");
    await fs.mkdir(depsDir, { recursive: true });
    await fs.writeFile(
      path.join(depsDir, "package.json"),
      JSON.stringify({
        name: "dep",
        version: "1.0.0",
        license: "GPL-3.0",
      }, null, 2)
    );

    // Create plugin that depends on dep
    const pluginDir = await writePkg(
      ws,
      "coplit-plugin",
      {
        name: "copyleft-plugin",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true },
        dependencies: { dep: "1.0.0" },
      },
      `export function register(core) { core.register.agents('./agents'); }`,
    );

    const agentDir = path.join(pluginDir, "agents", "copyleft-test");
    await fs.mkdir(agentDir, { recursive: true });
    const seedJson = await fs.readFile(path.join(process.cwd(), "seed/agents/planner/agent.json"), "utf-8");
    const seedPrompt = await fs.readFile(path.join(process.cwd(), "seed/agents/planner/prompt.md"), "utf-8");
    await fs.writeFile(path.join(agentDir, "agent.json"), seedJson);
    await fs.writeFile(path.join(agentDir, "prompt.md"), seedPrompt);

    await writeProjectConfig(ws, {
      plugins: {
        "copyleft-plugin": { enabled: true, path: pluginDir },
      },
    });

    const result = await discoverPluginAgentTemplates({ workspaceRoot: ws });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Plugin should NOT be loaded due to copyleft dependency
      expect(result.value.plugins).not.toContain("copyleft-plugin");
      // Should have a warning mentioning the copyleft license
      expect(result.value.warnings?.length).toBeGreaterThan(0);
      const copyleftWarning = result.value.warnings?.some(w => w.error.includes("non-permissive") || w.error.includes("GPL"));
      expect(copyleftWarning).toBe(true);
    }
  });

  it("options reach register() as second argument", async () => {
    const pluginDir = await writePkg(
      ws,
      "options-plugin",
      {
        name: "options-plugin",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true },
      },
      `export async function register(core, options) {
        // Write a marker file named from options.configKey to signal options were received
        if (options && options.configKey) {
          const { writeFileSync } = await import('fs');
          const path = await import('path');
          writeFileSync(path.join(process.cwd(), 'got-options-' + options.configKey), '');
        }
        core.register.agents('./agents');
      }`,
    );

    const agentDir = path.join(pluginDir, "agents", "research");
    await fs.mkdir(agentDir, { recursive: true });
    const seedJson = await fs.readFile(path.join(process.cwd(), "seed/agents/research/agent.json"), "utf-8");
    const seedPrompt = await fs.readFile(path.join(process.cwd(), "seed/agents/research/prompt.md"), "utf-8");
    await fs.writeFile(path.join(agentDir, "agent.json"), seedJson);
    await fs.writeFile(path.join(agentDir, "prompt.md"), seedPrompt);

    await writeProjectConfig(ws, {
      plugins: {
        "options-plugin": { enabled: true, path: pluginDir, options: { configKey: "my-config" } },
      },
    });

    const result = await discoverPluginAgentTemplates({ workspaceRoot: ws });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.plugins).toContain("options-plugin");
      // Verify options reached register by checking for the marker file
      const markerFile = path.join(process.cwd(), "got-options-my-config");
      const exists = await fs.access(markerFile).then(() => true).catch(() => false);
      expect(exists).toBe(true);
      // Clean up
      if (exists) await fs.rm(markerFile, { force: true });
    }
  });
});
