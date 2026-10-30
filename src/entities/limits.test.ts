/**
 * Limits registry foundation (core-blueprint.md §13.11): registry completeness,
 * the config-schema accept/reject behaviour, and the layered safety cascade.
 */
import { describe, it, expect } from "vitest";
import { LIMITS, LIMIT_KEYS, getLimitSpec, limitAreas, limitDefault, effectiveIngestParallel } from "./limits.js";
import { resolveLimits, effectiveLimit } from "./limits-resolve.js";
import { ConfigSchema } from "../config/schema.js";

describe("limits registry (§13.11)", () => {
  it("has unique dotted keys whose prefix is the area", () => {
    const seen = new Set<string>();
    for (const l of LIMITS) {
      expect(seen.has(l.key), `duplicate key ${l.key}`).toBe(false);
      seen.add(l.key);
      expect(l.key.startsWith(`${l.area}.`), `${l.key} must start with area ${l.area}.`).toBe(true);
    }
    expect(LIMIT_KEYS.length).toBe(LIMITS.length);
  });

  it("every default is non-negative and min <= default <= max", () => {
    for (const l of LIMITS) {
      expect(l.default, `${l.key} default`).toBeGreaterThanOrEqual(0);
      expect(l.min <= l.default, `${l.key}: min ${l.min} <= default ${l.default}`).toBe(true);
      expect(l.default <= l.max, `${l.key}: default ${l.default} <= max ${l.max}`).toBe(true);
    }
  });

  it("registers enough keys to cover the inventory (>= 60 configurable sites)", () => {
    // The inventory lists ~95 sites; some stay internal constants (security /
    // derived). The registry carries every proposed `limits.*` key — a healthy
    // floor well above the current count guards against accidental deletion.
    expect(LIMITS.length).toBeGreaterThanOrEqual(60);
  });

  it("getLimitSpec / limitDefault / limitAreas behave", () => {
    expect(getLimitSpec("memory.entryChars")?.default).toBe(2200);
    expect(getLimitSpec("nope.nope")).toBeUndefined();
    expect(limitDefault("memory.entryChars")).toBe(2200);
    expect(() => limitDefault("nope.nope")).toThrow();
    expect(limitAreas()).toContain("memory");
  });

  it("registers the new series rows with their specified bounds and classes", () => {
    const parallel = getLimitSpec("ingest.maxParallel");
    expect(parallel).toMatchObject({ unit: "count", class: "tunable", min: 1, max: 64 });

    const fallback = getLimitSpec("tools.searchFallbackMax");
    expect(fallback).toMatchObject({ default: 100, unit: "count", class: "tunable", min: 1, max: 10000 });

    const autoDeny = getLimitSpec("approval.autoDenySeconds");
    expect(autoDeny).toMatchObject({ default: 0, unit: "seconds", class: "tunable", min: 0, max: 86400 });
  });

  it("applies the updated ingest defaults (fitFraction 0.4, digestTokens 1200)", () => {
    expect(limitDefault("ingest.fitFraction")).toBe(0.4);
    expect(limitDefault("ingest.digestTokens")).toBe(1200);
  });

});

describe("effectiveIngestParallel (§8.7)", () => {
  it("follows turnMaxConcurrency when ingest.maxParallel is unset", () => {
    const r = resolveLimits([]);
    expect(effectiveIngestParallel(r, 4)).toBe(4);
    expect(effectiveIngestParallel(r, 1)).toBe(1);
  });

  it("uses ingest.maxParallel when set, capped by the registry max", () => {
    const r = resolveLimits([{ layer: "project", limits: { ingest: { maxParallel: 2 } } }]);
    expect(effectiveIngestParallel(r, 8)).toBe(2);
  });
});

