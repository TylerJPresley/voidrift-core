import { describe, it, expect } from "vitest";
import { RegistryStore, CORE_NAMESPACE } from "./registry-store.js";
import { InMemoryRegistryPersistence } from "./registry-persistence.js";

describe("RegistryStore — durable mode (§12.5)", () => {
  it("behaviour is identical to the in-memory store for set/get/query/remove", () => {
    const store = new RegistryStore(new InMemoryRegistryPersistence());
    store.set("a", "panel:x", 1);
    store.set("a", "panel:y", 2);
    store.set("a", "other", 3);
    store.set("b", "panel:z", 9);
    expect(store.get("a", "panel:x")).toBe(1);
    expect(store.query("a", "panel:").map((h) => h.key)).toEqual(["panel:x", "panel:y"]);
    store.remove("a", "panel:x");
    expect(store.get("a", "panel:x")).toBeNull();
    expect(store.get("a", "nope")).toBeNull();
  });

  it("persists each namespace to the backing store on every mutation", () => {
    const backing = new InMemoryRegistryPersistence();
    const store = new RegistryStore(backing);
    store.set("plugin", "k1", "v1");
    store.set("plugin", "k2", "v2");
    expect(backing.peek("plugin")).toEqual({ k1: "v1", k2: "v2" });
    store.remove("plugin", "k1");
    expect(backing.peek("plugin")).toEqual({ k2: "v2" });
  });

  it("a SECOND store over the same backing sees the first's entries (two-process style)", () => {
    const backing = new InMemoryRegistryPersistence();
    // Process 1 saves a routine and a plan.
    const p1 = new RegistryStore(backing);
    p1.set("@voidrift/plugin-routines", "routine:daily", { id: "daily", prompt: "hi" });
    p1.set("@voidrift/plugin-plan", "plan:demo", { id: "demo", goal: "ship" });
    p1.set("@voidrift/plugin-plan", "active-plan", "demo");

    // Process 2 boots fresh over the same store and reads them back lazily.
    const p2 = new RegistryStore(backing);
    expect(p2.get("@voidrift/plugin-routines", "routine:daily")).toEqual({ id: "daily", prompt: "hi" });
    expect(p2.get("@voidrift/plugin-plan", "plan:demo")).toEqual({ id: "demo", goal: "ship" });
    expect(p2.get("@voidrift/plugin-plan", "active-plan")).toBe("demo");
  });

  it("reserved core namespaces stay in memory and are never persisted", () => {
    const backing = new InMemoryRegistryPersistence();
    const store = new RegistryStore(backing);
    store.set(CORE_NAMESPACE, "panels.sessions", { title: "Sessions" });
    expect(store.get(CORE_NAMESPACE, "panels.sessions")).toEqual({ title: "Sessions" });
    // The reserved namespace is NOT written to the durable backend.
    expect(backing.peek(CORE_NAMESPACE)).toBeUndefined();
    // A second process does NOT see it (it is re-registered at boot, not stored).
    const p2 = new RegistryStore(backing);
    expect(p2.get(CORE_NAMESPACE, "panels.sessions")).toBeNull();
  });

  it("removeNamespace removes the plugin's backing file wholesale (disable)", () => {
    const backing = new InMemoryRegistryPersistence();
    const store = new RegistryStore(backing);
    store.set("p", "routine:a", 1);
    expect(backing.peek("p")).toEqual({ "routine:a": 1 });
    store.removeNamespace("p");
    expect(backing.peek("p")).toBeUndefined();
    expect(store.get("p", "routine:a")).toBeNull();
  });

  it("refuses a value over the 64 KiB per-value cap with deny action", () => {
    const store = new RegistryStore(new InMemoryRegistryPersistence(), {
      getLimit: () => 64 * 1024,
      getLimitAction: () => "deny",
    });
    const big = "x".repeat(64 * 1024 + 1);
    expect(() => store.set("p", "k", big)).toThrow(/per-value cap/);
    // The in-memory store (no persistence) does not cap — identical API, no throw.
    const plain = new RegistryStore();
    expect(() => plain.set("p", "k", big)).not.toThrow();
  });

  it("stores a value over the 64 KiB per-value cap with warn action and emits LIMIT_HIT", () => {
    const limits: any[] = [];
    const store = new RegistryStore(new InMemoryRegistryPersistence(), {
      getLimit: () => 64 * 1024,
      getLimitAction: () => "warn",
      onLimitHit: (key, detail) => limits.push({ key, detail }),
    });
    const big = "x".repeat(64 * 1024 + 1);
    expect(() => store.set("p", "k", big)).not.toThrow();
    expect(limits).toHaveLength(1);
    expect(limits[0].key).toBe("plugins.registryValueMaxBytes");
    expect(store.get("p", "k")).toBe(big);
  });

  it("lazy-loads a namespace only once, then reads from memory", () => {
    const backing = new InMemoryRegistryPersistence();
    backing.save("p", { "routine:a": 1 });
    const store = new RegistryStore(backing);
    expect(store.get("p", "routine:a")).toBe(1);
    // A later write by this store flushes the full namespace back.
    store.set("p", "routine:b", 2);
    expect(backing.peek("p")).toEqual({ "routine:a": 1, "routine:b": 2 });
  });
});
