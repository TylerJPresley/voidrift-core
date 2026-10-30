/**
 * The memory.projectChars exemplar (§13.11, §4.8, §8.7): projectContext() reads
 * its head budget from the limits registry via the port, keeps the WHOLE content
 * (never cut), and emits one LIMIT_HIT when the merge exceeds the head budget.
 */
import { describe, it, expect } from "vitest";
import { EventBus } from "../entities/event-bus.js";
import { resolveLimits } from "../entities/limits-resolve.js";
import { LimitsCapability } from "./limits-capability.js";
import { Memory, type MemoryDeps } from "./memory.js";
import { PROJECT_OVERFLOW_MARKER, type ProjectFile } from "../entities/memory/project-context.js";

function makeDeps(limits: LimitsCapability, files: ProjectFile[]): MemoryDeps {
  return {
    // Only projectContext() is exercised; the rest are never called here.
    store: {} as MemoryDeps["store"],
    bus: {} as MemoryDeps["bus"],
    sessions: {} as MemoryDeps["sessions"],
    suggestions: {} as MemoryDeps["suggestions"],
    getBounds: () => ({ entryChars: 2200, projectChars: 8000, reflectionBatchSize: 3 }),
    discoverProjectFiles: async () => files,
    // An explicit projectChars configuration drives the budget and names the key.
    projectCharsConfigured: () => true,
    limits,
  };
}

describe("memory.projectChars exemplar", () => {
  it("honors a configured limits.memory.projectChars for the head budget; keeps content WHOLE", async () => {
    const bus = new EventBus();
    const resolved = resolveLimits([{ layer: "project", limits: { memory: { projectChars: 50 } } }]);
    const limits = new LimitsCapability(resolved, bus);
    const files: ProjectFile[] = [{ path: "AGENTS.md", content: "x".repeat(500), depth: 0, scope: "workspace" }];
    const mem = new Memory(makeDeps(limits, files));
    const ctx = await mem.projectContext();
    expect(ctx.overflow).toBe(true);
    expect(ctx.limit).toBe(50);
    // The FULL text is never cut — every char survives.
    expect(ctx.full).toContain("x".repeat(500));
    // The HEAD is reduced and names the key.
    expect(ctx.digest).toContain(PROJECT_OVERFLOW_MARKER);
  });

  it("emits one LIMIT_HIT naming limits.memory.projectChars on overflow", async () => {
    const bus = new EventBus();
    const hits: { key: string; value: number }[] = [];
    bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string; value: number }));
    const resolved = resolveLimits([{ layer: "project", limits: { memory: { projectChars: 50 } } }]);
    const limits = new LimitsCapability(resolved, bus);
    const files: ProjectFile[] = [{ path: "AGENTS.md", content: "y".repeat(500), depth: 0, scope: "workspace" }];
    const mem = new Memory(makeDeps(limits, files));
    await mem.projectContext();
    expect(hits.length).toBe(1);
    expect(hits[0]?.key).toBe("memory.projectChars");
    expect(hits[0]?.value).toBe(50);
  });

  it("does not emit when the merge fits", async () => {
    const bus = new EventBus();
    const hits: unknown[] = [];
    bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload));
    const resolved = resolveLimits([]);
    const limits = new LimitsCapability(resolved, bus);
    const files: ProjectFile[] = [{ path: "AGENTS.md", content: "small", depth: 0, scope: "workspace" }];
    const mem = new Memory(makeDeps(limits, files));
    const ctx = await mem.projectContext();
    expect(ctx.overflow).toBe(false);
    expect(hits.length).toBe(0);
  });
});

