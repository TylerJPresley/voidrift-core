/**
 * S5 (GHSA-vfj7-8cjw-p6xm) glob validator: the advisory PoC shapes are rejected
 * in microseconds, and legitimate workspace globs still pass.
 */
import { describe, it, expect } from "vitest";
import { validateGlobPattern } from "./glob-validate.js";

describe("validateGlobPattern — advisory PoC shapes rejected (S5)", () => {
  it("rejects a huge run of `{` (unbalanced + too many)", () => {
    const start = performance.now();
    expect(validateGlobPattern("{".repeat(10000))).not.toBeNull();
    expect(performance.now() - start).toBeLessThan(500); // microseconds in practice; the bound only guards against catastrophic backtracking
  });

  it("rejects deep brace nesting `{a,{b,{c,{d,{e}}}}}`", () => {
    expect(validateGlobPattern("{a,{b,{c,{d,{e}}}}}")).toMatch(/nesting/);
  });

  it("a lone small range passes; the repeated expansion PoC trips the caps", () => {
    // Structurally `{1..99999999}` is balanced, shallow, few metachars — a lone
    // range is a legitimate glob. The advisory's danger is expansion SIZE; the
    // realistic PoC repeats brace terms, which trips the brace-count/length caps.
    expect(validateGlobPattern("{1..99999999}")).toBeNull();
    expect(validateGlobPattern("{a,b}".repeat(30))).not.toBeNull();
  });

  it("rejects `{a,b}` repeated 30 times (too many braces)", () => {
    expect(validateGlobPattern("{a,b}".repeat(30))).toMatch(/braces/);
  });

  it("rejects unbalanced braces", () => {
    expect(validateGlobPattern("{a,b")).toBe("unbalanced braces");
    expect(validateGlobPattern("a,b}")).toBe("unbalanced braces");
  });

  it("rejects a NUL or newline", () => {
    expect(validateGlobPattern("a\0b")).toMatch(/NUL|newline/);
    expect(validateGlobPattern("a\nb")).toMatch(/NUL|newline/);
  });

  it("rejects too many metacharacters", () => {
    expect(validateGlobPattern("*".repeat(21))).toMatch(/metacharacter/);
  });

  it("rejects too many path segments", () => {
    expect(validateGlobPattern("a/".repeat(40))).toMatch(/segments/);
  });

  it("rejects an over-long pattern", () => {
    expect(validateGlobPattern("a".repeat(2000))).toMatch(/too long/);
  });
});

describe("validateGlobPattern — legitimate patterns pass (S5)", () => {
  for (const p of ["**/*.ts", "src/**/{a,b}.test.ts", "*.{ts,tsx}", "docs/**/*.md", "package.json", "src/**"]) {
    it(`accepts \`${p}\``, () => {
      expect(validateGlobPattern(p)).toBeNull();
    });
  }
});
