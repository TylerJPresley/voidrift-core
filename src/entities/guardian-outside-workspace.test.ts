/**
 * Guardian `outside-workspace` force-ask classification (core-blueprint.md §9.3).
 *
 * `cd /etc && ls`, `cat /etc/passwd`, `ls /tmp` force-ask with
 * `forceAskKind: "outside-workspace"`; `cd sub && ls`, `cat ./README.md`,
 * `node -e '…'` keep their existing class; an exact whole-command allow lifts it.
 */
import { describe, it, expect } from "vitest";
import { Guardian, builtinGuardrails, type ShellLists } from "./guardian.js";
import {
  DEFAULT_SHELL_SAFE,
  DEFAULT_SHELL_FORCE_ASK,
  DEFAULT_SHELL_EQUIVALENTS,
  type PermissionRule,
} from "../config/schema.js";

const lists: ShellLists = {
  safe: DEFAULT_SHELL_SAFE,
  forceAsk: DEFAULT_SHELL_FORCE_ASK,
  equivalents: DEFAULT_SHELL_EQUIVALENTS,
  deny: [],
};
const WS = "/ws";
const guardian = new Guardian(builtinGuardrails());

function evalCmd(command: string, rules: PermissionRule[] = [], tool = "execute_command") {
  return guardian.evaluate({ tool, args: { command } }, rules, lists, { workdir: WS });
}

describe("guardian outside-workspace force-ask (§9.3)", () => {
  it("force-asks a cd outside the workspace", () => {
    const out = evalCmd("cd /etc && ls");
    expect(out.decision).toBe("ask");
    expect(out.forceAsk).toBe(true);
    expect(out.forceAskKind).toBe("outside-workspace");
  });

  it("force-asks an absolute-path argument outside the workspace", () => {
    expect(evalCmd("cat /etc/passwd").forceAskKind).toBe("outside-workspace");
    expect(evalCmd("ls /tmp").forceAskKind).toBe("outside-workspace");
  });

  it("applies to a wait check the same way", () => {
    const out = evalCmd("cat /etc/passwd", [], "wait");
    expect(out.forceAskKind).toBe("outside-workspace");
  });

  it("leaves inside-workspace commands at their existing class", () => {
    expect(evalCmd("cd sub && ls").forceAskKind).toBeUndefined();
    // cat is has-equivalent → blocked with guidance (not outside-workspace).
    const cat = evalCmd("cat ./README.md");
    expect(cat.forceAskKind).toBeUndefined();
    // node -e keeps its existing (unknown) handling — not outside-workspace.
    const node = evalCmd("node -e 'console.log(1)'");
    expect(node.forceAskKind).toBeUndefined();
  });

  it("an exact whole-command allow lifts the outside-workspace force-ask", () => {
    const rule: PermissionRule = {
      tool: "execute_command",
      pattern: "cat /etc/passwd",
      decision: "allow",
      exact: true,
      priority: 0,
      source: "workspace",
    };
    const out = evalCmd("cat /etc/passwd", [rule]);
    expect(out.decision).toBe("allow");
    expect(out.forceAsk).toBe(false);
  });

  it("a wildcard allow does NOT lift it", () => {
    const rule: PermissionRule = {
      tool: "execute_command",
      pattern: "cat *",
      decision: "allow",
      priority: 0,
      source: "workspace",
    };
    expect(evalCmd("cat /etc/passwd", [rule]).forceAskKind).toBe("outside-workspace");
  });
});
