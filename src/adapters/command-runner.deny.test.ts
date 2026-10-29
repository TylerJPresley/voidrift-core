/**
 * Deny conformance for `tools.commandOutputMaxBytes` at the command runner
 * (core-blueprint.md §13.11). A `warn` limit never blocks: at the bound the run
 * continues, the capability emits one `LIMIT_HIT` and the model keeps a bounded
 * view. A `deny` limit refuses at the bound: the process is killed through the
 * EXISTING kill path (`tools.commandKillGraceMs`), the tool returns its normal
 * error result whose one-line message is the notice (key, value, raise path),
 * the output past the bound is NOT delivered, and exactly ONE `LIMIT_HIT` fires
 * with action `deny`.
 *
 * Linux/macOS only (POSIX process groups); skips on win32.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import { runCommand } from "./command-runner.js";
import { EventBus } from "../entities/event-bus.js";
import { resolveLimits } from "../entities/limits-resolve.js";
import { LimitsCapability } from "../use-cases/limits-capability.js";
import { createProcessMarker } from "../test-support/process-marker.js";

const skip = process.platform === "win32";

function markerAlive(marker: string): boolean {
  try {
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

function denyLimits(bus: EventBus, value = 50): LimitsCapability {
  return new LimitsCapability(resolveLimits([{ layer: "project", limits: { tools: { commandOutputMaxBytes: { value, action: "deny" } } } }]), bus);
}

function warnLimits(bus: EventBus, value = 50): LimitsCapability {
  return new LimitsCapability(resolveLimits([{ layer: "project", limits: { tools: { commandOutputMaxBytes: { value, action: "warn" } } } }]), bus);
}

describe.skipIf(skip)("runCommand — tools.commandOutputMaxBytes deny (§13.11)", () => {
  let ws: string;
  beforeEach(() => {
    ws = hermeticTmp("cmdrun-deny");
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("warn: run continues, exactly one LIMIT_HIT, marker names the key", async () => {
    const bus = new EventBus();
    const hits: { key: string; action: string }[] = [];
    bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string; action: string }));
    const limits = warnLimits(bus);
    // node prints ~10 KB, well over the 50-byte cap.
    const r = await runCommand(`node -e "process.stdout.write('a'.repeat(10000))"`, { cwd: ws, limits });
    expect(r.truncated).toBe(true);
    expect(r.exitCode).toBe(0); // not an error; the run finished
    expect(r.output).toContain("limits.tools.commandOutputMaxBytes");
    expect(hits.length).toBe(1);
    expect(hits[0]?.key).toBe("tools.commandOutputMaxBytes");
    expect(hits[0]?.action).toBe("warn");
  }, 15_000);

  it("deny: refuses at the bound — error result, notice message, output past the bound not delivered, one LIMIT_HIT action deny", async () => {
    const bus = new EventBus();
    const hits: { key: string; value: number; action: string }[] = [];
    bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string; value: number; action: string }));
    const limits = denyLimits(bus, 50);
    const r = await runCommand(`node -e "process.stdout.write('a'.repeat(10000))"`, { cwd: ws, limits });
    // Error result shape (non-zero exit, truncated), one-line notice is the message.
    expect(r.exitCode).toBe(1);
    expect(r.truncated).toBe(true);
    expect(r.output).toContain("limits.tools.commandOutputMaxBytes");
    expect(r.output).toContain("50");
    // The output past the bound is NOT delivered: no 10 KB of 'a' leaks through.
    expect(r.output).not.toContain("a".repeat(100));
    // Exactly one LIMIT_HIT, action deny, naming the key.
    expect(hits.length).toBe(1);
    expect(hits[0]?.key).toBe("tools.commandOutputMaxBytes");
    expect(hits[0]?.action).toBe("deny");
    expect(hits[0]?.value).toBe(50);
  }, 15_000);

  it("deny: the spawned process is killed through the existing kill path (no orphan)", async () => {
    const bus = new EventBus();
    const limits = denyLimits(bus, 50);
    const marker = `vrmark_${Date.now()}_deny`;
    const markerPath = await createProcessMarker(ws, marker, "node");
    // A long-lived process that first floods output over the cap, then sleeps —
    // so if deny did not kill it, the marked process would linger.
    const r = await runCommand(
      `${markerPath} -e "process.stdout.write('a'.repeat(10000)); setInterval(()=>{}, 1000)"`,
      { cwd: ws, limits },
    );
    expect(r.exitCode).toBe(1);
    expect(r.truncated).toBe(true);
    // The process must be dead: nothing carrying the marker may linger.
    expect(await waitGone(marker, 3000)).toBe(true);
  }, 20_000);

  it("deny but output within the bound: no hit, success, byte-identical result", async () => {
    const bus = new EventBus();
    const hits: unknown[] = [];
    bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload));
    const limits = denyLimits(bus, 50);
    const r = await runCommand("echo hello", { cwd: ws, limits });
    expect(r.truncated).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe("hello\n");
    expect(hits.length).toBe(0);
  });

  it("default (no limits config): behaviour unchanged — oversized output truncates with the warn marker, run continues", async () => {
    // No limits port at all: the registry default (100000, action warn) applies,
    // output over an explicit small cap truncates inline and the run finishes.
    const r = await runCommand(`node -e "process.stdout.write('a'.repeat(2000))"`, { cwd: ws, maxOutputBytes: 100 });
    expect(r.truncated).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("... Output truncated at 100 bytes.");
    expect(r.output).toContain("limits.tools.commandOutputMaxBytes");
  }, 15_000);
});
