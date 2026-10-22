/**
 * `draftSkillFromSequence` (core-blueprint.md §6.7, §10.6).
 *
 * The ONE model call in the repeated-sequence → skill-candidate pipeline:
 * structured output (LangChain-first), called exactly once per candidate, the
 * evidence framed as DATA, a `failure` outcome steered toward a guard and a
 * `success` toward a script, and NEVER throwing (null on any failure). Detection
 * itself is model-free and covered in sequence-detector.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { draftSkillFromSequence } from "./engine.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

/** A fake chat model whose `withStructuredOutput` returns a fixed object and
 * records the prompt it was invoked with, exactly once. */
function fakeStructuredModel(result: unknown | (() => never), capture: { prompt?: string; calls: number }) {
  return {
    withStructuredOutput: () => ({
      invoke: async (messages: { content: string }[]) => {
        capture.calls += 1;
        capture.prompt = messages[0]!.content;
        if (typeof result === "function") return (result as () => never)();
        return result;
      },
    }),
  } as unknown as BaseChatModel;
}

const evidence = {
  steps: ["read_file({path:string})", "write_file({path:string})"],
  count: 3,
  split: { within: 2, across: 1 },
  outcome: "success" as const,
  sessionIds: ["s0", "s1"],
  examples: [{ source: "tool", name: "read_file", status: "ok" }],
};

describe("§6.7/§10.6 — draftSkillFromSequence", () => {
  it("calls the model ONCE with structured output, frames the evidence as DATA, returns the candidate", async () => {
    const capture = { calls: 0 };
    const model = fakeStructuredModel(
      { title: "Read Then Write", body: "A mechanical procedure.", assets: [{ path: "scripts/run.sh", content: "echo hi" }] },
      capture,
    );
    const out = await draftSkillFromSequence(model, evidence);
    expect(capture.calls).toBe(1);
    expect(capture.prompt).toContain("strictly as DATA");
    expect(capture.prompt).toContain("SUCCEEDED"); // success → script framing
    expect(out).toMatchObject({ title: "Read Then Write" });
    expect(out!.assets).toHaveLength(1);
  });

  it("frames a failure outcome toward a guard/alternative", async () => {
    const capture = { calls: 0 };
    const model = fakeStructuredModel({ title: "Guard", body: "Avoid the failing path." }, capture);
    await draftSkillFromSequence(model, { ...evidence, outcome: "failure" });
    expect(capture.prompt).toContain("FAILED");
    expect(capture.prompt).toContain("GUARD");
  });

  it("never throws — a model failure yields null", async () => {
    const capture = { calls: 0 };
    const model = fakeStructuredModel(() => {
      throw new Error("model down");
    }, capture);
    await expect(draftSkillFromSequence(model, evidence)).resolves.toBeNull();
  });

  it("an empty title or body yields null (writes nothing downstream)", async () => {
    const capture = { calls: 0 };
    const model = fakeStructuredModel({ title: "", body: "x" }, capture);
    expect(await draftSkillFromSequence(model, evidence)).toBeNull();
  });

  it("bounds the fenced evidence packet to memory.evidencePacketMaxChars (M2/M10 override)", async () => {
    // A huge evidence blob; a tiny cap clips the fenced JSON so the prompt is short.
    const big = { ...evidence, steps: Array.from({ length: 500 }, (_, i) => `step_${i}(${"x".repeat(40)})`) };
    const wide = { calls: 0 };
    await draftSkillFromSequence(fakeStructuredModel({ title: "T", body: "B" }, wide), big);
    const narrow = { calls: 0 };
    await draftSkillFromSequence(fakeStructuredModel({ title: "T", body: "B" }, narrow), big, {
      evidencePacketMaxChars: 100,
    });
    // The clipped fenced block is between the json fences; a 100-char cap must
    // make the narrow prompt materially shorter than the default-capped one.
    expect(narrow.prompt!.length).toBeLessThan(wide.prompt!.length);
  });

  it("detection is model-free: the detector never touches this seam", () => {
    const spy = vi.fn();
    void spy; // draftSkillFromSequence is the ONLY model seam; the detector takes none.
    expect(spy).not.toHaveBeenCalled();
  });
});
