/**
 * The ONE shared model-network middleware (core-blueprint.md §11.5, §3.6, §7.2):
 * retry + first-byte watchdog. These unit tests drive the factory's
 * `wrapModelCall` directly with a controllable handler and a fake model, so the
 * retry semantics and the watchdog (arm/disarm/typed-timeout) are exercised on
 * the real code path without a network. The loopback-SSE real-ChatOpenAI tests
 * live beside this file in `model-network-middleware.sse.test.ts`.
 */
import { describe, it, expect, vi } from "vitest";
import { AIMessage, type BaseMessage, HumanMessage } from "@langchain/core/messages";
import {
  createModelNetworkMiddleware,
  FirstByteTimeoutError,
  ModelCallFailed,
  type ModelNetworkMiddlewareDeps,
} from "./model-network-middleware.js";
import { WATCHDOG_MS_PER_1K_TOKENS, WATCHDOG_CAP_MULTIPLE, watchdogAllowanceMs } from "../entities/model-error.js";
import { EventBus } from "../entities/event-bus.js";

/** A fake model that only needs to carry the per-attempt bound config
 * (`withConfig`). `withConfig` records the bound signal + callbacks so a test
 * handler can drive `handleLLMNewToken` and observe the abort. */
interface BoundFake {
  signal?: AbortSignal;
  callbacks?: { handleLLMNewToken?: () => void }[];
}
function fakeModel(): { withConfig: (c: BoundFake) => BoundFake } {
  return { withConfig: (c: BoundFake) => c };
}

/** The middleware runtime signal seam the factory reads. */
function req(messages: BaseMessage[], signal?: AbortSignal) {
  return { model: fakeModel(), messages, runtime: { signal } } as unknown as Parameters<
    NonNullable<ReturnType<typeof createModelNetworkMiddleware>["wrapModelCall"]>
  >[0];
}

function deps(bus: EventBus, over: Partial<ModelNetworkMiddlewareDeps> = {}): ModelNetworkMiddlewareDeps {
  return {
    bus,
    modelName: "test-model",
    sessionId: "s1",
    getMaxRetries: () => 2,
    getFloorMs: () => 200,
    estimateInputTokens: () => 0,
    mask: (t) => t.replace(/sk-[A-Za-z0-9]+/g, "***"),
    ...over,
  };
}

function wrap(d: ModelNetworkMiddlewareDeps) {
  return createModelNetworkMiddleware(d).wrapModelCall!;
}

const msgs = [new HumanMessage("hi")];

describe("watchdogAllowanceMs (§11.5)", () => {
  it("is floor + 2s/1k tokens, capped at 5× floor", () => {
    expect(watchdogAllowanceMs(120_000, 0)).toBe(120_000);
    // 10k tokens → +20s.
    expect(watchdogAllowanceMs(120_000, 10_000)).toBe(120_000 + 10 * WATCHDOG_MS_PER_1K_TOKENS);
    // A huge input is clamped to the cap.
    expect(watchdogAllowanceMs(120_000, 10_000_000)).toBe(120_000 * WATCHDOG_CAP_MULTIPLE);
    expect(WATCHDOG_CAP_MULTIPLE).toBe(5);
  });
});

