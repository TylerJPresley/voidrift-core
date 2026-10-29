/**
 * Command-timeout LIMIT_HIT (core-blueprint.md §13.11, TOOL6; owner 2026-10-29).
 *
 * `tools.commandTimeoutMs` STAYS `deny` (a command that never times out hangs
 * the run). When the timeout FIRES the process group is killed AND exactly one
 * `LIMIT_HIT {key,area,value,action,observed}` is emitted naming the key and the
 * raise path, so the kill is discoverable in the trail. A command that finishes
 * within the budget emits no LIMIT_HIT.
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

interface HitPayload {
  key: string;
  area: string;
  value: number;
  action: "warn" | "deny";
  observed?: number;
}

describe.skipIf(skip)("runCommand — tools.commandTimeoutMs fires a LIMIT_HIT (§13.11)", () => {
  let ws: string;
  beforeEach(() => {
    ws = hermeticTmp("cmdrun-timeout-hit");
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("GIVEN a short timeout WHEN a command exceeds it THEN the process is killed AND one LIMIT_HIT (action deny) names the key", async () => {
    const bus = new EventBus();
    const hits: HitPayload[] = [];
    bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as HitPayload));
    const limits = new LimitsCapability(
      resolveLimits([{ layer: "project", limits: { tools: { commandTimeoutMs: 300 } } }]),
      bus,
    );
    const marker = `vrmark_${Date.now()}_timeout`;
    const markerPath = await createProcessMarker(ws, marker, "sleep");
    // A long-running command run under the marker symlink so argv[0] carries it,
    // proving the WHOLE process group dies when the timeout fires.
    const r = await runCommand(`${markerPath} 30`, { cwd: ws, limits });

    // Timed out: the normal 124 error result (behaviour for output WITHIN cap).
    expect(r.exitCode).toBe(124);
    expect(r.output).toContain("Command timed out after 0.3 seconds.");

    // The process group was killed — nothing survives the returned promise.
    expect(await waitGone(marker, 3000)).toBe(true);

    // Exactly one LIMIT_HIT naming the key, with action deny and the observed ms.
    expect(hits.length).toBe(1);
    expect(hits[0]?.key).toBe("tools.commandTimeoutMs");
    expect(hits[0]?.area).toBe("tools");
    expect(hits[0]?.action).toBe("deny");
    expect(hits[0]?.value).toBe(300);
    expect(hits[0]?.observed).toBe(300);
  }, 20_000);

  it("GIVEN a command that finishes within the budget THEN no LIMIT_HIT fires", async () => {
    const bus = new EventBus();
    const hits: HitPayload[] = [];
    bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as HitPayload));
    const limits = new LimitsCapability(resolveLimits([]), bus);
    const r = await runCommand("echo hello", { cwd: ws, limits });
    expect(r.exitCode).toBe(0);
    expect(hits.filter((h) => h.key === "tools.commandTimeoutMs").length).toBe(0);
  });
});
