import { describe, it, expect } from "vitest";
import { Guardian, builtinGuardrails, type ShellLists, type GuardianEvalOptions } from "./guardian.js";
import { DEFAULT_SHELL_SAFE, DEFAULT_SHELL_FORCE_ASK, DEFAULT_SHELL_EQUIVALENTS } from "../config/schema.js";
import type { PermissionRule } from "../config/schema.js";

const lists: ShellLists = {
  safe: DEFAULT_SHELL_SAFE,
  forceAsk: DEFAULT_SHELL_FORCE_ASK,
  equivalents: DEFAULT_SHELL_EQUIVALENTS,
  deny: [],
};

const OPTS: GuardianEvalOptions = {
  controlPath: { workspaceRoot: "/ws", globalConfigDir: "/home/u/.config/voidrift", home: "/home/u" },
};

const guardian = new Guardian(builtinGuardrails());
const evalCmd = (command: string, rules: PermissionRule[] = []) =>
  guardian.evaluate({ tool: "execute_command", args: { command } }, rules, lists, OPTS);
const evalWrite = (path: string, rules: PermissionRule[] = []) =>
  guardian.evaluate({ tool: "write_file", args: { path, content: "x" } }, rules, lists, OPTS);

describe("control-file protection — the five audited ALLOWs now DENY or FORCE-ASK (§8.4, SECURITY)", () => {
  it("`echo x > .voidrift/config.json` is DENIED (deny class, no prompt)", () => {
    const out = evalCmd("echo x > .voidrift/config.json");
    expect(out.decision).toBe("deny");
    expect(out.reason).toMatch(/control file/i);
  });

  it("`echo x > ~/.config/voidrift/config.json` is DENIED", () => {
    expect(evalCmd("echo x > ~/.config/voidrift/config.json").decision).toBe("deny");
  });

  it("`echo x > $HOME/.config/voidrift/config.json` is DENIED", () => {
    expect(evalCmd("echo x > $HOME/.config/voidrift/config.json").decision).toBe("deny");
  });

  it("`echo x > .voidrift/agents/chat/prompt.md` is a control-file FORCE-ASK", () => {
    const out = evalCmd("echo x > .voidrift/agents/chat/prompt.md");
    expect(out.decision).toBe("ask");
    expect(out.forceAsk).toBe(true);
    expect(out.forceAskKind).toBe("control-file");
  });

  it("`echo x > .git/hooks/pre-commit` is a control-file FORCE-ASK", () => {
    const out = evalCmd("echo x > .git/hooks/pre-commit");
    expect(out.decision).toBe("ask");
    expect(out.forceAskKind).toBe("control-file");
  });
});

describe("control-file protection — write_file / edit_file on each class", () => {
  it("deny class (config.json) → deny", () => {
    expect(evalWrite(".voidrift/config.json").decision).toBe("deny");
  });
  it("ask class (AGENTS.md) → force-ask control-file", () => {
    const out = evalWrite("AGENTS.md");
    expect(out.decision).toBe("ask");
    expect(out.forceAskKind).toBe("control-file");
  });
  it("ask class (agent prompt) → force-ask control-file", () => {
    expect(evalWrite(".voidrift/agents/chat/prompt.md").forceAskKind).toBe("control-file");
  });
  it("ordinary file → ask (no rule), not a force-ask", () => {
    const out = evalWrite("src/index.ts");
    expect(out.forceAsk).toBe(false);
  });
});

describe("control-file protection — exact-rule lift for an ask-class file", () => {
  it("an EXACT write_file rule lifts the AGENTS.md control-file force-ask", () => {
    const rules: PermissionRule[] = [
      { tool: "write_file", pattern: "AGENTS.md", exact: true, decision: "allow", priority: 0, source: "workspace" },
    ];
    const out = evalWrite("AGENTS.md", rules);
    expect(out.decision).toBe("allow");
    expect(out.exactLift).toBe(true);
  });

  it("a GLOB write_file rule does NOT lift the force-ask", () => {
    const rules: PermissionRule[] = [
      { tool: "write_file", pattern: "*", decision: "allow", priority: 0, source: "workspace" },
    ];
    expect(evalWrite("AGENTS.md", rules).decision).toBe("ask");
  });

  it("a deny rule beats everything on an ask-class path", () => {
    const rules: PermissionRule[] = [
      { tool: "write_file", pattern: "AGENTS.md", exact: true, decision: "allow", priority: 0, source: "workspace" },
      { tool: "write_file", decision: "deny", priority: 0, source: "workspace" },
    ];
    expect(evalWrite("AGENTS.md", rules).decision).toBe("deny");
  });
});

describe("control-file protection — write-shaped shell targets", () => {
  it("`tee .voidrift/config.json` is DENIED", () => {
    expect(evalCmd("echo x | tee .voidrift/config.json").decision).toBe("deny");
  });
  it("`cp evil .git/hooks/pre-commit` is a control-file FORCE-ASK", () => {
    expect(evalCmd("cp evil .git/hooks/pre-commit").forceAskKind).toBe("control-file");
  });
  it("`sed -i s/a/b/ AGENTS.md` is a control-file FORCE-ASK", () => {
    expect(evalCmd("sed -i s/a/b/ AGENTS.md").forceAskKind).toBe("control-file");
  });
  it("`git config core.hooksPath /tmp/evil` is a control-file FORCE-ASK (.git/config)", () => {
    expect(evalCmd("git config core.hooksPath /tmp/evil").forceAskKind).toBe("control-file");
  });
  it("a READ is unaffected (`cat .voidrift/config.json` classifies via equivalents, not control-file)", () => {
    const out = evalCmd("cat .voidrift/config.json");
    // cat is a has-equivalent → deny with the first-class-tool guidance, NOT the
    // control-file deny sentence.
    expect(out.reason ?? "").not.toMatch(/would change a VoidRift control file/);
  });
  it("a variable target cannot be resolved statically → ordinary classification (not control-file)", () => {
    const out = evalCmd("echo x > $TARGET");
    expect(out.forceAskKind).not.toBe("control-file");
  });
  it("an exact whole-command rule lifts a write-shaped ask-class command", () => {
    const cmd = "cp evil .git/hooks/pre-commit";
    const rules: PermissionRule[] = [
      { tool: "execute_command", pattern: cmd, exact: true, decision: "allow", priority: 0, source: "workspace" },
    ];
    expect(evalCmd(cmd, rules).decision).toBe("allow");
  });
});
