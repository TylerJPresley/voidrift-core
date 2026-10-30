/**
 * Worker decision-point gate (core-blueprint.md §9.1, §9.5, §7.5, §15.1#4).
 *
 * The security regression test for the fan-out bypass: a dispatched worker built
 * with `createAgent` and NO decision-point middleware ran its `write_file` /
 * `edit_file` / `execute_command` with NO Warden, NO Guardian, NO force-ask, NO
 * managed floor and NO masking — only the final merge/apply was gated. These
 * tests dispatch a worker whose OWN scripted model drives tool calls and assert
 * every call now passes the SAME single decision point the orchestrator uses.
 *
 * The worker runs over a REAL temp worktree (LocalShellBackend) so an ungated
 * write is observable on disk; a `fakeModel()` scripts the worker's tool calls
 * (the reviewer keeps a separate PASS model so the worker's script is not
 * consumed). Offline/deterministic: no network, no real git (a FakeVcs roots the
 * worker at the temp dir).
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { AIMessage } from "@langchain/core/messages";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Guardian, builtinGuardrails } from "../entities/guardian.js";
import { Warden, loadPolicy } from "../entities/warden.js";
import { EventBus } from "../entities/event-bus.js";
import { ToolRegistry } from "../entities/tool-registry.js";
import { builtinToolDefinitions } from "../tools/builtin.js";
import { ConfigSchema, type Config, type PermissionRule } from "../config/schema.js";
import type { MergeResult, VcsPort, Worktree } from "../entities/ports/vcs-port.js";
import type { StagingApplyResult, StagingArea, StagingPort } from "../entities/ports/staging-port.js";
import type { PendingApproval, ApprovalResponse } from "../entities/approvals.js";
import { Subagents, type SubagentsDeps } from "./subagents.js";
import type { AgentDefinition } from "../entities/subagents.js";

/** A FakeVcs that roots each worker at a REAL temp dir so writes are observable. */
class RealDirVcs implements VcsPort {
  repo = true;
  readonly merged: string[] = [];
  /** Files written into each new worktree so a worker can read them. */
  seedFiles: Record<string, string> = {};
  constructor(private readonly root: string) {}
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
  async createWorktree(id: string): Promise<Worktree> {
    const p = path.join(this.root, "wt", id);
    fs.mkdirSync(p, { recursive: true });
    for (const [name, content] of Object.entries(this.seedFiles)) {
      fs.writeFileSync(path.join(p, name), content);
    }
    return { id, path: p, branch: `voidrift-run-${id}` };
  }
  async mergeWorktree(wt: Worktree): Promise<MergeResult> {
    this.merged.push(wt.id);
    return { merged: true };
  }
  async abandonWorktree(wt: Worktree): Promise<string> {
    return `voidrift-recovery-${wt.id}`;
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

const noStaging: StagingPort = {
  async createArea(run: string): Promise<StagingArea> {
    return { run, path: `/stage/${run}` };
  },
  async stageWrite(): Promise<void> {},
  async read(): Promise<string | null> {
    return null;
  },
  async manifest() {
    return null;
  },
  async apply(): Promise<StagingApplyResult> {
    return { applied: [], blocked: [] };
  },
  async discard(): Promise<void> {},
  async listRuns(): Promise<string[]> {
    return [];
  },
  async bootCleanup(): Promise<string[]> {
    return [];
  },
  async removeForSession(): Promise<{ reclaimedBytes: number; removedRuns: string[] }> {
    return { reclaimedBytes: 0, removedRuns: [] };
  },
};

function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const t of builtinToolDefinitions()) reg.register(t.def, t.exec);
  return reg;
}

function cfg(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({ ...overrides });
}

/** A reviewer that always PASSes (kept separate so the worker's tool script is
 * never consumed by the reviewer). */
function reviewerPass() {
  return new FakeListChatModel({ responses: ["PASS: ok"] });
}

let root: string;
let bus: EventBus;

