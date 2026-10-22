/**
 * The observability writer (core-blueprint.md §10.1–10.8).
 *
 * The one capability that turns the harness's activity into the neutral
 * `ObsRecord` trail. It is fed from two additive sources that share a `traceId`
 * (the session id) and nest by `parentSpanId` (§10.4):
 *
 *  1. the shared `BaseCallbackHandler` (`ObsCallbackHandler`) the core registers
 *     on every runnable — its LangChain run id becomes `spanId`, its parent run
 *     id becomes `parentSpanId`, so model and tool spans nest exactly as
 *     LangChain nests runs, with no bespoke tracing (§1 LangChain-first); and
 *  2. the event stream — the writer subscribes at boot to the significant events
 *     (TURN_COMPLETE, MODEL_USAGE, PERMISSION_*, COMPLIANCE_*, WORKER_STATUS_CHANGED,
 *     MEMORY_SAVED, SKILL_LOADED, ERROR_OCCURRED, …) and mints a record for each
 *     span that has no LangChain run, parenting it to the enclosing span.
 *
 * Every record is masked (§10.10) before it is persisted or handed to an
 * exporter. The writer feeds the trace analyzer (§10.6), sums SessionStats
 * (§10.3, §10.7), and backs `observability.query` / `tail` and the `query_logs`
 * tool (§10.5). Writes are best-effort: a store failure is swallowed (§10.3).
 */
import type { EventBus, EventEnvelope } from "../entities/event-bus.js";
import type { ObsLogStore } from "../entities/ports/obs-log-store.js";
import {
  type ObsExporter,
  type ObsRecord,
  type ObsSeverity,
  type ObsSource,
  type ObsStatus,
  type TokenUsage,
} from "../entities/observability/obs-record.js";
import { TraceAnalyzer } from "../entities/observability/trace-analyzer.js";
import {
  SequenceDetector,
  windowsFromRecords,
  type SequencePattern,
} from "../entities/observability/sequence-detector.js";
import { toolDisplayName } from "../entities/observability/tool-display.js";
import type { SessionRepository } from "../entities/ports/session-repository.js";
import { limitDefault } from "../entities/limits.js";
import { deriveCost, type ModelPrice } from "../entities/observability/cost.js";
import { emptyStats, type SessionStats } from "../entities/observability/session-stats.js";
import {
  buildStatsReport,
  parseTrailLines,
  type StatsReport,
  type StatsBuildOpts,
} from "../entities/observability/stats-report.js";
import { queryRecords } from "../entities/observability/query.js";
import { applyFilter, parseFilter } from "../entities/observability/query.js";
import { maskValue } from "./secret-mask.js";
import { ok, type Result } from "../entities/errors.js";

/** A monotone-ish span id for a core-minted (non-LangChain) span (§10.4). */
let MINT_SEQ = 0;
function mintSpanId(): string {
  MINT_SEQ += 1;
  return `vr-${Date.now().toString(36)}-${MINT_SEQ.toString(36)}`;
}

/** Repeated-sequence detection internals (§10.6), fixed in code, not config. */
/** `sequenceMaxLen` default when no resolver is wired. */
const DEFAULT_SEQUENCE_MAX_LEN = 6;
/** Most recent prior sessions of the SAME workspace seeded at the boundary. The
 * default comes from the limits registry (`sequence.priorSessions`). */
const SEQUENCE_PRIOR_SESSIONS = limitDefault("sequence.priorSessions");
/** Bounded ring of recent masked spans kept per session for evidence examples. */
const SEQUENCE_SPAN_RING = 64;
/** At most this many example spans ride a raised sequence into reflection. */
const SEQUENCE_EXAMPLE_SPANS = 6;
/** The bounded per-session cap on recorded-but-undrafted sequence candidates
 * (§6.7). The detector already caps signals at 3/session, so this is a safety
 * ceiling against a long-lived session; the oldest candidate is dropped first.
 * The default comes from the limits registry (`sequence.queueCap`). */
const SEQUENCE_QUEUE_CAP = limitDefault("sequence.queueCap");
/** The bounded per-session in-memory record cap for the live stats report
 * (§10.14): enough for a long session's model.usage + tool spans without
 * growing without bound. The default comes from the limits registry
 * (`stats.recordCap`); boot wires a live getter so a config override applies. */
const STATS_RECORD_CAP = limitDefault("stats.recordCap");

/** The per-record cap for an event-sourced span's argument/summary bag (§10.3,
 * §10.2): a tool span records a masked, length-bounded SUMMARY of its args —
 * never full file contents or command output — so one long turn's trail cannot
 * grow without bound. A string value longer than this is truncated with an
 * ellipsis marker; the structural keys are kept so the record stays parseable. */
const MAX_ARG_SUMMARY_CHARS = 1024;

/**
 * Build a bounded, structure-preserving summary of a tool call's arguments for
 * the `info` trail (§10.2, §10.3). Each string value is capped at
 * {@link MAX_ARG_SUMMARY_CHARS}; a non-string value is kept as-is (numbers,
 * booleans, small nested objects). The result is masked by {@link maskRecord}
 * when the record is written, so a secret in an argument never reaches disk.
 * The whole bag is never the raw file content or command output — those ride the
 * mutation journal, not the trail.
 */
function summarizeArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") {
    return args === undefined ? {} : { value: boundString(String(args)) };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    out[k] = typeof v === "string" ? boundString(v) : v;
  }
  return out;
}

/** Cap a string at the per-record summary bound, marking a truncation (§10.3). */
function boundString(s: string): string {
  if (s.length <= MAX_ARG_SUMMARY_CHARS) return s;
  return `${s.slice(0, MAX_ARG_SUMMARY_CHARS)}…[+${s.length - MAX_ARG_SUMMARY_CHARS} chars]`;
}

