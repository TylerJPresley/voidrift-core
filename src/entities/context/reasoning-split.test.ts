/**
 * Inline reasoning splitter tests (core-blueprint.md §3.7, §4.7).
 *
 * Offline, pure. Covers: a single inline block, a property-style split-at-EVERY
 * boundary position (the real wire shape where '<think>' arrives as '<thi'+'nk>'),
 * multiple/adjacent blocks, an unterminated block at end of stream, mixed case,
 * and a no-reasoning string being byte-identical through the splitter.
 */
import { describe, it, expect } from "vitest";
import {
  InlineReasoningSplitter,
  splitInlineReasoning,
  hasInlineReasoning,
  REASONING_TAGS,
} from "./reasoning-split.js";

/** Feed a whole string split at a fixed index `k`, then end(). */
function feedSplitAt(input: string, k: number): { text: string; reasoning: string } {
  const s = new InlineReasoningSplitter();
  const a = s.feed(input.slice(0, k));
  const b = s.feed(input.slice(k));
  const c = s.end();
  return { text: a.text + b.text + c.text, reasoning: a.reasoning + b.reasoning + c.reasoning };
}

describe("InlineReasoningSplitter (§4.7)", () => {
  it("strips a single inline <think> block from one chunk", () => {
    const { text, reasoning } = splitInlineReasoning("<think>secret plan</think>Hello");
    expect(text).toBe("Hello");
    expect(reasoning).toBe("secret plan");
  });

  it("keeps text before and after the block", () => {
    const { text, reasoning } = splitInlineReasoning("A<think>mid</think>B");
    expect(text).toBe("AB");
    expect(reasoning).toBe("mid");
  });

  it("split at EVERY boundary position yields identical result (chunk-safe)", () => {
    // Given — a payload with text, a reasoning block, and trailing text.
    const input = "pre<think>hidden reasoning</think>post";
    const expectedText = "prepost";
    const expectedReasoning = "hidden reasoning";
    // When/Then — splitting the stream at each index k reconstructs the same split.
    for (let k = 0; k <= input.length; k++) {
      const { text, reasoning } = feedSplitAt(input, k);
      expect(text, `split at ${k}`).toBe(expectedText);
      expect(reasoning, `split at ${k}`).toBe(expectedReasoning);
    }
  });

  it("handles the '<thi'+'nk>' cross-chunk tag split explicitly", () => {
    const s = new InlineReasoningSplitter();
    const a = s.feed("x<thi");
    const b = s.feed("nk>why</think>y");
    const end = s.end();
    expect(a.text + b.text + end.text).toBe("xy");
    expect(a.reasoning + b.reasoning + end.reasoning).toBe("why");
  });

  it("strips multiple and adjacent blocks", () => {
    const { text, reasoning } = splitInlineReasoning("a<think>one</think>b<think>two</think>c");
    expect(text).toBe("abc");
    expect(reasoning).toBe("onetwo");
    const adj = splitInlineReasoning("<think>one</think><think>two</think>Z");
    expect(adj.text).toBe("Z");
    expect(adj.reasoning).toBe("onetwo");
  });

  it("an UNTERMINATED block keeps prior text and loses no visible text (reasoning out)", () => {
    for (let k = 0; k <= "keep me<think>never ends".length; k++) {
      const { text, reasoning } = feedSplitAt("keep me<think>never ends", k);
      expect(text, `split at ${k}`).toBe("keep me");
      expect(reasoning, `split at ${k}`).toBe("never ends");
    }
  });

  it("matches tags case-insensitively across all delimiters", () => {
    for (const tag of REASONING_TAGS) {
      const upper = `<${tag.toUpperCase()}>R</${tag.toUpperCase()}>V`;
      const { text, reasoning } = splitInlineReasoning(upper);
      expect(text, tag).toBe("V");
      expect(reasoning, tag).toBe("R");
    }
    const mixed = splitInlineReasoning("<ThInK>r</tHiNk>v");
    expect(mixed.text).toBe("v");
    expect(mixed.reasoning).toBe("r");
  });

  it("a string with NO reasoning passes through byte-identical", () => {
    const samples = ["plain text", "a < b and c > d", "no tags here <notathink>", "", "1 < 2"];
    for (const s of samples) {
      expect(hasInlineReasoning(s)).toBe(false);
      const { text, reasoning } = splitInlineReasoning(s);
      expect(text, JSON.stringify(s)).toBe(s);
      expect(reasoning).toBe("");
    }
  });

  it("a literal '<' not starting a tag is preserved as text", () => {
    const { text, reasoning } = splitInlineReasoning("if x < 3 then <think>q</think> done");
    expect(text).toBe("if x < 3 then  done");
    expect(reasoning).toBe("q");
  });
});
