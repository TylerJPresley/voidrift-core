/**
 * Per-dispatch / worker events reach the OWNER session's subscribers
 * (core-blueprint.md §7.2, §14.6 — the `worker` scope belongs to a session, and
 * that session is the OWNER session, not the long-lived manager's own
 * `sessionId`).
 *
 * The regression this guards: Subagents is constructed with
 * `sessionId: "orchestrator"` (boot.ts) while the live owner is a real session
 * id resolved through `getOwnerSessionId()`. When the per-worker events
 * (WORKER_STATUS_CHANGED, PERMISSION_REQUESTED/RESOLVED) were scoped to
 * `this.deps.sessionId` they carried `session: "orchestrator"`, so a CLI
 * subscribed to the real session (`{ session: <owner> }`) never received them —
 * the live fan-out panel rows stayed `Waiting` for the whole run even though the
 * workers ran (real sessions 81ba35af / 76c2f9f3). Earlier panel tests used
 * synthetic events and set `sessionId` directly to the owner, so the divergence
 * was never exercised.
 *
 * Offline/deterministic: a scripted worker model (`fakeModel`) drives one real
 * tool call per worker; no network, no real git (a FakeVcs with no repo stages
 * in memory).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { Guardian, builtinGuardrails } from "../entities/guardian.js";
import { Warden } from "../entities/warden.js";
import { EventBus, type EventEnvelope } from "../entities/event-bus.js";
import { ConfigSchema, type Config } from "../config/schema.js";
import type { MergeResult, VcsPort, Worktree } from "../entities/ports/vcs-port.js";
import type { StagingApplyResult, StagingArea, StagingPort } from "../entities/ports/staging-port.js";
import { newManifest, type StagingManifest } from "../entities/staging-manifest.js";
import { Subagents, type SubagentsDeps } from "./subagents.js";
import type { AgentDefinition } from "../entities/subagents.js";
import { ToolRegistry } from "../entities/tool-registry.js";
import { builtinToolDefinitions } from "../tools/builtin.js";

function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const t of builtinToolDefinitions()) reg.register(t.def, t.exec);
  return reg;
}

/** No-repo VCS: a write worker stages in memory, so no real git is touched. */
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

const OWNER = "owner-sess";
const workerModels = new Map<string, ReturnType<typeof fakeModel>>();

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
    // The manager's OWN id is NOT the owner session — exactly the boot.ts wiring.
    sessionId: "orchestrator",
    getOwnerSessionId: () => OWNER,
    interactive: true,
    reviewerModel: new FakeListChatModel({ responses: ["PASS"] }),
    resolveModel: (k: string) => workerModels.get(k),
    ...partial,
  };
}

/** A worker whose own model (a config endpoint key) makes a gated write call
 * then replies done, so one approval round and a running→terminal lifecycle run
 * per worker. */
function coder(name: string, writePath: string): AgentDefinition {
  const key = `${name}-ep`;
  workerModels.set(
    key,
    fakeModel()
      .respondWithTools([{ name: "write_file", args: { path: writePath, content: "x" } }])
      .respond(new AIMessage("done")),
  );
  return { name, description: "writes", systemPrompt: "code", tools: ["read_file", "write_file"], model: key };
}

describe("per-worker events reach the OWNER session (§7.2, §14.6)", () => {
  beforeEach(() => workerModels.clear());

  it("delivers WORKER_STATUS_CHANGED and worker PERMISSION_REQUESTED/RESOLVED to a listener scoped to the owner session, never 'orchestrator'", async () => {
    const bus = new EventBus();
    // A grant would auto-approve the write (no ask); force the ask path so the
    // worker PERMISSION_REQUESTED/RESOLVED pair is emitted (§9.5).
    const guardian = new Guardian(builtinGuardrails());
    guardian.hasFanoutGrant = () => false;

    // The CLI's own subscription shape: scoped to the REAL (owner) session.
    const ownerEvents: EventEnvelope[] = [];
    bus.subscribe("*", (e) => ownerEvents.push(e), { scope: { session: OWNER } });
    // An unscoped audit listener to prove no per-worker event leaks under
    // 'orchestrator'.
    const stray: EventEnvelope[] = [];
    bus.subscribe("*", (e) => {
      if (e.scope.session === "orchestrator") stray.push(e);
    });

    const vcs = new FakeVcs();
    const sa = new Subagents(
      makeDeps({
        vcs,
        bus,
        guardian,
        requestWorkerApproval: async (p) => ({ requestId: p.id, decision: "approve" }),
      }),
    );
    sa.register(coder("alpha", "a.txt"));
    sa.register(coder("beta", "b.txt"));

    const result = await sa.dispatch([
      { id: "t1", agent: "alpha", task: "task A" },
      { id: "t2", agent: "beta", task: "task B" },
    ]);
    expect(result.workers).toHaveLength(2);

    const ofType = (t: string) => ownerEvents.filter((e) => e.type === t);
    const status = ofType("WORKER_STATUS_CHANGED").map((e) => e.payload as Record<string, unknown>);
    const requested = ofType("PERMISSION_REQUESTED");
    const resolved = ofType("PERMISSION_RESOLVED");

    // Owner-scoped listener saw the worker lifecycle: running → a terminal state
    // (merged for a no-conflict staged worker), carrying agent + taskId.
    expect(status.some((p) => p["status"] === "running")).toBe(true);
    expect(status.some((p) => p["status"] === "merged")).toBe(true);
    expect(status.some((p) => p["agent"] === "alpha" && p["taskId"] === "t1")).toBe(true);
    expect(status.some((p) => p["agent"] === "beta" && p["taskId"] === "t2")).toBe(true);
    // And the worker approval pair reached the owner session, worker-scoped.
    expect(requested.length).toBeGreaterThanOrEqual(1);
    expect(resolved.length).toBeGreaterThanOrEqual(1);
    expect(requested.every((e) => e.scope.worker !== undefined)).toBe(true);

    // NOTHING per-worker leaked under the manager's own 'orchestrator' id.
    const strayTypes = new Set(stray.map((e) => e.type));
    expect(strayTypes.has("WORKER_STATUS_CHANGED")).toBe(false);
    expect(strayTypes.has("PERMISSION_REQUESTED")).toBe(false);
    expect(strayTypes.has("PERMISSION_RESOLVED")).toBe(false);
  });

  it("emits a WORKER_STATUS_CHANGED carrying the current `tool` as a worker starts a tool call (§14.6 — the panel's current-tool line)", async () => {
    const bus = new EventBus();
    const ownerEvents: EventEnvelope[] = [];
    bus.subscribe("WORKER_STATUS_CHANGED", (e) => ownerEvents.push(e), { scope: { session: OWNER } });

    const vcs = new FakeVcs();
    const sa = new Subagents(
      makeDeps({
        vcs,
        bus,
        requestWorkerApproval: async (p) => ({ requestId: p.id, decision: "approve" }),
      }),
    );
    sa.register(coder("alpha", "a.txt"));

    await sa.dispatch([{ id: "t1", agent: "alpha", task: "task A" }]);

    // A running status carrying the tool name the worker is calling (write_file),
    // so a monitor can show "Write"/"Run"/… per tool call, not just at dispatch.
    const withTool = ownerEvents
      .map((e) => e.payload as Record<string, unknown>)
      .filter((p) => p["status"] === "running" && typeof p["tool"] === "string");
    expect(withTool.some((p) => p["tool"] === "write_file")).toBe(true);
  });
});