function baseDeps(partial: Partial<SubagentsDeps> & { vcs: VcsPort }): SubagentsDeps {
  return {
    chatModel: new FakeListChatModel({ responses: ["done"] }),
    guardian: new Guardian(builtinGuardrails()),
    warden: new Warden({ mode: "off" }),
    bus,
    staging: noStaging,
    registry: makeRegistry(),
    tempDir: path.join(os.tmpdir(), "no-such"),
    window: 32_000,
    getConfig: () => cfg(),
    workspaceRoot: root,
    sessionId: "orchestrator",
    interactive: true,
    reviewerModel: reviewerPass(),
    resolveModel: (key: string) => workerModels.get(key),
    ...partial,
  };
}

/** A coder worker whose OWN model (a config endpoint key) drives the tool
 * call(s), then replies done. The model instance is registered under the key in
 * `workerModels` and resolved via the `resolveModel` seam (invariant 14). */
const workerModels = new Map<string, ReturnType<typeof fakeModel>>();
function coderWith(model: ReturnType<typeof fakeModel>): AgentDefinition {
  const key = "coder-ep";
  workerModels.set(key, model);
  return {
    name: "coder",
    description: "writes code",
    systemPrompt: "code",
    tools: ["read_file", "write_file", "edit_file", "execute_command"],
    model: key,
  };
}

