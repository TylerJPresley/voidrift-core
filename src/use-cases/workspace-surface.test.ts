import { describe, it, expect } from "vitest";
import { InMemoryFileSystem } from "../adapters/in-memory-filesystem.js";
import {
  WorkspaceSurfaceImpl,
  isExcludedPath,
  looksBinary,
  MAX_FILE_BYTES,
} from "./workspace-surface.js";

function enc(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "utf8"));
}

/** Seed a file into both the text and binary maps so readText/readBinary agree. */
function seed(fs: InMemoryFileSystem, path: string, content: string | Uint8Array): void {
  const bytes = typeof content === "string" ? enc(content) : content;
  const text = typeof content === "string" ? content : "";
  fs.files.set(path, text);
  fs.binaries.set(path, bytes);
}

function makeSurface(fs: InMemoryFileSystem, extra?: { input?: string; focus?: string[] }) {
  return new WorkspaceSurfaceImpl({
    fileSystem: fs,
    getTurnInput: () => extra?.input ?? "",
    getFocusPaths: () => extra?.focus ?? [],
  });
}

describe("workspace surface — exclusion rules (retrieval §3)", () => {
  it("excludes node_modules, .git, .voidrift, secret names by path", () => {
    expect(isExcludedPath("node_modules/x/index.js")).toBe(true);
    expect(isExcludedPath(".git/config")).toBe(true);
    expect(isExcludedPath(".voidrift/cache/retrieval/v.json")).toBe(true);
    expect(isExcludedPath(".env")).toBe(true);
    expect(isExcludedPath(".env.local")).toBe(true);
    expect(isExcludedPath("keys/server.pem")).toBe(true);
    expect(isExcludedPath("a/b/service.key")).toBe(true);
    expect(isExcludedPath("id_rsa")).toBe(true);
    expect(isExcludedPath("aws_credentials.txt")).toBe(true);
    expect(isExcludedPath(".npmrc")).toBe(true);
    expect(isExcludedPath(".netrc")).toBe(true);
    // Ordinary files are not excluded.
    expect(isExcludedPath("src/index.ts")).toBe(false);
    expect(isExcludedPath("README.md")).toBe(false);
  });

  it("looksBinary detects a NUL in the first 8 KiB", () => {
    expect(looksBinary(enc("plain text"))).toBe(false);
    expect(looksBinary(new Uint8Array([0x61, 0x00, 0x62]))).toBe(true);
  });

  it("files() lists ordinary files and omits every excluded path", async () => {
    const fs = new InMemoryFileSystem();
    seed(fs, "src/index.ts", "export const x = 1;");
    seed(fs, "README.md", "# hi");
    seed(fs, "node_modules/dep/index.js", "module.exports = {}");
    seed(fs, ".git/config", "[core]");
    seed(fs, ".voidrift/cache/retrieval/v.json", "{}");
    seed(fs, ".env", "SECRET=1");
    seed(fs, "server.pem", "-----BEGIN-----");
    const files = await makeSurface(fs).files();
    expect(files).toEqual(["README.md", "src/index.ts"]);
  });

  it("readText returns text + hash for an ordinary file, null for excluded/binary/oversized", async () => {
    const fs = new InMemoryFileSystem();
    seed(fs, "src/a.ts", "hello");
    seed(fs, ".env", "SECRET=1");
    seed(fs, "logo.png", new Uint8Array([0x89, 0x50, 0x00, 0x4e]));
    seed(fs, "big.txt", "x".repeat(MAX_FILE_BYTES + 1));
    const s = makeSurface(fs);
    const ok = await s.readText("src/a.ts");
    expect(ok).not.toBeNull();
    expect(ok!.text).toBe("hello");
    expect(ok!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await s.readText(".env")).toBeNull(); // secret name
    expect(await s.readText("logo.png")).toBeNull(); // binary (NUL byte)
    expect(await s.readText("big.txt")).toBeNull(); // > 1 MiB
  });

  it("readText rejects a traversal path (degrades to null)", async () => {
    const fs = new InMemoryFileSystem();
    seed(fs, "src/a.ts", "hello");
    const s = makeSurface(fs);
    expect(await s.readText("../escape.ts")).toBeNull();
    expect(await s.readText("")).toBeNull();
  });

  it("currentInput and focusPaths reflect the injected accessors, filtering excluded focus", () => {
    const fs = new InMemoryFileSystem();
    const s = makeSurface(fs, { input: "find the retry logic", focus: ["src/a.ts", ".env", "node_modules/x.js"] });
    expect(s.currentInput()).toBe("find the retry logic");
    expect(s.focusPaths()).toEqual(["src/a.ts"]);
  });
});

