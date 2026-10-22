/**
 * Expectation comparison — entity layer (core-blueprint.md §9.5.1, invariant 27).
 *
 * Pure prediction-vs-actual comparison: a written target matching no predicted
 * entry is a SURPRISE; a predicted entry never written is NOT (over-touch is the
 * signal). File targets match by resolved workspace-relative path through the
 * shared glob matcher (§9.2); a non-file target matches its journal `target`
 * string literally or by prefix. Coverage is matched-actual / total-actual so an
 * over-broad prediction (`**`) reads as low-value rather than "zero surprises".
 *
 * INVARIANT 27 (structural): this module imports ONLY the shared glob matcher —
 * nothing from Guardian/Warden/plan-scope decision code — so a prediction can
 * never reach a permission or scope decision. The import-guard test below asserts
 * that structurally.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compareExpectation, EXPECTATION_LIMITS } from "./expectations.js";

describe("§9.5.1 expectation comparison (entity)", () => {
  it("a written target outside the prediction is a surprise; coverage counts matches", () => {
    const r = compareExpectation(["src/**"], ["src/app.ts", "docs/readme.md"]);
    expect(r.surprises).toEqual(["docs/readme.md"]);
    expect(r.matched).toBe(1);
    expect(r.totalActual).toBe(2);
    expect(r.coverage).toBeCloseTo(0.5);
  });

  it("an honest prediction covering every written target yields no surprise and full coverage", () => {
    const r = compareExpectation(["src/**", "docs/**"], ["src/app.ts", "docs/readme.md"]);
    expect(r.surprises).toEqual([]);
    expect(r.matched).toBe(2);
    expect(r.coverage).toBe(1);
  });

  it("over-touch (a predicted entry never written) is NOT a surprise", () => {
    const r = compareExpectation(["src/**", "test/**"], ["src/app.ts"]);
    expect(r.surprises).toEqual([]);
    expect(r.coverage).toBe(1);
  });

  it("`**` matches everything: no surprise but coverage is a full match (over-broad reads as low value by breadth, not by ratio)", () => {
    const r = compareExpectation(["**"], ["src/a.ts", "pkg/b.ts", "x/y/z.ts"]);
    expect(r.surprises).toEqual([]);
    expect(r.matched).toBe(3);
    expect(r.coverage).toBe(1);
  });

  it("a non-file target matches literally or by prefix", () => {
    const r = compareExpectation(["mcp_github_", "db:drop"], [
      "mcp_github_create_issue",
      "db:drop",
      "redis:flush",
    ]);
    expect(r.surprises).toEqual(["redis:flush"]);
    expect(r.matched).toBe(2);
  });

  it("an empty prediction runs no comparison and reports it", () => {
    const r = compareExpectation([], ["src/app.ts"]);
    expect(r.ran).toBe(false);
    expect(r.surprises).toEqual([]);
  });

  it("no actual targets: coverage is 1 (nothing written, nothing surprising)", () => {
    const r = compareExpectation(["src/**"], []);
    expect(r.ran).toBe(true);
    expect(r.surprises).toEqual([]);
    expect(r.coverage).toBe(1);
  });

  it("surprises are bounded by count and length (internal constants)", () => {
    const many = Array.from({ length: EXPECTATION_LIMITS.maxSurprises + 10 }, (_, i) => `out/${i}.ts`);
    const r = compareExpectation(["src/**"], many);
    expect(r.surprises.length).toBeLessThanOrEqual(EXPECTATION_LIMITS.maxSurprises);
    const longName = "out/" + "x".repeat(EXPECTATION_LIMITS.maxEntryLength + 50) + ".ts";
    const r2 = compareExpectation(["src/**"], [longName]);
    expect(r2.surprises[0]!.length).toBeLessThanOrEqual(EXPECTATION_LIMITS.maxEntryLength);
  });

  it("INVARIANT 27 (structural): the module imports nothing from decision code", () => {
    const src = readFileSync(fileURLToPath(new URL("./expectations.ts", import.meta.url)), "utf8");
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
    for (const spec of imports) {
      expect(spec).not.toMatch(/guardian/);
      expect(spec).not.toMatch(/warden/);
      expect(spec).not.toMatch(/plan-scope/);
      expect(spec).not.toMatch(/decision-point/);
    }
  });
});
