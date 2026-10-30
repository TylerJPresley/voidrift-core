/**
 * FAN-OUT ARCHITECTURE end to end (core-blueprint.md §7, §3.1, §13.11) — the
 * REAL live-turn path: the orchestrator model emits ONE `task` tool call in its
 * BATCH form during `runTurn`, the engine's real `task` tool validates it and
 * fans out through the shared `Subagents` use-case, and ONE consolidated
 * `ToolMessage` of bounded summaries converges to the orchestrator. Nothing is
 * driven through `api.subagents.dispatch` directly — the model drives it.
 *
 * Context: this suite reproduces and guards the architecture the 2026-10-23
 * fan-out defects exposed (`_internal/research/fanout-rca.md`,
 * `fanout-observations.md`): 5 workers failed with a recursion-limit on
 * over-broad tasks. The concern here is the ARCHITECTURE around that — parallel
 * bounding, dependency ordering, read-only denial, failure isolation,
 * cancellation, result bounding, and context/stream isolation — not the shimmer
 * panel (a CLI concern).
 *
 * Harness: the full `createCore` boot so the `task` tool is wired exactly as in
 * production, with a role-aware scripted model (`@langchain/core/testing`-style
 * `BaseChatModel` subclass) that plays orchestrator / worker / reviewer off the
 * ONE active endpoint keyed by message content and call order — the same
 * technique `engine-task-dispatch.e2e` uses. Concurrency is asserted with a
 * GATED barrier (promises + a peak counter), never sleeps. Offline/deterministic.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import type { ModelConfigEntry, Config } from "../config/schema.js";
import { seededPermissionsRecord } from "../test-support/seed-rules.js";

function text(messages: BaseMessage[]): string {
  return messages
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

/** A deferred promise (a one-shot gate) for the concurrency barrier. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * A role-aware scripted model (the orchestrator, every worker, and every
 * reviewer run off this ONE active endpoint). It decides its role from the
 * conversation:
 *   - reviewer prompt ("Review the work") → PASS;
 *   - a worker brief (carries the sentinel) → a per-worker hook (gate, write,
 *     or a tool loop) then a final text;
 *   - otherwise the orchestrator → emit the scripted first-turn `task` call(s),
 *     then finish.
 */
class RoleModel extends BaseChatModel {
  boundToolNames: string[] = [];
  orchestratorCalls = 0;
  /** Peak number of worker `_generate` bodies in flight AT ONCE (the real
   * overlap the semaphore allows). Observed inside the worker role only. */
  peakConcurrentWorkers = 0;
  private liveWorkers = 0;
  private readonly workerSeen = new Map<string, number>();

  constructor(
    private readonly spec: {
      sentinel: string;
      orchestratorToolCalls: { name: string; args: Record<string, unknown> }[];
      /** Optional barrier: a worker generation blocks until `release` resolves.
       * Used to prove real overlap: N workers must be in flight at once. */
      barrier?: Promise<void>;
      /** Called the first time each distinct worker brief is seen, with its
       * current in-flight count, so a test can release the barrier at a target. */
      onWorkerEnter?: (inFlight: number) => void;
      /** A per-worker-brief tool-call hook (keyed by a substring of the brief):
       * returns the tool calls that worker should emit on its first generation. */
      workerToolCalls?: (brief: string) => { name: string; args: Record<string, unknown> }[] | undefined;
      /** A per-worker-brief FINAL summary text (the worker's converging result).
       * Used to drive an oversized result through the by-reference seam. */
      workerFinalText?: (brief: string) => string | undefined;
    },
    params: BaseChatModelParams = {},
  ) {
    super(params);
  }
  _llmType(): string {
    return "fanout-role-fake";
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
    // Role by the LAST message only: a worker is invoked with its brief as the
    // sole/last user message, so the sentinel is in the last message. The
    // orchestrator's FINISHING turn has a ToolMessage (the consolidated result)
    // last — whose summaries may echo text — so keying on the whole conversation
    // would misroute it as a worker. The worker brief is the last message and its
    // type is `human`.
    const last = messages[messages.length - 1];
    const lastIsHumanBrief = last?.getType() === "human" && text([last]).includes(this.spec.sentinel);
    if (lastIsHumanBrief) {
      const brief = text([last!]);
      // ── worker role ────────────────────────────────────────────────────────
      this.liveWorkers += 1;
      this.peakConcurrentWorkers = Math.max(this.peakConcurrentWorkers, this.liveWorkers);
      this.spec.onWorkerEnter?.(this.liveWorkers);
      try {
        if (this.spec.barrier) await this.spec.barrier;
        const seen = this.workerSeen.get(brief) ?? 0;
        this.workerSeen.set(brief, seen + 1);
        const calls = seen === 0 ? this.spec.workerToolCalls?.(brief) : undefined;
        if (calls && calls.length > 0) {
          return {
            generations: [
              {
                text: "",
                message: new AIMessage({
                  content: "WORKER-SECRET-REASONING should never reach the orchestrator",
                  tool_calls: calls.map((c, i) => ({ id: `w${i}`, name: c.name, args: c.args })),
                }),
              },
            ],
          };
        }
        return { generations: [{ text: "worker done", message: new AIMessage(this.spec.workerFinalText?.(brief) ?? "worker summary: WORKER-SECRET-REASONING") }] };
      } finally {
        this.liveWorkers -= 1;
      }
    }
    // ── orchestrator role ──────────────────────────────────────────────────
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

function seed(extra: Partial<Config> = {}) {
  return {
    models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } },
    modelSelected: "t",
    permissions: seededPermissionsRecord(),
    ...extra,
  };
}

