/**
 * ObsCallbackHandler unit tests (core-blueprint.md §10.1, §10.4).
 *
 * The shared BaseCallbackHandler feeds the writer: run id → spanId, parent run
 * id → parentSpanId, input carried onto the closed span at verbose/debug, and
 * tool error/no-span paths. The writer is a lightweight capture stub.
 */
import { describe, it, expect } from "vitest";
import { ObsCallbackHandler } from "./obs-callback-handler.js";
import type { ObsWriter } from "../use-cases/obs-writer.js";
import type { ObsSeverity } from "../entities/observability/obs-record.js";

function captureWriter() {
  const records: Record<string, unknown>[] = [];
  const writer = {
    writeFromCallback: (r: Record<string, unknown>) => void records.push(r),
  } as unknown as ObsWriter;
  return { writer, records };
}

const model = { name: "local", protocol: "openai" };

describe("§10 — ObsCallbackHandler", () => {
  it("handleLLMStart records a pending span and carries input at verbose onto the closed span", () => {
    const { writer, records } = captureWriter();
    const level: ObsSeverity = "verbose";
    const h = new ObsCallbackHandler(writer, "s1", () => level, model);
    h.handleLLMStart({} as never, ["prompt text"], "run-1", undefined);
    h.handleLLMEnd(
      { generations: [[{ text: "answer" }]], llmOutput: { tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } } as never,
      "run-1",
      undefined,
    );
    const pending = records.find((r) => r["status"] === "pending")!;
    const done = records.find((r) => r["status"] === "ok")!;
    expect(pending["input"]).toEqual(["prompt text"]);
    expect(done["input"]).toEqual(["prompt text"]);
    expect(done["output"]).toBeDefined();
    expect((done["usage"] as { totalTokens: number }).totalTokens).toBe(2);
  });

  it("handleToolError records an error span with the message; no-span end still writes", () => {
    const { writer, records } = captureWriter();
    const h = new ObsCallbackHandler(writer, "s1", () => "info", model);
    // A tool error for a span that was never opened still produces an error record.
    h.handleToolError(new Error("boom"), "orphan", undefined);
    const err = records.find((r) => r["source"] === "tool" && r["status"] === "error")!;
    expect((err["attributes"] as { message: string }).message).toBe("boom");
    // A non-Error rejection is stringified.
    h.handleToolError("plain-fail", "orphan2", undefined);
    const err2 = records.filter((r) => r["status"] === "error")[1]!;
    expect((err2["attributes"] as { message: string }).message).toBe("plain-fail");
    // A tool end with no open span falls back to the default name.
    h.handleToolEnd({ ok: 1 }, "orphan3", undefined);
    const end = records.find((r) => r["source"] === "tool" && r["status"] === "ok")!;
    expect(end["name"]).toBe("tool");
  });

  it("derives a tool name from a serialized id array when name is absent", () => {
    const { writer, records } = captureWriter();
    const h = new ObsCallbackHandler(writer, "s1", () => "info", model);
    h.handleToolStart({ id: ["pkg", "edit_file"] } as never, "{}", "t1", "parent");
    const start = records.find((r) => r["status"] === "pending")!;
    expect(start["name"]).toBe("edit_file");
    expect(start["parentSpanId"]).toBe("parent");
  });
});
