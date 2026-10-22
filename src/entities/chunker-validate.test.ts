/**
 * §8.7 — a plugin chunker is CONTAINED and its output VALIDATED before use.
 * `validateChunks` enforces the invariants the ingest fan-out relies on
 * (contiguous, covers the whole text, 1-based ascending line numbers, bounded
 * count); `safeChunk` runs a picked chunker, falling back to the builtin on a
 * throw or an invalid shape.
 */
import { describe, it, expect } from "vitest";
import {
  validateChunks,
  safeChunk,
  pickChunker,
  genericChunker,
  type Chunk,
  type Chunker,
} from "./chunker.js";

const TEXT = ["line 1", "line 2", "line 3", "line 4"].join("\n");

describe("validateChunks (§8.7)", () => {
  it("accepts contiguous, covering, ascending, bounded chunks", () => {
    const chunks: Chunk[] = [
      { startLine: 1, endLine: 2, text: "line 1\nline 2" },
      { startLine: 3, endLine: 4, text: "line 3\nline 4" },
    ];
    expect(validateChunks(chunks, 4).ok).toBe(true);
  });

  it("rejects an empty chunk list", () => {
    expect(validateChunks([], 4).ok).toBe(false);
  });

  it("rejects a gap (not contiguous)", () => {
    const chunks: Chunk[] = [
      { startLine: 1, endLine: 1, text: "line 1" },
      { startLine: 3, endLine: 4, text: "line 3\nline 4" }, // skips line 2
    ];
    expect(validateChunks(chunks, 4).ok).toBe(false);
  });

  it("rejects a chunk that does not start at line 1 (coverage from the top)", () => {
    const chunks: Chunk[] = [{ startLine: 2, endLine: 4, text: "x" }];
    expect(validateChunks(chunks, 4).ok).toBe(false);
  });

  it("rejects a chunk that does not cover the last line", () => {
    const chunks: Chunk[] = [{ startLine: 1, endLine: 3, text: "x" }]; // text has 4 lines
    expect(validateChunks(chunks, 4).ok).toBe(false);
  });

  it("rejects a non-ascending / inverted range", () => {
    const chunks: Chunk[] = [{ startLine: 4, endLine: 1, text: "x" }];
    expect(validateChunks(chunks, 4).ok).toBe(false);
  });

  it("rejects a count above the bound", () => {
    // one chunk per line, far over any sane cap for a 4-line text
    const chunks: Chunk[] = Array.from({ length: 4 }, (_, i) => ({
      startLine: i + 1,
      endLine: i + 1,
      text: `line ${i + 1}`,
    }));
    // a low cap makes this invalid
    expect(validateChunks(chunks, 4, 2).ok).toBe(false);
    // the default cap accepts it
    expect(validateChunks(chunks, 4).ok).toBe(true);
  });
});

describe("safeChunk (§8.7 — contained + validated)", () => {
  it("uses a valid plugin chunker's output", () => {
    const plugin: Chunker = {
      id: "plug",
      matches: () => true,
      chunk: () => [{ startLine: 1, endLine: 4, text: TEXT }],
    };
    const result = safeChunk(plugin, TEXT, 100);
    expect(result.chunker).toBe("plug");
    expect(result.chunks).toEqual([{ startLine: 1, endLine: 4, text: TEXT }]);
    expect(result.fellBack).toBe(false);
  });

  it("falls back to the builtin when the plugin chunker THROWS", () => {
    const plugin: Chunker = {
      id: "boom",
      matches: () => true,
      chunk: () => {
        throw new Error("nope");
      },
    };
    const result = safeChunk(plugin, TEXT, 100);
    expect(result.fellBack).toBe(true);
    expect(result.chunker).toBe(genericChunker.id);
    expect(validateChunks(result.chunks, 4).ok).toBe(true);
  });

  it("falls back when the plugin chunker returns an INVALID shape (a gap)", () => {
    const plugin: Chunker = {
      id: "gappy",
      matches: () => true,
      chunk: () => [
        { startLine: 1, endLine: 1, text: "line 1" },
        { startLine: 3, endLine: 4, text: "line 3\nline 4" },
      ],
    };
    const result = safeChunk(plugin, TEXT, 100);
    expect(result.fellBack).toBe(true);
    expect(result.chunker).toBe(genericChunker.id);
  });

  it("pickChunker chooses a matching plugin chunker over the builtins", () => {
    const plugin: Chunker = {
      id: "ts-ast",
      matches: (p) => p.endsWith(".ts"),
      chunk: () => [{ startLine: 1, endLine: 4, text: TEXT }],
    };
    expect(pickChunker("a.ts", "", [plugin]).id).toBe("ts-ast");
    // a non-matching path still falls to a builtin
    expect(pickChunker("a.md", "# h", [plugin]).id).toBe("markdown");
  });
});
