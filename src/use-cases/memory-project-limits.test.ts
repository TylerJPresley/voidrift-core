/**
 * Project-context window-fit (core-blueprint.md §6.6, §4.8, §8.7): projectContext()
 * rides AGENTS.md WHOLE on the head (tier 1), keeping the full content, and only
 * when the merge cannot fit the window (`ingest.fitFraction` × window) does it
 * carry an ingest digest + a notice and emit one LIMIT_HIT naming the key.
 */
import { describe, it, expect } from "vitest";
import { EventBus } from "../entities/event-bus.js";
import { resolveLimits } from "../entities/limits-resolve.js";
import { LimitsCapability } from "./limits-capability.js";
import { Memory, type MemoryDeps } from "./memory.js";
import { PROJECT_OVERFLOW_MARKER, type ProjectFile } from "../entities/memory/project-context.js";

function makeDeps(
  files: ProjectFile[],
  windowTokens: number,
  extras: Partial<MemoryDeps> = {},
): MemoryDeps {
  const bus = new EventBus();
  const limits = new LimitsCapability(resolveLimits([]), bus);
  return {
    // Only projectContext() is exercised; the rest are never called here.
    store: {} as MemoryDeps["store"],
    bus,
    sessions: {} as MemoryDeps["sessions"],
    suggestions: {} as MemoryDeps["suggestions"],
    getBounds: () => ({ entryChars: 2200, reflectionBatchSize: 3 }),
    discoverProjectFiles: async () => files,
    getContextWindow: () => windowTokens,
    limits,
    ...extras,
  };
}

describe("§6.6/§4.2.1 — AGENTS.md rides the head WHOLE when it fits the window", () => {
  it("a 50k-char AGENTS.md on a 32k-token window rides whole — no overflow, no digest", async () => {
    // budget = 0.4 × 32768 × 4 ≈ 52428 chars > 50000 → fits whole.
    const files: ProjectFile[] = [{ path: "AGENTS.md", content: "x".repeat(50_000), depth: 0, scope: "workspace" }];
    const mem = new Memory(makeDeps(files, 32768));
    const ctx = await mem.projectContext();
    expect(ctx.overflow).toBe(false);
    expect(ctx.head).toContain("x".repeat(50_000));
    expect(ctx.head).not.toContain(PROJECT_OVERFLOW_MARKER);
  });

  it("does not emit a LIMIT_HIT when the merge fits the window", async () => {
    const bus = new EventBus();
    const hits: unknown[] = [];
    bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload));
    const limits = new LimitsCapability(resolveLimits([]), bus);
    const files: ProjectFile[] = [{ path: "AGENTS.md", content: "small", depth: 0, scope: "workspace" }];
    const mem = new Memory({ ...makeDeps(files, 32768), bus, limits });
    const ctx = await mem.projectContext();
    expect(ctx.overflow).toBe(false);
    expect(hits.length).toBe(0);
  });
});

describe("§6.6/§4.8/§8.7 — window-fit fan-out when the merge cannot fit the window", () => {
  // A 10.4k-char AGENTS.md on a small (4k) window: budget = 0.4 × 4096 × 4 ≈ 6553
  // chars < 10400 → cannot fit → fan-out path.
  const bigAgents: ProjectFile[] = [{ path: "AGENTS.md", content: "A".repeat(10_400), depth: 0, scope: "workspace" }];

  it("a file too large for the window keeps the full content whole and carries a marked head", async () => {
    const mem = new Memory(makeDeps(bigAgents, 4096));
    const ctx = await mem.projectContext();
    expect(ctx.overflow).toBe(true);
    expect(ctx.full).toContain("A".repeat(10_400));
    expect(ctx.head).toContain(PROJECT_OVERFLOW_MARKER);
    expect(ctx.head).toContain("limits.ingest.fitFraction");
  });

  it("emits one LIMIT_HIT naming limits.ingest.fitFraction when the merge cannot fit", async () => {
    const hits: { key: string }[] = [];
    const deps = makeDeps(bigAgents, 4096);
    (deps.bus as EventBus).subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string }));
    await new Memory(deps).projectContext();
    expect(hits.map((h) => h.key)).toContain("ingest.fitFraction");
  });

  it("the first turn kicks the ingest in the BACKGROUND and never awaits a fan-out", async () => {
    let called = 0;
    let returned = false;
    const deps = makeDeps(bigAgents, 4096, {
      projectDigest: (_merged: string, _hash: string) => {
        called++;
        return null; // miss → the real wiring fires ingest.run() fire-and-forget
      },
    });
    const ctx = await new Memory(deps).projectContext();
    returned = true;
    expect(called).toBe(1);
    expect(returned).toBe(true); // returned without awaiting any worker
    // Head carries the marked head on the first (miss) turn.
    expect(ctx.head).toContain(PROJECT_OVERFLOW_MARKER);
    expect(ctx.overflow).toBe(true);
  });

  it("the NEXT turn uses the cached digest in the head (§8.7)", async () => {
    const deps = makeDeps(bigAgents, 4096, {
      projectDigest: () => "lines 1-120: conventions, gate commands, architecture rules",
    });
    const ctx = await new Memory(deps).projectContext();
    expect(ctx.overflow).toBe(true);
    expect(ctx.head).toContain("conventions, gate commands");
    expect(ctx.head).toContain(PROJECT_OVERFLOW_MARKER);
    // The raw head of A's is NOT present when the digest is used.
    expect(ctx.head).not.toContain("A".repeat(200));
  });
});
