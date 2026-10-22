import { describe, it, expect, beforeEach } from "vitest";
import { Prompts } from "./prompts.js";
import { PromptsDirectory } from "../adapters/prompts-directory.js";
import { InMemoryFileSystem } from "../adapters/in-memory-filesystem.js";
import { EventBus } from "../entities/event-bus.js";

function make() {
  const fs = new InMemoryFileSystem();
  const bus = new EventBus();
  bus.register("RESOURCE_CHANGED");
  const directory = new PromptsDirectory(fs, { workspace: ".voidrift/prompts", global: "global/prompts" });
  const prompts = new Prompts({ bus, directory });
  return { fs, bus, directory, prompts };
}

describe("Prompts capability (§12.2)", () => {
  let env: ReturnType<typeof make>;
  beforeEach(async () => {
    env = make();
    await env.prompts.init();
  });

  it("resolves builtins and lists them", async () => {
    const list = env.prompts.list();
    const keys = list.map((p) => p.key);
    expect(keys).toContain("core.rules");
    expect(keys).toContain("compact");
    expect(env.prompts.get("core.rules").level).toBe("builtin");
  });

  it("resolves workspace > global > plugin > builtin", async () => {
    env.prompts.register("core.rules", "PLUGIN");
    expect(env.prompts.get("core.rules")).toMatchObject({ level: "plugin", content: "PLUGIN" });
    await env.fs.writeFile("global/prompts/core.rules.md", "GLOBAL");
    await env.prompts.onWatchedChange("core.rules");
    expect(env.prompts.get("core.rules")).toMatchObject({ level: "global", content: "GLOBAL" });
    await env.fs.writeFile(".voidrift/prompts/core.rules.md", "WORKSPACE");
    await env.prompts.onWatchedChange("core.rules");
    expect(env.prompts.get("core.rules")).toMatchObject({ level: "workspace", content: "WORKSPACE" });
  });

  it("override scaffolds a file seeded with the resolved content; resetOverride round-trips", async () => {
    const before = env.prompts.get("core.rules").content;
    const ov = await env.prompts.override("core.rules", "workspace");
    expect(ov.ok).toBe(true);
    expect(await env.fs.readFile(".voidrift/prompts/core.rules.md")).toBe(before);
    if (ov.ok) expect(ov.value.level).toBe("workspace");

    const reset = await env.prompts.resetOverride("core.rules");
    expect(reset.ok).toBe(true);
    if (reset.ok) expect(reset.value.level).toBe("builtin");
    expect(await env.fs.exists(".voidrift/prompts/core.rules.md")).toBe(false);
  });

  it("onWatchedChange emits RESOURCE_CHANGED and invalidates the cache", async () => {
    const seen: unknown[] = [];
    env.bus.subscribe("RESOURCE_CHANGED", (e) => seen.push(e.payload));
    await env.prompts.onWatchedChange("core.rules");
    expect(seen).toContainEqual({ type: "prompt" });
  });

  it("a plugin registration appears in list and extend/override/removePlugin apply", async () => {
    env.prompts.register("plugin.only", "P-BASE");
    expect(env.prompts.list().map((p) => p.key)).toContain("plugin.only");
    env.prompts.extendPrompt("plugin.only", "MORE");
    expect(env.prompts.get("plugin.only").content).toContain("MORE");
    env.prompts.overridePrompt("plugin.only", "REPLACED");
    expect(env.prompts.get("plugin.only").content).toBe("REPLACED");
    env.prompts.removePlugin("plugin.only");
    expect(env.prompts.get("plugin.only").content).toBe("");
  });
});
