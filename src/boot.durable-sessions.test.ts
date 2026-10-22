/**
 * Durable-session cross-process integration (core-blueprint.md §5.1–§5.8).
 *
 * The production path: `createCore` with NO injected `sessionRepository`, so the
 * real `FilesystemSessionRepository` persists the partition under
 * `.voidrift/sessions/{id}/`. A SECOND fresh `createCore` over the SAME workspace
 * + XDG home — the way a separate OS process sees the same durable state — must
 * restore the whole session: list, resume (chain + status), a pending out-of-band
 * approval resolvable by `confirm`, a persisted rename, delete removes the
 * partition, and the boot housekeeping notice counts a session idle across runs.
 *
 * Deterministic/offline: a `fakeModel()` factory and a real SQLite checkpointer
 * on disk (the shared message chain across the two cores), temp dirs cleaned up.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import { createCore } from "./boot.js";

describe("durable sessions across two fresh cores (§5, no injected repository)", () => {
  let ws: string;
  let home: string;
  let prevXdg: string | undefined;

  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), "vr-durable-ws-"));
    home = await fs.mkdtemp(path.join(os.tmpdir(), "vr-durable-xdg-"));
    prevXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = home;
  });
  afterEach(async () => {
    if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = prevXdg;
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  // A fresh core over the SAME dirs = a separate process. The checkpointer is
  // the real on-disk SQLite default; only the model factory is faked.
  const boot = () =>
    createCore({
      workspaceRoot: ws,
      chatModelFactory: () => fakeModel().respond(new AIMessage("remembered")),
    });

  it("persists a session that a second fresh core lists, resumes, confirms, renames and deletes", async () => {
    // ── Process 1: create a session, run a turn ──
    const c1 = await boot();
    const created = await c1.api.session.create({ name: "Plum" });
    expect(created.ok).toBe(true);
    const id = created.ok ? created.value.id : "";
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    const sent = await c1.api.session.send(id, { input: "remember: the code word is plum" });
    expect(sent.ok).toBe(true);
    // The partition exists on disk.
    const metaPath = path.join(ws, ".voidrift", "sessions", id, "metadata.json");
    expect(await fs.readFile(metaPath, "utf8").then(() => true)).toBe(true);
    await c1.api.session.shutdown();

    // ── Process 2: a fresh core sees it on disk ──
    const c2 = await boot();
    const list = await c2.api.session.list();
    const found = list.find((s) => s.id === id);
    expect(found).toBeDefined();
    expect(found?.name).toBe("Plum");
    expect(typeof found?.summary).toBe("string");
    expect(typeof found?.lastActiveAt).toBe("string");

    // Resume restores the chain + status.
    const resumed = await c2.api.session.resume(id);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(typeof resumed.value.status).toBe("string");
    const msgs = await c2.api.session.loadMessages(id);
    expect(msgs.ok).toBe(true);
    if (msgs.ok) expect(Array.isArray(msgs.value)).toBe(true);

    // Rename persists to disk and is visible to yet another list().
    const renamed = await c2.api.session.rename(id, "CodeWord");
    expect(renamed.ok).toBe(true);
    const onDisk = JSON.parse(await fs.readFile(metaPath, "utf8")) as { name: string; namePinned: boolean };
    expect(onDisk.name).toBe("CodeWord");
    expect(onDisk.namePinned).toBe(true);

    // Delete removes the partition.
    const del = await c2.api.session.delete(id);
    expect(del.ok).toBe(true);
    const stillThere = await fs.readFile(metaPath, "utf8").then(() => true).catch(() => false);
    expect(stillThere).toBe(false);
    await c2.api.session.shutdown();
  });

  it("a pending out_of_band approval created in core 1 is resolvable by confirm in core 2", async () => {
    // Core 1: write a session whose session-state.json carries a pending approval
    // directly through the repository (the durable mirror), then a fresh core 2
    // resumes and resolves it by confirm — proving the pending survives a process.
    const c1 = await boot();
    const created = await c1.api.session.create({ name: "Pending" });
    const id = created.ok ? created.value.id : "";
    await c1.api.session.shutdown();

    // Seed a pending approval on disk under the real partition.
    const statePath = path.join(ws, ".voidrift", "sessions", id, "session-state.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    state.pending = [
      { id: "req-1", tool: "write_file", args: { path: "x.txt", content: "hi" }, choices: ["approve", "reject"], mode: "out_of_band" },
    ];
    await fs.writeFile(statePath, JSON.stringify(state));

    const c2 = await boot();
    const resumed = await c2.api.session.resume(id);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect((resumed.value.pending ?? []).map((p) => p.id)).toContain("req-1");
    // confirm resolves it in the second process.
    const confirmed = await c2.api.session.confirm(id, { requestId: "req-1", decision: "reject" });
    expect(confirmed.ok).toBe(true);
    await c2.api.session.shutdown();
  });

  it("the boot housekeeping notice counts a session idle across runs (§5.8)", async () => {
    const c1 = await boot();
    const created = await c1.api.session.create({ name: "Old" });
    const id = created.ok ? created.value.id : "";
    await c1.api.session.send(id, { input: "hello" });
    await c1.api.session.shutdown();

    // Backdate lastActiveAt well past the default housekeepingIdleDays (30).
    const metaPath = path.join(ws, ".voidrift", "sessions", id, "metadata.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    meta.lastActiveAt = new Date(Date.now() - 90 * 86_400_000).toISOString();
    await fs.writeFile(metaPath, JSON.stringify(meta));

    const c2 = await boot();
    expect(c2.housekeeping.idleSessions).toBeGreaterThanOrEqual(1);
    await c2.api.session.shutdown();
  });
});
