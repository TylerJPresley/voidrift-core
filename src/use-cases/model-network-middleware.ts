/**
 * The ONE shared model-network middleware (core-blueprint.md §11.5, §3.6, §7.2).
 *
 * `wrapModelCall` that both RETRIES a retryable model failure within the budget
 * and enforces a harness-owned FIRST-BYTE WATCHDOG. One implementation serves the
 * orchestrator, every worker and the internal reviewer (§11.5, §7.2) so no call
 * site reimplements retry or timeout — the provider SDK's own per-call timeout is
 * only exposed by OpenAI, so VoidRift owns a portable watchdog that works for
 * every provider.
 *
 * Watchdog (§11.5): per attempt, a timer is armed for the request's effective
 * allowance (`networkModelTimeout` floor + 2 s per 1,000 estimated input tokens,
 * capped at 5× the floor) and DISARMED by the first streamed token via a
 * `handleLLMNewToken` callback (not an ad-hoc event). On fire the attempt is
 * aborted through its OWN `AbortController` (combined with the turn signal) and a
 * typed RETRYABLE `FirstByteTimeoutError` is raised — distinct from an
 * `AbortError`, so the retry loop re-issues it while a deliberate user cancel is
 * NEVER retried (invariant 26, no failover, untouched).
 */
import { createMiddleware } from "langchain";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { BaseMessage } from "@langchain/core/messages";
import { classifyModelError, watchdogAllowanceMs } from "../entities/model-error.js";
import type { EventBus } from "../entities/event-bus.js";

/**
 * A sentinel thrown by the model-network middleware when a model call has
 * definitively failed (budget exhausted or non-retryable) AND the middleware has
 * already emitted `MODEL_ERROR`. It tells the caller (`runTurn`, a worker invoke)
 * to end `failed` without emitting a second, engine-sourced `ERROR_OCCURRED`
 * (§3.6, §11.9).
 */
export class ModelCallFailed extends Error {
  /** A stable marker so a LangGraph-wrapped instance is still recognizable. */
  readonly isModelCallFailed = true as const;
  constructor(message: string) {
    super(message);
    this.name = "ModelCallFailed";
  }
}

/**
 * A typed RETRYABLE error raised when the first-byte watchdog fires (§11.5). It
 * is deliberately NOT an `AbortError`: a user cancel aborts the turn signal and
 * is never retried, whereas a watchdog timeout is a transient first-byte stall
 * and IS retried within the budget. `classifyModelError` reads its `code` /
 * message as a retryable `timeout`.
 */
export class FirstByteTimeoutError extends Error {
  readonly isFirstByteTimeout = true as const;
  readonly code = "timeout" as const;
  constructor(allowanceMs: number) {
    super(`the model timed out: no first token within ${Math.round(allowanceMs)} ms (first-byte watchdog)`);
    this.name = "FirstByteTimeoutError";
  }
}

/** Is this error (or anything in its cause chain) a watchdog first-byte timeout? */
function isFirstByteTimeout(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 8; depth++) {
    const e = cur as { isFirstByteTimeout?: unknown; name?: unknown; cause?: unknown };
    if (e.isFirstByteTimeout === true || e.name === "FirstByteTimeoutError") return true;
    cur = e.cause;
  }
  return false;
}

/** True for a deliberate cancel (AbortError/TimeoutError), walking the cause
 * chain — but NEVER for the watchdog's typed timeout, which must stay retryable. */
function isAbortError(err: unknown): boolean {
  if (isFirstByteTimeout(err)) return false;
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 8; depth++) {
    const e = cur as { name?: unknown; message?: unknown; cause?: unknown };
    if (e.name === "AbortError" || e.name === "TimeoutError") return true;
    if (typeof e.message === "string" && /\baborted\b|the operation was aborted/i.test(e.message)) return true;
    cur = e.cause;
  }
  return false;
}

/**
 * A backoff sleep that wakes the instant the turn's shared `AbortSignal` fires
 * (§3.3/§5.2). Resolves after `ms`; rejects with an `AbortError` on cancel.
 * Always clears the timer and removes the listener so a cancel never leaks a
 * pending timer. An already-aborted signal rejects synchronously.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Combine the turn signal with the watchdog's own signal (§11.5). Returns the
 * turn signal alone when `AbortSignal.any` is unavailable or one side is absent. */
function combineSignals(turn: AbortSignal | undefined, watchdog: AbortSignal): AbortSignal {
  if (!turn) return watchdog;
  if ("any" in AbortSignal) return (AbortSignal as { any(s: AbortSignal[]): AbortSignal }).any([turn, watchdog]);
  return turn;
}

/** The subset of the middleware `request` the wrapper reads/rewrites. */
interface ModelCallRequest {
  model: unknown;
  messages?: BaseMessage[];
  runtime?: { signal?: AbortSignal };
}

/** Dependencies the shared middleware needs, supplied by the engine, by
 * `buildWorker` and by the internal reviewer so the retry/watchdog behaviour is
 * identical for all three (DRY, §11.5). */
export interface ModelNetworkMiddlewareDeps {
  /** The event bus (`MODEL_ERROR` is emitted here). */
  bus: EventBus;
  /** The display model name carried on `MODEL_ERROR`. */
  modelName: string;
  /** The session the `MODEL_ERROR` is scoped to (the worker's own id for a worker). */
  sessionId: string;
  /** `networkModelMaxRetries` for this call site (read live each attempt). */
  getMaxRetries: () => number;
  /** `networkModelTimeout` — the watchdog allowance FLOOR (read live each attempt). */
  getFloorMs: () => number;
  /** The §4.8 ratio-based estimate of a request's input tokens — drives the
   * watchdog allowance. The engine/worker thread the same estimate used by the
   * overflow guard; the default counts the request text at 4 chars/token. */
  estimateInputTokens: (messages: BaseMessage[]) => number;
  /** A tiny masking hook for the raw provider message on the egress (§10.10). */
  mask: (text: string) => string;
}

