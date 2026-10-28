/**
 * Agent templates registry (core-blueprint.md §12.4, §13.9.1).
 *
 * Tracks plugin-registered agent templates by plugin id for discovery during
 * `config.init` and for cleanup on plugin disable. Templates are layout
 * `<dir>/<name>/{agent.json,prompt.md}` and are never runtime agents;
 * `config.init` copies enabled templates to the project.
 */

export interface AgentTemplate {
  pluginId: string;
  /** Absolute filesystem path to the template directory. */
  dir: string;
  /** Template name (lowercase slug, from directory name). */
  name: string;
}

export class AgentTemplatesRegistry {
  /** Templates keyed by plugin id; multiple templates per plugin. */
  private readonly templates = new Map<string, Set<AgentTemplate>>();

  /**
   * Register a template directory from a plugin (§12.4). The caller must have
   * already validated confinement (symlinks within the package). Returns false
   * if a duplicate is found (e.g., same plugin registering twice).
   */
  register(template: AgentTemplate): boolean {
    if (!this.templates.has(template.pluginId)) {
      this.templates.set(template.pluginId, new Set());
    }
    // Check for duplicate
    const existing = Array.from(this.templates.get(template.pluginId)!).find(
      (t) => t.dir === template.dir && t.name === template.name
    );
    if (existing) {
      return false; // already registered
    }
    this.templates.get(template.pluginId)!.add(template);
    return true;
  }

  /** Get all templates from a plugin. */
  getForPlugin(pluginId: string): AgentTemplate[] {
    return Array.from(this.templates.get(pluginId) ?? []);
  }

  /** Get all registered templates (across all plugins). */
  getAll(): AgentTemplate[] {
    const all: AgentTemplate[] = [];
    for (const templates of this.templates.values()) {
      all.push(...templates);
    }
    return all;
  }

  /** Remove all templates from a plugin (§12.4, teardown on disable). */
  unregisterPlugin(pluginId: string): void {
    this.templates.delete(pluginId);
  }
}
