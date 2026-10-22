/**
 * LimitsCapability (§13.11, §14.6): get() reads the effective value; hit() emits
 * LIMIT_HIT at most once per key per turn with the blueprint's notice wording.
 */
import { describe, it, expect } from "vitest";
import { EventBus } from "../entities/event-bus.js";
import { resolveLimits } from "../entities/limits-resolve.js";
import { LimitsCapability } from "./limits-capability.js";
import { limitMarker } from "../entities/ports/limits-port.js";

function setup() {
  const bus = new EventBus();
  const events: { key: string; value: number; area: string }[] = [];
  bus.subscribe("LIMIT_HIT", (e) => events.push(e.payload as { key: string; value: number; area: string }));
  const resolved = resolveLimits([{ layer: "project", limits: { memory: { projectChars: 4000 } } }]);
  const limits = new LimitsCapability(resolved, bus, { session: "s1" });
  return { bus, events, limits };
}

describe("LimitsCapability", () => {
  it("get returns the resolved effective value", () => {
    const { limits } = setup();
    expect(limits.get("memory.projectChars")).toBe(4000);
    expect(limits.get("tools.commandOutputMaxBytes")).toBe(100_000);
  });

  it("get throws on an unknown key", () => {
    const { limits } = setup();
    expect(() => limits.get("nope.nope")).toThrow();
  });

  it("hit emits LIMIT_HIT once per key per turn", () => {
    const { limits, events } = setup();
    const r1 = limits.hit("memory.projectChars", 9000, { what: "project instructions truncated" });
    const r2 = limits.hit("memory.projectChars", 9500);
    expect(r1.first).toBe(true);
    expect(r2.first).toBe(false);
    expect(events.length).toBe(1);
    expect(events[0].key).toBe("memory.projectChars");
    expect(events[0].value).toBe(4000);
    expect(events[0].area).toBe("memory");
  });

  it("emits and notices the key exactly as REGISTERED (canonical case), not the caller's spelling", () => {
    const bus = new EventBus();
    const events: { key: string; notice: string }[] = [];
    bus.subscribe("LIMIT_HIT", (e) => events.push(e.payload as { key: string; notice: string }));
    const resolved = resolveLimits([]);
    const limits = new LimitsCapability(resolved, bus, { session: "s1" });
    // A mixed-case registry key (context.metaBlockMaxTokens) must appear in BOTH
    // the emitted payload and the notice exactly as registered — a headless run's
    // `voidrift: limit reached: context.metaBlockMaxTokens (…)` must not be
    // lower-cased.
    const r = limits.hit("context.metaBlockMaxTokens");
    expect(events[0].key).toBe("context.metaBlockMaxTokens");
    expect(r.notice).toContain("limits.context.metaBlockMaxTokens");
    expect(r.notice).not.toContain("metablockmaxtokens");
  });

  it("notice uses the blueprint wording", () => {
    const { limits } = setup();
    const r = limits.hit("memory.projectChars", 9000, { what: "project instructions truncated" });
    expect(r.notice).toBe("project instructions truncated (limits.memory.projectChars = 4000). Raise it in config: limits.memory.projectChars");
  });

  it("resetTurn re-arms the per-key emission", () => {
    const { limits, events } = setup();
    limits.hit("memory.projectChars");
    limits.resetTurn();
    const again = limits.hit("memory.projectChars");
    expect(again.first).toBe(true);
    expect(events.length).toBe(2);
  });

  it("a different key emits its own event in the same turn", () => {
    const { limits, events } = setup();
    limits.hit("memory.projectChars");
    limits.hit("tools.commandOutputMaxBytes");
    expect(events.length).toBe(2);
  });

  it("effectiveIngestParallel follows turnMaxConcurrency when unset (§8.7)", () => {
    const { limits } = setup(); // no ingest.maxParallel override → default source
    expect(limits.effectiveIngestParallel(4)).toBe(4);
    expect(limits.effectiveIngestParallel(1)).toBe(1);
  });

  it("effectiveIngestParallel uses an explicit override over turnMaxConcurrency", () => {
    const bus = new EventBus();
    const resolved = resolveLimits([{ layer: "project", limits: { ingest: { maxParallel: 2 } } }]);
    const limits = new LimitsCapability(resolved, bus);
    expect(limits.effectiveIngestParallel(8)).toBe(2);
  });
});

describe("limitMarker", () => {
  it("names the key in a short bracketed marker", () => {
    expect(limitMarker("tools.commandOutputMaxBytes")).toBe("[truncated: limits.tools.commandOutputMaxBytes]");
  });
  it("includes the observed size when given", () => {
    expect(limitMarker("tools.commandOutputMaxBytes", 123)).toBe("[truncated at limits.tools.commandOutputMaxBytes (123)]");
  });
});
