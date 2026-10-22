/**
 * The `outside-workspace` detector (core-blueprint.md §4.4, §8.2, §9.3).
 *
 * `cd`/absolute-path-argument leaving the workspace trips it; an inside path, a
 * relative path, and the command WORD itself (a program path) do not.
 */
import { describe, it, expect } from "vitest";
import { commandLeavesWorkspace } from "./outside-workspace.js";

const ROOT = "/ws";

describe("commandLeavesWorkspace (§9.3 outside-workspace)", () => {
  it("flags a cd to an absolute path outside the root", () => {
    expect(commandLeavesWorkspace("cd /etc && ls", ROOT)).toBe(true);
    expect(commandLeavesWorkspace("pushd /var/log", ROOT)).toBe(true);
  });

  it("flags an absolute-path argument outside the root", () => {
    expect(commandLeavesWorkspace("cat /etc/passwd", ROOT)).toBe(true);
    expect(commandLeavesWorkspace("ls /tmp", ROOT)).toBe(true);
    expect(commandLeavesWorkspace("cp x /usr/bin/ls", ROOT)).toBe(true);
  });

  it("treats /dev/null and /tmp as outside (they ask)", () => {
    expect(commandLeavesWorkspace("echo x > /dev/null", ROOT)).toBe(true);
    expect(commandLeavesWorkspace("touch /tmp/scratch", ROOT)).toBe(true);
  });

  it("does NOT flag a relative cd or an in-workspace path", () => {
    expect(commandLeavesWorkspace("cd sub && ls", ROOT)).toBe(false);
    expect(commandLeavesWorkspace("cat ./README.md", ROOT)).toBe(false);
    expect(commandLeavesWorkspace("cat /ws/README.md", ROOT)).toBe(false);
    expect(commandLeavesWorkspace("ls /ws/src", ROOT)).toBe(false);
  });

  it("does NOT flag a bare cd (goes HOME, not outside the root)", () => {
    expect(commandLeavesWorkspace("cd", ROOT)).toBe(false);
  });

  it("excludes the command WORD itself (a program path)", () => {
    // /bin/ls is the program, not an argument → not flagged on its own.
    expect(commandLeavesWorkspace("/bin/ls", ROOT)).toBe(false);
    // but an absolute ARGUMENT to it is flagged.
    expect(commandLeavesWorkspace("/bin/ls /etc", ROOT)).toBe(true);
  });

  it("does NOT flag unresolvable paths (variable/glob) — falls back", () => {
    expect(commandLeavesWorkspace("cat $SECRET_PATH", ROOT)).toBe(false);
    expect(commandLeavesWorkspace("ls /tmp/scratch.log", ROOT)).toBe(true); // literal absolute outside
    expect(commandLeavesWorkspace("ls /tmp/*.log", ROOT)).toBe(false); // glob → unresolvable → falls back
    expect(commandLeavesWorkspace("cd $HOME", ROOT)).toBe(false); // no home dep → unresolvable
  });

  it("flags a chdir wrapper flag outside the root", () => {
    expect(commandLeavesWorkspace("env -C /etc ls", ROOT)).toBe(true);
    expect(commandLeavesWorkspace("env --chdir=/var ls", ROOT)).toBe(true);
    expect(commandLeavesWorkspace("env -C /ws/sub ls", ROOT)).toBe(false);
  });

  it("resolves ~ against the home dir when provided", () => {
    expect(commandLeavesWorkspace("cd ~", ROOT, { home: "/home/u" })).toBe(true);
    expect(commandLeavesWorkspace("cat ~/.ssh/config", ROOT, { home: "/home/u" })).toBe(true);
    // a workspace under home resolves inside.
    expect(commandLeavesWorkspace("cat ~/ws/x", "/home/u/ws", { home: "/home/u" })).toBe(false);
  });

  it("detects a worker worktree root the same way", () => {
    const wt = "/wt/session-1";
    expect(commandLeavesWorkspace("cat /ws/README.md", wt)).toBe(true); // real workspace is outside the worktree
    expect(commandLeavesWorkspace("cat /wt/session-1/README.md", wt)).toBe(false);
  });
});
