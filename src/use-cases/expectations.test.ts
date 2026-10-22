/**
 * Expectations capability — use-case layer (core-blueprint.md §9.5.1).
 *
 * `register({ scope, predicted })` / `clear(scope)` is a runtime, never-persisted
 * prediction seam. At scope CLOSE (the registrant clears the scope — the plan
 * advances/completes/abandons) the CORE reads that scope's actual write targets
 * from the mutation journal (core-internal; the plugin never reads the journal),
 * compares them with the shared matcher, and emits ONE
 * `WARNING_EMITTED { category:"surprise", source:"expectation", pattern, count }`
 * per scope close with the targets masked, plus a coverage ratio handed back to
 * the registrant. An empty/absent `predicted` registers nothing and runs no
 * comparison. The comparison influences no decision (invariant 27).
 */
import { describe, it, expect } from "vitest";
import { EventBus, type EventEnvelope } from "../entities/event-bus.js";
import { Expectations, type ScopeTargetsReader } from "./expectations.js";

/** An in-memory journal-target reader: scope id → the write targets recorded
 * for it (what the real core reads from the journal, filtered by plan step). */
function readerOf(targetsByScope: Record<string, string[]>): ScopeTargetsReader {
  return async (scopeId: string) => targetsByScope[scopeId] ?? [];
}

function captureWarnings(bus: EventBus): EventEnvelope[] {
  const hits: EventEnvelope[] = [];
  bus.subscribe("WARNING_EMITTED", (e) => hits.push(e));
  return hits;
}

const SESSION = { session: "s1" };

describe("§9.5.1 expectations capability", () => {
  it("a scope that writes an unpredicted target emits exactly one masked surprise with count at close", async () => {
    const bus = new EventBus();
    const warnings = captureWarnings(bus);
    const exp = new Expectations({
      bus,
      readScopeTargets: readerOf({
        "step-1": ["src/app.ts", "GITHUB_TOKEN=ghp_ab" + "cdefghijklmnopqrstuvwxyz0123456789"],
      }),
      sessionId: () => "s1",
    });
    exp.register({ scope: "step-1", predicted: ["src/**"] });

    const result = await exp.closeScope("step-1");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.payload).toMatchObject({ category: "surprise", source: "expectation" });
    const payload = warnings[0]!.payload as { pattern: string; count: number };
    expect(payload.count).toBe(1);
    // The surprise target carried a secret → masked by the shared detector.
    expect(payload.pattern).not.toContain("ghp_ab" + "cdefghijklmnopqrstuvwxyz0123456789");
    expect(payload.pattern).toContain("«redacted");
    // Scope-stamped (§14.5).
    expect(warnings[0]!.scope).toMatchObject(SESSION);
    // The coverage ratio is handed back to the registrant.
    expect(result?.coverage).toBeCloseTo(0.5);
  });

  it("an honest prediction covering every written target emits no surprise", async () => {
    const bus = new EventBus();
    const warnings = captureWarnings(bus);
    const exp = new Expectations({
      bus,
      readScopeTargets: readerOf({ "step-1": ["src/app.ts", "src/lib.ts"] }),
      sessionId: () => "s1",
    });
    exp.register({ scope: "step-1", predicted: ["src/**"] });
    const result = await exp.closeScope("step-1");
    expect(warnings).toHaveLength(0);
    expect(result?.coverage).toBe(1);
  });

  it("an empty predicted registers nothing and runs no comparison at close", async () => {
    const bus = new EventBus();
    const warnings = captureWarnings(bus);
    let read = 0;
    const exp = new Expectations({
      bus,
      readScopeTargets: async () => {
        read++;
        return ["src/app.ts"];
      },
      sessionId: () => "s1",
    });
    exp.register({ scope: "step-1", predicted: [] });
    const result = await exp.closeScope("step-1");
    expect(warnings).toHaveLength(0);
    expect(read).toBe(0); // no registration → the journal was never read
    expect(result).toBeNull();
  });

  it("a `**` prediction reports a low-value full coverage and emits no surprise", async () => {
    const bus = new EventBus();
    const warnings = captureWarnings(bus);
    const exp = new Expectations({
      bus,
      readScopeTargets: readerOf({ "step-1": ["src/a.ts", "pkg/b.ts", "docs/c.md"] }),
      sessionId: () => "s1",
    });
    exp.register({ scope: "step-1", predicted: ["**"] });
    const result = await exp.closeScope("step-1");
    expect(warnings).toHaveLength(0);
    expect(result?.coverage).toBe(1); // everything matched a `**` → breadth, not ratio, signals low value
    expect(result?.matched).toBe(3);
  });

  it("clear(scope) before close emits nothing and reads no journal", async () => {
    const bus = new EventBus();
    const warnings = captureWarnings(bus);
    let read = 0;
    const exp = new Expectations({
      bus,
      readScopeTargets: async () => {
        read++;
        return ["out/x.ts"];
      },
      sessionId: () => "s1",
    });
    exp.register({ scope: "step-1", predicted: ["src/**"] });
    exp.clear("step-1");
    const result = await exp.closeScope("step-1");
    expect(warnings).toHaveLength(0);
    expect(read).toBe(0);
    expect(result).toBeNull();
  });

  it("closing an unregistered scope is a no-op", async () => {
    const bus = new EventBus();
    const warnings = captureWarnings(bus);
    const exp = new Expectations({ bus, readScopeTargets: readerOf({}), sessionId: () => "s1" });
    const result = await exp.closeScope("never-registered");
    expect(warnings).toHaveLength(0);
    expect(result).toBeNull();
  });
});