/** The deps the writer needs, wired by boot. */
export interface ObsWriterDeps {
  bus: EventBus;
  store: ObsLogStore;
  /** Enumerate the workspace's prior sessions for cross-session sequence seeding
   * (§10.6). Optional: without it, counting is within-session only. */
  sessions?: SessionRepository;
  /** The sequence signatures the detector must NOT signal again (§10.6
   * Lifecycle): every pending/approved suggestion's signature plus the remembered
   * rejected list. Read once at the session boundary; a failure is non-fatal. */
  getSuppressedSignatures?: () => Promise<string[]>;
  getLevel: () => ObsSeverity;
  getSuggestionThreshold: () => number;
  /** `sequenceMaxLen` (§10.6) — the longest consecutive tool-call window the
   * repeated-sequence detector matches as one unit. */
  getSequenceMaxLen?: () => number;
  /** §13.11 `stats.recordCap` — the per-session evidence ring size. Live getter
   * so a config override applies; absent uses the registry default. */
  getStatsRecordCap?: () => number;
  /** §13.11 §10.6 — the repeated-sequence detector caps
   * (`sequence.maxSignalsPerSession`, `sequence.maxSignalsPerTurn`,
   * `sequence.minDistinctSessions`). Live getter so a config override applies;
   * absent, the detector uses the registry defaults. */
  getSequenceCaps?: () => { maxSignalsPerSession: number; maxSignalsPerTurn: number; minDistinctSessions: number };
  /** §13.11 `sequence.priorSessions` — how many recent prior sessions seed the
   * detector at the boundary. Live getter so a config override applies; absent
   * uses the registry default. */
  getSequencePriorSessions?: () => number;
  /** §13.11 `sequence.queueCap` — the bounded per-session recorded-but-undrafted
   * sequence-candidate cap. Live getter so a config override applies; absent uses
   * the registry default. */
  getSequenceQueueCap?: () => number;
  /**
   * Consume a raised repeated-sequence signal (§10.6 → §6.7). The ObsWriter
   * detects mechanically and emits the `sequence-detector` WARNING_EMITTED; this
   * hands the FULL signal (steps, split, outcome, session ids) plus a few masked
   * example spans from the `info` trail to the reflection flow, which turns it
   * into a pending skill candidate. Best-effort: a failure here never disturbs
   * the write path. Detection itself stays model-free; only this consumer calls a
   * model. */
  onSequenceSignal?: (signal: SequencePattern, exampleSpans: ObsRecord[]) => void | Promise<unknown>;
  /**
   * Consume a raised repeated-FAILURE signal (§10.6 → §6.7). The ObsWriter's
   * trace analyzer detects a recurring `tool_error:<name>`/`guardian_block:<tool>`
   * and emits the `trace-analyzer` WARNING_EMITTED; this hands the pattern, count,
   * error class and a few masked example spans to the reflection flow, which drafts
   * ONE pending memory-note candidate at idle. Best-effort; detection stays
   * model-free, only this consumer calls a model. */
  onFailureSignal?: (
    signal: { pattern: string; count: number; errorClass: string },
    exampleSpans: ObsRecord[],
  ) => void | Promise<unknown>;
  /** Per-model price map for cost attribution (§10.7); undefined = unpriced. */
  getPrice?: (modelName: string) => ModelPrice | undefined;
  /** The registered exporters (§10.8); each receives every masked record. */
  exporters?: () => ObsExporter[];
  /** Out-of-band sink for an exporter/write failure (§10.8). It is NOT the event
   * bus: an exporter failure must never re-enter the observability write path
   * (which the writer subscribes to), or it recurses unboundedly. The failure is
   * logged as a warning and swallowed; the local trail is written regardless. */
  onError?: (message: string) => void;
}

interface TailSub {
  predicate: (r: ObsRecord) => boolean;
  emit: (r: ObsRecord) => void;
}

export class ObsWriter {
  private readonly analyzers = new Map<string, TraceAnalyzer>();
  /** Per-session repeated-sequence detector (§10.6). */
  private readonly sequencers = new Map<string, SequenceDetector>();
  /** The most recent masked spans per session, a bounded ring so a raised
   * sequence can carry a few real example spans into its evidence packet (§6.7).
   * Shape digests already strip values; the spans themselves are masked. */
  private readonly recentSpans = new Map<string, ObsRecord[]>();
  /** Sessions already seeded from prior sessions, so a boundary seeds at most
   * once per session (idempotent). */
  private readonly seeded = new Set<string>();
  /** §6.7/§10.6 — recorded repeated-sequence candidates awaiting a DRAFT, per
   * session. The detector only records; `reflectSequence` runs when the session
   * is idle or at the boundary (never mid-turn), one at a time, best-effort. The
   * queue is bounded and cleared on setMode/clear/shutdown so it never grows
   * without bound or carries stale candidates across a mode switch. */
  private readonly sequenceQueue = new Map<string, { signal: SequencePattern; examples: ObsRecord[] }[]>();
  /** §6.7/§10.6 — recorded repeated-FAILURE candidates awaiting a DRAFT, per
   * session. Mirrors `sequenceQueue`: the trace analyzer only records a hit; the
   * memory-note draft (`reflectFailure`) runs at idle/boundary, one at a time. */
  private readonly failureQueue = new Map<string, { pattern: string; count: number; errorClass: string; examples: ObsRecord[] }[]>();
  /** Sessions whose candidate queue is currently being drained, so two drains
   * (an idle poke racing the boundary) never call the model concurrently. */
  private readonly draining = new Set<string>();
  private readonly stats = new Map<string, SessionStats>();
  /** Per-session in-memory record list for the live stats report (§10.14,
   * §11.9): the `model.usage` and terminal tool spans the builder needs, kept in
   * memory so the live `scope: "session"` report is honest even when the on-disk
   * trail write is best-effort (and may be unwritable). Bounded per session. */
  private readonly statsRecords = new Map<string, ObsRecord[]>();
  private readonly tails = new Set<TailSub>();
  private unsubscribe: (() => void) | undefined;
  /** In-flight best-effort writes, drained by `flush()` on a clean shutdown so a
   * late fire-and-forget write never races a workspace teardown (§10.3). */
  private readonly inflight = new Set<Promise<void>>();
  /** Set once `close()` has stopped accepting records. After this is true a
   * record offered to `schedule()` is refused DELIBERATELY (never written after
   * close), so an event emitted post-close cannot re-create a torn-down
   * workspace (§10.3, §14.3). */
  private closed = false;
  /** The single in-progress `close()`, so concurrent shutdown() calls share one
   * drain and all resolve after it (idempotent, concurrent-safe). */
  private closing: Promise<void> | undefined;

  constructor(private readonly deps: ObsWriterDeps) {}

