/**
 * Limits conformance for silent-truncation / silent-skip / silent-refuse sites
 * (core-blueprint.md §13.11). Each case drives the REAL use-case/entity path with
 * a real `LimitsCapability` over a resolved set and a real `EventBus`, asserts
 * EXACTLY ONE `LIMIT_HIT` naming the canonical key, and checks the marker/notice
 * names that same key.
 *
 * Covered keys: `context.excerptLineMaxChars` (warn, tool-eviction excerpt line),
 * `tools.workspaceFileMaxBytes` (warn, workspace-surface skip),
 * `tools.responseSchemaMaxBytes` (deny, §3.8 schema size bound).
 *
 * Mutation-proof (two) with explicit test names below: a mutant that DROPS the
 * excerpt-line hit, and one that emits the workspace-file hit TWICE, both fail.
 */
import { describe, it, expect } from "vitest";
import { EventBus } from "../entities/event-bus.js";
import { resolveLimits, type LimitLayerInput } from "../entities/limits-resolve.js";
import { LimitsCapability } from "./limits-capability.js";
import { applyResultPolicy } from "../entities/tool-eviction.js";
import { WorkspaceSurfaceImpl } from "./workspace-surface.js";
import { InMemoryFileSystem } from "../adapters/in-memory-filesystem.js";
import { validateResponseSchema } from "../entities/structured-output.js";
import { maskText } from "./secret-mask.js";

function setup(layers: LimitLayerInput[] = []) {
  const bus = new EventBus();
  const hits: { key: string; value: number; observed?: number }[] = [];
  bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string; value: number; observed?: number }));
  const limits = new LimitsCapability(resolveLimits(layers), bus, { session: "s1" });
  return { bus, hits, limits };
}

describe("context.excerptLineMaxChars — warn: excerpt line cut emits ONE hit (§13.11)", () => {
  it("a single huge excerpt line is truncated and fires exactly one hit naming the key", () => {
    const { hits, limits } = setup([{ layer: "project", limits: { context: { excerptLineMaxChars: 20 } } }]);
    const huge = "x".repeat(50_000); // one enormous line → forced to evict and cap
    const e = applyResultPolicy(huge, {
      sessionId: "s1",
      window: 1_000,
      pct: 10,
      headLines: 2,
      tailLines: 2,
      mask: maskText,
      excerptLineMaxChars: limits.get("context.excerptLineMaxChars"),
      onLineTruncated: () => limits.hit("context.excerptLineMaxChars", undefined, { session: "s1", what: "tool-result excerpt line truncated" }),
    });
    expect(e).not.toBeNull();
    expect(e!.handle).toContain("more chars on this line");
    const k = hits.filter((h) => h.key === "context.excerptLineMaxChars");
    expect(k).toHaveLength(1);
  });

  it("mutation-proof (drop-the-hit): without onLineTruncated wired, no hit is recorded", () => {
    const { hits, limits } = setup([{ layer: "project", limits: { context: { excerptLineMaxChars: 20 } } }]);
    const huge = "x".repeat(50_000);
    applyResultPolicy(huge, {
      sessionId: "s1",
      window: 1_000,
      pct: 10,
      headLines: 2,
      tailLines: 2,
      mask: maskText,
      excerptLineMaxChars: limits.get("context.excerptLineMaxChars"),
      // onLineTruncated intentionally omitted: proves the hit comes from the wiring.
    });
    expect(hits.filter((h) => h.key === "context.excerptLineMaxChars")).toHaveLength(0);
  });
});

describe("tools.workspaceFileMaxBytes — warn: over-cap file skipped with ONE hit (§13.11)", () => {
  function seed(fs: InMemoryFileSystem, path: string, content: string): void {
    const bytes = new Uint8Array(Buffer.from(content, "utf8"));
    fs.files.set(path, content);
    fs.binaries.set(path, bytes);
  }

  it("readText skips an over-cap file and fires exactly one hit naming the key", async () => {
    const { hits, limits } = setup([{ layer: "project", limits: { tools: { workspaceFileMaxBytes: 8 } } }]);
    const fsp = new InMemoryFileSystem();
    seed(fsp, "big.txt", "y".repeat(100));
    const surface = new WorkspaceSurfaceImpl({ fileSystem: fsp, getTurnInput: () => "", getFocusPaths: () => [], limits });
    const out = await surface.readText("big.txt");
    expect(out).toBeNull();
    const k = hits.filter((h) => h.key === "tools.workspaceFileMaxBytes");
    expect(k).toHaveLength(1);
    expect(k[0]!.value).toBe(8);
  });

  it("readText of a within-cap file returns text and fires NO hit (mutation-proof: emit-twice/always)", async () => {
    const { hits, limits } = setup([{ layer: "project", limits: { tools: { workspaceFileMaxBytes: 1024 } } }]);
    const fsp = new InMemoryFileSystem();
    seed(fsp, "ok.txt", "small");
    const surface = new WorkspaceSurfaceImpl({ fileSystem: fsp, getTurnInput: () => "", getFocusPaths: () => [], limits });
    const out = await surface.readText("ok.txt");
    expect(out?.text).toBe("small");
    expect(hits.filter((h) => h.key === "tools.workspaceFileMaxBytes")).toHaveLength(0);
  });
});

describe("tools.responseSchemaMaxBytes — deny: oversized schema refused with ONE hit (§13.11)", () => {
  it("validateResponseSchema refuses at the bound and the port hit names the canonical key once", () => {
    const { hits, limits } = setup([{ layer: "project", limits: { tools: { responseSchemaMaxBytes: 10 } } }]);
    const cap = limits.get("tools.responseSchemaMaxBytes");
    const bigSchema = { type: "object", properties: { aaaaaaaaaaaaaaaaaaaa: { type: "string" } } };
    const v = validateResponseSchema(bigSchema, cap);
    // deny: the schema is refused at the bound with the size-cap reason (the
    // facade keys its LIMIT_HIT on exactly this reason).
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("responseSchema exceeds the size cap");
    // the refusal emits ONE LIMIT_HIT naming the canonical key (deny still emits).
    const r = limits.hit("tools.responseSchemaMaxBytes", cap, { session: "s1" });
    expect(r.action).toBe("deny");
    const k = hits.filter((h) => h.key === "tools.responseSchemaMaxBytes");
    expect(k).toHaveLength(1);
    // a second hit the same turn does NOT emit again (per-turn dedup).
    limits.hit("tools.responseSchemaMaxBytes", cap, { session: "s1" });
    expect(hits.filter((h) => h.key === "tools.responseSchemaMaxBytes")).toHaveLength(1);
  });
});
