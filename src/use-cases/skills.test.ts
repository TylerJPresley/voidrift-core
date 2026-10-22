import { describe, it, expect, beforeEach } from "vitest";
import { Skills } from "./skills.js";
import { SkillsDirectory } from "../adapters/skills-directory.js";
import { InMemoryFileSystem } from "../adapters/in-memory-filesystem.js";
import { EventBus } from "../entities/event-bus.js";
import { ToolRegistry } from "../entities/tool-registry.js";

function skillMd(name: string, description: string, body = "do the thing", allowedTools?: string): string {
  const tools = allowedTools ? `\nallowed-tools: ${allowedTools}` : "";
  return `---\nname: ${name}\ndescription: ${description}${tools}\n---\n\n${body}`;
}

function make(allowlist: string[] = []) {
  const fs = new InMemoryFileSystem();
  const bus = new EventBus();
  for (const t of ["SKILL_LOADED", "RESOURCE_CHANGED"]) bus.register(t);
  const toolRegistry = new ToolRegistry();
  const directory = new SkillsDirectory(fs, { workspace: ".voidrift/skills", global: "global/skills" });
  const skills = new Skills({ bus, directory, getAllowlist: () => allowlist, toolRegistry });
  return { fs, bus, toolRegistry, directory, skills };
}

