/**
 * Skills directory adapter — writing an approved skill candidate's SKILL.md and
 * its assets as one directory (core-blueprint.md §6.7, §12.1). The asset is
 * written verbatim under the skill dir and the skill then loads.
 */
import { describe, it, expect } from "vitest";
import { SkillsDirectory } from "./skills-directory.js";
import { InMemoryFileSystem } from "./in-memory-filesystem.js";

describe("§6.7/§12.1 — approved skill directory with assets", () => {
  it("writes SKILL.md + scripts/run.sh under the skill dir and the skill loads", async () => {
    const fs = new InMemoryFileSystem();
    const dir = new SkillsDirectory(fs, { workspace: ".voidrift/skills", global: "/g/skills" });
    const content = `---\nname: build-step\ndescription: Build step\n---\n\nrun the build\n`;
    await dir.write("build-step", "project", content);
    await dir.writeAsset("build-step", "project", "scripts/run.sh", "#!/bin/sh\nnpm run build\n");

    expect(await fs.exists(".voidrift/skills/build-step/scripts/run.sh")).toBe(true);
    expect(await fs.readFile(".voidrift/skills/build-step/scripts/run.sh")).toContain("npm run build");

    const loaded = await dir.load("project");
    expect(loaded.skills.map((s) => s.name)).toEqual(["build-step"]);
    expect(loaded.skills[0]!.body).toContain("run the build");
  });

  it("writeSkill publishes SKILL.md + assets atomically and the skill loads", async () => {
    const fs = new InMemoryFileSystem();
    const dir = new SkillsDirectory(fs, { workspace: ".voidrift/skills", global: "/g/skills" });
    const content = `---\nname: build-step\ndescription: Build step\n---\n\nrun the build\n`;
    await dir.writeSkill("build-step", "project", content, [
      { path: "scripts/run.sh", content: "#!/bin/sh\nnpm run build\n" },
      { path: "references/notes.md", content: "notes" },
    ]);
    expect(await fs.exists(".voidrift/skills/build-step/SKILL.md")).toBe(true);
    expect(await fs.exists(".voidrift/skills/build-step/scripts/run.sh")).toBe(true);
    expect(await fs.exists(".voidrift/skills/build-step/references/notes.md")).toBe(true);
    // No staging directory survives.
    expect(fs.files.has(".voidrift/skills/build-step/SKILL.md")).toBe(true);
    expect([...fs.files.keys()].some((k) => k.includes(".tmp-"))).toBe(false);
    const loaded = await dir.load("project");
    expect(loaded.skills.map((s) => s.name)).toEqual(["build-step"]);
  });

  it("a mid-write failure leaves NO partial skill directory (§12.1 atomic)", async () => {
    const fs = new InMemoryFileSystem();
    // Fail on the second asset write — after SKILL.md + the first asset.
    let writes = 0;
    const realWrite = fs.writeFile.bind(fs);
    fs.writeFile = async (p: string, c: string) => {
      writes += 1;
      if (writes === 3) throw new Error("disk full");
      return realWrite(p, c);
    };
    const dir = new SkillsDirectory(fs, { workspace: ".voidrift/skills", global: "/g/skills" });
    const content = `---\nname: bad\ndescription: Bad\n---\n\nbody\n`;
    await expect(
      dir.writeSkill("bad", "project", content, [
        { path: "scripts/a.sh", content: "a" },
        { path: "scripts/b.sh", content: "b" },
      ]),
    ).rejects.toThrow("disk full");
    // Nothing published under the final name, and no staging dir left behind.
    expect(await fs.exists(".voidrift/skills/bad/SKILL.md")).toBe(false);
    expect([...fs.files.keys()].some((k) => k.includes("/bad/"))).toBe(false);
    expect([...fs.files.keys()].some((k) => k.includes(".tmp-"))).toBe(false);
    const loaded = await dir.load("project");
    expect(loaded.skills).toHaveLength(0);
  });
});
