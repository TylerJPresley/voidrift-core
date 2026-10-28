/**
 * Registration-only CoreServices for plugin discovery (§12.4, §13.9.1).
 * Used by discoverPluginAgentTemplates to collect register.agents templates
 * without booting a full core — no model, network, engine, MCP, or session.
 *
 * Every member is a harmless no-op except registerPluginAgents/unregisterPluginAgents,
 * which collect agent templates using the same logic boot's services use.
 */

import type { CoreServices, WorkspaceSurface } from "./use-cases/plugins.js";
import type { PluginAgentTemplate } from "./use-cases/config-init.js";
import { scanAgentTemplates } from "./adapters/agent-template-scan.js";

/**
 * Create CoreServices for plugin discovery that collects agent templates.
 * @param onTemplatesDiscovered - Called with discovered templates as they are registered
 * @param onError - Called with error messages (e.g., symlink escapes, scan failures)
 */
export function makeDiscoveryCoreServices(
  onTemplatesDiscovered: (template: PluginAgentTemplate) => void,
  onError: (pluginId: string, message: string) => void,
): CoreServices {
  const noop = (): void => {};

  const fakeWorkspace: WorkspaceSurface = {
    files: async () => [],
    readText: async () => null,
    currentInput: () => "",
    focusPaths: () => [],
    cacheDir: () => {
      throw new Error("workspace is not available during plugin discovery");
    },
    hashFor: () => null,
    pluginFiles: {
      list: async () => [],
      read: async () => null,
      write: async () => {},
      remove: async () => {},
    },
  };

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
    registerDataset: () => "datasets.x",
    unregisterDataset: noop,
    registerAgent: noop,
    registerGuardrail: noop,
    registerScope: () => "scope:0",
    unregisterScope: noop,
    unregisterScopeKey: noop,
    registerExpectation: noop,
    clearExpectation: noop,
    closeExpectation: noop,
    registerChunker: () => "chunker:0",
    unregisterChunker: noop,
    registerPluginDocs: async () => {},
    unregisterPluginDocs: noop,
    // The key service: collect agent templates via the same scan logic boot uses
    registerPluginAgents: async (pluginId, dir, pluginRealPath) => {
      const templates = await scanAgentTemplates(
        pluginId,
        dir,
        pluginRealPath,
        (message) => onError(pluginId, message),
      );
      for (const template of templates) {
        onTemplatesDiscovered(template);
      }
    },
    unregisterPluginAgents: noop,
    runInNewSession: async () => ({ status: "completed" }),
    workspace: fakeWorkspace,
  };
}
