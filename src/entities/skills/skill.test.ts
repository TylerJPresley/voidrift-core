import { describe, it, expect } from "vitest";
import { parseSkill, splitFrontmatter, scaffoldSkill, renderLoadedBody, SkillValidationError } from "./skill.js";

const good = `---\nname: deploy\ndescription: Deploy the app to production.\nallowed-tools: execute_command write_file\n---\n\n# Deploy\n\nRun the deploy script.`;

describe("skill entity (§12.1)", () => {
  it("parses valid frontmatter and body, mapping allowed-tools to a list", () => {
    const s = parseSkill(good, "deploy", "project");
    expect(s.name).toBe("deploy");
    expect(s.description).toBe("Deploy the app to production.");
    expect(s.frontmatter.allowedTools).toEqual(["execute_command", "write_file"]);
    expect(s.body).toContain("Run the deploy script.");
    expect(s.source).toBe("project");
  });

  it("splitFrontmatter rejects a file without a frontmatter block", () => {
    expect(() => splitFrontmatter("no frontmatter here")).toThrow(SkillValidationError);
  });

  it("rejects a name that does not match the directory name", () => {
    expect(() => parseSkill(good, "other", "global")).toThrow(/must equal the directory/);
  });

  it("rejects a name that violates the slug pattern", () => {
    const raw = `---\nname: Bad_Name\ndescription: x\n---\nbody`;
    expect(() => parseSkill(raw, "Bad_Name", "project")).toThrow(/must match/);
  });

  it("rejects a missing description", () => {
    const raw = `---\nname: deploy\n---\nbody`;
    expect(() => parseSkill(raw, "deploy", "project")).toThrow(/description is required/);
  });

  it("rejects an over-long compatibility and non-string metadata", () => {
    const longCompat = `---\nname: deploy\ndescription: ok\ncompatibility: ${"x".repeat(501)}\n---\nb`;
    expect(() => parseSkill(longCompat, "deploy", "project")).toThrow(/compatibility/);
    const badMeta = `---\nname: deploy\ndescription: ok\nmetadata:\n  k: [1,2]\n---\nb`;
    expect(() => parseSkill(badMeta, "deploy", "project")).toThrow(/metadata/);
  });

  it("rejects invalid YAML as a validation error", () => {
    const raw = `---\nname: : :\n  - broken\n---\nb`;
    expect(() => parseSkill(raw, "deploy", "project")).toThrow(SkillValidationError);
  });

  it("scaffolds a valid SKILL.md and renders a loaded body", () => {
    const scaffold = scaffoldSkill("my-skill");
    const parsed = parseSkill(scaffold, "my-skill", "project");
    expect(parsed.name).toBe("my-skill");
    expect(renderLoadedBody(parsed)).toMatch(/^### my-skill/);
  });

  it("accepts optional license and compatibility and metadata", () => {
    const raw = `---\nname: deploy\ndescription: ok\nlicense: MIT\ncompatibility: node>=22\nmetadata:\n  team: infra\n---\nbody`;
    const s = parseSkill(raw, "deploy", "builtin");
    expect(s.frontmatter.license).toBe("MIT");
    expect(s.frontmatter.compatibility).toBe("node>=22");
    expect(s.frontmatter.metadata).toEqual({ team: "infra" });
  });
});
