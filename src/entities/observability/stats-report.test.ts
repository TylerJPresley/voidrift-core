/**
 * Stats builder unit tests (core-blueprint.md §10.14, §10.7).
 *
 * The §10.14 integration scenarios over the pure builder: buckets reconcile to
 * totals; a worker rolls up to its parent and appears under its own agent key;
 * cost rides only a fully-priced bucket; estimatedTurns marks estimated turns;
 * tokensPerSecond is generation speed (tokensOut ÷ genMs/1000), present only
 * where genMs>0 and usage measured; --days / model / agent filters; corrupt
 * lines are skipped on parse.
 */
import { describe, it, expect } from "vitest";
import { buildStatsReport, parseTrailLines } from "./stats-report.js";
import type { ObsRecord } from "./obs-record.js";

function usage(
  o: {
    model: string;
    agent?: string;
    worker?: string;
    in: number;
    out: number;
    cache?: number;
    ms: number;
    estimated?: boolean;
    cost?: number;
    ts?: string;
    /** Generation time (ms); defaults to `ms` so a streamed turn carries a
     * measurable generation span. Pass 0/omit explicitly for an unstreamed call
     * that contributes no genMs (§10.7, §10.14). */
    genMs?: number;
  },
): ObsRecord {
  const attributes: Record<string, unknown> = {};
  if (o.agent) attributes["agent"] = o.agent;
  if (o.worker) attributes["worker"] = o.worker;
  if (o.estimated) attributes["estimated"] = true;
  if (o.cost !== undefined) attributes["cost"] = o.cost;
  const genMs = o.genMs !== undefined ? o.genMs : o.ms;
  return {
    traceId: "s",
    spanId: Math.random().toString(36).slice(2),
    timestamp: o.ts ?? "2026-10-19T10:00:00.000Z",
    status: "ok",
    source: "model",
    name: "model.usage",
    severity: "info",
    attributes,
    model: { name: o.model, protocol: "openai" },
    usage: {
      inputTokens: o.in,
      outputTokens: o.out,
      totalTokens: o.in + o.out,
      ...(o.cache !== undefined ? { cacheReadTokens: o.cache } : {}),
      ...(genMs > 0 ? { genMs } : {}),
    },
    durationMs: o.ms,
  };
}

function tool(o: { status: "ok" | "error"; agent?: string; model?: string; ts?: string }): ObsRecord {
  const attributes: Record<string, unknown> = {};
  if (o.agent) attributes["agent"] = o.agent;
  if (o.model) attributes["model"] = o.model;
  return {
    traceId: "s",
    spanId: Math.random().toString(36).slice(2),
    timestamp: o.ts ?? "2026-10-19T10:00:00.000Z",
    status: o.status,
    source: "tool",
    name: "write_file",
    severity: "info",
    attributes,
  };
}

