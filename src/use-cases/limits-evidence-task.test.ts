/**
 * Limits conformance at the live use-case sites (core-blueprint.md §13.11):
 *   - the skill-draft EVIDENCE PACKET (`memory.evidencePacketMaxChars`) in
 *     `draftSkillFromSequence` (engine.ts): warn marks visibly + one hit; deny
 *     yields NO draft (null) + one hit — background work never breaks.
 *   - the TASK BRIEF (`task.briefMaxChars`) in `buildTaskTool` (tools/task-tool):
 *     deny refuses the task call BEFORE dispatch with the normal tool error.
 *   - the BATCH RESULT (`task.batchResultMaxChars`) in `renderBatch`: warn marks
 *     visibly + one hit; deny fails the stage and does not deliver the content.
 *   - the DEPENDENCY SUMMARY (`task.depSummaryMaxChars`) in `Subagents.dispatch`:
 *     deny fails the dependent stage; the oversize summary is not delivered.
 *
 * Real use-cases, fakeModel where a model is needed, hermeticTmp for dirs.
 * Each site asserts: exactly ONE LIMIT_HIT, and (warn) the marker names the key.
 *
 * Mutation-prove:
 *   m1 — emit twice: the per-turn dedup collapses to one hit (would fail if a
 *        site called `hit` twice for the same key in one turn).
 *   m2 — ignore deny at the brief site: a dispatch WOULD fire (we assert it does
 *        NOT — the tool returns an error and never calls `dispatch`).
 *   m3 — drop the evidence marker: the warn packet must carry the key marker.
 */
import { describe, it, expect, vi } from "vitest";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { BaseChatModel as BaseChatModelClass, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { draftSkillFromSequence } from "./engine.js";
import { buildTaskTool } from "../tools/task-tool.js";
import { Subagents, type SubagentsDeps } from "./subagents.js";
import type { DispatchRequest, FanoutResult } from "./subagents.js";
import type { AgentDefinition, WorkerInfo } from "../entities/subagents.js";
import { EventBus } from "../entities/event-bus.js";
import { resolveLimits } from "../entities/limits-resolve.js";
import { LimitsCapability } from "./limits-capability.js";
import { ToolRegistry } from "../entities/tool-registry.js";
import { builtinToolDefinitions } from "../tools/builtin.js";
import { Guardian, builtinGuardrails } from "../entities/guardian.js";
import { Warden } from "../entities/warden.js";
import { ConfigSchema, type Config } from "../config/schema.js";
import type { MergeResult, VcsPort, Worktree } from "../entities/ports/vcs-port.js";
import type { StagingApplyResult, StagingArea, StagingPort } from "../entities/ports/staging-port.js";
import { newManifest, type StagingManifest } from "../entities/staging-manifest.js";
import { InMemoryRunCache } from "../adapters/run-cache.js";

// ── Shared helpers ──────────────────────────────────────────────────────────

function limitsFor(bus: EventBus, layer: Record<string, unknown>): LimitsCapability {
  return new LimitsCapability(resolveLimits([{ layer: "project", limits: layer as never }]), bus);
}

function captureHits(bus: EventBus): { key: string; action: string; observed?: number }[] {
  const hits: { key: string; action: string; observed?: number }[] = [];
  bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string; action: string; observed?: number }));
  return hits;
}