describe("limits config schema (§13.11)", () => {
  it("accepts an empty config (section defaults to {})", () => {
    const parsed = ConfigSchema.parse({});
    expect(parsed.limits).toEqual({});
  });

  it("accepts a valid nested leaf", () => {
    const parsed = ConfigSchema.parse({ limits: { tools: { commandOutputMaxBytes: 5000 } } });
    const tools = parsed.limits && typeof parsed.limits === 'object' && 'tools' in parsed.limits ? (parsed.limits as Record<string, unknown>).tools as Record<string, number> : undefined;
    expect(tools?.commandOutputMaxBytes).toBe(5000);
  });

  it("rejects an unknown area naming it", () => {
    const r = ConfigSchema.safeParse({ limits: { nope: { x: 1 } } });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown leaf naming it", () => {
    const r = ConfigSchema.safeParse({ limits: { tools: { notAThing: 1 } } });
    expect(r.success).toBe(false);
  });

  it("rejects a value below the registry min", () => {
    const r = ConfigSchema.safeParse({ limits: { tools: { commandOutputMaxBytes: 0 } } });
    expect(r.success).toBe(false);
  });

  it("rejects a wrong type", () => {
    const r = ConfigSchema.safeParse({ limits: { tools: { commandOutputMaxBytes: "big" } } });
    expect(r.success).toBe(false);
  });

  it("rejects a non-integer for a non-ratio unit", () => {
    const r = ConfigSchema.safeParse({ limits: { tools: { commandOutputMaxBytes: 1.5 } } });
    expect(r.success).toBe(false);
  });

  it("accepts a fractional ratio leaf", () => {
    const parsed = ConfigSchema.parse({ limits: { lane: { writeContextShare: 0.5 } } });
    const lane = parsed.limits && typeof parsed.limits === 'object' && 'lane' in parsed.limits ? (parsed.limits as Record<string, unknown>).lane as Record<string, number> : undefined;
    expect(lane?.writeContextShare).toBe(0.5);
  });

  it("accepts the new series leaves within bounds", () => {
    const parsed = ConfigSchema.parse({
      limits: {
        context: {},
        ingest: { maxParallel: 4 },
        tools: { searchFallbackMax: 500 },
        approval: { autoDenySeconds: 30 },
      },
    });
    const limitsObj = parsed.limits && typeof parsed.limits === 'object' ? (parsed.limits as Record<string, unknown>) : {};
    const ingest = limitsObj.ingest as Record<string, number> | undefined;
    const tools = limitsObj.tools as Record<string, number> | undefined;
    const approval = limitsObj.approval as Record<string, number> | undefined;
    expect(ingest?.maxParallel).toBe(4);
    expect(tools?.searchFallbackMax).toBe(500);
    expect(approval?.autoDenySeconds).toBe(30);
  });

  it("rejects ingest.maxParallel above its max (64)", () => {
    expect(ConfigSchema.safeParse({ limits: { ingest: { maxParallel: 100 } } }).success).toBe(false);
  });
});

