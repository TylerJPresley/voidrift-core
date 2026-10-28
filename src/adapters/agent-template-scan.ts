/**
 * Scans a directory for agent templates and returns their metadata.
 * Used by both boot's registerPluginAgents and discoverPluginAgentTemplates (§12.4).
 *
 * Validates each template name against the lowercase slug rule, resolves symlinks
 * safely, and reports errors via the callback.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { resolveInside } from "./docs-confine.js";

export interface PluginAgentTemplate {
  pluginId: string;
  name: string;
  dir: string;
}

/**
 * Scan a plugin's agents directory and yield template metadata.
 *
 * @param pluginId - The id of the plugin (used for attribution)
 * @param dir - The agents directory path (relative to pluginRealPath)
 * @param pluginRealPath - The real (resolved) path to the plugin
 * @param emitError - Callback to report non-fatal errors (invalid names, scan failures)
 * @returns Array of discovered templates
 */
export async function scanAgentTemplates(
  pluginId: string,
  dir: string,
  pluginRealPath: string,
  emitError: (message: string) => void,
): Promise<PluginAgentTemplate[]> {
  // Use resolveInside to safely confine the agents path
  const realAgentsPath = await resolveInside(pluginRealPath, dir);

  if (realAgentsPath === null) {
    // Confinement check failed: path traversal, absolute path, nonexistent, or symlink outside
    emitError(`plugin agents path is outside plugin directory or invalid: ${dir}`);
    return [];
  }

  const templates: PluginAgentTemplate[] = [];

  // Scan the directory for agent templates: <realAgentsPath>/<name>/{agent.json,prompt.md}
  try {
    const entries = await fs.readdir(realAgentsPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Validate name is a lowercase slug (no automatic lowercasing)
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.name)) {
        emitError(`agent template "${entry.name}" is not a lowercase slug`);
        continue;
      }

      const templatePath = path.join(realAgentsPath, entry.name);
      templates.push({
        pluginId,
        dir: templatePath,
        name: entry.name,
      });
    }
  } catch (e) {
    emitError(`agents scan failed: ${String(e)}`);
  }

  return templates;
}
