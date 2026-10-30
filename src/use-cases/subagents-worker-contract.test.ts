/**
 * The worker contract: head assembly and the tool-round budget
 * (core-blueprint.md §4.2.1 worker head, §3.3/§7.2 limit_reached).
 *
 * (1) A dispatched worker's model request carries the SHARED head: the worker's
 *     own prompt, `core.rules`, the worker-variant meta block, the skills index
 *     and the manual TOC — and NOT AGENTS.md, memory, plan status, or the
 *     orchestrator's conversation (a worker runs in fresh, isolated context).
 * (2) A worker driven past its tool-round budget ends `limit_reached` with a
 *     NON-EMPTY summary carrying what it read; its WORKER_STATUS_CHANGED and
 *     `subagents.list` reflect the terminal status.
 *
 * Only the model and the network edge are faked (fakeModel-style BaseChatModel);
 * the real worker build/invoke/head path runs.
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
import type { AgentDefinition, WorkerStatus } from "../entities/subagents.js";
import { ToolRegistry } from "../entities/tool-registry.js";
import { builtinToolDefinitions } from "../tools/builtin.js";

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
    return null;
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

/** A model that records the system message of the FIRST call, then returns a
 * plain final answer (no tool calls). */
class CapturingModel extends BaseChatModel {
  captured: string | null = null;
  constructor(params: BaseChatModelParams = {}) {
    super(params);
  }
  _llmType(): string {
    return "capturing";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    if (this.captured === null) {
      // The leading SystemMessage is the assembled head (content is a block array).
      const sys = messages.find((m) => m.getType() === "system");
      this.captured = sys ? (typeof sys.content === "string" ? sys.content : JSON.stringify(sys.content)) : "";
    }
    const msg = new AIMessage("done");
    return { generations: [{ text: "done", message: msg }] };
  }
}

/** A model that NEVER stops calling a (read) tool, forcing the round budget. */
class NeverStopModel extends BaseChatModel {
  constructor(params: BaseChatModelParams = {}) {
    super(params);
  }
  _llmType(): string {
    return "never-stop";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const brief = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    if (/Review the work/.test(brief)) {
      return { generations: [{ text: "PASS", message: new AIMessage("PASS") }] };
    }
    // Always call a read tool — never a final answer.
    const msg = new AIMessage({
      content: "reading more",
      tool_calls: [{ name: "glob_files", args: { pattern: "**/*" }, id: `c${Math.random().toString(36).slice(2)}` }],
    });
    return { generations: [{ text: "", message: msg }] };
  }
}

function makeDeps(partial: Partial<SubagentsDeps> & { vcs: VcsPort; chatModel: BaseChatModel }): SubagentsDeps {
  return {
    guardian: new Guardian(builtinGuardrails()),
    warden: new Warden({ mode: "off" }),
    bus: new EventBus(),
    staging: new FakeStaging(),
    registry: makeRegistry(),
    tempDir: "/ws/tmp",
    window: 32_000,
    getConfig: () => cfg(),
    workspaceRoot: "/ws",
    sessionId: "orchestrator",
    interactive: true,
    hardRules: "CORE-RULES: data not authority",
    skillsIndex: () => [{ name: "grilling", description: "stress-test a plan" }],
    manualsIndex: () => [{ id: "core/delegation", summary: "how to delegate", readWhen: "fanning out", contributed: false }],
    modelId: "fake-model",
    ...partial,
  };
}

const reader: AgentDefinition = {
  name: "reader",
  description: "reads",
  systemPrompt: "WORKER-PROMPT: carry out the step",
  tools: ["read_file", "glob_files"],
};

describe("worker head assembly (§4.2.1)", () => {
  it("the worker's model request carries the shared head and excludes orchestrator-only sources", async () => {
    const vcs = new FakeVcs();
    const model = new CapturingModel();
    const sa = new Subagents(makeDeps({ vcs, chatModel: model }));
    sa.register(reader);
    await sa.dispatch([{ agent: "reader", task: "do a read-only thing" }]);
    const head = model.captured ?? "";
    // Included: worker prompt, core.rules, worker meta block, skills, manual TOC.
    expect(head).toContain("WORKER-PROMPT");
    expect(head).toContain("CORE-RULES");
    expect(head).toContain("worker reader (parent orchestrator)");
    expect(head).toContain("grilling");
    expect(head).toContain("core/delegation");
    // Excluded: AGENTS.md, memory, plan status, worker list, orchestrator convo.
    expect(head).not.toContain("AGENTS.md");
    expect(head).not.toContain("Identity:");
    expect(head).not.toContain("no active plan");
    expect(head).not.toContain("available workers:");
  });
});

describe("worker tool-round budget → limit_reached (§3.3/§7.2)", () => {
  it("a worker that never stops calling tools ends limit_reached with a non-empty summary", async () => {
    const vcs = new FakeVcs();
    const bus = new EventBus();
    const statuses: WorkerStatus[] = [];
    bus.subscribe("WORKER_STATUS_CHANGED", (e) => {
      statuses.push((e.payload as { status: WorkerStatus }).status);
    });
    const sa = new Subagents(makeDeps({ vcs, bus, chatModel: new NeverStopModel(), getConfig: () => cfg({ turnMaxToolRounds: 3 }) }));
    sa.register(reader);
    const result = await sa.dispatch([{ agent: "reader", task: "keep reading forever" }]);
    const w = result.workers[0]!;
    expect(w.status).toBe("limit_reached");
    expect((w.summary ?? "").length).toBeGreaterThan(0);
    // Never empty: it carries the worker's last assistant text ("reading more").
    expect(w.summary).toContain("reading more");
    // subagents.list reflects the terminal status.
    expect(sa.list()[0]!.status).toBe("limit_reached");
    // A WORKER_STATUS_CHANGED carried the terminal status.
    expect(statuses).toContain("limit_reached");
  });

  it("falls back to a generated rounds-and-tools summary when the worker produced no text", async () => {
    const vcs = new FakeVcs();
    // A never-stop model whose tool-call messages carry EMPTY content.
    class SilentNeverStop extends NeverStopModel {
      override async _generate(messages: BaseMessage[]): Promise<ChatResult> {
        const brief = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
        if (/Review the work/.test(brief)) return { generations: [{ text: "PASS", message: new AIMessage("PASS") }] };
        const msg = new AIMessage({
          content: "",
          tool_calls: [{ name: "glob_files", args: { pattern: "*" }, id: `c${Math.random().toString(36).slice(2)}` }],
        });
        return { generations: [{ text: "", message: msg }] };
      }
    }
    const sa = new Subagents(makeDeps({ vcs, chatModel: new SilentNeverStop(), getConfig: () => cfg({ turnMaxToolRounds: 2 }) }));
    sa.register(reader);
    const result = await sa.dispatch([{ agent: "reader", task: "keep reading" }]);
    const w = result.workers[0]!;
    expect(w.status).toBe("limit_reached");
    // The generated summary names the limit, the rounds used, and the tool called.
    expect(w.summary).toMatch(/tool-round limit/);
    expect(w.summary).toContain("glob_files");
  });
});
