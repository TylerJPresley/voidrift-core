/**
 * Head assembly (core-blueprint.md §4.2, §4.2.1, §4.3) — three layers, four
 * tiers, the cap, degradation, cache-break blocks, and the turn-metadata tail.
 */
import { describe, it, expect } from "vitest";
import { assembleHead, appendTurnMetadata } from "./head.js";
import { emptySnapshot, type EnvironmentFacts, type ContextSnapshot } from "./snapshot.js";

const env: EnvironmentFacts = {
  cwd: "/ws",
  workspaceRoot: "/ws",
  gitBranch: "main",
  gitDirty: "clean",
  platform: "linux",
  osRelease: "6.1.0",
  shell: "/bin/bash",
  date: "2026-10-21T16:10:01-05:00",
  timeZone: "UTC",
  sessionId: "s1",
  agentMode: "chat",
  model: "m",
  contextLimit: 16_000,
  maxOutputTokens: 2000,
  vision: false,
  parallelToolCalls: null,
  turnMaxConcurrency: 4,
  ingestParallel: 4,
  toolRoundsUsed: 0,
  toolRoundsLimit: 15,
  remainingContextPct: 0,
  maxReadLines: 2000,
  cacheDir: ".voidrift/cache/",
  workers: [],
};

function full(): ContextSnapshot {
  const s = emptySnapshot(env);
  s.systemPrompt = "You are VoidRift.";
  s.hardRules = "HARD RULES: never leak secrets.";
  s.identityMemory = "The user is Alex.";
  s.planStatus = "building slice 2";
  s.digests = [
    { label: "AGENTS.md", digest: "D".repeat(400), pointer: ".voidrift/cache/session/s1/agents.md" },
    { label: "Directive memory", digest: "M".repeat(200), pointer: ".voidrift/cache/session/s1/directive.md" },
  ];
  s.documents = [{ name: "a.ts", path: "src/a.ts", size: 10, trust: "live", stale: false }];
  s.skills = [{ name: "review", description: "review code" }];
  s.referenceMemory = [{ key: "api-notes", summary: "REST API conventions", keywords: ["api", "rest"] }];
  s.voidProviderBlocks = ["plan: 2/5 tasks done"];
  s.turnMetadataBlocks = ["Injected: focus on §4"];
  return s;
}

describe("session meta block in the head (§4.4)", () => {
  it("rides the Agent layer with the data-not-authority header and location/concurrency", () => {
    const head = assembleHead(full(), 1600);
    const agent = head.blocks.find((b) => b.layer === "agent")!;
    expect(agent.text.toLowerCase()).toContain("session data");
    expect(agent.text).toContain("PWD / workspace root: /ws");
    expect(agent.text).toContain("workers in parallel: 4");
    expect(head.metaDropped).toEqual([]);
  });

  it("drops meta fields and reports metaDropped under a tiny metaBlockMaxTokens", () => {
    const head = assembleHead(full(), 1600, 55);
    expect(head.metaDropped.length).toBeGreaterThan(0);
    expect(head.metaDropped[0]).toBe("cache dir");
    const agent = head.blocks.find((b) => b.layer === "agent")!;
    // kept-last fields survive
    expect(agent.text).toContain("PWD / workspace root: /ws");
    expect(agent.text).toContain("workers in parallel:");
  });
});

describe("head assembly (§4.2.1, §4.3)", () => {
  it("builds Agent and Void cache-break blocks within a generous cap", () => {
    const head = assembleHead(full(), 1600);
    const agent = head.blocks.find((b) => b.layer === "agent")!;
    const voidB = head.blocks.find((b) => b.layer === "void")!;
    // Agent carries inline-always + digests; Void carries manifests
    expect(agent.text).toContain("You are VoidRift.");
    expect(agent.text).toContain("HARD RULES");
    expect(agent.text).toContain("AGENTS.md");
    expect(agent.text).toContain(".voidrift/cache/session/s1/agents.md");
    expect(voidB.text).toContain("src/a.ts");
    expect(voidB.text).toContain("review");
    // cache boundaries fall on the Agent and Void blocks (§4.3)
    expect(agent.cacheBoundary).toBe(true);
    expect(voidB.cacheBoundary).toBe(true);
    // manifest carries no body
    expect(voidB.text).not.toContain("DDDD");
  });

  it("degrades lower tiers first when over the cap; never drops inline/hard rules", () => {
    // Given a tiny cap
    const head = assembleHead(full(), 60);
    expect(head.degraded).toBe(true);
    const agent = head.blocks.find((b) => b.layer === "agent")!;
    // inline-always and hard rules survive
    expect(agent.text).toContain("You are VoidRift.");
    expect(agent.text).toContain("HARD RULES");
  });

  it("places turn metadata after the layers, not cached (§4.2)", () => {
    const head = assembleHead(full(), 1600);
    const blocks = appendTurnMetadata(head, full());
    const turn = blocks[blocks.length - 1]!;
    expect(turn.layer).toBe("turn");
    expect(turn.cacheBoundary).toBe(false);
    expect(turn.text).toContain("focus on §4");
  });

  it("reports a per-tier head split (inline/digest/manifest)", () => {
    const head = assembleHead(full(), 1600);
    expect(head.tierSplit.inline).toBeGreaterThan(0);
    expect(head.tierSplit.digest).toBeGreaterThan(0);
    expect(head.tierSplit.manifest).toBeGreaterThan(0);
  });
});