  /**
   * Drain every in-flight write to QUIESCENCE (§10.3, §5.2). A single write
   * (mask → analyze → store → export → tail) can SCHEDULE follow-on records —
   * the trace analyzer emits `WARNING_EMITTED` synchronously, which re-enters the
   * write path and adds to `inflight` AFTER a one-shot snapshot would have been
   * taken. So loop until no write is in flight, then flush exporters (a flush can
   * itself produce a record), then re-check — repeating until the system is
   * genuinely idle. Bounded at 32 passes: a pathological feedback loop (a record
   * that always begets another) can never hang shutdown; if the bound is hit the
   * writer signals `WARNING_EMITTED` once and returns. */
  async flush(): Promise<void> {
    const MAX_PASSES = 32;
    let pass = 0;
    for (;;) {
      while (this.inflight.size > 0) {
        if (pass >= MAX_PASSES) {
          this.deps.onError?.("obs flush exceeded 32 drain passes; forcing shutdown");
          return;
        }
        pass += 1;
        await Promise.allSettled([...this.inflight]);
      }
      // Flush exporters; a flush can emit a record that re-enters the write path.
      for (const exp of this.deps.exporters?.() ?? []) {
        try {
          await exp.flush?.();
        } catch {
          /* a thrower is isolated (§10.8) */
        }
      }
      // Draining the store's own per-path append queue can surface nothing new,
      // but a record accepted by the store is only durable once its queue drains.
      await this.deps.store.drain?.();
      // Re-check: if the exporter flush or a late callback scheduled a write,
      // loop again; otherwise we are quiescent.
      if (this.inflight.size === 0) return;
      if (pass >= MAX_PASSES) {
        this.deps.onError?.("obs flush exceeded 32 drain passes; forcing shutdown");
        return;
      }
    }
  }

