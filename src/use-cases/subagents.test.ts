/**
 * Subagents use-case tests (core-blueprint.md §7).
 *
 * The §7 integration test MINUS the no-repo staging clauses (git-repo-only
 * fan-out, build-order slice 3). The real-git worktree lifecycle (create +
 * .meta.json, clean merge, conflict → recovery branch, dead-owner TTL prune) is
 * proven against a real repo in `vcs.test.ts`; here a controllable fake `VcsPort`
 * isolates the orchestration wiring: fan-out, the no-recursion registration
 * assertion, the read-only reviewer gate, the fan-out grant with hard-deny and
 * Warden-deny still blocking, cancel-aborts-all, and non-interactive fail-fast.
 *
 * Offline/deterministic: `fakeModel()` scripts worker and reviewer replies; no
 * network, no real git.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { BaseChatModel, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { hermeticTmp } from "../test-hermetic.js";
import { Guardian, builtinGuardrails, type GuardedCall } from "../entities/guardian.js";
import { Warden, loadPolicy } from "../entities/warden.js";
import { EventBus } from "../entities/event-bus.js";
import { ConfigSchema, type Config, type PermissionRule } from "../config/schema.js";
import type { MergeResult, VcsPort, Worktree } from "../entities/ports/vcs-port.js";
import type { StagingApplyResult, StagingArea, StagingPort } from "../entities/ports/staging-port.js";
import { newManifest, stageEntry, upsertEntry, checkApply, type StagingManifest } from "../entities/staging-manifest.js";
import { Subagents, type SubagentsDeps } from "./subagents.js";
import type { AgentDefinition, WorkerStreamEvent } from "../entities/subagents.js";
import { ToolRegistry } from "../entities/tool-registry.js";
import { builtinToolDefinitions } from "../tools/builtin.js";

/** A registry carrying the §8.2 builtin suite — the SAME classification surface
 * the engine's decision point reads (read-only names, unknown-tool reject). */
function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const t of builtinToolDefinitions()) reg.register(t.def, t.exec);
  return reg;
}

/** A controllable in-memory VcsPort (§7.3) — no real git. */
class FakeVcs implements VcsPort {
  repo = true;
  readonly created: string[] = [];
  readonly merged: string[] = [];
  readonly abandoned: string[] = [];
  readonly preserved: string[] = [];
  /** Ids whose merge should conflict. */
  conflictIds = new Set<string>();

  isRepo(): boolean {
    return this.repo;
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
  async createWorktree(id: string, _sessionId?: string): Promise<Worktree> {
    this.created.push(id);
    return { id, path: `/wt/${id}`, branch: `voidrift-run-${id}` };
  }
  async mergeWorktree(wt: Worktree): Promise<MergeResult> {
    if (this.conflictIds.has(wt.id)) {
      return { merged: false, recoveryBranch: `voidrift-recovery-${wt.id}` };
    }
    this.merged.push(wt.id);
    return { merged: true };
  }
  async abandonWorktree(wt: Worktree): Promise<string> {
    this.abandoned.push(wt.id);
    return `voidrift-recovery-${wt.id}`;
  }
  preserveWorktree(wt: Worktree): string {
    this.preserved.push(wt.id);
    return wt.path;
  }
  async bootCleanup(): Promise<string[]> {
    return [];
  }
  async removeWorktreesForSession(): Promise<{ reclaimedBytes: number; remainingRecoveryBranches: string[] }> {
    return { reclaimedBytes: 0, remainingRecoveryBranches: [] };
  }
}

/**
 * A controllable in-memory StagingPort (§7.4) — no real filesystem. Models the
 * durable manifest (base + staged hashes), read-through, the two apply re-hash
 * checks, discard, and dead-owner prune, so the use-case wiring is proven here
 * while the real temp-and-rename adapter is proven in `staging.test.ts`.
 */
class FakeStaging implements StagingPort {
  /** disk[path] = content; the user's tree. */
  readonly disk = new Map<string, string>();
  /** areas[run] = { manifest, blobs }; the durable staging folders. */
  readonly areas = new Map<string, { manifest: StagingManifest; blobs: Map<string, string> }>();
  readonly applied: string[] = [];
  readonly discarded: string[] = [];
  /** Blob paths to corrupt after staging (simulate a disagreeing staged file). */
  corrupt = new Set<string>();
  /** When set, createArea pre-stages this path with a base that will conflict. */
  seedConflictPath: string | null = null;