/** A fake structured model for the skill-draft seam that records the prompt. */
function fakeStructuredModel(result: unknown, capture: { prompt: string; calls: number }): BaseChatModel {
  return {
    withStructuredOutput: () => ({
      invoke: async (messages: { content: string }[]) => {
        capture.calls += 1;
        capture.prompt = messages[0]!.content;
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
  sessionIds: ["s0"],
  examples: [{ source: "tool", name: "read_file", status: "ok" }],
};

/** A big evidence blob so the fenced JSON exceeds a small cap. */
const bigEvidence = { ...evidence, steps: Array.from({ length: 400 }, (_, i) => `step_${i}(${"x".repeat(40)})`) };

// ── Site 1: skill-draft evidence packet (memory.evidencePacketMaxChars) ───────

describe("§13.11 evidence packet (memory.evidencePacketMaxChars) — draftSkillFromSequence", () => {
  it("warn: packet carries a visible marker naming the key, exactly one LIMIT_HIT, draft still produced", async () => {
    const bus = new EventBus();
    const hits = captureHits(bus);
    const limits = limitsFor(bus, { memory: { evidencePacketMaxChars: { value: 100, action: "warn" } } });
    const capture = { prompt: "", calls: 0 };
    const out = await draftSkillFromSequence(fakeStructuredModel({ title: "T", body: "B" }, capture), bigEvidence, {
      evidencePacketMaxChars: 100,
      limits,
      session: "s1",
    });
    expect(out).toMatchObject({ title: "T" });
    expect(capture.prompt).toContain("[truncated at limits.memory.evidencePacketMaxChars");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.key).toBe("memory.evidencePacketMaxChars");
    expect(hits[0]!.action).toBe("warn");
  });

  it("deny: NO skill draft is produced (null), exactly one LIMIT_HIT, model never called", async () => {
    const bus = new EventBus();
    const hits = captureHits(bus);
    const limits = limitsFor(bus, { memory: { evidencePacketMaxChars: { value: 100, action: "deny" } } });
    const capture = { prompt: "", calls: 0 };
    const out = await draftSkillFromSequence(fakeStructuredModel({ title: "T", body: "B" }, capture), bigEvidence, {
      evidencePacketMaxChars: 100,
      limits,
      session: "s1",
    });
    expect(out).toBeNull();
    expect(capture.calls).toBe(0); // draft not generated → the model seam is never hit
    expect(hits).toHaveLength(1);
    expect(hits[0]!.action).toBe("deny");
  });

  it("m3 (mutation): dropping the evidence marker fails — the warn packet MUST name the key", async () => {
    const bus = new EventBus();
    const limits = limitsFor(bus, { memory: { evidencePacketMaxChars: { value: 100, action: "warn" } } });
    const capture = { prompt: "", calls: 0 };
    await draftSkillFromSequence(fakeStructuredModel({ title: "T", body: "B" }, capture), bigEvidence, {
      evidencePacketMaxChars: 100,
      limits,
    });
    // This assertion is exactly what m3 would break.
    expect(capture.prompt).toContain("limits.memory.evidencePacketMaxChars");
  });
});

// ── Task-tool sites (task.briefMaxChars, task.batchResultMaxChars) ────────────

const workerList = [{ name: "reader", description: "reads" }];

/** A typed `WorkerInfo` builder: a succeeded reader worker carrying `summary`,
 * with the required `workerId`/`pendingApproval` filled with valid values. */
function worker(summary: string, overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return { workerId: "w0", agent: "reader", status: "succeeded", summary, pendingApproval: false, ...overrides };
}

describe("§13.11 task brief (task.briefMaxChars) — buildTaskTool", () => {
  it("deny: the task call is REFUSED before dispatch with a tool error carrying the notice, exactly one hit", async () => {
    const bus = new EventBus();
    const hits = captureHits(bus);
    const limits = limitsFor(bus, { task: { briefMaxChars: { value: 20, action: "deny" } } });
    const dispatch = vi.fn(async (): Promise<FanoutResult> => ({ fanoutId: "f", workers: [] }));
    const tool = buildTaskTool({ workers: workerList, dispatch, limits, sessionId: "s1" });
    const res = (await tool.invoke(
      { worker: "reader", task: "x".repeat(200) },
      { toolCall: { id: "c1" } } as never,
    )) as { content: string; status?: string };
    expect(dispatch).not.toHaveBeenCalled(); // refused BEFORE dispatch
    expect(res.status).toBe("error");
    expect(res.content).toContain("limits.task.briefMaxChars");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.action).toBe("deny");
  });

  it("m2 (mutation): if deny were ignored at the brief site, dispatch WOULD fire — we assert it does NOT", async () => {
    const bus = new EventBus();
    const limits = limitsFor(bus, { task: { briefMaxChars: { value: 20, action: "deny" } } });
    const dispatch = vi.fn(async (): Promise<FanoutResult> => ({ fanoutId: "f", workers: [] }));
    const tool = buildTaskTool({ workers: workerList, dispatch, limits });
    await tool.invoke({ worker: "reader", task: "y".repeat(200) }, { toolCall: { id: "c2" } } as never);
    expect(dispatch).toHaveBeenCalledTimes(0);
  });

  it("warn: the brief is clipped with a marker naming the key and the task IS dispatched", async () => {
    const bus = new EventBus();
    const hits = captureHits(bus);
    const limits = limitsFor(bus, { task: { briefMaxChars: { value: 20, action: "warn" } } });
    let seen = "";
    const dispatch = vi.fn(async (reqs: DispatchRequest[]): Promise<FanoutResult> => {
      seen = reqs[0]!.task;
      return { fanoutId: "f", workers: [worker("ok")] };
    });
    const tool = buildTaskTool({ workers: workerList, dispatch, limits });
    await tool.invoke({ worker: "reader", task: "z".repeat(200) }, { toolCall: { id: "c3" } } as never);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(seen).toContain("[truncated at limits.task.briefMaxChars");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.action).toBe("warn");
  });
});

describe("§13.11 batch result (task.batchResultMaxChars) — renderBatch via buildTaskTool", () => {
  it("warn: the batch result is clipped with a marker naming the key, exactly one hit", async () => {
    const bus = new EventBus();
    const hits = captureHits(bus);
    const limits = limitsFor(bus, { task: { batchResultMaxChars: { value: 30, action: "warn" } } });
    const dispatch = vi.fn(async (): Promise<FanoutResult> => ({
      fanoutId: "f",
      workers: [{ ...worker("R".repeat(300)), taskId: "a" }],
    }));
    const tool = buildTaskTool({ workers: workerList, dispatch, limits });
    const res = (await tool.invoke(
      { tasks: [{ id: "a", worker: "reader", task: "do a" }] },
      { toolCall: { id: "c4" } } as never,
    )) as { content: string };
    expect(res.content).toContain("[truncated at limits.task.batchResultMaxChars");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.action).toBe("warn");
  });

  it("deny: the stage fails and the oversize content is NOT delivered, exactly one hit", async () => {
    const bus = new EventBus();
    const hits = captureHits(bus);
    const limits = limitsFor(bus, { task: { batchResultMaxChars: { value: 30, action: "deny" } } });
    const big = "R".repeat(300);
    const dispatch = vi.fn(async (): Promise<FanoutResult> => ({
      fanoutId: "f",
      workers: [{ ...worker(big), taskId: "a" }],
    }));
    const tool = buildTaskTool({ workers: workerList, dispatch, limits });
    const res = (await tool.invoke(
      { tasks: [{ id: "a", worker: "reader", task: "do a" }] },
      { toolCall: { id: "c5" } } as never,
    )) as { content: string; status?: string };
    expect(res.status).toBe("error");
    expect(res.content).toContain("limits.task.batchResultMaxChars");
    expect(res.content).not.toContain(big); // oversize content not delivered
    expect(hits).toHaveLength(1);
    expect(hits[0]!.action).toBe("deny");
  });

  it("m1 (mutation): two oversize rows for the SAME key emit ONE LIMIT_HIT (per-turn dedup)", async () => {
    const bus = new EventBus();
    const hits = captureHits(bus);
    const limits = limitsFor(bus, { task: { batchResultMaxChars: { value: 30, action: "warn" } } });
    const dispatch = vi.fn(async (): Promise<FanoutResult> => ({
      fanoutId: "f",
      workers: [
        { ...worker("A".repeat(300)), taskId: "a" },
        { ...worker("B".repeat(300)), taskId: "b" },
      ],
    }));
    const tool = buildTaskTool({ workers: workerList, dispatch, limits });
    await tool.invoke(
      { tasks: [{ id: "a", worker: "reader", task: "do a" }, { id: "b", worker: "reader", task: "do b" }] },
      { toolCall: { id: "c6" } } as never,
    );
    expect(hits).toHaveLength(1); // m1 breaks this if a site emits twice
  });
});

