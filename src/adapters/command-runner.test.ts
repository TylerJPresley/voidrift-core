/**
 * Command-runner tests (core-blueprint.md §8.2, §3.3/§5.2).
 *
 * The owner instruction is "cancelling should cancel everything": a cancelled or
 * timed-out `execute_command` must kill the WHOLE OS process group it spawned,
 * including background grandchildren, within a short bound — never leave a child
 * running to the backend timeout. These exercise the REAL path: a real child is
 * spawned, aborted, and its liveness is checked with `kill -0`/`pgrep` scoped to
 * a unique marker, so a leaked process fails the test.
 *
 * Linux/macOS only: the runner uses POSIX process groups (`detached` + negative
 * pid). The suite skips on win32.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import { runCommand } from "./command-runner.js";

const skip = process.platform === "win32";

/** True while a real sleep process (not the matcher itself) carries the marker. */
function markerAlive(marker: string): boolean {
  try {
    // `pgrep -af` prints "pid cmdline"; exclude the matcher's own shell/pgrep so
    // only the spawned target (argv[0] set to the marker via `exec -a`) counts.
    const out = execSync(`pgrep -af ${marker} || true`, { encoding: "utf8" });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .some((l) => !/\bpgrep\b|\|\| true/.test(l));
  } catch {
    return false;
  }
}

async function waitGone(marker: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!markerAlive(marker)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !markerAlive(marker);
}

