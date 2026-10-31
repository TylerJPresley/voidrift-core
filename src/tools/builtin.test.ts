/**
 * Core §8.2 tool suite tests (core-blueprint.md §8.1, §8.2).
 *
 * Exercise each core-owned tool over a real `LocalShellBackend` rooted at a
 * per-test temp workspace: the §8.2 names, argument fields, success output
 * contracts (headers, "N lines", diff blocks), and the error strings. Confirms
 * the model-facing surface is the blueprint's, not deepagents' native one.
 *
 * REGRESSION GUARD: no test command string in this suite contains `exec -a` (bash-only,
 * fails on dash). Tests use symlink markers instead (see process-marker.ts).
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { LocalShellBackend } from "deepagents";
import { buildCoreTools, builtinToolDefinitions, buildMcpModelTools, buildPluginModelTools } from "./builtin.js";
import { ToolRegistry } from "../entities/tool-registry.js";
import { z } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { ToolMessage } from "@langchain/core/messages";
import { createProcessMarker } from "../test-support/process-marker.js";

function byName(tools: StructuredToolInterface[], name: string): StructuredToolInterface {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}
async function call(tool: StructuredToolInterface, args: unknown): Promise<string> {
  const out = await tool.invoke(args as never);
  // A failing tool now returns a `ToolMessage` with `status: "error"` (§8.1); its
  // `content` is the same human string a success return would be — unwrap it so
  // the behavioral assertions below read the message either way.
  return out instanceof ToolMessage ? String(out.content) : String(out);
}

describe("builtinToolDefinitions (§8.1, §8.2)", () => {
  it("exposes the §8.2 names with the one readOnly classification", () => {
    const defs = builtinToolDefinitions();
    expect(defs.map((d) => d.def.name)).toEqual([
      "read_file",
      "glob_files",
      "workspace_map",
      "search_contents",
      "write_file",
      "edit_file",
      "execute_command",
      "wait",
      "web_fetch",
      "web_search",
      "researcher_save_notes",
      "save_memory",
      "list_memory",
      "delete_memory",
      "task",
      "ingest",
    ]);
    const ro = defs.filter((d) => d.def.readOnly).map((d) => d.def.name);
    expect(ro).toEqual(["read_file", "glob_files", "workspace_map", "search_contents", "list_memory", "ingest"]);
  });
});

describe("REGRESSION: no exec -a in command strings", () => {
  it("source code contains no exec -a commands", async () => {
    // This test reads the source and verifies no command string contains the
    // bash-only `exec -a`, which fails on dash. If this fails, commands must be
    // migrated to symlink markers (createProcessMarker).
    const fs = await import("node:fs");
    const source = fs.readFileSync(__filename, "utf8");
    const lines = source.split("\n");
    const offending = lines
      .map((line, idx) => ({ line, idx: idx + 1 }))
      .filter(({ line }) => /`.*exec\s+-a\s+/.test(line) || /'.*exec\s+-a\s+/.test(line) || /".*exec\s+-a\s+"/.test(line));
    if (offending.length > 0) {
      const msg = offending.map(({ line, idx }) => `  Line ${idx}: ${line.trim()}`).join("\n");
      throw new Error(`Found bash-only \`exec -a\` in test commands:\n${msg}`);
    }
  });
});

describe("buildCoreTools over a LocalShellBackend (§8.2)", () => {
  let ws: string;
  let tools: StructuredToolInterface[];

  beforeEach(async () => {
    ws = hermeticTmp("tools");
    await fs.writeFile(path.join(ws, "a.txt"), "line one\nline two\n");
    await fs.mkdir(path.join(ws, "sub"), { recursive: true });
    await fs.writeFile(path.join(ws, "sub", "b.ts"), "export const x = 1;\n");
    const backend = new LocalShellBackend({ rootDir: ws });
    tools = buildCoreTools(backend, { workspaceMaxReadLines: 2000, workspaceMapDepth: 5 });
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("read_file {path} returns a header, line numbers, and a not-found error", async () => {
    const ok = await call(byName(tools, "read_file"), { path: "a.txt" });
    expect(ok).toContain("a.txt (");
    expect(ok).toMatch(/\bline one\b/);
    const miss = await call(byName(tools, "read_file"), { path: "nope.txt" });
    expect(miss).toBe("Error: File not found: nope.txt");
  });

  it("read_file honors explicit offset and limit and notes pagination", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `row ${i}`).join("\n") + "\n";
    await fs.writeFile(path.join(ws, "big.txt"), lines);
    const page = await call(byName(tools, "read_file"), { path: "big.txt", offset: 0, limit: 3 });
    expect(page).toContain("big.txt (");
    expect(page).toContain("row 0");
    // A bounded read of a longer file carries a pagination note.
    expect(page).toMatch(/continue|Showing/);
  });

  it("workspace_map reports an empty directory", async () => {
    await fs.mkdir(path.join(ws, "empty"), { recursive: true });
    const r = await call(byName(tools, "workspace_map"), { path: "empty" });
    expect(r).toBe("(empty)");
  });

  it("glob_files {pattern} lists matches and reports no match", async () => {
    const hit = await call(byName(tools, "glob_files"), { pattern: "**/*.ts" });
    expect(hit).toContain("b.ts");
    const none = await call(byName(tools, "glob_files"), { pattern: "**/*.nomatch" });
    expect(none).toBe("No files matched.");
  });

  it("glob_files rejects an over-long pattern before it reaches the backend (A1 braces ReDoS guard)", async () => {
    // A1 (GHSA-vfj7-8cjw-p6xm): a model-supplied pattern is the one reachable
    // input to deepagents → fast-glob → micromatch → braces. braces 3.0.3 is
    // the latest release and still carries the ReDoS advisory with no upstream
    // fix, so an over-long pattern is rejected at the tool boundary (the only
    // reachable entry) rather than expanded. A normal glob is well under the cap.
    const hostile = "{" + "a,".repeat(2000) + "a}";
    expect(hostile.length).toBeGreaterThan(1024);
    const blocked = await call(byName(tools, "glob_files"), { pattern: hostile });
    expect(blocked).toContain("too long");
    // A legitimate glob of normal length is unaffected.
    const ok = await call(byName(tools, "glob_files"), { pattern: "**/*.ts" });
    expect(ok).toContain("b.ts");
  });

  it("workspace_map {path?} lists entries and marks directories", async () => {
    const map = await call(byName(tools, "workspace_map"), {});
    expect(map).toMatch(/a\.txt/);
    expect(map).toMatch(/sub\//);
    const scoped = await call(byName(tools, "workspace_map"), { path: "." });
    expect(scoped.length).toBeGreaterThan(0);
  });

  it("search_contents {pattern, include?} finds lines, handles a path-style include, reports no match", async () => {
    const found = await call(byName(tools, "search_contents"), { pattern: "line two" });
    expect(found).toContain("a.txt:");
    // §8.2 — a path-style include with a GLOB in the directory part is rejected.
    const bad = await call(byName(tools, "search_contents"), { pattern: "x", include: "sr*/x.ts" });
    expect(bad).toBe("Error: include is a filename glob such as *.ts; put the directory in path");
    // §8.2 — a plain filename glob is unchanged and still searches.
    const plain = await call(byName(tools, "search_contents"), { pattern: "line two", include: "*.txt" });
    expect(plain).toContain("a.txt:");
    // §8.2 — include too long is rejected with the exact message before parsing.
    const longInclude = await call(byName(tools, "search_contents"), {
      pattern: "x",
      include: "a".repeat(1100),
    });
    expect(longInclude).toBe("Error: 'include' too long (max 1024 characters)");
    const none = await call(byName(tools, "search_contents"), { pattern: "zzz-not-present-zzz" });
    expect(none).toBe("No matches found.");
    // §8.2 — a derived directory escaping the workspace is confined exactly as a
    // `path` argument is: the escape is DENIED before the backend runs, so a
    // file OUTSIDE the workspace is never matched (no leak).
    const escaped = await call(byName(tools, "search_contents"), { pattern: "line two", include: "../*.txt" });
    expect(escaped).toBe("Error: path escapes the workspace");
  });

  it("write_file {path, content} creates and overwrites with a diff block", async () => {
    const created = await call(byName(tools, "write_file"), { path: "new.txt", content: "hi\n" });
    expect(created).toContain("Created new.txt (");
    expect(await fs.readFile(path.join(ws, "new.txt"), "utf8")).toBe("hi\n");
    const over = await call(byName(tools, "write_file"), { path: "new.txt", content: "bye\n" });
    expect(over).toContain("```diff");
  });

  it("edit_file {path, search, replace} edits, rejects empty search, and reports not found", async () => {
    const edited = await call(byName(tools, "edit_file"), { path: "a.txt", search: "line one", replace: "LINE 1" });
    expect(edited).toContain("Edited a.txt");
    expect(edited).toContain("```diff");
    expect(await fs.readFile(path.join(ws, "a.txt"), "utf8")).toContain("LINE 1");
    const empty = await call(byName(tools, "edit_file"), { path: "a.txt", search: "", replace: "x" });
    expect(empty).toBe("Error: search string cannot be empty");
    const miss = await call(byName(tools, "edit_file"), { path: "a.txt", search: "absent-string", replace: "x" });
    expect(miss).toBe("Edit failed: search string not found in a.txt");
  });

  it("execute_command {command} returns the §8.2 'Exit code N' header and output on success", async () => {
    const out = await call(byName(tools, "execute_command"), { command: "echo hello" });
    expect(out).toContain("Exit code 0");
    expect(out).toContain("hello");
  });

  it("execute_command returns 'Exit code N' with status error on a non-zero exit (§8.2)", async () => {
    const msg = await byName(tools, "execute_command").invoke(
      { command: "sh -c 'exit 3'" } as never,
    );
    expect(msg).toBeInstanceOf(ToolMessage);
    const tm = msg as ToolMessage;
    expect(tm.status).toBe("error");
    expect(String(tm.content)).toContain("Exit code 3");
  });

  it("a failed read_file/edit_file/search_contents returns a ToolMessage with status error (not a false success)", async () => {
    // Regression: a string-returning error was reported as success by the
    // decision point, so the CLI showed a green ● instead of a red ✗. Each
    // failure now carries `status: "error"` (§8.1).
    const failing: Array<[string, unknown]> = [
      ["read_file", { path: "nope.txt" }],
      ["edit_file", { path: "a.txt", search: "", replace: "x" }],
      ["edit_file", { path: "a.txt", search: "absent-string", replace: "x" }],
      ["search_contents", { pattern: "x", include: "sr*/x.ts" }],
    ];
    for (const [name, args] of failing) {
      const msg = await byName(tools, name).invoke(args as never);
      expect(msg, `${name} should return a ToolMessage on failure`).toBeInstanceOf(ToolMessage);
      expect((msg as ToolMessage).status).toBe("error");
    }
    // A no-match glob is a successful empty result, NOT an error.
    const none = await byName(tools, "glob_files").invoke({ pattern: "**/*.nomatch" } as never);
    expect(none).toBe("No files matched.");
  });

  it("surfaces backend errors from write_file and edit_file on a bad path", async () => {
    // Writing where a directory already exists is a backend error, not a diff.
    const w = await call(byName(tools, "write_file"), { path: "sub", content: "x" });
    expect(w.startsWith("Error:")).toBe(true);
    // Editing a directory surfaces the backend error (not the not-found string).
    const e = await call(byName(tools, "edit_file"), { path: "sub", search: "a", replace: "b" });
    expect(e.startsWith("Error:") || e.startsWith("Edit failed:")).toBe(true);
  });

  it("wait {seconds} sleeps and reports how long it waited (§8.2)", async () => {
    const start = Date.now();
    const out = await call(byName(tools, "wait"), { seconds: 1 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
    expect(out).toBe("Waited 1s.");
  });

  it("wait clamps a request above toolWaitMaxSeconds and says so (§8.2)", async () => {
    // A tiny cap so the test does not actually sleep the requested 999s.
    const backend = new LocalShellBackend({ rootDir: ws });
    const capped = buildCoreTools(backend, { workspaceMaxReadLines: 2000, workspaceMapDepth: 5, toolWaitMaxSeconds: 1 });
    const out = await call(byName(capped, "wait"), { seconds: 999 });
    expect(out).toContain("Waited 1s.");
    expect(out).toContain("clamped to the 1s cap");
  });

  it("wait {check} polls the command and returns on success (exit 0) (§8.2)", async () => {
    const out = await call(byName(tools, "wait"), { check: "true", interval: 1, timeout: 5 });
    expect(out).toContain("check succeeded (exit 0)");
  });

  it("wait {check} times out when the command never succeeds (§8.2)", async () => {
    const out = await call(byName(tools, "wait"), { check: "false", interval: 1, timeout: 1 });
    expect(out).toContain("timed out");
  });

  it("wait is cancellable through the AbortSignal (§8.2 — session.cancel)", async () => {
    const ac = new AbortController();
    const p = byName(tools, "wait").invoke({ seconds: 30 } as never, { signal: ac.signal });
    // Abort shortly after the wait has begun so the in-flight sleep is cut short.
    setTimeout(() => ac.abort(), 50);
    // LangChain may surface an aborted run either as our "Wait cancelled." result
    // or as a thrown abort error; both prove the 30 s sleep did not run to end.
    let text: string;
    try {
      const out = await p;
      text = String(out instanceof ToolMessage ? out.content : out);
    } catch (e) {
      text = e instanceof Error ? e.message : String(e);
    }
    expect(text === "Wait cancelled." || /abort/i.test(text)).toBe(true);
  }, 10_000);

  it("execute_command cancel kills the whole process group, not just the turn (§3.3/§5.2)", async () => {
    // Owner instruction "cancelling should cancel everything": a cancel must not
    // only unblock the turn promptly, it must leave NO running child. The command
    // runs through VoidRift's own group-killing runner, so after the abort the
    // marked `sleep` is gone within ~2 s rather than surviving to the backend
    // timeout. (POSIX process groups — skipped on win32.)
    if (process.platform === "win32") return;
    const { execSync } = await import("node:child_process");
    const marker = `vrmark_builtin_${Date.now()}`;
    const markerPath = await createProcessMarker(ws, marker, "sleep");
    const alive = (): boolean =>
      execSync(`pgrep -af ${marker} || true`, { encoding: "utf8" })
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .some((l) => !/\bpgrep\b|\|\| true/.test(l));
    const ac = new AbortController();
    const started = Date.now();
    const p = byName(tools, "execute_command").invoke(
      { command: `${markerPath} 30` } as never,
      { signal: ac.signal },
    );
    // Give the child time to spawn, confirm it is alive, then cancel.
    await new Promise((r) => setTimeout(r, 300));
    expect(alive()).toBe(true);
    ac.abort();
    let text: string;
    try {
      const out = await p;
      text = String(out instanceof ToolMessage ? out.content : out);
    } catch (e) {
      text = e instanceof Error ? e.message : String(e);
    }
    expect(/cancelled|abort/i.test(text)).toBe(true);
    // Promptly: well under the 30 s the command would otherwise take.
    expect(Date.now() - started).toBeLessThan(5000);
    // And the child (and its group) is actually gone.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && alive()) await new Promise((r) => setTimeout(r, 100));
    expect(alive()).toBe(false);
  }, 15_000);

  it("wait {check} cancel kills the poll child's whole process group (§3.3/§5.2)", async () => {
    // The poll `check` must run through VoidRift's group-killing runner, not the
    // deepagents backend (which orphans its child to its 120 s timeout on cancel).
    // Cancelling a wait whose running `check` is a marked `sleep 30` must leave NO
    // process within ~2 s and the wait must return cancelled. (POSIX — skip win32.)
    if (process.platform === "win32") return;
    const { execSync } = await import("node:child_process");
    const marker = `vrmark_waitcheck_${Date.now()}`;
    const markerPath = await createProcessMarker(ws, marker, "sleep");
    const alive = (): boolean =>
      execSync(`pgrep -af ${marker} || true`, { encoding: "utf8" })
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .some((l) => !/\bpgrep\b|\|\| true/.test(l));
    const ac = new AbortController();
    const started = Date.now();
    // interval 0 keeps the first poll in-flight; the check itself blocks 30 s.
    const p = byName(tools, "wait").invoke(
      { check: `${markerPath} 30`, interval: 1, timeout: 60 } as never,
      { signal: ac.signal },
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(alive()).toBe(true);
    ac.abort();
    let text: string;
    try {
      const out = await p;
      text = String(out instanceof ToolMessage ? out.content : out);
    } catch (e) {
      text = e instanceof Error ? e.message : String(e);
    }
    expect(/cancelled|abort/i.test(text)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && alive()) await new Promise((r) => setTimeout(r, 100));
    expect(alive()).toBe(false);
  }, 15_000);
});

describe("buildMcpModelTools (§8.4 — the one place MCP binds to the model)", () => {
  it("binds only approved MCP tools and routes a call through the registry executor", async () => {
    const reg = new ToolRegistry();
    let called = 0;
    reg.register(
      { name: "mcp_s_lookup", description: "lookup", schema: z.object({}).loose(), readOnly: false, origin: "mcp" },
      async () => {
        called++;
        return { content: "RESULT", status: "success" };
      },
      true,
    );
    reg.register(
      { name: "mcp_s_pending", description: "pending", schema: z.object({}).loose(), readOnly: false, origin: "mcp" },
      async () => ({ content: "Error: tool pending approval", status: "error" }),
      false,
    );
    reg.register({ name: "read_file", description: "", schema: z.object({}), readOnly: true, origin: "builtin" }, async () => ({ content: "", status: "success" }));

    const tools = buildMcpModelTools(reg, { workspaceRoot: "/ws", sessionId: "s" });
    expect(tools.map((t) => t.name)).toEqual(["mcp_s_lookup"]);
    const out = await tools[0]!.invoke({ q: 1 });
    expect(out).toBe("RESULT");
    expect(called).toBe(1);
  });

  it("binds nothing when every MCP tool is pending/quarantined", () => {
    const reg = new ToolRegistry();
    reg.register(
      { name: "mcp_s_q", description: "q", schema: z.object({}).loose(), readOnly: false, origin: "mcp" },
      async () => ({ content: "Error: tool quarantined", status: "error" }),
      false,
    );
    expect(buildMcpModelTools(reg, { workspaceRoot: "/ws", sessionId: "s" })).toEqual([]);
  });
});

describe("buildPluginModelTools (§12.4 — the one place plugin tools bind to the model)", () => {
  it("binds every plugin tool and routes a call through the registry executor", async () => {
    const reg = new ToolRegistry();
    let called = 0;
    reg.register(
      { name: "retrieval_search", description: "search", schema: z.object({}).loose(), readOnly: true, origin: "plugin" },
      async () => {
        called++;
        return { content: "HITS", status: "success" };
      },
    );
    reg.register({ name: "read_file", description: "", schema: z.object({}), readOnly: true, origin: "builtin" }, async () => ({ content: "", status: "success" }));

    const tools = buildPluginModelTools(reg, { workspaceRoot: "/ws", sessionId: "s" });
    expect(tools.map((t) => t.name)).toEqual(["retrieval_search"]);
    const out = await tools[0]!.invoke({ query: "x" });
    expect(out).toBe("HITS");
    expect(called).toBe(1);
  });

  it("binds nothing when no plugin tools are registered", () => {
    const reg = new ToolRegistry();
    reg.register({ name: "read_file", description: "", schema: z.object({}), readOnly: true, origin: "builtin" }, async () => ({ content: "", status: "success" }));
    expect(buildPluginModelTools(reg, { workspaceRoot: "/ws", sessionId: "s" })).toEqual([]);
  });
});

describe("§8.2/§8.7 — read_file oversize note and ranged reads", () => {
  let ws: string;
  // A ~20k-token file: ~80k chars (4 chars/token) across 5000 lines.
  const bigLines = 5000;

  async function mkBig(): Promise<void> {
    const line = "x".repeat(15); // ~16 chars/line incl. newline → ~80k chars
    await fs.writeFile(path.join(ws, "huge.txt"), Array.from({ length: bigLines }, () => line).join("\n") + "\n");
  }

  async function makeLimits(fitFraction: number, readMaxLines = 2000): Promise<import("../use-cases/limits-capability.js").LimitsCapability> {
    const { LimitsCapability } = await import("../use-cases/limits-capability.js");
    const { resolveLimits } = await import("../entities/limits-resolve.js");
    const { EventBus } = await import("../entities/event-bus.js");
    return new LimitsCapability(
      resolveLimits([{ layer: "project", limits: { ingest: { fitFraction }, tools: { readMaxLines } } }]),
      new EventBus(),
    );
  }

  beforeEach(async () => {
    ws = hermeticTmp("read-oversize");
    await mkBig();
    await fs.writeFile(path.join(ws, "small.txt"), "one\ntwo\nthree\n");
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("a whole read of a 20k-token file with only 5k available returns the typed note (no cut body)", async () => {
    const limits = await makeLimits(0.5);
    const backend = new LocalShellBackend({ rootDir: ws });
    // available 5k tokens → budget 2500 tokens; the file is ~20k tokens → over.
    const tools = buildCoreTools(backend, {
      workspaceMaxReadLines: 2000,
      workspaceMapDepth: 5,
      limits,
      availableTokens: () => 5000,
      agentHasIngest: () => true,
    });
    const note = await call(byName(tools, "read_file"), { path: "huge.txt" });
    expect(note).toContain("huge.txt is large");
    expect(note).toContain("limits.ingest.fitFraction");
    expect(note).toContain("ingest {");
    expect(note).toContain("ranged read");
    // It is NOT a cut body — no numbered content lines.
    expect(note).not.toMatch(/^\s*\d+\s{2}x/m);
  });

  it("offers ingest ONLY when the agent holds it", async () => {
    const limits = await makeLimits(0.5);
    const backend = new LocalShellBackend({ rootDir: ws });
    const tools = buildCoreTools(backend, {
      workspaceMaxReadLines: 2000,
      workspaceMapDepth: 5,
      limits,
      availableTokens: () => 5000,
      agentHasIngest: () => false,
    });
    const note = await call(byName(tools, "read_file"), { path: "huge.txt" });
    expect(note).toContain("huge.txt is large");
    expect(note).not.toContain("ingest {");
    expect(note).toContain("ranged read");
  });

  it("a ranged read of the same oversize file always works and is never refused for size", async () => {
    const limits = await makeLimits(0.5);
    const backend = new LocalShellBackend({ rootDir: ws });
    const tools = buildCoreTools(backend, {
      workspaceMaxReadLines: 2000,
      workspaceMapDepth: 5,
      limits,
      availableTokens: () => 5000,
      agentHasIngest: () => true,
    });
    const page = await call(byName(tools, "read_file"), { path: "huge.txt", offset: 0, limit: 10 });
    expect(page).toContain("huge.txt (");
    expect(page).not.toContain("is large");
    expect(page).toMatch(/\d+\s{2}x/);
  });

  it("a small file reads whole as today", async () => {
    const limits = await makeLimits(0.5);
    const backend = new LocalShellBackend({ rootDir: ws });
    const tools = buildCoreTools(backend, {
      workspaceMaxReadLines: 2000,
      workspaceMapDepth: 5,
      limits,
      availableTokens: () => 5000,
      agentHasIngest: () => true,
    });
    const r = await call(byName(tools, "read_file"), { path: "small.txt" });
    expect(r).toContain("small.txt (3 lines)");
    expect(r).toMatch(/\btwo\b/);
    expect(r).not.toContain("is large");
  });

  it("without a pipeline (no availableTokens) a whole read is never a note", async () => {
    const limits = await makeLimits(0.5);
    const backend = new LocalShellBackend({ rootDir: ws });
    const tools = buildCoreTools(backend, { workspaceMaxReadLines: 2000, workspaceMapDepth: 5, limits });
    const r = await call(byName(tools, "read_file"), { path: "huge.txt" });
    expect(r).toContain("huge.txt (");
    expect(r).not.toContain("is large");
  });
});

describe("read_file read guard (§9.4/§10.11/§10.12 — MED cross-session + control stores)", () => {
  let ws: string;
  beforeEach(() => {
    ws = hermeticTmp("read-guard");
  });

  const toolsWithGuard = (sessionId: string): StructuredToolInterface[] => {
    const backend = new LocalShellBackend({ rootDir: ws });
    return buildCoreTools(backend, {
      workspaceMaxReadLines: 2000,
      workspaceMapDepth: 5,
      readGuard: { ctx: { workspaceRoot: ws, globalConfigDir: path.join(ws, "cfg"), home: ws }, sessionId: () => sessionId },
    });
  };

  const seed = (rel: string, body: string): void => {
    const abs = path.join(ws, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };

  it("denies reading the current OTHER session's run-cache blob, allows the current session's", async () => {
    seed(".voidrift/cache/run/s1/command-output-aaaa-0.txt", "mine\nsecond");
    seed(".voidrift/cache/run/s2/command-output-bbbb-0.txt", "theirs");
    const tools = toolsWithGuard("s1");
    const mine = await call(byName(tools, "read_file"), { path: ".voidrift/cache/run/s1/command-output-aaaa-0.txt" });
    expect(mine).toContain("mine");
    const theirs = await call(byName(tools, "read_file"), { path: ".voidrift/cache/run/s2/command-output-bbbb-0.txt" });
    expect(theirs).toContain("protected VoidRift control path");
  });

  it("denies reading the mutation journal and rollback snapshots", async () => {
    seed(".voidrift/journal/s1/entries.ndjson", "secret journal");
    seed(".voidrift/cache/snapshots/s1/timeline.json", "{}");
    const tools = toolsWithGuard("s1");
    const j = await call(byName(tools, "read_file"), { path: ".voidrift/journal/s1/entries.ndjson" });
    expect(j).toContain("protected VoidRift control path");
    const s = await call(byName(tools, "read_file"), { path: ".voidrift/cache/snapshots/s1/timeline.json" });
    expect(s).toContain("protected VoidRift control path");
  });

  it("denies reading the per-install rollback.key in the global config dir", async () => {
    seed("cfg/rollback.key", "deadbeef");
    const tools = toolsWithGuard("s1");
    const k = await call(byName(tools, "read_file"), { path: path.join(ws, "cfg", "rollback.key") });
    expect(k).toContain("protected VoidRift control path");
  });

  it("allows an ordinary workspace file and the writable cache subtrees", async () => {
    seed("src/a.ts", "const x = 1;");
    seed(".voidrift/cache/index/sym.json", "{}");
    const tools = toolsWithGuard("s1");
    expect(await call(byName(tools, "read_file"), { path: "src/a.ts" })).toContain("const x = 1;");
    expect(await call(byName(tools, "read_file"), { path: ".voidrift/cache/index/sym.json" })).toContain("sym");
  });
});

describe("search_contents timeout → glob filename fallback (§8.2)", () => {
  // A catastrophically-backtracking pattern on a long line forces the wall-clock
  // bound to fire deterministically; the lowered `searchTimeoutMs` keeps a large
  // margin over the per-file read while still terminating the runaway match.
  const CATASTROPHIC = "(a+)+$";
  const LONG_LINE = "a".repeat(60_000) + "b";

  it("falls back to a bounded filename glob capped at limits.tools.searchFallbackMax with a visible notice", async () => {
    const { LimitsCapability } = await import("../use-cases/limits-capability.js");
    const { resolveLimits } = await import("../entities/limits-resolve.js");
    const { EventBus } = await import("../entities/event-bus.js");
    const ws2 = hermeticTmp("search-fallback");
    try {
      // The runaway line (so the content scan times out) plus three files whose
      // names the fallback glob (`*a*`, derived from the pattern) matches.
      await fs.writeFile(path.join(ws2, "slow.txt"), LONG_LINE + "\n");
      await fs.writeFile(path.join(ws2, "a-one.ts"), "x\n");
      await fs.writeFile(path.join(ws2, "a-two.ts"), "x\n");
      await fs.writeFile(path.join(ws2, "a-three.ts"), "x\n");
      const limits = new LimitsCapability(
        resolveLimits([{ layer: "project", limits: { tools: { searchTimeoutMs: 150, searchFallbackMax: 2 } } }]),
        new EventBus(),
      );
      const backend = new LocalShellBackend({ rootDir: ws2 });
      const tools = buildCoreTools(backend, { workspaceMaxReadLines: 2000, workspaceMapDepth: 5, limits });
      const out = await call(byName(tools, "search_contents"), { pattern: CATASTROPHIC });
      expect(out).toContain("content search timed out");
      expect(out).toContain("limits.tools.searchFallbackMax");
      // Capped at 2 of the (at least 3) `*a*` filename matches.
      expect(out.split("\n").filter((l) => /a-(one|two|three)\.ts$/.test(l)).length).toBe(2);
    } finally {
      await fs.rm(ws2, { recursive: true, force: true });
    }
  });

  it("returns real matches when the scan completes before the timeout (no fallback)", async () => {
    const ws2 = hermeticTmp("search-ok");
    try {
      await fs.writeFile(path.join(ws2, "x.ts"), "nope\nfoo here\n");
      const backend = new LocalShellBackend({ rootDir: ws2 });
      const tools = buildCoreTools(backend, { workspaceMaxReadLines: 2000, workspaceMapDepth: 5 });
      const out = await call(byName(tools, "search_contents"), { pattern: "foo" });
      expect(out).toBe("x.ts:2:foo here");
    } finally {
      await fs.rm(ws2, { recursive: true, force: true });
    }
  });
});
