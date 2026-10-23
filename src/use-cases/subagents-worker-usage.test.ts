/**
 * Worker model usage lands in the trail and rolls up into the parent session
 * stats (core-blueprint.md §10.14, §10.7). A scripted fan-out of three workers
 * (each its own endpoint reporting usage) must:
 *   - emit ONE `MODEL_USAGE` per worker call onto the bus, scoped to the PARENT
 *     session and attributed to the worker (`agent` = worker name, `taskId`);
 *   - persisted as `model.usage` spans, those feed `buildStatsReport` so the
 *     parent session TOTALS = orchestrator + workers and `byAgent` has a bucket
 *     per worker with tokensPerSecond from genMs and the estimated marks —
 *     WITHOUT double-counting the orchestrator's own usage.
 */
import { describe, it, expect } from "vitest";
import { BaseChatModel, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { Guardian, builtinGuardrails } from "../entities/guardian.js";
import { Warden } from "../entities/warden.js";
import { EventBus } from "../entities/event-bus.js";
import { ConfigSchema, type Config } from "../config/schema.js";
import type { MergeResult, VcsPort, Worktree } from "../entities/ports/vcs-port.js";
import type { StagingApplyResult, StagingArea, StagingPort } from "../entities/ports/staging-port.js";
import { newManifest, type StagingManifest } from "../entities/staging-manifest.js";
import { Subagents, type SubagentsDeps } from "./subagents.js";
import type { AgentDefinition } from "../entities/subagents.js";
import { ToolRegistry } from "../entities/tool-registry.js";
import { builtinToolDefinitions } from "../tools/builtin.js";
import { buildStatsReport } from "../entities/observability/stats-report.js";
import type { ObsRecord } from "../entities/observability/obs-record.js";

function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const t of builtinToolDefinitions()) reg.register(t.def, t.exec);
  return reg;
}

class FakeVcs implements VcsPort {
  isRepo(): boolean {
    return false;
  }
  async currentBranch(): Promise<string | null> {
    return "main";
  }
  async workingDiff(): Promise<string> {
    return "";
  }
  async listFiles(): Promise<string[] | null> {
    return [];
  }
  async createWorktree(id: string): Promise<Worktree> {
    return { id, path: `/wt/${id}`, branch: `b-${id}` };
  }
  async mergeWorktree(): Promise<MergeResult> {
    return { merged: true };
  }
  async abandonWorktree(wt: Worktree): Promise<string> {
    return `r-${wt.id}`;
  }
  preserveWorktree(wt: Worktree): string {
    return wt.path;
  }
  async bootCleanup(): Promise<string[]> {
    return [];
  }
  async removeWorktreesForSession(): Promise<{ reclaimedBytes: number; remainingRecoveryBranches: string[] }> {
    return { reclaimedBytes: 0, remainingRecoveryBranches: [] };
  }
}

class FakeStaging implements StagingPort {
  async createArea(run: string): Promise<StagingArea> {
    return { run, path: `/stage/${run}` };
  }
  async stageWrite(): Promise<void> {}
  async read(): Promise<string | null> {
    return null;
  }
  async manifest(run: string): Promise<StagingManifest | null> {
    return newManifest(run);
  }
  async apply(): Promise<StagingApplyResult> {
    return { applied: [], blocked: [] };
  }
  async discard(): Promise<void> {}
  async listRuns(): Promise<string[]> {
    return [];
  }
  async bootCleanup(): Promise<string[]> {
    return [];
  }
  async removeForSession(): Promise<{ reclaimedBytes: number; removedRuns: string[] }> {
    return { reclaimedBytes: 0, removedRuns: [] };
  }
}

function cfg(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({ ...overrides });
}

/** A worker model whose AIMessage carries provider usage_metadata (so the §10.14
 * usage middleware extracts real figures), or none (estimated). */
class UsageModel extends BaseChatModel {
  constructor(
    private readonly reply: string,
    private readonly usage: { input: number; output: number } | null,
    params: BaseChatModelParams = {},
  ) {
    super(params);
  }
  _llmType(): string {
    return "usage-model";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const brief = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    if (/Review the work/.test(brief)) {
      return { generations: [{ text: "PASS", message: new AIMessage("PASS") }] };
    }
    if (this.usage) {
      const msg = new AIMessage({
        content: this.reply,
        usage_metadata: { input_tokens: this.usage.input, output_tokens: this.usage.output, total_tokens: this.usage.input + this.usage.output },
      } as never);
      return { generations: [{ text: this.reply, message: msg }] };
    }
    const msg = new AIMessage({ content: this.reply });
    return { generations: [{ text: this.reply, message: msg }] };
  }
}

function makeDeps(partial: Partial<SubagentsDeps> & { vcs: VcsPort }): SubagentsDeps {
  return {
    chatModel: new FakeListChatModel({ responses: ["done"] }),
    guardian: new Guardian(builtinGuardrails()),
    warden: new Warden({ mode: "off" }),
    bus: new EventBus(),
    staging: new FakeStaging(),
    registry: makeRegistry(),
    tempDir: "/ws/tmp",
    window: 32_000,
    getConfig: () => cfg(),
    workspaceRoot: "/ws",
    sessionId: "parent-session",
    interactive: true,
    reviewerModel: new FakeListChatModel({ responses: ["PASS"] }),
    ...partial,
  };
}

