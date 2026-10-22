import { describe, it, expect } from "vitest";
import { PromptRegistry, BUILTIN_PROMPTS } from "./prompt-registry.js";
import type { PromptOverrides } from "./prompt-registry.js";

describe("PromptRegistry (§12.2)", () => {
  it("resolves the builtin default when no override or plugin is present", () => {
    const r = new PromptRegistry(() => ({}));
    expect(r.resolve("core.rules").level).toBe("builtin");
    expect(r.resolve("core.rules").content).toBe(BUILTIN_PROMPTS["core.rules"]);
  });

  it("resolves highest-wins: workspace > global > plugin > builtin", () => {
    const overrides: Record<string, PromptOverrides> = {};
    const r = new PromptRegistry((k) => overrides[k] ?? {});
    // plugin over builtin
    r.register("core.rules", "PLUGIN");
    expect(r.resolve("core.rules")).toMatchObject({ level: "plugin", content: "PLUGIN" });
    // global over plugin
    overrides["core.rules"] = { global: "GLOBAL" };
    r.invalidate("core.rules");
    expect(r.resolve("core.rules")).toMatchObject({ level: "global", content: "GLOBAL" });
    // workspace over global
    overrides["core.rules"] = { global: "GLOBAL", workspace: "WORKSPACE" };
    r.invalidate("core.rules");
    expect(r.resolve("core.rules")).toMatchObject({ level: "workspace", content: "WORKSPACE" });
  });

  it("caches resolution until invalidated", () => {
    let reads = 0;
    const r = new PromptRegistry(() => {
      reads++;
      return {};
    });
    r.resolve("core.rules");
    r.resolve("core.rules");
    expect(reads).toBe(1);
    r.invalidate("core.rules");
    r.resolve("core.rules");
    expect(reads).toBe(2);
  });

  it("extendPrompt joins with a blank line over the base", () => {
    const r = new PromptRegistry(() => ({}));
    r.extend("core.rules", "EXTRA RULE");
    const resolved = r.resolve("core.rules");
    expect(resolved.level).toBe("plugin");
    expect(resolved.content).toContain(BUILTIN_PROMPTS["core.rules"]);
    expect(resolved.content).toContain("\n\nEXTRA RULE");
  });

  it("removePlugin reverts to builtin", () => {
    const r = new PromptRegistry(() => ({}));
    r.register("core.rules", "PLUGIN");
    r.removePlugin("core.rules");
    expect(r.resolve("core.rules").level).toBe("builtin");
  });
});
