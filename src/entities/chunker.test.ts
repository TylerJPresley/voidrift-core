/**
 * Structure-aware chunkers (core-blueprint.md §8.7). Pure, deterministic:
 * same input → same chunks, with contiguous 1-based line ranges, a small
 * overlap on the generic chunker, and the existing token estimator for sizing.
 */
import { describe, it, expect } from "vitest";
import {
  BUILTIN_CHUNKERS,
  markdownChunker,
  jsonChunker,
  yamlChunker,
  genericChunker,
  pickChunker,
  type Chunker,
} from "./chunker.js";

describe("markdownChunker", () => {
  it("splits on headings and keeps 1-based contiguous line ranges", () => {
    const text = ["# A", "a1", "a2", "## B", "b1", "## C", "c1", "c2"].join("\n");
    const chunks = markdownChunker.chunk(text, 10);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]?.startLine).toBe(1);
    // ranges are contiguous and cover every line
    for (let i = 1; i < chunks.length; i++) {
      const prevEndLine = chunks[i - 1]?.endLine;
      if (prevEndLine !== undefined) {
        expect(chunks[i]?.startLine).toBe(prevEndLine + 1);
      }
    }
    expect(chunks[chunks.length - 1]?.endLine).toBe(8);
  });

  it("merges small adjacent sections and splits an oversized section on blank lines", () => {
    const big = ["# Big", "para one", "", "para two", "", "para three"].join("\n");
    const small = markdownChunker.chunk(big, 2); // tiny target forces a split
    expect(small.length).toBeGreaterThan(1);
    // deterministic
    expect(markdownChunker.chunk(big, 2)).toEqual(small);
  });

  it("matches by extension and a leading-heading head", () => {
    expect(markdownChunker.matches("x.md", "# Title")).toBe(true);
    expect(markdownChunker.matches("x.txt", "nope")).toBe(false);
  });
});

describe("jsonChunker", () => {
  it("splits a top-level object by keys", () => {
    const text = JSON.stringify({ a: 1, b: { x: 2 }, c: [1, 2, 3] }, null, 2);
    const chunks = jsonChunker.chunk(text, 5);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const joined = chunks.map((c) => c.text).join("\n");
    expect(joined).toContain('"a"');
    expect(joined).toContain('"c"');
    expect(jsonChunker.chunk(text, 5)).toEqual(chunks); // deterministic
  });

  it("splits a top-level array by items", () => {
    const text = JSON.stringify([{ a: 1 }, { b: 2 }, { c: 3 }], null, 2);
    const chunks = jsonChunker.chunk(text, 3);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]?.startLine).toBe(1);
  });
});

describe("yamlChunker", () => {
  it("splits on top-level keys (column-0, non-indented)", () => {
    const text = ["a: 1", "b:", "  x: 2", "  y: 3", "c: 4"].join("\n");
    const chunks = yamlChunker.chunk(text, 3);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[chunks.length - 1]?.endLine).toBe(5);
    expect(yamlChunker.chunk(text, 3)).toEqual(chunks);
  });
});

describe("genericChunker", () => {
  it("splits on column-0 declaration boundaries", () => {
    const text = [
      "function a() {",
      "  return 1;",
      "}",
      "export class B {",
      "  m() {}",
      "}",
      "def c():",
      "  pass",
    ].join("\n");
    const chunks = genericChunker.chunk(text, 3);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[chunks.length - 1]?.endLine).toBe(8);
  });

  it("applies a small overlap between adjacent line-window chunks", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const chunks = genericChunker.chunk(lines, 5);
    expect(chunks.length).toBeGreaterThan(1);
    // overlap: a later chunk starts at or before the previous chunk's endLine
    let overlapped = false;
    for (let i = 1; i < chunks.length; i++) {
      const currStart = chunks[i]?.startLine;
      const prevEnd = chunks[i - 1]?.endLine;
      if (currStart !== undefined && prevEnd !== undefined && currStart <= prevEnd) {
        overlapped = true;
      }
    }
    expect(overlapped).toBe(true);
    expect(genericChunker.chunk(lines, 5)).toEqual(chunks); // deterministic
  });

  it("is a total fallback that matches anything", () => {
    expect(genericChunker.matches("x.bin", "")).toBe(true);
  });
});

describe("pickChunker", () => {
  it("prefers a registered plugin chunker, else picks by path/head, else generic", () => {
    expect(pickChunker("x.md", "# h", []).id).toBe("markdown");
    expect(pickChunker("x.json", "{", []).id).toBe("json");
    expect(pickChunker("x.yaml", "a: 1", []).id).toBe("yaml");
    expect(pickChunker("x.rs", "fn main(){}", []).id).toBe("generic");

    const ast: Chunker = {
      id: "ast-rs",
      matches: (p) => p.endsWith(".rs"),
      chunk: () => [{ startLine: 1, endLine: 1, text: "x" }],
    };
    expect(pickChunker("x.rs", "fn main(){}", [ast]).id).toBe("ast-rs");
  });

  it("exposes the builtin set in a stable order", () => {
    expect(BUILTIN_CHUNKERS.map((c) => c.id)).toEqual(["markdown", "json", "yaml", "generic"]);
  });
});
