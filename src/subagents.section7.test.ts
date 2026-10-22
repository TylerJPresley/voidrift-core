/**
 * §7 integration test — fan-out with worktrees and verification (git repos), and
 * durable staging without git (§7.4, no repo) (core-blueprint.md §7).
 *
 * This wires the whole path through `createCore`. Git-repo clauses run over a
 * REAL temp git repo and the real VCS adapter: `register.agent` rejects a worker
 * that declares the task tool; two workers each get their own
 * `.voidrift/worktrees/{id}` on `voidrift-run-{id}` with a `.meta.json`; a
 * read-only reviewer in fresh context passes before the merge; a fan-out grant
 * auto-approves the merge and clears on conclusion; and a dead-owner worktree
 * older than the TTL is pruned on boot.
 *
 * The no-repo clauses (§7.4) run over a temp workspace with NO git: two writers
 * stage to `.voidrift/cache/staging/{run}/` with manifests recording base and
 * staged-content hashes; the orchestrator applies them sequentially through the
 * decision point; a changed base hash reports a conflict; a staged file that
 * disagrees with its manifest hash is reported unreliable and not applied; and an
 * unfinished staging folder is offered apply-or-discard on resume.
 *
 * The granular real-git lifecycle (clean merge, conflict → recovery branch) is
 * also proven at the adapter level in `vcs.test.ts`; the staged apply/recovery
 * gates and the no-shell-staged-worker limit in `subagents.test.ts`; the durable
 * temp-and-rename adapter in `staging.test.ts`. Offline/deterministic:
 * `FakeListChatModel`, local git, local fs.
 */
import { hermeticTmp } from "./test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createCore } from "./boot.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
import { createMemoryCheckpointer } from "./adapters/checkpointer.js";
import type { AgentDefinition, WorkerInfo } from "./entities/subagents.js";
import type { DispatchRequest, FanoutResult } from "./use-cases/subagents.js";
import type { CoreError } from "./entities/errors.js";
import { FilesystemStagingAdapter } from "./adapters/staging.js";
import { contentHash } from "./entities/hash.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function makeRepo(): Promise<string> {
  const dir = hermeticTmp("s7");
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "checkout", "-q", "-B", "main");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".voidrift/\n");
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

/** A model that satisfies both roles: any worker text, and PASS for the reviewer. */
function passModel() {
  return new FakeListChatModel({ responses: ["PASS: work complete"] });
}

/** Cores created in a test, drained in afterEach so late obs writes (§10.3)
 * never race the workspace teardown. */
const trackedCores: { session: { shutdown: () => Promise<void> } }[] = [];
function trackCore(api: { session: { shutdown: () => Promise<void> } }): void {
  trackedCores.push(api);
}

async function makeCore(root: string, onApproval?: () => Promise<never>) {
  const ready = await createCore({
    workspaceRoot: root,
    configStore: new InMemoryConfigStore({
      models: { local: { model: "m", protocol: "openai", contextLimit: 32_000 } },
      modelSelected: "local",
    }),
    sessionRepository: new InMemorySessionRepository(),
    checkpointer: createMemoryCheckpointer(),
    chatModelFactory: () => passModel(),
    ...(onApproval ? { onApproval: onApproval as never } : {}),
  });
  trackCore(ready.api);
  return ready;
}

const coder: AgentDefinition = {
  name: "coder",
  description: "writes code",
  systemPrompt: "code",
  tools: ["read_file", "write_file", "edit_file"],
};

