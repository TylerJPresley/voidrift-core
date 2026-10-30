/**
 * The shared context-overflow guard (core-blueprint.md §3.3, §4.10, invariant 9).
 *
 * ONE implementation every model call passes through, so no call site can forget
 * it. Invariant 9: when the context limit AND maxOutputTokens are known, a
 * request whose estimated input plus maxOutputTokens would exceed the limit is
 * REFUSED — `CONTEXT_OVERFLOW` is emitted, the model is never called, and nothing
 * is silently truncated.
 *
 * The guard is a `wrapModelCall` middleware (`contextOverflowMiddleware`) bound to
 * every agent — the orchestrator, every dispatched worker, and the reviewer — so
 * it runs inside the one path LangChain hands every request through. The one
 * other model call that does NOT go through an agent (the compaction summarizer's
 * direct `chatModel.invoke`) uses the SAME `guardInput` check via `guardedInvoke`.
 *
 * Pure entity for the math + the thrown sentinel; the middleware factory lives
 * here too but takes only an emit callback and the window/limits, so it carries
 * no engine/worker coupling. LangChain's middleware request shape is read
 * structurally (messages + systemMessage), never imported, keeping this layer
 * free of a crossing type.
 */
import { ESTIMATE_MARGIN_TOKENS, clampRatio, CHARS_PER_TOKEN } from "./budget.js";

/** Which count drove a `CONTEXT_OVERFLOW` refusal (§4.8, §4.10): an exact
 * endpoint `countTokens`, the measured chars/token ratio, or the default ratio
 * (4, before any measurement). */
export type OverflowSource = "endpoint" | "ratio" | "default";

/** The `CONTEXT_OVERFLOW` event payload (§4.10). */
export interface ContextOverflow {
  estimatedInput: number;
  maxOutputTokens: number;
  limit: number;
  message: string;
  /** Which count drove the refusal (§4.8). Omitted by `guardInput` callers that
   * do not distinguish; the engine fills it when it knows (§4.10). */
  source?: OverflowSource;
}

/** The overflow refusal message — one source of truth. */
export const CONTEXT_OVERFLOW_MESSAGE =
  "context would overflow the model's limit; run /compact to fold older turns, /new to start a fresh session, or raise the model's contextLimit";

/**
 * The guard decision for a known estimate (§4.10). Returns the overflow payload
 * when the request MUST be refused, else null. The guard is a no-op (returns
 * null) when either the window or maxOutputTokens is unknown (<= 0): the hard
 * stop fires only when both are known, exactly as invariant 9 states.
 */
export function guardInput(opts: {
  estimatedInput: number;
  limit: number;
  maxOutputTokens: number | null;
}): ContextOverflow | null {
  const { estimatedInput, limit, maxOutputTokens } = opts;
  if (!limit || limit <= 0 || !maxOutputTokens || maxOutputTokens <= 0) return null;
  if (estimatedInput + maxOutputTokens > limit) {
    return { estimatedInput, maxOutputTokens, limit, message: CONTEXT_OVERFLOW_MESSAGE };
  }
  return null;
}

/**
 * A conservative estimate of a request's input tokens from the assembled text:
 * the system message plus every message's text, at `ratio` chars/token (§4.8)
 * plus the margin. `ratio` defaults to `CHARS_PER_TOKEN` (4); a measured
 * `usageRatio` refines it. Used by the middleware, where the request is already
 * assembled.
 */
export function estimateRequestTokens(
  parts: { systemText: string; messagesText: string },
  marginTokens: number = ESTIMATE_MARGIN_TOKENS,
  ratio: number = CHARS_PER_TOKEN,
): number {
  const chars = parts.systemText.length + parts.messagesText.length;
  return Math.ceil(chars / clampRatio(ratio)) + marginTokens;
}

/** The exact character count of the assembled request (§4.8) — the numerator of
 * the measured chars/token ratio. */
export function requestChars(parts: { systemText: string; messagesText: string }): number {
  return parts.systemText.length + parts.messagesText.length;
}

/**
 * The sentinel thrown when the guard refuses a request so a worker/agent run
 * ends with a recognizable reason (the orchestrator maps it to a failed worker
 * carrying `CONTEXT_OVERFLOW`, §7.2). Distinct from a provider failure.
 */
export class ContextOverflowError extends Error {
  readonly isContextOverflow = true as const;
  readonly overflow: ContextOverflow;
  constructor(overflow: ContextOverflow) {
    super(overflow.message);
    this.name = "ContextOverflowError";
    this.overflow = overflow;
  }
}

/** Recognize a `ContextOverflowError` even after LangGraph re-wraps it (checks
 * the error, its `cause` chain, and the name). Returns the overflow or null. */
export function contextOverflowOf(err: unknown): ContextOverflow | null {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 8; depth++) {
    const e = cur as { isContextOverflow?: unknown; overflow?: ContextOverflow; name?: unknown; cause?: unknown };
    if (e.isContextOverflow === true && e.overflow) return e.overflow;
    if (e.name === "ContextOverflowError" && e.overflow) return e.overflow;
    cur = e.cause;
  }
  return null;
}

/** Minimal structural view of a LangChain model-call request (messages +
 * optional systemMessage); read, never imported, so no library type crosses. */
interface ModelCallRequestLike {
  messages?: unknown;
  systemMessage?: unknown;
}

/** Pull plain text out of a message/content value for estimation. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    let out = "";
    for (const b of value) {
      if (b && typeof b === "object") {
        const t = (b as { text?: unknown }).text;
        if (typeof t === "string") out += t;
      } else if (typeof b === "string") out += b;
    }
    return out;
  }
  if (value && typeof value === "object") {
    const c = (value as { content?: unknown }).content;
    if (c !== undefined) return textOf(c);
  }
  return "";
}

/** Assemble the estimated input text from a model-call request. */
export function requestText(request: ModelCallRequestLike): { systemText: string; messagesText: string } {
  const systemText = textOf(request.systemMessage);
  const msgs = Array.isArray(request.messages) ? request.messages : [];
  const messagesText = msgs.map((m) => textOf(m)).join("\n");
  return { systemText, messagesText };
}

/**
 * Build the shared `wrapModelCall` guard middleware (§3.3, §4.10). Every agent —
 * orchestrator, worker, reviewer — binds it, so a request that would overflow is
 * refused before the provider is called: `CONTEXT_OVERFLOW` is emitted and a
 * `ContextOverflowError` is thrown (never a silent truncation, never a send).
 * `emit` reports the event; `getLimits` returns the current window + output
 * reservation. Returns a `createMiddleware`-ready definition built by the caller
 * (LangChain's `createMiddleware` is passed in to keep this entity library-free).
 */
export function overflowGuardSpec(deps: {
  emit: (overflow: ContextOverflow) => void;
  getLimits: () => { limit: number; maxOutputTokens: number | null; marginTokens?: number };
}): {
  name: string;
  wrapModelCall: (request: unknown, handler: (r: unknown) => Promise<unknown>) => Promise<unknown>;
} {
  return {
    name: "voidrift-context-overflow",
    wrapModelCall: async (request, handler) => {
      const { limit, maxOutputTokens, marginTokens } = deps.getLimits();
      const { systemText, messagesText } = requestText(request as ModelCallRequestLike);
      const estimatedInput = estimateRequestTokens({ systemText, messagesText }, marginTokens ?? ESTIMATE_MARGIN_TOKENS);
      const overflow = guardInput({ estimatedInput, limit, maxOutputTokens });
      if (overflow) {
        deps.emit(overflow);
        throw new ContextOverflowError(overflow);
      }
      return handler(request);
    },
  };
}
