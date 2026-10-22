/**
 * §8.4 MCP ready-grace bound (limits.mcp.readyGraceMs). The one-time wait for
 * the non-blocking MCP auto-connect reads its bound through the LimitsPort and
 * fires a LIMIT_HIT when the grace expires with servers still connecting.
 *
 * Exercises the pure `awaitMcpReadyBounded` helper (deterministic, no fake
 * timers needed) plus the registry default and override, and the LIMIT_HIT the
 * LimitsCapability emits when the grace is hit.
 */
import { describe, it, expect } from "vitest";
import { EventBus } from "../entities/event-bus.js";
import { resolveLimits } from "../entities/limits-resolve.js";
import { LimitsCapability } from "./limits-capability.js";
import { limitDefault } from "../entities/limits.js";
import { awaitMcpReadyBounded } from "./engine.js";

describe("mcp.readyGraceMs registry row", () => {
  it("defaults to 5000ms", () => {
    expect(limitDefault("mcp.readyGraceMs")).toBe(5000);
  });

  it("an override changes the effective wait", () => {
    const resolved = resolveLimits([{ layer: "project", limits: { mcp: { readyGraceMs: 25 } } }]);
    const limits = new LimitsCapability(resolved, new EventBus());
    expect(limits.get("mcp.readyGraceMs")).toBe(25);
  });
});

describe("awaitMcpReadyBounded", () => {
  it("returns false when auto-connect settles within the grace", async () => {
    const ready = Promise.resolve();
    const timedOut = await awaitMcpReadyBounded(ready, 1000);
    expect(timedOut).toBe(false);
  });

  it("returns true when the grace expires with servers still connecting", async () => {
    // A promise that never settles within the test window.
    const ready = new Promise<void>(() => undefined);
    const timedOut = await awaitMcpReadyBounded(ready, 10);
    expect(timedOut).toBe(true);
  });

  it("a rejected auto-connect is non-fatal (treated as settled, not a timeout)", async () => {
    const ready = Promise.reject(new Error("connect failed"));
    const timedOut = await awaitMcpReadyBounded(ready, 1000);
    expect(timedOut).toBe(false);
  });

  it("fires LIMIT_HIT on mcp.readyGraceMs when the grace is hit", async () => {
    const bus = new EventBus();
    const events: { key: string; value: number; area: string }[] = [];
    bus.subscribe("LIMIT_HIT", (e) => events.push(e.payload as { key: string; value: number; area: string }));
    const resolved = resolveLimits([{ layer: "project", limits: { mcp: { readyGraceMs: 10 } } }]);
    const limits = new LimitsCapability(resolved, bus, { session: "s1" });

    const graceMs = limits.get("mcp.readyGraceMs");
    const timedOut = await awaitMcpReadyBounded(new Promise<void>(() => undefined), graceMs);
    if (timedOut) {
      limits.hit("mcp.readyGraceMs", graceMs, { session: "s1", what: "MCP auto-connect still running when the grace expired" });
    }

    expect(timedOut).toBe(true);
    expect(events.length).toBe(1);
    expect(events[0].key).toBe("mcp.readyGraceMs");
    expect(events[0].area).toBe("mcp");
    expect(events[0].value).toBe(10);
  });
});