// ── Subagents site: dependency summary (task.depSummaryMaxChars) deny ─────────

class FakeVcs implements VcsPort {
  isRepo(): boolean { return false; }
  async currentBranch(): Promise<string | null> { return "main"; }
  async workingDiff(): Promise<string> { return ""; }
  async listFiles(): Promise<string[] | null> { return []; }
  async createWorktree(id: string): Promise<Worktree> { return { id, path: `/wt/${id}`, branch: `voidrift-run-${id}` }; }
  async mergeWorktree(): Promise<MergeResult> { return { merged: true }; }
  async abandonWorktree(wt: Worktree): Promise<string> { return `voidrift-recovery-${wt.id}`; }
  preserveWorktree(wt: Worktree): string { return wt.path; }
  async bootCleanup(): Promise<string[]> { return []; }
  async removeWorktreesForSession(): Promise<{ reclaimedBytes: number; remainingRecoveryBranches: string[] }> { return { reclaimedBytes: 0, remainingRecoveryBranches: [] }; }
}

class FakeStaging implements StagingPort {
  async createArea(run: string): Promise<StagingArea> { return { run, path: `/stage/${run}` }; }
  async stageWrite(): Promise<void> {}
  async read(): Promise<string | null> { return null; }
  async manifest(run: string): Promise<StagingManifest | null> { return newManifest(run); }
  async apply(): Promise<StagingApplyResult> { return { applied: [], blocked: [] }; }
  async discard(): Promise<void> {}
  async listRuns(): Promise<string[]> { return []; }
  async bootCleanup(): Promise<string[]> { return []; }
  async removeForSession(): Promise<{ reclaimedBytes: number; removedRuns: string[] }> { return { reclaimedBytes: 0, removedRuns: [] }; }
}

