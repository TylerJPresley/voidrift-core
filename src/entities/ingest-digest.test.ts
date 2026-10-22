/**
 * Digest entity tests (core-blueprint.md §8.7): schema round-trip, keying,
 * sanitization, bounded sizes, and render.
 */
import { describe, it, expect } from "vitest";
import {
  makeDigest,
  digestSchema,
  digestKey,
  renderDigest,
  DIGEST_VERSION,
  READ_EXACT_LINE,
  type DigestInput,
} from "./ingest-digest.js";
import { contentHash } from "./hash.js";

const baseInput = (): DigestInput => ({
  source: "src/app.ts",
  contentHash: contentHash("hello world"),
  purpose: "understand the auth flow",
  params: { chunkTargetTokens: 3000, digestTokens: 800, chunkerId: "generic" },
  ranges: [
    { startLine: 1, endLine: 20, summary: "imports and config" },
    { startLine: 21, endLine: 80, summary: "the login handler" },
  ],
  overall: "A TypeScript module implementing login.",
  missing: [],
});

describe("Digest schema and build (§8.7)", () => {
  it("builds a valid digest that round-trips through the schema", () => {
    const d = makeDigest(baseInput());
    expect(d.version).toBe(DIGEST_VERSION);
    const parsed = digestSchema.parse(JSON.parse(JSON.stringify(d)));
    expect(parsed).toEqual(d);
  });

  it("rejects an unknown key (strict) and a bad content hash", () => {
    const d = makeDigest(baseInput());
    expect(() => digestSchema.parse({ ...d, surprise: 1 })).toThrow();
    expect(() => digestSchema.parse({ ...d, contentHash: "nothex" })).toThrow();
  });

  it("strips control/bidi characters from every string", () => {
    const d = makeDigest({
      ...baseInput(),
      source: "src/\u202eevil.ts",
      purpose: "do \u0007 a thing",
      overall: "line1\nline2\u0000\u202e",
      ranges: [{ startLine: 1, endLine: 2, summary: "sum\u001bmary\u200b" }],
    });
    expect(d.source).not.toMatch(/[\u0000-\u001f\u202e\u200b]/);
    expect(d.purpose).not.toMatch(/[\u0000-\u001f\u202e]/);
    expect(d.overall).not.toMatch(/[\u0000\u202e\u200b]/);
    expect(d.ranges[0]!.summary).not.toMatch(/[\u001b\u200b]/);
    // Newlines in overall are preserved (multi-line field).
    expect(d.overall).toContain("line1\nline2");
  });

  it("bounds oversized strings", () => {
    const huge = "x".repeat(100_000);
    const d = makeDigest({ ...baseInput(), overall: huge, purpose: huge });
    expect(d.overall.length).toBeLessThanOrEqual(16384);
    expect(d.purpose.length).toBeLessThanOrEqual(1024);
  });

  it("normalizes line numbers to ≥1 and start ≤ end", () => {
    const d = makeDigest({
      ...baseInput(),
      ranges: [{ startLine: 0, endLine: -5, summary: "x" }],
    });
    expect(d.ranges[0]!.startLine).toBe(1);
    expect(d.ranges[0]!.endLine).toBeGreaterThanOrEqual(d.ranges[0]!.startLine);
  });
});

describe("digestKey (§8.7)", () => {
  it("is a hex-only filename component (no separators)", () => {
    const k = digestKey(contentHash("a"), "p", { chunkTargetTokens: 3000, digestTokens: 800, chunkerId: "generic" });
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for the same content+purpose+params, and differs on any change", () => {
    const ch = contentHash("a");
    const params = { chunkTargetTokens: 3000, digestTokens: 800, chunkerId: "generic" };
    const k0 = digestKey(ch, "p", params);
    expect(digestKey(ch, "p", params)).toBe(k0);
    expect(digestKey(contentHash("b"), "p", params)).not.toBe(k0); // content
    expect(digestKey(ch, "other", params)).not.toBe(k0); // purpose
    expect(digestKey(ch, "p", { ...params, chunkTargetTokens: 2000 })).not.toBe(k0); // target
    expect(digestKey(ch, "p", { ...params, digestTokens: 400 })).not.toBe(k0); // digest budget
    expect(digestKey(ch, "p", { ...params, chunkerId: "markdown" })).not.toBe(k0); // chunker
  });
});

describe("renderDigest (§8.7)", () => {
  it("renders overall + anchored ranges + the read_file affordance", () => {
    const d = makeDigest(baseInput());
    const text = renderDigest(d);
    expect(text).toContain("A TypeScript module implementing login.");
    expect(text).toContain("lines 1-20: imports and config");
    expect(text).toContain("lines 21-80: the login handler");
    expect(text.trimEnd().endsWith(READ_EXACT_LINE)).toBe(true);
  });

  it("names missing ranges so a gap is never silent", () => {
    const d = makeDigest({ ...baseInput(), missing: [{ startLine: 81, endLine: 120, summary: "" }] });
    const text = renderDigest(d);
    expect(text).toContain("Not summarized");
    expect(text).toContain("lines 81-120");
  });

  it("matches a stable snapshot", () => {
    const d = makeDigest({ ...baseInput(), createdAt: "2026-01-01T00:00:00.000Z" });
    expect(renderDigest(d)).toMatchInlineSnapshot(`
      "A TypeScript module implementing login.
      lines 1-20: imports and config
      lines 21-80: the login handler
      Read exact lines with read_file path offset limit"
    `);
  });
});
