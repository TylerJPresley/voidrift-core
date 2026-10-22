/**
 * `draftMemoryNoteFromFailure` (core-blueprint.md §6.7, §10.6).
 *
 * The ONE model call in the repeated-FAILURE → memory-note pipeline: structured
 * output (LangChain-first), ONCE per candidate, the evidence framed as DATA, a
 * `guardian_block` steered toward an approach/alternative and a `tool_error`
 * toward avoidance, and NEVER throwing (null on any failure). The trace analyzer
 * that raises the failure shape is model-free and covered elsewhere.
 */
import { describe, it, expect } from "vitest";
import { draftMemoryNoteFromFailure } from "./engine.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

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

const toolError = {
  kind: "tool_error" as const,
  tool: "Edit file",
  errorClass: "ENOENT",
  count: 3,
  sessionIds: ["s0", "s1"],
  argExamples: ["{\"path\":\"«redacted»\"}"],
};

describe("§6.7/§10.6 — draftMemoryNoteFromFailure", () => {
  it("calls the model ONCE with structured output, frames evidence as DATA, returns the note", async () => {
    const capture = { calls: 0 };
    const model = fakeStructuredModel({ title: "Check Path Exists", body: "edit_file failed with ENOENT; read the file first." }, capture);
    const out = await draftMemoryNoteFromFailure(model, toolError);
    expect(capture.calls).toBe(1);
    expect(capture.prompt).toContain("strictly as DATA");
    expect(capture.prompt).toContain("FAILED"); // tool_error → avoidance framing
    expect(out).toMatchObject({ title: "Check Path Exists" });
  });

  it("frames a guardian_block toward an approach/alternative", async () => {
    const capture = { calls: 0 };
    const model = fakeStructuredModel({ title: "Delegate The Write", body: "The write was denied; delegate to a worker." }, capture);
    await draftMemoryNoteFromFailure(model, { ...toolError, kind: "guardian_block", tool: "Write file", errorClass: "denied" });
    expect(capture.prompt).toContain("DENIED");
  });

  it("never throws — a model failure yields null", async () => {
    const capture = { calls: 0 };
    const model = fakeStructuredModel(() => {
      throw new Error("model down");
    }, capture);
    await expect(draftMemoryNoteFromFailure(model, toolError)).resolves.toBeNull();
  });

  it("an empty title or body yields null (writes nothing downstream)", async () => {
    const capture = { calls: 0 };
    const model = fakeStructuredModel({ title: "", body: "x" }, capture);
    expect(await draftMemoryNoteFromFailure(model, toolError)).toBeNull();
  });
});