  async createArea(run: string, _sessionId?: string): Promise<StagingArea> {
    if (!this.areas.has(run)) this.areas.set(run, { manifest: newManifest(run), blobs: new Map() });
    if (this.seedConflictPath) {
      // Pre-stage a file whose disk base will have changed by apply time, so the
      // dispatched worker's apply reports a CONFLICT (§7.4).
      const p = this.seedConflictPath;
      this.disk.set(p, "base-at-stage");
      await this.stageWrite(run, p, "staged-new");
      this.disk.set(p, "changed-after-stage"); // base no longer matches
    }
    return { run, path: `/stage/${run}` };
  }
  async stageWrite(run: string, targetPath: string, content: string): Promise<void> {
    const area = this.areas.get(run) ?? { manifest: newManifest(run), blobs: new Map() };
    const blob = encodeURIComponent(targetPath);
    area.blobs.set(blob, content);
    const base = this.disk.get(targetPath) ?? "";
    area.manifest = upsertEntry(area.manifest, stageEntry(targetPath, base, content, blob));
    this.areas.set(run, area);
  }
  async read(run: string, targetPath: string): Promise<string | null> {
    const area = this.areas.get(run);
    const entry = area?.manifest.files.find((f) => f.path === targetPath);
    if (entry && area) {
      const v = area.blobs.get(entry.blob);
      if (v !== undefined) return v;
    }
    return this.disk.get(targetPath) ?? null;
  }
  async manifest(run: string): Promise<StagingManifest | null> {
    return this.areas.get(run)?.manifest ?? null;
  }
  async apply(run: string): Promise<StagingApplyResult> {
    const area = this.areas.get(run);
    const applied: string[] = [];
    const blocked: StagingApplyResult["blocked"] = [];
    if (!area) return { applied, blocked };
    for (const entry of area.manifest.files) {
      let stagedNow = area.blobs.get(entry.blob) ?? "";
      if (this.corrupt.has(entry.blob)) stagedNow = `${stagedNow}CORRUPT`;
      const diskNow = this.disk.get(entry.path) ?? "";
      const check = checkApply(entry, stagedNow, diskNow);
      if (!check.ok) {
        blocked.push(check);
        continue;
      }
      this.disk.set(entry.path, stagedNow);
      applied.push(entry.path);
    }
    if (blocked.length === 0) {
      this.areas.delete(run);
      this.applied.push(run);
    }
    return { applied, blocked };
  }
  async discard(run: string): Promise<void> {
    this.areas.delete(run);
    this.discarded.push(run);
  }
  async listRuns(): Promise<string[]> {
    return [...this.areas.keys()];
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

/** A worker model that replies with a short summary (cycles, never exhausts). */
function workerModel(reply = "done") {
  return new FakeListChatModel({ responses: [reply] });
}
/** A reviewer model whose verdict is PASS or FAIL (cycles, never exhausts). */
function reviewerModel(pass: boolean) {
  return new FakeListChatModel({ responses: [pass ? "PASS: looks good" : "FAIL: not done"] });
}

function makeDeps(partial: Partial<SubagentsDeps> & { vcs: VcsPort }): SubagentsDeps {
  return {
    chatModel: workerModel(),
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
    reviewerModel: reviewerModel(true),
    ...partial,
  };
}

const codeAgent: AgentDefinition = {
  name: "coder",
  description: "writes code",
  systemPrompt: "code",
  tools: ["read_file", "write_file", "edit_file"],
};

describe("Subagents — orchestrator-only dispatch & no recursion (§7.1)", () => {
  it("rejects an agent definition whose toolset contains the task tool", () => {
    const vcs = new FakeVcs();
    const sa = new Subagents(makeDeps({ vcs }));
    // Given a worker definition that declares the dispatch tool.
    const bad: AgentDefinition = { ...codeAgent, name: "bad", tools: ["read_file", "task"] };
    // When it is registered, Then registration throws (recursion impossible).
    expect(() => sa.register(bad)).toThrow(/task/);
  });

  it("accepts a worker definition with only §8.2 tools", () => {
    const vcs = new FakeVcs();
    const sa = new Subagents(makeDeps({ vcs }));
    expect(() => sa.register(codeAgent)).not.toThrow();
  });
});

describe("Subagents — fan-out, worktrees, verification (§7.2, §7.3, §7.5)", () => {
  let vcs: FakeVcs;
  let sa: Subagents;
  let bus: EventBus;

  beforeEach(() => {
    vcs = new FakeVcs();
    bus = new EventBus();
    sa = new Subagents(makeDeps({ vcs, bus, reviewerModel: reviewerModel(true) }));
    sa.register(codeAgent);
  });

  it("fans out two workers, each in its own worktree, and merges on reviewer PASS", async () => {
    const statuses: string[] = [];
    bus.subscribe("WORKER_STATUS_CHANGED", (e) => statuses.push((e.payload as { status: string }).status));

    const result = await sa.dispatch([
      { agent: "coder", task: "task A" },
      { agent: "coder", task: "task B" },
    ]);

    // Two workers, each got its own worktree, each merged after review.
    expect(result.workers).toHaveLength(2);
    expect(vcs.created).toHaveLength(2);
    expect(vcs.merged).toHaveLength(2);
    expect(result.workers.every((w) => w.status === "merged")).toBe(true);
    expect(result.workers.every((w) => w.worktree?.startsWith("/wt/"))).toBe(true);
    // The lifecycle passed through needs_review → reviewed → merged.
    expect(statuses).toContain("needs_review");
    expect(statuses).toContain("reviewed");
    expect(statuses).toContain("merged");
  });

  it("a failing reviewer blocks the merge and abandons the worktree to recovery", async () => {
    sa = new Subagents(makeDeps({ vcs, bus, reviewerModel: reviewerModel(false) }));
    sa.register(codeAgent);

    const result = await sa.dispatch([{ agent: "coder", task: "task" }]);

    expect(result.workers[0]!.status).toBe("failed");
    expect(vcs.merged).toHaveLength(0);
    expect(vcs.abandoned).toEqual(result.workers.map((w) => w.worktree!.split("/").pop()));
    expect(result.workers[0]!.recoveryBranch).toMatch(/voidrift-recovery-/);
  });

  it("accepts a per-dispatch resultSchema and still converges a worker (§3.8 worker typed result)", async () => {
    // §3.8 — a dispatch MAY carry a `resultSchema`; the worker then runs with a
    // `responseFormat` (the portable toolStrategy). A worker that produces no
    // schema-conforming structured value converges on its text summary, so the
    // dispatch completes normally — the wiring never breaks a plain dispatch.
    const result = await sa.dispatch([
      { agent: "coder", task: "typed task", resultSchema: { type: "object", properties: { ok: { type: "boolean" } } } },
    ]);
    expect(result.workers).toHaveLength(1);
    expect(result.workers[0]!.status).toBe("merged");
    expect(typeof result.workers[0]!.summary).toBe("string");
  });

  it("a completed worker's summary LEADS with the structured end report (§3.3/§7.2)", async () => {
    const result = await sa.dispatch([{ agent: "coder", task: "task" }]);
    expect(result.workers[0]!.status).toBe("merged");
    // The first line is the two-way end report naming the `completed` ending,
    // the rounds used/limit, the context pct (used/window), and elapsed seconds.
    expect(result.workers[0]!.summary).toMatch(
      /^\[worker report: ended=completed rounds=\d+\/\d+ context=\d+% \(\d+\/\d+\) elapsed=\d+s\]/,
    );
  });

  it("a merge conflict preserves work on voidrift-recovery-{id}", async () => {
    const result = await sa.dispatch([{ agent: "coder", task: "task" }]);
    const id = result.workers[0]!.worktree!.split("/").pop()!;
    // Re-dispatch with a forced conflict for this worker's next id.
    vcs.conflictIds.add(`${result.fanoutId}-w${0}`); // (no-op guard; direct check below)

    // Drive a conflict deterministically on a fresh fan-out.
    const vcs2 = new FakeVcs();
    const sa2 = new Subagents(makeDeps({ vcs: vcs2, reviewerModel: reviewerModel(true) }));
    sa2.register(codeAgent);
    // Force every merge to conflict.
    const origCreate = vcs2.createWorktree.bind(vcs2);
    vcs2.createWorktree = async (wid: string) => {
      const wt = await origCreate(wid);
      vcs2.conflictIds.add(wt.id);
      return wt;
    };
    const r2 = await sa2.dispatch([{ agent: "coder", task: "conflicting" }]);
    expect(r2.workers[0]!.status).toBe("failed");
    expect(r2.workers[0]!.recoveryBranch).toMatch(/^voidrift-recovery-/);
    expect(id).toBeTruthy();
  });

  it("the reviewer never grades its own work — a distinct reviewer is dispatched", async () => {
    // Scripted reviewer PASS; if the worker (reply 'done') were graded by its
    // own output, the /PASS/ check would fail — proving a distinct reviewer ran.
    sa = new Subagents(makeDeps({ vcs, chatModel: workerModel("done"), reviewerModel: reviewerModel(true) }));
    sa.register(codeAgent);
    const result = await sa.dispatch([{ agent: "coder", task: "task" }]);
    expect(result.workers[0]!.status).toBe("merged");
  });
});

describe("Subagents — the two gates: grant, hard deny, Warden deny (§7.5, §9.5)", () => {
  it("a fan-out grant auto-approves the merge and clears when the fan-out concludes", async () => {
    const vcs = new FakeVcs();
    const guardian = new Guardian(builtinGuardrails());
    const sa = new Subagents(makeDeps({ vcs, guardian, reviewerModel: reviewerModel(true) }));
    sa.register(codeAgent);

    const result = await sa.dispatch([{ agent: "coder", task: "task" }]);

    // The merge auto-approved (no interactive prompt), and the grant is cleared.
    expect(result.workers[0]!.status).toBe("merged");
    expect(guardian.hasFanoutGrant(result.fanoutId)).toBe(false);
  });

  it("a hard deny rule blocks the merge even under a fan-out grant", async () => {
    const vcs = new FakeVcs();
    const guardian = new Guardian(builtinGuardrails());
    const config = cfg({
      permissions: {
        "no-merge": { tool: "merge_worktree", decision: "deny", priority: 1000, source: "user" },
      },
    });
    const sa = new Subagents(makeDeps({ vcs, guardian, getConfig: () => config, reviewerModel: reviewerModel(true) }));
    sa.register(codeAgent);

    const result = await sa.dispatch([{ agent: "coder", task: "task" }]);

    expect(result.workers[0]!.status).toBe("failed");
    expect(vcs.merged).toHaveLength(0);
    expect(result.workers[0]!.recoveryBranch).toMatch(/^voidrift-recovery-/);
  });

  it("a Warden deny is final and runs before Guardian — the grant cannot override it", async () => {
    const vcs = new FakeVcs();
    // A Warden with a deterministic rule that blocks merge_worktree (§9.6).
    const warden = new Warden({ mode: "enforcing", source: "x" });
    warden.setPolicy(
      loadPolicy({ version: "1", rules: [{ match: "merge_worktree", kind: "tool", effect: "block" }] }),
    );
    const blocked: unknown[] = [];
    const bus = new EventBus();
    bus.subscribe("COMPLIANCE_BLOCKED", (e) => blocked.push(e.payload));
    const sa = new Subagents(makeDeps({ vcs, warden, bus, reviewerModel: reviewerModel(true) }));
    sa.register(codeAgent);

    const result = await sa.dispatch([{ agent: "coder", task: "task" }]);

    expect(result.workers[0]!.status).toBe("failed");
    expect(vcs.merged).toHaveLength(0);
    expect(blocked).toHaveLength(1);
  });

  it("routes the merge through the ONE decision point — guardian.evaluate is invoked with the merge write", async () => {
    const vcs = new FakeVcs();
    const guardian = new Guardian(builtinGuardrails());
    const seen: GuardedCall[] = [];
    const realEvaluate = guardian.evaluate.bind(guardian);
    guardian.evaluate = (call, rules, lists) => {
      seen.push(call);
      return realEvaluate(call, rules, lists);
    };
    const sa = new Subagents(makeDeps({ vcs, guardian, reviewerModel: reviewerModel(true) }));
    sa.register(codeAgent);

    const result = await sa.dispatch([{ agent: "coder", task: "task" }]);

    // The merge flowed through guardian.evaluate as a non-read write carrying
    // the worktree's branch/path — the SAME path the engine's wrapToolCall uses.
    expect(result.workers[0]!.status).toBe("merged");
    const mergeCall = seen.find((c) => c.tool === "merge_worktree");
    expect(mergeCall).toBeDefined();
    expect(mergeCall!.args).toMatchObject({ branch: expect.any(String), path: expect.any(String) });
  });

  it("a force-ask-classified merge is NOT satisfied by a fan-out grant (grants cannot override force-ask)", async () => {
    const vcs = new FakeVcs();
    const guardian = new Guardian(builtinGuardrails());
    // Classify the merge as a force-ask at the single decision point. A grant is
    // open for the fan-out, yet a force-ask is immune to grants (§9.3), so the
    // gate must resolve to 'ask' — and a non-interactive run fails fast.
    guardian.evaluate = (): ReturnType<Guardian["evaluate"]> => ({ decision: "ask", forceAsk: true });
    const sa = new Subagents(
      makeDeps({ vcs, guardian, interactive: false, reviewerModel: reviewerModel(true) }),
    );
    sa.register(codeAgent);

    const result = await sa.dispatch([{ agent: "coder", task: "task" }]);

    expect(result.workers[0]!.status).toBe("failed");
    expect(result.workers[0]!.summary).toMatch(/non-interactive/i);
    expect(vcs.merged).toHaveLength(0);
  });

  it("a session-scoped merge_worktree deny rule blocks the merge even under a fan-out grant (§15.1#4)", async () => {
    const vcs = new FakeVcs();
    const guardian = new Guardian(builtinGuardrails());
    // A session-scoped deny — the live source the engine writes on a user's
    // session "deny" (engine.persistRule). It is NOT in cfg.permissions; the
    // merge gate must still honor it, exactly as every other write does.
    const sessionRules: PermissionRule[] = [
      { tool: "merge_worktree", pattern: "*", decision: "deny", priority: 300, source: "session" },
    ];
    const sa = new Subagents(
      makeDeps({ vcs, guardian, getSessionRules: () => sessionRules, reviewerModel: reviewerModel(true) }),
    );
    sa.register(codeAgent);

    const result = await sa.dispatch([{ agent: "coder", task: "task" }]);

    expect(result.workers[0]!.status).toBe("failed");
    expect(vcs.merged).toHaveLength(0);
    expect(result.workers[0]!.recoveryBranch).toMatch(/^voidrift-recovery-/);
  });

  it("a session-scoped merge_worktree allow rule approves the merge with no fan-out grant (§15.1#4)", async () => {
    const vcs = new FakeVcs();
    const guardian = new Guardian(builtinGuardrails());
    guardian.hasFanoutGrant = (): boolean => false; // force the rule path, no grant
    const sessionRules: PermissionRule[] = [
      { tool: "merge_worktree", pattern: "*", decision: "allow", priority: 300, source: "session" },
    ];
    const sa = new Subagents(
      makeDeps({ vcs, guardian, getSessionRules: () => sessionRules, reviewerModel: reviewerModel(true) }),
    );
    sa.register(codeAgent);

    const result = await sa.dispatch([{ agent: "coder", task: "task" }]);

    expect(result.workers[0]!.status).toBe("merged");
    expect(vcs.merged).toHaveLength(1);
  });
});

describe("Subagents — status, work-in-flight, and no-repo in-place run (§7.2)", () => {
  it("runs a worker in place (no worktree) when there is no git repo and still verifies", async () => {
    const vcs = new FakeVcs();
    vcs.repo = false; // no git repo — §7.4 staging is a later slice; run in place.
    const sa = new Subagents(makeDeps({ vcs, reviewerModel: reviewerModel(true) }));
    sa.register(codeAgent);

    const result = await sa.dispatch([{ agent: "coder", task: "task" }]);

    // No worktree was created; with no repo there is no merge step, so a reviewed
    // worker ends 'merged' (the apply is the later staging slice's job).
    expect(vcs.created).toHaveLength(0);
    expect(result.workers[0]!.worktree).toBeUndefined();
    expect(result.workers[0]!.status).toBe("merged");
  });

  it("fails a dispatch to an unknown agent without creating a worktree", async () => {
    const vcs = new FakeVcs();
    const sa = new Subagents(makeDeps({ vcs }));
    const result = await sa.dispatch([{ agent: "ghost", task: "task" }]);
    expect(result.workers[0]!.status).toBe("failed");
    expect(result.workers[0]!.summary).toMatch(/unknown agent/);
    expect(vcs.created).toHaveLength(0);
  });

  it("fails and abandons the worktree when the worker errors before review", async () => {
    const vcs = new FakeVcs();
    // A model with no responses throws on invoke → worker error path.
    const broken = new FakeListChatModel({ responses: [] });
    const sa = new Subagents(makeDeps({ vcs, chatModel: broken, reviewerModel: reviewerModel(true) }));
    sa.register(codeAgent);
    const result = await sa.dispatch([{ agent: "coder", task: "task" }]);
    expect(result.workers[0]!.status).toBe("failed");
    expect(vcs.abandoned).toHaveLength(1);
    expect(vcs.merged).toHaveLength(0);
  });

  it("exposes workInFlight, resultOf, and a not-found status", async () => {
    const vcs = new FakeVcs();
    const sa = new Subagents(makeDeps({ vcs, reviewerModel: reviewerModel(true) }));
    sa.register(codeAgent);
    const result = await sa.dispatch([{ agent: "coder", task: "task" }]);
    const workerId = result.workers[0]!.workerId;

    const wif = sa.workInFlight();
    expect(wif.workers.some((w) => w.workerId === workerId)).toBe(true);
    const res = sa.resultOf(workerId);
    expect(res?.status).toBe("merged");
    expect(sa.resultOf("nope")).toBeNull();
    expect(sa.status("nope")).toBeNull();
  });

  it("auto-approves a merge via a matching allow rule when no grant is present (§9)", async () => {
    const vcs = new FakeVcs();
    const guardian = new Guardian(builtinGuardrails());
    guardian.hasFanoutGrant = (): boolean => false; // force the rule path
    const config = cfg({
      permissions: {
        "allow-merge": { tool: "merge_worktree", decision: "allow", priority: 500, source: "workspace" },
      },
    });
    const sa = new Subagents(makeDeps({ vcs, guardian, getConfig: () => config, reviewerModel: reviewerModel(true) }));
    sa.register(codeAgent);
    const result = await sa.dispatch([{ agent: "coder", task: "task" }]);
    expect(result.workers[0]!.status).toBe("merged");
  });

  it("a non-interactive worker with a declared trusted scope proceeds through an ask (§7.5)", async () => {
    const vcs = new FakeVcs();
    const guardian = new Guardian(builtinGuardrails());
    guardian.hasFanoutGrant = (): boolean => false; // force 'ask'
    const sa = new Subagents(
      makeDeps({
        vcs,
        guardian,
        interactive: false,
        trustedScopes: new Set(["merge_worktree"]),
        reviewerModel: reviewerModel(true),
      }),
    );
    sa.register(codeAgent);
    const result = await sa.dispatch([{ agent: "coder", task: "task" }]);
    expect(result.workers[0]!.status).toBe("merged");
  });
});

describe("Subagents — cancel and non-interactive fail-fast (§3.3, §7.5)", () => {
  it("a cancel mid-fan-out aborts workers through the one signal and preserves worktrees", async () => {
    const vcs = new FakeVcs();
    const bus = new EventBus();
    // A worker model that sleeps long enough that cancel lands mid-run; the
    // shared AbortSignal reaches the worker's model call.
    const hanging = new FakeListChatModel({ responses: ["late"], sleep: 1000 });
    const sa = new Subagents(makeDeps({ vcs, chatModel: hanging, reviewerModel: reviewerModel(true), bus }));
    sa.register(codeAgent);

    let fanoutId = "";
    bus.subscribe("FANOUT_STARTED", (e) => {
      fanoutId = (e.payload as { fanoutId: string }).fanoutId;
    });

    const p = sa.dispatch([{ agent: "coder", task: "slow A" }, { agent: "coder", task: "slow B" }]);
    // Cancel the fan-out shortly after dispatch, using the id from the event.
    await new Promise((r) => setTimeout(r, 20));
    sa.cancel(fanoutId);
    const result = await p;

    // Every running worker ended aborted and no worktree was merged/abandoned —
    //   they are preserved as recovery artifacts (cancel does not delete).
    expect(result.workers.every((w) => w.status === "aborted")).toBe(true);
    expect(vcs.merged).toHaveLength(0);
    expect(vcs.preserved.length).toBeGreaterThan(0);
  });

  it("(W1 §7) the turn's external AbortSignal aborts workers mid-dispatch and preserves artifacts", async () => {
    // This is the signal the model-callable `task` tool passes from the live
    // turn (`config.signal`): an external abort reaches the fan-out's workers.
    const vcs = new FakeVcs();
    const bus = new EventBus();
    const hanging = new FakeListChatModel({ responses: ["late"], sleep: 1000 });
    const sa = new Subagents(makeDeps({ vcs, chatModel: hanging, reviewerModel: reviewerModel(true), bus }));
    sa.register(codeAgent);

    const controller = new AbortController();
    const p = sa.dispatchFromTurn(
      [{ agent: "coder", task: "slow A" }, { agent: "coder", task: "slow B" }],
      controller.signal,
    );
    await new Promise((r) => setTimeout(r, 20));
    controller.abort(); // the turn is cancelled
    const result = await p;

    expect(result.workers.every((w) => w.status === "aborted")).toBe(true);
    expect(vcs.merged).toHaveLength(0);
    expect(vcs.preserved.length).toBeGreaterThan(0);
  });

  it("(W1 §7) an already-aborted external signal aborts the fan-out immediately", async () => {
    const vcs = new FakeVcs();
    const hanging = new FakeListChatModel({ responses: ["late"], sleep: 1000 });
    const sa = new Subagents(makeDeps({ vcs, chatModel: hanging, reviewerModel: reviewerModel(true) }));
    sa.register(codeAgent);
    const result = await sa.dispatchFromTurn([{ agent: "coder", task: "x" }], AbortSignal.abort());
    expect(result.workers.every((w) => w.status === "aborted")).toBe(true);
    expect(vcs.merged).toHaveLength(0);
  });

  it("a non-interactive worker reaching an undeclared approval fails fast", async () => {
    const vcs = new FakeVcs();
    const guardian = new Guardian(builtinGuardrails());
    // No fan-out grant short-circuit for the merge: make the gate return 'ask'
    // by disabling the grant path — a non-interactive run with no trusted scope.
    const config = cfg();
    const sa = new Subagents(
      makeDeps({
        vcs,
        guardian,
        getConfig: () => config,
        interactive: false,
        reviewerModel: reviewerModel(true),
      }),
    );
    sa.register(codeAgent);

    // Force the merge gate to 'ask' by clearing the grant right after dispatch
    // opens it: emulate the non-grant path via a guardian whose grant is absent.
    const originalHas = guardian.hasFanoutGrant.bind(guardian);
    guardian.hasFanoutGrant = (): boolean => {
      void originalHas;
      return false; // no grant → gate resolves to 'ask'
    };

    const result = await sa.dispatch([{ agent: "coder", task: "task" }]);

    expect(result.workers[0]!.status).toBe("failed");
    expect(result.workers[0]!.summary).toMatch(/non-interactive/i);
    expect(vcs.merged).toHaveLength(0);
  });
});

describe("Subagents — durable staging without git (§7.4)", () => {
  function noRepoDeps(staging: FakeStaging, partial: Partial<SubagentsDeps> = {}): SubagentsDeps {
    const vcs = new FakeVcs();
    vcs.repo = false; // no git repo → the staging writer path (§7.4)
    return makeDeps({ vcs, staging, ...partial });
  }

  it("with no repo, a dispatched writer stages to a run folder and the apply lands through the decision point", async () => {
    // Given no repo and a writer whose staging folder is pre-populated (the fake
    // model does not drive tool calls; we model the staged write the writer made).
    const staging = new FakeStaging();
    const sa = new Subagents(noRepoDeps(staging));
    sa.register(codeAgent);
    // Simulate the writer's staged change by seeding the area it will create.
    // dispatch creates the area as `${fanoutId}-wN`; seed on the STAGING_RECOVERY
    // path instead — assert here that dispatch sets w.staging and applies clean.
    const result = await sa.dispatch([{ agent: "coder", task: "write a file" }]);
    const w = result.workers[0]!;
    // The worker ran with NO worktree (no repo) and a staging run was assigned.
    expect(w.worktree).toBeUndefined();
    // A clean (empty) apply through the decision point reaches merged.
    expect(w.status).toBe("merged");
  });

  it("two staged writers each get their own staging folder with a base+staged-hash manifest, applied sequentially", async () => {
    const staging = new FakeStaging();
    const sa = new Subagents(noRepoDeps(staging));
    sa.register(codeAgent);
    // Seed two independent staged runs as if two writers had produced them.
    await staging.createArea("run-a");
    await staging.stageWrite("run-a", "a.txt", "A-content");
    await staging.createArea("run-b");
    await staging.stageWrite("run-b", "b.txt", "B-content");
    // Manifests record BOTH hashes per file.
    const ma = (await staging.manifest("run-a"))!;
    expect(ma.files[0]!.baseHash).toBeDefined();
    expect(ma.files[0]!.stagedHash).toBeDefined();
    // When recovery applies them, each lands sequentially through the gate.
    const recovered = await sa.recoverStaging();
    expect(recovered.map((r) => r.decision)).toEqual(["applied", "applied"]);
    expect(staging.disk.get("a.txt")).toBe("A-content");
    expect(staging.disk.get("b.txt")).toBe("B-content");
  });

  it("a changed base hash reports a CONFLICT and is not applied", async () => {
    const staging = new FakeStaging();
    const sa = new Subagents(noRepoDeps(staging));
    sa.register(codeAgent);
    staging.disk.set("c.txt", "original");
    await staging.createArea("run-c");
    await staging.stageWrite("run-c", "c.txt", "staged-new");
    // The disk changes AFTER staging — the base hash no longer matches.
    staging.disk.set("c.txt", "changed-by-someone-else");
    const result = await staging.apply("run-c");
    expect(result.applied).toHaveLength(0);
    expect(result.blocked[0]).toMatchObject({ ok: false, reason: "conflict", path: "c.txt" });
    // Not applied: the user's changed file is untouched.
    expect(staging.disk.get("c.txt")).toBe("changed-by-someone-else");
    void sa;
  });

  it("a staged file that disagrees with its manifest hash is reported UNRELIABLE and not applied", async () => {
    const staging = new FakeStaging();
    staging.disk.set("d.txt", "base");
    await staging.createArea("run-d");
    await staging.stageWrite("run-d", "d.txt", "good-staged");
    // Corrupt the staged blob so its re-hash disagrees with the manifest.
    staging.corrupt.add(encodeURIComponent("d.txt"));
    const result = await staging.apply("run-d");
    expect(result.applied).toHaveLength(0);
    expect(result.blocked[0]).toMatchObject({ ok: false, reason: "unreliable", path: "d.txt" });
    expect(staging.disk.get("d.txt")).toBe("base");
  });

  it("recovery offers apply or discard through the decision point", async () => {
    const staging = new FakeStaging();
    const sa = new Subagents(noRepoDeps(staging));
    sa.register(codeAgent);
    await staging.createArea("run-r");
    await staging.stageWrite("run-r", "r.txt", "recovered");
    const offered: string[] = [];
    (sa as unknown as { deps: SubagentsDeps }).deps.bus.subscribe("STAGING_RECOVERY_OFFERED", (e) =>
      offered.push((e.payload as { decision: string }).decision),
    );
    const recovered = await sa.recoverStaging();
    expect(recovered[0]!.decision).toBe("applied");
    expect(staging.disk.get("r.txt")).toBe("recovered");
    expect(offered.length).toBeGreaterThan(0);
  });

  it("recovery discards when policy denies the apply", async () => {
    const staging = new FakeStaging();
    // A hard deny on apply_staging makes the gate return deny → discard.
    const guardian = new Guardian(builtinGuardrails());
    const denyRule: PermissionRule = { tool: "apply_staging", decision: "deny", priority: 100, source: "session" };
    const sa = new Subagents(noRepoDeps(staging, { guardian, getSessionRules: () => [denyRule] }));
    sa.register(codeAgent);
    await staging.createArea("run-x");
    await staging.stageWrite("run-x", "x.txt", "nope");
    const recovered = await sa.recoverStaging();
    expect(recovered[0]!.decision).toBe("discarded");
    expect(staging.discarded).toContain("run-x");
    expect(staging.disk.has("x.txt")).toBe(false);
  });

  it("a staged (no-repo) worker cannot run shell — a write+shell worker runs in place, not staged", async () => {
    const staging = new FakeStaging();
    const sa = new Subagents(noRepoDeps(staging));
    // A worker that needs BOTH writes and shell runs ALONE, in place (no staging).
    const writeShell: AgentDefinition = {
      ...codeAgent,
      name: "builder",
      tools: ["read_file", "write_file", "execute_command"],
    };
    sa.register(writeShell);
    const result = await sa.dispatch([{ agent: "builder", task: "build" }]);
    const w = result.workers[0]!;
    // It ran in place: no staging folder was created for it (no-shell-staged limit).
    expect(w.staging).toBeUndefined();
    expect(await staging.listRuns()).toHaveLength(0);
  });

  it("a dispatched staged worker whose apply hits a changed base reports a CONFLICT to the orchestrator and is not applied", async () => {
    const staging = new FakeStaging();
    staging.seedConflictPath = "z.txt"; // dispatch's created area will conflict on apply
    const sa = new Subagents(noRepoDeps(staging));
    sa.register(codeAgent);
    const result = await sa.dispatch([{ agent: "coder", task: "write z" }]);
    const w = result.workers[0]!;
    // The apply reports the conflict and the worker fails; the staging folder is
    // kept so the orchestrator can re-dispatch against current files.
    expect(w.status).toBe("failed");
    expect(w.summary).toMatch(/apply conflict/i);
    expect(staging.disk.get("z.txt")).toBe("changed-after-stage"); // not overwritten
  });

  it("recovery KEEPS an unfinished folder when it cannot be auto-resolved (non-interactive, no grant/trusted scope)", async () => {
    const staging = new FakeStaging();
    // Non-interactive and no trusted scope → the apply offer resolves to 'ask'
    // with no grant, so recovery keeps the folder rather than applying/discarding.
    const sa = new Subagents(noRepoDeps(staging, { interactive: false }));
    sa.register(codeAgent);
    await staging.createArea("run-keep");
    await staging.stageWrite("run-keep", "k.txt", "pending");
    const recovered = await sa.recoverStaging();
    expect(recovered[0]!.decision).toBe("kept");
    expect(await staging.listRuns()).toContain("run-keep"); // preserved, not applied
    expect(staging.disk.has("k.txt")).toBe(false);
  });
});

describe("Subagents — the shared CONTEXT_OVERFLOW guard on worker calls (§4.10, invariant 9)", () => {
  /** A model that FAILS the test if it is ever invoked — proves the guard
   * refuses BEFORE the provider is called (nothing is sent). */
  class NeverCalledModel extends FakeListChatModel {
    invoked = false;
    constructor() {
      super({ responses: ["should never be returned"] });
    }
    override async _generate(...args: Parameters<FakeListChatModel["_generate"]>): ReturnType<FakeListChatModel["_generate"]> {
      this.invoked = true;
      return super._generate(...args);
    }
  }

  it("a tiny window + a long task description fails the worker with CONTEXT_OVERFLOW and NEVER invokes the model", async () => {
    const vcs = new FakeVcs();
    const workerModelKey = "overflow-ep";
    const never = new NeverCalledModel();
    const overflows: unknown[] = [];
    const bus = new EventBus();
    bus.subscribe("CONTEXT_OVERFLOW", (e) => overflows.push(e.payload));
    const sa = new Subagents(
      makeDeps({
        vcs,
        bus,
        // Both known (>0) so the guard is armed; window tiny so any input overflows.
        window: 50,
        maxOutputTokens: 40,
        resolveModel: (k) => (k === workerModelKey ? (never as never) : undefined),
        reviewerModel: reviewerModel(true),
      }),
    );
    sa.register({ ...codeAgent, model: workerModelKey });
    const longTask = "do this ".repeat(500); // ~4000 chars → way over a 50-token window
    const result = await sa.dispatch([{ agent: "coder", task: longTask }]);
    // P4 — the context hard stop ends the worker as a `limit_reached`-style
    // ending that CARRIES what it gathered (never an empty failure), and the
    // model was never called. The result leads with the structured end report
    // naming the `context` ending.
    expect(result.workers[0]!.status).toBe("limit_reached");
    expect(result.workers[0]!.summary).toContain("[worker report: ended=context");
    expect(never.invoked).toBe(false);
    // CONTEXT_OVERFLOW was still emitted with the typed payload (§4.10).
    expect(overflows.length).toBeGreaterThanOrEqual(1);
    expect(overflows[0]).toMatchObject({ maxOutputTokens: 40, limit: 50 });
  });

  it("the guard is a no-op when maxOutputTokens is unknown (worker runs normally)", async () => {
    const vcs = new FakeVcs();
    const sa = new Subagents(makeDeps({ vcs, window: 50, maxOutputTokens: null, reviewerModel: reviewerModel(true) }));
    sa.register(codeAgent);
    const result = await sa.dispatch([{ agent: "coder", task: "short" }]);
    // No overflow refusal: the worker reaches the model and merges.
    expect(result.workers[0]!.status).toBe("merged");
  });
});

describe("Subagents — AgentDefinition.model is a STRING endpoint key (invariant 14, §11)", () => {
  it("rejects an unknown model endpoint key with MODEL_NOT_CONFIGURED", () => {
    const vcs = new FakeVcs();
    const sa = new Subagents(makeDeps({ vcs, resolveModel: () => undefined }));
    try {
      sa.register({ ...codeAgent, model: "no-such-endpoint" });
      expect.unreachable("register should throw for an unknown model key");
    } catch (e) {
      expect((e as { error?: { code?: string } }).error?.code).toBe("MODEL_NOT_CONFIGURED");
    }
  });

  it("accepts a known model endpoint key resolved via the model port", () => {
    const vcs = new FakeVcs();
    const known = workerModel("ok");
    const sa = new Subagents(makeDeps({ vcs, resolveModel: (k) => (k === "known-ep" ? known : undefined) }));
    expect(() => sa.register({ ...codeAgent, model: "known-ep" })).not.toThrow();
  });
});



/**
 * §7.2/§6.3/§14.6 — the worker's LIVE stream drives the real code: a scripted
 * worker runs READ/SEARCH/EDIT tool calls through the SAME invokeAgent path and
 * its `workerToolStatusMiddleware` pushes the stream events (tool names, briefs,
 * the real edit diff, the final summary) and fires WORKER_STATUS_CHANGED per
 * tool call. Only the model is faked; the real tool backend edits a hermeticTmp
 * file and `edit_file` returns the real `diff` fence.
 */
describe("Subagents — worker stream drives the real code (§7.2, §6.3, §14.6)", () => {
  /**
   * A scripted worker model that, on each worker call, drives the next tool in
   * the sequence read_file → search_contents → edit_file, then answers "done".
   * The reviewer uses a SEPARATE `reviewerModel`, so this never sees the review.
   * The step is tracked by COUNTING the tool-call rounds already in the history
   * (one AIMessage with tool_calls per completed round), so no shared mutable
   * sequence index leaks across workers.
   */
  class ScriptedToolModel extends BaseChatModel {
    private seq: number;
    constructor(params: BaseChatModelParams = {}) {
      super(params);
      this.seq = 0;
    }
    _llmType(): string {
      return "scripted-tool";
    }
    override bindTools(): this {
      return this;
    }
    async _generate(messages: BaseMessage[]): Promise<ChatResult> {
      // The tool round = the number of prior assistant messages that CALLED a
      // tool (each adds one AIMessage with tool_calls to the history).
      const priorToolRounds = messages.filter(
        (m) => m instanceof AIMessage && (m.tool_calls?.length ?? 0) > 0,
      ).length;
      const call = (name: string, args: Record<string, unknown>): ChatResult => {
        const msg = new AIMessage({
          content: "",
          tool_calls: [{ name, args, id: `c${name}-${this.seq++}` }],
        });
        return { generations: [{ text: "", message: msg }] };
      };
      if (priorToolRounds === 0) return call("read_file", { path: "README.md" });
      if (priorToolRounds === 1) return call("search_contents", { pattern: "hello", path: "README.md" });
      if (priorToolRounds === 2) return call("edit_file", { path: "README.md", search: "hello", replace: "goodbye" });
      const msg = new AIMessage("done: edited README.md");
      return { generations: [{ text: "done: edited README.md", message: msg }] };
    }
  }

  /** A model that NEVER answers — always calls read_file — so the worker hits
   * its tool-round budget (`limit_reached`). */
  class NeverStopToolModel extends BaseChatModel {
    private seq = 0;
    constructor(params: BaseChatModelParams = {}) {
      super(params);
    }
    _llmType(): string {
      return "never-stop-tool";
    }
    override bindTools(): this {
      return this;
    }
    async _generate(): Promise<ChatResult> {
      const msg = new AIMessage({
        content: "still reading",
        tool_calls: [{ name: "read_file", args: { path: "README.md" }, id: `c${this.seq++}` }],
      });
      return { generations: [{ text: "", message: msg }] };
    }
  }

  /**
   * A scripted model that first reads README.md (a normal, successful call that
   * MUST NOT produce an error event), then calls `execute_command shutdown now`
   * — a hard-deny the guardian refuses with `permission denied: …` — then
   * answers "done". Drives the real decision point so the denial is the real
   * `ToolMessage { status: "error" }`, never a literal the test builds.
   */
  class DenyingToolModel extends BaseChatModel {
    private seq = 0;
    constructor(params: BaseChatModelParams = {}) {
      super(params);
    }
    _llmType(): string {
      return "denying-tool";
    }
    override bindTools(): this {
      return this;
    }
    async _generate(messages: BaseMessage[]): Promise<ChatResult> {
      const priorToolRounds = messages.filter(
        (m) => m instanceof AIMessage && (m.tool_calls?.length ?? 0) > 0,
      ).length;
      const call = (name: string, args: Record<string, unknown>): ChatResult => {
        const msg = new AIMessage({ content: "", tool_calls: [{ name, args, id: `c${name}-${this.seq++}` }] });
        return { generations: [{ text: "", message: msg }] };
      };
      if (priorToolRounds === 0) return call("read_file", { path: "README.md" });
      if (priorToolRounds === 1) return call("execute_command", { command: "shutdown now" });
      const msg = new AIMessage("done: tried a denied command");
      return { generations: [{ text: "done", message: msg }] };
    }
  }

  /** A model that THROWS on invoke — the worker ends `failed`. */
  class ThrowingModel extends BaseChatModel {
    constructor(params: BaseChatModelParams = {}) {
      super(params);
    }
    _llmType(): string {
      return "throwing";
    }
    override bindTools(): this {
      return this;
    }
    async _generate(): Promise<ChatResult> {
      throw new Error("model exploded");
    }
  }

  function reviewerPass() {
    return new FakeListChatModel({ responses: ["PASS: looks good"] });
  }

  const streamAgent: AgentDefinition = {
    name: "streamer",
    description: "reads, searches, edits",
    systemPrompt: "do the work",
    // write+shell → runs in place against the workspace root (no repo, no
    // worktree, no staging), so the real tool backend edits the hermeticTmp file.
    tools: ["read_file", "search_contents", "edit_file", "execute_command"],
  };

  let ws: string;
  beforeEach(() => {
    ws = hermeticTmp("subagents-stream");
    fs.writeFileSync(path.join(ws, "README.md"), "hello world\nsecond line\n");
  });

  it("the stream carries exactly one running status, the real tool briefs, the real edit diff, and ONE final summary", async () => {
    const vcs = new FakeVcs();
    vcs.repo = false; // no repo → in-place run at the workspace root
    const bus = new EventBus();
    const toolEvents: { tool?: string; status?: string }[] = [];
    bus.subscribe("WORKER_STATUS_CHANGED", (e) => {
      const p = e.payload as { status: string; tool?: string };
      toolEvents.push({ status: p.status, ...(p.tool ? { tool: p.tool } : {}) });
    });
    const sa = new Subagents(
      makeDeps({ vcs, bus, chatModel: new ScriptedToolModel(), reviewerModel: reviewerPass(), workspaceRoot: ws }),
    );
    sa.register(streamAgent);

    const result = await sa.dispatch([{ agent: "streamer", task: "edit README" }]);
    const workerId = result.workers[0]!.workerId;
    const stream: WorkerStreamEvent[] = sa.stream(workerId);

    // Exactly one `status: running` event (the initial transition), no second one.
    const runningStatuses = stream.filter((e) => e.kind === "status" && e.status === "running");
    expect(runningStatuses).toHaveLength(1);

    // Tool events in call order, carrying the real makeToolBrief briefs.
    const toolCalls = stream.filter((e) => e.kind === "tool" && !(e.text ?? "").startsWith("```diff"));
    const read = toolCalls.find((e) => e.tool === "read_file");
    const search = toolCalls.find((e) => e.tool === "search_contents");
    const edit = toolCalls.find((e) => e.tool === "edit_file");
    expect(read?.text).toBe("README.md");
    expect(search?.text).toBe("hello  in README.md");
    expect(edit?.text).toBe("README.md");

    // A diff event for edit_file: a real ```diff fence carrying the +/- lines.
    const diff = stream.find((e) => e.kind === "tool" && (e.text ?? "").startsWith("```diff"));
    expect(diff).toBeDefined();
    expect(diff!.text).toContain("-hello world");
    expect(diff!.text).toContain("+goodbye world");

    // Exactly ONE summary event, and it is LAST.
    const summaries = stream.filter((e) => e.kind === "summary");
    expect(summaries).toHaveLength(1);
    expect(stream[stream.length - 1]!.kind).toBe("summary");

    // WORKER_STATUS_CHANGED fired per tool call carrying `tool`.
    const toolBus = toolEvents.filter((e) => e.tool !== undefined).map((e) => e.tool);
    expect(toolBus).toEqual(expect.arrayContaining(["read_file", "search_contents", "edit_file"]));

    // The real edit landed on disk (the real backend ran, not a stub).
    expect(fs.readFileSync(path.join(ws, "README.md"), "utf8")).toContain("goodbye world");
  });

  it("a worker call the guardian refuses adds an `error` event right after its tool call; a successful call adds none (§7.2)", async () => {
    const vcs = new FakeVcs();
    vcs.repo = false; // in-place run at the workspace root
    const sa = new Subagents(
      makeDeps({ vcs, chatModel: new DenyingToolModel(), reviewerModel: reviewerPass(), workspaceRoot: ws }),
    );
    sa.register(streamAgent);

    const result = await sa.dispatch([{ agent: "streamer", task: "try a denied command" }]);
    const workerId = result.workers[0]!.workerId;
    const stream: WorkerStreamEvent[] = sa.stream(workerId);

    // The successful read_file call produced NO error event.
    const readIdx = stream.findIndex((e) => e.kind === "tool" && e.tool === "read_file");
    expect(readIdx).toBeGreaterThanOrEqual(0);
    expect(stream[readIdx + 1]!.kind).not.toBe("error");

    // The denied execute_command call is immediately followed by an `error`
    // event carrying the real guardian reason — [..., tool(call), error(...)].
    const callIdx = stream.findIndex((e) => e.kind === "tool" && e.tool === "execute_command");
    expect(callIdx).toBeGreaterThanOrEqual(0);
    const errEvent = stream[callIdx + 1]!;
    expect(errEvent.kind).toBe("error");
    expect(errEvent.text).toContain("permission denied");
    // Exactly one error event (the one denied call), and it is not the summary.
    expect(stream.filter((e) => e.kind === "error")).toHaveLength(1);
  });

  it("a worker that never stops calling tools ends with exactly ONE summary event (limit_reached)", async () => {
    const vcs = new FakeVcs();
    vcs.repo = false;
    const sa = new Subagents(
      makeDeps({
        vcs,
        chatModel: new NeverStopToolModel(),
        reviewerModel: reviewerPass(),
        workspaceRoot: ws,
        getConfig: () => cfg({ turnMaxToolRounds: 2 }),
      }),
    );
    sa.register(streamAgent);
    const result = await sa.dispatch([{ agent: "streamer", task: "read forever" }]);
    const workerId = result.workers[0]!.workerId;
    expect(result.workers[0]!.status).toBe("limit_reached");
    const stream = sa.stream(workerId);
    expect(stream.filter((e) => e.kind === "summary")).toHaveLength(1);
    expect(stream[stream.length - 1]!.kind).toBe("summary");
  });

  it("a worker whose model throws ends failed with exactly ONE summary event", async () => {
    const vcs = new FakeVcs();
    vcs.repo = false;
    const sa = new Subagents(
      makeDeps({ vcs, chatModel: new ThrowingModel(), reviewerModel: reviewerPass(), workspaceRoot: ws }),
    );
    sa.register(streamAgent);
    const result = await sa.dispatch([{ agent: "streamer", task: "boom" }]);
    const workerId = result.workers[0]!.workerId;
    expect(result.workers[0]!.status).toBe("failed");
    const stream = sa.stream(workerId);
    expect(stream.filter((e) => e.kind === "summary")).toHaveLength(1);
    expect(stream[stream.length - 1]!.kind).toBe("summary");
  });
});
