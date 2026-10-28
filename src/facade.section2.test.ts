/**
 * §2 acceptance integration test (core-blueprint.md §2.6, §15.2).
 *
 * Two sessions in one process each run a tool-using turn to `completed` with NO
 * cross-talk; one is driven to `waiting_for_approval` under `out_of_band` and
 * resolved via `confirm`; the other is resumed by id in a FRESH CoreAPI with
 * restored chain, pending approvals, and stale-document marks.
 *
 * Deterministic and offline: `fakeModel()` drives the engine, a shared SQLite
 * checkpointer file plays the durable chain across two CoreAPI instances, a
 * shared in-memory session repository plays the durable state mirror, and a
 * per-test temp workspace backs the deepagents filesystem tools.
 */
import { hermeticTmp } from "./test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import { NodeSqliteSaver } from "./adapters/node-sqlite-saver.js";
import path from "node:path";
import fs from "node:fs/promises";
import { createCore } from "./boot.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { seededPermissionsRecord } from "./test-support/seed-rules.js";
import type { ResolvedModel } from "./entities/ports/model-port.js";
import type { ModelConfigEntry } from "./config/schema.js";

const seed = {
  models: { test: { model: "test-model", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "test",
  permissions: seededPermissionsRecord(),
};

function fakeFactory(script: () => ReturnType<typeof fakeModel>) {
  return (_r: ResolvedModel, _e: ModelConfigEntry) => script();
}

describe("§2 — CoreAPI facade, multi-session isolation, out_of_band confirm, resume", () => {
  let ws: string;
  let dbPath: string;
  const tracked: Array<{ api: { session: { shutdown: () => Promise<void> } } }> = [];
  function track<T extends { api: { session: { shutdown: () => Promise<void> } } }>(r: T): T {
    tracked.push(r);
    return r;
  }

  beforeEach(async () => {
    ws = hermeticTmp("s2");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    dbPath = path.join(ws, ".voidrift", "checkpoint.db");
    await fs.writeFile(path.join(ws, "a.txt"), "hello from A");
  });

  afterEach(async () => {
    // Shut every created core down first so the §14.3 obs-write drain runs; a
    // late observability write otherwise re-creates the deleted workspace.
    for (const c of tracked.splice(0)) await c.api.session.shutdown().catch(() => undefined);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("runs two isolated tool-using turns, pauses one out_of_band, resumes the other in a fresh CoreAPI", async () => {
    // Given a shared durable mirror and a shared checkpointer db file.
    const sessions = new InMemorySessionRepository();

    // Session A reads a file (a free read) then completes.
    const scriptA = () =>
      fakeModel()
        .respondWithTools([{ name: "read_file", args: { path: "a.txt" } }])
        .respond(new AIMessage("A done"));

    const saverA = NodeSqliteSaver.fromPath(dbPath);
    const { api: apiA } = track(
      await createCore({
        workspaceRoot: ws,
        configStore: new InMemoryConfigStore(seed),
        sessionRepository: sessions,
        chatModelFactory: fakeFactory(scriptA),
        checkpointer: saverA,
      }),
    );

    const createdA = await apiA.session.create({ name: "A" });
    expect(createdA.ok).toBe(true);
    const idA = createdA.ok ? createdA.value.id : "";

    const resA = await apiA.session.send(idA, { input: "read a.txt" });
    expect(resA.ok).toBe(true);
    if (resA.ok) {
      // Then session A completes with no cross-talk.
      expect(resA.value.status).toBe("completed");
      expect(resA.value.text).toBe("A done");
      expect(resA.value.toolsUsed).toContain("read_file");
    }

    // Session B writes a file under out_of_band: the gated write pauses.
    const scriptB = () =>
      fakeModel()
        .respondWithTools([{ name: "write_file", args: { path: "b.txt", content: "from B" } }])
        .respond(new AIMessage("B done"));

    const { api: apiB } = track(
      await createCore({
        workspaceRoot: ws,
        configStore: new InMemoryConfigStore(seed),
        sessionRepository: sessions,
        chatModelFactory: fakeFactory(scriptB),
        checkpointer: saverA,
      }),
    );

    const createdB = await apiB.session.create({ name: "B" });
    const idB = createdB.ok ? createdB.value.id : "";
    expect(idB).not.toBe(idA);

    const resB = await apiB.session.send(idB, { input: "write b.txt", approvalMode: "out_of_band" });
    expect(resB.ok).toBe(true);
    if (resB.ok) {
      // Then B pauses waiting for approval, carrying the full action.
      expect(resB.value.status).toBe("waiting_for_approval");
      expect(resB.value.pending?.[0]?.tool).toBe("write_file");
      expect(resB.value.pending?.[0]?.args).toMatchObject({ path: "b.txt", content: "from B" });
    }

    // When B's pending approval is resolved via confirm.
    const requestId = resB.ok ? resB.value.pending![0]!.id : "";
    const confirmed = await apiB.session.confirm(idB, { requestId, decision: "approve" });
    expect(confirmed.ok).toBe(true);
    if (confirmed.ok) {
      // Then the write runs and the turn completes.
      expect(confirmed.value.status).toBe("completed");
      expect(confirmed.value.text).toBe("B done");
    }
    // The write landed in the workspace (no cross-talk into A's state).
    expect(await fs.readFile(path.join(ws, "b.txt"), "utf8")).toBe("from B");

    saverA.close();

    // Simulate a document going stale for A, mirrored to the durable store.
    const persistedA = await sessions.load(idA);
    expect(persistedA).not.toBeNull();
    persistedA!.documents = [{ path: "a.txt", hash: "old", stale: true, turnAdded: 1, trust: "live", lines: 1 }];
    await sessions.save(persistedA!);

    // And when session A is resumed by id in a FRESH CoreAPI (fresh process) over
    // the same mirror and the same on-disk checkpoint db.
    const saverFresh = NodeSqliteSaver.fromPath(dbPath);
    const { api: apiFresh } = track(
      await createCore({
        workspaceRoot: ws,
        configStore: new InMemoryConfigStore(seed),
        sessionRepository: sessions,
        chatModelFactory: fakeFactory(scriptA),
        checkpointer: saverFresh,
      }),
    );

    const resumedA = await apiFresh.session.resume(idA);
    expect(resumedA.ok).toBe(true);
    if (resumedA.ok) {
      // Then the fresh CoreAPI restores the session's status, identity, pending
      // approvals (none for A), and the stale-document mark.
      expect(resumedA.value.info.id).toBe(idA);
      expect(resumedA.value.status).toBe("completed");
      expect(resumedA.value.pending).toEqual([]);
      expect(resumedA.value.staleDocuments).toContain("a.txt");
    }

    const resumedB = await apiFresh.session.resume(idB);
    expect(resumedB.ok).toBe(true);
    if (resumedB.ok) expect(resumedB.value.info.id).toBe(idB);

    const list = await apiFresh.session.list();
    const ids = list.map((s) => s.id);
    expect(ids).toContain(idA);
    expect(ids).toContain(idB);

    saverFresh.close();
  });
});