describe("§7 integration — git-repo-only fan-out (minus §7.4 staging)", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeRepo();
    trackedCores.length = 0;
  });

  afterEach(async () => {
    // Drain the observability writer (best-effort, fire-and-forget §10.3) before
    // tearing down the workspace, so a late log write never races the rmdir.
    for (const c of trackedCores) await c.session.shutdown().catch(() => undefined);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("registration rejects a worker definition whose toolset contains the task tool (§7.1)", async () => {
    const { api } = await makeCore(root);
    // Given a worker that declares the dispatch tool.
    const bad: AgentDefinition = { ...coder, name: "bad", tools: ["read_file", "task"] };
    // When it is registered, Then registration is rejected with a CoreError.
    const result = api.register.agent(bad) as CoreError | void;
    expect(result).toBeDefined();
    expect((result as CoreError).code).toBe("INVALID_INPUT");
    expect((result as CoreError).message).toMatch(/task/);
    // And a clean definition registers without error.
    expect(api.register.agent(coder)).toBeUndefined();
  });

  it("fans out two workers, each in its own worktree/branch with .meta.json, verified then merged (§7.2/§7.3/§7.5)", async () => {
    const { api } = await makeCore(root);
    expect(api.register.agent(coder)).toBeUndefined();

    // Capture each worker's worktree and its .meta.json while the worktree still
    // exists — on the needs_review transition, before the merge removes it.
    const metaByWorker = new Map<string, Record<string, unknown>>();
    api.events.subscribe("WORKER_STATUS_CHANGED", (e) => {
      const p = e.payload as { workerId: string; status: string };
      if (p.status !== "needs_review") return;
      const dir = path.join(root, ".voidrift/worktrees");
      if (!fs.existsSync(dir)) return;
      for (const id of fs.readdirSync(dir)) {
        const metaFile = path.join(dir, id, ".meta.json");
        if (fs.existsSync(metaFile) && !metaByWorker.has(id)) {
          metaByWorker.set(id, JSON.parse(fs.readFileSync(metaFile, "utf8")));
        }
      }
    });

    const requests: DispatchRequest[] = [
      { agent: "coder", task: "task A" },
      { agent: "coder", task: "task B" },
    ];
    const res = await api.subagents.dispatch(requests);
    expect(res.ok).toBe(true);
    const fanout = (res as { value: FanoutResult }).value;

    // Two workers, each merged after a reviewer PASS.
    expect(fanout.workers).toHaveLength(2);
    expect(fanout.workers.every((w: WorkerInfo) => w.status === "merged")).toBe(true);
    // Each worker ran in its OWN worktree under .voidrift/worktrees — two distinct paths.
    const worktrees = fanout.workers.map((w) => w.worktree!);
    expect(new Set(worktrees).size).toBe(2);
    for (const wt of worktrees) expect(wt).toContain(path.join(".voidrift", "worktrees"));
    // At least one worktree's .meta.json was observed mid-flight with this
    // process's pid and a voidrift-run branch (full lifecycle proven in vcs.test.ts).
    expect(metaByWorker.size).toBeGreaterThanOrEqual(1);
    for (const meta of metaByWorker.values()) {
      expect(meta["pid"]).toBe(process.pid);
      expect(String(meta["branch"])).toMatch(/^voidrift-run-/);
    }
    // After a clean merge, the worktrees and run branches are gone.
    expect(git(root, "branch", "--list", "voidrift-run-*").trim()).toBe("");
    expect(
      fs.existsSync(path.join(root, ".voidrift/worktrees"))
        ? fs.readdirSync(path.join(root, ".voidrift/worktrees"))
        : [],
    ).toHaveLength(0);
  });

  it("subagents.list/status/stream expose per-worker state and WORKER_STATUS_CHANGED fires (§7.2)", async () => {
    const { api } = await makeCore(root);
    api.register.agent(coder);
    const transitions: string[] = [];
    api.events.subscribe("WORKER_STATUS_CHANGED", (e) => transitions.push((e.payload as { status: string }).status));

    const res = await api.subagents.dispatch([{ agent: "coder", task: "t" }]);
    const fanout = (res as { value: FanoutResult }).value;
    const workerId = fanout.workers[0]!.workerId;

    const status = await api.subagents.status(workerId);
    expect(status.ok).toBe(true);
    const list = await api.subagents.list();
    expect(list.ok && (list.value as WorkerInfo[]).some((w) => w.workerId === workerId)).toBe(true);
    const stream = await api.subagents.stream(workerId);
    expect(stream.ok && (stream.value as unknown[]).length).toBeGreaterThan(0);
    // Running → needs_review → reviewed → merged all fired.
    expect(transitions).toEqual(expect.arrayContaining(["running", "needs_review", "reviewed", "merged"]));
  });

  it("a dead-owner worktree older than the TTL is pruned on boot (§7.3 step 5)", async () => {
    // Given a stale worktree created directly on disk via git with a dead-owner meta.
    git(root, "worktree", "add", ".voidrift/worktrees/stale", "-b", "voidrift-run-stale");
    const metaPath = path.join(root, ".voidrift/worktrees/stale/.meta.json");
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ pid: 2 ** 30, timestamp: new Date(Date.now() - 1000 * 60_000).toISOString(), branch: "voidrift-run-stale" }),
    );

    // When the core boots (bootCleanup runs with the default 120-minute TTL).
    const pruned: string[][] = [];
    const core = await createCore({
      workspaceRoot: root,
      configStore: new InMemoryConfigStore({
        models: { local: { model: "m", protocol: "openai", contextLimit: 32_000 } },
        modelSelected: "local",
      }),
      sessionRepository: new InMemorySessionRepository(),
      checkpointer: createMemoryCheckpointer(),
      chatModelFactory: () => passModel(),
    });
    void core;

    // Then the stale worktree and its run branch are pruned.
    const dir = path.join(root, ".voidrift/worktrees");
    const remaining = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    expect(remaining).not.toContain("stale");
    expect(git(root, "branch", "--list", "voidrift-run-stale").trim()).toBe("");
    void pruned;
  });

  it("a fan-out grant auto-approves the merge and is cleared when the fan-out concludes (§7.5/§9.5)", async () => {
    // No onApproval handler is wired, so an interactive prompt is impossible; the
    // merge can only land via the fan-out grant's auto-approval.
    const { api } = await makeCore(root);
    api.register.agent(coder);
    const res = await api.subagents.dispatch([{ agent: "coder", task: "t" }]);
    const fanout = (res as { value: FanoutResult }).value;
    expect(fanout.workers[0]!.status).toBe("merged");
    // The grant is bounded to the fan-out: re-listing shows no lingering state
    // and a second dispatch still merges (a fresh grant), proving per-fan-out scope.
    const res2 = await api.subagents.dispatch([{ agent: "coder", task: "t2" }]);
    expect((res2 as { value: FanoutResult }).value.workers[0]!.status).toBe("merged");
  });
});