/**
 * Build the ONE shared model-network middleware (§11.5). Used by the engine's
 * orchestrator agent, by every `buildWorker` agent and by the internal reviewer,
 * so retry + first-byte watchdog + `MODEL_ERROR` behave identically everywhere.
 */
export function createModelNetworkMiddleware(deps: ModelNetworkMiddlewareDeps) {
  const { bus, modelName, sessionId, mask } = deps;
  return createMiddleware({
    name: "voidrift-model-network",
    wrapModelCall: async (request, handler) => {
      const req = request as unknown as ModelCallRequest;
      const maxRetries = Math.max(0, deps.getMaxRetries());
      // §3.3/§5.2 — the turn's single shared AbortSignal. A deliberate cancel
      // stops the retry loop AND its backoff immediately and is never retried.
      const turnSignal = req.runtime?.signal;
      const messages = req.messages ?? [];
      const estInput = deps.estimateInputTokens(messages);
      const allowance = watchdogAllowanceMs(deps.getFloorMs(), estInput);
      let attempt = 0;
      for (;;) {
        attempt += 1;
        if (turnSignal?.aborted) throw new DOMException("The operation was aborted", "AbortError");

        // §11.5 — arm this attempt's first-byte watchdog. A fresh controller per
        // attempt, combined with the turn signal, aborts the in-flight request
        // when the floor-plus-allowance elapses with no first token. The first
        // `handleLLMNewToken` DISARMS it.
        const watchdog = new AbortController();
        let fired = false;
        let disarmed = false;
        const timer = setTimeout(() => {
          if (disarmed) return;
          fired = true;
          watchdog.abort();
        }, allowance);
        const disarm = (): void => {
          if (disarmed) return;
          disarmed = true;
          clearTimeout(timer);
        };
        const callbacks = [FirstTokenWatchdog.create(disarm)];
        const combined = combineSignals(turnSignal, watchdog.signal);
        // Bind the combined signal + the disarm callback onto THIS attempt's
        // model (LangChain merges a bound signal with the call-time signal via
        // AbortSignal.any, so the watchdog abort reaches the provider fetch).
        const model = bindModel(req.model, combined, callbacks);

        try {
          const result = await handler({ ...(request as object), model } as typeof request);
          disarm();
          return result;
        } catch (e) {
          disarm();
          // The watchdog fired: the abort surfaces as an AbortError, but a
          // first-byte timeout is RETRYABLE — re-raise it as the typed error so
          // the loop treats it as a transient timeout (§11.5). A cancel during
          // the attempt (turn signal) is NOT retryable.
          const watchdogFired = fired && !turnSignal?.aborted;
          if (!watchdogFired && (isAbortError(e) || turnSignal?.aborted)) throw e;
          const err: unknown = watchdogFired ? new FirstByteTimeoutError(allowance) : e;
          const cls = classifyModelError(err);
          const willRetry = cls.retryable && attempt <= maxRetries;
          const rawMessage = err instanceof Error ? err.message : String(err);
          bus.emit(
            "MODEL_ERROR",
            {
              name: modelName,
              code: cls.code,
              // §10.10 — mask the raw provider body on this egress.
              message: mask(rawMessage),
              retryable: cls.retryable,
              attempt,
              willRetry,
              // `maxRetries` retries follow the first try; total = maxRetries + 1.
              maxRetries,
            },
            { session: sessionId },
          );
          if (!willRetry) {
            throw new ModelCallFailed(mask(rawMessage));
          }
          // Bounded, abortable exponential backoff with a low ceiling (§3.6).
          const delay = Math.min(1000 * 2 ** (attempt - 1), 4000);
          await abortableSleep(delay, turnSignal);
        }
      }
    },
  });
}

/** Bind a per-attempt signal + callbacks onto the model via `withConfig` (§11.5)
 * without reaching into a provider type. Falls back to the bare model when the
 * seam is a test fake with no `withConfig`. */
function bindModel(model: unknown, signal: AbortSignal, callbacks: BaseCallbackHandler[]): unknown {
  const m = model as { withConfig?: (c: Record<string, unknown>) => unknown };
  return typeof m?.withConfig === "function" ? m.withConfig({ signal, callbacks }) : model;
}

/**
 * The CallbackHandler that DISARMS the first-byte watchdog on the first streamed
 * token (§11.5). LangChain streaming chat models call `handleLLMNewToken` once
 * per chunk (see `@langchain/core` `dist/language_models/chat_models.js` —
 * `_streamResponseChunks` → `runManager?.handleLLMNewToken(...)`); the first call
 * clears the timer, so a model that starts streaming inside its allowance is
 * never cut, and a stream that keeps sending after the allowance is never cut.
 */
class FirstTokenWatchdog extends BaseCallbackHandler {
  name = "voidrift-first-byte-watchdog";
  private readonly onFirstToken: () => void;
  private constructor(onFirstToken: () => void) {
    super();
    this.onFirstToken = onFirstToken;
  }
  static create(onFirstToken: () => void): FirstTokenWatchdog {
    return new FirstTokenWatchdog(onFirstToken);
  }
  handleLLMNewToken(): void {
    this.onFirstToken();
  }
}
