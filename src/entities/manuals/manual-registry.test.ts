import { describe, it, expect } from "vitest";
import { ManualRegistry } from "./manual-registry.js";
import type { Manual } from "./manual.js";

function manual(
  id: string,
  source: Manual["source"],
  summary = "Test manual",
  readWhen = "anytime",
): Manual {
  return {
    id,
    body: `# ${id}\n\nContent`,
    source,
    frontmatter: { summary, readWhen, type: "reference" },
  };
}

describe("ManualRegistry (§12.8)", () => {
  it("stores manuals by id and returns them", () => {
    const r = new ManualRegistry();
    const m = manual("core/intro", "builtin");
    r.register(m);
    expect(r.get("core/intro")).toEqual(m);
  });

  it("enforces append-only: rejects duplicate ids", () => {
    const r = new ManualRegistry();
    r.register(manual("core/intro", "builtin"));
    expect(() => r.register(manual("core/intro", "builtin"))).toThrow(
      /already registered/,
    );
  });

  it("allows different namespaces to coexist without shadowing", () => {
    const r = new ManualRegistry();
    const coreIntro = manual("core/intro", "builtin", "Core intro");
    const pluginIntro = manual("plugin-x/intro", "builtin", "Plugin intro");
    r.register(coreIntro);
    r.register(pluginIntro);
    expect(r.get("core/intro")).toEqual(coreIntro);
    expect(r.get("plugin-x/intro")).toEqual(pluginIntro);
  });

  it("lists all registered manuals", () => {
    const r = new ManualRegistry();
    r.register(manual("core/intro", "builtin"));
    r.register(manual("cli/reference", "builtin"));
    const list = r.list();
    expect(list).toHaveLength(2);
    expect(list.map((m) => m.id).sort()).toEqual(["cli/reference", "core/intro"]);
  });

  it("returns undefined for unknown ids", () => {
    const r = new ManualRegistry();
    expect(r.get("unknown/doc")).toBeUndefined();
  });

  it("provides an index of id + summary + type for TOC generation", () => {
    const r = new ManualRegistry();
    r.register(manual("core/intro", "builtin", "Getting started", "before first use"));
    r.register(manual("cli/ref", "builtin", "CLI reference", "when using CLI"));
    const index = r.indexLines();
    expect(index).toEqual([
      { id: "core/intro", summary: "Getting started", type: "reference" },
      { id: "cli/ref", summary: "CLI reference", type: "reference" },
    ]);
  });
});