let ws: string;
const cores: { session: { shutdown: () => Promise<void> } }[] = [];

async function makeCore(model: RoleModel, seedCfg: Record<string, unknown>, startAgent?: string) {
  const ready = await createCore({
    workspaceRoot: ws,
    configStore: new InMemoryConfigStore(seedCfg),
    sessionRepository: new InMemorySessionRepository(),
    checkpointer: createMemoryCheckpointer(),
    chatModelFactory: factory(model),
    ...(startAgent ? { startAgent } : {}),
  });
  cores.push(ready.api);
  return ready;
}

/** Seed read + write top-levels and workers, mirroring the seeded shape. */
async function seedAgents(api: Awaited<ReturnType<typeof createCore>>["api"]) {
  await api.agents.create({ name: "research", description: "reads and delegates", kind: "top-level", systemPrompt: "RESEARCH", tools: ["read_file", "glob_files", "search_contents", "task"], workers: ["researcher"], unlisted: "deny", order: 20 });
  await api.agents.create({ name: "vibe", description: "delegates every change", kind: "top-level", systemPrompt: "VIBE", tools: ["read_file", "task"], workers: "all", unlisted: "allow", confirm: true, order: 30 });
  await api.agents.create({ name: "researcher", description: "read-only investigation", kind: "worker", systemPrompt: "RSRCH", tools: ["read_file", "glob_files"] });
  await api.agents.create({ name: "implementer", description: "writes code in isolation", kind: "worker", systemPrompt: "IMPL", tools: ["read_file", "write_file", "edit_file"] });
}

function fiveTasks(sentinel: string) {
  return Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, worker: "researcher", task: `${sentinel} slice ${i}` }));
}

async function startResearch(api: Awaited<ReturnType<typeof createCore>>["api"]) {
  const created = await api.session.create({});
  const id = created.ok ? created.value.id : "";
  await api.session.setMode(id, "research");
  return id;
}

