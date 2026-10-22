/**
 * chat-lane entity tests (core-blueprint.md §3.1) — the WHO predicate, the
 * per-turn counter, the limit checks, the guidance wording, and the reset.
 * Pure, deterministic, offline.
 */
import { describe, it, expect } from "vitest";
import {
  CHAT_LANE_LIMITS,
  DIRECT_WRITE_TOOLS,
  laneLimited,
  laneTarget,
  laneGuidance,
  LaneCounter,
} from "./chat-lane.js";
import type { AgentDefinition } from "./subagents.js";

const topLevel = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name: "a",
  description: "d",
  kind: "top-level",
  systemPrompt: "",
  tools: ["*"],
  workers: "all",
  unlisted: "ask",
  ...over,
});

describe("laneLimited — WHO the lane applies to (§3.1)", () => {
  it("applies to the built-in chat (tools ['*'], workers 'all')", () => {
    expect(laneLimited(topLevel({ name: "chat", tools: ["*"], workers: "all" }))).toBe(true);
  });

  it("applies to a custom agent that holds a write tool AND can delegate", () => {
    expect(
      laneLimited(topLevel({ tools: ["read_file", "write_file", "task"], workers: ["implementer"] })),
    ).toBe(true);
  });

  it("does NOT apply to vibe — it holds no direct write tool", () => {
    // vibe fans out: read tools + task, no write_file/edit_file/execute_command.
    expect(
      laneLimited(topLevel({ name: "vibe", tools: ["read_file", "glob_files", "task"], workers: "all", unlisted: "allow", confirm: true })),
    ).toBe(false);
  });

  it("does NOT apply to research — it holds no write-class tool", () => {
    expect(
      laneLimited(topLevel({ name: "research", tools: ["read_file", "researcher_save_notes", "task"], workers: ["researcher"], unlisted: "deny" })),
    ).toBe(false);
  });

  it("does NOT apply to an agent that cannot delegate (no task)", () => {
    expect(laneLimited(topLevel({ tools: ["write_file"], workers: "all" }))).toBe(false);
  });

  it("does NOT apply to an agent with an empty workers list", () => {
    expect(laneLimited(topLevel({ tools: ["write_file", "task"], workers: [] }))).toBe(false);
  });

  it("does NOT apply to a worker (kind !== top-level) or undefined", () => {
    expect(laneLimited({ name: "w", description: "d", kind: "worker", systemPrompt: "", tools: ["write_file"] })).toBe(false);
    expect(laneLimited(undefined)).toBe(false);
  });
});

describe("laneTarget — the normalized target counted per call (§3.1 item ii)", () => {
  it("normalizes a file path for write_file/edit_file (./a.txt === a.txt)", () => {
    expect(laneTarget("write_file", { path: "./a.txt" })).toBe("a.txt");
    expect(laneTarget("edit_file", { path: "a.txt" })).toBe("a.txt");
  });
  it("uses the trimmed command string for execute_command", () => {
    expect(laneTarget("execute_command", { command: "  npm run build " })).toBe("npm run build");
  });
  it("is null when no target arg is present", () => {
    expect(laneTarget("write_file", {})).toBe(null);
  });
});

describe("LaneCounter.check — the limits (§3.1 items 3,5)", () => {
  it("DIRECT_WRITE_TOOLS is exactly write_file/edit_file/execute_command", () => {
    expect([...DIRECT_WRITE_TOOLS].sort()).toEqual(["edit_file", "execute_command", "write_file"]);
  });

  it("allows exactly 8 write calls; the 9th is blocked (writeCalls)", () => {
    const c = new LaneCounter();
    for (let i = 0; i < CHAT_LANE_LIMITS.writeCallsPerTurn; i++) {
      // Each with a NEW distinct target so distinctTargets is not the limiter —
      // but 8 distinct files would hit the target limit first, so re-use a small
      // set of targets to isolate the write-call limit.
      expect(c.check(0, "same.txt").blocked).toBe(false);
      c.recordExecuted("same.txt");
    }
    const d = c.check(0, "same.txt");
    expect(d.blocked).toBe(true);
    expect(d.which).toBe("writeCalls");
    expect(d.counts?.writeCalls).toBe(8);
  });

  it("allows 5 distinct files; the 6th distinct is blocked, re-editing an already-touched file is allowed (distinctTargets)", () => {
    const c = new LaneCounter();
    for (let i = 0; i < CHAT_LANE_LIMITS.distinctTargetsPerTurn; i++) {
      const t = `f${i}.txt`;
      expect(c.check(0, t).blocked).toBe(false);
      c.recordExecuted(t);
    }
    // Re-editing an ALREADY-touched file is NOT a new distinct target → allowed
    // (bounded only by the call limit, which is not yet reached at 5 calls).
    expect(c.check(0, "f0.txt").blocked).toBe(false);
    // A NEW 6th distinct target is blocked.
    const d = c.check(0, "f5.txt");
    expect(d.blocked).toBe(true);
    expect(d.which).toBe("distinctTargets");
    expect(d.counts?.distinctTargets).toBe(5);
  });

  it("blocks the next write when context share exceeds 0.35 (contextShare)", () => {
    const c = new LaneCounter();
    expect(c.check(0.35, "a.txt").blocked).toBe(false); // exactly at the cap is allowed
    const d = c.check(0.36, "a.txt");
    expect(d.blocked).toBe(true);
    expect(d.which).toBe("contextShare");
    expect(d.counts?.contextSharePct).toBe(36);
  });

  it("resets per turn / on setMode", () => {
    const c = new LaneCounter();
    for (let i = 0; i < 8; i++) c.recordExecuted(`f${i}.txt`);
    expect(c.check(0, "x.txt").blocked).toBe(true);
    c.reset();
    expect(c.check(0, "x.txt").blocked).toBe(false);
  });

  it("claimEventOnce is true once per turn, false after, true again after reset", () => {
    const c = new LaneCounter();
    expect(c.claimEventOnce()).toBe(true);
    expect(c.claimEventOnce()).toBe(false);
    c.reset();
    expect(c.claimEventOnce()).toBe(true);
  });
});

describe("laneGuidance — the exact pinned wording (§3.1 item 4)", () => {
  it("names N write calls", () => {
    expect(laneGuidance("writeCalls", { writeCalls: 8, distinctTargets: 3, contextSharePct: 10 })).toBe(
      "Direct-write limit reached for this turn (8 write calls). Delegate the remaining changes to a worker with the task tool (for example the implementer), then continue.",
    );
  });
  it("names N distinct files", () => {
    expect(laneGuidance("distinctTargets", { writeCalls: 5, distinctTargets: 5, contextSharePct: 10 })).toContain(
      "(5 distinct files)",
    );
  });
  it("names N% of context used by tool results", () => {
    expect(laneGuidance("contextShare", { writeCalls: 2, distinctTargets: 2, contextSharePct: 40 })).toContain(
      "(40% of context used by tool results)",
    );
  });
});