class ReplyModel extends BaseChatModelClass {
  constructor(private readonly reply: string, params: BaseChatModelParams = {}) { super(params); }
  _llmType(): string { return "reply-model"; }
  override bindTools(): this { return this; }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const brief = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    if (/Review the work/.test(brief)) return { generations: [{ text: "PASS", message: new AIMessage("PASS") }] };
    return { generations: [{ text: this.reply, message: new AIMessage(this.reply) }] };
  }
}

function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const t of builtinToolDefinitions()) reg.register(t.def, t.exec);
  return reg;
}
function cfg(overrides: Partial<Config> = {}): Config { return ConfigSchema.parse({ ...overrides }); }
const reader: AgentDefinition = { name: "reader", description: "reads", systemPrompt: "read", tools: ["read_file"] };

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
    sessionId: "s1",
    interactive: true,
    reviewerModel: new FakeListChatModel({ responses: ["PASS"] }),
    ...partial,
  };
}

describe("§13.11 dependency summary (task.depSummaryMaxChars) deny — Subagents.dispatch", () => {
  it("deny: the dependent stage FAILS, the oversize summary is not delivered, exactly one hit", async () => {
    const bus = new EventBus();
    const hits = captureHits(bus);
    const runCache = new InMemoryRunCache({ sessionId: "s1" });
    const limits = limitsFor(bus, { task: { depSummaryMaxChars: { value: 30, action: "deny" } } });
    const big = "D".repeat(400);
    const probe: Record<string, BaseChatModel> = { "ep-a": new ReplyModel(big), "ep-c": new ReplyModel("summary-C") };
    const sa = new Subagents(makeDeps({ vcs: new FakeVcs(), bus, runCache, limits, resolveModel: (k) => probe[k]! }));
    sa.register({ ...reader, name: "ra", model: "ep-a" });
    sa.register({ ...reader, name: "rc", model: "ep-c" });

    const out = await sa.dispatch([
      { id: "a", agent: "ra", task: "task A" },
      { id: "c", agent: "rc", task: "task C", dependsOn: ["a"] },
    ]);

    const dependent = out.workers.find((w) => w.taskId === "c")!;
    expect(dependent.status).toBe("failed");
    expect(dependent.summary ?? "").toContain("limits.task.depSummaryMaxChars");
    expect(dependent.summary ?? "").not.toContain(big); // oversize content not delivered
    const depHits = hits.filter((h) => h.key === "task.depSummaryMaxChars");
    expect(depHits).toHaveLength(1);
    expect(depHits[0]!.action).toBe("deny");
  });
});
