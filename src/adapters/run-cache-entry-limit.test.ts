/**
 * run.entryMaxBytes conformance (core-blueprint.md §13.11, §7.2): a single blob
 * over the per-entry byte cap is truncated to the cap but NEVER silently — the
 * store fires EXACTLY ONE `LIMIT_HIT` naming `run.entryMaxBytes` and appends a
 * visible marker naming the same key to the stored blob. Covers both caches.
 *
 * Mutation-proof (two): a mutant that DROPS the hit, and a mutant that emits it
 * TWICE, are caught by the named tests below.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { hermeticTmp } from "../test-hermetic.js";
import { FilesystemRunCache, InMemoryRunCache } from "./run-cache.js";

let ws: string;
beforeEach(() => {
  ws = hermeticTmp("run-entry-limit");
});
afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

describe("run.entryMaxBytes — warn-style truncate + one LIMIT_HIT + marker (§13.11)", () => {
  it("FilesystemRunCache: fires exactly one run.entryMaxBytes hit and the marker names the key", () => {
    const hits: { key: string; value: number; observed?: number }[] = [];
    const cache = new FilesystemRunCache({ workspaceRoot: ws, sessionId: "s1", entryMaxBytes: 10, onLimitHit: (i) => hits.push(i) });
    const { handle } = cache.store("brief", "a".repeat(250));
    // exactly one hit for the key, with the observed (pre-truncation) size.
    const entryHits = hits.filter((h) => h.key === "run.entryMaxBytes");
    expect(entryHits).toHaveLength(1);
    expect(entryHits[0]!.value).toBe(10);
    expect(entryHits[0]!.observed).toBe(250);
    // the stored blob carries a visible marker naming the key (not silent).
    const body = readFileSync(path.join(ws, handle), "utf8");
    expect(body).toContain("limits.run.entryMaxBytes");
  });

  it("InMemoryRunCache: fires exactly one run.entryMaxBytes hit and the marker names the key", () => {
    const hits: { key: string; observed?: number }[] = [];
    const cache = new InMemoryRunCache({ sessionId: "s1", entryMaxBytes: 10, onLimitHit: (i) => hits.push(i) });
    const { handle } = cache.store("dep-summary", "b".repeat(100));
    expect(hits.filter((h) => h.key === "run.entryMaxBytes")).toHaveLength(1);
    expect(cache.read(handle)).toContain("limits.run.entryMaxBytes");
  });

  it("a blob at or under the cap fires NO hit and carries no marker (mutation-proof: emit-when-not-over)", () => {
    const hits: { key: string }[] = [];
    const cache = new InMemoryRunCache({ sessionId: "s1", entryMaxBytes: 50, onLimitHit: (i) => hits.push(i) });
    const { handle } = cache.store("brief", "small");
    expect(hits.filter((h) => h.key === "run.entryMaxBytes")).toHaveLength(0);
    expect(cache.read(handle)).toBe("small");
  });

  it("truncation fires the hit exactly once per store, never twice (mutation-proof: emit-twice)", () => {
    const hits: { key: string }[] = [];
    const cache = new InMemoryRunCache({ sessionId: "s1", entryMaxBytes: 10, onLimitHit: (i) => hits.push(i) });
    cache.store("brief", "z".repeat(40));
    expect(hits.filter((h) => h.key === "run.entryMaxBytes")).toHaveLength(1);
  });
});
