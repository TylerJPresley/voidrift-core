/**
 * Journal worker merge and apply (core-blueprint.md §10.11): "every write
 * action — a file write or edit, a merge or apply, a mutating MCP or plugin
 * tool, a remote effect — appends one journal entry at the moment the write
 * executes". A SUCCEEDED worktree merge (worktree → working tree) and a
 * SUCCEEDED staging apply (staging copy → tree) each append a journal entry per
 * merged/applied relative path, carrying the active plan-scope id as `planStep`
 * (metadata only, invariant 27) and, for a merge, an undo hint naming the
 * previous HEAD (README). A REFUSED merge appends nothing. The §9.5.1 surprise
 * seam then sees merged paths outside a scope's `predicted`.
 *
 * Real-path, createCore-level harness with a git worktree (the shape of
 * engine-task-dispatch.test.ts / engine-expectation-surprise-worker.test.ts):
 * a role-aware scripted model plays the orchestrator (emits `task`), the worker
 * (its write), and the reviewer (PASS).
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
import type { EventEnvelope } from "../entities/event-bus.js";

const seed = {
  models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "t",
  mutationLogLevel: "action",
  permissions: seededPermissionsRecord(),
};

function text(messages: BaseMessage[]): string {
  return messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
}

class RoleModel extends BaseChatModel {
  orchestratorCalls = 0;
  private readonly workerSeen = new Set<string>();
  constructor(
    private readonly spec: {
      sentinel: string;
      orchestratorToolCalls: { name: string; args: Record<string, unknown> }[];
      workerToolCalls?: { name: string; args: Record<string, unknown> }[];
    },
    params: BaseChatModelParams = {},
  ) {
    super(params);
  }
  _llmType(): string {
    return "role-fake";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const convo = text(messages);
    if (/Review the work/i.test(convo)) {
      return { generations: [{ text: "PASS", message: new AIMessage("PASS: looks correct") }] };
    }
    if (convo.includes(this.spec.sentinel)) {
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

async function makeCore(model: RoleModel, startAgent: string) {
  const ready = await createCore({
    workspaceRoot: ws,
    configStore: new InMemoryConfigStore(seed),
    sessionRepository: new InMemorySessionRepository(),
    checkpointer: createMemoryCheckpointer(),
    chatModelFactory: factory(model),
    startAgent,
  });
  cores.push(ready.api);
  return ready;
}

async function seedAgents(api: Awaited<ReturnType<typeof createCore>>["api"]) {
  await api.agents.create({ name: "vibe", description: "delegates every change", kind: "top-level", systemPrompt: "VIBE", tools: ["read_file", "task"], workers: "all", unlisted: "allow", confirm: true, order: 30 });
  await api.agents.create({ name: "research", description: "reads only and delegates", kind: "top-level", systemPrompt: "RESEARCH", tools: ["read_file", "task"], workers: ["implementer"], unlisted: "deny", order: 20 });
  await api.agents.create({ name: "implementer", description: "writes code in isolation", kind: "worker", systemPrompt: "IMPL", tools: ["read_file", "write_file", "edit_file"] });
}

describe("journal worker merge and apply (§10.11, §9.5.1)", () => {
  beforeEach(() => {
    ws = hermeticTmp("merge-apply-journal");
    cores.length = 0;
  });
  afterEach(async () => {
    for (const c of cores) await c.session.shutdown().catch(() => undefined);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("a merged worktree write appends a merge entry (path, planStep, previous-HEAD undo hint); the surprise seam sees the merged path", async () => {
    initRepo(ws);
    const model = new RoleModel({
      sentinel: "CREATE-HELLO",
      orchestratorToolCalls: [{ name: "task", args: { worker: "implementer", task: "CREATE-HELLO write hello.txt" } }],
      workerToolCalls: [{ name: "write_file", args: { path: "hello.txt", content: "hi\n" } }],
    });
    const { api } = await makeCore(model, "vibe");
    await seedAgents(api);
    const warnings: EventEnvelope[] = [];
    api.events.subscribe("WARNING_EMITTED", (e) => warnings.push(e));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.setMode(id, "vibe");

    const scopeId = "plan:merge-step";
    api.register.planScope(scopeId, { writeGlobs: ["**"], executePatterns: [] });
    api.expectations.register({ scope: scopeId, predicted: ["src/**"] });

    const res = await api.session.send(id, { input: "create hello.txt", approvalMode: "policy_only" });
    expect(res.ok && res.value.status).toBe("completed");
    expect(fsSync.existsSync(path.join(ws, "hello.txt"))).toBe(true);

    const entries = await api.session.journal.list(id);
    const merge = entries.filter((e) => e.tool === "merge_worktree");
    expect(merge.length).toBeGreaterThanOrEqual(1);
    expect(merge.map((e) => e.target)).toContain("hello.txt");
    expect(merge.every((e) => e.planStep === scopeId)).toBe(true);
    expect(merge.some((e) => typeof e.undoHint === "string" && /[0-9a-f]{7}/.test(e.undoHint!))).toBe(true);

    api.register.clearPlanScope(scopeId);
    await new Promise((r) => setTimeout(r, 0));
    const surprises = warnings.filter((w) => (w.payload as { category?: string }).category === "surprise");
    expect(surprises).toHaveLength(1);
    expect((surprises[0]!.payload as { pattern: string }).pattern).toContain("hello.txt");
  });

  it("a refused merge (read-only agent) appends no merge entry", async () => {
    initRepo(ws);
    const model = new RoleModel({
      sentinel: "WRITE-UNDER-DENY",
      orchestratorToolCalls: [{ name: "task", args: { worker: "implementer", task: "WRITE-UNDER-DENY write x.txt" } }],
      workerToolCalls: [{ name: "write_file", args: { path: "x.txt", content: "no\n" } }],
    });
    const { api } = await makeCore(model, "research");
    await seedAgents(api);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.setMode(id, "research");
    const res = await api.session.send(id, { input: "try to write under deny" });
    expect(res.ok && res.value.status).toBe("completed");
    expect(fsSync.existsSync(path.join(ws, "x.txt"))).toBe(false);
    const entries = await api.session.journal.list(id);
    expect(entries.filter((e) => e.tool === "merge_worktree")).toHaveLength(0);
  });

  it("a staged apply (no repo) appends an apply entry with the path and planStep", async () => {
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

    const scopeId = "plan:apply-step";
    api.register.planScope(scopeId, { writeGlobs: ["**"], executePatterns: [] });

    const res = await api.session.send(id, { input: "create note.txt", approvalMode: "policy_only" });
    expect(res.ok && res.value.status).toBe("completed");
    expect(fsSync.existsSync(path.join(ws, "note.txt"))).toBe(true);

    const entries = await api.session.journal.list(id);
    const apply = entries.filter((e) => e.tool === "apply_staging");
    expect(apply.length).toBeGreaterThanOrEqual(1);
    expect(apply.map((e) => e.target)).toContain("note.txt");
    expect(apply.every((e) => e.planStep === scopeId)).toBe(true);
    api.register.clearPlanScope(scopeId);
  });
});
