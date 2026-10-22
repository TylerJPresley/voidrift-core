/**
 * Large-result eviction entity (core-blueprint.md §8.3).
 *
 * Pure, offline: the threshold is a share of the injected window, the handle is
 * head/tail excerpts + a hash-derived cache path, the artifact never reaches the
 * model, masking runs before the body is shaped, and a hostile `tool_call.id`
 * can never influence the filename (it is not an input — the hash is).
 */
import { describe, it, expect } from "vitest";
import {
  shouldEvict,
  evict,
  evictionCacheName,
  evictionThresholdTokens,
  flattenMcpContent,
  applyResultPolicy,
} from "./tool-eviction.js";
import { maskText } from "../use-cases/secret-mask.js";
import { resolveWithinRoot } from "./staging-manifest.js";
import path from "node:path";

const mask = maskText;

describe("§8.3 — large-result eviction (pure)", () => {
  it("threshold is pct% of the endpoint window, so a small window evicts earlier", () => {
    // Given a tiny 16k window vs a large 200k window at 10%.
    expect(evictionThresholdTokens(16_000, 10)).toBe(1_600);
    expect(evictionThresholdTokens(200_000, 10)).toBe(20_000);
  });

  it("a result at or below the threshold is NOT evicted (zero behavior change)", () => {
    // Given a window whose 50% threshold is ~5 tokens (~20 chars).
    const small = "short result"; // < 20 chars
    expect(shouldEvict(small, { window: 40, pct: 50 })).toBe(false);
  });

  it("a result ABOVE the threshold is evicted", () => {
    const big = "x".repeat(10_000); // ~2500 tokens
    expect(shouldEvict(big, { window: 1_000, pct: 10 })).toBe(true); // threshold ~25 tokens
  });

  it("the handle carries the size, a head excerpt, a tail excerpt, and the relative cache path", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const e = evict(lines, { sessionId: "sess1234", headLines: 3, tailLines: 2, mask });
    // Head N lines and tail M lines are present; the middle is elided.
    expect(e.handle).toContain("line 0");
    expect(e.handle).toContain("line 2"); // 3rd head line
    expect(e.handle).toContain("line 99"); // last tail line
    expect(e.handle).toContain("lines omitted");
    // The relative cache path points under the session cache (§4.2.1).
    expect(e.handle).toContain(".voidrift/cache/session/sess1234/");
    expect(e.handle).toMatch(/read_file/);
    // The handle is far smaller than the full body.
    expect(e.handle.length).toBeLessThan(lines.length);
  });

  it("the artifact {path,size,hash} describes the masked body and never appears in the handle", () => {
    const body = "y".repeat(5_000);
    const e = evict(body, { sessionId: "sess1234", headLines: 2, tailLines: 2, mask });
    expect(e.artifact.size).toBe(Buffer.byteLength(e.maskedBody, "utf8"));
    expect(e.artifact.hash).toHaveLength(64); // sha-256 hex
    // The artifact hash is NOT in the model-facing handle.
    expect(e.handle).not.toContain(e.artifact.hash);
  });

  it("the handle (and cache name) are deterministic for the same content", () => {
    const body = "repeatable\n".repeat(500);
    const a = evict(body, { sessionId: "s", headLines: 5, tailLines: 5, mask });
    const b = evict(body, { sessionId: "s", headLines: 5, tailLines: 5, mask });
    expect(a.name).toBe(b.name);
    expect(a.handle).toBe(b.handle);
    expect(a.artifact.hash).toBe(b.artifact.hash);
  });

  it("a secret in the output is masked in BOTH the handle excerpt and the cached body (§10.10)", () => {
    const secret = "Authorization: Bearer sk-liv" + "e-abcdefghijklmnop1234567890";
    const body = secret + "\n" + "z".repeat(5_000);
    const e = evict(body, { sessionId: "s", headLines: 2, tailLines: 2, mask });
    // The raw bearer value appears NOWHERE — not in the persisted body, not in the handle.
    expect(e.maskedBody).not.toContain("sk-liv" + "e-abcdefghijklmnop1234567890");
    expect(e.handle).not.toContain("sk-liv" + "e-abcdefghijklmnop1234567890");
    expect(e.maskedBody).toContain("«redacted:");
    expect(e.handle).toContain("«redacted:");
  });

  it("a single ENORMOUS line is char-capped in the handle so it stays bounded", () => {
    const oneBigLine = "q".repeat(100_000); // no newlines at all
    const e = evict(oneBigLine, { sessionId: "s", headLines: 30, tailLines: 20, mask });
    // The handle does NOT embed the whole 100k line — it is bounded well under it.
    expect(e.handle.length).toBeLessThan(8_192);
    expect(e.handle).toContain("more chars on this line");
    // The FULL body is still cached intact.
    expect(e.maskedBody.length).toBe(100_000);
  });

  it("a hostile tool_call id can never influence the filename — it is not an input (containment)", () => {
    // The cache name is derived from the HASH of the content, not any id. A
    // hostile id string, were it used, would be sanitized away; here we PROVE it
    // is never consulted and the resulting name is contained under the cache dir.
    const body = "payload".repeat(2_000);
    const name = evictionCacheName(mask(body));
    // Only lowercase hex + the `tool-`/`.txt` affixes — no separators, no `..`, no NUL.
    expect(name).toMatch(/^tool-[0-9a-f]{32}\.txt$/);
    const cacheRoot = "/ws/.voidrift/cache/session/s";
    const resolved = resolveWithinRoot(cacheRoot, name);
    expect(resolved).toBe(path.join(cacheRoot, name));
    // Hostile ids that WOULD escape are refused by the ONE containment helper.
    expect(resolveWithinRoot(cacheRoot, "../../etc/x")).toBeNull();
    expect(resolveWithinRoot(cacheRoot, "/etc/passwd")).toBeNull();
  });

  it("the per-line excerpt cap defaults to limits.context.excerptLineMaxChars (2000) and honors an override (CTX12)", () => {
    const oneBigLine = "q".repeat(5_000);
    // Default: each excerpt line capped at 2000, so the handle names ~3000 more chars.
    const def = evict(oneBigLine, { sessionId: "s", headLines: 1, tailLines: 1, mask });
    expect(def.handle).toContain("[3000 more chars on this line]");
    // Override lower: a tighter cap cuts more and names the larger remainder.
    const tight = evict(oneBigLine, { sessionId: "s", headLines: 1, tailLines: 1, mask, excerptLineMaxChars: 100 });
    expect(tight.handle).toContain("[4900 more chars on this line]");
    expect(tight.handle.length).toBeLessThan(def.handle.length);
  });
});