describe("workspace surface — honours gitignore (FX-B)", () => {
  it("in a git repo, files() lists only the hardened git ls-files set", async () => {
    const fs = new InMemoryFileSystem();
    seed(fs, "src/index.ts", "x");
    seed(fs, "ignored/g.ts", "SHOULD NOT SHOW");
    seed(fs, "README.md", "hi");
    // The git candidate set omits the ignored file (git applied .gitignore).
    const s = new WorkspaceSurfaceImpl({
      fileSystem: fs,
      gitListFiles: async () => ["src/index.ts", "README.md"],
      getTurnInput: () => "",
      getFocusPaths: () => [],
    });
    const files = await s.files();
    expect(files).toEqual(["README.md", "src/index.ts"]);
    expect(files).not.toContain("ignored/g.ts");
  });

  it("in a git repo, a tracked-but-also-ignored file STAYS visible (follows git)", async () => {
    const fs = new InMemoryFileSystem();
    seed(fs, "build.log", "tracked though ignored");
    seed(fs, "other.log", "untracked + ignored");
    // git ls-files keeps a tracked file even if a pattern would ignore it.
    const s = new WorkspaceSurfaceImpl({
      fileSystem: fs,
      gitListFiles: async () => ["build.log"],
      getTurnInput: () => "",
      getFocusPaths: () => [],
    });
    const files = await s.files();
    expect(files).toEqual(["build.log"]);
  });

  it("outside a git repo, files() excludes paths matched by a root .gitignore", async () => {
    const fs = new InMemoryFileSystem();
    seed(fs, ".gitignore", "ignored/\n*.log\n");
    seed(fs, "src/index.ts", "x");
    seed(fs, "ignored/g.ts", "SHOULD NOT SHOW");
    seed(fs, "app.log", "SHOULD NOT SHOW");
    seed(fs, "README.md", "hi");
    // No gitListFiles -> the non-git path parses .gitignore itself.
    const s = makeSurface(fs);
    const files = await s.files();
    expect(files).toContain("src/index.ts");
    expect(files).toContain("README.md");
    expect(files).toContain(".gitignore");
    expect(files).not.toContain("ignored/g.ts");
    expect(files).not.toContain("app.log");
  });

  it("outside a git repo, a nested .gitignore and a negation are honoured", async () => {
    const fs = new InMemoryFileSystem();
    seed(fs, ".gitignore", "*.tmp\n");
    seed(fs, "sub/.gitignore", "!keep.tmp\n");
    seed(fs, "a.tmp", "nope");
    seed(fs, "sub/drop.tmp", "nope");
    seed(fs, "sub/keep.tmp", "yes");
    const s = makeSurface(fs);
    const files = await s.files();
    expect(files).not.toContain("a.tmp");
    expect(files).not.toContain("sub/drop.tmp");
    expect(files).toContain("sub/keep.tmp");
  });

  it("the git path takes precedence over any .gitignore parsing when gitListFiles returns a set", async () => {
    const fs = new InMemoryFileSystem();
    seed(fs, ".gitignore", "src/\n"); // would ignore src/ on the non-git path
    seed(fs, "src/index.ts", "x");
    const s = new WorkspaceSurfaceImpl({
      fileSystem: fs,
      gitListFiles: async () => ["src/index.ts", ".gitignore"],
      getTurnInput: () => "",
      getFocusPaths: () => [],
    });
    const files = await s.files();
    expect(files).toContain("src/index.ts"); // git says it is tracked
  });
});

describe("workspace surface — limits registry (§13.11 TOOL3/4)", () => {
  it("defaults equal today's values", async () => {
    const { limitDefault } = await import("../entities/limits.js");
    expect(limitDefault("tools.workspaceMaxFiles")).toBe(20_000);
    expect(limitDefault("tools.workspaceFileMaxBytes")).toBe(1024 * 1024);
    expect(MAX_FILE_BYTES).toBe(1024 * 1024);
  });

  it("a configured limits.tools.workspaceMaxFiles caps the listing and emits one LIMIT_HIT", async () => {
    const { EventBus } = await import("../entities/event-bus.js");
    const { resolveLimits } = await import("../entities/limits-resolve.js");
    const { LimitsCapability } = await import("./limits-capability.js");
    const bus = new EventBus();
    const hits: { key: string; value: number }[] = [];
    bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string; value: number }));
    const limits = new LimitsCapability(resolveLimits([{ layer: "project", limits: { tools: { workspaceMaxFiles: 2 } } }]), bus);
    const fs = new InMemoryFileSystem();
    for (let i = 0; i < 5; i++) seed(fs, `src/f${i}.ts`, "x");
    const s = new WorkspaceSurfaceImpl({ fileSystem: fs, getTurnInput: () => "", getFocusPaths: () => [], limits });
    const files = await s.files();
    expect(files).toHaveLength(2);
    expect(hits.some((h) => h.key === "tools.workspaceMaxFiles" && h.value === 2)).toBe(true);
  });
});
