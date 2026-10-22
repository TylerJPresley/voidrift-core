/**
 * Model-error classifier unit tests (core-blueprint.md §3.6, §11.9).
 */
import { describe, it, expect } from "vitest";
import { classifyModelError } from "./model-error.js";

describe("classifyModelError (§3.6, §11.9)", () => {
  it("classifies a refused connection as non-retryable network (fail fast, §3.6)", () => {
    // The shape the OpenAI SDK throws for ECONNREFUSED: APIConnectionError →
    // TypeError(fetch failed) → AggregateError(code ECONNREFUSED).
    const err = Object.assign(new Error("Connection error."), {
      cause: Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error(""), { code: "ECONNREFUSED" }),
      }),
    });
    expect(classifyModelError(err)).toEqual({ code: "network", retryable: false });
  });

  it("classifies ECONNREFUSED nested in an AggregateError.errors array", () => {
    const agg = Object.assign(new Error("agg"), { errors: [{ code: "ECONNREFUSED" }] });
    const err = Object.assign(new Error("fetch failed"), { cause: agg });
    expect(classifyModelError(err)).toEqual({ code: "network", retryable: false });
  });

  it("classifies a 429 as retryable rate_limited", () => {
    expect(classifyModelError({ status: 429 })).toEqual({ code: "rate_limited", retryable: true });
  });

  it("classifies a 5xx as retryable server", () => {
    expect(classifyModelError({ status: 503 })).toEqual({ code: "server", retryable: true });
  });

  it("classifies auth (401) as non-retryable", () => {
    expect(classifyModelError({ status: 401 })).toEqual({ code: "auth", retryable: false });
  });

  it("classifies a timeout as retryable", () => {
    expect(classifyModelError({ message: "Request timed out" })).toEqual({ code: "timeout", retryable: true });
  });

  it("classifies a generic (non-refused) connection error as retryable network", () => {
    expect(classifyModelError(Object.assign(new Error("fetch failed"), { name: "APIConnectionError" }))).toEqual({
      code: "network",
      retryable: true,
    });
  });

  // Regression (the gx10 502 symptom): the agent framework re-wraps the provider
  // error in nested `MiddlewareError`s, so the HTTP status and the provider error
  // class live DOWN the cause chain, not on the top-level error. The classifier
  // must still find them — otherwise a retryable 5xx or a typed 401/429 is
  // misread as `unknown`/non-retryable and the user sees a bare message.
  it("finds a 5xx status nested under wrapper MiddlewareErrors (retryable server)", () => {
    const inner = Object.assign(new Error("502 Bad Gateway"), { name: "InternalServerError", status: 502 });
    const mid = Object.assign(new Error("502 Bad Gateway"), { name: "MiddlewareError", cause: inner });
    const outer = Object.assign(new Error("502 Bad Gateway"), { name: "MiddlewareError", cause: mid });
    expect(classifyModelError(outer)).toEqual({ code: "server", retryable: true });
  });

  it("finds a nested 400 (non-retryable client)", () => {
    const inner = Object.assign(new Error("400 bad param"), { name: "BadRequestError", status: 400 });
    const outer = Object.assign(new Error("400 bad param"), { name: "MiddlewareError", cause: inner });
    expect(classifyModelError(outer)).toEqual({ code: "client", retryable: false });
  });

  it("finds a nested 401 by status and a nested RateLimitError by class name", () => {
    const auth = Object.assign(new Error("401"), { name: "MiddlewareError", cause: Object.assign(new Error("401"), { status: 401 }) });
    expect(classifyModelError(auth)).toEqual({ code: "auth", retryable: false });
    const rl = Object.assign(new Error("rate"), { name: "MiddlewareError", cause: Object.assign(new Error("rate"), { name: "RateLimitError" }) });
    expect(classifyModelError(rl)).toEqual({ code: "rate_limited", retryable: true });
  });
});
