/**
 * §13.11 `tools.searchFallbackMax` — a `warn`-class cap on the filename
 * fallback that `search_contents` uses when the content grep times out. The
 * fallback is ALWAYS accepted (warn never blocks); when it drops results past
 * the cap it now emits exactly ONE `LIMIT_HIT` naming the key, alongside the
 * visible notice the model already sees. Driven over the real search tool with
 * a stub backend whose `grep` never resolves (so the timeout fires
 * deterministically) and whose `glob` returns more files than the cap.
 */
import { describe, it, expect } from "vitest";
import type { LocalShellBackend } from "deepagents";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { ToolMessage } from "@langchain/core/messages";
import { buildCoreTools } from "./builtin.js";
import { EventBus } from "../entities/event-bus.js";
import { resolveLimits } from "../entities/limits-resolve.js";
import { LimitsCapability } from "../use-cases/limits-capability.js";

function byName(tools: StructuredToolInterface[], name: string): StructuredToolInterface {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}
async function call(tool: StructuredToolInterface, args: unknown): Promise<string> {
  const out = await tool.invoke(args as never);
  return out instanceof ToolMessage ? String(out.content) : String(out);
}

/** A backend whose content grep never resolves (forces the timeout path) and
 * whose filename glob returns `fileCount` matches. */
function stubBackend(fileCount: number): LocalShellBackend {
  const files = Array.from({ length: fileCount }, (_, i) => ({ path: `f${i}.ts` }));
  return {
    grep: () => new Promise(() => {}), // never resolves → the search timer wins
    glob: async () => ({ files }),
  } as unknown as LocalShellBackend;
}

function limitsWith(overrides: Record<string, unknown>): { limits: LimitsCapability; hits: { key: string; value: number }[] } {
  const bus = new EventBus();
  const hits: { key: string; value: number }[] = [];
  bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string; value: number }));
  return { limits: new LimitsCapability(resolveLimits([{ layer: "project", limits: overrides }]), bus), hits };
}

describe("search_contents filename fallback — tools.searchFallbackMax (§13.11)", () => {
  it("drops results past the cap and emits exactly ONE LIMIT_HIT naming the key", async () => {
    // Tiny timeout so the never-resolving grep yields to the fallback at once.
    const { limits, hits } = limitsWith({ tools: { searchTimeoutMs: 1, searchFallbackMax: 2 } });
    const tools = buildCoreTools(stubBackend(5), { workspaceMaxReadLines: 2000, workspaceMapDepth: 5, limits });
    const out = await call(byName(tools, "search_contents"), { pattern: "needle" });
    // Accepted: the fallback returns the capped list with the visible notice.
    expect(out).toContain("timed out");
    expect(out.split("\n").filter((l) => /^f\d+\.ts$/.test(l)).length).toBe(2);
    // Exactly one LIMIT_HIT for the key.
    expect(hits.filter((h) => h.key === "tools.searchFallbackMax").length).toBe(1);
  });

  it("emits NO LIMIT_HIT when the fallback fits under the cap", async () => {
    const { limits, hits } = limitsWith({ tools: { searchTimeoutMs: 1, searchFallbackMax: 10 } });
    const tools = buildCoreTools(stubBackend(3), { workspaceMaxReadLines: 2000, workspaceMapDepth: 5, limits });
    const out = await call(byName(tools, "search_contents"), { pattern: "needle" });
    expect(out).toContain("timed out");
    expect(hits.filter((h) => h.key === "tools.searchFallbackMax").length).toBe(0);
  });
});

describe("search_contents timeout — tools.searchTimeoutMs (§13.11, §8.2)", () => {
  it("fires exactly ONE LIMIT_HIT naming tools.searchTimeoutMs when the wall-clock budget fires", async () => {
    // A tiny timeout + a never-resolving grep forces the timeout path.
    const { limits, hits } = limitsWith({ tools: { searchTimeoutMs: 1, searchFallbackMax: 100 } });
    const tools = buildCoreTools(stubBackend(2), { workspaceMaxReadLines: 2000, workspaceMapDepth: 5, limits });
    const out = await call(byName(tools, "search_contents"), { pattern: "needle" });
    expect(out).toContain("timed out");
    const keyHits = hits.filter((h) => h.key === "tools.searchTimeoutMs");
    expect(keyHits.length).toBe(1);
  });

  it("fires NO tools.searchTimeoutMs LIMIT_HIT when the grep returns before the budget", async () => {
    const { limits, hits } = limitsWith({ tools: { searchTimeoutMs: 10_000, searchFallbackMax: 100 } });
    // A backend whose grep resolves immediately (no timeout).
    const backend = {
      grep: async () => ({ matches: [{ path: "a.ts", line: 1, text: "needle" }] }),
      glob: async () => ({ files: [] }),
    } as unknown as LocalShellBackend;
    const tools = buildCoreTools(backend, { workspaceMaxReadLines: 2000, workspaceMapDepth: 5, limits });
    const out = await call(byName(tools, "search_contents"), { pattern: "needle" });
    expect(out).toContain("a.ts:1:needle");
    expect(hits.filter((h) => h.key === "tools.searchTimeoutMs").length).toBe(0);
  });
});
