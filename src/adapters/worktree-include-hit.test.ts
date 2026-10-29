/**
 * Worktree-include over-cap LIMIT_HIT (core-blueprint.md §13.11, SNAP4; owner
 * 2026-10-29). `worktree.includeCapBytes` is `warn`: an entry that would push
 * past the byte cap is skipped WHOLE and the copy keeps going (never a refused
 * worktree create), and exactly ONE `LIMIT_HIT` names the key where the entry is
 * skipped. The port dedups per key per turn, so many over-cap entries still
 * surface once.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { copyIncludeList } from "./worktree-include.js";
import { EventBus } from "../entities/event-bus.js";
import { resolveLimits } from "../entities/limits-resolve.js";
import { LimitsCapability } from "../use-cases/limits-capability.js";

interface HitPayload {
  key: string;
  area: string;
  value: number;
  action: "warn" | "deny";
  observed?: number;
}

describe("copyIncludeList — worktree.includeCapBytes emits one LIMIT_HIT (§13.11)", () => {
  let main: string;
  let wt: string;
  beforeEach(() => {
    main = hermeticTmp("wtinc-main");
    wt = hermeticTmp("wtinc-wt");
  });
  afterEach(async () => {
    await fsp.rm(main, { recursive: true, force: true });
    await fsp.rm(wt, { recursive: true, force: true });
  });

  it("GIVEN an over-cap entry WHEN copying THEN it is skipped, the under-cap entry copies, and one LIMIT_HIT names the key", () => {
    // a.bin fits under the 150-byte cap; b.bin pushes past it.
    fs.writeFileSync(path.join(main, "a.bin"), Buffer.alloc(100, 1));
    fs.writeFileSync(path.join(main, "b.bin"), Buffer.alloc(200, 1));

    const bus = new EventBus();
    const hits: HitPayload[] = [];
    bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as HitPayload));
    const limits = new LimitsCapability(
      resolveLimits([{ layer: "project", limits: { worktree: { includeCapBytes: 150 } } }]),
      bus,
    );

    const res = copyIncludeList(main, wt, ["a.bin", "b.bin"], () => false, 150, limits);

    // warn never blocks: a.bin copied, b.bin skipped, the copy kept going.
    expect(res.copied.map((c) => c.path)).toEqual(["a.bin"]);
    expect(res.skipped.find((s) => s.path === "b.bin")?.reason).toContain("worktree.includeCapBytes");
    expect(fs.existsSync(path.join(wt, "a.bin"))).toBe(true);
    expect(fs.existsSync(path.join(wt, "b.bin"))).toBe(false);

    // Exactly one LIMIT_HIT naming the key, action warn, observed = would-be total.
    expect(hits.length).toBe(1);
    expect(hits[0]?.key).toBe("worktree.includeCapBytes");
    expect(hits[0]?.area).toBe("worktree");
    expect(hits[0]?.action).toBe("warn");
    expect(hits[0]?.value).toBe(150);
    expect(hits[0]?.observed).toBe(300);
  });

  it("GIVEN no over-cap entry THEN no LIMIT_HIT fires", () => {
    fs.writeFileSync(path.join(main, "a.bin"), Buffer.alloc(50, 1));
    const bus = new EventBus();
    const hits: HitPayload[] = [];
    bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as HitPayload));
    const limits = new LimitsCapability(resolveLimits([]), bus);
    const res = copyIncludeList(main, wt, ["a.bin"], () => false, 1000, limits);
    expect(res.copied.map((c) => c.path)).toEqual(["a.bin"]);
    expect(hits.filter((h) => h.key === "worktree.includeCapBytes").length).toBe(0);
  });
});
