/**
 * Shared context-overflow guard unit tests (core-blueprint.md §4.10, invariant 9).
 *
 * Pure, offline. Covers the guard decision, the request-text assembly across the
 * string/array/object content shapes, the thrown sentinel + its wrapped-cause
 * recognition, and the middleware spec refusing (throw) vs passing through.
 */
import { describe, it, expect } from "vitest";
import {
  guardInput,
  estimateRequestTokens,
  requestText,
  overflowGuardSpec,
  ContextOverflowError,
  contextOverflowOf,
  CONTEXT_OVERFLOW_MESSAGE,
} from "./model-guard.js";

describe("guardInput (§4.10)", () => {
  it("refuses when estimate + maxOutputTokens exceeds the limit", () => {
    const o = guardInput({ estimatedInput: 100, limit: 120, maxOutputTokens: 40 });
    expect(o).not.toBeNull();
    expect(o).toMatchObject({ estimatedInput: 100, maxOutputTokens: 40, limit: 120, message: CONTEXT_OVERFLOW_MESSAGE });
  });

  it("allows when the request fits", () => {
    expect(guardInput({ estimatedInput: 50, limit: 200, maxOutputTokens: 40 })).toBeNull();
  });

  it("is a no-op when the window or maxOutputTokens is unknown (<=0 or null)", () => {
    expect(guardInput({ estimatedInput: 1e9, limit: 0, maxOutputTokens: 40 })).toBeNull();
    expect(guardInput({ estimatedInput: 1e9, limit: 100, maxOutputTokens: null })).toBeNull();
    expect(guardInput({ estimatedInput: 1e9, limit: 100, maxOutputTokens: 0 })).toBeNull();
  });
});

describe("requestText / estimateRequestTokens", () => {
  it("reads string, array-of-blocks, and object content shapes", () => {
    const req = {
      systemMessage: "SYS",
      messages: [
        "raw string",
        { content: [{ type: "text", text: "A" }, { type: "image", url: "x" }, "B"] },
        { content: "plain" },
      ],
    };
    const { systemText, messagesText } = requestText(req);
    expect(systemText).toBe("SYS");
    expect(messagesText).toContain("raw string");
    expect(messagesText).toContain("A");
    expect(messagesText).toContain("B");
    expect(messagesText).toContain("plain");
    expect(estimateRequestTokens({ systemText, messagesText })).toBeGreaterThan(0);
  });

  it("handles absent/empty messages", () => {
    const { systemText, messagesText } = requestText({});
    expect(systemText).toBe("");
    expect(messagesText).toBe("");
  });

  it("yields empty text for object-without-content, null, and number values", () => {
    const { messagesText } = requestText({ systemMessage: { notContent: 1 }, messages: [null, 42, { content: null }] });
    expect(messagesText.replace(/\n/g, "")).toBe("");
  });
});

describe("ContextOverflowError + contextOverflowOf", () => {
  it("recognizes a direct error and one wrapped as a cause", () => {
    const overflow = { estimatedInput: 1, maxOutputTokens: 2, limit: 2, message: "m" };
    const e = new ContextOverflowError(overflow);
    expect(contextOverflowOf(e)).toEqual(overflow);
    const wrapped = new Error("outer", { cause: e });
    expect(contextOverflowOf(wrapped)).toEqual(overflow);
    expect(contextOverflowOf(new Error("unrelated"))).toBeNull();
  });
});

describe("overflowGuardSpec middleware", () => {
  it("throws + emits on overflow and never calls the handler", async () => {
    const emitted: unknown[] = [];
    const spec = overflowGuardSpec({
      emit: (o) => emitted.push(o),
      getLimits: () => ({ limit: 10, maxOutputTokens: 10 }),
    });
    let handlerCalled = false;
    await expect(
      spec.wrapModelCall({ systemMessage: "x".repeat(400), messages: [] }, async () => {
        handlerCalled = true;
        return "r";
      }),
    ).rejects.toBeInstanceOf(ContextOverflowError);
    expect(handlerCalled).toBe(false);
    expect(emitted.length).toBe(1);
  });

  it("passes through when the request fits", async () => {
    const spec = overflowGuardSpec({
      emit: () => expect.unreachable("should not emit"),
      getLimits: () => ({ limit: 100_000, maxOutputTokens: 100 }),
    });
    const res = await spec.wrapModelCall({ systemMessage: "small", messages: ["hi"] }, async () => "ok");
    expect(res).toBe("ok");
  });

  it("passes through when the guard is unarmed (unknown limits)", async () => {
    const spec = overflowGuardSpec({
      emit: () => expect.unreachable("should not emit"),
      getLimits: () => ({ limit: 0, maxOutputTokens: null }),
    });
    const res = await spec.wrapModelCall({ systemMessage: "x".repeat(10_000), messages: [] }, async () => "ok");
    expect(res).toBe("ok");
  });
});
