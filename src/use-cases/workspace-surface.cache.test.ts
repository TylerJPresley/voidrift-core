/**
 * WorkspaceSurface cacheDir + hashFor (core-blueprint.md §12.4, retrieval §3/§4):
 * a plugin-owned, owner-only cache dir under `<workspace>/.voidrift/cache/<ns>/`
 * (0700, traversal/absolute refused) and a SYNCHRONOUS content-hash cache
 * populated by `readText` and the surface's own reads (null when
 * unknown/excluded/out-of-workspace). Uses a real temp workspace because the
 * cache dir creation and 0700 mode are real-filesystem behaviour.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { hermeticTmp } from "../test-hermetic.js";
import { FilesystemAdapter } from "../adapters/filesystem.js";
import { contentHash } from "../entities/hash.js";
import { WorkspaceSurfaceImpl } from "./workspace-surface.js";
import { classifyControlPath } from "../entities/protected-paths.js";

function surfaceFor(root: string, extra?: { gitList?: () => Promise<string[] | null> }): WorkspaceSurfaceImpl {
  return new WorkspaceSurfaceImpl({
    fileSystem: new FilesystemAdapter(root),
    workspaceRoot: root,
    ...(extra?.gitList ? { gitListFiles: extra.gitList } : {}),
    getTurnInput: () => "",
    getFocusPaths: () => [],
  });
}

describe("workspace surface — cacheDir (retrieval §4)", () => {
  let ws: string;
  beforeEach(() => {
    ws = hermeticTmp("wscache");
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("creates an owner-only (0700) dir under .voidrift/cache/<namespace>/", async () => {
    const s = surfaceFor(ws);
    const dir = s.cacheDir("fixture");
    expect(dir).toBe(path.join(ws, ".voidrift", "cache", "fixture"));
    const st = await fs.stat(dir);
    expect(st.isDirectory()).toBe(true);
    // 0700 on the created directory (POSIX mode bits).
    expect(st.mode & 0o777).toBe(0o700);
  });

  it("refuses a traversal or absolute or non-slug namespace", () => {
    const s = surfaceFor(ws);
    expect(() => s.cacheDir("../escape")).toThrow();
    expect(() => s.cacheDir("Bad_Name")).toThrow();
    expect(() => s.cacheDir("a/b")).toThrow();
    expect(() => s.cacheDir("/abs")).toThrow();
    expect(() => s.cacheDir("")).toThrow();
  });

  it("a file written into the cache dir is a protected control path (§9.4) for file + shell tools", async () => {
    const s = surfaceFor(ws);
    const dir = s.cacheDir("fixture");
    const file = path.join(dir, "index.json");
    await fs.writeFile(file, "{}", { mode: 0o600 });
    const ctx = { workspaceRoot: ws, globalConfigDir: path.join(ws, "global"), home: ws };
    // The model's file tool and a shell redirect both resolve to this path.
    expect(classifyControlPath(".voidrift/cache/fixture/index.json", ctx)).toBe("deny");
    expect(classifyControlPath(file, ctx)).toBe("deny");
  });
});

describe("workspace surface — hashFor (retrieval §3)", () => {
  let ws: string;
  beforeEach(() => {
    ws = hermeticTmp("wshash");
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("returns the surface's content hash synchronously for a file the surface has read", async () => {
    await fs.mkdir(path.join(ws, "src"), { recursive: true });
    await fs.writeFile(path.join(ws, "src", "a.ts"), "hello world");
    const s = surfaceFor(ws);
    // Priming by the surface's own read (what the retrieval drive does when indexing).
    const read = await s.readText("src/a.ts");
    expect(read).not.toBeNull();
    // Now hashFor is synchronous and equals the content hash.
    expect(s.hashFor("src/a.ts")).toBe(contentHash("hello world"));
    expect(s.hashFor("src/a.ts")).toBe(read!.hash);
  });

  it("returns null synchronously for unknown, excluded (secret/gitignored), and out-of-workspace paths", async () => {
    await fs.writeFile(path.join(ws, ".gitignore"), "ignored/\n");
    await fs.mkdir(path.join(ws, "ignored"), { recursive: true });
    await fs.writeFile(path.join(ws, "ignored", "g.ts"), "nope");
    await fs.writeFile(path.join(ws, ".env"), "SECRET=1");
    const s = surfaceFor(ws);
    // Unknown (never read) path.
    expect(s.hashFor("src/never.ts")).toBeNull();
    // Secret-named path is excluded by the same rules readText applies.
    expect(s.hashFor(".env")).toBeNull();
    // Out-of-workspace path.
    expect(s.hashFor("../outside.ts")).toBeNull();
    expect(s.hashFor("/etc/passwd")).toBeNull();
  });
});
