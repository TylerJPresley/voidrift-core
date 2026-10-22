/**
 * The code-level NEVER LIST, `unlock`, metadata hosts, and the `rm -rf`
 * within-workdir refinement (core-blueprint.md §9.3, §13.10; owner D1).
 *
 * One positive and one bypass-attempt per never-list id (wrappers, quoting,
 * `sudo`, env prefixes, `command`, absolute binary paths, variable indirection);
 * `unlock` of each id lifts it to always-ask; `metadata-hosts` never/unlock;
 * and the `rm -rf` inside-vs-outside-workdir matrix with a real symlink.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Guardian,
  builtinGuardrails,
  classifyNever,
  type ShellLists,
} from "./guardian.js";
import { NEVER_CATEGORIES, neverListView, isMetadataHost } from "./never-list.js";
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
const NONE = new Set<string>();
const guardian = new Guardian(builtinGuardrails());

function evalCmd(command: string, opts?: { unlock?: Set<string>; workdir?: string; rules?: PermissionRule[] }) {
  return guardian.evaluate(
    { tool: "execute_command", args: { command } },
    opts?.rules ?? [],
    lists,
    { ...(opts?.unlock ? { unlock: opts.unlock } : {}), ...(opts?.workdir ? { workdir: opts.workdir } : {}) },
  );
}

/** One positive (must be NEVER) and one bypass-attempt (a wrapper/quote/path/
 * substitution variant that must ALSO be NEVER) per category id. */
const CATEGORY_CASES: Record<string, { positive: string; bypass: string }> = {
  "wipe-disk": { positive: "mkfs.ext4 /dev/sda1", bypass: "sudo /sbin/mkfs.ext4 /dev/sda1" },
  "delete-system-dirs": { positive: "rm -rf /", bypass: "env FOO=1 /bin/rm --recursive --force /etc" },
  "overwrite-system-files": { positive: "echo x > /etc/passwd", bypass: "command cp evil /usr/bin/ls" },
  "fork-bomb": { positive: ":(){ :|:& };:", bypass: "bomb(){ bomb|bomb& };bomb" },
  "kill-all-processes": { positive: "kill -9 -1", bypass: "sudo killall5" },
  "power-state": { positive: "shutdown now", bypass: "'reboot'" },
  "flush-firewall": { positive: "iptables -F", bypass: "sudo nft flush ruleset" },
};

describe("never list — each category denies (positive + bypass), §9.3", () => {
  it("covers every code category id", () => {
    const ids = NEVER_CATEGORIES.map((c) => c.id).sort();
    expect(ids).toEqual(Object.keys(CATEGORY_CASES).sort());
  });

  for (const [id, { positive, bypass }] of Object.entries(CATEGORY_CASES)) {
    it(`${id}: positive "${positive}" is NEVER`, () => {
      const out = evalCmd(positive);
      expect(out.decision).toBe("deny");
      expect(out.reason).toContain(`never list: ${id}`);
      expect(out.reason).toContain(`add "${id}" to "unlock"`);
    });

    it(`${id}: bypass attempt "${bypass}" is still NEVER`, () => {
      const out = evalCmd(bypass);
      expect(out.decision, bypass).toBe("deny");
      expect(out.reason, bypass).toContain(`never list: ${id}`);
    });

    it(`${id}: a wildcard allow + wrapper + substitution cannot cover it`, () => {
      const rules: PermissionRule[] = [{ tool: "*", pattern: "*", decision: "allow", priority: 1000, source: "session" }];
      const out = evalCmd(`echo $(${positive})`, { rules });
      expect(out.decision, positive).toBe("deny");
    });

    it(`${id}: unlocking it lifts the command to always-ask (force-ask)`, () => {
      const out = evalCmd(positive, { unlock: new Set([id]) });
      // The lifted category falls to the force-ask list: it ASKS (force-ask), is
      // never auto-approved. (A few positives also match the force-ask defaults;
      // any that classify unknown after lifting still ASK via posture — but all
      // seven positives above are in the force-ask families too.)
      expect(out.decision, `${id} lifted`).toBe("ask");
      expect(out.forceAsk, `${id} lifted`).toBe(true);
    });
  }
});

describe("never list — variable indirection stays blocked/asked, §9.3", () => {
  it("`$X` as a system-dir operand does NOT qualify the rm (stays force-ask, not allowed)", () => {
    // `rm -rf $DIR` is not a never-list system-dir (no literal path) but is a
    // force-ask rm; it must never silently allow.
    const out = evalCmd("rm -rf $DIR", { workdir: "/ws" });
    expect(out.decision).toBe("ask");
    expect(out.forceAsk).toBe(true);
  });
});