const reader: AgentDefinition = { name: "reader", description: "reads", systemPrompt: "read", tools: ["read_file"] };

describe("worker model usage in the trail and parent stats (§10.14)", () => {
  it("emits a per-worker MODEL_USAGE scoped to the parent session, rolled into totals + byAgent", async () => {
    const bus = new EventBus();
    const usageEvents: { session: string; agent?: string; taskId?: string; genMsPresent: boolean; estimated: boolean; input: number; output: number }[] = [];
    bus.subscribe("MODEL_USAGE", (e) => {
      const p = e.payload as Record<string, unknown>;
      const u = (p["usage"] ?? {}) as Record<string, unknown>;
      const agent = p["agent"] as string | undefined;
      const taskId = p["taskId"] as string | undefined;
      usageEvents.push({
        session: String((e.scope as Record<string, unknown>)?.["session"] ?? ""),
        ...(agent !== undefined && { agent }),
        ...(taskId !== undefined && { taskId }),
        genMsPresent: u["genMs"] !== undefined,
        estimated: p["estimated"] === true,
        input: Number(u["inputSum"] ?? 0),
        output: Number(u["completionTokens"] ?? 0),
      });
    });

    const vcs = new FakeVcs();
    const models: Record<string, BaseChatModel> = {
      "ep-sum": new UsageModel("summary", { input: 100, output: 10 }),
      "ep-res": new UsageModel("research", { input: 200, output: 20 }),
      "ep-impl": new UsageModel("impl", null), // reports no usage → estimated
    };
    const sa = new Subagents(makeDeps({ vcs, bus, resolveModel: (k) => models[k] }));
    sa.register({ ...reader, name: "summarizer", model: "ep-sum" });
    sa.register({ ...reader, name: "researcher", model: "ep-res" });
    sa.register({ ...reader, name: "implementer", model: "ep-impl" });

    const result = await sa.dispatch([
      { id: "t1", agent: "summarizer", task: "summarize" },
      { id: "t2", agent: "researcher", task: "research" },
      { id: "t3", agent: "implementer", task: "implement" },
    ]);
    expect(result.workers.every((w) => w.status === "merged")).toBe(true);

    // One MODEL_USAGE per worker, attributed to the worker, on the PARENT scope.
    const byAgent = new Map(usageEvents.map((u) => [u.agent, u]));
    expect(byAgent.has("summarizer")).toBe(true);
    expect(byAgent.has("researcher")).toBe(true);
    expect(byAgent.has("implementer")).toBe(true);
    for (const u of usageEvents) expect(u.session).toBe("parent-session");
    expect(byAgent.get("summarizer")!).toMatchObject({ taskId: "t1", input: 100, output: 10, estimated: false });
    expect(byAgent.get("researcher")!).toMatchObject({ taskId: "t2", input: 200, output: 20, estimated: false });
    expect(byAgent.get("implementer")!.estimated).toBe(true);

    // Build model.usage records the way the obs-writer persists them (agent attr,
    // usage, genMs, estimated) plus the ORCHESTRATOR's own turn — then the §10.14
    // stats builder rolls the fan-out into the parent totals AND byAgent buckets.
    const records: ObsRecord[] = [
      // Orchestrator's own turn.
      usageRecord("chat", { inputTokens: 50, outputTokens: 5, totalTokens: 55, genMs: 500 }, false),
      ...usageEvents.map((u) =>
        usageRecord(u.agent!, { inputTokens: u.input, outputTokens: u.output, totalTokens: u.input + u.output, genMs: u.genMsPresent ? 100 : 0 }, u.estimated),
      ),
    ];
    const report = buildStatsReport(records, { scope: "session" });
    // Totals = orchestrator + the three workers (no double count).
    expect(report.totals.turns).toBe(4);
    expect(report.totals.tokensIn).toBe(50 + 100 + 200 + 0);
    expect(report.totals.tokensOut).toBe(5 + 10 + 20 + 0);
    // byAgent has a bucket per worker AND the orchestrator.
    expect(Object.keys(report.byAgent).sort()).toEqual(["chat", "implementer", "researcher", "summarizer"]);
    expect(report.byAgent["summarizer"]!.tokensOut).toBe(10);
    // tokensPerSecond derives from genMs on a measured bucket.
    expect(report.byAgent["summarizer"]!.tokensPerSecond).toBeCloseTo((10 / 100) * 1000, 5);
    // The implementer bucket is marked estimated.
    expect(report.byAgent["implementer"]!.estimatedTurns).toBe(1);
  });
});

/** Build a `model.usage` ObsRecord the way the obs-writer persists one. */
function usageRecord(agent: string, usage: { inputTokens: number; outputTokens: number; totalTokens: number; genMs: number }, estimated: boolean): ObsRecord {
  return {
    traceId: "parent-session",
    spanId: `span-${agent}-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    status: "ok",
    source: "model",
    name: "model.usage",
    severity: "info",
    attributes: { agent, ...(estimated ? { estimated: true } : {}) },
    model: { name: "fake", protocol: "openai" },
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens, ...(usage.genMs > 0 ? { genMs: usage.genMs } : {}) },
  };
}
