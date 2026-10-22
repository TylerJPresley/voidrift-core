import { describe, it, expect } from "vitest";
import { InMemoryFileSystem } from "../adapters/in-memory-filesystem.js";
import { WorkspaceMap } from "./workspace-map.js";

/** §8.2 — the workspace-map use-case: tree + extracted symbols, hash-cached. */
describe("WorkspaceMap (§8.2)", () => {
  function make(files: Record<string, string>, depth = 5) {
    const fs = new InMemoryFileSystem();
    for (const [p, c] of Object.entries(files)) fs.files.set(p, c);
    return { fs, map: new WorkspaceMap({ fileSystem: fs, getDepth: () => depth }) };
  }

  it("builds a tree with per-file line counts and extracted symbols", async () => {
    const { map } = make({
      "src/a.ts": "export function foo() {}\nexport class Bar {}\n",
      "README.md": "# Title\n## Section\n",
    });
    const dto = await map.build();
    expect(dto.root).toBe("");
    expect(dto.depth).toBe(5);
    const names = (dto.tree.children ?? []).map((c) => c.path);
    expect(names).toContain("README.md");
    const readme = dto.tree.children!.find((c) => c.path === "README.md")!;
    expect(readme.symbols).toEqual(["# Title", "## Section"]);
    const srcDir = dto.tree.children!.find((c) => c.path === "src")!;
    const a = srcDir.children!.find((c) => c.path === "src/a.ts")!;
    expect(a.lines).toBe(3);
    expect(a.symbols).toEqual(["function foo", "class Bar"]);
  });

  it("caches the symbol index by path + content hash under .voidrift/cache/index/", async () => {
    const { fs, map } = make({ "x.ts": "export const a = 1\n" });
    await map.build();
    expect(await fs.exists(".voidrift/cache/index/map.json")).toBe(true);
    const cache = JSON.parse(await fs.readFile(".voidrift/cache/index/map.json"));
    expect(cache["x.ts"].symbols).toEqual(["const a"]);
    const firstHash = cache["x.ts"].hash;
    // A rebuild with unchanged content reuses the cached entry (same hash).
    await map.build();
    const cache2 = JSON.parse(await fs.readFile(".voidrift/cache/index/map.json"));
    expect(cache2["x.ts"].hash).toBe(firstHash);
    // A content change re-parses: the hash and symbols update.
    fs.files.set("x.ts", "export class Z {}\n");
    await map.build();
    const cache3 = JSON.parse(await fs.readFile(".voidrift/cache/index/map.json"));
    expect(cache3["x.ts"].hash).not.toBe(firstHash);
    expect(cache3["x.ts"].symbols).toEqual(["class Z"]);
  });

  it("bounds the tree to the depth given, eliding deeper files", async () => {
    const { map } = make({ "a/b/c/deep.ts": "export const x = 1\n", "top.ts": "export const t = 1\n" }, 1);
    const dto = await map.build(undefined, 1);
    expect(dto.depth).toBe(1);
    // top.ts (depth 1) is present; the deep file (depth 4) is elided.
    const topLevel = (dto.tree.children ?? []).map((c) => c.path);
    expect(topLevel).toContain("top.ts");
    expect(JSON.stringify(dto.tree)).not.toContain("deep.ts");
  });

  it("excludes the .voidrift state dir from the map", async () => {
    const { map } = make({ ".voidrift/cache/index/map.json": "{}", "real.ts": "export const r = 1\n" });
    const dto = await map.build();
    expect(JSON.stringify(dto.tree)).not.toContain(".voidrift");
    expect(JSON.stringify(dto.tree)).toContain("real.ts");
  });

  it("skips an unreadable glob match and survives a corrupt cache file", async () => {
    const fs = new InMemoryFileSystem();
    fs.files.set("ok.ts", "export const a = 1\n");
    // A corrupt cache file is tolerated (treated as empty), never a crash.
    fs.files.set(".voidrift/cache/index/map.json", "{ not json");
    // A glob entry that cannot be read is skipped (simulate by overriding readFile).
    const origRead = fs.readFile.bind(fs);
    fs.readFile = async (p: string) => {
      if (p === "phantom.ts") throw new Error("ENOENT");
      return origRead(p);
    };
    fs.files.set("phantom.ts", "");
    const map = new WorkspaceMap({ fileSystem: fs, getDepth: () => 5 });
    const dto = await map.build();
    expect(JSON.stringify(dto.tree)).toContain("ok.ts");
    expect(JSON.stringify(dto.tree)).not.toContain("phantom.ts");
  });

  it("normalizes a dot/empty path and a leading-dot root to the workspace root", async () => {
    const { map } = make({ "a.ts": "export const a = 1\n" });
    expect((await map.build(".")).root).toBe("");
    expect((await map.build("")).root).toBe("");
    expect((await map.build("./src")).root).toBe("src");
  });
});
