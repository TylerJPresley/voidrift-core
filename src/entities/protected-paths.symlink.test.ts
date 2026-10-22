/**
 * S5 (LOW hardening): a `write_file`/`edit_file` through an in-workspace symlink
 * that points at a protected control file must be caught on the RESOLVED target,
 * not just the raw model path. Uses a REAL temp workspace and REAL symlinks, and
 * the REAL `fs.realpathSync.native` injected the same way the decision point
 * injects it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Guardian, builtinGuardrails, type ShellLists, type GuardianEvalOptions } from "./guardian.js";
import { DEFAULT_SHELL_SAFE, DEFAULT_SHELL_FORCE_ASK, DEFAULT_SHELL_EQUIVALENTS } from "../config/schema.js";

const lists: ShellLists = {
  safe: DEFAULT_SHELL_SAFE,
  forceAsk: DEFAULT_SHELL_FORCE_ASK,
  equivalents: DEFAULT_SHELL_EQUIVALENTS,
  deny: [],
};

let root: string;
const guardian = new Guardian(builtinGuardrails());

function evalWrite(path: string) {
  const opts: GuardianEvalOptions = {
    controlPath: { workspaceRoot: root, globalConfigDir: join(root, ".config/voidrift"), home: root },
    realpath: (p) => realpathSync.native(p),
  };
  return guardian.evaluate({ tool: "write_file", args: { path, content: "x" } }, [], lists, opts);
}

describe("symlink-through control-file write guard (S5 LOW)", () => {
  beforeAll(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "vr-symlink-")));
    mkdirSync(join(root, ".voidrift"), { recursive: true });
    mkdirSync(join(root, ".voidrift/agents/chat"), { recursive: true });
    writeFileSync(join(root, ".voidrift/config.json"), "{}");
    writeFileSync(join(root, ".voidrift/agents/chat/prompt.md"), "p");
    writeFileSync(join(root, "real.txt"), "r");
    // notes.md -> .voidrift/config.json  (deny class through a symlink)
    symlinkSync(join(root, ".voidrift/config.json"), join(root, "notes.md"));
    // promptlink.md -> .voidrift/agents/chat/prompt.md  (ask class)
    symlinkSync(join(root, ".voidrift/agents/chat/prompt.md"), join(root, "promptlink.md"));
    // safe.md -> real.txt  (not a control file)
    symlinkSync(join(root, "real.txt"), join(root, "safe.md"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("write THROUGH a symlink to config.json is DENIED (deny class on resolved target)", () => {
    const out = evalWrite("notes.md");
    expect(out.decision).toBe("deny");
    expect(out.reason).toMatch(/config\.set|control file/i);
  });

  it("write THROUGH a symlink to an agent prompt is a control-file FORCE-ASK (ask class)", () => {
    const out = evalWrite("promptlink.md");
    expect(out.decision).toBe("ask");
    expect(out.forceAsk).toBe(true);
    expect(out.forceAskKind).toBe("control-file");
  });

  it("write THROUGH a symlink to a non-control file is NOT gated", () => {
    expect(evalWrite("safe.md").decision).not.toBe("deny");
    expect(evalWrite("safe.md").forceAsk).not.toBe(true);
  });

  it("a plain write to a non-control, non-symlink path is unaffected", () => {
    expect(evalWrite("real.txt").decision).not.toBe("deny");
  });

  it("the raw path is STILL caught even when it is not a symlink (config.json directly)", () => {
    expect(evalWrite(".voidrift/config.json").decision).toBe("deny");
  });
});
