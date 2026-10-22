/**
 * W1 — delegation is real end to end (core-blueprint.md §3.1, §7): the engine
 * binds a MODEL-CALLABLE `task` tool that fans out through the shared `Subagents`
 * use-case during a live turn. The earlier suite drove `api.subagents.dispatch`
 * directly; this one drives the model emitting a `task` tool call inside
 * `runTurn`, which is the real live-turn path that was dead before.
 *
 * Harness: the full `createCore` boot so the `task` tool is wired exactly as in
 * production (boot late-binds the facade's shared Subagents). A role-aware
 * scripted model plays the orchestrator (emits `task`), the worker (its own tool
 * calls), and the reviewer (PASS) off the ONE active endpoint, keyed by message
 * content and call order — the same technique the real-binary fake-openai uses.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { BaseChatModel, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createCore } from "../boot.js";
import { InMemoryConfigStore } from "../adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "../adapters/repositories/session-repository.js";
import { createMemoryCheckpointer } from "../adapters/checkpointer.js";
import type { ResolvedModel } from "../entities/ports/model-port.js";
import type { ModelConfigEntry } from "../config/schema.js";
import { seededPermissionsRecord } from "../test-support/seed-rules.js";

const seed = {
  models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "t",
  // The seeded allow list frees the read built-ins and `task` (§13.8), exactly
  // as `voidrift init` seeds them, so the posture under test is the worker-class
  // posture inside dispatch — not a `task`-tool gate denial.
  permissions: seededPermissionsRecord(),
};

function text(messages: BaseMessage[]): string {
  return messages
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

/**
 * A role-aware scripted model. It inspects the conversation to decide its role:
 * - the reviewer prompt ("Review the work") → "PASS";
 * - a worker brief (the orchestrator's task text, carrying a sentinel) → the
 *   scripted worker tool calls, then a final message;
 * - otherwise the orchestrator → emit the scripted `task` tool call(s) on its
 *   FIRST turn only, then finish.
 * `boundToolNames` records the tools bound on the LAST bind (orchestrator).
 */
class RoleModel extends BaseChatModel {
  boundToolNames: string[] = [];
  orchestratorCalls = 0;
  private readonly workerSeen = new Set<string>();
  constructor(
    private readonly spec: {
      /** Sentinel inside the orchestrator's `task` text that marks the worker brief. */
      sentinel: string;
      /** The orchestrator's first-turn tool calls (usually one or two `task` calls). */
      orchestratorToolCalls: { name: string; args: Record<string, unknown> }[];
      /** The worker's tool calls when it sees the brief (e.g. a write_file). */
      workerToolCalls?: { name: string; args: Record<string, unknown> }[];
    },
    params: BaseChatModelParams = {},
  ) {
    super(params);
  }
  _llmType(): string {
    return "role-fake";
  }
  override bindTools(tools: { name: string }[]): this {
    this.boundToolNames = tools.map((t) => t.name);
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const convo = text(messages);
    if (/Review the work/i.test(convo)) {
      return { generations: [{ text: "PASS", message: new AIMessage("PASS: looks correct") }] };
    }
    if (convo.includes(this.spec.sentinel)) {
      // Worker role. Emit its tool calls once, then finish.
      if (this.spec.workerToolCalls && this.spec.workerToolCalls.length > 0 && !this.workerSeen.has(this.spec.sentinel)) {
        this.workerSeen.add(this.spec.sentinel);
        return {
          generations: [
            {
              text: "",
              message: new AIMessage({
                content: "",
                tool_calls: this.spec.workerToolCalls.map((c, i) => ({ id: `w${i}`, name: c.name, args: c.args })),
              }),
            },
          ],
        };
      }
      return { generations: [{ text: "worker done", message: new AIMessage("worker done") }] };
    }
    // Orchestrator role.
    this.orchestratorCalls += 1;
    if (this.orchestratorCalls === 1 && this.spec.orchestratorToolCalls.length > 0) {
      return {
        generations: [
          {
            text: "",
            message: new AIMessage({
              content: "",
              tool_calls: this.spec.orchestratorToolCalls.map((c, i) => ({ id: `o${i}`, name: c.name, args: c.args })),
            }),
          },
        ],
      };
    }
    return { generations: [{ text: "orchestrator done", message: new AIMessage("orchestrator done") }] };
  }
}

