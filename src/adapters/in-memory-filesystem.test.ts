/**
 * The in-memory FileSystemPort test helper (§15.3) — exercised directly so the
 * fake the memory tests depend on is itself covered.
 */
import { describe, it, expect } from "vitest";
import { InMemoryFileSystem } from "./in-memory-filesystem.js";

describe("InMemoryFileSystem", () => {
  it("writes, reads, and reports existence", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile("./a/b.txt", "hello");
    expect(await fs.exists("a/b.txt")).toBe(true);
    expect(await fs.readFile("a/b.txt")).toBe("hello");
    expect(await fs.exists("missing")).toBe(false);
  });

  it("throws ENOENT on a missing read", async () => {
    const fs = new InMemoryFileSystem();
    await expect(fs.readFile("nope")).rejects.toThrow(/ENOENT/);
  });

  it("globs with **, *, and basename fallback", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile("AGENTS.md", "root");
    await fs.writeFile("pkg/sub/AGENTS.md", "nested");
    await fs.writeFile("x/y.ts", "code");
    expect((await fs.glob("**/AGENTS.md")).sort()).toEqual(["AGENTS.md", "pkg/sub/AGENTS.md"]);
    expect(await fs.glob("x/*.ts")).toEqual(["x/y.ts"]);
    // A segment glob also matches by basename fallback (as the real adapter does).
    expect((await fs.glob("*.md")).sort()).toEqual(["AGENTS.md", "pkg/sub/AGENTS.md"]);
  });

  it("searches content, honoring a path scope", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile("a.txt", "alpha\nbeta");
    await fs.writeFile("sub/b.txt", "beta\ngamma");
    expect((await fs.search("beta")).length).toBe(2);
    const scoped = await fs.search("beta", { path: "sub" });
    expect(scoped.every((l) => l.startsWith("sub/"))).toBe(true);
  });
});