describe("never list — view + metadata host detection", () => {
  it("neverListView marks lifted categories and includes metadata-hosts", () => {
    const view = neverListView(["power-state", "metadata-hosts"]);
    const ids = view.map((r) => r.id);
    expect(ids).toContain("metadata-hosts");
    expect(view.find((r) => r.id === "power-state")?.unlocked).toBe(true);
    expect(view.find((r) => r.id === "wipe-disk")?.unlocked).toBe(false);
    for (const r of view) expect(r.description.length).toBeGreaterThan(0);
  });

  it("isMetadataHost recognizes the cloud metadata endpoints", () => {
    expect(isMetadataHost("169.254.169.254")).toBe(true);
    expect(isMetadataHost("metadata.google.internal")).toBe(true);
    expect(isMetadataHost("fd00:ec2::254")).toBe(true);
    expect(isMetadataHost("example.com")).toBe(false);
    expect(isMetadataHost("169.254.1.1")).toBe(false);
  });
});

describe("rm -rf within-workdir refinement (owner D1.4)", () => {
  const workdir = "/ws/project";
  const run = (command: string, realpath?: (p: string) => string) =>
    guardian.evaluate({ tool: "execute_command", args: { command } }, [], lists, {
      workdir,
      ...(realpath ? { realpath } : {}),
    });

  it("`rm -rf build/` inside the workdir flows normally (ask, NOT force-ask)", () => {
    const out = run("rm -rf build/");
    expect(out.decision).toBe("ask");
    expect(out.forceAsk).toBe(false);
  });

  it("`rm -rf /tmp/x` outside the workdir stays force-ask", () => {
    const out = run("rm -rf /tmp/x");
    expect(out.forceAsk).toBe(true);
  });

  it.each([
    ["rm -rf ./", "the workdir itself"],
    ["rm -rf .", "the workdir itself (dot)"],
    ["rm -rf ..", "a parent"],
    ["rm -rf build/../..", "an escaping climb"],
    ["rm -rf $HOME/x", "a variable operand"],
    ["rm -rf *", "a glob"],
    ["rm -rf .git", "a .git operand"],
    ["rm -rf src .git", "mixed operands incl. .git"],
    ["rm -rf .voidrift", "a .voidrift operand"],
  ])("`%s` (%s) stays force-ask", (command) => {
    const out = run(command);
    expect(out.forceAsk, command).toBe(true);
  });

  it("`rm -rf src sub/dir` (all inside) flows normally", () => {
    const out = run("rm -rf src sub/dir");
    expect(out.decision).toBe("ask");
    expect(out.forceAsk).toBe(false);
  });

  it("a symlink operand pointing OUTSIDE the workdir does not qualify (stays force-ask)", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "vr-rmlink-"));
    try {
      const ws = path.join(base, "project");
      const outside = path.join(base, "outside");
      fs.mkdirSync(ws, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      const link = path.join(ws, "link-to-outside");
      fs.symlinkSync(outside, link);
      const out = guardian.evaluate(
        { tool: "execute_command", args: { command: "rm -rf link-to-outside/" } },
        [],
        lists,
        { workdir: ws, realpath: (p) => fs.realpathSync.native(p) },
      );
      expect(out.forceAsk).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("a real sub-directory (no symlink escape) flows normally with the realpath guard live", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "vr-rmreal-"));
    try {
      const ws = fs.realpathSync.native(base);
      fs.mkdirSync(path.join(ws, "build"), { recursive: true });
      const out = guardian.evaluate(
        { tool: "execute_command", args: { command: "rm -rf build/" } },
        [],
        lists,
        { workdir: ws, realpath: (p) => fs.realpathSync.native(p) },
      );
      expect(out.decision).toBe("ask");
      expect(out.forceAsk).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("under posture `allow` a never-list command is still denied, but an inside-workdir rm auto-approves", () => {
    // Posture is enforced at the decision point, not Guardian; here we prove
    // Guardian hands an inside-workdir rm as a plain ASK (not force-ask) so the
    // decision point's `allow` posture auto-approves it, while a never-list
    // command denies outright regardless.
    const inside = run("rm -rf build/");
    expect(inside.forceAsk).toBe(false); // plain ask → auto-approvable under `allow`
    const never = run("rm -rf /");
    expect(never.decision).toBe("deny"); // never list → denied even under `allow`
  });
});

describe("rm within-workdir refinement disabled by a dir change (owner D1b)", () => {
  const workdir = "/ws/project";
  const run = (command: string) =>
    guardian.evaluate({ tool: "execute_command", args: { command } }, [], lists, { workdir });

  it.each([
    ["cd / && rm -rf build", "cd before (&&)"],
    ["cd .. && rm -rf x", "cd .. before"],
    ["pushd /tmp; rm -rf x", "pushd before (;)"],
    ["(cd / ; rm -rf build)", "subshell with cd"],
    ["{ cd /; rm -rf build; }", "group with cd"],
    ["bash -c 'cd / && rm -rf build'", "bash -c string with cd"],
    ["sh -c 'cd /; rm -rf build'", "sh -c string with cd"],
    ["eval 'cd / && rm -rf build'", "eval string with cd"],
    ["rm -rf build && cd /", "cd AFTER still disables (simpler rule)"],
    ["env -C / rm -rf build", "env -C wrapper flag"],
    ["env --chdir=/ rm -rf build", "env --chdir wrapper flag"],
  ])("`%s` (%s) stays force-ask — the refinement is disabled", (command) => {
    const out = run(command);
    expect(out.forceAsk, command).toBe(true);
  });

  it("`echo cd && rm -rf build` — `cd` as an echo ARGUMENT does NOT disable; the rm still flows", () => {
    // Tokenized properly: `cd` here is an argument to echo, not a command word.
    const out = run("echo cd && rm -rf build");
    expect(out.decision).toBe("ask");
    expect(out.forceAsk).toBe(false);
  });

  it("`rm -rf cd` — a directory literally named `cd` flows normally (not a dir change)", () => {
    const out = run("rm -rf cd");
    expect(out.decision).toBe("ask");
    expect(out.forceAsk).toBe(false);
  });

  it("the existing plain inside-workdir rm still flows with no dir change present", () => {
    const out = run("rm -rf build/");
    expect(out.decision).toBe("ask");
    expect(out.forceAsk).toBe(false);
  });
});

describe("overwrite-system-files — /dev stream carve-out (§9.3)", () => {
  // Every EXEMPT device stream crossed with every FORM in the category. Each
  // must NOT be a never-list hit (the command flows to the normal gate).
  const EXEMPT = ["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/fd/3", "/dev/fd/42"];
  const forms = (t: string): string[] => [
    `cat x > ${t}`,
    `cat x >> ${t}`,
    `ls 2> ${t}`,
    `make &> ${t}`,
    `cat x 2>${t}`,
    `tee ${t}`,
    `truncate -s 0 ${t}`,
    `cp a ${t}`,
    `mv a ${t}`,
    `install a ${t}`,
    `ln -sf a ${t}`,
    `sed -i s/a/b/ ${t}`,
  ];

  for (const t of EXEMPT) {
    for (const cmd of forms(t)) {
      it(`exempt: "${cmd}" is NOT a never-list hit`, () => {
        expect(classifyNever(cmd, NONE)).toBeNull();
      });
    }
  }

  it("quoted exempt target behaves like unquoted", () => {
    expect(classifyNever(`cat x > "/dev/null"`, NONE)).toBeNull();
    expect(classifyNever(`echo hi > '/dev/stderr'`, NONE)).toBeNull();
  });

  // The must-STILL-deny list (pin 3), including multi-target segments.
  const DENIED = [
    "echo x > /dev/null/x",
    "echo x > /dev/null/../sda",
    "echo x > /dev/nullx",
    "echo x > /dev/fd/3/../x",
    "echo x > /dev/fd/../sda",
    "echo x > /etc/hosts",
    "tee /dev/null /dev/sda",
    "cp a /dev/null /etc/x",
    "sed -i s/a/b/ /dev/null /etc/passwd",
  ];
  for (const cmd of DENIED) {
    it(`still denied: "${cmd}" (overwrite-system-files)`, () => {
      expect(classifyNever(cmd, NONE)?.id).toBe("overwrite-system-files");
    });
  }

  it("`/dev/sda` is still denied (via wipe-disk or overwrite), not exempt", () => {
    expect(classifyNever("echo x > /dev/sda", NONE)).not.toBeNull();
  });

  it("other categories are unchanged by the carve-out", () => {
    expect(classifyNever("rm -rf /dev", NONE)?.id).toBe("delete-system-dirs");
    expect(classifyNever("mkfs.ext4 /dev/sda1", NONE)?.id).toBe("wipe-disk");
  });
});

describe("classifyNever is pure over compound commands", () => {
  it("catches a never-list command in any segment of a chain", () => {
    expect(classifyNever("ls && shutdown now", NONE)?.id).toBe("power-state");
    expect(classifyNever("echo hi; mkfs.ext4 /dev/sda", NONE)?.id).toBe("wipe-disk");
    expect(classifyNever("cat x | kill -9 -1", NONE)?.id).toBe("kill-all-processes");
  });
  it("returns null for a benign command", () => {
    expect(classifyNever("ls -la", NONE)).toBeNull();
    expect(classifyNever("rm -rf build/", NONE)).toBeNull();
  });
});
