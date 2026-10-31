/**
 * §13.11 `tools.searchFallbackMax` / `tools.searchTimeoutMs` — the `warn`-class
 * cap and the wall-clock bound on the `search_contents` filename fallback.
 *
 * `search_contents` scans file CONTENTS with a real JS regex in a worker thread
 * (builtin/search-contents.ts). When a catastrophically-backtracking pattern
 * does not finish inside `tools.searchTimeoutMs` the worker is terminated and
 * the tool falls back to a glob-based FILENAME search, ALWAYS accepted (warn
 * never blocks) and capped at `tools.searchFallbackMax`. When the cap drops
 * results it emits exactly ONE `LIMIT_HIT` naming the key, alongside the visible
 * notice the model sees; the timeout itself emits exactly ONE `LIMIT_HIT` for
 * `tools.searchTimeoutMs`. Driven over a REAL `LocalShellBackend` with a runaway
 * pattern on a long line (so the bound fires deterministically) and a lowered
 * timeout that keeps a large margin over the per-file read.
 */
import { describe, it, expect, afterEach } from "vitest";
import { LocalShellBackend } from "deepagents";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { ToolMessage } from "@langchain/core/messages";
import { writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import path from "node:path";
import { hermeticTmp } from "../test-hermetic.js";
import { buildCoreTools } from "./builtin.js";
import { EventBus } from "../entities/event-bus.js";
import { resolveLimits } from "../entities/limits-resolve.js";
import { LimitsCapability } from "../use-cases/limits-capability.js";

// A catastrophically-backtracking pattern on a long line never finishes inside
// the lowered budget; its literal run (`a`) makes the fallback glob `*a*`, which
// matches the seeded `a-*.ts` files below.
const CATASTROPHIC = "(a+)+$";
const LONG_LINE = "a".repeat(60_000) + "b";

function byName(tools: StructuredToolInterface[], name: string): StructuredToolInterface {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}
async function call(tool: StructuredToolInterface, args: unknown): Promise<string> {
  const out = await tool.invoke(args as never);
  return out instanceof ToolMessage ? String(out.content) : String(out);
}

const workspaces: string[] = [];
/** A real backend over a temp workspace seeded with a runaway line and
 * `fileCount` files whose names the `*a*` fallback glob matches. */
function realBackend(fileCount: number): LocalShellBackend {
  const ws = hermeticTmp("search-fallback-hit");
  workspaces.push(ws);
  writeFileSync(path.join(ws, "slow.txt"), LONG_LINE + "\n");
  for (let i = 0; i < fileCount; i++) writeFileSync(path.join(ws, `a-file-${i}.ts`), "x\n");
  return new LocalShellBackend({ rootDir: ws });
}
afterEach(() => {
  while (workspaces.length) rmSync(workspaces.pop()!, { recursive: true, force: true });
});

function limitsWith(overrides: Record<string, unknown>): { limits: LimitsCapability; hits: { key: string; value: number }[] } {
  const bus = new EventBus();
  const hits: { key: string; value: number }[] = [];
  bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string; value: number }));
  return { limits: new LimitsCapability(resolveLimits([{ layer: "project", limits: overrides }]), bus), hits };
}

describe("search_contents filename fallback — tools.searchFallbackMax (§13.11)", () => {
  it("drops results past the cap and emits exactly ONE LIMIT_HIT naming the key", async () => {
    const { limits, hits } = limitsWith({ tools: { searchTimeoutMs: 150, searchFallbackMax: 2 } });
    const tools = buildCoreTools(realBackend(5), { workspaceMaxReadLines: 2000, workspaceMapDepth: 5, limits });
    const out = await call(byName(tools, "search_contents"), { pattern: CATASTROPHIC });
    // Accepted: the fallback returns the capped list with the visible notice.
    expect(out).toContain("timed out");
    expect(out.split("\n").filter((l) => /a-file-\d+\.ts$/.test(l)).length).toBe(2);
    // Exactly one LIMIT_HIT for the key.
    expect(hits.filter((h) => h.key === "tools.searchFallbackMax").length).toBe(1);
  });

  it("emits NO LIMIT_HIT when the fallback fits under the cap", async () => {
    const { limits, hits } = limitsWith({ tools: { searchTimeoutMs: 150, searchFallbackMax: 10 } });
    const tools = buildCoreTools(realBackend(3), { workspaceMaxReadLines: 2000, workspaceMapDepth: 5, limits });
    const out = await call(byName(tools, "search_contents"), { pattern: CATASTROPHIC });
    expect(out).toContain("timed out");
    expect(hits.filter((h) => h.key === "tools.searchFallbackMax").length).toBe(0);
  });
});

describe("search_contents timeout — tools.searchTimeoutMs (§13.11, §8.2)", () => {
  it("fires exactly ONE LIMIT_HIT naming tools.searchTimeoutMs when the wall-clock budget fires", async () => {
    const { limits, hits } = limitsWith({ tools: { searchTimeoutMs: 150, searchFallbackMax: 100 } });
    const tools = buildCoreTools(realBackend(2), { workspaceMaxReadLines: 2000, workspaceMapDepth: 5, limits });
    const out = await call(byName(tools, "search_contents"), { pattern: CATASTROPHIC });
    expect(out).toContain("timed out");
    expect(hits.filter((h) => h.key === "tools.searchTimeoutMs").length).toBe(1);
  });

  it("fires NO tools.searchTimeoutMs LIMIT_HIT when the scan returns before the budget", async () => {
    const { limits, hits } = limitsWith({ tools: { searchTimeoutMs: 10_000, searchFallbackMax: 100 } });
    const ws = hermeticTmp("search-fast");
    workspaces.push(ws);
    writeFileSync(path.join(ws, "a.ts"), "needle\n");
    const backend = new LocalShellBackend({ rootDir: ws });
    const tools = buildCoreTools(backend, { workspaceMaxReadLines: 2000, workspaceMapDepth: 5, limits });
    const out = await call(byName(tools, "search_contents"), { pattern: "needle" });
    expect(out).toBe("a.ts:1:needle");
    expect(hits.filter((h) => h.key === "tools.searchTimeoutMs").length).toBe(0);
  });
});