  /** Subscribe to the significant events at boot (§10.4). Idempotent. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.bus.subscribe("*", (e) => this.onEvent(e));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /**
   * Release every handle the writer holds (§10, §14.3 shutdown) in a fixed order
   * so nothing touches the filesystem after it resolves:
   *   (a) the event bus is synchronous (§14.5) — every event already emitted has
   *       already been delivered to `onEvent` and `schedule()`d, so no extra turn
   *       is needed to let the bus drain; a microtask yield guards against a
   *       scheduler that defers delivery;
   *   (b) stop accepting new records (`closed` + detach the subscription), so a
   *       record emitted from here on is refused DELIBERATELY, never written;
   *   (c) drain in-flight writes AND their follow-on records to quiescence,
   *       flushing exporters and the store's append queue (`flush()`);
   *   (d) clear the live tails and per-session analyzers.
   * Idempotent and concurrent-safe: two simultaneous shutdowns share one drain
   * and both resolve only after it. `dispose` is an alias.
   */
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      // (a) Let the bus deliver everything already emitted. emit() is synchronous
      // (§14.5), so this is a guard, not a dependency.
      await Promise.resolve();
      // (b) Drain to quiescence FIRST, with the subscription still live, so a
      // follow-on record a draining write produces (an exporter or analyzer that
      // emits a mapped event, a TURN_COMPLETE-derived span) still re-enters the
      // write path and is persisted — not lost. `flush()` loops until no write is
      // in flight, flushing exporters and the store's append queue each pass.
      await this.flush();
      // (c) Now stop accepting records: detach the bus subscription and set the
      // guard. From here a record is refused DELIBERATELY (never written after
      // close), so a post-close event cannot re-create a torn-down workspace.
      this.closed = true;
      this.stop();
      // (d) A record could have been scheduled in the window between the last
      // flush pass and setting `closed`; drain that final tail too.
      await this.flush();
      // (e) Release the remaining handles.
      this.tails.clear();
      this.analyzers.clear();
      this.sequencers.clear();
      this.recentSpans.clear();
      this.statsRecords.clear();
      this.sequenceQueue.clear();
    })();
    return this.closing;
  }

  /** Alias for `close()` (§14). */
  async dispose(): Promise<void> {
    await this.close();
  }

  /** Running totals for a session, mirrored to its partition (§10.3). */
  statsFor(sessionId: string): SessionStats {
    return this.stats.get(sessionId) ?? emptyStats();
  }

  /**
   * The session's live cost/token/time report (§10.14, §11.9) — a `StatsReport`
   * with `scope: "session"` built from the session's OWN `model.usage` records,
   * so a mid-session model switch is attributed to the model that actually ran
   * each turn. Reads the persisted trail only; a corrupt line is skipped.
   */
  async statsReportFor(sessionId: string): Promise<StatsReport> {
    // Drain in-flight writes first so a just-completed turn's records are
    // captured, then build from the in-memory record list — honest even when
    // the on-disk trail write is best-effort (and possibly unwritable).
    await this.flush();
    const records = this.statsRecords.get(sessionId) ?? [];
    return buildStatsReport(records, { scope: "session" });
  }

  /**
   * The aggregate cost/token/time report (§10.14, §2.4) across the workspace's
   * stored session trails, optionally filtered by day cutoff, model or agent.
   * Reads local trails only — no model call, no network, no session start.
   * Best-effort per session: an unreadable trail is skipped, a corrupt line is
   * skipped, and the build is bounded by the session list.
   */
  async aggregateStats(opts?: { days?: number; model?: string; agent?: string; workspace?: string }): Promise<StatsReport> {
    // Drain in-flight writes first so the live session's own records are current
    // in the persisted trail before the aggregate reads them.
    await this.flush();
    const build: StatsBuildOpts = { scope: "aggregate" };
    if (opts?.model) build.model = opts.model;
    if (opts?.agent) build.agent = opts.agent;
    if (typeof opts?.days === "number" && opts.days > 0) {
      const cutoff = new Date(Date.now() - (opts.days - 1) * 86_400_000);
      const y = cutoff.getFullYear();
      const m = String(cutoff.getMonth() + 1).padStart(2, "0");
      const d = String(cutoff.getDate()).padStart(2, "0");
      build.since = `${y}-${m}-${d}`;
    }
    const records: ObsRecord[] = [];
    if (this.deps.sessions) {
      let metas: Awaited<ReturnType<SessionRepository["list"]>> = [];
      try {
        metas = await this.deps.sessions.list();
      } catch (e) {
        this.deps.onError?.(`obs stats: session list failed: ${e instanceof Error ? e.message : String(e)}`);
        metas = [];
      }
      for (const meta of metas) {
        if (opts?.workspace !== undefined && meta.workspace !== opts.workspace) continue;
        try {
          const lines = await this.deps.store.readWorkspace(meta.id);
          records.push(...parseTrailLines(lines));
        } catch (e) {
          // Best-effort: one unreadable trail never breaks the aggregate (§10.3).
          this.deps.onError?.(`obs stats: session ${meta.id} unreadable: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    return buildStatsReport(records, build);
  }

  // ── the shared BaseCallbackHandler surface (§10.1, §10.4) ───────────────────
  // The handler calls through to `writeFromCallback`, so a model/tool span and
  // an event-sourced span share one write path and one trace.

  /** Write a callback-sourced span (run id → spanId, parent run id → parentSpanId). */
  writeFromCallback(partial: {
    spanId: string;
    parentSpanId?: string;
    source: ObsSource;
    name: string;
    status: ObsStatus;
    severity?: ObsSeverity;
    traceId: string;
    durationMs?: number;
    attributes?: Record<string, unknown>;
    model?: { name: string; protocol: string };
    input?: unknown;
    output?: unknown;
    usage?: TokenUsage;
  }): void {
    const rec: ObsRecord = {
      traceId: partial.traceId,
      spanId: partial.spanId,
      ...(partial.parentSpanId ? { parentSpanId: partial.parentSpanId } : {}),
      timestamp: new Date().toISOString(),
      ...(partial.durationMs !== undefined ? { durationMs: partial.durationMs } : {}),
      status: partial.status,
      source: partial.source,
      name: partial.name,
      severity: partial.severity ?? "info",
      attributes: partial.attributes ?? {},
      ...(partial.model ? { model: partial.model } : {}),
      ...(partial.input !== undefined ? { input: partial.input } : {}),
      ...(partial.output !== undefined ? { output: partial.output } : {}),
      ...(partial.usage ? { usage: partial.usage } : {}),
    };
    this.schedule(rec);
  }

  // ── event-sourced spans (§10.4) ────────────────────────────────────────────

  private onEvent(e: EventEnvelope): void {
    const sessionId = e.scope.session;
    if (!sessionId) return; // unscoped boot/housekeeping events carry no trace
    const map = (
      source: ObsSource,
      status: ObsStatus,
      name: string,
      attributes: Record<string, unknown>,
      extra?: Partial<ObsRecord>,
    ): void => {
      const rec: ObsRecord = {
        traceId: sessionId,
        spanId: mintSpanId(),
        timestamp: e.at,
        status,
        source,
        name,
        severity: "info",
        attributes,
        ...extra,
      };
      this.schedule(rec);
    };

    const p = e.payload as Record<string, unknown>;
    switch (e.type) {
      case "MODEL_USAGE": {
        const name = String(p["name"] ?? "model");
        const usage = normalizeUsage(p["usage"]);
        const price = this.deps.getPrice?.(name);
        const cost = deriveCost(usage, price);
        // Wall time rides the record as `durationMs` (the turn's measured
        // `totalMs`) so the §10.14 trail builder can sum it without a new stamp.
        const rawUsage = p["usage"] as Record<string, unknown> | undefined;
        const totalMs = num(rawUsage?.["totalMs"]);
        // §10.7 — a turn whose response reports no usage records the harness
        // estimate and is marked so a view can mark it `~`. The engine sends the
        // estimate beside the usage; `estimated` is true when the turn's token
        // totals rest on it rather than a provider-reported figure.
        const estimated = p["estimated"] === true;
        const agent = typeof p["agent"] === "string" && p["agent"] ? String(p["agent"]) : undefined;
        const taskId = typeof p["taskId"] === "string" && p["taskId"] ? String(p["taskId"]) : undefined;
        this.bumpTokens(sessionId, usage, cost, { cacheRead: num(usage?.cacheReadTokens), wallMs: totalMs });
        map(
          "model",
          "ok",
          "model.usage",
          {
            ...(cost !== undefined ? { cost } : {}),
            ...(estimated ? { estimated: true } : {}),
            ...(agent ? { agent } : {}),
            ...(taskId ? { taskId } : {}),
          },
          {
            model: { name, protocol: String(p["protocol"] ?? "openai") },
            ...(usage ? { usage } : {}),
            ...(totalMs > 0 ? { durationMs: totalMs } : {}),
          },
        );
        break;
      }
      case "TURN_COMPLETE": {
        this.bumpTurn(sessionId);
        // The full compiled turn is written once per turn (§10.4). At `info` the
        // compiled prompt and the full model response ride the record; raw
        // payload bulk is omitted (§10.2).
        map("session", "ok", "turn.complete", {
          toolsUsed: p["toolsUsed"] ?? [],
          ...(typeof p["agent"] === "string" && p["agent"] ? { agent: String(p["agent"]) } : {}),
          compiledTurn: {
            prompt: p["prompt"] ?? p["input"] ?? null,
            response: p["text"] ?? null,
            usage: p["usage"] ?? null,
          },
        });
        break;
      }
      case "TOOL_STARTED": {
        const name = String(p["name"] ?? "");
        this.bumpTool(sessionId, name);
        // §10.3/§10.4 — persist the tool START span so a run is reconstructable
        // from disk (the `info` trail carries every span, never sampled). It
        // carries the tool name, the correlation id, and a masked, length-bounded
        // argument SUMMARY — never full file contents or command output (those
        // ride the mutation journal, §10.11). `pending` status, so the stats
        // builder never counts a start span as a completed tool call (§10.14).
        map(
          "tool",
          "pending",
          name || "tool",
          {
            ...(p["id"] !== undefined ? { toolCallId: p["id"] } : {}),
            args: summarizeArgs(p["args"]),
          },
          { spanId: typeof p["id"] === "string" && p["id"] ? `tool-start-${String(p["id"])}` : mintSpanId() },
        );
        break;
      }
      case "TOOL_FINISHED": {
        // §10.3/§10.4 — persist the tool FINISH span. `ok`/`error` status, so the
        // stats builder counts it as one completed tool call (and an error when it
        // closed `error`, §10.14). A `bumpToolError` is NOT done here: the error
        // is counted from the finish span by the stats builder, and the live
        // `SessionStats` already tracks errors via the write path for callback
        // spans; an event-sourced finish keeps the trail the source of truth.
        const name = String(p["name"] ?? "");
        const status: ObsStatus = p["status"] === "error" ? "error" : "ok";
        const durationMs = num(p["durationMs"]);
        if (status === "error") this.bumpToolError(sessionId);
        map(
          "tool",
          status,
          name || "tool",
          {
            ...(p["id"] !== undefined ? { toolCallId: p["id"] } : {}),
            // A short result summary (already capped by the emitter to ~500 chars);
            // bound again here so the trail record can never grow unbounded.
            ...(p["summary"] !== undefined ? { summary: boundString(String(p["summary"])) } : {}),
          },
          {
            ...(durationMs > 0 ? { durationMs } : {}),
            spanId: typeof p["id"] === "string" && p["id"] ? `tool-finish-${String(p["id"])}` : mintSpanId(),
          },
        );
        break;
      }
      case "MODEL_ERROR": {
        // §10.3/§10.4/§11.9 — persist a model REQUEST span per failed attempt so
        // the retry history (model name, attempt number, retryable, whether a
        // retry followed) is reconstructable from disk. Named `model.request` and
        // carrying NO `usage`, so the stats builder never counts it toward tokens
        // or turns — `model.usage` stays the single source for token totals
        // (§10.14). A `willRetry` attempt is `pending`; the terminal failure is
        // `error`.
        const willRetry = p["willRetry"] === true;
        map(
          "model",
          willRetry ? "pending" : "error",
          "model.request",
          {
            ...(p["code"] !== undefined ? { code: p["code"] } : {}),
            ...(p["message"] !== undefined ? { message: boundString(String(p["message"])) } : {}),
            attempt: num(p["attempt"]),
            ...(p["maxRetries"] !== undefined ? { maxRetries: num(p["maxRetries"]) } : {}),
            retryable: p["retryable"] === true,
            willRetry,
          },
          { model: { name: String(p["name"] ?? "model"), protocol: String(p["protocol"] ?? "openai") } },
        );
        break;
      }
      case "PERMISSION_REQUESTED":
      case "PERMISSION_RESOLVED":
      case "PERMISSION_DENIED": {
        // An approval record ALWAYS carries the full action at every level (§10.2).
        map(
          "guardian",
          e.type === "PERMISSION_DENIED" ? "error" : "pending",
          e.type.toLowerCase(),
          {
            decision: e.type === "PERMISSION_DENIED" ? "deny" : (p["decision"] ?? "ask"),
            tool: p["tool"] ?? p["action"] ?? "",
            action: {
              tool: p["tool"] ?? p["action"] ?? "",
              // §9.5/§14.6 — a denial carries the masked `target` (the command or
              // path), so a denied row shows what was denied instead of `null`.
              args: p["args"] ?? p["command"] ?? (p["target"] !== undefined ? { target: p["target"] } : null),
            },
            ...(p["target"] !== undefined ? { target: p["target"] } : {}),
            ...(p["rule"] !== undefined ? { matchedRule: p["rule"] } : {}),
            ...(p["version"] !== undefined ? { policyVersion: p["version"] } : {}),
            ...(p["reason"] !== undefined ? { reason: p["reason"] } : {}),
            // §9.5 — a `auto_approve` auto-approval carries its resolver so the
            // audit record shows the human step was removed by the host mode.
            ...(p["resolver"] !== undefined ? { resolver: p["resolver"] } : {}),
          },
        );
        break;
      }
      case "COMPLIANCE_VIOLATION":
      case "COMPLIANCE_BLOCKED": {
        map("warden", e.type === "COMPLIANCE_BLOCKED" ? "error" : "ok", e.type.toLowerCase(), {
          action: { tool: p["action"] ?? "", args: p["args"] ?? null },
          ...(p["rule"] !== undefined ? { matchedRule: p["rule"] } : {}),
          ...(p["version"] !== undefined ? { policyVersion: p["version"] } : {}),
        });
        break;
      }
      case "WORKER_STATUS_CHANGED":
        map("worker", "ok", "worker.status", { worker: p["workerId"] ?? p["id"] ?? "", to: p["status"] ?? "" });
        break;
      case "MEMORY_SAVED":
        map("memory", "ok", "memory.saved", { id: p["id"] ?? "" });
        break;
      case "SKILL_LOADED":
        map("skill", "ok", "skill.loaded", { name: p["name"] ?? "" });
        break;
      case "PLUGIN_LOADED":
        // §12.4.1 — a plugin loaded from a config layer (info level). Records the
        // id and the layer so a project-layer plugin load is visible in the trail.
        map("plugin", "ok", "plugin.loaded", { id: p["id"] ?? "", layer: p["layer"] ?? "" });
        break;
      case "SESSION_MODE_CHANGED":
        // §2.7/§14.6 — every accepted conversation-mode change writes an audit
        // record (masked like any other, §10.10) so a `vibe` entry/exit is
        // auditable; `from`/`to` are `chat | research | vibe`.
        map("session", "ok", "session.mode_changed", { from: p["from"] ?? "", to: p["to"] ?? "" });
        break;
      case "ERROR_OCCURRED":
        map("error", "error", "error", { source: p["source"] ?? "", message: p["message"] ?? "" });
        break;
      case "WARNING_EMITTED":
        // §10.6/§14.6 — persist every emitted warning/notice to the `info` trail
        // so a suggestion, surprise, read-lane or true warning is auditable from
        // disk. The payload is already masked when written (§10.10); it carries
        // the human `message` plus `category`/`source`/`pattern?`/`count?`.
        map("session", "ok", "warning", {
          category: p["category"] ?? "",
          source: p["source"] ?? "",
          ...(p["message"] !== undefined ? { message: boundString(String(p["message"])) } : {}),
          ...(p["pattern"] !== undefined ? { pattern: p["pattern"] } : {}),
          ...(p["count"] !== undefined ? { count: p["count"] } : {}),
          ...(p["outcome"] !== undefined ? { outcome: p["outcome"] } : {}),
        });
        break;
      case "INGEST":
        // §8.7/§14.6 — an oversized source was ingested by fan-out to a
        // line-anchored digest (or served from cache). The record carries the
        // source, the kind, the input/available token figures, the chunk count,
        // the cache-hit flag, and the triggering `limits.ingest.*` key; never any
        // content (the digest is the tool result, the full copy stays on disk).
        map("session", "ok", "ingest", {
          source: boundString(String(p["source"] ?? "")),
          ...(p["kind"] !== undefined ? { kind: p["kind"] } : {}),
          ...(p["inputTokens"] !== undefined ? { inputTokens: num(p["inputTokens"]) } : {}),
          ...(p["available"] !== undefined ? { available: num(p["available"]) } : {}),
          ...(p["chunks"] !== undefined ? { chunks: num(p["chunks"]) } : {}),
          cacheHit: p["cacheHit"] === true,
          ...(p["key"] !== undefined ? { key: p["key"] } : {}),
        });
        break;
      case "BY_REFERENCE":
        // §7.2/§8.7/§14.6 — a task brief, dependency summary, or batch result was
        // passed by reference (full text in the run cache, handle to the receiver)
        // rather than clipped. The record names what, its byte size, and the
        // triggering `limits.task.*` key; never the content itself.
        map("session", "ok", "by_reference", {
          ...(p["what"] !== undefined ? { what: p["what"] } : {}),
          ...(p["bytes"] !== undefined ? { bytes: num(p["bytes"]) } : {}),
          ...(p["key"] !== undefined ? { key: p["key"] } : {}),
        });
        break;
      default:
        break;
    }
  }

  // ── the one write path (mask → store → analyze → export → tail) ─────────────

  /** Schedule a best-effort write, tracked so a clean shutdown can drain it.
   * After `close()` has begun, a record is refused DELIBERATELY (§10.3, §14.3):
   * nothing may touch the filesystem once shutdown has stopped accepting records,
   * so a post-close event cannot re-create a torn-down workspace. */
  private schedule(record: ObsRecord): void {
    if (this.closed) return;
    const p = this.write(record).finally(() => void this.inflight.delete(p));
    this.inflight.add(p);
  }

  private async write(record: ObsRecord): Promise<void> {
    const masked = maskRecord(record);
    const line = JSON.stringify(masked);

    // §10.7 — a tool span that closed `error` bumps SessionStats.toolCalls.errors
    // (tool spans arrive via the callback handler, not an event, so count here).
    if (masked.source === "tool" && masked.status === "error") {
      this.bumpToolError(masked.traceId);
    }

    // §10.14/§11.9 — keep the records the live session report is built from in
    // memory (model.usage + terminal tool spans), so the report is honest even
    // when the on-disk trail write is best-effort. Bounded per session.
    if (
      (masked.source === "model" && masked.name === "model.usage") ||
      (masked.source === "tool" && (masked.status === "ok" || masked.status === "error"))
    ) {
      const ring = this.statsRecords.get(masked.traceId) ?? [];
      ring.push(masked);
      const cap = this.deps.getStatsRecordCap ? this.deps.getStatsRecordCap() : STATS_RECORD_CAP;
      if (ring.length > cap) ring.shift();
      this.statsRecords.set(masked.traceId, ring);
    }

    // Trace analysis (§10.6) — signal a recurring failure shape once.
    this.analyze(masked);

    // Persist (§10.3). Best-effort: a store failure is swallowed, never thrown.
    try {
      await this.deps.store.appendWorkspace(masked.traceId, line);
      if (masked.status === "error") {
        await this.deps.store.appendGlobal(masked.traceId, line);
      }
    } catch (e) {
      // Logged once by the store adapter; swallowed here (§10.3).
      void e;
    }

    // Export (§10.8) — each exporter is isolated; a thrower never stops the
    // trail. The failure is reported OUT OF BAND (never through the event bus):
    // the writer subscribes to the bus, so emitting an error event here would be
    // re-consumed, re-exported, and re-thrown — an unbounded recursion. A plain
    // warning sink breaks that cycle (§10.8).
    for (const exp of this.deps.exporters?.() ?? []) {
      try {
        await exp.export(masked);
      } catch (e) {
        this.deps.onError?.(`obs exporter threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Live tail (§10.5).
    for (const t of this.tails) {
      try {
        if (t.predicate(masked)) t.emit(masked);
      } catch {
        /* a bad tail consumer is isolated */
      }
    }
  }

  private analyze(record: ObsRecord): void {
    let a = this.analyzers.get(record.traceId);
    if (!a) {
      a = new TraceAnalyzer(this.deps.getSuggestionThreshold());
      this.analyzers.set(record.traceId, a);
    }
    const hit = a.observe(record);
    if (hit) {
      // The analyzer only SIGNALS; the §6.7 suggestions flow consumes it (§10.6).
      // Every payload carries a human `message` (§14.6) so a view never shows the
      // bare category word; it names the failing tool by its DISPLAY name.
      this.deps.bus.emit(
        "WARNING_EMITTED",
        {
          category: "suggestion",
          source: "trace-analyzer",
          pattern: hit.pattern,
          count: hit.count,
          message: traceAnalyzerMessage(hit.pattern, hit.count),
        },
        { session: record.traceId },
      );
      // §6.7/§10.6 — queue a repeated-FAILURE candidate for a boundary-/idle-time
      // DRAFT (the model-free analyzer only records). The error class is the
      // triggering record's error message/decision reason (bounded, masked on
      // write); a few recent masked spans ride as redacted argument evidence.
      if (this.deps.onFailureSignal) {
        const errorClass =
          record.source === "guardian"
            ? String(record.attributes["reason"] ?? record.attributes["decision"] ?? "denied")
            : String(record.attributes["errorClass"] ?? record.status ?? "error");
        const examples = (this.recentSpans.get(record.traceId) ?? []).slice(-SEQUENCE_EXAMPLE_SPANS);
        const q = this.failureQueue.get(record.traceId) ?? [];
        q.push({ pattern: hit.pattern, count: hit.count, errorClass, examples });
        const queueCap = this.deps.getSequenceQueueCap ? this.deps.getSequenceQueueCap() : SEQUENCE_QUEUE_CAP;
        while (q.length > queueCap) q.shift();
        this.failureQueue.set(record.traceId, q);
      }
    }

    // §10.6 — repeated-sequence detection beside the failure-shape watch, over
    // the SAME masked `info` trail, mechanical and model-free. Keep a bounded
    // ring of recent masked spans so a raised sequence can carry example spans.
    const ring = this.recentSpans.get(record.traceId) ?? [];
    ring.push(record);
    if (ring.length > SEQUENCE_SPAN_RING) ring.shift();
    this.recentSpans.set(record.traceId, ring);

    let seq = this.sequencers.get(record.traceId);
    if (!seq) {
      seq = new SequenceDetector(
        this.deps.getSuggestionThreshold(),
        this.deps.getSequenceMaxLen?.() ?? DEFAULT_SEQUENCE_MAX_LEN,
        record.traceId,
        this.deps.getSequenceCaps?.(),
      );
      this.sequencers.set(record.traceId, seq);
    }
    // §10.6 — the detector buffers qualifying windows per turn and emits only the
    // MAXIMAL set at the turn boundary (so a shorter sub-window that closed on an
    // earlier record never pre-empts the maximal procedure). `observe` therefore
    // returns nothing; the signals are drained by `flushSequenceSignals` when the
    // turn is settled (from `beginSequenceTurn` for the prior turn, and from
    // `drainSequenceCandidates` for the final turn).
    seq.observe(record);
  }

  /** Emit the maximal repeated-sequence signals buffered for a settled turn
   * (§10.6) and queue each for a boundary-/idle-time DRAFT. Called when a turn is
   * settled, never mid-turn. Best-effort and idempotent per flush. */
  private flushSequenceSignals(sessionId: string): void {
    const seq = this.sequencers.get(sessionId);
    if (!seq) return;
    for (const signal of seq.flushTurnSignals()) {
      // Emit the signal event (every payload carries a human `message`, §14.6);
      // the CLI renders it as a dim `ℹ` info line, not a `⚠` warning. The
      // detector only RECORDS a candidate here — the model-call DRAFT runs later,
      // at the session boundary or when idle (§6.7, never mid-turn), via
      // `drainSequenceCandidates`.
      this.deps.bus.emit(
        "WARNING_EMITTED",
        {
          category: "suggestion",
          source: "sequence-detector",
          pattern: signal.pattern,
          count: signal.count,
          outcome: signal.outcome,
          message: signal.message,
        },
        { session: sessionId },
      );
      // Queue the candidate (full signal + a few masked example spans) for a
      // boundary-/idle-time draft. Bounded; oldest dropped first.
      if (this.deps.onSequenceSignal) {
        const examples = (this.recentSpans.get(sessionId) ?? []).slice(-SEQUENCE_EXAMPLE_SPANS);
        const q = this.sequenceQueue.get(sessionId) ?? [];
        q.push({ signal, examples });
        const queueCap = this.deps.getSequenceQueueCap ? this.deps.getSequenceQueueCap() : SEQUENCE_QUEUE_CAP;
        while (q.length > queueCap) q.shift();
        this.sequenceQueue.set(sessionId, q);
      }
    }
  }

  /**
   * Draft every recorded repeated-sequence candidate for a session (§6.7/§10.6)
   * — the model call the detector deferred. Called at the session boundary or
   * when the session is IDLE (no active turn), NEVER mid-turn: the caller (the
   * facade) gates this on the turn being settled. Drains the queue ONE candidate
   * at a time, best-effort — a draft failure is swallowed and the candidate
   * dropped. Re-entrancy-safe: a second drain for the same session while one is
   * in flight is a no-op. An undrafted candidate (drain not yet reached) carries
   * forward until the next idle/boundary drain or `clearSequenceCandidates`.
   */
  async drainSequenceCandidates(sessionId: string): Promise<void> {
    // Flush the current (final) turn's buffered maximal signals first (§10.6), so
    // the WARNING is emitted when the turn settles even when no draft consumer is
    // wired; then (if a consumer exists) draft the queued candidates.
    this.flushSequenceSignals(sessionId);
    const consume = this.deps.onSequenceSignal;
    const consumeFailure = this.deps.onFailureSignal;
    if ((!consume && !consumeFailure) || this.draining.has(sessionId)) return;
    this.draining.add(sessionId);
    try {
      if (consume) {
        for (;;) {
          const q = this.sequenceQueue.get(sessionId);
          const next = q?.shift();
          if (!next) break;
          try {
            await consume(next.signal, next.examples);
          } catch {
            /* best-effort; a drafting miss never disturbs the write path (§6.7) */
          }
        }
      }
      // §6.7/§10.6 — drain repeated-FAILURE candidates into memory-note drafts.
      if (consumeFailure) {
        for (;;) {
          const q = this.failureQueue.get(sessionId);
          const next = q?.shift();
          if (!next) break;
          try {
            await consumeFailure({ pattern: next.pattern, count: next.count, errorClass: next.errorClass }, next.examples);
          } catch {
            /* best-effort (§6.7) */
          }
        }
      }
    } finally {
      this.draining.delete(sessionId);
      this.sequenceQueue.delete(sessionId);
      this.failureQueue.delete(sessionId);
    }
  }

  /** Mark a new live turn on a session's detector (§10.6 per-turn accounting):
   * resets the per-turn signal cap and advances the turn id so a sequence
   * repeated across turns counts toward the "three distinct turns" qualifier.
   * Called by the facade when a turn starts. */
  beginSequenceTurn(sessionId: string): void {
    // Flush the PRIOR turn's buffered maximal signals before starting a new turn
    // (§10.6): a turn's signals are known only once the turn ends.
    this.flushSequenceSignals(sessionId);
    this.sequencers.get(sessionId)?.beginTurn();
  }

  /** Drop a session's recorded-but-undrafted candidates (§6.7): called on
   * `setMode` and session `clear` so a mode switch never drafts stale work. */
  clearSequenceCandidates(sessionId: string): void {
    this.sequencers.get(sessionId)?.discardTurnSignals();
    this.sequenceQueue.delete(sessionId);
  }

  /**
   * Seed this session's sequence detector from the SAME workspace's prior
   * sessions (cross-session counting, §10.6). Call once at the session boundary
   * before live observation. Reads the most recent `SEQUENCE_PRIOR_SESSIONS`
   * prior trails lazily; a trail that cannot be read is logged and skipped —
   * never fatal. Idempotent per session.
   */
  async seedSequencesFromPriorSessions(sessionId: string, workspace?: string): Promise<void> {
    if (this.seeded.has(sessionId)) return;
    this.seeded.add(sessionId);
    const maxLen = this.deps.getSequenceMaxLen?.() ?? DEFAULT_SEQUENCE_MAX_LEN;
    let seq = this.sequencers.get(sessionId);
    if (!seq) {
      seq = new SequenceDetector(this.deps.getSuggestionThreshold(), maxLen, sessionId, this.deps.getSequenceCaps?.());
      this.sequencers.set(sessionId, seq);
    }
    // §10.6 Lifecycle — suppress every signature that already has a pending/
    // approved suggestion or was rejected for this workspace, so a procedure
    // already surfaced or declined never re-signals (within or across sessions).
    // Best-effort and independent of the prior-session trail seeding below.
    if (this.deps.getSuppressedSignatures) {
      try {
        for (const sig of await this.deps.getSuppressedSignatures()) seq.suppressSignature(sig);
      } catch (e) {
        this.deps.onError?.(`obs sequence seed: suppressed signatures failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!this.deps.sessions) return;
    let metas: Awaited<ReturnType<SessionRepository["list"]>>;
    try {
      metas = await this.deps.sessions.list();
    } catch (e) {
      this.deps.onError?.(`obs sequence seed: session list failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const prior = metas
      .filter((m) => m.id !== sessionId && (workspace === undefined || m.workspace === workspace))
      .slice(0, this.deps.getSequencePriorSessions ? this.deps.getSequencePriorSessions() : SEQUENCE_PRIOR_SESSIONS); // list() is newest-active first (§2.4)
    for (const m of prior) {
      try {
        const lines = await this.deps.store.readWorkspace(m.id);
        const records: ObsRecord[] = [];
        for (const l of lines) {
          try {
            records.push(JSON.parse(l) as ObsRecord);
          } catch {
            /* skip a corrupt line */
          }
        }
        // readWorkspace is newest-first; replay oldest-first so sequences form
        // in trail order.
        for (const sig of windowsFromRecords(records.reverse(), maxLen)) {
          seq.seedPrior(sig, m.id);
        }
      } catch (e) {
        // Best-effort: one unreadable prior session never breaks the boundary.
        this.deps.onError?.(`obs sequence seed: session ${m.id} unreadable: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // ── query and tail (§10.5) ──────────────────────────────────────────────────

  /** Point-in-time read of the persisted session trail (§10.5). */
  async query(
    sessionId: string,
    filter?: string,
    opts?: { limit?: number; since?: string },
  ): Promise<Result<ObsRecord[]>> {
    const lines = await this.deps.store.readWorkspace(sessionId);
    const records: ObsRecord[] = [];
    for (const l of lines) {
      try {
        records.push(JSON.parse(l) as ObsRecord);
      } catch {
        /* skip a corrupt line */
      }
    }
    return queryRecords(records, filter, opts);
  }

  /** A live subscription emitting each new masked record matching `filter` (§10.5). */
  tail(filter: string | undefined, emit: (r: ObsRecord) => void): Result<() => void> {
    const parsed = parseFilter(filter);
    if (!parsed.ok) return parsed;
    const sub: TailSub = {
      predicate: (r) => applyFilter(parsed.value, [r]).length > 0,
      emit,
    };
    this.tails.add(sub);
    return ok(() => void this.tails.delete(sub));
  }

  // ── SessionStats (§10.3, §10.7) ──────────────────────────────────────────────

  private ensureStats(sessionId: string): SessionStats {
    let s = this.stats.get(sessionId);
    if (!s) {
      s = emptyStats();
      this.stats.set(sessionId, s);
    }
    return s;
  }

  private bumpTokens(
    sessionId: string,
    usage: TokenUsage | undefined,
    cost: number | undefined,
    extra?: { cacheRead?: number; wallMs?: number },
  ): void {
    const s = this.ensureStats(sessionId);
    if (usage) {
      s.tokensIn += usage.inputTokens;
      s.tokensOut += usage.outputTokens;
    }
    if (extra?.cacheRead) s.tokensCacheRead += extra.cacheRead;
    if (extra?.wallMs) s.wallMs += extra.wallMs;
    if (cost !== undefined) s.cost = (s.cost ?? 0) + cost;
    this.recomputeAverages(s);
  }

  /** Count a tool span that closed `error` (§10.7) — `total` is bumped on
   * `TOOL_STARTED`, so this increments `errors` only, never inflating `total`. */
  private bumpToolError(sessionId: string): void {
    const s = this.ensureStats(sessionId);
    s.toolCalls.errors += 1;
  }

  private bumpTurn(sessionId: string): void {
    const s = this.ensureStats(sessionId);
    s.turns += 1;
    this.recomputeAverages(s);
  }

  private bumpTool(sessionId: string, name: string): void {
    const s = this.ensureStats(sessionId);
    s.toolCalls.total += 1;
    s.toolCalls.perTool[name] = (s.toolCalls.perTool[name] ?? 0) + 1;
    this.recomputeAverages(s);
  }

  private recomputeAverages(s: SessionStats): void {
    const t = s.turns || 1;
    s.averages = {
      tokensPerTurn: Math.round((s.tokensIn + s.tokensOut) / t),
      toolCallsPerTurn: Math.round(s.toolCalls.total / t),
      // §10.7 — msPerTurn is derived from the summed measured wall-clock.
      msPerTurn: Math.round(s.wallMs / t),
    };
  }
}

/** Normalize an event's usage payload into TokenUsage (events carry varied shapes). */
function normalizeUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  // §10.7 — a turn's REPORTED input is the SUM across every model call
  // (`inputSum`); fall back to the peak `promptTokens`/`inputTokens` only when a
  // producer sent no sum. The peak stays on the raw payload for the context
  // meter; stats and cost use the summed input.
  const inputTokens = num(u["inputSum"] ?? u["inputTokens"] ?? u["promptTokens"] ?? u["input_tokens"]);
  const outputTokens = num(u["outputTokens"] ?? u["completionTokens"] ?? u["output_tokens"]);
  if (inputTokens === 0 && outputTokens === 0 && u["totalTokens"] === undefined) return undefined;
  const totalTokens = num(u["totalTokens"] ?? u["total_tokens"]) || inputTokens + outputTokens;
  const cacheReadTokens = u["cacheReadTokens"] !== undefined ? num(u["cacheReadTokens"]) : undefined;
  const genMs = u["genMs"] !== undefined ? num(u["genMs"]) : undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(genMs !== undefined ? { genMs } : {}),
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Mask a record before it leaves the process (§10.10): the attribute bag,
 * input, and output are masked; correlation ids and usage are structural and
 * never secret-bearing, so they pass through. */
export function maskRecord(record: ObsRecord): ObsRecord {
  return {
    ...record,
    attributes: maskValue(record.attributes) as Record<string, unknown>,
    ...(record.input !== undefined ? { input: maskValue(record.input) } : {}),
    ...(record.output !== undefined ? { output: maskValue(record.output) } : {}),
  };
}

/**
 * The human WARNING_EMITTED `message` for a trace-analyzer suggestion (§10.6,
 * §14.6): one sentence naming the repeated failure shape by the tool's DISPLAY
 * name, no secrets, no literal values. The shape is `tool_error:<name>` (a tool
 * repeatedly failing) or `guardian_block:<tool>` (a tool repeatedly denied).
 */
export function traceAnalyzerMessage(pattern: string, count: number): string {
  const colon = pattern.indexOf(":");
  const kind = colon >= 0 ? pattern.slice(0, colon) : pattern;
  const tool = colon >= 0 ? pattern.slice(colon + 1) : "";
  const display = toolDisplayName(tool);
  if (kind === "guardian_block") {
    return `Repeated block: ${display} was denied ${count}× — a guard or a different approach may help; review with /memory.`;
  }
  return `Repeated failure: ${display} failed ${count}× — a guard or a different approach may help; review with /memory.`;
}
