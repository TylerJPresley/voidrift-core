/**
 * Worker-level surprise detection over the REAL chain (core-blueprint.md §9.5.1,
 * §10.11; §7). Plan steps are commonly executed by DISPATCHED workers, so a
 * worker's writes are the main path a plan-scope's surprise seam must see.
 *
 * The sibling suite (engine-expectation-surprise.test.ts) drives an ORCHESTRATOR
 * write. This one drives the production delegation path end to end:
 *   - a real plan-scope grant is open under `plan:<id>` with an expectation;
 *   - a `vibe` top-level agent dispatches an `implementer` worker via the real
 *     model-callable `task` tool inside a live turn;
 *   - the worker (a scripted role model) writes a file OUTSIDE the prediction;
 *   - the worker's journal entry (in the SESSION's journal, via the shared
 *     decision point) carries `planStep` = the scope id — the regression this
 *     guards: before the fix the worker decision point got no `getActiveScopeId`
 *     and the entry carried no `planStep`, so the surprise was invisible;
 *   - clearing the scope emits exactly ONE masked surprise;
 *   - an honest worker write (inside the prediction) emits none.
 *
 * Deterministic/offline over a per-test git workspace and in-memory stores.
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
  permissions: {
    ...seededPermissionsRecord(),
    "allow-write": { tool: "write_file", decision: "allow" as const, priority: 0, source: "user" as const },
  },
};

function text(messages: BaseMessage[]): string {
  return messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
}

/** Role-aware scripted model: reviewer → PASS; worker brief (sentinel) → the
 * worker's write; otherwise orchestrator → the `task` call on its first turn. */
class RoleModel extends BaseChatModel {
  orchestratorCalls = 0;
  private readonly workerSeen = new Set<string>();
  constructor(
    private readonly spec: {
      sentinel: string;
      orchestratorToolCalls: { name: string; args: Record<string, unknown> }[];
      workerToolCalls: { name: string; args: Record<string, unknown> }[];
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
      if (this.spec.workerToolCalls.length > 0 && !this.workerSeen.has(this.spec.sentinel)) {
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

async function makeCore(model: RoleModel) {
  const ready = await createCore({
    workspaceRoot: ws,
    configStore: new InMemoryConfigStore(seed),
    sessionRepository: new InMemorySessionRepository(),
    checkpointer: createMemoryCheckpointer(),
    chatModelFactory: factory(model),
    startAgent: "vibe",
  });
  cores.push(ready.api);
  return ready;
}

async function seedAgents(api: Awaited<ReturnType<typeof createCore>>["api"]) {
  await api.agents.create({ name: "vibe", description: "delegates every change", kind: "top-level", systemPrompt: "VIBE", tools: ["read_file", "task"], workers: "all", unlisted: "allow", confirm: true, order: 30 });
  await api.agents.create({ name: "implementer", description: "writes code in isolation", kind: "worker", systemPrompt: "IMPL", tools: ["read_file", "write_file", "edit_file"] });
}

describe("Worker surprise detection over the real chain (§9.5.1, §7)", () => {
  beforeEach(() => {
    ws = hermeticTmp("jsurprise-worker");
    cores.length = 0;
    initRepo(ws);
  });
  afterEach(async () => {
    for (const c of cores) await c.session.shutdown().catch(() => undefined);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("an unpredicted WORKER write emits ONE surprise; the worker's journal entry planStep equals the scope id", async () => {
    const model = new RoleModel({
      sentinel: "LEAK-STEP",
      orchestratorToolCalls: [{ name: "task", args: { worker: "implementer", task: "LEAK-STEP write out/leaked.ts" } }],
      workerToolCalls: [{ name: "write_file", args: { path: "out/leaked.ts", content: "x\n" } }],
    });
    const { api } = await makeCore(model);
    await seedAgents(api);
    const warnings: EventEnvelope[] = [];
    api.events.subscribe("WARNING_EMITTED", (e) => warnings.push(e));

    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.setMode(id, "vibe");

    const scopeId = "plan:step-1";
    api.register.planScope(scopeId, { writeGlobs: ["out/**", "src/**"], executePatterns: [] });
    api.expectations.register({ scope: scopeId, predicted: ["src/**"] });

    const res = await api.session.send(id, { input: "delegate out/leaked.ts", approvalMode: "policy_only" });
    expect(res.ok && res.value.status).toBe("completed");

    // The worker's journal entry MUST carry the scope id — the regression guard.
    const entries = await api.session.journal.list(id);
    const write = entries.find((e) => e.tool === "write_file" && e.target === "out/leaked.ts");
    expect(write, "a journaled worker write for the scope's target").toBeTruthy();
    expect(write!.planStep).toBe(scopeId);

    api.register.clearPlanScope(scopeId);
    await new Promise((r) => setTimeout(r, 0));

    const surprises = warnings.filter((w) => (w.payload as { category?: string }).category === "surprise");
    expect(surprises).toHaveLength(1);
    const payload = surprises[0]!.payload as { pattern: string; count: number; source: string };
    expect(payload.source).toBe("expectation");
    expect(payload.count).toBe(1);
    expect(payload.pattern).toContain("out/leaked.ts");
  });

  it("an honest WORKER write (inside the prediction) emits no surprise", async () => {
    const model = new RoleModel({
      sentinel: "HONEST-STEP",
      orchestratorToolCalls: [{ name: "task", args: { worker: "implementer", task: "HONEST-STEP write src/app.ts" } }],
      workerToolCalls: [{ name: "write_file", args: { path: "src/app.ts", content: "x\n" } }],
    });
    const { api } = await makeCore(model);
    await seedAgents(api);
    const warnings: EventEnvelope[] = [];
    api.events.subscribe("WARNING_EMITTED", (e) => warnings.push(e));

    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.setMode(id, "vibe");

    const scopeId = "plan:step-2";
    api.register.planScope(scopeId, { writeGlobs: ["src/**"], executePatterns: [] });
    api.expectations.register({ scope: scopeId, predicted: ["src/**"] });

    const res = await api.session.send(id, { input: "delegate src/app.ts", approvalMode: "policy_only" });
    expect(res.ok && res.value.status).toBe("completed");

    const entries = await api.session.journal.list(id);
    const write = entries.find((e) => e.tool === "write_file" && e.target === "src/app.ts");
    expect(write!.planStep).toBe(scopeId);

    api.register.clearPlanScope(scopeId);
    await new Promise((r) => setTimeout(r, 0));

    const surprises = warnings.filter((w) => (w.payload as { category?: string }).category === "surprise");
    expect(surprises).toHaveLength(0);
  });
});