describe("fan-out architecture end to end (§7)", () => {
  beforeEach(() => {
    ws = hermeticTmp("fanout-arch");
    cores.length = 0;
  });
  afterEach(async () => {
    for (const c of cores) await c.session.shutdown().catch(() => undefined);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("(1) a batch of 5 runs in parallel bounded by turnMaxConcurrency (gated overlap, no sleeps)", async () => {
    const concurrency = 3;
    const gate = deferred();
    const model = new RoleModel({
      sentinel: "PARALLEL5",
      orchestratorToolCalls: [{ name: "task", args: { tasks: fiveTasks("PARALLEL5") } }],
      barrier: gate.promise,
      // Release only once `concurrency` workers are simultaneously in flight —
      // proving the semaphore lets exactly that many overlap, and that the batch
      // did NOT serialize (which would deadlock here and time out).
      onWorkerEnter: (inFlight) => {
        if (inFlight >= concurrency) gate.resolve();
      },
    });
    const { api } = await makeCore(model, seed({ turnMaxConcurrency: concurrency } as Partial<Config>), "research");
    await seedAgents(api);
    const id = await startResearch(api);
    const res = await api.session.send(id, { input: "fan out five" });
    expect(res.ok && res.value.status).toBe("completed");
    // Real overlap: at least `concurrency` worker bodies were in flight at once…
    expect(model.peakConcurrentWorkers).toBeGreaterThanOrEqual(concurrency);
    // …and NEVER more than the bound (the semaphore never over-admits).
    expect(model.peakConcurrentWorkers).toBeLessThanOrEqual(concurrency);
  }, 20_000);

  it("(2) dependsOn ordering: a dependent starts only after its dependencies finish", async () => {
    let cBrief = "";
    const order: string[] = [];
    const model = new RoleModel({
      sentinel: "DEPORD",
      orchestratorToolCalls: [
        {
          name: "task",
          args: {
            tasks: [
              { id: "a", worker: "researcher", task: "DEPORD survey A" },
              { id: "b", worker: "researcher", task: "DEPORD survey B" },
              { id: "c", worker: "researcher", task: "DEPORD combine C", dependsOn: ["a", "b"] },
            ],
          },
        },
      ],
      // a and b emit DISTINCT summaries; the dependent c receives BOTH prefixed
      // into its brief (§7.2 — a dependent works from its dependencies' summaries
      // by reference). This is the deterministic dependsOn contract: c cannot
      // carry a's and b's summaries unless both finished before c started.
      workerFinalText: (brief) => {
        if (/survey A/.test(brief)) return "SUMMARY-OF-A done";
        if (/survey B/.test(brief)) return "SUMMARY-OF-B done";
        return undefined;
      },
      workerToolCalls: (brief) => {
        if (/survey A/.test(brief)) order.push("a");
        else if (/survey B/.test(brief)) order.push("b");
        else if (/combine C/.test(brief)) {
          order.push("c");
          cBrief = brief;
        }
        return undefined;
      },
    });
    const { api } = await makeCore(model, seed({ turnMaxConcurrency: 4 } as Partial<Config>), "research");
    await seedAgents(api);
    const id = await startResearch(api);
    const res = await api.session.send(id, { input: "dependency chain" });
    expect(res.ok && res.value.status).toBe("completed");
    // c ran, and its brief carries BOTH dependencies' summaries — only possible
    // if a AND b finished before c started (the real dependsOn guarantee).
    expect(order).toContain("c");
    expect(cBrief).toContain("SUMMARY-OF-A");
    expect(cBrief).toContain("SUMMARY-OF-B");
    // Belt and braces: both a and b were observed before c in the run order.
    const cAt = order.indexOf("c");
    expect(order.slice(0, cAt)).toEqual(expect.arrayContaining(["a", "b"]));
  }, 20_000);

  it("(3) a read-only worker cannot write: the write tool is denied and the file is unchanged", async () => {
    // `researcher` is read-class (read_file/glob_files only). If the worker
    // model emits a write_file call, the worker has no such tool bound → it is an
    // unknown/denied call and the file never lands.
    const model = new RoleModel({
      sentinel: "RO-WRITE",
      orchestratorToolCalls: [{ name: "task", args: { tasks: [{ id: "a", worker: "researcher", task: "RO-WRITE try to write" }] } }],
      workerToolCalls: () => [{ name: "write_file", args: { path: "should-not-exist.txt", content: "nope\n" } }],
    });
    const { api } = await makeCore(model, seed({ turnMaxConcurrency: 2 } as Partial<Config>), "research");
    await seedAgents(api);
    const id = await startResearch(api);
    const res = await api.session.send(id, { input: "read-only cannot write" });
    expect(res.ok && res.value.status).toBe("completed");
    // The read-only worker never wrote the file.
    expect(fsSync.existsSync(path.join(ws, "should-not-exist.txt"))).toBe(false);
  }, 20_000);

  it("(4) one worker failing is isolated and reported with a reason; the others succeed", async () => {
    // Drive one worker to a recursion-limit failure with a tiny budget by making
    // its model loop forever (always emit a read_file tool call), while the other
    // workers finish normally. The failing worker is reported `failed`; siblings
    // are unaffected.
    const model = new RoleModel({
      sentinel: "ISO-FAIL",
      orchestratorToolCalls: [
        {
          name: "task",
          args: {
            tasks: [
              { id: "ok1", worker: "researcher", task: "ISO-FAIL good one" },
              { id: "bad", worker: "researcher", task: "ISO-FAIL LOOP forever" },
              { id: "ok2", worker: "researcher", task: "ISO-FAIL good two" },
            ],
          },
        },
      ],
      // The "bad" worker loops (never a final text) → it exhausts its recursion
      // budget and invokeAgent returns { ok:false } → the worker is `failed`.
      workerToolCalls: (brief) => (/LOOP forever/.test(brief) ? [{ name: "read_file", args: { path: "base.txt" } }] : undefined),
    });
    const statuses: { taskId: string | undefined; status: string }[] = [];
    // subagentRecursionLimit tiny so the loop fails fast and deterministically.
    const { api } = await makeCore(model, seed({ turnMaxConcurrency: 3, subagentRecursionLimit: 3 } as Partial<Config>), "research");
    await seedAgents(api);
    fsSync.writeFileSync(path.join(ws, "base.txt"), "base\n");
    api.events.subscribe("WORKER_STATUS_CHANGED", (e) => {
      const p = e.payload as { taskId?: string; status: string };
      statuses.push({ taskId: p.taskId, status: p.status });
    });
    const id = await startResearch(api);
    const res = await api.session.send(id, { input: "one fails, others fine" });
    expect(res.ok && res.value.status).toBe("completed");
    const finalOf = (tid: string) => statuses.filter((s) => s.taskId === tid).at(-1)?.status;
    // The looping worker ended failed; the two others reached a success state.
    expect(finalOf("bad")).toBe("failed");
    expect(["merged", "reviewed", "succeeded"]).toContain(finalOf("ok1"));
    expect(["merged", "reviewed", "succeeded"]).toContain(finalOf("ok2"));
    // The consolidated tool result the ORCHESTRATOR sees names the failed task
    // with a reason, and the batch does not abort the siblings.
    const r = res.ok ? res.value : undefined;
    expect(r?.status).toBe("completed");
  }, 20_000);

  it("(5) cancel mid-fan-out leaves no running workers and no partial state", async () => {
    const gate = deferred();
    let sessionId = "";
    let apiRef: Awaited<ReturnType<typeof createCore>>["api"];
    const model = new RoleModel({
      sentinel: "CANCELME",
      orchestratorToolCalls: [{ name: "task", args: { tasks: fiveTasks("CANCELME") } }],
      // Each worker blocks on the gate; once the first batch of workers is in
      // flight, cancel the turn, THEN release the gate so the workers resume into
      // an already-aborted signal and transition to aborted (never merged).
      barrier: gate.promise,
      onWorkerEnter: (inFlight) => {
        if (inFlight >= 2) {
          // Cancel the live turn mid-fan-out, then let the gate open.
          void apiRef.session.cancel(sessionId).finally(() => gate.resolve());
        }
      },
    });
    const { api } = await makeCore(model, seed({ turnMaxConcurrency: 3 } as Partial<Config>), "research");
    apiRef = api;
    await seedAgents(api);
    sessionId = await startResearch(api);
    const statuses: string[] = [];
    api.events.subscribe("WORKER_STATUS_CHANGED", (e) => statuses.push((e.payload as { status: string }).status));
    const res = await api.session.send(sessionId, { input: "cancel me" });
    expect(res.ok).toBe(true);
    // No worker is left running: the live worker list has no `running` entries.
    const live = await api.subagents.list();
    const running = live.ok ? (live.value as { status: string }[]).filter((w) => w.status === "running") : [];
    expect(running).toHaveLength(0);
    // The cancel reached the fan-out: at least one worker aborted and none merged
    // (read-class workers merge only on success; a cancel precludes it).
    expect(statuses).toContain("aborted");
    expect(statuses).not.toContain("merged");
  }, 20_000);

  it("(6) the consolidated result respects task.batchResultMaxChars with a by-reference remainder", async () => {
    // A worker returns a summary far larger than the cap. The consolidated tool
    // result the orchestrator sees carries a bounded head + a `[full result:
    // <handle>]` reference, never the whole body inline.
    const model = new RoleModel({
      sentinel: "BIGRESULT",
      orchestratorToolCalls: [{ name: "task", args: { tasks: [{ id: "a", worker: "researcher", task: "BIGRESULT produce a big summary" }] } }],
      // The worker's FINAL summary is its converging result; make it far larger
      // than the cap so the by-reference seam must engage (§7.2).
      workerFinalText: () => "HEAD-MARKER " + "Z".repeat(20_000),
    });
    const { api } = await makeCore(model, seed({ turnMaxConcurrency: 2, limits: { task: { batchResultMaxChars: 200 } } } as unknown as Partial<Config>), "research");
    await seedAgents(api);
    const byRef: { what: string; key: string }[] = [];
    api.events.subscribe("BY_REFERENCE", (e) => byRef.push(e.payload as { what: string; key: string }));
    const id = await startResearch(api);
    const res = await api.session.send(id, { input: "big result" });
    expect(res.ok && res.value.status).toBe("completed");
    // The oversized result tripped the batch-result cap and stored the WHOLE body
    // by reference (one BY_REFERENCE naming the batch-result key).
    expect(byRef.some((b) => b.key === "task.batchResultMaxChars")).toBe(true);
    // The orchestrator's consolidated tool result holds a bounded HEAD plus a
    // `[full result: <handle>]` reference — never the whole 20k body inline.
    const exp = await api.session.export(id, { format: "md", includeToolResults: true });
    expect(exp.ok).toBe(true);
    const body = exp.ok ? exp.value.content ?? "" : "";
    expect(body).toContain("HEAD-MARKER");
    expect(body).toMatch(/\[full result: [^\]]+\]/);
    // The full 20k payload did NOT land inline in the orchestrator conversation.
    expect(body).not.toContain("Z".repeat(1_000));
  }, 20_000);

  it("(7) worker transcripts never enter the orchestrator messages (orchestrator context stays small)", async () => {
    const model = new RoleModel({
      sentinel: "NOLEAK-T",
      orchestratorToolCalls: [{ name: "task", args: { tasks: fiveTasks("NOLEAK-T") } }],
      // Each worker does a read then finishes; its transcript (tool calls, tool
      // results, its own reasoning) must stay inside the worker, not the
      // orchestrator conversation.
      workerToolCalls: () => [{ name: "read_file", args: { path: "base.txt" } }],
    });
    const { api } = await makeCore(model, seed({ turnMaxConcurrency: 3 } as Partial<Config>), "research");
    await seedAgents(api);
    fsSync.writeFileSync(path.join(ws, "base.txt"), "base\n");
    const id = await startResearch(api);
    const res = await api.session.send(id, { input: "no transcript leak" });
    expect(res.ok && res.value.status).toBe("completed");
    const exp = await api.session.export(id, { format: "md", includeToolResults: true });
    expect(exp.ok).toBe(true);
    const body = exp.ok ? exp.value.content ?? "" : "";
    // The orchestrator transcript never contains a worker's internal tool-call
    // transcript. A worker's read_file call/args live only in the worker.
    expect(body).not.toContain("should never reach the orchestrator");
    // The orchestrator holds only the bounded, consolidated summary rows — its
    // conversation is small relative to five full worker transcripts.
    expect(body.length).toBeLessThan(20_000);
  }, 20_000);

  it("(8) journal/log attribution is per worker (agent + taskId on each worker event)", async () => {
    const model = new RoleModel({
      sentinel: "ATTRIB",
      orchestratorToolCalls: [
        {
          name: "task",
          args: {
            tasks: [
              { id: "alpha", worker: "researcher", task: "ATTRIB one" },
              { id: "beta", worker: "researcher", task: "ATTRIB two" },
            ],
          },
        },
      ],
      workerToolCalls: () => undefined,
    });
    const { api } = await makeCore(model, seed({ turnMaxConcurrency: 2 } as Partial<Config>), "research");
    await seedAgents(api);
    const events: { workerId?: string; agent?: string; taskId?: string }[] = [];
    api.events.subscribe("WORKER_STATUS_CHANGED", (e) => events.push(e.payload as { workerId?: string; agent?: string; taskId?: string }));
    const id = await startResearch(api);
    const res = await api.session.send(id, { input: "attribute per worker" });
    expect(res.ok && res.value.status).toBe("completed");
    // Each worker's events carry its agent name AND its batch task id, and the two
    // workers have distinct worker ids — per-worker attribution, not a lump.
    expect(events.some((e) => e.agent === "researcher" && e.taskId === "alpha")).toBe(true);
    expect(events.some((e) => e.agent === "researcher" && e.taskId === "beta")).toBe(true);
    const ids = new Set(events.map((e) => e.workerId).filter(Boolean));
    expect(ids.size).toBeGreaterThanOrEqual(2);
  }, 20_000);

  // DEFECT (reproduced) — worker transcript content leaks into the ORCHESTRATOR
  // token stream. `fanout-observations.md` item 3 flagged this unconfirmed
  // ("worker reasoning leaks into the orchestrator's expanded Thought view …
  // suspect a core event-scope bug … needs a reproduction against core"); this
  // test is that reproduction. The orchestrator turn streams via
  // `agent.stream(..., streamMode:["messages"])` (engine.ts:2583) and emits every
  // surfaced chunk as a session-scoped TOKEN_STREAM/REASONING_STREAM
  // (engine.ts:2607/2611, scope `{ session }`, NO worker scope). A worker runs
  // via `Subagents.invokeAgent` → `agent.invoke` (subagents.ts:1457) with only
  // `{ recursionLimit, signal }` and NO isolated callback manager, so LangChain's
  // AsyncLocalStorage callback propagation threads the worker's model chunks into
  // the ORCHESTRATOR's live `messages` stream. Result: worker content reaches the
  // owner session stream UNSCOPED (scope.worker === undefined), so the CLI's
  // `subscriptions.ts` worker-drop filter (which keys on scope.worker) cannot
  // suppress it. Evidence: with this test un-skipped, streamed orchestrator
  // tokens contain the worker-only marker "WORKER-SECRET-REASONING" while
  // `workerScoped` stays 0. Fix is in core (isolate the worker invoke's callbacks
  // from the parent run tree, or scope the worker's streamed chunks to
  // `{ session, worker }`), so per the brief src is NOT changed here.
  it("(9) no worker reasoning leaks into the orchestrator stream", async () => {
    // Intended invariant (currently VIOLATED): the engine emits
    // TOKEN_STREAM/REASONING_STREAM only for the ORCHESTRATOR turn, and a worker's
    // reasoning is never streamed to the owner session as orchestrator output.
    const model = new RoleModel({
      sentinel: "NOLEAK-R",
      orchestratorToolCalls: [{ name: "task", args: { tasks: fiveTasks("NOLEAK-R") } }],
      workerToolCalls: () => [{ name: "read_file", args: { path: "base.txt" } }],
    });
    const { api } = await makeCore(model, seed({ turnMaxConcurrency: 3 } as Partial<Config>), "research");
    await seedAgents(api);
    fsSync.writeFileSync(path.join(ws, "base.txt"), "base\n");
    const id = await startResearch(api);
    const streamTokens: string[] = [];
    let workerScoped = 0;
    for (const t of ["TOKEN_STREAM", "REASONING_STREAM"] as const) {
      api.events.subscribe(t, (e) => {
        if (e.scope.worker !== undefined) workerScoped += 1;
        const p = e.payload as { token?: string };
        if (typeof p.token === "string") streamTokens.push(p.token);
      });
    }
    const res = await api.session.send(id, { input: "no reasoning leak" });
    expect(res.ok && res.value.status).toBe("completed");
    // No stream event was worker-scoped (worker reasoning is never streamed as
    // orchestrator output), and no streamed orchestrator token carried the
    // worker's secret reasoning marker.
    expect(workerScoped).toBe(0);
    expect(streamTokens.join("")).not.toContain("WORKER-SECRET-REASONING");
  }, 20_000);
});
