import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FileSystemPort } from "../entities/ports/host.js";
import { InMemoryFileSystem } from "./in-memory-filesystem.js";
import { ManualsDirectory } from "./manuals-directory.js";

let projectFs: FileSystemPort;
let globalFs: FileSystemPort;

beforeEach(() => {
  projectFs = new InMemoryFileSystem();
  globalFs = new InMemoryFileSystem();
});

afterEach(() => {
  // no resource cleanup needed for in-memory fakes
});

function testManualRaw(id: string): string {
  return `---\nsummary: Test ${id}\nread-when: anytime\ntype: reference\n---\n\n# ${id}\n\nBody for ${id}`;
}

describe("ManualsDirectory adapter (§12.8)", () => {
  it("loads project docs from .voidrift/docs and registers with project/ prefix", async () => {
    const mandir = new ManualsDirectory(projectFs, { workspace: ".voidrift/docs", global: "docs" }, globalFs);

    await projectFs.writeFile(".voidrift/docs/getting-started.md", testManualRaw("getting-started"));
    await projectFs.writeFile(".voidrift/docs/reference.md", testManualRaw("reference"));

    const result = await mandir.load("project");

    expect(result.manuals).toHaveLength(2);
    if (result.manuals[0]) expect(result.manuals[0].id).toMatch(/^project\//);
    if (result.manuals[1]) expect(result.manuals[1].id).toMatch(/^project\//);
    expect(result.skipped).toHaveLength(0);
  });

  it("loads global docs from ~/.config/voidrift/docs and registers with user/ prefix", async () => {
    const mandir = new ManualsDirectory(projectFs, { workspace: ".voidrift/docs", global: "docs" }, globalFs);

    await globalFs.writeFile("docs/user-guide.md", testManualRaw("user-guide"));
    await globalFs.writeFile("docs/tips.md", testManualRaw("tips"));

    const result = await mandir.load("global");

    expect(result.manuals).toHaveLength(2);
    if (result.manuals[0]) expect(result.manuals[0].id).toMatch(/^user\//);
    if (result.manuals[1]) expect(result.manuals[1].id).toMatch(/^user\//);
    expect(result.skipped).toHaveLength(0);
  });

  it("skips malformed docs without crashing", async () => {
    const mandir = new ManualsDirectory(projectFs, { workspace: ".voidrift/docs", global: "docs" }, globalFs);

    // Valid doc
    await projectFs.writeFile(".voidrift/docs/good.md", testManualRaw("good"));
    // Missing frontmatter
    await projectFs.writeFile(".voidrift/docs/bad-no-fm.md", "# Just a heading\n\nNo frontmatter");
    // Invalid YAML
    await projectFs.writeFile(".voidrift/docs/bad-yaml.md", "---\nbad: [yaml\n---\n\nBody");

    const result = await mandir.load("project");

    expect(result.manuals).toHaveLength(1);
    if (result.manuals[0]) expect(result.manuals[0].id).toContain("good");
    expect(result.skipped).toHaveLength(2);
    if (result.skipped[0]) expect(result.skipped[0].name).toBe("bad-no-fm");
    if (result.skipped[1]) expect(result.skipped[1].name).toBe("bad-yaml");
  });

  it("returns empty if docs directory does not exist", async () => {
    const mandir = new ManualsDirectory(projectFs, { workspace: ".voidrift/docs", global: "docs" }, globalFs);

    const result = await mandir.load("project");

    expect(result.manuals).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it("prefixes project docs with project/ and global docs with user/", async () => {
    const mandir = new ManualsDirectory(projectFs, { workspace: ".voidrift/docs", global: "docs" }, globalFs);

    await projectFs.writeFile(".voidrift/docs/proj.md", testManualRaw("proj"));
    await globalFs.writeFile("docs/global.md", testManualRaw("global"));

    const proj = await mandir.load("project");
    const glob = await mandir.load("global");

    if (proj.manuals[0]) expect(proj.manuals[0].id).toBe("project/proj");
    if (glob.manuals[0]) expect(glob.manuals[0].id).toBe("user/global");
  });

  it("uses workspace-confined fs for project docs", async () => {
    const mandir = new ManualsDirectory(projectFs, { workspace: ".voidrift/docs", global: "docs" }, globalFs);

    await projectFs.writeFile(".voidrift/docs/test.md", testManualRaw("test"));

    const result = await mandir.load("project");

    expect(result.manuals).toHaveLength(1);
  });

  it("uses dedicated globalFs for global docs (outside workspace)", async () => {
    const mandir = new ManualsDirectory(projectFs, { workspace: ".voidrift/docs", global: "docs" }, globalFs);

    await globalFs.writeFile("docs/test.md", testManualRaw("test"));

    const result = await mandir.load("global");

    expect(result.manuals).toHaveLength(1);
    if (result.manuals[0]) expect(result.manuals[0].id).toBe("user/test");
  });

  it("falls back to single fs if no dedicated globalFs", async () => {
    const mandir = new ManualsDirectory(projectFs, {
      workspace: ".voidrift/docs",
      global: ".voidrift/docs-global",
    });

    await projectFs.writeFile(".voidrift/docs-global/test.md", testManualRaw("test"));

    const result = await mandir.load("global");

    expect(result.manuals).toHaveLength(1);
  });
});
