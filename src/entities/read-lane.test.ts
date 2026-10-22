/**
 * read-lane entity tests (core-blueprint.md §3.3) — the WHO predicate, the
 * counter thresholds, and the one-per-turn note wording.
 */
import { describe, it, expect } from "vitest";
import {
  READ_LANE_LIMITS,
  DIRECT_READ_TOOLS,
  readLaneApplies,
  readLaneNote,
  ReadLaneCounter,
} from "./read-lane.js";
import type { AgentDefinition } from "./subagents.js";

function topLevel(p: Partial<AgentDefinition>): AgentDefinition {
  return { name: "x", description: "d", kind: "top-level", systemPrompt: "", tools: [], ...p } as AgentDefinition;
}

describe("read-lane WHO predicate (§3.3)", () => {
  it("applies to the built-in chat (reads + task + workers)", () => {
    expect(readLaneApplies(topLevel({ name: "chat", tools: ["*"], workers: "all" }))).toBe(true);
  });
  it("does NOT apply to the pure-orchestrator research (no direct read tools)", () => {
    expect(
      readLaneApplies(
        topLevel({ name: "research", tools: ["task", "researcher_save_notes"], workers: ["researcher"], unlisted: "deny" }),
      ),
    ).toBe(false);
  });
  it("does NOT apply to vibe (no direct read tools)", () => {
    expect(readLaneApplies(topLevel({ name: "vibe", tools: ["task", "write_file"], workers: "all" }))).toBe(false);
  });
  it("does NOT apply to a reader that cannot delegate (no task / no workers)", () => {
    expect(readLaneApplies(topLevel({ tools: ["read_file"], workers: [] }))).toBe(false);
    expect(readLaneApplies(topLevel({ tools: ["read_file", "task"], workers: [] }))).toBe(false);
  });
  it("never applies to a worker or undefined", () => {
    expect(readLaneApplies({ name: "w", description: "d", kind: "worker", systemPrompt: "", tools: ["read_file"] } as AgentDefinition)).toBe(false);
    expect(readLaneApplies(undefined)).toBe(false);
  });
  it("counts exactly the four local read built-ins", () => {
    expect([...DIRECT_READ_TOOLS].sort()).toEqual(["glob_files", "read_file", "search_contents", "workspace_map"]);
  });
});

describe("ReadLaneCounter thresholds (§3.3)", () => {
  it("fires the note on the NEXT result after 8 reads, once only", () => {
    const c = new ReadLaneCounter();
    // 8 reads, each preceded by a note check that returns null (under/at cross).
    for (let i = 0; i < READ_LANE_LIMITS.readCallsPerTurn; i++) {
      expect(c.noteFor(0)).toBeNull(); // before recording this read
      c.recordRead();
    }
    // The 9th call: count is 8 → note fires now, exactly once.
    const note = c.noteFor(0);
    expect(note).toBe(readLaneNote(8));
    expect(c.noteFor(0)).toBeNull(); // only once per turn
  });
  it("fires on context share over 25% before the count threshold", () => {
    const c = new ReadLaneCounter();
    c.recordRead();
    expect(c.noteFor(0.1)).toBeNull();
    expect(c.noteFor(0.3)).toBe(readLaneNote(1));
    expect(c.noteFor(0.9)).toBeNull(); // once only
  });
  it("resets per turn", () => {
    const c = new ReadLaneCounter();
    for (let i = 0; i < 8; i++) c.recordRead();
    expect(c.noteFor(0)).toBe(readLaneNote(8));
    c.reset();
    expect(c.count).toBe(0);
    expect(c.noteFor(0)).toBeNull();
  });
});
