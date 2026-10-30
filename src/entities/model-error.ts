/**
 * Model-error classification (core-blueprint.md §3.6, §11.9).
 *
 * A pure function that maps a thrown provider error to the `MODEL_ERROR` fields
 * `{ code, retryable }` the engine's retry seam reports per attempt. `code` is a
 * free-string classification (not a closed enum, §11.9): `timeout`,
 * `rate_limited`, `auth`, `server`, `network`, or `unknown`.
 *
 * A connection refusal (`ECONNREFUSED`, surfaced by the provider SDK as an
 * `APIConnectionError`/`fetch failed` with an `ECONNREFUSED` cause) is a `network`
 * failure classified NON-retryable: it is not a transient timeout, and retrying a
 * refused connect only wastes the retry budget's backoff — it must fail fast in
 * seconds, not minutes (§3.6). Genuinely transient failures (timeout, 429, 5xx)
 * stay retryable within `networkModelMaxRetries`.
 */

export interface ModelErrorClass {
  code: string;
  retryable: boolean;
}

/** The first numeric HTTP `status` found anywhere in the cause chain, else
 * undefined. The agent framework wraps provider errors in `MiddlewareError`s,
 * so the status that classifies a failure can be several levels deep. */
function findStatus(err: unknown): number | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 8; depth++) {
    const e = cur as { status?: unknown; cause?: unknown };
    if (typeof e.status === "number") return e.status;
    cur = e.cause;
  }
  return undefined;
}

/** The first recognizable provider error-class name in the cause chain (e.g.
 * `AuthenticationError`, `RateLimitError`, `APITimeoutError`), else "". A
 * `MiddlewareError` wrapper is skipped in favor of the real provider error. */
function findErrorName(err: unknown): string {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 8; depth++) {
    const e = cur as { name?: unknown; constructor?: { name?: string }; cause?: unknown };
    // Prefer an explicit, non-generic `name` (`RateLimitError`), then a
    // non-generic constructor name; skip the `MiddlewareError`/`Error` wrappers.
    const explicit = typeof e.name === "string" ? e.name : "";
    const ctor = e.constructor?.name ?? "";
    const generic = (n: string): boolean => n === "" || n === "MiddlewareError" || n === "Error";
    if (!generic(explicit)) return explicit;
    if (!generic(ctor)) return ctor;
    cur = e.cause;
  }
  return "";
}

/** The deepest non-empty message in the cause chain — the provider's own
 * message, not the generic wrapper text. Falls back to the outermost message. */
function findMessage(err: unknown): string {
  let cur: unknown = err;
  let last = "";
  for (let depth = 0; cur && depth < 8; depth++) {
    const e = cur as { message?: unknown; cause?: unknown };
    if (typeof e.message === "string" && e.message) last = e.message;
    cur = e.cause;
  }
  return last;
}

/** Does any error in the cause chain carry a connection-refused signal? */
function hasConnRefused(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 8; depth++) {
    const e = cur as { code?: unknown; errno?: unknown; errors?: unknown; cause?: unknown };
    if (e.code === "ECONNREFUSED" || e.errno === "ECONNREFUSED") return true;
    // An AggregateError (Node fetch) nests the socket errors under `errors`.
    if (Array.isArray(e.errors) && e.errors.some((inner) => hasConnRefused(inner))) return true;
    cur = e.cause;
  }
  return false;
}

/** Classify a thrown provider/stream error into `{ code, retryable }` (§11.9). */
export function classifyModelError(err: unknown): ModelErrorClass {
  const e = (err ?? {}) as {
    name?: string;
    status?: number;
    code?: string;
    message?: string;
    constructor?: { name?: string };
  };
  // The agent framework (LangGraph/deepagents) re-wraps a provider error in one
  // or more `MiddlewareError`s, so the HTTP `status` and the provider error
  // CLASS (`AuthenticationError`, `RateLimitError`, …) live DOWN the `cause`
  // chain, not on the top-level error. Walk the chain for both — otherwise a
  // retryable 5xx or a typed 401/429 is misread as `unknown`/non-retryable and
  // the user sees a bare, unclassified message (the gx10 502 symptom).
  const status = findStatus(err);
  const name = findErrorName(err) || e.constructor?.name || e.name || "";
  const message = findMessage(err) || String(e.message ?? "");

  // A refused connection fails fast and is never retried (§3.6).
  if (hasConnRefused(err)) return { code: "network", retryable: false };

  // HTTP status classification (OpenAI/Anthropic/Google error shapes carry it).
  if (status === 401 || status === 403 || name === "AuthenticationError") {
    return { code: "auth", retryable: false };
  }
  if (status === 429 || name === "RateLimitError") return { code: "rate_limited", retryable: true };
  if (status !== undefined && status >= 500) return { code: "server", retryable: true };
  if (status !== undefined && status >= 400) return { code: "client", retryable: false };

  // Timeouts and generic connection errors are retryable within the budget.
  if (name === "APITimeoutError" || /timeout|timed out/i.test(message) || e.code === "ETIMEDOUT") {
    return { code: "timeout", retryable: true };
  }
  if (name === "APIConnectionError" || /connection error|fetch failed|network/i.test(message)) {
    // A generic connection error with no ECONNREFUSED signal (e.g. DNS/reset) is
    // transient and retryable; a refused connect was already caught above.
    return { code: "network", retryable: true };
  }
  return { code: "unknown", retryable: false };
}

/**
 * The harness-owned FIRST-BYTE WATCHDOG allowance (core-blueprint.md §11.5).
 *
 * Only OpenAI's client exposes a per-call timeout, so VoidRift owns a portable
 * watchdog that bounds the FIRST streamed token for every provider identically.
 * `networkModelTimeout` (the floor) plus 2 seconds per 1,000 estimated input
 * tokens of the request (the §4.8 estimate), capped at five times the floor. The
 * two constants are INTERNAL (not config keys): measured over >1,000 real calls
 * (60k+-token requests had a 73 s median first byte, 309 s max). The client
 * constructor timeout is set to the 5× cap so the SDK timeout never fires first.
 */
export const WATCHDOG_MS_PER_1K_TOKENS = 2000;
/** The watchdog allowance ceiling as a multiple of the `networkModelTimeout`
 * floor (§11.5). Internal constant; also the client constructor timeout. */
export const WATCHDOG_CAP_MULTIPLE = 5;

/**
 * The effective first-byte allowance for one request (§11.5): the floor plus
 * 2 s per 1,000 estimated input tokens, capped at 5× the floor. PURE.
 */
export function watchdogAllowanceMs(floorMs: number, estimatedInputTokens: number): number {
  const tokens = Math.max(0, estimatedInputTokens);
  const raised = floorMs + WATCHDOG_MS_PER_1K_TOKENS * (tokens / 1000);
  return Math.min(raised, floorMs * WATCHDOG_CAP_MULTIPLE);
}
