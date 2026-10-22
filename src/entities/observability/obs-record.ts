/**
 * The observability record and exporter contract (core-blueprint.md §10.1, §10.8).
 *
 * One neutral, correlated, LLM-aware record of everything the harness does. It
 * names no telemetry backend and holds NO LangChain type — the neutral record is
 * the entire contract an export plugin (§10.8) consumes. `traceId` is the session
 * id, so one session is one trace; `spanId`/`parentSpanId` come from the shared
 * `BaseCallbackHandler` (LangChain run ids) where a run exists, and are minted and
 * parented to the enclosing span where no LangChain run exists (§10.1, §10.4).
 */

/** Token accounting carried on every model span at every level (§10.1, §10.7). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  /** Generation time (ms) from the span's first streamed token to its last, so
   * prompt processing, waiting and tool execution are excluded (§10.7); absent
   * when the call was not streamed or the time is unmeasurable. */
  genMs?: number;
}

/** The source capability that produced a span (§10.1). */
export type ObsSource =
  | "user"
  | "model"
  | "tool"
  | "guardian"
  | "warden"
  | "session"
  | "worker"
  | "memory"
  | "skill"
  | "plugin"
  | "workspace"
  | "mcp"
  | "reflection"
  | "error";

/** The detail band a record was recorded at (§10.2). */
export type ObsSeverity = "info" | "verbose" | "debug";

/** The lifecycle status of a span (§10.1). */
export type ObsStatus = "ok" | "error" | "pending";

/** The neutral observability record (§10.1). No LangChain type appears here. */
export interface ObsRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  timestamp: string;
  durationMs?: number;
  status: ObsStatus;
  source: ObsSource;
  name: string;
  severity: ObsSeverity;
  attributes: Record<string, unknown>;
  model?: { name: string; protocol: string };
  input?: unknown;
  output?: unknown;
  usage?: TokenUsage;
}

/**
 * The exporter contract (§10.8). An export plugin registers through
 * `register.exporter` and receives each `ObsRecord` as it is written — already
 * masked (§10.10). The core holds no OTel/Langfuse dependency; the neutral
 * record is the whole contract. A throwing exporter is isolated (§10.8, §12).
 */
export interface ObsExporter {
  export(record: ObsRecord): void | Promise<void>;
  flush?(): Promise<void>;
}

/** `info ⊂ verbose ⊂ debug` — a record at `recorded` is kept when the active
 * level is at or above it. Correlation and usage are present at every level,
 * independent of this ordering (§10.2). */
const RANK: Record<ObsSeverity, number> = { info: 0, verbose: 1, debug: 2 };

/** True when a record recorded at `recorded` is kept at the active `level`. */
export function levelIncludes(level: ObsSeverity, recorded: ObsSeverity): boolean {
  return RANK[level] >= RANK[recorded];
}
