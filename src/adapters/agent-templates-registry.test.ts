/**
 * Tests for agent templates registry (§12.4, §13.9.1).
 */
import { describe, it, expect } from "vitest";
import { AgentTemplatesRegistry, type AgentTemplate } from "./agent-templates-registry.js";

describe("AgentTemplatesRegistry", () => {
  it("registers a template and retrieves it", () => {
    const registry = new AgentTemplatesRegistry();
    const template: AgentTemplate = {
      pluginId: "myplugin",
      dir: "/path/to/plugin/agents",
      name: "custom-agent",
    };

    const registered = registry.register(template);
    expect(registered).toBe(true);
    const templates = registry.getForPlugin("myplugin");
    expect(templates).toHaveLength(1);
    expect(templates[0]).toEqual(template);
  });

  it("rejects duplicate template registration", () => {
    const registry = new AgentTemplatesRegistry();
    const template: AgentTemplate = {
      pluginId: "myplugin",
      dir: "/path/to/plugin/agents",
      name: "custom-agent",
    };

    expect(registry.register(template)).toBe(true);
    expect(registry.register(template)).toBe(false);
  });

  it("allows multiple templates from the same plugin", () => {
    const registry = new AgentTemplatesRegistry();
    const t1: AgentTemplate = {
      pluginId: "myplugin",
      dir: "/path/to/plugin/agents",
      name: "agent1",
    };
    const t2: AgentTemplate = {
      pluginId: "myplugin",
      dir: "/path/to/plugin/agents",
      name: "agent2",
    };

    registry.register(t1);
    registry.register(t2);
    const templates = registry.getForPlugin("myplugin");
    expect(templates).toHaveLength(2);
  });

  it("returns all templates across plugins", () => {
    const registry = new AgentTemplatesRegistry();
    const t1: AgentTemplate = {
      pluginId: "plugin1",
      dir: "/path1",
      name: "agent1",
    };
    const t2: AgentTemplate = {
      pluginId: "plugin2",
      dir: "/path2",
      name: "agent2",
    };

    registry.register(t1);
    registry.register(t2);
    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all).toContainEqual(t1);
    expect(all).toContainEqual(t2);
  });

  it("unregisters all templates from a plugin", () => {
    const registry = new AgentTemplatesRegistry();
    const t1: AgentTemplate = {
      pluginId: "myplugin",
      dir: "/path",
      name: "agent1",
    };
    const t2: AgentTemplate = {
      pluginId: "myplugin",
      dir: "/path",
      name: "agent2",
    };

    registry.register(t1);
    registry.register(t2);
    expect(registry.getForPlugin("myplugin")).toHaveLength(2);

    registry.unregisterPlugin("myplugin");
    expect(registry.getForPlugin("myplugin")).toHaveLength(0);
    expect(registry.getAll()).toHaveLength(0);
  });

  it("returns empty list for unknown plugin", () => {
    const registry = new AgentTemplatesRegistry();
    expect(registry.getForPlugin("unknown")).toHaveLength(0);
  });
});