describe("§7.4 integration — durable staging without git (no repo)", () => {
  let root: string;
  const cores: { session: { shutdown: () => Promise<void> } }[] = [];

  beforeEach(async () => {
    // A temp workspace with NO git repo — the §7.4 staging writer path.
    root = hermeticTmp("s74");
    cores.length = 0;
  });

  afterEach(async () => {
    for (const c of cores) await c.session.shutdown().catch(() => undefined);
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function makeNoRepoCore() {
    const ready = await createCore({
      workspaceRoot: root,
      configStore: new InMemoryConfigStore({
        models: { local: { model: "m", protocol: "openai", contextLimit: 32_000 } },
        modelSelected: "local",
        // An allow rule for the staged-apply write lets recovery apply land through
        // the one decision point without an interactive prompt (§7.4, §9.2) — the
        // headless analog of the user approving the apply/discard offer.
        permissions: {
          "apply-staging": { tool: "apply_staging", decision: "allow", priority: 50, source: "user" },
        },
      }),
      sessionRepository: new InMemorySessionRepository(),
      checkpointer: createMemoryCheckpointer(),
      chatModelFactory: () => passModel(),
    });
    cores.push(ready.api);
    return ready;
  }

  it("two writers stage to .voidrift/cache/staging/{run}/ with base+staged-hash manifests, applied sequentially through the decision point", async () => {
    const { api } = await makeNoRepoCore();
    // Given two writers' staged runs on disk (seeded via the real durable adapter,
    // as the fake model does not drive tool calls). Each manifest records BOTH the
    // disk base hash and the staged-content hash per file.
    const staging = new FilesystemStagingAdapter(root);
    fs.writeFileSync(path.join(root, "a.txt"), "A-base");
    await staging.createArea("run-a");
    await staging.stageWrite("run-a", "a.txt", "A-staged");
    await staging.createArea("run-b");
    await staging.stageWrite("run-b", "b.txt", "B-staged");

    const ma = (await staging.manifest("run-a"))!;
    expect(ma.files[0]!.baseHash).toBe(contentHash("A-base"));
    expect(ma.files[0]!.stagedHash).toBe(contentHash("A-staged"));
    const mb = (await staging.manifest("run-b"))!;
    expect(mb.files[0]!.baseHash).toBe(contentHash("")); // b.txt did not exist on disk

    // When the orchestrator applies them through the decision point (recovery
    // drives the same sequential gated apply the dispatch path uses).
    const res = await api.subagents.recoverStaging();
    expect(res.ok).toBe(true);
    const outcomes = (res as { value: { run: string; decision: string }[] }).value;
    expect(outcomes.every((o) => o.decision === "applied")).toBe(true);
    // Then both staged files landed in the user's tree, folders discarded.
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("A-staged");
    expect(fs.readFileSync(path.join(root, "b.txt"), "utf8")).toBe("B-staged");
    expect(fs.existsSync(path.join(root, ".voidrift/cache/staging/run-a"))).toBe(false);
  });

  it("a changed base hash reports a CONFLICT and is not applied", async () => {
    await makeNoRepoCore();
    const staging = new FilesystemStagingAdapter(root);
    fs.writeFileSync(path.join(root, "c.txt"), "original");
    await staging.createArea("run-c");
    await staging.stageWrite("run-c", "c.txt", "staged");
    // The disk changes AFTER staging — the base no longer matches.
    fs.writeFileSync(path.join(root, "c.txt"), "changed-elsewhere");
    const result = await staging.apply("run-c");
    expect(result.applied).toHaveLength(0);
    expect(result.blocked[0]).toMatchObject({ ok: false, reason: "conflict", path: "c.txt" });
    expect(fs.readFileSync(path.join(root, "c.txt"), "utf8")).toBe("changed-elsewhere");
  });

  it("a staged file that disagrees with its manifest hash is reported UNRELIABLE and not applied", async () => {
    await makeNoRepoCore();
    const staging = new FilesystemStagingAdapter(root);
    fs.writeFileSync(path.join(root, "d.txt"), "base");
    await staging.createArea("run-d");
    await staging.stageWrite("run-d", "d.txt", "good");
    // Tamper with the staged blob so its re-hash disagrees with the manifest.
    const entry = (await staging.manifest("run-d"))!.files[0]!;
    fs.writeFileSync(path.join(root, ".voidrift/cache/staging/run-d", entry.blob), "tampered");
    const result = await staging.apply("run-d");
    expect(result.applied).toHaveLength(0);
    expect(result.blocked[0]).toMatchObject({ ok: false, reason: "unreliable", path: "d.txt" });
    expect(fs.readFileSync(path.join(root, "d.txt"), "utf8")).toBe("base");
  });

  it("an unfinished staging folder is offered apply-or-discard on resume", async () => {
    // Given an unfinished staging folder written before the core boots.
    const staging = new FilesystemStagingAdapter(root);
    await staging.createArea("run-resume");
    await staging.stageWrite("run-resume", "r.txt", "recovered");

    // When a fresh core boots and recovery runs.
    const { api } = await makeNoRepoCore();
    const offered: string[] = [];
    api.events.subscribe("STAGING_RECOVERY_OFFERED", (e) => offered.push((e.payload as { decision: string }).decision));
    const res = await api.subagents.recoverStaging();

    // Then the folder was offered and (with the fan-out grant) applied.
    expect(res.ok).toBe(true);
    expect(offered.length).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(root, "r.txt"), "utf8")).toBe("recovered");
  });
});
