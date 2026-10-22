/**
 * FX-B real-binary end-to-end: in a real temp git repo the workspace surface
 * never surfaces a gitignored file, because its candidate list is the hardened
 * `git ls-files -z --cached --others --exclude-standard` set — git applies
 * `.gitignore`, `.git/info/exclude` and keeps a tracked-but-ignored file
 * visible. A plain (non-git) directory parses its own `.gitignore`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { hermeticTmp } from "../test-hermetic.js";
import { FilesystemAdapter } from "../adapters/filesystem.js";
import { VcsAdapter } from "../adapters/vcs.js";
import { WorkspaceSurfaceImpl } from "./workspace-surface.js";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

function surfaceFor(root: string): WorkspaceSurfaceImpl {
  const vcs = new VcsAdapter(root);
  return new WorkspaceSurfaceImpl({
    fileSystem: new FilesystemAdapter(root),
    gitListFiles: () => vcs.listFiles(),
    getTurnInput: () => "",
    getFocusPaths: () => [],
  });
}

describe("workspace surface — real git repo gitignore (FX-B)", () => {
  let ws: string;
  beforeEach(() => {
    ws = hermeticTmp("fxb");
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("never returns a gitignored dir/file; a .git/info/exclude pattern is honoured", async () => {
    await git(ws, "init", "-q");
    await fs.mkdir(path.join(ws, "src"), { recursive: true });
    await fs.mkdir(path.join(ws, "ignored"), { recursive: true });
    await fs.writeFile(path.join(ws, ".gitignore"), "ignored/\n*.log\n");
    await fs.writeFile(path.join(ws, "src", "index.ts"), "export const x = 1;");
    await fs.writeFile(path.join(ws, "ignored", "g.ts"), "TOP HIT BEFORE FIX");
    await fs.writeFile(path.join(ws, "app.log"), "noise");
    await fs.writeFile(path.join(ws, "README.md"), "# hi");
    // .git/info/exclude (local, uncommitted ignore)
    await fs.writeFile(path.join(ws, ".git", "info", "exclude"), "excluded.txt\n");
    await fs.writeFile(path.join(ws, "excluded.txt"), "local ignore");

    const files = await surfaceFor(ws).files();
    expect(files).toContain("src/index.ts");
    expect(files).toContain("README.md");
    expect(files).not.toContain("ignored/g.ts");
    expect(files).not.toContain("app.log");
    expect(files).not.toContain("excluded.txt");
  });

  it("a tracked file that later matches an ignore pattern STAYS visible (git keeps tracked files)", async () => {
    await git(ws, "init", "-q");
    await fs.writeFile(path.join(ws, "keep.log"), "tracked");
    await git(ws, "add", "keep.log");
    await git(ws, "commit", "-qm", "add keep.log");
    // Now ignore *.log — the tracked keep.log must still be listed.
    await fs.writeFile(path.join(ws, ".gitignore"), "*.log\n");
    await fs.writeFile(path.join(ws, "untracked.log"), "ignored + untracked");

    const files = await surfaceFor(ws).files();
    expect(files).toContain("keep.log");
    expect(files).not.toContain("untracked.log");
  });

  it("a plain (non-git) directory parses its own .gitignore", async () => {
    // No `git init`: the surface takes the non-git path (gitListFiles -> null).
    await fs.mkdir(path.join(ws, "dist"), { recursive: true });
    await fs.mkdir(path.join(ws, "src"), { recursive: true });
    await fs.writeFile(path.join(ws, ".gitignore"), "dist/\n");
    await fs.writeFile(path.join(ws, "dist", "bundle.js"), "nope");
    await fs.writeFile(path.join(ws, "src", "main.ts"), "yes");

    const files = await surfaceFor(ws).files();
    expect(files).toContain("src/main.ts");
    expect(files).not.toContain("dist/bundle.js");
  });
});
