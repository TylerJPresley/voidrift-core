/**
 * The per-worker model-usage middleware spec (core-blueprint.md §10.14, §10.7).
 * A worker model call emits ONE WorkerUsage with the response's reported tokens,
 * the measured genMs, and the estimated flag; a call with no reported usage still
 * emits (estimated) so the worker always shows in byAgent.
 */
import { describe, it, expect } from "vitest";
import { workerUsageSpec, extractUsageFromResult } from "./worker-usage.js";

describe("extractUsageFromResult (§10.14)", () => {
  it("sums usage_metadata off a { messages } result", () => {
    const result = {
      messages: [
        { usage_metadata: { input_tokens: 100, output_tokens: 20 } },
        { usage_metadata: { input_tokens: 120, output_tokens: 15, input_token_details: { cache_read: 10 } } },
      ],
    };
    const u = extractUsageFromResult(result);
    expect(u.promptTokens).toBe(120); // peak single-prompt input
    expect(u.completionTokens).toBe(35); // summed output
    expect(u.cacheReadTokens).toBe(10);
    expect(u.reported).toBe(true);
  });

  it("reads usage_metadata off a bare AIMessage-like result", () => {
    const u = extractUsageFromResult({ usage_metadata: { input_tokens: 7, output_tokens: 3 } });
    expect(u.promptTokens).toBe(7);
    expect(u.completionTokens).toBe(3);
    expect(u.reported).toBe(true);
  });

  it("reports nothing when no usage metadata is present", () => {
    expect(extractUsageFromResult({ messages: [{ content: "hi" }] }).reported).toBe(false);
    expect(extractUsageFromResult(undefined).reported).toBe(false);
  });
});

describe("workerUsageSpec.wrapModelCall (§10.14, §10.7)", () => {
  it("emits one usage with measured genMs and reported tokens", async () => {
    const seen: Parameters<Parameters<typeof workerUsageSpec>[0]["emit"]>[0][] = [];
    let t = 1000;
    const spec = workerUsageSpec({ emit: (u) => seen.push(u), now: () => t });
    const result = { messages: [{ usage_metadata: { input_tokens: 50, output_tokens: 8 } }] };
    const out = await spec.wrapModelCall({}, async () => {
      t = 1120; // 120 ms elapsed
      return result;
    });
    expect(out).toBe(result);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ promptTokens: 50, completionTokens: 8, genMs: 120, estimated: false });
  });

  it("emits with estimated=true when the call reports no usage", async () => {
    const seen: Parameters<Parameters<typeof workerUsageSpec>[0]["emit"]>[0][] = [];
    const spec = workerUsageSpec({ emit: (u) => seen.push(u) });
    await spec.wrapModelCall({}, async () => ({ messages: [{ content: "answer" }] }));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.estimated).toBe(true);
    expect(seen[0]!.promptTokens).toBe(0);
  });

  it("does not emit and re-throws when the handler throws", async () => {
    const seen: unknown[] = [];
    const spec = workerUsageSpec({ emit: (u) => seen.push(u) });
    await expect(
      spec.wrapModelCall({}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(seen).toHaveLength(0);
  });
});
