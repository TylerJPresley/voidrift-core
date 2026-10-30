/**
 * §6.3/§13.11 `memory.entryChars` — the per-entry char cap is a `warn`-class
 * registry key: an over-length entry is ACCEPTED in full with exactly ONE
 * `LIMIT_HIT` naming the key; a configured `{action:"deny"}` refuses before any
 * persist with the same notice (the `MEMORY_BOUND_EXCEEDED` error shape) and
 * emits one hit too. Driven over the real Memory use-case with a real
 * `LimitsCapability` port. Deterministic, offline, in-memory store.
 */
import { describe, it, expect } from "vitest";
import { Memory, type MemoryDeps } from "./memory.js";
import { InMemoryMemoryStore } from "../adapters/repositories/in-memory-memory-store.js";
import { SuggestionsDirectory } from "../adapters/suggestions-directory.js";
import { InMemoryFileSystem } from "../adapters/in-memory-filesystem.js";
import { EventBus, type EventEnvelope } from "../entities/event-bus.js";
import { InMemorySessionRepository } from "../adapters/repositories/session-repository.js";
import { resolveLimits } from "../entities/limits-resolve.js";
import { LimitsCapability } from "./limits-capability.js";

function makeMemory(entryChars: number, action?: "deny") {
  const bus = new EventBus();
  const events: EventEnvelope[] = [];
  bus.subscribe("*", (e) => events.push(e));
  const leaf = action ? { value: entryChars, action } : entryChars;
  const limits = new LimitsCapability(resolveLimits([{ layer: "project", limits: { memory: { entryChars: leaf } } }]), bus);
  const deps: MemoryDeps = {
    store: new InMemoryMemoryStore(),
    bus,
    sessions: new InMemorySessionRepository(),
    suggestions: new SuggestionsDirectory(new InMemoryFileSystem(), ".voidrift/suggestions"),
    getBounds: () => ({ entryChars, reflectionBatchSize: 3 }),
    discoverProjectFiles: async () => [],
    limits,
  };
  const hitsOf = () => events.filter((e) => e.type === "LIMIT_HIT").map((e) => e.payload as { key: string });
  return { memory: new Memory(deps), events, hitsOf };
}

describe("memory.entryChars — warn vs deny (§6.3, §13.11 M1)", () => {
  it("warn (the default action): an over-bound write is ACCEPTED and emits exactly one LIMIT_HIT", async () => {
    const { memory, events, hitsOf } = makeMemory(2200);
    const res = await memory.write({ title: "Prefs", type: "user-model", scope: "workspace", body: "x".repeat(2201) });
    expect(res.ok).toBe(true);
    expect(events.filter((e) => e.type === "MEMORY_SAVED")).toHaveLength(1);
    expect(hitsOf().filter((h) => h.key === "memory.entryChars").length).toBe(1);
  });

  it("deny (a configured action): an over-bound write is REFUSED MEMORY_BOUND_EXCEEDED with the same notice, no write, one LIMIT_HIT", async () => {
    const { memory, events, hitsOf } = makeMemory(2200, "deny");
    const res = await memory.write({ title: "Prefs", type: "user-model", scope: "workspace", body: "x".repeat(2201) });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("MEMORY_BOUND_EXCEEDED");
      expect(res.error.message).toContain("limits.memory.entryChars");
      expect(res.error.details).toMatchObject({ size: 2201, limit: 2200 });
    }
    expect(events.filter((e) => e.type === "MEMORY_SAVED")).toHaveLength(0);
    expect(hitsOf().filter((h) => h.key === "memory.entryChars").length).toBe(1);
  });
});