describe("shared model-network middleware — retry semantics (§3.6, §7.2)", () => {
  it("a call that fails once with a retryable error then succeeds completes", async () => {
    const bus = new EventBus();
    const errs: unknown[] = [];
    bus.subscribe("MODEL_ERROR", (e) => errs.push(e.payload), { scope: { session: "w1" } });
    const run = wrap(deps(bus, { sessionId: "w1" }));
    let n = 0;
    const handler = vi.fn(async () => {
      n += 1;
      if (n === 1) throw Object.assign(new Error("boom"), { status: 503 });
      return new AIMessage("ok");
    });
    const out = (await run(req(msgs), handler as never)) as AIMessage;
    expect(out.content).toBe("ok");
    expect(handler).toHaveBeenCalledTimes(2);
    // ONE MODEL_ERROR for the first attempt, scoped to the worker, willRetry.
    expect(errs).toHaveLength(1);
    expect((errs[0] as { willRetry: boolean; retryable: boolean }).willRetry).toBe(true);
  });

  it("MODEL_ERROR is scoped to the worker session", async () => {
    const bus = new EventBus();
    const parent: unknown[] = [];
    const worker: unknown[] = [];
    bus.subscribe("MODEL_ERROR", (e) => parent.push(e.payload), { scope: { session: "parent" } });
    bus.subscribe("MODEL_ERROR", (e) => worker.push(e.payload), { scope: { session: "w1" } });
    const run = wrap(deps(bus, { sessionId: "w1", getMaxRetries: () => 0 }));
    await Promise.resolve(
      run(
        req(msgs),
        (async () => {
          throw Object.assign(new Error("x"), { status: 500 });
        }) as never,
      ),
    ).catch(() => undefined);
    expect(worker).toHaveLength(1);
    expect(parent).toHaveLength(0); // a sibling session never sees it
  });

  it("non-retryable fails at once with the (masked) error text", async () => {
    const bus = new EventBus();
    const run = wrap(deps(bus));
    const handler = vi.fn(async () => {
      throw Object.assign(new Error("bad key sk-SECRET123"), { status: 401 });
    });
    await expect(run(req(msgs), handler as never)).rejects.toSatisfy(
      (e: unknown) => e instanceof ModelCallFailed && /\*\*\*/.test((e as Error).message) && !/SECRET123/.test((e as Error).message),
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("exhausted retries fail with the last error", async () => {
    const bus = new EventBus();
    const errs: { attempt: number; willRetry: boolean }[] = [];
    bus.subscribe("MODEL_ERROR", (e) => errs.push(e.payload as never));
    const run = wrap(deps(bus, { getMaxRetries: () => 2 }));
    const handler = vi.fn(async () => {
      throw Object.assign(new Error("still 503"), { status: 503 });
    });
    await expect(run(req(msgs), handler as never)).rejects.toBeInstanceOf(ModelCallFailed);
    // first try + 2 retries = 3 attempts.
    expect(handler).toHaveBeenCalledTimes(3);
    expect(errs.map((e) => e.willRetry)).toEqual([true, true, false]);
  });

  it("a cancel during backoff stops it (turn signal aborts the sleep)", async () => {
    const bus = new EventBus();
    const ctrl = new AbortController();
    const run = wrap(deps(bus, { getMaxRetries: () => 5 }));
    const handler = vi.fn(async () => {
      // Schedule the cancel to land DURING the (1s) backoff sleep, not in the
      // same tick as the throw, so the abortable sleep rejects with AbortError
      // and the loop never re-issues.
      setTimeout(() => ctrl.abort(), 10);
      throw Object.assign(new Error("503"), { status: 503 });
    });
    await expect(run(req(msgs, ctrl.signal), handler as never)).rejects.toSatisfy(
      (e: unknown) => (e as Error).name === "AbortError",
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a cancel before the first attempt fails fast with no model call", async () => {
    const bus = new EventBus();
    const ctrl = new AbortController();
    ctrl.abort();
    const run = wrap(deps(bus));
    const handler = vi.fn(async () => new AIMessage("never"));
    await expect(run(req(msgs, ctrl.signal), handler as never)).rejects.toSatisfy(
      (e: unknown) => (e as Error).name === "AbortError",
    );
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("shared model-network middleware — first-byte watchdog (§11.5)", () => {
  // A handler that simulates a streaming model: it reads the bound callbacks
  // off the per-attempt model, optionally fires `handleLLMNewToken` after
  // `firstTokenMs`, and resolves/rejects when the bound signal aborts.
  function streamingHandler(firstTokenMs: number) {
    return vi.fn((request: { model: BoundFake }) =>
      new Promise<AIMessage>((resolve, reject) => {
        const bound = request.model;
        const onAbort = (): void => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (bound.signal?.aborted) return onAbort();
        bound.signal?.addEventListener("abort", onAbort, { once: true });
        const t = setTimeout(() => {
          // First token → disarm the watchdog, then finish shortly after.
          bound.callbacks?.[0]?.handleLLMNewToken?.();
          setTimeout(() => resolve(new AIMessage("done")), 5);
        }, firstTokenMs);
        bound.signal?.addEventListener("abort", () => clearTimeout(t), { once: true });
      }),
    );
  }

  it("first token inside the allowance succeeds (never cut)", async () => {
    const bus = new EventBus();
    // tiny floor 200ms, 0 tokens → allowance 200ms; first token at 50ms.
    const run = wrap(deps(bus, { getFloorMs: () => 200, estimateInputTokens: () => 0 }));
    const out = (await run(req(msgs), streamingHandler(50) as never)) as AIMessage;
    expect(out.content).toBe("done");
  });

  it("first byte beyond the allowance times out, retries, then fails with the typed error", async () => {
    const bus = new EventBus();
    const codes: string[] = [];
    bus.subscribe("MODEL_ERROR", (e) => codes.push((e.payload as { code: string }).code));
    // floor 100ms, maxRetries 1 → 2 attempts, each times out (no first token).
    const run = wrap(deps(bus, { getFloorMs: () => 100, getMaxRetries: () => 1 }));
    const handler = vi.fn((request: { model: BoundFake }) =>
      new Promise<AIMessage>((_resolve, reject) => {
        const bound = request.model;
        bound.signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
        // never sends a token → the watchdog fires.
      }),
    );
    await expect(run(req(msgs), handler as never)).rejects.toBeInstanceOf(ModelCallFailed);
    // Both attempts classified as a retryable timeout; two attempts total.
    expect(handler).toHaveBeenCalledTimes(2);
    expect(codes).toEqual(["timeout", "timeout"]);
  });

  it("the estimate drives the allowance: a large input gets a longer watchdog", async () => {
    // floor 100ms. Small input (0 tokens) → 100ms allowance; a first token at
    // 180ms would miss it. Large input (100k tokens) → capped at 500ms, so the
    // SAME 180ms first token now succeeds.
    const small = wrap(deps(new EventBus(), { getFloorMs: () => 100, estimateInputTokens: () => 0, getMaxRetries: () => 0 }));
    await expect(small(req(msgs), streamingHandler(180) as never)).rejects.toBeInstanceOf(ModelCallFailed);
    const large = wrap(
      deps(new EventBus(), { getFloorMs: () => 100, estimateInputTokens: () => 100_000, getMaxRetries: () => 0 }),
    );
    const out = (await large(req(msgs), streamingHandler(180) as never)) as AIMessage;
    expect(out.content).toBe("done");
  });

  it("a stream that keeps sending after the allowance is never cut (disarmed on first token)", async () => {
    const bus = new EventBus();
    const run = wrap(deps(bus, { getFloorMs: () => 100, getMaxRetries: () => 0 }));
    // First token at 50ms (inside), then the 'stream' runs 300ms (> allowance)
    // before resolving — it must NOT be cut because the watchdog disarmed.
    const handler = vi.fn((request: { model: BoundFake }) =>
      new Promise<AIMessage>((resolve, reject) => {
        const bound = request.model;
        bound.signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
        setTimeout(() => bound.callbacks?.[0]?.handleLLMNewToken?.(), 50);
        setTimeout(() => resolve(new AIMessage("long")), 300);
      }),
    );
    const out = (await run(req(msgs), handler as never)) as AIMessage;
    expect(out.content).toBe("long");
  });

  it("a user cancel during the watchdog window is NOT retried (distinct from a timeout)", async () => {
    const bus = new EventBus();
    const errs: unknown[] = [];
    bus.subscribe("MODEL_ERROR", (e) => errs.push(e.payload));
    const ctrl = new AbortController();
    const run = wrap(deps(bus, { getFloorMs: () => 1000, getMaxRetries: () => 3 }));
    const handler = vi.fn((request: { model: BoundFake }) =>
      new Promise<AIMessage>((_resolve, reject) => {
        const bound = request.model;
        bound.signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
        queueMicrotask(() => ctrl.abort()); // user cancel, well inside the 1s window
      }),
    );
    await expect(run(req(msgs, ctrl.signal), handler as never)).rejects.toSatisfy(
      (e: unknown) => (e as Error).name === "AbortError" && !(e instanceof FirstByteTimeoutError),
    );
    expect(handler).toHaveBeenCalledTimes(1); // never retried
    expect(errs).toHaveLength(0); // a cancel emits no MODEL_ERROR
  });
});
