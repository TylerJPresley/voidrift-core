/**
 * Substrate tripwire — core-blueprint.md §1 assumption 6, §3.3, §5.2.
 *
 * A COMPLETED turn under the engine's `durability: "exit"` writes exactly ONE
 * checkpoint row for the turn's thread and NO `input`-source checkpoint —
 * LangGraph collapses the whole super-step chain (model + every tool round) to
 * a single row at graph exit. The companion tripwire
 * (`durability-exit-no-checkpoint.test.ts`) covers the ABORTED case; this one
 * covers the COMPLETED case, which nothing else asserts.
 *
 * Why it matters: the durable checkpoint file grows by one row per completed
 * turn only because of `durability: "exit"`. Under `async`/`default` the same
 * turn writes one `input` row plus one row per super-step — many rows per turn,
 * the legacy bloat the owner's real DB shows. A silent regression of the
 * engine's `threadConfig` durability would reintroduce that growth and pass the
 * rest of the gate; this tripwire fails on it (proven by the mutation run
 * recorded in _internal/scratch/checkpoint).
 *
 * Drives the REAL product path: a full `createCore` boot with a real
 * NodeSqliteSaver as the checkpointer, a scripted `fakeModel`, through
 * `api.session.send`. Offline/deterministic: temp SQLite DB under hermeticTmp,
 * no network, no live model.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs/promises";
import { createCore } from "../boot.js";
import { NodeSqliteSaver } from "../adapters/node-sqlite-saver.js";
import { InMemoryConfigStore } from "../adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "../adapters/repositories/session-repository.js";
import { seededPermissionsRecord } from "../test-support/seed-rules.js";
import type { ResolvedModel } from "../entities/ports/model-port.js";
import type { ModelConfigEntry } from "../config/schema.js";

const seed = {
  models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "t",
  // The seeded allow list frees the read built-ins and `task` (§13.8), exactly
  // as `voidrift init` seeds them, so the scripted tool rounds run headless
  // without a prompt.
  permissions: seededPermissionsRecord(),
};

function factory(script: () => ReturnType<typeof fakeModel>) {
  return (_r: ResolvedModel, _e: ModelConfigEntry) => script();
}

/** Count checkpoint rows for a thread and the sources present, read directly. */
function inspect(dbPath: string, threadId: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db
    .prepare("SELECT metadata FROM checkpoints WHERE thread_id = ?")
    .all(threadId) as { metadata: Uint8Array }[];
  let inputRows = 0;
  for (const r of rows) {
    let source: string | undefined;
    try {
      source = (JSON.parse(Buffer.from(r.metadata).toString("utf8")) as { source?: string }).source;
    } catch {
      /* non-JSON metadata counts as not-input */
    }
    if (source === "input") inputRows += 1;
  }
  db.close();
  return { total: rows.length, inputRows };
}

describe("substrate §1.6 — a COMPLETED turn under durability:exit writes exactly one checkpoint", () => {
  let dir: string;
  const cores: { session: { shutdown: () => Promise<void> } }[] = [];

  beforeEach(() => {
    dir = hermeticTmp("substrate-dur-one");
    cores.length = 0;
  });

  afterEach(async () => {
    for (const c of cores) await c.session.shutdown().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("a turn with 3 tool rounds persists ONE checkpoint and zero input-source rows", async () => {
    // Given a headless turn that drives three read-tool rounds then finishes.
    const dbPath = path.join(dir, "tools.db");
    const saver = NodeSqliteSaver.fromPath(dbPath);
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "read_file", args: { path: "a.txt" } }])
        .respondWithTools([{ name: "read_file", args: { path: "b.txt" } }])
        .respondWithTools([{ name: "read_file", args: { path: "c.txt" } }])
        .respond(new AIMessage("done"));
    const { api } = await createCore({
      workspaceRoot: dir,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      checkpointer: saver,
      chatModelFactory: factory(script),
    });
    cores.push(api);

    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "read three files", approvalMode: "headless" });

    // When the turn completes.
    expect(res.ok && res.value.status).toBe("completed");

    // Then exactly one checkpoint row exists for the thread and none is an
    //   `input`-source row (both only appear under async/default durability).
    const { total, inputRows } = inspect(dbPath, id);
    expect(total).toBe(1);
    expect(inputRows).toBe(0);
    saver.close();
  });

  it("a turn that dispatches a task worker batch persists ONE checkpoint and zero input-source rows", async () => {
    // Given a research agent that dispatches a read-class worker batch, and the
    //   orchestrator + worker scripted off the one active endpoint by content.
    const dbPath = path.join(dir, "task.db");
    const saver = NodeSqliteSaver.fromPath(dbPath);
    const script = () =>
      fakeModel().respond((messages) => {
        const convo = messages
          .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
          .join("\n");
        // The worker's isolated context carries the delegated task text.
        if (convo.includes("WORKER-BRIEF")) return new AIMessage("worker done");
        // The orchestrator's first turn emits the batch `task` call; after the
        // worker summaries return it finishes.
        if (!/worker done/.test(convo) && !convo.includes("task")) {
          return new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "o0",
                name: "task",
                args: {
                  tasks: [
                    { id: "x", worker: "researcher", task: "WORKER-BRIEF survey A" },
                    { id: "y", worker: "researcher", task: "WORKER-BRIEF survey B" },
                  ],
                },
              },
            ],
          });
        }
        return new AIMessage("orchestrator done");
      });
    const { api } = await createCore({
      workspaceRoot: dir,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      checkpointer: saver,
      chatModelFactory: factory(script),
    });
    cores.push(api);
    await api.agents.create({
      name: "research",
      description: "reads and delegates",
      kind: "top-level",
      systemPrompt: "RESEARCH",
      tools: ["read_file", "task"],
      workers: ["researcher"],
      unlisted: "deny",
      order: 20,
    });
    await api.agents.create({
      name: "researcher",
      description: "read-only investigation",
      kind: "worker",
      systemPrompt: "RSRCH",
      tools: ["read_file", "glob_files"],
    });

    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.setMode(id, "research");
    const res = await api.session.send(id, { input: "fan out a batch", approvalMode: "headless" });

    // When the turn (with its whole worker fan-out) completes.
    expect(res.ok && res.value.status).toBe("completed");

    // Then the ORCHESTRATOR thread still has exactly one checkpoint and no
    //   input-source row — the workers' own isolated graphs do not add rows to
    //   the orchestrator's thread.
    const { total, inputRows } = inspect(dbPath, id);
    expect(total).toBe(1);
    expect(inputRows).toBe(0);
    saver.close();
  });
});