describe("Skills capability (§12.1)", () => {
  let env: ReturnType<typeof make>;
  beforeEach(() => {
    env = make();
  });

  it("indexes a valid SKILL.md to name + description only; skips a malformed one", async () => {
    await env.fs.writeFile(".voidrift/skills/deploy/SKILL.md", skillMd("deploy", "Deploy prod."));
    await env.fs.writeFile(".voidrift/skills/broken/SKILL.md", "no frontmatter");
    await env.skills.reindex();
    expect(env.skills.indexLines()).toEqual([{ name: "deploy", description: "Deploy prod." }]);
  });

  it("workspace overrides global of the same name", async () => {
    await env.fs.writeFile("global/skills/deploy/SKILL.md", skillMd("deploy", "GLOBAL"));
    await env.fs.writeFile(".voidrift/skills/deploy/SKILL.md", skillMd("deploy", "WORKSPACE"));
    await env.skills.reindex();
    expect(env.skills.list()[0]!.source).toBe("project");
    expect(env.skills.indexLines()[0]!.description).toBe("WORKSPACE");
  });

  it("load_skill tool activates a skill, emits SKILL_LOADED, and renders the body", async () => {
    await env.fs.writeFile(".voidrift/skills/deploy/SKILL.md", skillMd("deploy", "Deploy prod.", "RUN DEPLOY"));
    await env.skills.reindex();
    const events: unknown[] = [];
    env.bus.subscribe("SKILL_LOADED", (e) => events.push(e.payload));
    const exec = env.toolRegistry.getExecutor("load_skill")!;
    const res = await exec({ name: "deploy" }, { workspaceRoot: ".", sessionId: "s" });
    expect(res.content).toContain("RUN DEPLOY");
    expect(events).toEqual([{ name: "deploy" }]);
    expect(env.skills.loadedBodies()).toEqual(["### deploy\nRUN DEPLOY"]);
  });

  it("allowed-tools is surfaced in the DTO but is advisory only", async () => {
    await env.fs.writeFile(".voidrift/skills/deploy/SKILL.md", skillMd("deploy", "d", "b", "execute_command"));
    await env.skills.reindex();
    expect(env.skills.list()[0]!.allowedTools).toEqual(["execute_command"]);
  });

  it("config.skills scopes the index to the allowlist", async () => {
    env = make(["keep"]);
    await env.fs.writeFile(".voidrift/skills/keep/SKILL.md", skillMd("keep", "k"));
    await env.fs.writeFile(".voidrift/skills/drop/SKILL.md", skillMd("drop", "d"));
    await env.skills.reindex();
    expect(env.skills.list().map((s) => s.name)).toEqual(["keep"]);
  });

  it("create scaffolds a SKILL.md, reindexes, and emits RESOURCE_CHANGED", async () => {
    const changed: unknown[] = [];
    env.bus.subscribe("RESOURCE_CHANGED", (e) => changed.push(e.payload));
    const res = await env.skills.create("new-skill", "project");
    expect(res.ok).toBe(true);
    expect(await env.fs.exists(".voidrift/skills/new-skill/SKILL.md")).toBe(true);
    expect(changed).toContainEqual({ type: "skill" });
  });

  it("delete and rename reject a builtin", async () => {
    env.skills.registerBuiltin(skillMd("core-skill", "builtin skill"), "core-skill");
    await env.skills.reindex();
    expect((await env.skills.delete("core-skill", "project")).ok).toBe(false);
    expect((await env.skills.rename("core-skill", "x", "project")).ok).toBe(false);
  });

  it("override seeds a workspace copy from a builtin", async () => {
    env.skills.registerBuiltin(skillMd("base", "builtin base", "BUILTIN BODY"), "base");
    await env.skills.reindex();
    const res = await env.skills.override("base", "project");
    expect(res.ok).toBe(true);
    expect(await env.fs.exists(".voidrift/skills/base/SKILL.md")).toBe(true);
    expect(env.skills.list()[0]!.source).toBe("project");
  });

  it("override of a builtin with allowed-tools serializes the frontmatter", async () => {
    env.skills.registerBuiltin(skillMd("base", "d", "BODY", "write_file execute_command"), "base");
    await env.skills.reindex();
    await env.skills.override("base", "global");
    const raw = await env.directory.read("base", "global");
    expect(raw).toContain("allowed-tools: write_file execute_command");
    expect(raw).toContain("BODY");
  });

  it("rename moves a workspace skill and re-indexes under the new name", async () => {
    await env.fs.writeFile(".voidrift/skills/old/SKILL.md", skillMd("old", "d"));
    await env.skills.reindex();
    const res = await env.skills.rename("old", "new", "project");
    expect(res.ok).toBe(true);
    expect(env.skills.list().map((s) => s.name)).toEqual(["new"]);
    expect(await env.fs.exists(".voidrift/skills/old/SKILL.md")).toBe(false);
  });

  it("delete removes a workspace skill and re-indexes", async () => {
    await env.fs.writeFile(".voidrift/skills/gone/SKILL.md", skillMd("gone", "d"));
    await env.skills.reindex();
    const res = await env.skills.delete("gone", "project");
    expect(res.ok).toBe(true);
    expect(env.skills.list()).toEqual([]);
  });

  it("rejects an invalid create name and a missing-source rename/delete/override", async () => {
    expect((await env.skills.create("Bad Name", "project")).ok).toBe(false);
    expect((await env.skills.rename("missing", "x", "project")).ok).toBe(false);
    expect((await env.skills.delete("missing", "project")).ok).toBe(false);
    expect((await env.skills.override("missing", "project")).ok).toBe(false);
  });

  it("registerBuiltin rejects a malformed skill", () => {
    expect(env.skills.registerBuiltin("not a skill", "x").ok).toBe(false);
  });

  it("unload drops a loaded name from the Void layer", async () => {
    await env.fs.writeFile(".voidrift/skills/deploy/SKILL.md", skillMd("deploy", "d", "BODY"));
    await env.skills.reindex();
    env.skills.load("deploy");
    expect(env.skills.loadedBodies().length).toBe(1);
    env.skills.unload("deploy");
    expect(env.skills.loadedBodies()).toEqual([]);
  });

  it("list_skills tool renders the index and reports none when empty", async () => {
    const listExec = env.toolRegistry.getExecutor("list_skills")!;
    const empty = await listExec({}, { workspaceRoot: ".", sessionId: "s" });
    expect(empty.content).toBe("No skills available.");
    await env.fs.writeFile(".voidrift/skills/deploy/SKILL.md", skillMd("deploy", "Deploy."));
    await env.skills.reindex();
    const full = await listExec({}, { workspaceRoot: ".", sessionId: "s" });
    expect(full.content).toContain("## Available Skills");
    expect(full.content).toContain("- deploy: Deploy.");
  });
});
