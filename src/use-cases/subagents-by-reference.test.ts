/**
 * Dependency-summary pass-by-reference (core-blueprint.md §7.2): a dependency's
 * result larger than `task.depSummaryMaxChars` is NOT clipped into the
 * dependent's brief — the WHOLE summary is stored in the run cache and the
 * dependent's brief carries a bounded head plus a `read_file` handle; a
 * BY_REFERENCE event fires naming {what, bytes, key}; and the stored copy is
 * secret-masked. Real path through `Subagents.dispatch` with scripted workers.
 */
import { describe, it, expect } from "vitest";
import { BaseChatModel, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
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
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { InMemoryRunCache } from "../adapters/run-cache.js";
import { resolveLimits } from "../entities/limits-resolve.js";
import { LimitsCapability } from "./limits-capability.js";

function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const t of builtinToolDefinitions()) reg.register(t.def, t.exec);
  return reg;
}

class FakeVcs implements VcsPort {
  repo = false;
  isRepo(): boolean { return this.repo; }
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

function cfg(overrides: Partial<Config> = {}): Config { return ConfigSchema.parse({ ...overrides }); }

/** A worker model that replies with a fixed summary; a reviewer prompt answers
 * PASS. Optionally captures the brief that contains `captureMark`. */
class ReplyModel extends BaseChatModel {
  captured = "";
  constructor(private readonly reply: string, private readonly captureMark?: string, params: BaseChatModelParams = {}) { super(params); }
  _llmType(): string { return "reply-model"; }
  override bindTools(): this { return this; }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const brief = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    if (/Review the work/.test(brief)) return { generations: [{ text: "PASS", message: new AIMessage("PASS") }] };
    if (this.captureMark && brief.includes(this.captureMark)) this.captured = brief;
    return { generations: [{ text: this.reply, message: new AIMessage(this.reply) }] };
  }
}

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

describe("Subagents dependency summary pass-by-reference (§7.2)", () => {
  it("stores an oversized dependency summary whole and hands the dependent a handle, masking secrets", async () => {
    const vcs = new FakeVcs();
    const bus = new EventBus();
    const byRef: { what: string; bytes: number; key: string }[] = [];
    bus.subscribe("BY_REFERENCE", (e) => byRef.push(e.payload as { what: string; bytes: number; key: string }));
    const runCache = new InMemoryRunCache({ sessionId: "s1" });
    const limits = new LimitsCapability(resolveLimits([{ layer: "project", limits: { task: { depSummaryMaxChars: 50 } } }]), bus);

    const secret = "ghp_" + "b".repeat(36);
    const bigSummary = "D".repeat(4000) + " token " + secret;
    const capModel = new ReplyModel("summary-C", "task C");
    const probe: Record<string, BaseChatModel> = {
      "ep-a": new ReplyModel(bigSummary),
      "ep-c": capModel,
    };

    const sa = new Subagents(makeDeps({ vcs, bus, runCache, limits, resolveModel: (k) => probe[k] }));
    sa.register({ ...reader, name: "ra", model: "ep-a" });
    sa.register({ ...reader, name: "rc", model: "ep-c" });

    await sa.dispatch([
      { id: "a", agent: "ra", task: "task A" },
      { id: "c", agent: "rc", task: "task C", dependsOn: ["a"] },
    ]);

    const captured = capModel.captured;

    // The dependent's brief carries a handle footer, NOT a bare truncation marker.
    expect(captured).toMatch(/\[summary continues: \d+ bytes at \.voidrift\/cache\/run\/s1\/.+\.txt — read it with read_file\]/);
    expect(captured).not.toContain("[truncated");
    const handle = captured.match(/at (\.voidrift\/cache\/run\/\S+\.txt)/)![1]!;
    const stored = runCache.read(handle)!;
    // The full summary is in the run cache; the secret is masked in the stored copy.
    expect(stored).toContain("D".repeat(4000));
    expect(stored).not.toContain(secret);
    expect(stored).toContain("«redacted:");
    // One BY_REFERENCE record names the dependency summary and the key.
    expect(byRef).toContainEqual(expect.objectContaining({ what: 'dependency "a" summary', key: "task.depSummaryMaxChars" }));
  });
});