describe("limits layered resolution (§13.11)", () => {
  it("falls back to the registry default when no layer sets it", () => {
    const r = resolveLimits([]);
    expect(effectiveLimit(r, "memory.entryChars")).toBe(2200);
    expect(r.values.get("memory.entryChars")?.source).toBe("default");
  });

  it("a tunable limit: narrower layer wins and source is tracked", () => {
    const r = resolveLimits([
      { layer: "global", path: "/g/config.json", limits: { memory: { entryChars: 6000 } } },
      { layer: "project", path: "/p/config.json", limits: { memory: { entryChars: 4000 } } },
    ]);
    const res = r.values.get("memory.entryChars");
    expect(res?.value).toBe(4000);
    expect(res?.source).toBe("project");
    expect(res?.sourcePath).toBe("/p/config.json");
  });

  it("a safety limit: a project RAISE is ignored and warned", () => {
    const r = resolveLimits([
      { layer: "global", path: "/g", limits: { tools: { imageMaxBytes: 65536 } } },
      { layer: "project", path: "/p/config.json", limits: { tools: { imageMaxBytes: 1_000_000 } } },
    ]);
    expect(effectiveLimit(r, "tools.imageMaxBytes")).toBe(65536);
    const w = r.warnings.find((x) => x.key === "tools.imageMaxBytes");
    expect(w?.layer).toBe("project");
    expect(w?.path).toBe("/p/config.json");
  });

  it("a safety limit: a project LOWER is honored (no warning)", () => {
    const r = resolveLimits([
      { layer: "global", limits: { tools: { imageMaxBytes: 65536 } } },
      { layer: "project", limits: { tools: { imageMaxBytes: 1024 } } },
    ]);
    expect(effectiveLimit(r, "tools.imageMaxBytes")).toBe(1024);
    expect(r.warnings.length).toBe(0);
  });

  it("a managed ceiling wins: a global raise above managed is capped", () => {
    const r = resolveLimits([
      { layer: "managed", limits: { tools: { imageMaxBytes: 2048 } } },
      { layer: "global", limits: { tools: { imageMaxBytes: 65536 } } },
    ]);
    expect(effectiveLimit(r, "tools.imageMaxBytes")).toBe(2048);
  });

  it("an integrity limit: a project LOWER is ignored and warned (journal.maxEntries)", () => {
    const r = resolveLimits([
      { layer: "global", path: "/g", limits: { journal: { maxEntries: 20000 } } },
      { layer: "project", path: "/p/config.json", limits: { journal: { maxEntries: 5 } } },
    ]);
    expect(effectiveLimit(r, "journal.maxEntries")).toBe(20000);
    const w = r.warnings.find((x) => x.key === "journal.maxEntries");
    expect(w?.layer).toBe("project");
    expect(w?.path).toBe("/p/config.json");
    expect(w?.message).toMatch(/integrity limit/);
  });

  it("an integrity limit: a global LOWER is honored (global may set it)", () => {
    const r = resolveLimits([
      { layer: "global", limits: { journal: { maxEntries: 100 } } },
    ]);
    expect(effectiveLimit(r, "journal.maxEntries")).toBe(100);
    expect(r.warnings.length).toBe(0);
  });

  it("an integrity limit: a project RAISE is honored (no warning)", () => {
    const r = resolveLimits([
      { layer: "global", limits: { journal: { maxBlobBytes: 1024 } } },
      { layer: "project", limits: { journal: { maxBlobBytes: 4096 } } },
    ]);
    expect(effectiveLimit(r, "journal.maxBlobBytes")).toBe(4096);
    expect(r.warnings.length).toBe(0);
  });

  it("an integrity managed FLOOR wins: a lower layer never goes below it", () => {
    const r = resolveLimits([
      { layer: "managed", limits: { rollback: { snapshotCount: 50 } } },
      { layer: "project", limits: { rollback: { snapshotCount: 10 } } },
    ]);
    expect(effectiveLimit(r, "rollback.snapshotCount")).toBe(50);
    expect(r.warnings.find((x) => x.key === "rollback.snapshotCount")?.layer).toBe("project");
  });

  it("rollback OFF (snapshotCount 0) is honored from global, ignored from a project", () => {
    const fromGlobal = resolveLimits([{ layer: "global", limits: { rollback: { snapshotCount: 0 } } }]);
    expect(effectiveLimit(fromGlobal, "rollback.snapshotCount")).toBe(0);
    const fromProject = resolveLimits([{ layer: "project", path: "/p", limits: { rollback: { snapshotCount: 0 } } }]);
    // The registry default is 50; a project lowering to 0 is ignored + warned.
    expect(effectiveLimit(fromProject, "rollback.snapshotCount")).toBe(50);
    expect(fromProject.warnings.find((x) => x.key === "rollback.snapshotCount")?.layer).toBe("project");
  });
});

describe("limits legacy-alias resolution (§13.11)", () => {
  it("reads a legacy top-level key when the nested limits leaf is absent, with aliasOf provenance", () => {
    const r = resolveLimits([{ layer: "global", path: "/g/config.json", doc: { snapshotCount: 10 } }]);
    const res = r.values.get("rollback.snapshotCount");
    expect(res?.value).toBe(10);
    expect(res?.source).toBe("global");
    expect(res?.sourcePath).toBe("/g/config.json");
    expect(res?.aliasOf).toBe("snapshotCount");
  });

  it("the nested limits leaf WINS over the legacy alias key in the same layer", () => {
    const r = resolveLimits([
      { layer: "global", doc: { snapshotCount: 10 }, limits: { rollback: { snapshotCount: 30 } } },
    ]);
    const res = r.values.get("rollback.snapshotCount");
    expect(res?.value).toBe(30);
    expect(res?.aliasOf).toBeUndefined();
  });

  it("a legacy memory alias key resolves the same as the nested key", () => {
    const viaLegacy = resolveLimits([{ layer: "project", doc: { memoryMaxEntryChars: 1234 } }]);
    const viaNested = resolveLimits([{ layer: "project", limits: { memory: { entryChars: 1234 } } }]);
    expect(effectiveLimit(viaLegacy, "memory.entryChars")).toBe(1234);
    expect(effectiveLimit(viaNested, "memory.entryChars")).toBe(1234);
    expect(viaLegacy.values.get("memory.entryChars")?.aliasOf).toBe("memoryMaxEntryChars");
  });

  it("the integrity rule still applies to an alias read (a project LOWER of snapshotCount via the legacy key is ignored)", () => {
    const r = resolveLimits([
      { layer: "global", doc: { snapshotCount: 50 } },
      { layer: "project", path: "/p", doc: { snapshotCount: 10 } },
    ]);
    expect(effectiveLimit(r, "rollback.snapshotCount")).toBe(50);
    expect(r.warnings.find((x) => x.key === "rollback.snapshotCount")?.layer).toBe("project");
  });
});
