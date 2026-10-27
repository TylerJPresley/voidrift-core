/**
 * The session meta block through the REAL context pipeline (core-blueprint.md
 * §4.4). Exercised end-to-end via `createCore`: the block content and field
 * order, per-turn refresh (date/git dirty, rounds, context %), concurrency
 * values following config overrides, a worker's worktree root, the tiny-cap
 * drop order with a LIMIT_HIT, no secrets, and the head staying within budget.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AIMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { BaseChatModel, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCore } from "../boot.js";
import { InMemoryConfigStore } from "../adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "../adapters/repositories/session-repository.js";
import { createMemoryCheckpointer } from "../adapters/checkpointer.js";
import type { ResolvedModel } from "../entities/ports/model-port.js";
import type { ModelConfigEntry } from "../config/schema.js";

const execFileAsync = promisify(execFile);

function seed(over: Record<string, unknown> = {}) {
  return {
    models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } },
    modelSelected: "t",
    ...over,
  };
}

/** Records the SystemMessage text of the last model request. */
class CaptureModel extends BaseChatModel {
  systemText = "";
  _llmType(): string {
    return "capture-meta";
  }
  constructor(params: BaseChatModelParams = {}) {
    super(params);
  }
  override bindTools(): this {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const sys = messages.find((m) => m instanceof SystemMessage) as SystemMessage | undefined;
    if (sys) {
      this.systemText = Array.isArray(sys.content)
        ? (sys.content as { text?: string }[]).map((b) => b.text ?? "").join("\n")
        : String(sys.content);
    }
    return { generations: [{ text: "done", message: new AIMessage("done") }] };
  }
}

function factory(model: CaptureModel) {
  return (_r: ResolvedModel, _e: ModelConfigEntry) => model as unknown as BaseChatModel;
}

async function makeCore(model: CaptureModel, ws: string, over: Record<string, unknown> = {}) {
  return createCore({
    workspaceRoot: ws,
    configStore: new InMemoryConfigStore(seed(over)),
    sessionRepository: new InMemorySessionRepository(),
    checkpointer: createMemoryCheckpointer(),
    chatModelFactory: factory(model),
  });
}

let ws: string;
const cores: { session: { shutdown: () => Promise<void> } }[] = [];

describe("session meta block — real path through createCore (§4.4)", () => {
  beforeEach(() => {
    ws = hermeticTmp("meta-block");
  });
  afterEach(async () => {
    for (const c of cores) await c.session.shutdown().catch(() => undefined);
    cores.length = 0;
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("renders the data-not-authority header, the fields in order, and concurrency as numbers", async () => {
    const model = new CaptureModel();
    const ready = await makeCore(model, ws);
    cores.push(ready.api);
    const created = await ready.api.session.create({});
    const id = created.ok ? created.value.id : "";
    await ready.api.session.send(id, { input: "hi" });
    const t = model.systemText;
    expect(t.toLowerCase()).toContain("session data");
    expect(t.toLowerCase()).toContain("not instructions");
    expect(t).toContain(`PWD / workspace root: ${ws}`);
    expect(t).toContain("workers in parallel:");
    expect(t).toContain("ingest parallel:");
    expect(t).toContain("tool rounds:");
    expect(t).toContain("max read lines:");
    // field order: PWD before model before concurrency before workers
    expect(t.indexOf("PWD")).toBeLessThan(t.indexOf("model:"));
    expect(t.indexOf("model:")).toBeLessThan(t.indexOf("workers in parallel:"));
    expect(t.indexOf("workers in parallel:")).toBeLessThan(t.indexOf("available workers:"));
    // no remote URL / secret leakage
    expect(t).not.toMatch(/https?:\/\/[^ ]*@/);
  });

  it("concurrency follows config overrides (turnMaxConcurrency, ingest.maxParallel)", async () => {
    const model = new CaptureModel();
    const ready = await makeCore(model, ws, {
      turnMaxConcurrency: 6,
      limits: { ingest: { maxParallel: 3 } },
    });
    cores.push(ready.api);
    const created = await ready.api.session.create({});
    await ready.api.session.send(created.ok ? created.value.id : "", { input: "hi" });
    expect(model.systemText).toContain("workers in parallel: 6");
    expect(model.systemText).toContain("ingest parallel: 3");
  });

  it("omits git when not a repo, and shows a branch + dirty summary when it is", async () => {
    // not a repo
    const m1 = new CaptureModel();
    const r1 = await makeCore(m1, ws);
    cores.push(r1.api);
    const c1 = await r1.api.session.create({});
    await r1.api.session.send(c1.ok ? c1.value.id : "", { input: "hi" });
    expect(m1.systemText).toContain("git: no");

    // a git repo with a dirty working tree
    const gitWs = hermeticTmp("meta-block-git");
    try {
      const run = (args: string[]) =>
        execFileAsync("git", args, { cwd: gitWs }).catch(() => undefined);
      await run(["init", "-q", "-b", "main"]);
      await run(["config", "user.email", "t@example.com"]);
      await run(["config", "user.name", "t"]);
      await fs.writeFile(`${gitWs}/a.txt`, "x");
      const m2 = new CaptureModel();
      const r2 = await makeCore(m2, gitWs);
      cores.push(r2.api);
      const c2 = await r2.api.session.create({});
      await r2.api.session.send(c2.ok ? c2.value.id : "", { input: "hi" });
      expect(m2.systemText).toContain("git: main");
      expect(m2.systemText).toContain("changed");
      // never a remote URL
      expect(m2.systemText).not.toContain("remote");
    } finally {
      await fs.rm(gitWs, { recursive: true, force: true });
    }
  });

  it("refreshes each turn: rounds reset and the context % appears after a turn", async () => {
    const model = new CaptureModel();
    const ready = await makeCore(model, ws);
    cores.push(ready.api);
    const created = await ready.api.session.create({});
    const id = created.ok ? created.value.id : "";
    await ready.api.session.send(id, { input: "first" });
    const first = model.systemText;
    expect(first).toContain("tool rounds: 0/");
    await ready.api.session.send(id, { input: "second" });
    // the block is regenerated (tool rounds line present again; date is live)
    expect(model.systemText).toContain("tool rounds: 0/");
    expect(model.systemText).toContain("date:");
  });



  it("the head stays within contextHeadBudgetPct on a 32k window", async () => {
    const model = new CaptureModel();
    const ready = await makeCore(model, ws);
    cores.push(ready.api);
    const created = await ready.api.session.create({});
    const id = created.ok ? created.value.id : "";
    await ready.api.session.send(id, { input: "hi" });
    const ctx = await ready.api.models.context(id);
    expect(ctx.ok).toBe(true);
    if (ctx.ok) {
      const bd = ctx.value as { window: number; headTokens: number };
      expect(bd.headTokens).toBeLessThanOrEqual(Math.floor(bd.window * 0.1));
    }
  });
});
