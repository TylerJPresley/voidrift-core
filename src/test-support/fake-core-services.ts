/**
 * Shared typed fake CoreServices for plugin tests (§12.4, §9.5).
 * Implements the CURRENT CoreServices interface from use-cases/plugins.ts.
 * Extend per-test by passing custom overrides.
 */
import type { CoreServices, WorkspaceSurface } from "../use-cases/plugins.js";

export function fakeCoreServices(overrides?: Partial<CoreServices>): CoreServices {
  const noop = (): void => {};

  const fakeWorkspace: WorkspaceSurface = {
    files: async () => [],
    readText: async () => null,
    currentInput: () => "",
    focusPaths: () => [],
    cacheDir: () => "/tmp/cache",
    hashFor: () => null,
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
    runInNewSession: async () => ({ status: "completed" }),
    workspace: fakeWorkspace,
    ...overrides,
  };
}