describe("§10.14 — buildStatsReport", () => {
  it("a priced two-turn session switching endpoints sums tokens/cache/wall/cost; buckets reconcile to totals", () => {
    const records = [
      usage({ model: "cloud", agent: "chat", in: 100, out: 50, cache: 10, ms: 2000, cost: 0.3 }),
      usage({ model: "local", agent: "chat", in: 200, out: 80, cache: 0, ms: 3000, cost: 0.1 }),
    ];
    const r = buildStatsReport(records, { scope: "session" });
    expect(r.totals.turns).toBe(2);
    expect(r.totals.tokensIn).toBe(300);
    expect(r.totals.tokensOut).toBe(130);
    expect(r.totals.tokensCacheRead).toBe(10);
    expect(r.totals.wallMs).toBe(5000);
    expect(r.totals.cost).toBeCloseTo(0.4);
    // byModel honest per-model after a mid-session switch (§11.9).
    expect(r.byModel["cloud"]!.tokensIn).toBe(100);
    expect(r.byModel["local"]!.tokensIn).toBe(200);
    // byModel sums to totals.
    const sumIn = Object.values(r.byModel).reduce((a, b) => a + b.tokensIn, 0);
    expect(sumIn).toBe(r.totals.tokensIn);
    const sumMs = Object.values(r.byDay).reduce((a, b) => a + b.wallMs, 0);
    expect(sumMs).toBe(r.totals.wallMs);
    // §10.14 — genMs sums the contributing calls' generation time; tokens/second
    // is generation speed = tokensOut ÷ (genMs/1000). Wall time is separate.
    expect(r.totals.genMs).toBe(5000);
    expect(r.totals.tokensPerSecond).toBeCloseTo((130 / 5000) * 1000);
  });

  it("a tool span that closed error increments toolErrors without inflating toolCalls' turn count", () => {
    const records = [
      usage({ model: "local", agent: "chat", in: 10, out: 5, ms: 100 }),
      tool({ status: "ok", agent: "chat", model: "local" }),
      tool({ status: "error", agent: "chat", model: "local" }),
    ];
    const r = buildStatsReport(records, { scope: "session" });
    expect(r.totals.turns).toBe(1);
    expect(r.totals.toolCalls).toBe(2);
    expect(r.totals.toolErrors).toBe(1);
  });

  it("with no price configured, cost is absent but every token and time field is populated", () => {
    const records = [usage({ model: "local", agent: "chat", in: 100, out: 40, ms: 1000 })];
    const r = buildStatsReport(records, { scope: "session" });
    expect(r.totals.cost).toBeUndefined();
    expect(r.totals.tokensIn).toBe(100);
    expect(r.totals.wallMs).toBe(1000);
    expect(r.totals.genMs).toBe(1000);
    expect(r.totals.tokensPerSecond).toBeCloseTo((40 / 1000) * 1000);
  });

  it("a mixed priced/unpriced subtotal omits cost; a fully-priced one keeps it", () => {
    const records = [
      usage({ model: "cloud", agent: "chat", in: 10, out: 5, ms: 100, cost: 0.2 }),
      usage({ model: "local", agent: "chat", in: 10, out: 5, ms: 100 }), // unpriced
    ];
    const r = buildStatsReport(records, { scope: "aggregate" });
    // Mixed total -> no cost.
    expect(r.totals.cost).toBeUndefined();
    // Fully-priced model bucket keeps cost; unpriced model bucket omits it.
    expect(r.byModel["cloud"]!.cost).toBeCloseTo(0.2);
    expect(r.byModel["local"]!.cost).toBeUndefined();
  });

  it("a worker rolls up into totals and appears under its own byAgent key", () => {
    const records = [
      usage({ model: "local", agent: "chat", in: 100, out: 50, ms: 1000 }),
      usage({ model: "local", worker: "implementer", in: 200, out: 80, ms: 2000 }),
    ];
    const r = buildStatsReport(records, { scope: "aggregate" });
    expect(r.totals.tokensIn).toBe(300);
    expect(r.byAgent["chat"]!.tokensIn).toBe(100);
    expect(r.byAgent["implementer"]!.tokensIn).toBe(200);
    const sum = Object.values(r.byAgent).reduce((a, b) => a + b.tokensIn, 0);
    expect(sum).toBe(r.totals.tokensIn);
  });

  it("estimatedTurns marks only buckets built from estimated turns; a turn with both keeps the reported figure", () => {
    const records = [
      usage({ model: "local", agent: "chat", in: 100, out: 50, ms: 1000, estimated: true }), // estimate-only
      usage({ model: "local", agent: "chat", in: 200, out: 80, ms: 1000 }), // reported
    ];
    const r = buildStatsReport(records, { scope: "session" });
    expect(r.totals.estimatedTurns).toBe(1);
    // tokens/second present because at least one measured turn exists.
    expect(r.totals.tokensPerSecond).toBeGreaterThan(0);
  });

  it("a bucket whose calls were not streamed reports genMs 0 and no tokens/second; a streamed bucket reports both (§10.14)", () => {
    // Unstreamed: genMs explicitly 0 (no generation span measurable).
    const unstreamed = buildStatsReport(
      [usage({ model: "local", agent: "chat", in: 100, out: 40, ms: 1500, genMs: 0 })],
      { scope: "session" },
    );
    expect(unstreamed.totals.genMs).toBe(0);
    expect(unstreamed.totals.wallMs).toBe(1500); // wall time still reported
    expect(unstreamed.totals.tokensPerSecond).toBeUndefined();
    // Streamed across two calls: genMs sums; tok/s from the summed generation time.
    const streamed = buildStatsReport(
      [
        usage({ model: "local", agent: "chat", in: 100, out: 20, ms: 1000, genMs: 400 }),
        usage({ model: "local", agent: "chat", in: 140, out: 50, ms: 1200, genMs: 600 }),
      ],
      { scope: "session" },
    );
    expect(streamed.totals.genMs).toBe(1000);
    expect(streamed.totals.tokensPerSecond).toBeCloseTo((70 / 1000) * 1000);
  });

  it("estimate-only buckets report no tokens/second (no measured usage)", () => {
    const records = [usage({ model: "local", agent: "chat", in: 100, out: 50, ms: 1000, estimated: true })];
    const r = buildStatsReport(records, { scope: "session" });
    expect(r.totals.estimatedTurns).toBe(1);
    expect(r.totals.tokensPerSecond).toBeUndefined();
  });

  it("--days cutoff, model and agent filters restrict the records", () => {
    const records = [
      usage({ model: "local", agent: "chat", in: 100, out: 50, ms: 1000, ts: "2026-10-10T10:00:00.000Z" }),
      usage({ model: "cloud", agent: "vibe", in: 200, out: 80, ms: 2000, ts: "2026-10-19T10:00:00.000Z" }),
    ];
    const bySince = buildStatsReport(records, { scope: "aggregate", since: "2026-10-15" });
    expect(bySince.totals.turns).toBe(1);
    expect(bySince.since).toBe("2026-10-15");
    const byModel = buildStatsReport(records, { scope: "aggregate", model: "local" });
    expect(byModel.totals.turns).toBe(1);
    expect(byModel.totals.tokensIn).toBe(100);
    const byAgent = buildStatsReport(records, { scope: "aggregate", agent: "vibe" });
    expect(byAgent.totals.turns).toBe(1);
    expect(byAgent.totals.tokensIn).toBe(200);
  });

  it("--model keeps tool calls/errors in totals even though tool spans carry no model (finding 5)", () => {
    const records = [
      usage({ model: "local", agent: "chat", in: 100, out: 50, ms: 1000 }),
      usage({ model: "cloud", agent: "chat", in: 200, out: 80, ms: 2000 }),
      tool({ status: "ok", agent: "chat" }), // no model attribute → "(unknown)"
      tool({ status: "error", agent: "chat" }),
    ];
    const r = buildStatsReport(records, { scope: "aggregate", model: "local" });
    // model.usage still filtered to the one model.
    expect(r.totals.turns).toBe(1);
    expect(r.totals.tokensIn).toBe(100);
    // Tool spans counted under totals regardless of the model filter.
    expect(r.totals.toolCalls).toBe(2);
    expect(r.totals.toolErrors).toBe(1);
  });

  it("preserves a group key literally named __proto__ and leaves Object.prototype untouched (finding 3)", () => {
    const records = [
      usage({ model: "__proto__", agent: "__proto__", in: 10, out: 5, ms: 100 }),
      usage({ model: "local", agent: "chat", in: 20, out: 5, ms: 100 }),
    ];
    const r = buildStatsReport(records, { scope: "aggregate" });
    expect(Object.keys(r.byModel)).toContain("__proto__");
    expect(Object.keys(r.byAgent)).toContain("__proto__");
    expect(r.byModel["__proto__"]!.tokensIn).toBe(10);
    expect(r.byAgent["__proto__"]!.tokensIn).toBe(10);
    // Object.prototype must not have been polluted.
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.getPrototypeOf(r.byModel["__proto__"])).toBe(Object.prototype);
  });

  it("parseTrailLines skips a corrupt line, never throwing (§10.3)", () => {
    const lines = [
      JSON.stringify(usage({ model: "local", agent: "chat", in: 10, out: 5, ms: 100 })),
      "{ not json",
      JSON.stringify(usage({ model: "local", agent: "chat", in: 20, out: 5, ms: 100 })),
    ];
    const recs = parseTrailLines(lines);
    expect(recs).toHaveLength(2);
    const r = buildStatsReport(recs, { scope: "aggregate" });
    expect(r.totals.turns).toBe(2);
    expect(r.totals.tokensIn).toBe(30);
  });
});
