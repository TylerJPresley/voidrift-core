import { describe, it, expect, vi } from "vitest";
import { EventBus } from "./event-bus.js";

describe("EventBus — scoped, outward-only (§14.5)", () => {
  it("delivers only matching scopes and never a sibling session's events", () => {
    // Given a bus with a session-A-scoped subscriber.
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe("*", (e) => seen.push(String((e.payload as { tag: string }).tag)), { scope: { session: "A" } });

    // When events fire for A, A's worker, and B.
    bus.emit("X", { tag: "a" }, { session: "A" });
    bus.emit("X", { tag: "a-worker" }, { session: "A", worker: "w1" });
    bus.emit("X", { tag: "b" }, { session: "B" });
    bus.emit("X", { tag: "global" }, {});

    // Then the subscriber sees A and A's worker, never B, never global.
    expect(seen).toEqual(["a", "a-worker"]);
  });

  it("an unscoped subscriber receives every scope including global", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe("X", (e) => seen.push(String((e.payload as { t: string }).t)));
    bus.emit("X", { t: "s" }, { session: "A" });
    bus.emit("X", { t: "g" }, {});
    bus.emit("Y", { t: "ignored" }, {});
    expect(seen).toEqual(["s", "g"]);
  });

  it("isolates a throwing subscriber and runs core before plugin subscribers", () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.subscribe("X", () => order.push("plugin"), { isPlugin: true });
    bus.subscribe("X", () => {
      throw new Error("boom");
    });
    bus.subscribe("X", () => order.push("core"));
    expect(() => bus.emit("X", {}, {})).not.toThrow();
    expect(order).toEqual(["core", "plugin"]);
  });

  it("register tracks custom event names and unsubscribe stops delivery", () => {
    const bus = new EventBus();
    expect(bus.isRegistered("CUSTOM")).toBe(false);
    bus.register("CUSTOM");
    expect(bus.isRegistered("CUSTOM")).toBe(true);
    const handler = vi.fn();
    const off = bus.subscribe("CUSTOM", handler);
    bus.emit("CUSTOM", {}, {});
    off();
    bus.emit("CUSTOM", {}, {});
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
