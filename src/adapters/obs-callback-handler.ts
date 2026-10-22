/**
 * The shared observability callback handler (core-blueprint.md §10.1, §10.4).
 *
 * ONE `BaseCallbackHandler` the core registers on every runnable. The handler's
 * run id becomes `spanId` and its parent run id becomes `parentSpanId`, so model
 * and tool spans nest exactly as LangChain nests runs — no bespoke tracing (§1
 * LangChain-first). `traceId` is the session id (one session, one trace). It is
 * the only place the writer touches a LangChain callback type; the writer and
 * the ObsRecord stay neutral (§1 substrate contract).
 */
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import type { ObsSeverity } from "../entities/observability/obs-record.js";
import type { ObsWriter } from "../use-cases/obs-writer.js";

interface OpenSpan {
  start: number;
  name: string;
  /** The input captured at start (messages/prompts), carried onto the end record
   * so the closed model span holds both the full message chain and the response
   * at `verbose`/`debug` (§10.2). */
  input?: unknown;
}

/** Build the shared handler bound to a session's trace. */
export class ObsCallbackHandler extends BaseCallbackHandler {
  name = "voidrift-observability";

  private readonly open = new Map<string, OpenSpan>();

  constructor(
    private readonly writer: ObsWriter,
    private readonly traceId: string,
    private readonly getLevel: () => ObsSeverity,
    private readonly model: { name: string; protocol: string },
  ) {
    super();
  }

  override handleChatModelStart(
    _llm: Serialized,
    _messages: unknown,
    runId: string,
    parentRunId?: string,
  ): void {
    this.open.set(runId, { start: Date.now(), name: "model.stream", input: _messages });
    this.writer.writeFromCallback({
      traceId: this.traceId,
      spanId: runId,
      ...(parentRunId ? { parentSpanId: parentRunId } : {}),
      source: "model",
      name: "model.stream",
      status: "pending",
      model: this.model,
      ...(this.getLevel() !== "info" ? { input: _messages } : {}),
    });
  }

  override handleLLMStart(
    _llm: Serialized,
    prompts: string[],
    runId: string,
    parentRunId?: string,
  ): void {
    this.open.set(runId, { start: Date.now(), name: "model.stream", input: prompts });
    this.writer.writeFromCallback({
      traceId: this.traceId,
      spanId: runId,
      ...(parentRunId ? { parentSpanId: parentRunId } : {}),
      source: "model",
      name: "model.stream",
      status: "pending",
      model: this.model,
      ...(this.getLevel() !== "info" ? { input: prompts } : {}),
    });
  }

  override handleLLMEnd(output: LLMResult, runId: string, parentRunId?: string): void {
    const span = this.open.get(runId);
    this.open.delete(runId);
    const usage = extractUsage(output);
    this.writer.writeFromCallback({
      traceId: this.traceId,
      spanId: runId,
      ...(parentRunId ? { parentSpanId: parentRunId } : {}),
      source: "model",
      name: span?.name ?? "model.stream",
      status: "ok",
      model: this.model,
      ...(span ? { durationMs: Date.now() - span.start } : {}),
      ...(usage ? { usage } : {}),
      // At verbose/debug the closed model span carries BOTH the full message
      // chain sent (captured at start) and the response (§10.2).
      ...(this.getLevel() !== "info" && span?.input !== undefined ? { input: span.input } : {}),
      ...(this.getLevel() !== "info" ? { output: output.generations } : {}),
    });
  }

  override handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
  ): void {
    const name = toolName(tool);
    this.open.set(runId, { start: Date.now(), name });
    this.writer.writeFromCallback({
      traceId: this.traceId,
      spanId: runId,
      ...(parentRunId ? { parentSpanId: parentRunId } : {}),
      source: "tool",
      name,
      status: "pending",
      input, // masked in the writer (§10.10)
    });
  }

  override handleToolEnd(output: unknown, runId: string, parentRunId?: string): void {
    const span = this.open.get(runId);
    this.open.delete(runId);
    this.writer.writeFromCallback({
      traceId: this.traceId,
      spanId: runId,
      ...(parentRunId ? { parentSpanId: parentRunId } : {}),
      source: "tool",
      name: span?.name ?? "tool",
      status: "ok",
      ...(span ? { durationMs: Date.now() - span.start } : {}),
      output: typeof output === "string" ? output : JSON.stringify(output),
    });
  }

  override handleToolError(error: unknown, runId: string, parentRunId?: string): void {
    const span = this.open.get(runId);
    this.open.delete(runId);
    this.writer.writeFromCallback({
      traceId: this.traceId,
      spanId: runId,
      ...(parentRunId ? { parentSpanId: parentRunId } : {}),
      source: "tool",
      name: span?.name ?? "tool",
      status: "error",
      ...(span ? { durationMs: Date.now() - span.start } : {}),
      attributes: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

function toolName(tool: Serialized): string {
  const n = (tool as { name?: string; id?: string[] }).name;
  if (n) return n;
  const id = (tool as { id?: string[] }).id;
  return Array.isArray(id) ? id[id.length - 1]! : "tool";
}

function extractUsage(output: LLMResult): { inputTokens: number; outputTokens: number; totalTokens: number } | undefined {
  const llmOutput = output.llmOutput as { tokenUsage?: Record<string, number>; usage?: Record<string, number> } | undefined;
  const u = llmOutput?.tokenUsage ?? llmOutput?.usage;
  if (!u) return undefined;
  const inputTokens = u["promptTokens"] ?? u["input_tokens"] ?? 0;
  const outputTokens = u["completionTokens"] ?? u["output_tokens"] ?? 0;
  const totalTokens = u["totalTokens"] ?? u["total_tokens"] ?? inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}