beforeEach(async () => {
  root = hermeticTmp("wgate");
  bus = new EventBus();
});
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe("Worker gate — STEP 0 proof: a worker's ungated calls are now stopped (§9.1, §9.5)", () => {
  it("a worker's force-ask execute_command (git push --force) does NOT execute, even with a live fan-out grant", async () => {
    // A force-ask is immune to the fan-out grant (§9.3); under policy_only it
    // fails fast and never runs — the ungated-shell bypass is closed.
    const workerModel = fakeModel()
      .respondWithTools([{ name: "execute_command", args: { command: "git push --force origin main" } }])
      .respond(new AIMessage("done"));
    const started: string[] = [];
    const finished: Array<{ name: string; status: string }> = [];
    const denied: unknown[] = [];
    bus.subscribe("TOOL_STARTED", (e) => started.push((e.payload as { name: string }).name));
    bus.subscribe("TOOL_FINISHED", (e) => finished.push(e.payload as { name: string; status: string }));
    bus.subscribe("PERMISSION_DENIED", (e) => denied.push(e.payload));
    const vcs = new RealDirVcs(root);
    const sa = new Subagents(
      baseDeps({ vcs, interactive: false, getApprovalMode: () => "policy_only" }),
    );
    sa.register(coderWith(workerModel));

    const res = await sa.dispatch([{ agent: "coder", task: "push" }]);

    // The force-ask was rejected before execution. §8.1/§9.1: the call is now
    // BRACKETED (one TOOL_STARTED + one TOOL_FINISHED {status:"error"}) yet never
    // EXECUTES — there is no successful execute_command finish, and
    // PERMISSION_DENIED "rejected" rides alongside.
    expect(denied.some((p) => (p as { reason: string }).reason === "rejected")).toBe(true);
    const execFinishes = finished.filter((f) => f.name === "execute_command");
    expect(execFinishes).toHaveLength(1);
    expect(execFinishes[0]!.status).toBe("error"); // denied, not executed
    expect(started.filter((n) => n === "execute_command")).toHaveLength(1); // bracketed exactly once
    expect(res.workers[0]!.status).toBe("merged"); // the worker loop continued after rejection
  });

  it("a worker force-ask PendingApproval carries forceAsk/forceAskKind/rememberable/exactOnly/inferredPatterns (§9.5, owner D2a)", async () => {
    // A dangerous-shell force-ask surfaced to the interactive worker callback
    // must carry the SAME presentation fields the orchestrator's does, so a host
    // can route it out of a batch and show the exact-only remember line.
    const workerModel = fakeModel()
      .respondWithTools([{ name: "execute_command", args: { command: "git push --force origin main" } }])
      .respond(new AIMessage("done"));
    let captured: PendingApproval | undefined;
    const vcs = new RealDirVcs(root);
    const sa = new Subagents(
      baseDeps({
        vcs,
        getApprovalMode: () => "interactive",
        requestWorkerApproval: async (p) => {
          captured = p;
          return { requestId: p.id, decision: "reject" };
        },
      }),
    );
    sa.register(coderWith(workerModel));

    await sa.dispatch([{ agent: "coder", task: "push" }]);

    expect(captured).toBeDefined();
    expect(captured!.forceAsk).toBe(true);
    expect(captured!.forceAskKind).toBe("shell");
    expect(captured!.rememberable).toBe(true); // a clean, short value is exact-rememberable
    expect(captured!.exactOnly).toBe(true);
    expect(captured!.inferredPatterns).toEqual(["git push --force origin main"]);
    expect(captured!.workerId).toBeDefined();
  });

  it("a live fan-out grant does NOT lift a worker force-ask — it still prompts (§9.3)", async () => {
    // The grant auto-approves a PLAIN ask but NEVER a force-ask: an SSRF
    // web_fetch under a live grant must still reach the human callback.
    const workerModel = fakeModel()
      .respondWithTools([{ name: "web_fetch", args: { url: "http://127.0.0.1:8080/x" } }])
      .respond(new AIMessage("done"));
    const guardian = new Guardian(builtinGuardrails());
    guardian.hasFanoutGrant = () => true; // a LIVE grant
    let asked = 0;
    const vcs = new RealDirVcs(root);
    const sa = new Subagents(
      baseDeps({
        vcs,
        guardian,
        getApprovalMode: () => "interactive",
        requestWorkerApproval: async (p) => {
          asked++;
          expect(p.forceAsk).toBe(true);
          expect(p.forceAskKind).toBe("ssrf");
          return { requestId: p.id, decision: "reject" };
        },
      }),
    );
    const key = "fetcher-ep";
    workerModels.set(key, workerModel);
    sa.register({
      name: "fetcher",
      description: "fetches",
      systemPrompt: "fetch",
      tools: ["read_file", "web_fetch"],
      model: key,
    });

    await sa.dispatch([{ agent: "fetcher", task: "fetch" }]);

    expect(asked).toBe(1); // the grant did not satisfy the force-ask
  });

  it("an unruled write with NO grant does NOT execute under policy_only (fail fast)", async () => {
    const workerModel = fakeModel()
      .respondWithTools([{ name: "write_file", args: { path: "pwned.txt", content: "x" } }])
      .respond(new AIMessage("done"));
    const guardian = new Guardian(builtinGuardrails());
    guardian.hasFanoutGrant = () => false; // no grant → the ask has nothing to satisfy it
    const vcs = new RealDirVcs(root);
    const sa = new Subagents(
      baseDeps({ vcs, guardian, interactive: false, getApprovalMode: () => "policy_only" }),
    );
    sa.register(coderWith(workerModel));

    await sa.dispatch([{ agent: "coder", task: "write" }]);

    const wt = path.join(root, "wt");
    const written = fs.existsSync(wt)
      ? fs.readdirSync(wt, { recursive: true }).some((f) => String(f).endsWith("pwned.txt"))
      : false;
    expect(written).toBe(false);
  });

  it("a Warden `enforcing` block stops a worker's write and the user is never asked", async () => {
    const workerModel = fakeModel()
      .respondWithTools([{ name: "write_file", args: { path: "blocked.txt", content: "x" } }])
      .respond(new AIMessage("done"));
    const warden = new Warden({ mode: "enforcing", source: "x" });
    warden.setPolicy(loadPolicy({ version: "1", rules: [{ match: "write_file", kind: "tool", effect: "block" }] }));
    const blocked: unknown[] = [];
    bus.subscribe("COMPLIANCE_BLOCKED", (e) => blocked.push(e.payload));
    let asked = 0;
    const vcs = new RealDirVcs(root);
    const sa = new Subagents(
      baseDeps({ vcs, warden, requestWorkerApproval: async (p) => { asked++; return { requestId: p.id, decision: "approve" }; } }),
    );
    sa.register(coderWith(workerModel));

    await sa.dispatch([{ agent: "coder", task: "write" }]);

    expect(blocked.length).toBeGreaterThanOrEqual(1);
    expect(asked).toBe(0); // Warden deny is final — never asks
    const wt = path.join(root, "wt");
    const written = fs.existsSync(wt)
      ? fs.readdirSync(wt, { recursive: true }).some((f) => String(f).endsWith("blocked.txt"))
      : false;
    expect(written).toBe(false);
  });
});

