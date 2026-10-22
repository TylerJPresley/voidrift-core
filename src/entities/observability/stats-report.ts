/**
 * The cost, token and time view (core-blueprint.md §10.14, §10.7, §11.9).
 *
 * A pure builder over the neutral `ObsRecord` trail. Two scopes share one typed
 * document: the live single session (`scope: "session"`, from the session's own
 * `model.usage` records) and an aggregate across the workspace's stored session
 * trails (`scope: "aggregate"`). It reads already-persisted, already-masked
 * records only — no model call, no network, no session start (§10.14).
 *
 * Every grouping (`byModel`, `byAgent`, `byDay`) partitions the same per-record
 * contribution, so each grouping independently sums to `totals`. Cost rides a
 * bucket only when EVERY contributing model is priced (§10.7); a mixed subtotal
 * omits it rather than report a misleading figure. `estimatedTurns` counts turns
 * whose token totals rest on the harness estimate rather than a provider-reported
 * figure. A corrupt trail line is the caller's concern (skipped on parse);
 * the builder is total over whatever records it is handed.
 */
import type { ObsRecord } from "./obs-record.js";

export interface StatsReport {
  scope: "session" | "aggregate";
  /** ISO day cutoff when `--days` is given (aggregate). */
  since?: string;
  totals: StatsBucket;
  byModel: Record<string, StatsBucket>;
  /** top-level or worker agent name. */
  byAgent: Record<string, StatsBucket>;
  /** YYYY-MM-DD, local. */
  byDay: Record<string, StatsBucket>;
}

export interface StatsBucket {
  turns: number;
  toolCalls: number;
  toolErrors: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensTotal: number;
  wallMs: number;
  /** Summed model generation time (first to last streamed token), §10.7/§10.14. */
  genMs: number;
  /** Turns whose token totals are the harness estimate (§10.7). */
  estimatedTurns: number;
  /** Generation speed: `tokensOut ÷ (genMs/1000)`; omitted when `genMs` is 0 or
   * unmeasurable, or usage was not measured (§10.14). */
  tokensPerSecond?: number;
  /** Only where a price is configured for every model that contributed (§10.7). */
  cost?: number;
}

/** A mutable accumulator; `cost` becomes `undefined` the moment one contributing
 * model is unpriced, so a partially priced bucket never reports a subtotal. */
interface BucketAcc {
  turns: number;
  toolCalls: number;
  toolErrors: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensTotal: number;
  wallMs: number;
  genMs: number;
  estimatedTurns: number;
  /** Cumulative cost while every contributor is priced. */
  cost: number;
  /** False once any contributing model carried no cost. */
  allPriced: boolean;
  /** True once a model.usage record contributed measured (reported) usage. */
  measured: boolean;
}

function emptyAcc(): BucketAcc {
  return {
    turns: 0,
    toolCalls: 0,
    toolErrors: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensCacheRead: 0,
    tokensTotal: 0,
    wallMs: 0,
    genMs: 0,
    estimatedTurns: 0,
    cost: 0,
    allPriced: true,
    measured: false,
  };
}

function finalize(acc: BucketAcc): StatsBucket {
  const bucket: StatsBucket = {
    turns: acc.turns,
    toolCalls: acc.toolCalls,
    toolErrors: acc.toolErrors,
    tokensIn: acc.tokensIn,
    tokensOut: acc.tokensOut,
    tokensCacheRead: acc.tokensCacheRead,
    tokensTotal: acc.tokensTotal,
    wallMs: acc.wallMs,
    genMs: acc.genMs,
    estimatedTurns: acc.estimatedTurns,
  };
  // tokens/second is GENERATION speed: summed output tokens over summed
  // generation time (`genMs`), present only where that time is measured AND
  // usage was measured (§10.14, §10.7). Wall time is reported separately.
  if (acc.genMs > 0 && acc.measured) {
    bucket.tokensPerSecond = (acc.tokensOut / acc.genMs) * 1000;
  }
  // cost only when EVERY contributing model was priced (§10.7).
  if (acc.allPriced && acc.cost > 0) bucket.cost = acc.cost;
  return bucket;
}

/** The day key (YYYY-MM-DD, LOCAL) for a record's timestamp. */
function dayOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Options for the aggregate build (§10.14, §2.4). */
export interface StatsBuildOpts {
  scope: "session" | "aggregate";
  /** Day cutoff (ISO YYYY-MM-DD): records strictly before it are excluded. */
  since?: string;
  /** Keep only records attributed to this model name. */
  model?: string;
  /** Keep only records attributed to this agent name. */
  agent?: string;
}

