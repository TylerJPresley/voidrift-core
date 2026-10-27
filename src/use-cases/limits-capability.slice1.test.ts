import { describe, it, expect, beforeEach } from "vitest";
import { LimitsCapability } from "./limits-capability.js";
import { resolveLimits } from "../entities/limits-resolve.js";
import { EventBus } from "../entities/event-bus.js";

describe("LimitsCapability: LIMIT_HIT event payload action (SLICE 1)", () => {
  let bus: EventBus;
  let emittedEvents: Array<{ type: string; payload: unknown }> = [];

  beforeEach(() => {
    bus = new EventBus();
    emittedEvents = [];
    // Subscribe to all LIMIT_HIT events
    bus.subscribe("LIMIT_HIT", (envelope) => {
      emittedEvents.push({ type: envelope.type, payload: envelope.payload });
    });
  });

  it("LIMIT_HIT carries action field from registry", () => {
    const resolved = resolveLimits([]);
    const capability = new LimitsCapability(resolved, bus);

    const result = capability.hit("tools.webFetchBodyMaxBytes", 5242880);
    expect(result.action).toBe("deny");
  });

  it("LIMIT_HIT emits action: deny when limit is deny", () => {
    const resolved = resolveLimits([]);
    const capability = new LimitsCapability(resolved, bus);

    capability.hit("tools.webFetchBodyMaxBytes", 5242880);

    expect(emittedEvents.length).toBeGreaterThan(0);
    const payload = emittedEvents[0]?.payload as any;
    expect(payload.action).toBe("deny");
  });

  it("LIMIT_HIT emits action: warn when limit is warn", () => {
    const resolved = resolveLimits([]);
    const capability = new LimitsCapability(resolved, bus);

    capability.hit("context.estimateMarginTokens", 2000);

    expect(emittedEvents.length).toBeGreaterThan(0);
    const payload = emittedEvents[0]?.payload as any;
    expect(payload.action).toBe("warn");
  });

  it("hit() returns action from registry (not overridable in resolver)", () => {
    // The resolver doesn't support overriding action
    // Action always comes from the registry spec
    const resolved = resolveLimits([
      {
        layer: "global",
        limits: { tools: { webFetchBodyMaxBytes: 5242880 } },
      },
    ]);
    const capability = new LimitsCapability(resolved, bus);

    const result = capability.hit("tools.webFetchBodyMaxBytes");
    expect(result.action).toBe("deny");
  });

  it("LIMIT_HIT carries key, area, value and action", () => {
    const resolved = resolveLimits([]);
    const capability = new LimitsCapability(resolved, bus);

    capability.hit("tools.imageMaxBytes", 5242880);

    expect(emittedEvents.length).toBeGreaterThan(0);
    const payload = emittedEvents[0]?.payload as any;
    expect(payload.key).toBe("tools.imageMaxBytes");
    expect(payload.area).toBe("tools");
    expect(typeof payload.value).toBe("number");
    expect(["warn", "deny"]).toContain(payload.action);
  });

  it("deduplicates LIMIT_HIT per turn", () => {
    const resolved = resolveLimits([]);
    const capability = new LimitsCapability(resolved, bus);

    const result1 = capability.hit("context.estimateMarginTokens");
    const result2 = capability.hit("context.estimateMarginTokens");

    expect(result1.first).toBe(true);
    expect(result2.first).toBe(false);
    expect(emittedEvents.length).toBe(1);
  });

  it("different keys emit separate LIMIT_HIT events", () => {
    const resolved = resolveLimits([]);
    const capability = new LimitsCapability(resolved, bus);

    capability.hit("context.estimateMarginTokens");
    capability.hit("tools.webFetchBodyMaxBytes");

    expect(emittedEvents.length).toBe(2);
  });

  it("resetTurn clears per-turn dedup", () => {
    const resolved = resolveLimits([]);
    const capability = new LimitsCapability(resolved, bus);

    const result1 = capability.hit("context.estimateMarginTokens");
    expect(result1.first).toBe(true);

    capability.resetTurn();

    const result2 = capability.hit("context.estimateMarginTokens");
    expect(result2.first).toBe(true);
    expect(emittedEvents.length).toBe(2);
  });

  it("action is always from registry spec (not from user config)", () => {
    // The resolver doesn't support action overrides; it only resolves numeric values
    // Action always comes from the registry
    const resolved = resolveLimits([
      {
        layer: "global",
        limits: { context: { estimateMarginTokens: 2000 } },
      },
    ]);
    const capability = new LimitsCapability(resolved, bus);

    const result = capability.hit("context.estimateMarginTokens");
    // Registry says warn, so even with custom value, action stays warn
    expect(result.action).toBe("warn");

    expect(emittedEvents.length).toBeGreaterThan(0);
    const payload = emittedEvents[0]?.payload as any;
    expect(payload.action).toBe("warn");
  });
});
