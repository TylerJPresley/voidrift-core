/**
 * Tests for register.agents() and config.init plugin agent seeding (§12.4, §13.9.1).
 *
 * Integration test claims from core-blueprint.md §12.4:
 * 1. register.agents adds no agent to agents.list(), the Shift+Tab cycle, or /access
 * 2. symlink escaping the package is refused
 * 3. config.init copies valid template to .voidrift/agents/<name>/ (reported `seeded:`)
 * 4. collision and invalid agent.json reported `kept:` with reason; files untouched
 * 5. disabling plugin removes template source and touches no copied file
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { hermeticTmp } from "../test-hermetic.js";
import { AgentTemplatesRegistry } from "../adapters/agent-templates-registry.js";
import { ConfigInit, type PluginAgentTemplate } from "./config-init.js";
import { NodeInitFs } from "../adapters/init-fs.js";
import path from "node:path";
import fs from "node:fs/promises";

describe("register.agents and config.init plugin agent seeding", () => {
  let tmpDir: string;
  let projectDir: string;
  let pluginDir: string;
  let initFs: NodeInitFs;

  beforeEach(async () => {
    tmpDir = hermeticTmp("register-agents");
    projectDir = path.join(tmpDir, "project");
    pluginDir = path.join(tmpDir, "plugin");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(pluginDir, { recursive: true });
    initFs = new NodeInitFs();
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("AgentTemplatesRegistry", () => {
    it("registers a template and retrieves it", () => {
      const registry = new AgentTemplatesRegistry();
      const template: PluginAgentTemplate = {
        pluginId: "myplugin",
        dir: path.join(pluginDir, "agents"),
        name: "custom-agent",
      };

      registry.register(template);
      const templates = registry.getForPlugin("myplugin");
      expect(templates).toHaveLength(1);
      expect(templates[0]?.name).toBe("custom-agent");
    });

    it("unregisters templates on plugin disable", () => {
      const registry = new AgentTemplatesRegistry();
      const t1: PluginAgentTemplate = {
        pluginId: "myplugin",
        dir: path.join(pluginDir, "agents"),
        name: "agent1",
      };

      registry.register(t1);
      expect(registry.getAll()).toHaveLength(1);

      registry.unregisterPlugin("myplugin");
      expect(registry.getAll()).toHaveLength(0);
    });
  });

  describe("config.init plugin agent seeding", () => {
    it("seeds valid plugin template to project .voidrift/agents/", async () => {
      // Set up plugin template
      const templateDir = path.join(pluginDir, "agents", "my-template");
      await fs.mkdir(templateDir, { recursive: true });
      await fs.writeFile(
        path.join(templateDir, "agent.json"),
        JSON.stringify({
          name: "my-template",
          description: "Test agent",
          kind: "top-level",
        })
      );
      await fs.writeFile(
        path.join(templateDir, "prompt.md"),
        "# My Template\n\nTest prompt"
      );

      // Run project init with plugin templates
      const configInit = new ConfigInit(initFs, "", () => "");
      const result = await configInit.run({
        scope: "project",
        dir: projectDir,
        pluginAgents: [
          {
            pluginId: "myplugin",
            dir: path.join(pluginDir, "agents", "my-template"),
            name: "my-template",
          },
        ],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.seeded).toContain("my-template");
        expect(result.value.kept?.length ?? 0).toBe(0);

        // Verify files were copied
        const agentJsonPath = path.join(projectDir, ".voidrift", "agents", "my-template", "agent.json");
        const promptMdPath = path.join(projectDir, ".voidrift", "agents", "my-template", "prompt.md");

        const agentJson = await fs.readFile(agentJsonPath, "utf-8");
        const promptMd = await fs.readFile(promptMdPath, "utf-8");

        expect(JSON.parse(agentJson).name).toBe("my-template");
        expect(promptMd).toContain("My Template");
      }
    });

    it("skips template on agent directory collision", async () => {
      // Create existing agent directory
      const existingDir = path.join(projectDir, ".voidrift", "agents", "existing");
      await fs.mkdir(existingDir, { recursive: true });
      await fs.writeFile(path.join(existingDir, "agent.json"), "{}");

      // Set up plugin template with same name
      const templateDir = path.join(pluginDir, "agents", "existing");
      await fs.mkdir(templateDir, { recursive: true });
      await fs.writeFile(
        path.join(templateDir, "agent.json"),
        JSON.stringify({ name: "existing", description: "Test", kind: "top-level" })
      );
      await fs.writeFile(path.join(templateDir, "prompt.md"), "# Existing");

      const configInit = new ConfigInit(initFs, "", () => "");
      const result = await configInit.run({
        scope: "project",
        dir: projectDir,
        pluginAgents: [
          {
            pluginId: "myplugin",
            dir: path.join(pluginDir, "agents", "existing"),
            name: "existing",
          },
        ],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.kept).toContainEqual({
          name: "existing",
          reason: "agent directory already exists",
        });
        expect((result.value.seeded ?? []).length).toBe(0);
      }
    });

    it("skips template on invalid agent.json", async () => {
      // Set up plugin template with invalid agent.json
      const templateDir = path.join(pluginDir, "agents", "bad-agent");
      await fs.mkdir(templateDir, { recursive: true });
      await fs.writeFile(
        path.join(templateDir, "agent.json"),
        JSON.stringify({ description: "Missing name" }) // Missing required 'name'
      );
      await fs.writeFile(path.join(templateDir, "prompt.md"), "# Bad");

      const configInit = new ConfigInit(initFs, "", () => "");
      const result = await configInit.run({
        scope: "project",
        dir: projectDir,
        pluginAgents: [
          {
            pluginId: "myplugin",
            dir: path.join(pluginDir, "agents", "bad-agent"),
            name: "bad-agent",
          },
        ],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.kept).toBeDefined();
        expect(result.value.kept?.[0]?.name).toBe("bad-agent");
        expect(result.value.kept?.[0]?.reason).toBeTruthy();
        expect((result.value.seeded ?? []).length).toBe(0);

        // Verify directory was not created
        const agentDir = path.join(projectDir, ".voidrift", "agents", "bad-agent");
        const exists = await fs
          .access(agentDir)
          .then(() => true)
          .catch(() => false);
        expect(exists).toBe(false);
      }
    });

    it("skips template on missing template files", async () => {
      // Create template directory but don't populate files
      const templateDir = path.join(pluginDir, "agents", "incomplete");
      await fs.mkdir(templateDir, { recursive: true });

      const configInit = new ConfigInit(initFs, "", () => "");
      const result = await configInit.run({
        scope: "project",
        dir: projectDir,
        pluginAgents: [
          {
            pluginId: "myplugin",
            dir: path.join(pluginDir, "agents", "incomplete"),
            name: "incomplete",
          },
        ],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.kept).toContainEqual({
          name: "incomplete",
          reason: "template files missing",
        });
      }
    });

    it("does not overwrite existing agent on init", async () => {
      // Create initial agent with custom content
      const agentDir = path.join(projectDir, ".voidrift", "agents", "customized");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "agent.json"),
        JSON.stringify({ name: "customized", description: "User-customized" })
      );
      await fs.writeFile(path.join(agentDir, "prompt.md"), "# User Customized");

      // Run init again with a plugin template of the same name
      const templateDir = path.join(pluginDir, "agents", "customized");
      await fs.mkdir(templateDir, { recursive: true });
      await fs.writeFile(
        path.join(templateDir, "agent.json"),
        JSON.stringify({ name: "customized", description: "Plugin version" })
      );
      await fs.writeFile(path.join(templateDir, "prompt.md"), "# Plugin version");

      const configInit = new ConfigInit(initFs, "", () => "");
      const result = await configInit.run({
        scope: "project",
        dir: projectDir,
        pluginAgents: [
          {
            pluginId: "myplugin",
            dir: path.join(pluginDir, "agents", "customized"),
            name: "customized",
          },
        ],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.kept).toContainEqual({
          name: "customized",
          reason: "agent directory already exists",
        });

        // Verify original file was not touched
        const agentJson = await fs.readFile(path.join(agentDir, "agent.json"), "utf-8");
        expect(JSON.parse(agentJson).description).toBe("User-customized");
      }
    });

    it("copies multiple templates from same plugin", async () => {
      // Set up multiple templates
      for (const name of ["agent1", "agent2"]) {
        const templateDir = path.join(pluginDir, "agents", name);
        await fs.mkdir(templateDir, { recursive: true });
        await fs.writeFile(
          path.join(templateDir, "agent.json"),
          JSON.stringify({ name, description: `Test ${name}`, kind: "top-level" })
        );
        await fs.writeFile(path.join(templateDir, "prompt.md"), `# ${name}`);
      }

      const configInit = new ConfigInit(initFs, "", () => "");
      const result = await configInit.run({
        scope: "project",
        dir: projectDir,
        pluginAgents: [
          {
            pluginId: "myplugin",
            dir: path.join(pluginDir, "agents", "agent1"),
            name: "agent1",
          },
          {
            pluginId: "myplugin",
            dir: path.join(pluginDir, "agents", "agent2"),
            name: "agent2",
          },
        ],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.seeded).toContain("agent1");
        expect(result.value.seeded).toContain("agent2");
      }
    });

    it("skips template with symlinked agent.json", async () => {
      // Set up a template with a symlinked agent.json
      const templateDir = path.join(pluginDir, "agents", "symlinked");
      await fs.mkdir(templateDir, { recursive: true });
      
      // Create actual files elsewhere
      const sourceDir = path.join(pluginDir, "sources");
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(
        path.join(sourceDir, "real-agent.json"),
        JSON.stringify({ name: "symlinked", description: "Test", kind: "top-level" })
      );
      await fs.writeFile(path.join(sourceDir, "real-prompt.md"), "# Symlinked");
      
      // Create symlinks in the template directory
      await fs.symlink(
        path.join(sourceDir, "real-agent.json"),
        path.join(templateDir, "agent.json")
      );
      await fs.writeFile(path.join(templateDir, "prompt.md"), "# Symlinked");

      const configInit = new ConfigInit(initFs, "", () => "");
      const result = await configInit.run({
        scope: "project",
        dir: projectDir,
        pluginAgents: [
          {
            pluginId: "myplugin",
            dir: templateDir,
            name: "symlinked",
          },
        ],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.kept).toContainEqual({
          name: "symlinked",
          reason: "template files contain symlinks",
        });
        expect((result.value.seeded ?? []).length).toBe(0);
      }
    });
  });

  describe("mutation checks", () => {
    it("breaks if we overwrite existing agent on collision", async () => {
      // This test verifies that the no-overwrite rule is actually enforced
      const existingDir = path.join(projectDir, ".voidrift", "agents", "protected");
      await fs.mkdir(existingDir, { recursive: true });
      const origContent = "ORIGINAL CONTENT";
      await fs.writeFile(path.join(existingDir, "agent.json"), origContent);

      const templateDir = path.join(pluginDir, "agents", "protected");
      await fs.mkdir(templateDir, { recursive: true });
      await fs.writeFile(
        path.join(templateDir, "agent.json"),
        JSON.stringify({ name: "protected", description: "Override attempt", kind: "top-level" })
      );
      await fs.writeFile(path.join(templateDir, "prompt.md"), "# Override");

      const configInit = new ConfigInit(initFs, "", () => "");
      const result = await configInit.run({
        scope: "project",
        dir: projectDir,
        pluginAgents: [
          {
            pluginId: "myplugin",
            dir: path.join(pluginDir, "agents", "protected"),
            name: "protected",
          },
        ],
      });

      // Verify it was skipped
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.kept).toBeDefined();
        expect(result.value.kept?.[0]?.name).toBe("protected");
      }

      // Verify original file is untouched
      const fileContent = await fs.readFile(path.join(existingDir, "agent.json"), "utf-8");
      expect(fileContent).toBe(origContent);
    });

    it("breaks if disabled plugin templates are still in registry", () => {
      const registry = new AgentTemplatesRegistry();
      const t1: PluginAgentTemplate = {
        pluginId: "plugin1",
        dir: "/path",
        name: "agent1",
      };

      registry.register(t1);
      expect(registry.getForPlugin("plugin1")).toHaveLength(1);

      // This test fails if unregisterPlugin doesn't actually remove templates
      registry.unregisterPlugin("plugin1");
      expect(registry.getForPlugin("plugin1")).toHaveLength(0);
      expect(registry.getAll()).toHaveLength(0);
    });
  });
});