/**
 * Build a `StatsReport` from a flat list of already-parsed records (one session
 * or many concatenated). Each `model.usage` span contributes one turn's tokens,
 * wall time, cost and estimated flag; each terminal tool span contributes a tool
 * call (and an error when it closed `error`). A record carries its `agent` and,
 * where known, its `model` so the three groupings partition identically.
 */
export function buildStatsReport(records: readonly ObsRecord[], opts: StatsBuildOpts): StatsReport {
  const totals = emptyAcc();
  const byModel = new Map<string, BucketAcc>();
  const byAgent = new Map<string, BucketAcc>();
  const byDay = new Map<string, BucketAcc>();

  const get = (m: Map<string, BucketAcc>, k: string): BucketAcc => {
    let a = m.get(k);
    if (!a) {
      a = emptyAcc();
      m.set(k, a);
    }
    return a;
  };

  for (const r of records) {
    const attrs = (r.attributes ?? {}) as Record<string, unknown>;
    // A worker span's own name takes precedence for agent attribution (§10.14);
    // else the turn's active agent, else "unknown".
    const worker = typeof attrs["worker"] === "string" ? (attrs["worker"] as string) : undefined;
    const agent =
      worker ??
      (typeof attrs["agent"] === "string" && attrs["agent"] ? (attrs["agent"] as string) : "unknown");
    const modelName = r.model?.name ?? (typeof attrs["model"] === "string" ? (attrs["model"] as string) : "(unknown)");
    const day = dayOf(r.timestamp);

    if (opts.since && day < opts.since) continue;
    if (opts.agent && agent !== opts.agent) continue;

    const isModelUsage = r.source === "model" && r.name === "model.usage";
    const isTool = r.source === "tool" && (r.status === "ok" || r.status === "error");

    if (isModelUsage) {
      if (opts.model && modelName !== opts.model) continue;
      const usage = r.usage;
      const tokensIn = num(usage?.inputTokens);
      const tokensOut = num(usage?.outputTokens);
      const tokensTotal = num(usage?.totalTokens) || tokensIn + tokensOut;
      const cacheRead = num(usage?.cacheReadTokens);
      const wallMs = num(r.durationMs);
      const genMs = num(usage?.genMs);
      const estimated = attrs["estimated"] === true;
      const cost = typeof attrs["cost"] === "number" && Number.isFinite(attrs["cost"]) ? (attrs["cost"] as number) : undefined;
      const measured = !estimated;

      for (const acc of [totals, get(byModel, modelName), get(byAgent, agent), get(byDay, day)]) {
        acc.turns += 1;
        acc.tokensIn += tokensIn;
        acc.tokensOut += tokensOut;
        acc.tokensCacheRead += cacheRead;
        acc.tokensTotal += tokensTotal;
        acc.wallMs += wallMs;
        acc.genMs += genMs;
        if (estimated) acc.estimatedTurns += 1;
        if (measured && tokensTotal > 0) acc.measured = true;
        if (cost !== undefined) acc.cost += cost;
        else acc.allPriced = false;
      }
    } else if (isTool) {
      // Tool spans carry no model (§10.14); a `--model` filter must not drop
      // them — they are counted under totals regardless of the model filter
      // (finding 5). The agent/since filters above still apply.
      const isError = r.status === "error";
      for (const acc of [totals, get(byModel, modelName), get(byAgent, agent), get(byDay, day)]) {
        acc.toolCalls += 1;
        if (isError) acc.toolErrors += 1;
      }
    }
  }

  const mapOut = (m: Map<string, BucketAcc>): Record<string, StatsBucket> => {
    // A null-prototype object so a group key literally named `__proto__` (or
    // `constructor`) is preserved as an ordinary key and never mutates
    // Object.prototype (finding 3).
    const out: Record<string, StatsBucket> = Object.create(null) as Record<string, StatsBucket>;
    for (const [k, acc] of m) out[k] = finalize(acc);
    return out;
  };

  const report: StatsReport = {
    scope: opts.scope,
    totals: finalize(totals),
    byModel: mapOut(byModel),
    byAgent: mapOut(byAgent),
    byDay: mapOut(byDay),
  };
  if (opts.since) report.since = opts.since;
  return report;
}

/** Parse NDJSON lines into records, skipping a corrupt line (§10.3). */
export function parseTrailLines(lines: readonly string[]): ObsRecord[] {
  const out: ObsRecord[] = [];
  for (const l of lines) {
    try {
      out.push(JSON.parse(l) as ObsRecord);
    } catch {
      /* skip a corrupt line (§10.3) */
    }
  }
  return out;
}
