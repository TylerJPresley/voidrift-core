/**
 * Persist-rule builder tests (§9.2, Slice C3). The CORE builds the exact rule
 * and a deterministic, readable id so an identical approval is idempotent.
 */
import { describe, it, expect } from "vitest";
import { buildPersistRule } from "./persist-rule.js";

describe("buildPersistRule (§9.2)", () => {
  it("builds a command/path rule with the pattern and the exact tool name", () => {
    // Given a shell/file tool and a chosen command glob.
    // When the rule is built.
    const { id, rule } = buildPersistRule("execute_command", "git status*", false);
    // Then it is an allow rule at priority 0, source workspace, pattern carried.
    expect(rule).toEqual({
      tool: "execute_command",
      pattern: "git status*",
      decision: "allow",
      priority: 0,
      source: "workspace",
    });
    expect(id).toMatch(/^allow-execute-command-[0-9a-f]{8}$/);
  });

  it("builds a TOOL-NAME glob rule (no pattern) for an MCP/plugin tool", () => {
    const { id, rule } = buildPersistRule("mcp_acme_apply", "mcp_acme_*", true);
    expect(rule).toEqual({ tool: "mcp_acme_*", decision: "allow", priority: 0, source: "workspace" });
    expect(rule.pattern).toBeUndefined();
    expect(id).toMatch(/^allow-mcp-acme-[0-9a-f]{8}$/);
  });

  it("is deterministic: the same tool+pattern always yields the same id (idempotent)", () => {
    const a = buildPersistRule("execute_command", "git status*", false);
    const b = buildPersistRule("execute_command", "git status*", false);
    expect(a.id).toBe(b.id);
  });

  it("different patterns yield different ids", () => {
    const a = buildPersistRule("execute_command", "git status*", false);
    const b = buildPersistRule("execute_command", "git log*", false);
    expect(a.id).not.toBe(b.id);
  });

  it("the id distinguishes a tool-name rule from a command rule on the same string", () => {
    // A tool-name rule hashes (glob, "") while a command rule hashes (tool, glob),
    // so the two never collide even if the glob equals the tool.
    const nameRule = buildPersistRule("x", "x", true);
    const cmdRule = buildPersistRule("x", "x", false);
    expect(nameRule.id).not.toBe(cmdRule.id);
  });

  it("builds an EXACT rule carrying exact:true and the literal pattern (owner D2a)", () => {
    const { id, rule } = buildPersistRule("execute_command", "git push --force", false, true);
    expect(rule).toEqual({
      tool: "execute_command",
      pattern: "git push --force",
      exact: true,
      decision: "allow",
      priority: 0,
      source: "workspace",
    });
    expect(id).toMatch(/^allow-execute-command-[0-9a-f]{8}$/);
  });

  it("an exact rule and a glob rule on the same tool+string get DISTINCT ids (owner D2a)", () => {
    const glob = buildPersistRule("execute_command", "git push --force", false, false);
    const exact = buildPersistRule("execute_command", "git push --force", false, true);
    expect(glob.id).not.toBe(exact.id);
  });
});
