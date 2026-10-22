import { describe, it, expect } from "vitest";
import { RegistryStore, CORE_NAMESPACE } from "./registry-store.js";

describe("RegistryStore (§12.5)", () => {
  it("namespaces keys so two namespaces never collide", () => {
    const s = new RegistryStore();
    s.set("plugin-a", "k", 1);
    s.set("plugin-b", "k", 2);
    expect(s.get("plugin-a", "k")).toBe(1);
    expect(s.get("plugin-b", "k")).toBe(2);
  });

  it("query matches by prefix within the namespace only", () => {
    const s = new RegistryStore();
    s.set("a", "panel:x", 1);
    s.set("a", "panel:y", 2);
    s.set("a", "other", 3);
    s.set("b", "panel:z", 9);
    const hits = s.query("a", "panel:");
    expect(hits.map((h) => h.key)).toEqual(["panel:x", "panel:y"]);
  });

  it("removeNamespace drops every key in a namespace wholesale", () => {
    const s = new RegistryStore();
    s.set("a", "k1", 1);
    s.set("a", "k2", 2);
    s.set("b", "k1", 3);
    s.removeNamespace("a");
    expect(s.get("a", "k1")).toBeNull();
    expect(s.get("a", "k2")).toBeNull();
    expect(s.get("b", "k1")).toBe(3);
  });

  it("the core namespace is a distinct, reserved space", () => {
    const s = new RegistryStore();
    s.set(CORE_NAMESPACE, "panels", ["p1"]);
    s.set("plugin", "panels", ["evil"]);
    expect(s.get(CORE_NAMESPACE, "panels")).toEqual(["p1"]);
  });

  it("get returns null for an absent key and remove is a no-op when absent", () => {
    const s = new RegistryStore();
    expect(s.get("a", "nope")).toBeNull();
    s.remove("a", "nope");
    expect(s.get("a", "nope")).toBeNull();
  });
});
