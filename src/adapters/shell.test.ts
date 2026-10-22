import { describe, it, expect } from "vitest";
import { ShellAdapter } from "./shell.js";
import { createMemoryCheckpointer } from "./checkpointer.js";
import { builtinToolDefinitions } from "../tools/builtin.js";

describe("ShellAdapter (§8.2)", () => {
  const sh = new ShellAdapter();

  it("runs a command and captures output with a zero exit", async () => {
    const r = await sh.execute("echo hello");
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("hello");
  });

  it("reports a non-zero exit code", async () => {
    const r = await sh.execute("exit 3");
    expect(r.exitCode).toBe(3);
  });

  it("times out and reports exit code 124", async () => {
    const r = await sh.execute("sleep 2", { timeoutMs: 50 });
    expect(r.exitCode).toBe(124);
  });

  it("runs rooted at a provided cwd", async () => {
    const r = await sh.execute("pwd", { cwd: process.cwd() });
    expect(r.exitCode).toBe(0);
    expect(r.output.trim().length).toBeGreaterThan(0);
  });
});

describe("checkpointer factory (§5)", () => {
  it("builds an in-memory checkpointer", () => {
    expect(createMemoryCheckpointer()).toBeDefined();
  });
});

describe("builtin tool definitions (§8.1)", () => {
  it("classify the suite's read-only vs gated tools and run the no-op executor", async () => {
    const defs = builtinToolDefinitions();
    const names = defs.map((d) => d.def.name);
    expect(names).toContain("read_file");
    expect(names).toContain("execute_command");
    const read = defs.find((d) => d.def.name === "read_file")!;
    expect(read.def.readOnly).toBe(true);
    const exec = defs.find((d) => d.def.name === "execute_command")!;
    expect(exec.def.readOnly).toBe(false);
    const r = await read.exec({}, { workspaceRoot: "/ws", sessionId: "s" });
    expect(r.status).toBe("success");
  });
});
