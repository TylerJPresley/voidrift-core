import { describe, it, expect } from "vitest";
import { InMemoryFileSystem } from "./in-memory-filesystem.js";
import { AgentsDirectory } from "./agents-directory.js";

/** §3.1/§12.1 — filesystem agent discovery: a directory `<name>/agent.json`
 * (+ optional `prompt.md`), skipping a malformed one so discovery never breaks. */
describe("AgentsDirectory (§3.1, §12.1)", () => {
  const json = (o: Record<string, unknown>) => JSON.stringify(o);
  function make(files: Record<string, string>) {
    const fs = new InMemoryFileSystem();
    for (const [p, c] of Object.entries(files)) fs.files.set(p, c);
    return new AgentsDirectory(fs, { project: ".voidrift/agents", global: "agents" });
  }

  it("discovers valid agent directories and SKIPS a malformed one", async () => {
    const dir = make({
      ".voidrift/agents/good/agent.json": json({ name: "good", description: "d", kind: "worker", tools: ["read_file"], prompt: "p" }),
      ".voidrift/agents/bad/agent.json": json({ name: "Bad Name!", description: "" }),
    });
    const result = await dir.discover("project");
    expect(result.definitions.map((d) => d.name)).toEqual(["good"]);
    expect(result.skipped.map((s) => s.name)).toEqual(["bad"]);
  });

  it("reads the sibling prompt.md when no inline prompt", async () => {
    const dir = make({
      ".voidrift/agents/w/agent.json": json({ name: "w", description: "d", kind: "worker", tools: [] }),
      ".voidrift/agents/w/prompt.md": "the prompt body",
    });
    const result = await dir.discover("project");
    expect(result.definitions[0]?.systemPrompt).toBe("the prompt body");
  });

  it("returns empty when the source directory has no agents", async () => {
    const dir = make({});
    const result = await dir.discover("global");
    expect(result.definitions).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("tags each discovered definition with its source and file path (§3.1)", async () => {
    const dir = make({ ".voidrift/agents/w/agent.json": json({ name: "w", description: "d", kind: "worker", prompt: "p" }) });
    const result = await dir.discover("project");
    expect(result.definitions[0]?.source).toBe("project");
    expect(result.definitions[0]?.filePath).toBe(".voidrift/agents/w/agent.json");
  });

  it("the BUILTIN source is NOT discovered on disk (chat lives in code) — returns nothing", async () => {
    const dir = make({});
    const result = await dir.discover("builtin");
    expect(result.definitions).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("reads the GLOBAL source through the dedicated global-rooted FS, NOT the project port (§3.1)", async () => {
    const projectFs = new InMemoryFileSystem();
    const globalFs = new InMemoryFileSystem();
    globalFs.files.set("agents/g/agent.json", json({ name: "g", description: "d", kind: "worker", tools: ["read_file"], prompt: "p" }));
    const dir = new AgentsDirectory(projectFs, { project: ".voidrift/agents", global: "agents" }, globalFs);
    const result = await dir.discover("global");
    expect(result.definitions.map((d) => d.name)).toEqual(["g"]);
    expect(result.definitions[0]?.source).toBe("global");
    // The project port returns nothing for the global source.
    const proj = await dir.discover("project");
    expect(proj.definitions).toEqual([]);
  });
});
