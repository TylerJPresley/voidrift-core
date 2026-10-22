/**
 * The shared per-worker model-usage middleware spec (core-blueprint.md §10.14,
 * §10.7, §7.2).
 *
 * A dispatched worker (summarizer, researcher, implementer, …) runs its own
 * model calls inside its own fresh context. Those calls were previously invisible
 * to the trail — only `worker.status` landed in `orchestrator.log`, so
 * `voidrift stats` and `/stats` UNDERREPORTED fan-out cost and `byAgent` never
 * listed a worker. This `wrapModelCall` middleware captures each worker model
 * call's token usage and generation time and emits a `MODEL_USAGE` event onto the
 * bus with the PARENT session scope and `agent` = the worker name (plus `taskId`),
 * so the obs-writer persists it as a `model.usage` span attributed to the worker
 * and the §10.14 stats builder rolls it into the parent session totals AND the
 * `byAgent` bucket — without double-counting the orchestrator's own usage (each
 * worker call is a distinct span the orchestrator never emits for itself).
 *
 * Pure entity: it reads the response message's `usage_metadata` structurally
 * (never imports a LangChain type) and takes an emit callback + a clock, so it
 * carries no engine/worker coupling. The caller passes `createMiddleware`.
 */

/** The usage figures a single worker model call contributes (§10.7/§10.14). */
export interface WorkerUsage {
  /** Prompt (input) tokens the provider reported for this call. */
  promptTokens: number;
  /** Completion (output) tokens the provider reported for this call. */
  completionTokens: number;
  /** Cache-read tokens when the provider reports them. */
  cacheReadTokens: number;
  /** Generation time (ms) for this call (first-to-last token / wall fallback). */
  genMs: number;
  /** True when no provider usage was reported and the figures are the harness
   * estimate (a view marks the turn `~`). */
  estimated: boolean;
}

/** The structural view of the provider usage metadata LangChain attaches. */
interface UsageMetadataLike {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_token_details?: { cache_read?: number };
}

/** Pull `usage_metadata` off the model-call result (an AIMessage or a
 * `{ messages: [...] }` result), reading structurally so no library type
 * crosses this layer. Returns the summed usage across any assistant messages. */
export function extractUsageFromResult(result: unknown): {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  reported: boolean;
} {
  const messages = collectMessages(result);
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheReadTokens = 0;
  let reported = false;
  for (const m of messages) {
    const u = (m as { usage_metadata?: UsageMetadataLike }).usage_metadata;
    if (!u) continue;
    const input = u.input_tokens ?? 0;
    // The peak single-prompt input anchors the call's prompt size.
    if (input > promptTokens) promptTokens = input;
    completionTokens += u.output_tokens ?? 0;
    cacheReadTokens += u.input_token_details?.cache_read ?? 0;
    if ((u.input_tokens ?? 0) > 0 || (u.output_tokens ?? 0) > 0) reported = true;
  }
  return { promptTokens, completionTokens, cacheReadTokens, reported };
}

/** Normalize a model-call result into a flat list of candidate messages. */
function collectMessages(result: unknown): unknown[] {
  if (result && typeof result === "object") {
    const r = result as { messages?: unknown; usage_metadata?: unknown };
    if (Array.isArray(r.messages)) return r.messages;
    if (r.usage_metadata !== undefined) return [result];
  }
  return result === undefined || result === null ? [] : [result];
}

/**
 * Build the shared per-worker usage `wrapModelCall` middleware spec (§10.14). It
 * times the call, extracts usage from the response, and emits ONE `WorkerUsage`
 * through `emit` after the handler resolves. A call that reports no usage still
 * emits with `estimated: true` and zeros (the span is attributed to the worker
 * either way, so a worker always shows in `byAgent`). A throwing handler emits
 * nothing and re-throws (the worker's error path owns it).
 */
export function workerUsageSpec(deps: {
  emit: (usage: WorkerUsage) => void;
  now?: () => number;
}): {
  name: string;
  wrapModelCall: (request: unknown, handler: (r: unknown) => Promise<unknown>) => Promise<unknown>;
} {
  const now = deps.now ?? (() => Date.now());
  return {
    name: "voidrift-worker-usage",
    wrapModelCall: async (request, handler) => {
      const start = now();
      const result = await handler(request);
      const genMs = Math.max(0, now() - start);
      const u = extractUsageFromResult(result);
      deps.emit({
        promptTokens: u.promptTokens,
        completionTokens: u.completionTokens,
        cacheReadTokens: u.cacheReadTokens,
        genMs,
        estimated: !u.reported,
      });
      return result;
    },
  };
}
