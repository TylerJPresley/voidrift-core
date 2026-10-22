import { describe, it, expect } from "vitest";
import { SkillRegistry } from "./skill-registry.js";
import type { Skill } from "./skill.js";

function skill(name: string, source: Skill["source"], description = `${name} desc`, body = `${name} body`): Skill {
  return { name, description, body, source, frontmatter: { name, description, allowedTools: [] } };
}

describe("SkillRegistry (§12.1)", () => {
  it("cascades project over global over builtin by name", () => {
    const r = new SkillRegistry();
    r.reindex(
      { builtin: [skill("a", "builtin", "builtin a")], global: [skill("a", "global", "global a")], project: [skill("a", "project", "project a")] },
      [],
    );
    expect(r.get("a")!.description).toBe("project a");
    expect(r.get("a")!.source).toBe("project");
  });

  it("scopes the index to a non-empty allowlist uniformly across sources", () => {
    const r = new SkillRegistry();
    r.reindex(
      { builtin: [skill("keep", "builtin")], global: [skill("drop", "global")], project: [skill("also", "project")] },
      ["keep", "also"],
    );
    expect(r.list().map((s) => s.name)).toEqual(["also", "keep"]);
  });

  it("surfaces name + description only in the index manifest", () => {
    const r = new SkillRegistry();
    r.reindex({ builtin: [skill("a", "builtin", "A desc", "SECRET BODY")], global: [], project: [] }, []);
    const lines = r.indexLines();
    expect(lines).toEqual([{ name: "a", description: "A desc" }]);
    expect(JSON.stringify(lines)).not.toContain("SECRET BODY");
  });

  it("load is idempotent, ignores unknown, and renders the loaded body", () => {
    const r = new SkillRegistry();
    r.reindex({ builtin: [skill("a", "builtin")], global: [], project: [] }, []);
    expect(r.load("a")).toBe(true);
    expect(r.load("a")).toBe(false); // idempotent
    expect(r.load("unknown")).toBe(false); // unknown ignored
    expect(r.loadedBodies()).toEqual(["### a\na body"]);
  });

  it("reindex drops loaded names no longer resolved", () => {
    const r = new SkillRegistry();
    r.reindex({ builtin: [skill("a", "builtin")], global: [], project: [] }, []);
    r.load("a");
    const dropped = r.reindex({ builtin: [], global: [], project: [] }, []);
    expect(dropped).toEqual(["a"]);
    expect(r.loadedNames()).toEqual([]);
  });
});
