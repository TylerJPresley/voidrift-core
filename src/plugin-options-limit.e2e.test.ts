import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { hermeticTmp } from "./test-hermetic.js";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { createCore } from "./boot.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
import { seededPermissionsRecord } from "./test-support/seed-rules.js";
import type { ResolvedModel } from "./entities/ports/model-port.js";
import type { ModelConfigEntry } from "./config/schema.js";

describe("plugin options size limit enforcement (§12.4, §13.11)", () => {
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
    ws = hermeticTmp("plugin-options-limit-e2e");
    globalHome = hermeticTmp("xdg-plugin-options-limit");
    prevXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = globalHome;
  });

  afterEach(async () => {
    if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = prevXdg;
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(globalHome, { recursive: true, force: true });
  });

  it("(1) DEFAULT config, 100 KiB options: plugin loads, seen.json exists with full options", async () => {
    const big = "x".repeat(100_000);
    const pluginDir = await writePkg(
      ws,
      "testplugin",
      {
        name: "testplugin",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true },
      },
      // Plugin receives full options and writes seen.json with byte count
      `import fs from "node:fs";
import path from "node:path";

export async function register(core, options) {
  const wsPath = ${JSON.stringify(ws)};
  const seenPath = path.join(wsPath, "seen.json");
  const bytes = JSON.stringify(options).length;
  fs.writeFileSync(seenPath, JSON.stringify({ bytes }));
}`,
    );

    const sessions = new InMemorySessionRepository();
    const config = { ...seed, plugins: { testplugin: { enabled: true, path: pluginDir, options: { blob: big } } } };

    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(config),
      sessionRepository: sessions,
      chatModelFactory: fakeFactory(() => fakeModel().respond(new AIMessage("ok"))),
      installSignalHandlers: false,
    });

    // Poll for seen.json to appear (plugin async load)
    const startTime = Date.now();
    const timeoutMs = 3000;
    let seenExists = false;
    while (Date.now() - startTime < timeoutMs) {
      if (existsSync(path.join(ws, "seen.json"))) {
        seenExists = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(seenExists).toBe(true);
    const seen = JSON.parse(await fs.readFile(path.join(ws, "seen.json"), "utf8"));
    // Verify the plugin received the full 100 KiB options (warn action allows it)
    expect(seen.bytes).toBeGreaterThanOrEqual(100_000);

    // Verify the plugin is marked active
    const pluginListResult = await api.plugins.list();
    expect(pluginListResult.ok).toBe(true);
    const pluginList = pluginListResult.ok ? pluginListResult.value : [];
    const testPlugin = pluginList.find((p) => p.id === "testplugin");
    expect(testPlugin).toBeDefined();
    expect(testPlugin?.active).toBe(true);

    await api.session.shutdown();
  });

  it("(2) deny action, 100 KiB options: plugin does NOT load, seen.json absent, load failure observable", async () => {
    const big = "x".repeat(100_000);
    const pluginDir = await writePkg(
      ws,
      "testplugin",
      {
        name: "testplugin",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true },
      },
      // Plugin would write seen.json if it runs
      `import fs from "node:fs";
import path from "node:path";

export async function register(core, options) {
  const wsPath = ${JSON.stringify(ws)};
  const seenPath = path.join(wsPath, "seen.json");
  const bytes = JSON.stringify(options).length;
  fs.writeFileSync(seenPath, JSON.stringify({ bytes }));
}`,
    );

    const sessions = new InMemorySessionRepository();
    const config = {
      ...seed,
      plugins: { testplugin: { enabled: true, path: pluginDir, options: { blob: big } } },
      limits: { plugins: { optionsMaxBytes: { value: 65536, action: "deny" as const } } },
    };

    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(config),
      sessionRepository: sessions,
      chatModelFactory: fakeFactory(() => fakeModel().respond(new AIMessage("ok"))),
      installSignalHandlers: false,
    });

    // Wait for plugin load to complete (or fail)
    await new Promise((r) => setTimeout(r, 500));

    // seen.json should NOT exist (plugin didn't run)
    const seenPath = path.join(ws, "seen.json");
    let seenExists = false;
    const startTime = Date.now();
    while (Date.now() - startTime < 1500) {
      if (existsSync(seenPath)) {
        seenExists = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(seenExists).toBe(false);

    // Verify the plugin is in the list but marked inactive (not loaded)
    const pluginListResult = await api.plugins.list();
    expect(pluginListResult.ok).toBe(true);
    const pluginList = pluginListResult.ok ? pluginListResult.value : [];
    const testPlugin = pluginList.find((p) => p.id === "testplugin");
    expect(testPlugin).toBeDefined();
    expect(testPlugin?.active).toBe(false);

    await api.session.shutdown();
  });

  it("(3) deny action, 20 KiB options: plugin loads normally", async () => {
    const small = "x".repeat(20_000);
    const pluginDir = await writePkg(
      ws,
      "testplugin",
      {
        name: "testplugin",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true },
      },
      // Plugin writes seen.json if it runs
      `import fs from "node:fs";
import path from "node:path";

export async function register(core, options) {
  const wsPath = ${JSON.stringify(ws)};
  const seenPath = path.join(wsPath, "seen.json");
  const bytes = JSON.stringify(options).length;
  fs.writeFileSync(seenPath, JSON.stringify({ bytes }));
}`,
    );

    const sessions = new InMemorySessionRepository();
    const config = {
      ...seed,
      plugins: { testplugin: { enabled: true, path: pluginDir, options: { blob: small } } },
      limits: { plugins: { optionsMaxBytes: { value: 65536, action: "deny" as const } } },
    };

    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(config),
      sessionRepository: sessions,
      chatModelFactory: fakeFactory(() => fakeModel().respond(new AIMessage("ok"))),
      installSignalHandlers: false,
    });

    // Poll for seen.json to appear
    const startTime = Date.now();
    const timeoutMs = 3000;
    let seenExists = false;
    while (Date.now() - startTime < timeoutMs) {
      if (existsSync(path.join(ws, "seen.json"))) {
        seenExists = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(seenExists).toBe(true);
    const seen = JSON.parse(await fs.readFile(path.join(ws, "seen.json"), "utf8"));
    expect(seen.bytes).toBeGreaterThanOrEqual(20_000);

    // Verify the plugin is marked active
    const pluginListResult = await api.plugins.list();
    expect(pluginListResult.ok).toBe(true);
    const pluginList = pluginListResult.ok ? pluginListResult.value : [];
    const testPlugin = pluginList.find((p) => p.id === "testplugin");
    expect(testPlugin).toBeDefined();
    expect(testPlugin?.active).toBe(true);

    await api.session.shutdown();
  });
});
