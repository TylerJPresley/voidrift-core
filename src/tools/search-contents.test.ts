/**
 * §8.2 `search_contents` — real-regex behaviour (the §8.2 integration test).
 *
 * Driven over a REAL `LocalShellBackend` rooted at a per-test hermetic
 * workspace: alternation, line anchors, `.` vs `\.`, a leading `(?i)`, an
 * invalid pattern (literal fallback with a named note), a single-file `path`, a
 * directory `path`, the skipped directories, the walk bounds (2 MiB, depth 32),
 * the 100-line cap notice, no-match, and the catastrophic-pattern bound.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalShellBackend } from "deepagents";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { ToolMessage } from "@langchain/core/messages";
import fs from "node:fs/promises";
import path from "node:path";
import { hermeticTmp } from "../test-hermetic.js";
import { buildCoreTools } from "./builtin.js";

function byName(tools: StructuredToolInterface[], name: string): StructuredToolInterface {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}
async function call(tool: StructuredToolInterface, args: unknown): Promise<string> {
  const out = await tool.invoke(args as never);
  return out instanceof ToolMessage ? String(out.content) : String(out);
}

describe("search_contents real regex (§8.2)", () => {
  let ws: string;
  let tools: StructuredToolInterface[];
  const search = (args: unknown): Promise<string> => call(byName(tools, "search_contents"), args);

  beforeEach(async () => {
    ws = hermeticTmp("search-regex");
    await fs.writeFile(path.join(ws, "doc.md"), "# Open docs\nread the README\na doc.s line\n");
    await fs.writeFile(path.join(ws, "notes.txt"), "DOCS and readme both here\n  # Open indented\n");
    await fs.mkdir(path.join(ws, "sub"), { recursive: true });
    await fs.writeFile(path.join(ws, "sub", "code.ts"), "export const README = 1;\n");
    tools = buildCoreTools(new LocalShellBackend({ rootDir: ws }), {
      workspaceMaxReadLines: 2000,
      workspaceMapDepth: 5,
    });
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("alternation matches either branch", async () => {
    const out = await search({ pattern: "docs|README" });
    expect(out).toContain("doc.md:1:# Open docs");
    expect(out).toContain("doc.md:2:read the README");
    expect(out).toContain("sub/code.ts:1:export const README = 1;");
  });

  it("a line anchor only matches at line start", async () => {
    const out = await search({ pattern: "^# Open" });
    expect(out).toBe("doc.md:1:# Open docs");
    // The indented "# Open" line is NOT anchored at column 0.
    expect(out).not.toContain("notes.txt");
  });

  it("`.` is any char but `\\.` is a literal dot", async () => {
    const anyChar = await search({ pattern: "doc.s" });
    expect(anyChar).toContain("doc.md:3:a doc.s line"); // matches "doc.s" (the dot is literal here too)
    const literalDot = await search({ pattern: "doc\\.s" });
    expect(literalDot).toContain("doc.md:3:a doc.s line");
    // `.` matches the space in a line that has no literal "docXs"
    const spaceMatch = await search({ pattern: "DOCS.and" });
    expect(spaceMatch).toContain("notes.txt:1:");
  });

  it("a leading (?i) is case-insensitive", async () => {
    const out = await search({ pattern: "(?i)readme" });
    expect(out).toContain("doc.md:2:read the README");
    expect(out).toContain("sub/code.ts:1:");
  });

  it("an invalid regex is searched literally with a note naming the error", async () => {
    await fs.writeFile(path.join(ws, "lit.txt"), "a [ bracket line\n");
    const out = await search({ pattern: "[" });
    expect(out).toMatch(/^ℹ '\[' is not a valid regular expression \(.+\); searched as literal text\./);
    expect(out).toContain("lit.txt:1:a [ bracket line");
  });

  it("a path naming one file returns matches from that file only", async () => {
    const out = await search({ pattern: "README", path: "doc.md" });
    expect(out).toBe("doc.md:2:read the README");
    expect(out).not.toContain("sub/code.ts");
  });

  it("a directory path restricts the search to that subtree", async () => {
    const out = await search({ pattern: "README", path: "sub" });
    expect(out).toBe("sub/code.ts:1:export const README = 1;");
  });

  it("reports no match plainly", async () => {
    expect(await search({ pattern: "zzz-absent-zzz" })).toBe("No matches found.");
  });

  it("skips node_modules/.git/dist and files over 2 MiB", async () => {
    for (const d of ["node_modules", ".git", "dist"]) {
      await fs.mkdir(path.join(ws, d), { recursive: true });
      await fs.writeFile(path.join(ws, d, "x.ts"), "NEEDLE_SKIP\n");
    }
    await fs.writeFile(path.join(ws, "huge.txt"), "NEEDLE_SKIP\n" + "x".repeat(3 * 1024 * 1024));
    expect(await search({ pattern: "NEEDLE_SKIP" })).toBe("No matches found.");
  });

  it("shows the cap notice when 100 matching lines are reached", async () => {
    const body = Array.from({ length: 150 }, () => "capme").join("\n") + "\n";
    await fs.writeFile(path.join(ws, "many.txt"), body);
    const out = await search({ pattern: "capme" });
    const lines = out.split("\n");
    expect(lines.filter((l) => l.startsWith("many.txt:")).length).toBe(100);
    expect(out.endsWith("100 matches shown; narrow the pattern or path")).toBe(true);
  });

  it("does not hang on a catastrophic pattern; returns the filename fallback at the bound", async () => {
    // Lowered budget keeps a >=10x margin over a per-file read while terminating
    // the runaway match. `(a+)+$` on a long `aaa...b` line backtracks forever.
    const { LimitsCapability } = await import("../use-cases/limits-capability.js");
    const { resolveLimits } = await import("../entities/limits-resolve.js");
    const { EventBus } = await import("../entities/event-bus.js");
    const limits = new LimitsCapability(
      resolveLimits([{ layer: "project", limits: { tools: { searchTimeoutMs: 150 } } }]),
      new EventBus(),
    );
    const tools2 = buildCoreTools(new LocalShellBackend({ rootDir: ws }), {
      workspaceMaxReadLines: 2000,
      workspaceMapDepth: 5,
      limits,
    });
    await fs.writeFile(path.join(ws, "aaa-slow.txt"), "a".repeat(60_000) + "b\n");
    const started = Date.now();
    const out = await call(byName(tools2, "search_contents"), { pattern: "(a+)+$" });
    const elapsed = Date.now() - started;
    // Returned via the filename fallback at the (lowered 150 ms) bound; the
    // content scan itself would never terminate. A large margin under a hang.
    expect(out).toContain("content search timed out");
    expect(elapsed).toBeLessThan(5_000);
  }, 20_000);
});
