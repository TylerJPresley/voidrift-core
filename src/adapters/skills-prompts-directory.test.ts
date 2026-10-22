import { describe, it, expect } from "vitest";
import { SkillsDirectory } from "./skills-directory.js";
import { PromptsDirectory } from "./prompts-directory.js";
import { InMemoryFileSystem } from "./in-memory-filesystem.js";

describe("SkillsDirectory (§12.1)", () => {
  it("loads valid skills and reports skipped malformed ones", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile(".voidrift/skills/good/SKILL.md", "---\nname: good\ndescription: ok\n---\nbody");
    await fs.writeFile(".voidrift/skills/bad/SKILL.md", "not a skill");
    const dir = new SkillsDirectory(fs, { workspace: ".voidrift/skills", global: "g/skills" });
    const res = await dir.load("project");
    expect(res.skills.map((s) => s.name)).toEqual(["good"]);
    expect(res.skipped.map((s) => s.name)).toEqual(["bad"]);
  });

  it("scaffolds, writes, reads, and removes a skill", async () => {
    const fs = new InMemoryFileSystem();
    const dir = new SkillsDirectory(fs, { workspace: ".voidrift/skills", global: "g/skills" });
    await dir.scaffold("deploy", "project");
    expect(await dir.exists("deploy", "project")).toBe(true);
    const raw = await dir.read("deploy", "project");
    expect(raw).toContain("name: deploy");
    expect(await dir.remove("deploy", "project")).toBe(true);
    expect(await dir.exists("deploy", "project")).toBe(false);
  });
});

describe("PromptsDirectory (§12.2)", () => {
  it("reads only present override levels", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile(".voidrift/prompts/chat.md", "WS");
    const dir = new PromptsDirectory(fs, { workspace: ".voidrift/prompts", global: "g/prompts" });
    expect(await dir.readOverrides("chat")).toEqual({ workspace: "WS" });
  });

  it("writes and removes override files on both levels", async () => {
    const fs = new InMemoryFileSystem();
    const dir = new PromptsDirectory(fs, { workspace: ".voidrift/prompts", global: "g/prompts" });
    await dir.write("chat", "workspace", "WS");
    await dir.write("chat", "global", "GL");
    expect(await dir.readOverrides("chat")).toEqual({ workspace: "WS", global: "GL" });
    await dir.remove("chat");
    expect(await dir.readOverrides("chat")).toEqual({});
  });
});
