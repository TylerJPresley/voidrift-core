/**
 * Observability entity unit tests (core-blueprint.md §10.5, §10.6, §10.7, §10.2).
 */
import { describe, it, expect } from "vitest";
import { queryRecords, parseFilter, applyFilter, INVALID_QUERY } from "./query.js";
import { TraceAnalyzer } from "./trace-analyzer.js";
import { deriveCost } from "./cost.js";
import { levelIncludes, type ObsRecord } from "./obs-record.js";

function rec(partial: Partial<ObsRecord>): ObsRecord {
  return {
    traceId: "s1",
    spanId: "sp",
    timestamp: new Date().toISOString(),
    status: "ok",
    source: "tool",
    name: "n",
    severity: "info",
    attributes: {},
    ...partial,
  };
}

describe("§10.5 — liqe query path", () => {
  it("returns only failed tool spans for source:tool AND status:error", () => {
    const records = [
      rec({ source: "tool", status: "error", name: "a" }),
      rec({ source: "tool", status: "ok", name: "b" }),
      rec({ source: "model", status: "error", name: "c" }),
    ];
    const res = queryRecords(records, "source:tool AND status:error");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toHaveLength(1);
      expect(res.value[0]!.name).toBe("a");
    }
  });

  it("an unparseable filter returns a structured INVALID_QUERY with the parser message", () => {
    const res = parseFilter("status:>>bad::");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(INVALID_QUERY);
      expect(res.error.message.length).toBeGreaterThan(0);
    }
  });

  it("an absent filter matches all; limit keeps the newest", () => {
    const records = [rec({ name: "newest" }), rec({ name: "older" })];
    expect(applyFilter(parseFilter().ok ? (parseFilter() as { value: null }).value : null, records)).toHaveLength(2);
    const limited = queryRecords(records, undefined, { limit: 1 });
    expect(limited.ok && limited.value).toHaveLength(1);
    if (limited.ok) expect(limited.value[0]!.name).toBe("newest");
  });

  it("a since cutoff drops older records", () => {
    const old = rec({ name: "old", timestamp: "2000-01-01T00:00:00.000Z" });
    const now = rec({ name: "now", timestamp: "2100-01-01T00:00:00.000Z" });
    const res = queryRecords([now, old], undefined, { since: "2050-01-01T00:00:00.000Z" });
    expect(res.ok && res.value.map((r) => r.name)).toEqual(["now"]);
  });
});

describe("§10.6 — trace analyzer", () => {
  it("fires once per shape after the threshold, repeated tool_error:<name>", () => {
    const a = new TraceAnalyzer(3);
    const r = () => a.observe(rec({ source: "tool", status: "error", name: "write_file" }));
    expect(r()).toBeNull();
    expect(r()).toBeNull();
    const hit = r();
    expect(hit).toEqual({ pattern: "tool_error:write_file", count: 3 });
    // Does not fire again for the same shape.
    expect(r()).toBeNull();
  });

  it("fires guardian_block:<tool> on repeated denies and ignores non-failures", () => {
    const a = new TraceAnalyzer(2);
    const deny = () =>
      a.observe(rec({ source: "guardian", status: "error", name: "permission_denied", attributes: { decision: "deny", tool: "execute_command" } }));
    expect(deny()).toBeNull();
    expect(deny()).toEqual({ pattern: "guardian_block:execute_command", count: 2 });
    // An ok tool span is not a shape.
    expect(a.observe(rec({ source: "tool", status: "ok", name: "read_file" }))).toBeNull();
  });
});

describe("§10.7 — cost attribution", () => {
  it("derives a cost only when a price is supplied", () => {
    const usage = { inputTokens: 1000, outputTokens: 2000, totalTokens: 3000 };
    expect(deriveCost(usage, undefined)).toBeUndefined();
    expect(deriveCost(usage, {})).toBeUndefined();
    expect(deriveCost(usage, { costPer1kInput: 0.5, costPer1kOutput: 1 })).toBeCloseTo(0.5 + 2);
  });
});

describe("§10.2 — level ordering info ⊂ verbose ⊂ debug", () => {
  it("a higher level includes a lower-recorded record", () => {
    expect(levelIncludes("info", "info")).toBe(true);
    expect(levelIncludes("info", "verbose")).toBe(false);
    expect(levelIncludes("verbose", "info")).toBe(true);
    expect(levelIncludes("debug", "verbose")).toBe(true);
  });
});
