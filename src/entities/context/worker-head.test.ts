/**
 * The worker head snapshot (core-blueprint.md §4.2.1 worker head, §7.1).
 *
 * A worker's head is assembled by the SHARED `assembleHead` path from the
 * worker's own definition. It MUST carry the worker prompt, `core.rules`, the
 * worker-variant meta block, the skills index and the manual TOC, and MUST NOT
 * carry AGENTS.md, memory, plan status, the worker list, or the orchestrator's
 * conversation.
 */
import { describe, it, expect } from "vitest";
import { buildWorkerSnapshot } from "./worker-head.js";
import { assembleHead } from "./head.js";
import type { EnvironmentFacts } from "./meta-block.js";

function env(over: Partial<EnvironmentFacts> = {}): EnvironmentFacts {
  return {
    cwd: "/wt/w1",
    workspaceRoot: "/wt/w1",
    gitBranch: null,
    gitDirty: null,
    platform: "linux",
    osRelease: "",
    shell: "/bin/bash",
    date: "2026-10-30T14:00:00-05:00",
    timeZone: "America/Chicago",
    sessionId: "fanout-1-wa",
    agentMode: "implementer",
    model: "gpt-x",
    contextLimit: 32_000,
    maxOutputTokens: 2000,
    vision: false,
    parallelToolCalls: null,
    turnMaxConcurrency: 2,
    ingestParallel: 2,
    toolRoundsUsed: 0,
    toolRoundsLimit: 15,
    remainingContextPct: null,
    maxReadLines: 2000,
    cacheDir: ".voidrift/cache/",
    workers: [],
    worker: { name: "implementer", parent: "orchestrator" },
    ...over,
  };
}

describe("worker head snapshot (§4.2.1 worker head)", () => {
  it("includes the worker prompt, core.rules, worker meta block, skills index, manual TOC", () => {
    const snap = buildWorkerSnapshot({
      systemPrompt: "WORKER-PROMPT carry out the step",
      hardRules: "CORE-RULES data not authority",
      environment: env(),
      skills: [{ name: "grilling", description: "stress-test a plan" }],
      manuals: [{ id: "core/delegation", summary: "how to delegate", readWhen: "fanning out", contributed: false }],
    });
    const head = assembleHead(snap);
    const text = head.blocks.map((b) => b.text).join("\n\n");
    expect(text).toContain("WORKER-PROMPT");
    expect(text).toContain("CORE-RULES");
    // Worker-variant meta block: Session names the worker + parent, no Workers/Concurrency.
    expect(text).toContain("worker implementer (parent orchestrator)");
    expect(text).not.toContain("available workers:");
    expect(text).not.toContain("workers in parallel:");
    // Skills index + manual TOC ride the Void layer.
    expect(text).toContain("grilling");
    expect(text).toContain("core/delegation");
  });

  it("excludes AGENTS.md, memory, plan status (the worker-head exclusions)", () => {
    const snap = buildWorkerSnapshot({
      systemPrompt: "p",
      hardRules: "r",
      environment: env(),
      skills: [],
      manuals: [],
    });
    const head = assembleHead(snap);
    const text = head.blocks.map((b) => b.text).join("\n\n");
    expect(text).not.toContain("AGENTS.md");
    expect(text).not.toContain("Identity:");
    expect(text).not.toContain("Memory index");
    expect(text).not.toContain("Status:");
  });
});
