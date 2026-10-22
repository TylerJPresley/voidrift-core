/**
 * Subagent entity tests (core-blueprint.md §7.1) — the no-recursion assertions.
 */
import { describe, it, expect } from "vitest";
import {
  assertWorkerToolset,
  assertResolvedWorkerTools,
  findDispatchTool,
  TASK_TOOL_NAME,
  type AgentDefinition,
} from "./subagents.js";

const base: AgentDefinition = {
  name: "w",
  description: "d",
  systemPrompt: "p",
  tools: ["read_file", "write_file"],
};

describe("subagents entity — worker toolset assertions (§7.1)", () => {
  it("findDispatchTool reports the task tool when present and null otherwise", () => {
    expect(findDispatchTool([{ name: "read_file" }, { name: TASK_TOOL_NAME }])).toBe(TASK_TOOL_NAME);
    expect(findDispatchTool([{ name: "read_file" }])).toBeNull();
  });

  it("assertWorkerToolset accepts a clean definition and rejects one with the task tool", () => {
    expect(() => assertWorkerToolset(base)).not.toThrow();
    expect(() => assertWorkerToolset({ ...base, tools: ["read_file", TASK_TOOL_NAME] })).toThrow(/task/);
  });

  it("assertResolvedWorkerTools rejects resolved instances that include a task tool", () => {
    expect(() => assertResolvedWorkerTools("w", [{ name: "read_file" } as never])).not.toThrow();
    expect(() => assertResolvedWorkerTools("w", [{ name: TASK_TOOL_NAME } as never])).toThrow(/dispatch/);
  });
});