describe.skipIf(skip)("runCommand — process-group lifecycle (§8.2, §3.3/§5.2)", () => {
  let ws: string;
  beforeEach(() => {
    ws = hermeticTmp("cmdrun");
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("cancel during a long sleep kills the process and its group within ~2s", async () => {
    const marker = `vrmark_${Date.now()}_a`;
    const ac = new AbortController();
    const p = runCommand(`exec -a ${marker} sleep 30`, { cwd: ws, signal: ac.signal });
    // Let the child spawn, then confirm it is alive, then cancel.
    await new Promise((r) => setTimeout(r, 300));
    expect(markerAlive(marker)).toBe(true);
    ac.abort();
    const r = await p;
    expect(r.output).toBe("Command cancelled.");
    expect(await waitGone(marker, 2000)).toBe(true);
  }, 15_000);

  it("cancel kills a background grandchild too (sh -c 'sleep 30 & wait')", async () => {
    const marker = `vrmark_${Date.now()}_b`;
    const ac = new AbortController();
    // The grandchild sleep is backgrounded under an inner sh; it carries the
    // marker in its argv via `exec -a`, so pgrep can find it independently.
    const p = runCommand(`sh -c '(exec -a ${marker} sleep 30) & wait'`, { cwd: ws, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 300));
    expect(markerAlive(marker)).toBe(true);
    ac.abort();
    await p;
    // The grandchild sleep (carrying the marker) must be reaped with the group.
    expect(await waitGone(marker, 2000)).toBe(true);
  }, 15_000);

  it("timeout kills the group and reports exit 124 with the §8.2 timeout string", async () => {
    const marker = `vrmark_${Date.now()}_c`;
    const r = await runCommand(`exec -a ${marker} sleep 30`, { cwd: ws, timeoutMs: 400 });
    expect(r.exitCode).toBe(124);
    expect(r.output).toBe("Error: Command timed out after 0.4 seconds.");
    expect(await waitGone(marker, 2000)).toBe(true);
  }, 15_000);

  it("abort BEFORE spawn spawns nothing", async () => {
    const marker = `vrmark_${Date.now()}_d`;
    const ac = new AbortController();
    ac.abort();
    const r = await runCommand(`exec -a ${marker} sleep 30`, { cwd: ws, signal: ac.signal });
    expect(r.output).toBe("Command cancelled.");
    // Give any (erroneous) spawn a moment, then assert nothing ran.
    await new Promise((res) => setTimeout(res, 200));
    expect(markerAlive(marker)).toBe(false);
  }, 10_000);

  it("a normal command returns the deepagents-identical output (stdout, no trailing noise)", async () => {
    const r = await runCommand("echo hello", { cwd: ws });
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe("hello\n");
    expect(r.truncated).toBe(false);
  });

  it("a non-zero exit appends the '\\n\\nExit code: N' line like the backend", async () => {
    const r = await runCommand("sh -c 'exit 3'", { cwd: ws });
    expect(r.exitCode).toBe(3);
    expect(r.output).toBe("<no output>\n\nExit code: 3");
  });

  it("stderr lines are prefixed '[stderr] ' and combined after stdout", async () => {
    const r = await runCommand("sh -c 'echo out; echo err 1>&2'", { cwd: ws });
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe("out\n\n[stderr] err");
  });

  it("output over the byte cap is truncated with the backend's marker", async () => {
    const r = await runCommand("sh -c 'head -c 2000 /dev/zero | tr \"\\0\" a'", { cwd: ws, maxOutputBytes: 100 });
    expect(r.truncated).toBe(true);
    expect(r.output).toContain("... Output truncated at 100 bytes.");
    // §13.11 HIGH — the model-visible marker names the key and how to get the rest.
    expect(r.output).toContain("limits.tools.commandOutputMaxBytes");
    expect(r.output).toContain("not returned");
  });

  it("leaves no zombie/leaked process after a completed run", async () => {
    const marker = `vrmark_${Date.now()}_e`;
    // A brief marked sleep that finishes on its own; nothing marked may linger.
    const r = await runCommand(`exec -a ${marker} sleep 0.2`, { cwd: ws });
    expect(r.exitCode).toBe(0);
    expect(await waitGone(marker, 2000)).toBe(true);
  }, 10_000);
});

describe.skipIf(skip)("runCommand — command env allowlist (§8.2)", () => {
  let ws: string;
  beforeEach(() => {
    ws = hermeticTmp("cmdrun-env");
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("finds a tool via the host PATH with no opts.env (printenv PATH is the host's)", async () => {
    const r = await runCommand("printenv PATH", { cwd: ws });
    expect(r.exitCode).toBe(0);
    expect(r.output.trim()).toBe(process.env["PATH"]);
  });

  it("does NOT expose a host secret var to a model-run command", async () => {
    const prev = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "sk-should-not-leak";
    try {
      // `printenv VAR` exits non-zero and prints nothing when the var is unset;
      // the runner renders empty output as its `<no output>` placeholder. Either
      // proves the var never reached the child (the key itself never appears).
      const r = await runCommand("printenv OPENAI_API_KEY || true", { cwd: ws });
      expect(["", "<no output>"]).toContain(r.output.trim());
      expect(r.output).not.toContain("sk-should-not-leak");
    } finally {
      if (prev === undefined) delete process.env["OPENAI_API_KEY"];
      else process.env["OPENAI_API_KEY"] = prev;
    }
  });

  it("an explicit opts.env still wins over the allowlist default", async () => {
    const r = await runCommand("printenv MY_EXPLICIT", { cwd: ws, env: { MY_EXPLICIT: "yes", PATH: process.env["PATH"] } });
    expect(r.exitCode).toBe(0);
    expect(r.output.trim()).toBe("yes");
  });
});

describe.skipIf(skip)("runCommand — limits registry (§13.11 TOOL5/6/7)", () => {
  let ws: string;
  beforeEach(() => {
    ws = hermeticTmp("cmdrun-lim");
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("the output cap default equals today's value (100000 bytes)", async () => {
    const { limitDefault } = await import("../entities/limits.js");
    expect(limitDefault("tools.commandOutputMaxBytes")).toBe(100_000);
    expect(limitDefault("tools.commandKillGraceMs")).toBe(500);
  });

  it("TOOL6: the timeout default equals today's RUNTIME value (120000 ms, not the shell 30000)", async () => {
    // What actually runs for execute_command is runCommand, whose default was a
    // hardcoded 120 s; it now comes from the registry — the two MUST agree so the
    // registry default equals today's observable behaviour.
    const { limitDefault } = await import("../entities/limits.js");
    expect(limitDefault("tools.commandTimeoutMs")).toBe(120_000);
  });

  it("TOOL6: a configured limits.tools.commandTimeoutMs bounds the run (times out at the configured value)", async () => {
    const { EventBus } = await import("../entities/event-bus.js");
    const { resolveLimits } = await import("../entities/limits-resolve.js");
    const { LimitsCapability } = await import("../use-cases/limits-capability.js");
    const bus = new EventBus();
    const limits = new LimitsCapability(resolveLimits([{ layer: "project", limits: { tools: { commandTimeoutMs: 300 } } }]), bus);
    const r = await runCommand("sleep 30", { cwd: ws, limits });
    // The port's 300 ms cap fired, not the 120 s registry default.
    expect(r.exitCode).toBe(124);
    expect(r.output).toContain("Command timed out after 0.3 seconds.");
  });

  it("a configured limits.tools.commandOutputMaxBytes changes the truncation point", async () => {
    const { EventBus } = await import("../entities/event-bus.js");
    const { resolveLimits } = await import("../entities/limits-resolve.js");
    const { LimitsCapability } = await import("../use-cases/limits-capability.js");
    const bus = new EventBus();
    const limits = new LimitsCapability(resolveLimits([{ layer: "project", limits: { tools: { commandOutputMaxBytes: 50 } } }]), bus);
    const r = await runCommand("sh -c 'head -c 2000 /dev/zero | tr \"\\0\" a'", { cwd: ws, limits });
    expect(r.truncated).toBe(true);
    expect(r.output).toContain("... Output truncated at 50 bytes.");
  });

  it("emits one LIMIT_HIT naming the key when the output is truncated", async () => {
    const { EventBus } = await import("../entities/event-bus.js");
    const { resolveLimits } = await import("../entities/limits-resolve.js");
    const { LimitsCapability } = await import("../use-cases/limits-capability.js");
    const bus = new EventBus();
    const hits: { key: string; value: number }[] = [];
    bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string; value: number }));
    const limits = new LimitsCapability(resolveLimits([{ layer: "project", limits: { tools: { commandOutputMaxBytes: 50 } } }]), bus);
    await runCommand("sh -c 'head -c 2000 /dev/zero | tr \"\\0\" a'", { cwd: ws, limits });
    expect(hits.length).toBe(1);
    expect(hits[0].key).toBe("tools.commandOutputMaxBytes");
    expect(hits[0].value).toBe(50);
  });

  it("does not emit a LIMIT_HIT when the output fits", async () => {
    const { EventBus } = await import("../entities/event-bus.js");
    const { resolveLimits } = await import("../entities/limits-resolve.js");
    const { LimitsCapability } = await import("../use-cases/limits-capability.js");
    const bus = new EventBus();
    const hits: unknown[] = [];
    bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload));
    const limits = new LimitsCapability(resolveLimits([]), bus);
    const r = await runCommand("echo hello", { cwd: ws, limits });
    expect(r.truncated).toBe(false);
    expect(hits.length).toBe(0);
  });
});

describe.skipIf(skip)("runCommand — oversized output by reference (§8.2, §8.7, §13.11)", () => {
  let ws: string;
  beforeEach(() => {
    ws = hermeticTmp("cmdrun-byref");
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  async function wiring() {
    const { InMemoryRunCache } = await import("./run-cache.js");
    const { EventBus } = await import("../entities/event-bus.js");
    const { resolveLimits } = await import("../entities/limits-resolve.js");
    const { LimitsCapability } = await import("../use-cases/limits-capability.js");
    return { InMemoryRunCache, EventBus, resolveLimits, LimitsCapability };
  }

  it("output over the cap is stored IN FULL by reference; result carries head+tail+handle and the exit code is preserved", async () => {
    const { InMemoryRunCache, EventBus, resolveLimits, LimitsCapability } = await wiring();
    const bus = new EventBus();
    const byRef: { what: string; bytes: number; key: string }[] = [];
    bus.subscribe("BY_REFERENCE", (e) => byRef.push(e.payload as { what: string; bytes: number; key: string }));
    const hits: { key: string; value: number }[] = [];
    bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string; value: number }));
    const limits = new LimitsCapability(resolveLimits([{ layer: "project", limits: { tools: { commandOutputMaxBytes: 500, commandHeadLines: 3, commandTailLines: 2 } } }]), bus);
    const runCache = new InMemoryRunCache({ sessionId: "s1" });

    // Print 1000 numbered lines (~ several KB, well over the 500-byte cap), exit 7.
    const cmd = `sh -c 'for i in $(seq 1 1000); do echo "line $i"; done; exit 7'`;
    const r = await runCommand(cmd, { cwd: ws, limits, runCache, onByReference: (i) => bus.emit("BY_REFERENCE", i, {}) });

    expect(r.exitCode).toBe(7);
    expect(r.truncated).toBe(true);
    // Head and tail are present; the exit-code line survives.
    expect(r.output).toContain("line 1\n");
    expect(r.output).toContain("line 1000");
    expect(r.output).toContain("Exit code: 7");
    // The handle marker names the kind, lines, bytes and read_file.
    const m = r.output.match(/\[full output: (\S+) \((\d+) lines, (\d+) bytes\) - read ranges with read_file\]/);
    expect(m).not.toBeNull();
    const handle = m![1]!;
    const lines = Number(m![2]);
    const bytes = Number(m![3]);
    expect(handle).toMatch(/^\.voidrift\/cache\/run\/s1\/command-output-/);
    expect(lines).toBe(1001); // 1000 echoed lines + trailing newline (read_file line counting)

    // The full blob is readable and holds EVERY line, not a cut.
    const full = runCache.read(handle);
    expect(full).not.toBeNull();
    expect(full).toContain("line 1\n");
    expect(full).toContain("line 500\n");
    expect(full).toContain("line 1000");
    expect(Buffer.byteLength(full!, "utf8")).toBe(bytes);

    // BY_REFERENCE + LIMIT_HIT fired naming the key.
    expect(byRef.length).toBe(1);
    expect(byRef[0]!.key).toBe("tools.commandOutputMaxBytes");
    expect(byRef[0]!.bytes).toBe(bytes);
    expect(hits.some((h) => h.key === "tools.commandOutputMaxBytes")).toBe(true);
  }, 30_000);

  it("a ranged read of the handle blob returns the exact middle lines", async () => {
    const { InMemoryRunCache, resolveLimits, LimitsCapability } = await wiring();
    const { EventBus } = await import("../entities/event-bus.js");
    const limits = new LimitsCapability(resolveLimits([{ layer: "project", limits: { tools: { commandOutputMaxBytes: 500 } } }]), new EventBus());
    const runCache = new InMemoryRunCache({ sessionId: "s2" });
    const r = await runCommand(`sh -c 'for i in $(seq 1 1000); do echo "line $i"; done'`, { cwd: ws, limits, runCache });
    const handle = r.output.match(/\[full output: (\S+) /)![1]!;
    const full = runCache.read(handle)!;
    // Slice lines 400..402 as read_file(offset,limit) would address them.
    const slice = full.split("\n").slice(399, 402).join("\n");
    expect(slice).toBe("line 400\nline 401\nline 402");
  }, 30_000);

  it("output below the cap is byte-identical to the no-runCache path (nothing stored)", async () => {
    const { InMemoryRunCache, resolveLimits, LimitsCapability } = await wiring();
    const { EventBus } = await import("../entities/event-bus.js");
    const limits = new LimitsCapability(resolveLimits([]), new EventBus());
    const runCache = new InMemoryRunCache({ sessionId: "s3" });
    const r = await runCommand("echo hello", { cwd: ws, limits, runCache });
    expect(r.output).toBe("hello\n");
    expect(r.truncated).toBe(false);
    // Same as the plain path.
    const plain = await runCommand("echo hello", { cwd: ws });
    expect(r.output).toBe(plain.output);
  });

  it("without a runCache, oversized output falls back to the inline truncation marker (unchanged)", async () => {
    const r = await runCommand(`sh -c 'for i in $(seq 1 1000); do echo "line $i"; done'`, { cwd: ws, maxOutputBytes: 200 });
    expect(r.truncated).toBe(true);
    expect(r.output).toContain("... Output truncated at 200 bytes.");
    expect(r.output).not.toContain("[full output:");
  }, 30_000);

  it("a blob over run.entryMaxBytes is capped in the file with a marker naming the key", async () => {
    const { InMemoryRunCache, resolveLimits, LimitsCapability } = await wiring();
    const { EventBus } = await import("../entities/event-bus.js");
    const limits = new LimitsCapability(resolveLimits([{ layer: "project", limits: { tools: { commandOutputMaxBytes: 500 }, run: { entryMaxBytes: 4000 } } }]), new EventBus());
    const runCache = new InMemoryRunCache({ sessionId: "s4", entryMaxBytes: 4000 });
    const r = await runCommand(`sh -c 'for i in $(seq 1 5000); do echo "line $i"; done'`, { cwd: ws, limits, runCache });
    const handle = r.output.match(/\[full output: (\S+) /)![1]!;
    const full = runCache.read(handle)!;
    expect(Buffer.byteLength(full, "utf8")).toBeLessThanOrEqual(4000);
    // The result marker tells the model the blob itself was capped at the key.
    expect(r.output).toContain("run.entryMaxBytes");
  }, 30_000);

  it("cancel mid-output kills the group and stores no dangling blob", async () => {
    const { InMemoryRunCache, resolveLimits, LimitsCapability } = await wiring();
    const { EventBus } = await import("../entities/event-bus.js");
    const limits = new LimitsCapability(resolveLimits([{ layer: "project", limits: { tools: { commandOutputMaxBytes: 100 } } }]), new EventBus());
    const runCache = new InMemoryRunCache({ sessionId: "s5" });
    const marker = `vrmark_${Date.now()}_byref`;
    const ac = new AbortController();
    const p = runCommand(`sh -c 'exec -a ${marker} sh -c "while true; do echo spam; done"'`, { cwd: ws, signal: ac.signal, limits, runCache });
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    const r = await p;
    expect(r.output).toBe("Command cancelled.");
    expect(await waitGone(marker, 2000)).toBe(true);
    // Nothing was stored for a cancelled run.
    expect((runCache as unknown as { map: Map<string, unknown> }).map.size).toBe(0);
  }, 20_000);

  it("masks secrets in the stored blob (MED §10.10): an API-key-shaped line and a PEM block are redacted", async () => {
    const { InMemoryRunCache, resolveLimits, LimitsCapability } = await wiring();
    const { EventBus } = await import("../entities/event-bus.js");
    const limits = new LimitsCapability(
      resolveLimits([{ layer: "project", limits: { tools: { commandOutputMaxBytes: 200 } } }]),
      new EventBus(),
    );
    const runCache = new InMemoryRunCache({ sessionId: "sm" });
    // Emit an AWS-shaped key, a PEM block, and bulk filler to force by-reference.
    const key = "AKIA" + "ABCDEFGHIJKLMNOP"; // AWS access key id shape
    const cmd =
      `sh -c 'echo "aws_key=${key}"; ` +
      `echo "-----B` + `EGIN RSA PRIVATE KEY-----"; echo "MIIBderPRIVATEkeybytes=="; echo "-----END RSA PRIVATE KEY-----"; ` +
      `for i in $(seq 1 500); do echo "filler $i"; done'`;
    const r = await runCommand(cmd, { cwd: ws, limits, runCache });
    expect(r.truncated).toBe(true);
    const handle = r.output.match(/\[full output: (\S+) /)![1]!;
    const full = runCache.read(handle)!;
    // The stored blob (re-readable by read_file) must NOT contain the raw secrets.
    expect(full).not.toContain(key);
    expect(full).not.toContain("MIIBderPRIVATEkeybytes==");
    expect(full).toContain("«redacted:");
    // Filler survives (only secrets are masked).
    expect(full).toContain("filler 1");
  }, 30_000);
});