describe("§8.3/§8.4 — flattenMcpContent bounds image/resource blocks with an explicit marker", () => {
  const imageMaxBytes = 32; // tiny cap so even a small image is over

  it("a text block passes through unchanged", () => {
    const out = flattenMcpContent([{ type: "text", text: "hello world" }], { imageMaxBytes });
    expect(out).toBe("hello world");
  });

  it("an image block NEVER embeds its base64 — it is replaced by a bounded marker naming mime + bytes", () => {
    const base64 = "A".repeat(10_000); // ~7.5 KiB of bytes
    const out = flattenMcpContent(
      [{ type: "image", data: base64, mimeType: "image/png" }],
      { imageMaxBytes },
    );
    expect(out).not.toContain(base64); // the raw base64 never reaches the string
    expect(out).toContain("[mcp image");
    expect(out).toContain("image/png");
    expect(out).toContain("bytes"); // the decoded byte size is named
    expect(out).toContain("omitted");
    // The marker is bounded regardless of the payload size.
    expect(out.length).toBeLessThan(256);
  });

  it("an embedded resource block is replaced by a bounded marker, never its blob/base64", () => {
    const blob = "Z".repeat(20_000);
    const out = flattenMcpContent(
      [{ type: "resource", resource: { uri: "file://x", mimeType: "application/pdf", blob } }],
      { imageMaxBytes },
    );
    expect(out).not.toContain(blob);
    expect(out).toContain("[mcp resource");
    expect(out).toContain("file://x");
    expect(out.length).toBeLessThan(256);
  });

  it("a mixed array joins text blocks and markers in order; the base64 of the image is absent", () => {
    const base64 = "B".repeat(5_000);
    const out = flattenMcpContent(
      [
        { type: "text", text: "before" },
        { type: "image", data: base64, mimeType: "image/jpeg" },
        { type: "text", text: "after" },
      ],
      { imageMaxBytes },
    );
    expect(out).not.toContain(base64);
    expect(out.indexOf("before")).toBeLessThan(out.indexOf("[mcp image"));
    expect(out.indexOf("[mcp image")).toBeLessThan(out.indexOf("after"));
  });

  it("a non-array content falls back to String()", () => {
    expect(flattenMcpContent("plain", { imageMaxBytes })).toBe("plain");
    expect(flattenMcpContent(42, { imageMaxBytes })).toBe("42");
  });
});

describe("§8.3 — applyResultPolicy is the ONE gate; a result over threshold is always evicted", () => {
  it("returns null (unchanged) for a small result", () => {
    const out = applyResultPolicy("small", {
      sessionId: "s",
      window: 1_000,
      pct: 50,
      headLines: 2,
      tailLines: 2,
      mask,
    });
    expect(out).toBeNull();
  });

  it("returns an eviction (handle + artifact + LIMIT marker) for an oversized result", () => {
    const big = Array.from({ length: 500 }, (_, i) => `row ${i}`).join("\n");
    const out = applyResultPolicy(big, {
      sessionId: "s",
      window: 1_000,
      pct: 10,
      headLines: 3,
      tailLines: 2,
      mask,
    });
    expect(out).not.toBeNull();
    expect(out!.handle).toContain("evicted");
    expect(out!.handle).toContain(".voidrift/cache/session/s/");
    expect(out!.artifact.hash).toHaveLength(64);
    // The handle is far smaller than the full body (bounded).
    expect(out!.handle.length).toBeLessThan(big.length);
  });
});