describe("§6.6/§4.8/§8.7 — fit-fraction head budget and non-blocking digest", () => {
  // A 10.4k-char AGENTS.md (the owner's real size).
  const bigAgents: ProjectFile[] = [{ path: "AGENTS.md", content: "A".repeat(10_400), depth: 0, scope: "workspace" }];

  function makeFractionDeps(
    files: ProjectFile[],
    windowTokens: number,
    extras: Partial<MemoryDeps> = {},
  ): MemoryDeps {
    const bus = new EventBus();
    // ingest.fitFraction = 0.4 default, projectChars unset → the fit test drives
    // the head budget (ingest.fitFraction × window).
    const resolved = resolveLimits([]);
    const limits = new LimitsCapability(resolved, bus);
    return {
      store: {} as MemoryDeps["store"],
      bus,
      sessions: {} as MemoryDeps["sessions"],
      suggestions: {} as MemoryDeps["suggestions"],
      getBounds: () => ({ entryChars: 2200, projectChars: 8000, reflectionBatchSize: 3 }),
      discoverProjectFiles: async () => files,
      projectCharsConfigured: () => false,
      getContextWindow: () => windowTokens,
      limits,
      ...extras,
    };
  }

  it("a 10.4k AGENTS.md on a small (4k) window overflows: head-with-marker, full kept whole", async () => {
    // budget = 0.4 × 4096 × 4 ≈ 6553 chars < 10400 → overflow.
    const mem = new Memory(makeFractionDeps(bigAgents, 4096));
    const ctx = await mem.projectContext();
    expect(ctx.overflow).toBe(true);
    expect(ctx.full).toContain("A".repeat(10_400));
    expect(ctx.digest).toContain(PROJECT_OVERFLOW_MARKER);
    expect(ctx.digest).toContain("limits.ingest.fitFraction");
  });

  it("the SAME 10.4k AGENTS.md on a 32k window fits (no overflow) but rides a reduced head digest", async () => {
    // budget = 0.4 × 32768 × 4 ≈ 52428 chars > 10400 → fits, no overflow. The
    // head still carries a REAL digest, not the whole body (§4.2.1 tier 2).
    const mem = new Memory(makeFractionDeps(bigAgents, 32768));
    const ctx = await mem.projectContext();
    expect(ctx.overflow).toBe(false);
    expect(ctx.full).toContain("A".repeat(10_400));
    expect(ctx.digest.length).toBeLessThan(ctx.full.length);
    expect(ctx.digest).not.toContain(PROJECT_OVERFLOW_MARKER);
  });

  it("names limits.ingest.fitFraction (not projectChars) when the fit test drives the budget", async () => {
    const hits: { key: string }[] = [];
    const deps = makeFractionDeps(bigAgents, 4096);
    (deps.bus as EventBus).subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string }));
    await new Memory(deps).projectContext();
    expect(hits.map((h) => h.key)).toContain("ingest.fitFraction");
  });

  it("the first turn kicks the ingest in the BACKGROUND and never awaits a fan-out", async () => {
    let called = 0;
    let returned = false;
    // projectDigest returns null (cache miss) and records the background kick.
    const deps = makeFractionDeps(bigAgents, 4096, {
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
    expect(ctx.digest).toContain(PROJECT_OVERFLOW_MARKER);
    expect(ctx.overflow).toBe(true);
  });

  it("the NEXT turn uses the cached digest in the head (§8.7)", async () => {
    const deps = makeFractionDeps(bigAgents, 4096, {
      projectDigest: () => "lines 1-120: conventions, gate commands, architecture rules",
    });
    const ctx = await new Memory(deps).projectContext();
    expect(ctx.overflow).toBe(true);
    expect(ctx.digest).toContain("conventions, gate commands");
    expect(ctx.digest).toContain(PROJECT_OVERFLOW_MARKER);
    // The raw head of A's is NOT present when the digest is used.
    expect(ctx.digest).not.toContain("A".repeat(200));
  });
});

describe("memory.projectDigestMaxChars is live through the real memory path (§4.2.1/§13.11)", () => {
  // A multi-section AGENTS.md that FITS a large head budget, so the head rides
  // the structural digest whose length memory.projectDigestMaxChars bounds.
  const content = [
    "# AGENTS.md",
    "Lead paragraph describing the project in one sentence. More detail here.",
    "## Build",
    "Run the gate before committing. It builds, tests and lints every package.",
    "## Testing",
    "Everything is tested. A bug fix carries a regression test written first.",
    "## Conventions",
    "All configuration files are JSON and prose is Markdown throughout the repo.",
  ].join("\n");
  const files: ProjectFile[] = [{ path: "AGENTS.md", content, depth: 0, scope: "workspace" }];

  async function headFor(digestMaxChars?: number): Promise<string> {
    const bus = new EventBus();
    // Large projectChars so the content fits the head budget (digest rides, no
    // overflow); the digest cap is the only thing that varies.
    const layers: Parameters<typeof resolveLimits>[0] = [
      {
        layer: "project",
        limits: {
          memory: {
            projectChars: 100_000,
            ...(digestMaxChars !== undefined ? { projectDigestMaxChars: digestMaxChars } : {}),
          },
        },
      },
    ];
    const limits = new LimitsCapability(resolveLimits(layers), bus);
    const mem = new Memory(makeDeps(limits, files));
    const ctx = await mem.projectContext();
    expect(ctx.overflow).toBe(false);
    return ctx.digest;
  }

  it("a config override of the key shortens the head digest through projectContext()", async () => {
    const wide = await headFor(2000);
    const tight = await headFor(40);
    expect(tight.length).toBeLessThan(wide.length);
  });

  it("the unset default matches the explicit registry default (byte-identical)", async () => {
    const unset = await headFor(undefined);
    const atDefault = await headFor(2000);
    expect(unset).toBe(atDefault);
  });
});
