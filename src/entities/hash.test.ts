/**
 * The shared diff/hash utility (core-blueprint.md §8.2) — one source of hashing
 * and diffing so a cache key, a staleness check, and an approval diff never
 * diverge.
 */
import { describe, it, expect } from "vitest";
import { contentHash, contentChanged, unifiedDiff } from "./hash.js";

describe("hash utility (§8.2)", () => {
  it("hashes deterministically and detects change", () => {
    // Given identical content
    expect(contentHash("abc")).toBe(contentHash("abc"));
    // When content differs
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
    // Then contentChanged agrees
    expect(contentChanged("abc", "abc")).toBe(false);
    expect(contentChanged("abc", "abd")).toBe(true);
  });

  it("renders a unified diff in a fenced diff block", () => {
    const d = unifiedDiff("a\nb\nc", "a\nx\nc");
    expect(d.startsWith("```diff")).toBe(true);
    expect(d).toContain("-b");
    expect(d).toContain("+x");
    expect(d).toContain(" a");
    expect(d).toContain(" c");
  });

  it("handles empty before (pure addition) and after (pure removal)", () => {
    expect(unifiedDiff("", "x")).toContain("+x");
    expect(unifiedDiff("y", "")).toContain("-y");
  });
});
