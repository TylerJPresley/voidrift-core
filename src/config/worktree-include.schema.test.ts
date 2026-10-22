/**
 * `worktreeInclude` schema validation and layer union (core-blueprint.md §7.3,
 * §13.1, §13.9). Each entry is a repo-root-relative file/directory the harness
 * copies into a new worktree; the key is strict-validated per entry, bounded to
 * 64 entries per layer, and UNIONS across layers (it is in ARRAY_UNION_KEYS).
 */
import { describe, it, expect } from "vitest";
import {
  ConfigSchema,
  ARRAY_UNION_KEYS,
  validateWorktreeIncludeEntry,
  WORKTREE_INCLUDE_MAX_ENTRIES,
  WORKTREE_INCLUDE_MAX_LENGTH,
} from "./schema.js";
import { deepMerge } from "../entities/config-capability.js";

describe("worktreeInclude — per-entry validation (§7.3)", () => {
  it("defaults to [] and is in ARRAY_UNION_KEYS", () => {
    const parsed = ConfigSchema.parse({});
    expect(parsed.worktreeInclude).toEqual([]);
    expect(ARRAY_UNION_KEYS).toContain("worktreeInclude");
  });

  it("accepts valid relative file and directory entries", () => {
    const parsed = ConfigSchema.safeParse({ worktreeInclude: [".env", "node_modules", "a/b/c.txt", "dir/"] });
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it("accepts a literal glob-char filename (globs are not expanded)", () => {
    // `*` is a literal filename character here — not a pattern.
    expect(validateWorktreeIncludeEntry("weird[name].txt")).toBeNull();
    expect(validateWorktreeIncludeEntry("star*file")).toBeNull();
  });

  const rejected: { name: string; value: string; match: RegExp }[] = [
    { name: "empty", value: "", match: /empty/ },
    { name: "NUL byte", value: "a\u0000b", match: /NUL/ },
    { name: "absolute (posix)", value: "/etc/passwd", match: /absolute/ },
    { name: "absolute (windows drive)", value: "C:\\x", match: /absolute|backslash/ },
    { name: "parent escape", value: "../secret", match: /\.\./ },
    { name: "nested parent escape", value: "a/../../b", match: /\.\./ },
    { name: "backslash", value: "a\\b", match: /backslash/ },
    { name: "is .git", value: ".git", match: /\.git/ },
    { name: "inside .git", value: ".git/config", match: /\.git/ },
    { name: "contains .git", value: "nested/.git/hooks", match: /\.git/ },
  ];  for (const r of rejected) {
    it(`rejects ${r.name}`, () => {
      expect(validateWorktreeIncludeEntry(r.value)).toMatch(r.match);
      const parsed = ConfigSchema.safeParse({ worktreeInclude: [r.value] });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        // The error names the key.
        expect(JSON.stringify(parsed.error.issues)).toMatch(/worktreeInclude/);
      }
    });
  }

  it("rejects an over-length entry (> 512 chars)", () => {
    const long = "a".repeat(WORKTREE_INCLUDE_MAX_LENGTH + 1);
    expect(validateWorktreeIncludeEntry(long)).toMatch(/512 characters/);
    expect(ConfigSchema.safeParse({ worktreeInclude: [long] }).success).toBe(false);
  });

  it("accepts exactly 512 chars", () => {
    expect(validateWorktreeIncludeEntry("a".repeat(WORKTREE_INCLUDE_MAX_LENGTH))).toBeNull();
  });

  it(`rejects more than ${WORKTREE_INCLUDE_MAX_ENTRIES} entries per layer`, () => {
    const many = Array.from({ length: WORKTREE_INCLUDE_MAX_ENTRIES + 1 }, (_, i) => `f${i}`);
    const parsed = ConfigSchema.safeParse({ worktreeInclude: many });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(JSON.stringify(parsed.error.issues)).toMatch(/at most 64/);
  });

  it(`accepts exactly ${WORKTREE_INCLUDE_MAX_ENTRIES} entries`, () => {
    const many = Array.from({ length: WORKTREE_INCLUDE_MAX_ENTRIES }, (_, i) => `f${i}`);
    expect(ConfigSchema.safeParse({ worktreeInclude: many }).success).toBe(true);
  });
});

describe("worktreeInclude — rejects an entry that normalizes to the repo root (§7.3)", () => {
  // These normalize to "." (the repo root itself) and must be refused with a
  // message naming the key. ("a/.." is caught earlier by the ".." rule.)
  for (const value of [".", "./", "./."]) {
    it(`rejects ${JSON.stringify(value)} with a key-named message`, () => {
      const msg = validateWorktreeIncludeEntry(value);
      expect(msg).toBe("worktreeInclude entries must name a file or directory below the repository root");
      const parsed = ConfigSchema.safeParse({ worktreeInclude: [value] });
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(JSON.stringify(parsed.error.issues)).toMatch(/worktreeInclude/);
    });
  }
});

describe("worktreeInclude — layer union (§13.1)", () => {
  const unionSet = new Set<string>(ARRAY_UNION_KEYS);

  it("unions a project list onto a global list, deduped, broad→narrow", () => {
    const global = { worktreeInclude: [".env", "node_modules"] };
    const project = { worktreeInclude: ["node_modules", "cache/"] };
    const merged = deepMerge(global, project, unionSet);
    expect(merged["worktreeInclude"]).toEqual([".env", "node_modules", "cache/"]);
  });

  it("the merged result still validates against the strict schema", () => {
    const merged = deepMerge({ worktreeInclude: [".env"] }, { worktreeInclude: [".envrc"] }, unionSet);
    expect(ConfigSchema.safeParse(merged).success).toBe(true);
  });
});
