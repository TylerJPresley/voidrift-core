/**
 * AGENTS.md discovery (core-blueprint.md §6.6) and the suggestions directory
 * (§6.7), over an in-memory FileSystemPort.
 */
import { describe, it, expect } from "vitest";
import { discoverProjectFiles } from "./project-discovery.js";
import { SuggestionsDirectory } from "./suggestions-directory.js";
import { InMemoryFileSystem } from "./in-memory-filesystem.js";
import type { Suggestion } from "../entities/memory/suggestion.js";

describe("§6.6 — AGENTS.md discovery", () => {
  it("walks the workspace and assigns depth; reads the global file", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile("AGENTS.md", "root");
    await fs.writeFile("pkg/sub/AGENTS.md", "nested");
    await fs.writeFile("g/AGENTS.md", "global");

    const files = await discoverProjectFiles(fs, { workspace: "/ws", global: "g/AGENTS.md" });
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get("AGENTS.md")?.depth).toBe(0);
    expect(byPath.get("pkg/sub/AGENTS.md")?.depth).toBe(2);
    expect(byPath.get("g/AGENTS.md")?.scope).toBe("global");
  });

  it("skips empty files and a missing global", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile("AGENTS.md", "   ");
    const files = await discoverProjectFiles(fs, { workspace: "/ws", global: "nope/AGENTS.md" });
    expect(files).toEqual([]);
  });

  it("excludes VoidRift's own state dir and the usual non-source dirs (§6.6)", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile("AGENTS.md", "root");
    await fs.writeFile("src/a/AGENTS.md", "nested legit");
    // VoidRift's OWN session-cache copy of the merged context — must NOT be
    // rediscovered (the snowball root cause: cache copies merged back in).
    await fs.writeFile(".voidrift/cache/session/x/AGENTS.md", "cache copy");
    await fs.writeFile("node_modules/p/AGENTS.md", "dep");
    await fs.writeFile(".git/anything/AGENTS.md", "git");

    const files = await discoverProjectFiles(fs, { workspace: "/ws", global: "nope/AGENTS.md" });
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(["AGENTS.md", "src/a/AGENTS.md"]);
  });

  it("a session-cache copy written mid-run is not rediscoverable (snowball guard, §6.6)", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile("AGENTS.md", "root rule");
    const before = (await discoverProjectFiles(fs, { workspace: "/ws" })).map((f) => f.content);
    // Simulate engine.ts writeCache(session.id, "AGENTS.md", ctx.full).
    await fs.writeFile(".voidrift/cache/session/sess-1/AGENTS.md", "root rule");
    const after = (await discoverProjectFiles(fs, { workspace: "/ws" })).map((f) => f.content);
    expect(after).toEqual(before);
  });
});

describe("§6.7 — suggestions directory", () => {
  const mk = (id: string, status: Suggestion["status"]): Suggestion => ({
    id,
    kind: "memory-note",
    title: id,
    body: `body-${id}`,
    keywords: [],
    memoryType: "note",
    memoryScope: "workspace",
    status,
    sourceSessionId: "s1",
    createdAt: id,
  });

  it("saves, gets, lists, and filters pending", async () => {
    const dir = new SuggestionsDirectory(new InMemoryFileSystem(), ".voidrift/suggestions");
    await dir.save(mk("a", "pending"));
    await dir.save(mk("b", "approved"));
    expect((await dir.get("a"))?.title).toBe("a");
    expect((await dir.list()).map((s) => s.id)).toEqual(["a", "b"]);
    expect((await dir.listPending()).map((s) => s.id)).toEqual(["a"]);
  });

  it("returns null for an unknown id", async () => {
    const dir = new SuggestionsDirectory(new InMemoryFileSystem(), ".voidrift/suggestions");
    expect(await dir.get("nope")).toBeNull();
  });
});
