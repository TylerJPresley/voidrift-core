import { describe, it, expect } from "vitest";
import {
  Guardian,
  builtinGuardrails,
  classifySegment,
  classifyCommand,
  commandSegmentVerdicts,
  commandAllowCovers,
  splitSegments,
  inferPatterns,
  isProtectedControlFile,
  type ShellLists,
} from "./guardian.js";
import { DEFAULT_SHELL_SAFE, DEFAULT_SHELL_FORCE_ASK, DEFAULT_SHELL_EQUIVALENTS } from "../config/schema.js";
import type { PermissionRule } from "../config/schema.js";

const lists: ShellLists = {
  safe: DEFAULT_SHELL_SAFE,
  forceAsk: DEFAULT_SHELL_FORCE_ASK,
  equivalents: DEFAULT_SHELL_EQUIVALENTS,
  deny: ["shutdown.*"],
};

describe("Guardian (§9.2–§9.4)", () => {
  const guardian = new Guardian(builtinGuardrails());

  it("a read tool WITHOUT a rule asks (read-class is not a permission input, §9)", () => {
    const out = guardian.evaluate({ tool: "read_file", args: { path: "a.txt" } }, [], lists);
    expect(out.decision).toBe("ask");
  });

  it("a read tool WITH the seeded allow rule is allowed", () => {
    const rules: PermissionRule[] = [
      { tool: "read_file", decision: "allow", priority: 0, source: "default" },
    ];
    const out = guardian.evaluate({ tool: "read_file", args: { path: "a.txt" } }, rules, lists);
    expect(out.decision).toBe("allow");
  });

  it("no matching rule yields ask with inferred patterns", () => {
    const out = guardian.evaluate({ tool: "write_file", args: { path: "a/b.txt" } }, [], lists);
    expect(out.decision).toBe("ask");
    expect(out.inferredPatterns).toEqual(["a/b.txt", "a/**"]);
  });

  it("highest-priority rule wins; deny beats allow", () => {
    const rules: PermissionRule[] = [
      { tool: "write_file", pattern: "*", decision: "allow", priority: 100, source: "user" },
      { tool: "write_file", pattern: "secret/**", decision: "deny", priority: 300, source: "session" },
    ];
    const allow = guardian.evaluate({ tool: "write_file", args: { path: "a.txt" } }, rules, lists);
    expect(allow.decision).toBe("allow");
    const deny = guardian.evaluate({ tool: "write_file", args: { path: "secret/x" } }, rules, lists);
    expect(deny.decision).toBe("deny");
  });

  it("a dangerous shell command is a force-ask immune to a broad allow", () => {
    const rules: PermissionRule[] = [{ tool: "execute_command", pattern: "git *", decision: "allow", priority: 300, source: "session" }];
    const out = guardian.evaluate({ tool: "execute_command", args: { command: "git push --force" } }, rules, lists);
    expect(out.decision).toBe("ask");
    expect(out.forceAsk).toBe(true);
  });

  it("a safe command auto-approves and a has-equivalent is denied with guidance", () => {
    expect(guardian.evaluate({ tool: "execute_command", args: { command: "ls -la" } }, [], lists).decision).toBe("allow");
    const eq = guardian.evaluate({ tool: "execute_command", args: { command: "cat f" } }, [], lists);
    expect(eq.decision).toBe("deny");
    expect(eq.reason).toContain("first-class tool");
  });

  it("a hard-deny command is denied outright", () => {
    const out = guardian.evaluate({ tool: "execute_command", args: { command: "shutdown now" } }, [], lists);
    expect(out.decision).toBe("deny");
  });

  describe("plugins_install is a force-ask immune to allow rules (§12.4.1)", () => {
    const call = { tool: "plugins_install", args: { name: "@voidrift/plugin-x" } };

    it("a wildcard allow rule cannot auto-approve it — it force-asks", () => {
      const rules: PermissionRule[] = [{ tool: "*", decision: "allow", priority: 100, source: "user" }];
      const out = guardian.evaluate(call, rules, lists);
      expect(out.decision).toBe("ask");
      expect(out.forceAsk).toBe(true);
    });

    it("an explicit plugins_install allow rule cannot auto-approve it", () => {
      const rules: PermissionRule[] = [{ tool: "plugins_install", decision: "allow", priority: 500, source: "user" }];
      const out = guardian.evaluate(call, rules, lists);
      expect(out.decision).toBe("ask");
      expect(out.forceAsk).toBe(true);
    });

    it("defaults to a force-ask with no rules", () => {
      const out = guardian.evaluate(call, [], lists);
      expect(out.decision).toBe("ask");
      expect(out.forceAsk).toBe(true);
    });

    it("only an explicit top-priority deny blocks it", () => {
      const rules: PermissionRule[] = [{ tool: "plugins_install", decision: "deny", priority: 500, source: "managed" }];
      const out = guardian.evaluate(call, rules, lists);
      expect(out.decision).toBe("deny");
    });

    it("a plan scope cannot bypass it (a name-only arg never matches a scope anyway)", () => {
      const g = new Guardian(builtinGuardrails());
      g.registerScope("plan", { writeGlobs: ["**"], executePatterns: ["**"] });
      const out = g.evaluate(call, [], lists);
      expect(out.decision).toBe("ask");
      expect(out.forceAsk).toBe(true);
    });
  });

  describe("tool-name glob permission rules (§8.4, §9.2)", () => {
    it("an `mcp_x_*` tool-glob rule allows exactly the matching MCP tools and nothing else", () => {
      const rules: PermissionRule[] = [
        { tool: "mcp_github_*", decision: "allow", priority: 100, source: "user" },
      ];
      expect(guardian.evaluate({ tool: "mcp_github_create_issue", args: {} }, rules, lists).decision).toBe("allow");
      expect(guardian.evaluate({ tool: "mcp_github_list", args: {} }, rules, lists).decision).toBe("allow");
      expect(guardian.evaluate({ tool: "mcp_gitlab_create_issue", args: {} }, rules, lists).decision).toBe("ask");
      expect(guardian.evaluate({ tool: "mcp_github2_x", args: {} }, rules, lists).decision).toBe("ask");
    });

    it("a `mcp_*` tool-glob rule covers every MCP tool but not a built-in", () => {
      const rules: PermissionRule[] = [{ tool: "mcp_*", decision: "allow", priority: 100, source: "user" }];
      expect(guardian.evaluate({ tool: "mcp_github_x", args: {} }, rules, lists).decision).toBe("allow");
      expect(guardian.evaluate({ tool: "mcp_gitlab_y", args: {} }, rules, lists).decision).toBe("allow");
      expect(guardian.evaluate({ tool: "write_file", args: { path: "a.txt" } }, rules, lists).decision).toBe("ask");
    });

    it("a wildcard tool glob cannot cover a force-ask class (§9.3)", () => {
      const rules: PermissionRule[] = [{ tool: "*", decision: "allow", priority: 500, source: "user" }];
      // A force-ask that is NOT on the never list (git force-push), so the test
      // proves the wildcard-allow cannot cover a FORCE-ASK (never-list commands
      // deny outright, covered separately).
      const shell = guardian.evaluate({ tool: "execute_command", args: { command: "git push --force" } }, rules, lists);
      expect(shell.decision).toBe("ask");
      expect(shell.forceAsk).toBe(true);
      const install = guardian.evaluate({ tool: "plugins_install", args: { name: "x" } }, rules, lists);
      expect(install.decision).toBe("ask");
      expect(install.forceAsk).toBe(true);
    });

    it("a metacharacter in a tool name is escaped — a glob never becomes a regex", () => {
      const meta = "mcp_a.b+c_d(e)";
      const exact: PermissionRule[] = [{ tool: meta, decision: "allow", priority: 100, source: "user" }];
      expect(guardian.evaluate({ tool: meta, args: {} }, exact, lists).decision).toBe("allow");
      expect(guardian.evaluate({ tool: "mcp_aXbbc_dXeY", args: {} }, exact, lists).decision).toBe("ask");
      const dotStar: PermissionRule[] = [{ tool: "mcp_a.*", decision: "allow", priority: 100, source: "user" }];
      expect(guardian.evaluate({ tool: "mcp_a.anything", args: {} }, dotStar, lists).decision).toBe("allow");
      expect(guardian.evaluate({ tool: "mcp_aX", args: {} }, dotStar, lists).decision).toBe("ask");
    });

    it("an over-long tool glob rule never matches (fail-closed)", () => {
      const huge = "mcp_" + "x".repeat(2000) + "*";
      const rules: PermissionRule[] = [{ tool: huge, decision: "allow", priority: 100, source: "user" }];
      expect(guardian.evaluate({ tool: "mcp_" + "x".repeat(2000) + "_t", args: {} }, rules, lists).decision).toBe("ask");
    });
  });

  it("guardrails block an unread edit, a stale edit, a temp write, and a >50-line edit", () => {
    const base = { readPaths: new Set<string>(), stalePaths: new Set<string>(), tempDir: "/tmp" };
    // unread
    expect(
      guardian.runGuardrails({ tool: "edit_file", args: { path: "x", search: "a", replace: "b" } }, base).allowed,
    ).toBe(false);
    // read then allowed
    const read = { ...base, readPaths: new Set(["x"]) };
    expect(
      guardian.runGuardrails({ tool: "edit_file", args: { path: "x", search: "a", replace: "b" } }, read).allowed,
    ).toBe(true);
    // stale
    const stale = { readPaths: new Set(["x"]), stalePaths: new Set(["x"]), tempDir: "/tmp" };
    expect(
      guardian.runGuardrails({ tool: "edit_file", args: { path: "x", search: "a", replace: "b" } }, stale).allowed,
    ).toBe(false);
    // temp dir write
    expect(
      guardian.runGuardrails({ tool: "write_file", args: { path: "/tmp/x" } }, base).allowed,
    ).toBe(false);
    // >50 line edit
    const big = { ...base, readPaths: new Set(["x"]) };
    const search = Array.from({ length: 51 }, () => "l").join("\n");
    expect(
      guardian.runGuardrails({ tool: "edit_file", args: { path: "x", search, replace: "b" } }, big).allowed,
    ).toBe(false);
  });
});