describe("Worker gate — rules bind every worker (§9.2, §15.1#4)", () => {
  it("a session-scope deny rule binds a worker's write", async () => {
    const workerModel = fakeModel()
      .respondWithTools([{ name: "write_file", args: { path: "d.txt", content: "x" } }])
      .respond(new AIMessage("done"));
    const sessionRules: PermissionRule[] = [
      { tool: "write_file", pattern: "*", decision: "deny", priority: 300, source: "session" },
    ];
    const denied: unknown[] = [];
    bus.subscribe("PERMISSION_DENIED", (e) => denied.push(e.payload));
    const vcs = new RealDirVcs(root);
    const sa = new Subagents(baseDeps({ vcs, getSessionRules: () => sessionRules }));
    sa.register(coderWith(workerModel));

    await sa.dispatch([{ agent: "coder", task: "write" }]);

    expect(denied.some((p) => (p as { tool: string }).tool === "write_file")).toBe(true);
    const wt = path.join(root, "wt");
    const written = fs.existsSync(wt)
      ? fs.readdirSync(wt, { recursive: true }).some((f) => String(f).endsWith("d.txt"))
      : false;
    expect(written).toBe(false);
  });

  it("a managed deny binds a worker and cannot be loosened by a session allow", async () => {
    const workerModel = fakeModel()
      .respondWithTools([{ name: "write_file", args: { path: "m.txt", content: "x" } }])
      .respond(new AIMessage("done"));
    // A session allow would normally approve; the managed gate denies first.
    const sessionRules: PermissionRule[] = [
      { tool: "write_file", pattern: "*", decision: "allow", priority: 300, source: "session" },
    ];
    const denied: unknown[] = [];
    bus.subscribe("PERMISSION_DENIED", (e) => denied.push(e.payload));
    const vcs = new RealDirVcs(root);
    const sa = new Subagents(
      baseDeps({ vcs, getSessionRules: () => sessionRules, managedGate: () => ({ reason: "managed layer unavailable" }) }),
    );
    sa.register(coderWith(workerModel));

    await sa.dispatch([{ agent: "coder", task: "write" }]);

    expect(denied.some((p) => (p as { reason: string }).reason === "managed_layer_unavailable")).toBe(true);
    const wt = path.join(root, "wt");
    const written = fs.existsSync(wt)
      ? fs.readdirSync(wt, { recursive: true }).some((f) => String(f).endsWith("m.txt"))
      : false;
    expect(written).toBe(false);
  });
});

describe("Worker gate — the fan-out grant (§7.5, §9.3)", () => {
  it("the fan-out grant lets a worker's non-force-ask write proceed but NOT git push --force", async () => {
    // Non-force-ask write: a live fan-out grant auto-approves it; the write lands.
    const okModel = fakeModel()
      .respondWithTools([{ name: "write_file", args: { path: "ok.txt", content: "y" } }])
      .respond(new AIMessage("done"));
    const vcs = new RealDirVcs(root);
    const sa = new Subagents(baseDeps({ vcs }));
    sa.register(coderWith(okModel));
    const r1 = await sa.dispatch([{ agent: "coder", task: "write ok" }]);
    expect(r1.workers[0]!.status).toBe("merged");
    const wt = path.join(root, "wt");
    const landed = fs.readdirSync(wt, { recursive: true }).some((f) => String(f).endsWith("ok.txt"));
    expect(landed).toBe(true);

    // Force-ask: even with a grant open, git push --force is never auto-run.
    const pushModel = fakeModel()
      .respondWithTools([{ name: "execute_command", args: { command: "git push --force origin main" } }])
      .respond(new AIMessage("done"));
    const vcs2 = new RealDirVcs(root);
    let asked = 0;
    const sa2 = new Subagents(
      baseDeps({ vcs: vcs2, interactive: false, getApprovalMode: () => "policy_only" }),
    );
    void asked;
    sa2.register(coderWith(pushModel));
    const denied: unknown[] = [];
    bus.subscribe("PERMISSION_DENIED", (e) => denied.push(e.payload));
    const r2 = await sa2.dispatch([{ agent: "coder", task: "push" }]);
    // The force-ask under a grant resolved to reject (fail fast) — not executed.
    expect(denied.some((p) => (p as { reason: string }).reason === "rejected")).toBe(true);
    expect(r2.workers[0]!.status).toBe("merged"); // worker loop continued after rejection
  });
});

