/**
 * Typed-memory entity logic (core-blueprint.md §6.2, §6.3) — slug/summary
 * derivation, frontmatter round-trip, keyword-discovery ranking, and the dedup
 * normalization. Pure, deterministic, offline.
 */
import { describe, it, expect } from "vitest";
import {
  slugId,
  deriveSummary,
  serializeEntry,
  parseEntry,
  makeEntry,
  entrySize,
  normalizeBody,
  rankByKeywords,
  type MemoryEntry,
} from "./memory-entry.js";

describe("§6.2 — slug id derivation", () => {
  it("lowercases, hyphenates non-alphanumerics, trims, and slices to 60", () => {
    expect(slugId("Use PNPM, Always!")).toBe("use-pnpm-always");
    const long = "x".repeat(80);
    expect(slugId(long).length).toBe(60);
  });

  it("falls back to a timestamp when the slug is empty", () => {
    expect(slugId("!!!", () => 1234)).toBe("mem-1234");
  });
});

describe("§6.2 — summary derivation", () => {
  it("takes the first non-empty line to 120 chars", () => {
    expect(deriveSummary("\n  first line  \nsecond")).toBe("first line");
    expect(deriveSummary("y".repeat(200)).length).toBe(120);
  });
});

describe("§6.2 — frontmatter round-trip", () => {
  it("serializes and parses back to the same entry", () => {
    const entry: MemoryEntry = {
      id: "use-pnpm",
      title: "Use pnpm",
      summary: "Always use pnpm",
      type: "note",
      scope: "workspace",
      keywords: ["pnpm", "install.sh"],
      body: "Always use pnpm in this repo.",
    };
    const parsed = parseEntry(serializeEntry(entry));
    expect(parsed).toEqual(entry);
  });

  it("returns null for text without a valid frontmatter block", () => {
    expect(parseEntry("no frontmatter here")).toBeNull();
    expect(parseEntry("---\nnot: valid-type-fields\n---\nbody")).toBeNull();
  });

  it("derives the summary on parse when the frontmatter omits it", () => {
    const text = "---\nid: x\ntitle: X\ntype: note\nscope: workspace\nkeywords: []\n---\nfirst body line\nmore";
    const parsed = parseEntry(text);
    expect(parsed?.summary).toBe("first body line");
  });
});

describe("§6.2 — makeEntry defaults", () => {
  it("derives id from title and summary from body when absent", () => {
    const e = makeEntry({ title: "My Title", type: "note", scope: "workspace", body: "a body line" });
    expect(e.id).toBe("my-title");
    expect(e.summary).toBe("a body line");
    expect(e.keywords).toEqual([]);
  });

  it("entrySize counts the body length (§6.3)", () => {
    expect(entrySize(makeEntry({ title: "t", type: "note", scope: "workspace", body: "abcde" }))).toBe(5);
  });
});

describe("§6.7 — dedup normalization", () => {
  it("folds case and collapses whitespace", () => {
    expect(normalizeBody("  Use   PNPM\n Always ")).toBe("use pnpm always");
  });
});

describe("§6.2 — weighted keyword discovery", () => {
  const notes: MemoryEntry[] = [
    makeEntry({ title: "plain", type: "note", scope: "workspace", body: "p", keywords: ["deploy"] }),
    makeEntry({ title: "ext", type: "note", scope: "workspace", body: "e", keywords: [".ts"] }),
    makeEntry({ title: "file", type: "note", scope: "workspace", body: "f", keywords: ["config.ts"] }),
    makeEntry({ title: "zero", type: "note", scope: "workspace", body: "z", keywords: ["unrelated"] }),
  ];

  it("ranks filename (4.0) > extension (3.0) > plain (2.5) and drops zero-scored", () => {
    const ranked = rankByKeywords(notes, "config.ts .ts deploy");
    expect(ranked.map((r) => r.entry.id)).toEqual(["file", "ext", "plain"]);
    expect(ranked[0]!.score).toBe(4.0);
    expect(ranked[1]!.score).toBe(3.0);
    expect(ranked[2]!.score).toBe(2.5);
    expect(ranked.find((r) => r.entry.id === "zero")).toBeUndefined();
  });

  it("returns an empty ranking when nothing matches", () => {
    expect(rankByKeywords(notes, "nothing here")).toEqual([]);
  });
});