describe("shell classification (§9.3)", () => {
  it("splits compound commands", () => {
    expect(splitSegments("a && b || c ; d | e")).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("classifies each segment type", () => {
    expect(classifySegment("ls -la", lists)).toBe("safe");
    expect(classifySegment("rm -rf /", lists)).toBe("dangerous");
    expect(classifySegment("cat f", lists)).toBe("has-equivalent");
    expect(classifySegment("shutdown now", lists)).toBe("hard-deny");
    expect(classifySegment('git commit -m "x"', lists)).toBe("unknown");
    expect(classifySegment("echo x > f", lists)).toBe("unknown");
  });

  it("the most severe segment wins for a compound command", () => {
    expect(classifyCommand("ls && rm -rf b", lists).cls).toBe("dangerous");
    expect(classifyCommand("ls && pwd", lists).cls).toBe("safe");
    expect(classifyCommand("ls && cat f", lists).cls).toBe("has-equivalent");
  });

  it("infers command and mcp patterns", () => {
    expect(inferPatterns({ tool: "execute_command", args: { command: "git commit x" } })).toEqual([
      "git *",
      "git commit *",
      "git commit x",
    ]);
    expect(inferPatterns({ tool: "mcp_fs_read", args: {} })).toEqual(["mcp_fs_*", "mcp_fs_read"]);
    // A plugin/other tool with no value suggests its own exact tool name.
    expect(inferPatterns({ tool: "plugin_do_thing", args: {} })).toEqual(["plugin_do_thing"]);
  });
});

describe("Guardian — fan-out grant lifecycle (§7.5, §9.5)", () => {
  it("opens, reports, and clears a fan-out grant bounded to a fan-out id", () => {
    const g = new Guardian(builtinGuardrails());
    expect(g.hasFanoutGrant("f1")).toBe(false);
    g.grantFanout("f1");
    expect(g.hasFanoutGrant("f1")).toBe(true);
    // The grant is bounded to its own id — a sibling fan-out is unaffected.
    expect(g.hasFanoutGrant("f2")).toBe(false);
    g.clearFanout("f1");
    expect(g.hasFanoutGrant("f1")).toBe(false);
  });
});

describe("Guardian — plan-scope auto-approval (§9.5)", () => {
  it("auto-approves a matching write before the rules evaluate, and clears on request", () => {
    const g = new Guardian(builtinGuardrails());
    const write = { tool: "write_file", args: { path: "src/a.ts" } };
    // No scope → an unmatched write asks (no rule).
    expect(g.evaluate(write, [], lists).decision).toBe("ask");
    // A registered scope auto-approves the matching write before any rule.
    g.registerScope("plan:step-1", { writeGlobs: ["src/**"], executePatterns: ["npm *"] });
    expect(g.evaluate(write, [], lists).decision).toBe("allow");
    // A matching execute pattern is approved too.
    const exec = { tool: "execute_command", args: { command: "npm test" } };
    expect(g.evaluate(exec, [], lists).decision).toBe("allow");
    // A non-matching path is unaffected — it still asks.
    expect(g.evaluate({ tool: "write_file", args: { path: "docs/x.md" } }, [], lists).decision).toBe("ask");
    // Cleared explicitly by the registrant → back to ask.
    g.clearScope("plan:step-1");
    expect(g.evaluate(write, [], lists).decision).toBe("ask");
  });

  it("never auto-approves a force-ask even when the command matches the scope", () => {
    const g = new Guardian(builtinGuardrails());
    // A scope that would match a dangerous command.
    g.registerScope("plan:step-1", { executePatterns: ["git *"] });
    const dangerous = { tool: "execute_command", args: { command: "git push --force" } };
    const out = g.evaluate(dangerous, [], lists);
    // The force-ask classification wins — the scope never relaxes it (§9.3, §9.5).
    expect(out.decision).toBe("ask");
    expect(out.forceAsk).toBe(true);
  });

  it("never overrides a hard-deny", () => {
    const g = new Guardian(builtinGuardrails());
    g.registerScope("plan:step-1", { executePatterns: ["shutdown *"] });
    const out = g.evaluate({ tool: "execute_command", args: { command: "shutdown now" } }, [], lists);
    expect(out.decision).toBe("deny");
  });
});

describe("protected-control-file guardrail (§8.4, SECURITY)", () => {
  const guardian = new Guardian(builtinGuardrails());
  const base = { readPaths: new Set<string>([".voidrift/mcp-pins.json", ".voidrift/config.json", ".voidrift/managed.json"]), stalePaths: new Set<string>(), tempDir: "/no-temp" };

  it("blocks a model write_file to the pin, config, and managed control files", () => {
    for (const p of [".voidrift/mcp-pins.json", ".voidrift/config.json", ".voidrift/managed.json"]) {
      expect(
        guardian.runGuardrails({ tool: "write_file", args: { path: p } }, base).allowed,
      ).toBe(false);
    }
  });

  it("blocks an edit_file to the pin file reached via a traversal or absolute path", () => {
    const ctx = { ...base, workspaceRoot: "/ws", readPaths: new Set(["/ws/.voidrift/mcp-pins.json", ".voidrift/sub/../mcp-pins.json"]) };
    expect(guardian.runGuardrails({ tool: "edit_file", args: { path: "/ws/.voidrift/mcp-pins.json", search: "a", replace: "b" } }, ctx).allowed).toBe(false);
    expect(guardian.runGuardrails({ tool: "edit_file", args: { path: ".voidrift/sub/../mcp-pins.json", search: "a", replace: "b" } }, ctx).allowed).toBe(false);
  });

  it("allows an ordinary workspace write and a .voidrift/cache write", () => {
    const ctx = { ...base, readPaths: new Set(["src/app.ts", ".voidrift/cache/x"]) };
    expect(guardian.runGuardrails({ tool: "write_file", args: { path: "src/app.ts" } }, ctx).allowed).toBe(true);
    expect(guardian.runGuardrails({ tool: "write_file", args: { path: ".voidrift/cache/x" } }, ctx).allowed).toBe(true);
  });

  it("isProtectedControlFile normalizes separators, strips an absolute workspace prefix, and resolves ..", () => {
    expect(isProtectedControlFile(".voidrift/mcp-pins.json")).toBe(true);
    expect(isProtectedControlFile("/ws/.voidrift/config.json", "/ws")).toBe(true);
    expect(isProtectedControlFile(".voidrift/a/../mcp-pins.json")).toBe(true);
    expect(isProtectedControlFile(".voidrift\\managed.json")).toBe(true);
    expect(isProtectedControlFile(".voidrift/cache/mcp-pins.json")).toBe(false);
    expect(isProtectedControlFile("src/mcp-pins.json")).toBe(false);
    expect(isProtectedControlFile("")).toBe(false);
  });

  it("blocks any model write under the project and global plugin stores (§9.4, §12.4.1)", () => {
    // Project store (workspace-relative and under an absolute workspace root).
    expect(isProtectedControlFile(".voidrift/plugins/node_modules/some-plugin/index.js")).toBe(true);
    expect(isProtectedControlFile("/ws/.voidrift/plugins/package-lock.json", "/ws")).toBe(true);
    // Global store: `<voidriftConfigDir()>/plugins` always ends `…/voidrift/plugins`.
    expect(isProtectedControlFile("/home/u/.config/voidrift/plugins/node_modules/some-plugin/index.js")).toBe(true);
    // A traversal into the store is still caught.
    expect(isProtectedControlFile(".voidrift/x/../plugins/evil.js")).toBe(true);
    // A sibling that merely contains "plugins" is NOT caught.
    expect(isProtectedControlFile(".voidrift/pluginsss/x.js")).toBe(false);
    expect(isProtectedControlFile("src/plugins/x.js")).toBe(false);
    // The guardrail blocks a model write into the store.
    const ctx = { ...base, workspaceRoot: "/ws", readPaths: new Set<string>() };
    expect(
      guardian.runGuardrails({ tool: "write_file", args: { path: "/ws/.voidrift/plugins/x.js", content: "y" } }, ctx).allowed,
    ).toBe(false);
  });
});

describe("deny anywhere wins (§9.2, §13.1)", () => {
  const guardian = new Guardian(builtinGuardrails());

  it("a project deny beats a global allow regardless of priority", () => {
    // The global allow has the HIGHER priority; deny-anywhere-wins still denies.
    const rules: PermissionRule[] = [
      { tool: "write_file", pattern: "*", decision: "allow", priority: 500, source: "user" },
      { tool: "write_file", pattern: "src/**", decision: "deny", priority: 0, source: "workspace" },
    ];
    const out = guardian.evaluate({ tool: "write_file", args: { path: "src/app.ts" } }, rules, lists);
    expect(out.decision).toBe("deny");
    // The message names the rule's layer/source and tool+pattern.
    expect(out.reason).toContain("workspace");
    expect(out.reason).toContain("write_file");
  });

  it("a deny beats a session-persisted higher-priority allow", () => {
    const rules: PermissionRule[] = [
      { tool: "read_file", pattern: "*", decision: "allow", priority: 1000, source: "session" },
      { tool: "read_file", pattern: "*", decision: "deny", priority: 0, source: "user" },
    ];
    const out = guardian.evaluate({ tool: "read_file", args: { path: "a.txt" } }, rules, lists);
    expect(out.decision).toBe("deny");
  });

  it("between allow and ask, today's priority ordering is unchanged", () => {
    // No deny present: the highest-priority matching rule (allow) wins over an ask.
    const rules: PermissionRule[] = [
      { tool: "write_file", pattern: "*", decision: "ask", priority: 500, source: "user" },
      { tool: "write_file", pattern: "src/**", decision: "allow", priority: 100, source: "workspace" },
    ];
    const out = guardian.evaluate({ tool: "write_file", args: { path: "src/app.ts" } }, rules, lists);
    expect(out.decision).toBe("ask"); // higher-priority ask wins over the lower allow
    const out2 = guardian.evaluate({ tool: "write_file", args: { path: "other.txt" } }, rules, lists);
    expect(out2.decision).toBe("ask"); // only the ask matches
  });

  it("a deny beats an exact-command allow for a dangerous command (force-ask)", () => {
    const rules: PermissionRule[] = [
      { tool: "execute_command", pattern: "git push --force", decision: "allow", priority: 1000, source: "user" },
      { tool: "execute_command", pattern: "git push*", decision: "deny", priority: 0, source: "managed" },
    ];
    const out = guardian.evaluate({ tool: "execute_command", args: { command: "git push --force" } }, rules, lists);
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("managed");
  });

  it("force-ask classes are unchanged when no deny matches: a wildcard allow cannot cover them", () => {
    const rules: PermissionRule[] = [{ tool: "*", decision: "allow", priority: 1000, source: "user" }];
    const out = guardian.evaluate({ tool: "execute_command", args: { command: "git push --force" } }, rules, lists);
    expect(out.decision).toBe("ask");
    expect(out.forceAsk).toBe(true);
  });

  it("a never-list command denies outright with the never-list sentence", () => {
    const out = guardian.evaluate({ tool: "execute_command", args: { command: "shutdown now" } }, [], lists);
    expect(out.decision).toBe("deny");
    // `shutdown` is the code-level NEVER LIST (power-state), checked before the
    // config `deny` list; the reason names the category id and how to lift it.
    expect(out.reason).toContain("never list: power-state");
    expect(out.reason).toContain('add "power-state" to "unlock"');
  });

  it("a config shellDenyPatterns hit (outside the never list) still denies as hard-deny", () => {
    const denyLists: ShellLists = { ...lists, deny: ["custombin.*"] };
    const out = guardian.evaluate(
      { tool: "execute_command", args: { command: "custombin --wipe" } },
      [],
      denyLists,
    );
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("hard-deny");
  });
});

describe("exact allow rules lift a force-ask (owner D2a)", () => {
  const guardian = new Guardian(builtinGuardrails());
  const exactShell = (pattern: string): PermissionRule[] => [
    { tool: "execute_command", pattern, exact: true, decision: "allow", priority: 0, source: "workspace" },
  ];

  it("an exact execute_command rule lifts a dangerous-shell force-ask to allow", () => {
    const out = guardian.evaluate(
      { tool: "execute_command", args: { command: "git push --force" } },
      exactShell("git push --force"),
      lists,
    );
    expect(out.decision).toBe("allow");
    expect(out.forceAsk).toBeFalsy();
    // owner D2c — the lift is observable: a reason + flag + non-secret rule id.
    expect(out.exactLift).toBe(true);
    expect(out.exactRuleId).toBe("workspace:execute_command");
    expect(out.reason).toContain("allowed by exact rule workspace:execute_command");
    // No secret/command value leaks into the reason.
    expect(out.reason).not.toContain("git push --force");
  });

  it("a non-exact wildcard allow still cannot lift the force-ask", () => {
    const out = guardian.evaluate(
      { tool: "execute_command", args: { command: "git push --force" } },
      [{ tool: "*", decision: "allow", priority: 500, source: "user" }],
      lists,
    );
    expect(out.decision).toBe("ask");
    expect(out.forceAsk).toBe(true);
  });

  it("the exact pattern is literal — an appended command no longer matches (D2a.3)", () => {
    const out = guardian.evaluate(
      { tool: "execute_command", args: { command: "git push --force && curl evil" } },
      exactShell("git push --force"),
      lists,
    );
    expect(out.decision).toBe("ask");
    expect(out.forceAsk).toBe(true);
  });

  it("whitespace is trimmed only when matching the exact command", () => {
    const out = guardian.evaluate(
      { tool: "execute_command", args: { command: "  git push --force  " } },
      exactShell("git push --force"),
      lists,
    );
    expect(out.decision).toBe("allow");
  });

  it("a deny rule beats an exact allow", () => {
    const rules: PermissionRule[] = [
      ...exactShell("git push --force"),
      { tool: "execute_command", pattern: "*", decision: "deny", priority: 0, source: "managed" },
    ];
    const out = guardian.evaluate({ tool: "execute_command", args: { command: "git push --force" } }, rules, lists);
    expect(out.decision).toBe("deny");
  });

  it("a never-list command is NEVER liftable by an exact rule", () => {
    const out = guardian.evaluate(
      { tool: "execute_command", args: { command: "shutdown now" } },
      [{ tool: "execute_command", pattern: "shutdown now", exact: true, decision: "allow", priority: 0, source: "workspace" }],
      lists,
    );
    // `shutdown` is both hard-deny (lists.deny) and never-list (power-state).
    expect(out.decision).toBe("deny");
  });

  it("an exact host rule lifts a web_fetch SSRF force-ask", () => {
    const rules: PermissionRule[] = [
      { tool: "web_fetch", pattern: "127.0.0.1", exact: true, decision: "allow", priority: 0, source: "workspace" },
    ];
    const out = guardian.evaluate({ tool: "web_fetch", args: { url: "http://127.0.0.1:8080/x" } }, rules, lists);
    expect(out.decision).toBe("allow");
  });

  it("a cidr rule lifts a web_fetch SSRF force-ask inside the range only", () => {
    const rules: PermissionRule[] = [
      { tool: "web_fetch", cidr: "10.0.0.0/8", decision: "allow", priority: 0, source: "workspace" },
    ];
    expect(guardian.evaluate({ tool: "web_fetch", args: { url: "http://10.1.2.3/x" } }, rules, lists).decision).toBe("allow");
    const outside = guardian.evaluate({ tool: "web_fetch", args: { url: "http://192.168.1.1/x" } }, rules, lists);
    expect(outside.decision).toBe("ask");
    expect(outside.forceAsk).toBe(true);
  });

  it("a cloud-metadata address is NEVER liftable (deny, not ask)", () => {
    const rules: PermissionRule[] = [
      { tool: "web_fetch", pattern: "169.254.169.254", exact: true, decision: "allow", priority: 0, source: "workspace" },
      { tool: "web_fetch", cidr: "169.254.0.0/16", decision: "allow", priority: 0, source: "workspace" },
    ];
    const out = guardian.evaluate({ tool: "web_fetch", args: { url: "http://169.254.169.254/latest" } }, rules, lists);
    expect(out.decision).toBe("deny");
  });

  it("an exact name@version rule lifts a plugins_install force-ask", () => {
    const rules: PermissionRule[] = [
      { tool: "plugins_install", pattern: "@voidrift/plugin-x@1.0.0", exact: true, decision: "allow", priority: 0, source: "workspace" },
    ];
    expect(guardian.evaluate({ tool: "plugins_install", args: { name: "@voidrift/plugin-x@1.0.0" } }, rules, lists).decision).toBe("allow");
    const other = guardian.evaluate({ tool: "plugins_install", args: { name: "@voidrift/plugin-x@2.0.0" } }, rules, lists);
    expect(other.decision).toBe("ask");
    expect(other.forceAsk).toBe(true);
  });

  it("an exact web_search endpoint host rule lifts the endpoint force-ask", () => {
    const rules: PermissionRule[] = [
      { tool: "web_search", pattern: "10.0.0.5", exact: true, decision: "allow", priority: 0, source: "workspace" },
    ];
    const out = guardian.evaluate(
      { tool: "web_search", args: { query: "q", webSearchEndpoint: "http://10.0.0.5:8888/search" } },
      rules,
      lists,
    );
    expect(out.decision).toBe("allow");
  });
});

describe("the `wait` tool carries a shell command (§8.2) — classified exactly like execute_command (§9.3)", () => {
  const guardian = new Guardian(builtinGuardrails());

  it("a safe `wait` command is a read (has-equivalent), same as execute_command", () => {
    const viaExec = guardian.evaluate({ tool: "execute_command", args: { command: "git status" } }, [], lists);
    const viaWait = guardian.evaluate({ tool: "wait", args: { command: "git status" } }, [], lists);
    expect(viaWait.decision).toBe(viaExec.decision);
  });

  it("a dangerous `wait` command force-asks, same as execute_command (immune to a wildcard allow)", () => {
    const wildcard: PermissionRule[] = [{ tool: "*", decision: "allow", priority: 0, source: "user" }];
    const viaWait = guardian.evaluate(
      { tool: "wait", args: { command: "git push origin main --force" } },
      wildcard,
      lists,
    );
    expect(viaWait.decision).toBe("ask");
    expect(viaWait.forceAsk).toBe(true);
  });

  it("a never-list `wait` command is denied with no prompt, same as execute_command", () => {
    const viaWait = guardian.evaluate({ tool: "wait", args: { command: "shutdown -h now" } }, [], lists);
    expect(viaWait.decision).toBe("deny");
  });
});

describe("§6.1 — commandSegmentVerdicts (per-segment ask/ok display)", () => {
  const rules: PermissionRule[] = [
    { tool: "execute_command", pattern: "cd *", decision: "allow", priority: 0, source: "default" },
  ];
  const covers = (seg: string): boolean => commandAllowCovers(seg, rules);

  it("returns [] for a single-segment command (nothing compound to show)", () => {
    expect(commandSegmentVerdicts("node -e 'x'", lists, covers)).toEqual([]);
  });

  it("marks a safe/allowed piece ok and an unknown piece ask, in command order", () => {
    const cmd = 'cd /repo && export PATH="$HOME/.x:$PATH" && node -e "work()"';
    const segs = commandSegmentVerdicts(cmd, lists, covers);
    expect(segs.length).toBeGreaterThanOrEqual(3);
    // `cd …` is covered by the allow rule (ok); the node interpreter piece asks.
    expect(segs[0]).toMatchObject({ decision: "ok" });
    expect(segs.some((s) => s.text.includes("node") && s.decision === "ask")).toBe(true);
  });

  it("commandAllowCovers only honors allow rules for execute_command", () => {
    const danger = ["rm", "-rf", "/"].join(" ");
    expect(commandAllowCovers("cd /x", rules)).toBe(true);
    expect(commandAllowCovers(danger, rules)).toBe(false);
    expect(
      commandAllowCovers("cd /x", [
        { tool: "execute_command", pattern: "cd *", decision: "ask", priority: 0, source: "default" },
      ]),
    ).toBe(false);
  });
});