describe("Worker gate — approval modes (§9.5)", () => {
  it("out_of_band surfaces a PendingApproval carrying workerId + full args; approve lets the worker continue", async () => {
    const workerModel = fakeModel()
      .respondWithTools([{ name: "write_file", args: { path: "oob.txt", content: "z" } }])
      .respond(new AIMessage("done"));
    // No grant (force the ask path): disable the grant.
    const guardian = new Guardian(builtinGuardrails());
    guardian.hasFanoutGrant = () => false;
    let captured: PendingApproval | null = null;
    const vcs = new RealDirVcs(root);
    const sa = new Subagents(
      baseDeps({
        vcs,
        guardian,
        getApprovalMode: () => "out_of_band",
        requestWorkerApproval: async (p): Promise<ApprovalResponse> => {
          captured = p;
          return { requestId: p.id, decision: "approve" };
        },
      }),
    );
    sa.register(coderWith(workerModel));

    const res = await sa.dispatch([{ agent: "coder", task: "write oob" }]);

    expect(captured).not.toBeNull();
    expect(captured!.workerId).toMatch(/^fanout-.*-w/);
    expect(captured!.args).toMatchObject({ path: "oob.txt", content: "z" });
    expect(res.workers[0]!.status).toBe("merged");
    const wt = path.join(root, "wt");
    expect(fs.readdirSync(wt, { recursive: true }).some((f) => String(f).endsWith("oob.txt"))).toBe(true);
  });

  it("out_of_band reject makes the worker's model see a rejection and the write never runs", async () => {
    const workerModel = fakeModel()
      .respondWithTools([{ name: "write_file", args: { path: "rej.txt", content: "z" } }])
      .respond(new AIMessage("done"));
    const guardian = new Guardian(builtinGuardrails());
    guardian.hasFanoutGrant = () => false;
    const vcs = new RealDirVcs(root);
    const sa = new Subagents(
      baseDeps({
        vcs,
        guardian,
        getApprovalMode: () => "out_of_band",
        requestWorkerApproval: async (p): Promise<ApprovalResponse> => ({ requestId: p.id, decision: "reject" }),
      }),
    );
    sa.register(coderWith(workerModel));

    await sa.dispatch([{ agent: "coder", task: "write rej" }]);

    const wt = path.join(root, "wt");
    const written = fs.existsSync(wt)
      ? fs.readdirSync(wt, { recursive: true }).some((f) => String(f).endsWith("rej.txt"))
      : false;
    expect(written).toBe(false);
  });

  it("policy_only with no grant fails fast on an unruled write (never asks)", async () => {
    const workerModel = fakeModel()
      .respondWithTools([{ name: "write_file", args: { path: "pf.txt", content: "z" } }])
      .respond(new AIMessage("done"));
    const guardian = new Guardian(builtinGuardrails());
    guardian.hasFanoutGrant = () => false;
    let asked = 0;
    const vcs = new RealDirVcs(root);
    const sa = new Subagents(
      baseDeps({
        vcs,
        guardian,
        interactive: false,
        getApprovalMode: () => "policy_only",
        requestWorkerApproval: async (p) => { asked++; return { requestId: p.id, decision: "approve" }; },
      }),
    );
    sa.register(coderWith(workerModel));

    await sa.dispatch([{ agent: "coder", task: "write pf" }]);

    expect(asked).toBe(0); // policy_only never asks
    const wt = path.join(root, "wt");
    const written = fs.existsSync(wt)
      ? fs.readdirSync(wt, { recursive: true }).some((f) => String(f).endsWith("pf.txt"))
      : false;
    expect(written).toBe(false);
  });
});

