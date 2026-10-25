import { describe, it, expect } from "vitest";
import { READ_CLASS_TOOLS, deriveAgentClass } from "./subagents.js";
import type { AgentDefinition } from "./subagents.js";

describe("READ_CLASS_TOOLS — read_manual classification (§3.1, §9, §12.8)", () => {
  it("(b) read_manual is in READ_CLASS_TOOLS", () => {
    expect(READ_CLASS_TOOLS.has("read_manual")).toBe(true);
  });

  it("(b) a worker with read_manual and only read-class tools derives as read", () => {
    const def: AgentDefinition = {
      name: "researcher",
      kind: "worker",
      systemPrompt: "research",
      tools: ["read_file", "read_manual", "list_skills"],
      description: "test",
    };
    expect(deriveAgentClass(def)).toBe("read");
  });

  it("(b) a worker with read_manual but also write_file derives as write (fail closed)", () => {
    const def: AgentDefinition = {
      name: "editor",
      kind: "worker",
      systemPrompt: "edit",
      tools: ["read_manual", "write_file"],
      description: "test",
    };
    expect(deriveAgentClass(def)).toBe("write");
  });

  it("(b) a top-level agent with read_manual only derives as read", () => {
    const def: AgentDefinition = {
      name: "manual-reader",
      kind: "top-level",
      systemPrompt: "read manuals",
      tools: ["read_manual", "list_skills"],
      description: "test",
    };
    expect(deriveAgentClass(def)).toBe("read");
  });
});
