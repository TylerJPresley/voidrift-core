import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { hermeticTmp } from "../test-hermetic.js";
import { resolveInside } from "./docs-confine.js";

describe("resolveInside - docs path confinement", () => {
  let baseDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    const tmpRoot = hermeticTmp("docs-confine");
    baseDir = path.join(tmpRoot, "plugin");
    outsideDir = path.join(tmpRoot, "outside");

    // Create base plugin dir
    await fs.mkdir(baseDir, { recursive: true });
    // Create outside dir for path traversal tests
    await fs.mkdir(outsideDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up tmpRoot by removing the parent of baseDir
    const tmpRoot = path.dirname(baseDir);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("accepts a relative docs path './docs' inside base", async () => {
    const docsDir = path.join(baseDir, "docs");
    await fs.mkdir(docsDir, { recursive: true });

    const result = await resolveInside(baseDir, "./docs");
    expect(result).toBe(docsDir);
  });

  it("accepts a nested relative path 'docs/sub' inside base", async () => {
    const subDir = path.join(baseDir, "docs", "sub");
    await fs.mkdir(subDir, { recursive: true });

    const result = await resolveInside(baseDir, "docs/sub");
    expect(result).toBe(subDir);
  });

  it("rejects path traversal '../outside'", async () => {
    // Create outside dir to make sure it "exists", but it's still outside
    await fs.mkdir(outsideDir, { recursive: true });

    const result = await resolveInside(baseDir, "../outside");
    expect(result).toBeNull();
  });

  it("rejects absolute paths", async () => {
    const absPath = path.join(baseDir, "docs");
    await fs.mkdir(absPath, { recursive: true });

    const result = await resolveInside(baseDir, absPath);
    expect(result).toBeNull();
  });

  it("rejects a symlink dir inside base pointing outside", async () => {
    // Create a symlink inside base that points to outsideDir
    const symlinkPath = path.join(baseDir, "link-to-outside");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.symlink(outsideDir, symlinkPath);

    const result = await resolveInside(baseDir, "link-to-outside");
    expect(result).toBeNull();
  });

  it("rejects nonexistent paths", async () => {
    const result = await resolveInside(baseDir, "nonexistent");
    expect(result).toBeNull();
  });
});