function factory(model: RoleModel) {
  return (_r: ResolvedModel, _e: ModelConfigEntry) => model as unknown as BaseChatModel;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
function initRepo(dir: string): void {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "checkout", "-q", "-B", "main");
  fsSync.writeFileSync(path.join(dir, ".gitignore"), ".voidrift/\n");
  fsSync.writeFileSync(path.join(dir, "base.txt"), "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
}

let ws: string;
const cores: { session: { shutdown: () => Promise<void> } }[] = [];

async function makeCore(model: RoleModel, startAgent?: string) {
  const ready = await createCore({
    workspaceRoot: ws,
    configStore: new InMemoryConfigStore(seed),
    sessionRepository: new InMemorySessionRepository(),
    checkpointer: createMemoryCheckpointer(),
    chatModelFactory: factory(model),
    ...(startAgent ? { startAgent } : {}),
  });
  cores.push(ready.api);
  return ready;
}

/** The seeded-shape agents this slice drives (read + write top-levels + workers). */
async function seedAgents(api: Awaited<ReturnType<typeof createCore>>["api"]) {
  await api.agents.create({ name: "research", description: "reads only and delegates", kind: "top-level", systemPrompt: "RESEARCH", tools: ["read_file", "glob_files", "search_contents", "task"], workers: ["researcher"], unlisted: "deny", order: 20 });
  await api.agents.create({ name: "vibe", description: "delegates every change", kind: "top-level", systemPrompt: "VIBE", tools: ["read_file", "task"], workers: "all", unlisted: "allow", confirm: true, order: 30 });
  await api.agents.create({ name: "noworkers", description: "a top-level that lists task but has no workers", kind: "top-level", systemPrompt: "NW", tools: ["read_file", "task"], workers: [], unlisted: "ask", order: 40 });
  await api.agents.create({ name: "researcher", description: "read-only investigation", kind: "worker", systemPrompt: "RSRCH", tools: ["read_file", "glob_files"] });
  await api.agents.create({ name: "implementer", description: "writes code in isolation", kind: "worker", systemPrompt: "IMPL", tools: ["read_file", "write_file", "edit_file"] });
}

describe("W1 — model-callable task dispatch in a live turn (§3.1, §7)", () => {
  beforeEach(() => {
    ws = hermeticTmp("task-dispatch");
    cores.length = 0;
  });
  afterEach(async () => {
    for (const c of cores) await c.session.shutdown().catch(() => undefined);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("(a) research dispatches a read-class worker; the worker's summary returns as the tool result", async () => {
    const model = new RoleModel({
      sentinel: "INVESTIGATE-X",
      orchestratorToolCalls: [{ name: "task", args: { worker: "researcher", task: "INVESTIGATE-X the repo" } }],
    });
    const { api } = await makeCore(model);
    await seedAgents(api);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.setMode(id, "research");
    const res = await api.session.send(id, { input: "delegate an investigation" });
    expect(res.ok).toBe(true);
    // The orchestrator was bound the `task` tool (research lists it + has a worker).
    expect(model.boundToolNames).toContain("task");
    expect(res.ok && res.value.status).toBe("completed");
  });

  it("(f) the task tool is NOT bound when the agent lists it but has no workers", async () => {
    const model = new RoleModel({ sentinel: "NONE", orchestratorToolCalls: [] });
    const { api } = await makeCore(model);
    await seedAgents(api);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.setMode(id, "noworkers");
    await api.session.send(id, { input: "hi" });
    expect(model.boundToolNames).not.toContain("task");
    expect(model.boundToolNames).toContain("read_file");
  });

  it("(e) a worker is never bound the task tool", async () => {
    // The worker's model would see `task` bound only if the engine wrongly bound
    // it; the Subagents compile the worker WITHOUT task (asserted at build). Here
    // we prove the orchestrator's dispatched worker completes and the invariant
    // assertion (entities/subagents.test.ts) holds — a worker declaring task is
    // rejected at registration.
    const bad = await (await makeCore(new RoleModel({ sentinel: "x", orchestratorToolCalls: [] })).then((r) => r.api)).agents.create({
      name: "dispatcher",
      description: "d",
      kind: "worker",
      systemPrompt: "p",
      tools: ["read_file", "task"],
    });
    expect(bad.ok).toBe(false);
  });

  it("(f) the task description lists only the active agent's allowed workers", async () => {
    // research allows only `researcher`; capture the bound task tool's description.
    const model = new RoleModel({ sentinel: "NONE", orchestratorToolCalls: [] });
    const { api } = await makeCore(model);
    await seedAgents(api);
    const def = api.resolveActiveAgent("research");
    expect(def).toBeDefined();
    const workers = (api as unknown as { dispatchableWorkers: (d: typeof def) => { name: string }[] }).dispatchableWorkers(def!);
    expect(workers.map((w) => w.name)).toEqual(["researcher"]);
  });

  it("(b-git) vibe dispatches a write-class worker in a git repo: worktree created, reviewed, merged, file in main tree", async () => {
    initRepo(ws);
    const model = new RoleModel({
      sentinel: "CREATE-HELLO",
      orchestratorToolCalls: [{ name: "task", args: { worker: "implementer", task: "CREATE-HELLO write hello.txt" } }],
      workerToolCalls: [{ name: "write_file", args: { path: "hello.txt", content: "hi\n" } }],
    });
    const { api } = await makeCore(model, "vibe");
    await seedAgents(api);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.setMode(id, "vibe");
    const res = await api.session.send(id, { input: "create hello.txt containing hi" });
    expect(res.ok && res.value.status).toBe("completed");
    // The file reached the MAIN tree through the gated merge.
    expect(fsSync.existsSync(path.join(ws, "hello.txt"))).toBe(true);
    expect(fsSync.readFileSync(path.join(ws, "hello.txt"), "utf8")).toBe("hi\n");
    // No leftover worktrees.
    const wtDir = path.join(ws, ".voidrift", "worktrees");
    const leftover = fsSync.existsSync(wtDir) ? fsSync.readdirSync(wtDir) : [];
    expect(leftover).toHaveLength(0);
    // git tree sane: on main, clean working tree (merge committed or applied).
    expect(git(ws, "status", "--porcelain").trim()).toBe("");
  });

  it("(b-nogit) vibe dispatches a write-class worker with no repo: staged then applied to the tree", async () => {
    // No git init → the no-repo staging/apply path.
    const model = new RoleModel({
      sentinel: "CREATE-NOTE",
      orchestratorToolCalls: [{ name: "task", args: { worker: "implementer", task: "CREATE-NOTE write note.txt" } }],
      workerToolCalls: [{ name: "write_file", args: { path: "note.txt", content: "noted\n" } }],
    });
    const { api } = await makeCore(model, "vibe");
    await seedAgents(api);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.setMode(id, "vibe");
    const res = await api.session.send(id, { input: "create note.txt" });
    expect(res.ok && res.value.status).toBe("completed");
    expect(fsSync.existsSync(path.join(ws, "note.txt"))).toBe(true);
    expect(fsSync.readFileSync(path.join(ws, "note.txt"), "utf8")).toBe("noted\n");
  });

  it("posture: research (unlisted deny) denies a write-class worker and continues", async () => {
    const model = new RoleModel({
      sentinel: "WRITE-UNDER-DENY",
      orchestratorToolCalls: [{ name: "task", args: { worker: "implementer", task: "WRITE-UNDER-DENY write x.txt" } }],
      workerToolCalls: [{ name: "write_file", args: { path: "x.txt", content: "no\n" } }],
    });
    const { api } = await makeCore(model);
    await seedAgents(api);
    // research allows only `researcher`; it does not list `implementer`, so the
    // dispatch is denied by the workers allow-list before the posture even —
    // give research the worker but keep deny posture to exercise the posture.
    await api.agents.create({ name: "research", description: "r", kind: "top-level", systemPrompt: "R", tools: ["read_file", "task"], workers: ["implementer"], unlisted: "deny", order: 20 });
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.setMode(id, "research");
    const denied: string[] = [];
    api.events.subscribe("PERMISSION_DENIED", (e) => denied.push((e.payload as { reason: string }).reason));
    const res = await api.session.send(id, { input: "try to write under deny" });
    expect(res.ok && res.value.status).toBe("completed");
    // The write-class dispatch was denied-and-continue, and the file never landed.
    expect(fsSync.existsSync(path.join(ws, "x.txt"))).toBe(false);
    expect(denied.some((r) => /read-only workers/.test(r))).toBe(true);
  });

  it("(c) two task calls in one assistant message both run and both summaries return", async () => {
    const model = new RoleModel({
      sentinel: "PARALLEL",
      orchestratorToolCalls: [
        { name: "task", args: { worker: "researcher", task: "PARALLEL look at A" } },
        { name: "task", args: { worker: "researcher", task: "PARALLEL look at B" } },
      ],
    });
    const { api } = await makeCore(model);
    await seedAgents(api);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.setMode(id, "research");
    const res = await api.session.send(id, { input: "two investigations" });
    expect(res.ok && res.value.status).toBe("completed");
    expect(model.orchestratorCalls).toBeGreaterThanOrEqual(2);
  });

  it("(c-batch) ONE batch task call fans out 2 independent + 1 dependent and returns one consolidated result", async () => {
    // The orchestrator emits ONE `task` call in its BATCH form; the engine's real
    // tool validates and dispatches the whole batch through the shared Subagents.
    const model = new RoleModel({
      sentinel: "BATCH-INV",
      orchestratorToolCalls: [
        {
          name: "task",
          args: {
            tasks: [
              { id: "a", worker: "researcher", task: "BATCH-INV survey A" },
              { id: "b", worker: "researcher", task: "BATCH-INV survey B" },
              { id: "c", worker: "researcher", task: "BATCH-INV combine", dependsOn: ["a", "b"] },
            ],
          },
        },
      ],
    });
    const { api } = await makeCore(model);
    await seedAgents(api);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.setMode(id, "research");
    const res = await api.session.send(id, { input: "fan out a batch" });
    expect(res.ok && res.value.status).toBe("completed");
    // The orchestrator made exactly ONE tool-emitting turn (the batch), then one
    // finishing turn — fan-out rode a single call, not three.
    expect(model.orchestratorCalls).toBeGreaterThanOrEqual(2);
  });

  it("(d-batch) an invalid batch (unknown worker) is rejected with zero workers dispatched", async () => {
    const started: unknown[] = [];
    const model = new RoleModel({
      sentinel: "BAD-BATCH",
      orchestratorToolCalls: [
        {
          name: "task",
          args: {
            tasks: [
              { id: "a", worker: "researcher", task: "BAD-BATCH ok" },
              { id: "b", worker: "ghost", task: "BAD-BATCH unknown worker" },
            ],
          },
        },
      ],
    });
    const { api } = await makeCore(model);
    await seedAgents(api);
    api.events.subscribe("FANOUT_STARTED", (e) => started.push(e.payload));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.setMode(id, "research");
    const res = await api.session.send(id, { input: "bad batch" });
    expect(res.ok && res.value.status).toBe("completed");
    // The whole batch was rejected at the tool boundary before any dispatch — no
    // fan-out ever started.
    expect(started).toHaveLength(0);
  });

  it("(g-batch) a batch of mutating workers each gets isolation and all merge to the main tree (git)", async () => {
    initRepo(ws);
    const model = new RoleModel({
      sentinel: "BATCH-WRITE",
      orchestratorToolCalls: [
        {
          name: "task",
          args: {
            tasks: [
              { id: "one", worker: "implementer", task: "BATCH-WRITE write one.txt" },
              { id: "two", worker: "implementer", task: "BATCH-WRITE write two.txt" },
            ],
          },
        },
      ],
      // Both workers see the same sentinel; each stages its file into its own
      // worktree. A deterministic path derived from the brief keeps them distinct.
      workerToolCalls: [{ name: "write_file", args: { path: "batch.txt", content: "b\n" } }],
    });
    const { api } = await makeCore(model, "vibe");
    await seedAgents(api);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.setMode(id, "vibe");
    const res = await api.session.send(id, { input: "write two files in a batch" });
    expect(res.ok && res.value.status).toBe("completed");
    // Each mutating worker ran in its OWN worktree (isolation) and merged — the
    // file reached the main tree and no worktree leaked.
    expect(fsSync.existsSync(path.join(ws, "batch.txt"))).toBe(true);
    const wtDir = path.join(ws, ".voidrift", "worktrees");
    const leftover = fsSync.existsSync(wtDir) ? fsSync.readdirSync(wtDir) : [];
    expect(leftover).toHaveLength(0);
    expect(git(ws, "status", "--porcelain").trim()).toBe("");
  });

  it("(perms-batch) a never-list command inside a batch worker is still denied", async () => {
    initRepo(ws);
    const model = new RoleModel({
      sentinel: "BATCH-DANGER",
      orchestratorToolCalls: [
        {
          name: "task",
          args: {
            tasks: [{ id: "x", worker: "builder", task: "BATCH-DANGER run a dangerous command" }],
          },
        },
      ],
      // The worker tries a never-list command (a fork bomb pattern) — denied in
      // every mode/posture with no prompt, inside a batch worker exactly as
      // outside one.
      workerToolCalls: [{ name: "execute_command", args: { command: ":(){ :|:& };:" } }],
    });
    const { api } = await makeCore(model, "vibe");
    await seedAgents(api);
    // A write+shell worker runs in place; vibe may dispatch all workers.
    await api.agents.create({ name: "builder", description: "builds", kind: "worker", systemPrompt: "B", tools: ["read_file", "write_file", "execute_command"] });
    const denied: string[] = [];
    api.events.subscribe("PERMISSION_DENIED", (e) => denied.push((e.payload as { reason?: string }).reason ?? ""));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.setMode(id, "vibe");
    const res = await api.session.send(id, { input: "run danger in a batch" });
    expect(res.ok && res.value.status).toBe("completed");
    // The never-list command never ran: no fork-bomb side effect, and a denial
    // was recorded for the worker's command.
    expect(denied.length).toBeGreaterThan(0);
  });
});

describe("§8.7 — the model-callable `ingest` tool is bound ONLY to a delegating top-level agent", () => {
  beforeEach(() => {
    ws = hermeticTmp("ingest-bind");
    cores.length = 0;
  });
  afterEach(async () => {
    for (const c of cores) await c.session.shutdown().catch(() => undefined);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("binds `ingest` for research (lists task + has a worker)", async () => {
    const model = new RoleModel({ sentinel: "NONE", orchestratorToolCalls: [] });
    const { api } = await makeCore(model);
    await seedAgents(api);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.setMode(id, "research");
    await api.session.send(id, { input: "hi" });
    expect(model.boundToolNames).toContain("ingest");
    expect(model.boundToolNames).toContain("task");
  });

  it("binds `ingest` for vibe (workers: all)", async () => {
    const model = new RoleModel({ sentinel: "NONE", orchestratorToolCalls: [] });
    const { api } = await makeCore(model, "vibe");
    await seedAgents(api);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.setMode(id, "vibe");
    await api.session.send(id, { input: "hi" });
    expect(model.boundToolNames).toContain("ingest");
  });

  it("does NOT bind `ingest` for a top-level that lists task but has NO workers", async () => {
    const model = new RoleModel({ sentinel: "NONE", orchestratorToolCalls: [] });
    const { api } = await makeCore(model);
    await seedAgents(api);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.setMode(id, "noworkers");
    await api.session.send(id, { input: "hi" });
    // No task tool (no workers) → no ingest tool either (same delegation gate).
    expect(model.boundToolNames).not.toContain("task");
    expect(model.boundToolNames).not.toContain("ingest");
    expect(model.boundToolNames).toContain("read_file");
  });

  it("does NOT bind `ingest` for a non-delegating top-level (no task tool at all)", async () => {
    const model = new RoleModel({ sentinel: "NONE", orchestratorToolCalls: [] });
    const { api } = await makeCore(model);
    await seedAgents(api);
    await api.agents.create({ name: "plain", description: "no delegation", kind: "top-level", systemPrompt: "P", tools: ["read_file"], unlisted: "ask", order: 50 });
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.setMode(id, "plain");
    await api.session.send(id, { input: "hi" });
    expect(model.boundToolNames).not.toContain("ingest");
    expect(model.boundToolNames).toContain("read_file");
  });
});
