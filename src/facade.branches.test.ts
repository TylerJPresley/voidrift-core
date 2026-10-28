import { hermeticTmp } from "./test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import { NodeSqliteSaver } from "./adapters/node-sqlite-saver.js";
import path from "node:path";
import fs from "node:fs/promises";
import { createCore } from "./boot.js";
import { createMemoryCheckpointer } from "./adapters/checkpointer.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";

const seed = { models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } }, modelSelected: "t" };

describe("CoreAPI facade — additional branches (§2, §5)", () => {
  let ws: string;
  // Shut every created core down before deleting the workspace so the product's
  // §14.3 obs-write drain runs; otherwise a late observability write re-creates
  // the just-deleted workspace (the /tmp leak + ENOTEMPTY flake).
  const tracked: Array<{ api: { session: { shutdown: () => Promise<void> } } }> = [];
  function track<T extends { api: { session: { shutdown: () => Promise<void> } } }>(r: T): T {
    tracked.push(r);
    return r;
  }
  beforeEach(async () => {
    ws = hermeticTmp("fac2");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
  });
  afterEach(async () => {
    for (const c of tracked.splice(0)) await c.api.session.shutdown().catch(() => undefined);
    await fs.rm(ws, { recursive: true, force: true });
  });

  async function core(sessions = new InMemorySessionRepository()) {
    return track(
      await createCore({
        workspaceRoot: ws,
        configStore: new InMemoryConfigStore(seed),
        sessionRepository: sessions,
        checkpointer: createMemoryCheckpointer(),
        chatModelFactory: () => fakeModel().respond(new AIMessage("hi")),
      }),
    );
  }

  it("cancel emits TURN_CANCELLED for a live session and is safe for an unknown one", async () => {
    const { api } = await core();
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    let cancelled = false;
    api.events.subscribe("TURN_CANCELLED", () => (cancelled = true));
    expect((await api.session.cancel(id)).ok).toBe(true);
    expect(cancelled).toBe(true);
    expect((await api.session.cancel("unknownxx")).ok).toBe(true);
  });

  it("send honors a per-request configOverride and runs a plain completion", async () => {
    const { api } = await core();
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "hello", configOverrides: { turnMaxConcurrency: 2 } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.status).toBe("completed");
  });

  it("rejects a second concurrent turn on the same session (TURN_ACTIVE)", async () => {
    const { api } = await core();
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const first = api.session.send(id, { input: "a" });
    const second = api.session.send(id, { input: "b" });
    const [r1, r2] = await Promise.all([first, second]);
    const oneActive = (!r1.ok && r1.error.code === "TURN_ACTIVE") || (!r2.ok && r2.error.code === "TURN_ACTIVE");
    expect(oneActive).toBe(true);
  });

  it("resume surfaces restored pending approvals and stale documents from the mirror", async () => {
    const sessions = new InMemorySessionRepository();
    const { api } = await core(sessions);
    const created = await api.session.create({ name: "r" });
    const id = created.ok ? created.value.id : "";
    const persisted = await sessions.load(id);
    persisted!.lastStatus = "waiting_for_approval";
    persisted!.pending = [{ id: "p1", tool: "write_file", args: { file_path: "x" }, choices: ["approve", "edit", "reject"], mode: "out_of_band" }];
    persisted!.documents = [{ path: "x.txt", hash: "h", stale: true, turnAdded: 1, trust: "live", lines: 1 }];
    await sessions.save(persisted!);

    const resumed = await api.session.resume(id);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      expect(resumed.value.status).toBe("waiting_for_approval");
      expect(resumed.value.pending?.[0]?.id).toBe("p1");
      expect(resumed.value.staleDocuments).toEqual(["x.txt"]);
    }
  });

  it("loadMessages/compact/moves seams respond without throwing", async () => {
    const { api } = await core();
    expect((await api.session.loadMessages()).ok).toBe(true);
    expect((await api.session.compact()).ok).toBe(false);
    // §10.12 — rollback replaces rewind; `moves` reports the (disabled) timeline.
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    expect((await api.session.moves(id)).ok).toBe(true);
  });

  it("delete reclaims a session and reports no remaining branches", async () => {
    const { api } = await core();
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const del = await api.session.delete(id);
    expect(del.ok).toBe(true);
    if (del.ok) expect(del.value.remainingBranches).toEqual([]);
  });

  it("constructs with a SQLite checkpointer injected", async () => {
    const dbPath = path.join(ws, ".voidrift", "cp.db");
    const saver = NodeSqliteSaver.fromPath(dbPath);
    const { api } = track(
      await createCore({
        workspaceRoot: ws,
        configStore: new InMemoryConfigStore(seed),
        sessionRepository: new InMemorySessionRepository(),
        chatModelFactory: () => fakeModel().respond(new AIMessage("hi")),
        checkpointer: saver,
      }),
    );
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "hi" });
    expect(res.ok).toBe(true);
    saver.close();
  });

  it("auto-names a session after the first turn and a rename pins it", async () => {
    const { api } = await core();
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.send(id, { input: "First line goal\nsecond line" });
    const list = await api.session.list();
    const info = list.find((s) => s.id === id);
    expect(info?.name).toBe("First line goal");
    // A later rename pins; a further turn does not overwrite it.
    await api.session.rename(id, "Pinned");
    await api.session.send(id, { input: "another goal entirely" });
    const list2 = await api.session.list();
    expect(list2.find((s) => s.id === id)?.name).toBe("Pinned");
  });

  it("clear forks a fresh session preserving the prior one on disk", async () => {
    const { api } = await core();
    const created = await api.session.create({ name: "orig" });
    const id = created.ok ? created.value.id : "";
    const cleared = await api.session.clear(id);
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.value.id).not.toBe(id);
    const list = await api.session.list();
    expect(list.find((s) => s.id === id)).toBeDefined(); // prior stays resumable
  });

  it("permissions.resolve routes to confirm and register.guardrail is a seam", async () => {
    const { api } = await core();
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    // No pending → resolve fails like confirm.
    const r = await api.permissions.resolve(id, { requestId: "x", decision: "approve" });
    expect(r.ok).toBe(false);
    // register.guardrail accepts a guardrail without throwing.
    expect(() => api.register.guardrail({ name: "g", check: () => ({ allowed: true }) })).not.toThrow();
  });

  it("workspace branch/files/diff seams and permissions.approvals by session", async () => {
    const { api } = await core();
    expect((await api.workspace.branch()).ok).toBe(true);
    expect((await api.workspace.files()).ok).toBe(true);
    expect((await api.workspace.diff()).ok).toBe(true);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const appr = await api.permissions.approvals(id);
    expect(appr.ok).toBe(true);
    if (appr.ok) expect(appr.value).toEqual([]);
  });

  it("auto-name falls back to 'untitled' when the first line is blank", async () => {
    const { api } = await core();
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.send(id, { input: "   \nreal content" });
    const list = await api.session.list();
    expect(list.find((s) => s.id === id)?.name).toBe("untitled");
  });

  it("resume of a live session restores from the mirror and marks read documents", async () => {
    const sessions = new InMemorySessionRepository();
    const { api } = await core(sessions);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const persisted = await sessions.load(id);
    persisted!.documents = [{ path: "fresh.txt", hash: "h", stale: false, turnAdded: 1, trust: "live", lines: 1 }];
    await sessions.save(persisted!);
    const resumed = await api.session.resume(id);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(resumed.value.staleDocuments).toEqual([]);
  });
});