describe("Worker gate — reviewer, events, masking, eviction (§7.5, §8.3, §10.10)", () => {
  it("the reviewer cannot write even if its model tries (toolset + gate)", async () => {
    // The reviewer is read-only by toolset; even a scripted write is dropped as
    // an unknown tool for the reviewer (not in its resolved set) — never runs.
    const reviewerModel = fakeModel()
      .respondWithTools([{ name: "write_file", args: { path: "rv.txt", content: "x" } }])
      .respond(new AIMessage("PASS"));
    const vcs = new RealDirVcs(root);
    const sa = new Subagents(baseDeps({ vcs, reviewerModel: reviewerModel as never }));
    sa.register({ name: "coder", description: "c", systemPrompt: "c", tools: ["read_file"] });
    await sa.dispatch([{ agent: "coder", task: "noop" }]);
    const wt = path.join(root, "wt");
    const written = fs.existsSync(wt)
      ? fs.readdirSync(wt, { recursive: true }).some((f) => String(f).endsWith("rv.txt"))
      : false;
    expect(written).toBe(false);
  });

  it("TOOL_* events carry the worker scope", async () => {
    fs.writeFileSync(path.join(root, "base.txt"), "hi");
    const scopes: ({ worker?: string } | undefined)[] = [];
    bus.subscribe("TOOL_STARTED", (e) => scopes.push(e.scope as { worker?: string }));
    const vcs = new RealDirVcs(root);
    const sa = new Subagents(baseDeps({ vcs }));
    const workerModel = fakeModel()
      .respondWithTools([{ name: "read_file", args: { path: "base.txt" } }])
      .respond(new AIMessage("done"));
    // The worker runs in its own worktree; a read of a worktree-relative path
    // still passes the point (reads are free) and emits a worker-scoped event.
    fs.mkdirSync(path.join(root, "wt"), { recursive: true });
    workerModels.set("tool-ev-ep", workerModel);
    sa.register({ name: "coder", description: "c", systemPrompt: "c", tools: ["read_file", "write_file"], model: "tool-ev-ep" });
    await sa.dispatch([{ agent: "coder", task: "read" }]);
    expect(scopes.some((s) => typeof s?.worker === "string" && s.worker.includes("-w"))).toBe(true);
  });

  it("a worker's large secret-bearing output is evicted to the PARENT session cache and masked", async () => {
    // A big read result (> threshold) is evicted; the FULL masked body is written
    // through the injected writer, keyed by the PARENT session id (§7, §8.3).
    const big = ("AKIA" + "A".repeat(20) + " line\n").repeat(4000);
    const workerModel = fakeModel()
      .respondWithTools([{ name: "read_file", args: { path: "big.txt" } }])
      .respond(new AIMessage("done"));
    const writes: { sessionId: string; body: string }[] = [];
    const evicted: unknown[] = [];
    bus.subscribe("TOOL_RESULT_EVICTED", (e) => evicted.push(e.payload));
    const vcs = new RealDirVcs(root);
    vcs.seedFiles = { "big.txt": big }; // the worker reads it inside its worktree
    const sa = new Subagents(
      baseDeps({
        vcs,
        window: 2000, // small window so the read evicts
        getConfig: () => cfg({ contextToolResultPct: 1 }),
        getOwnerSessionId: () => "parent-sess",
        writeEvictedResult: async (sessionId, _name, body) => {
          writes.push({ sessionId, body });
        },
      }),
    );
    workerModels.set("evict-ep", workerModel);
    sa.register({ name: "coder", description: "c", systemPrompt: "c", tools: ["read_file", "write_file"], model: "evict-ep" });
    await sa.dispatch([{ agent: "coder", task: "read big" }]);
    expect(writes.length).toBeGreaterThanOrEqual(1);
    expect(writes[0]!.sessionId).toBe("parent-sess"); // PARENT cache, not worker
    expect(writes[0]!.body).not.toContain("AKIA" + "A".repeat(20)); // masked
    expect(evicted.length).toBeGreaterThanOrEqual(1);
  });

  it("a staged (no-repo) worker still has no execute_command", async () => {
    // With no repo, a pure-write worker is staged and holds no shell tool; a
    // worker whose toolset lacks execute_command cannot run it regardless.
    const vcs = new RealDirVcs(root);
    vcs.repo = false;
    const sa = new Subagents(baseDeps({ vcs }));
    sa.register({ name: "coder", description: "c", systemPrompt: "c", tools: ["read_file", "write_file"] });
    expect(sa.resolvedTools("coder").some((t) => t.name === "execute_command")).toBe(false);
  });
});
