/**
 * Session export — the host-only facade operation (core-blueprint.md §10.13).
 *
 * `session.export` is a HOST/USER operation: NOT a model tool (absent from the
 * agent toolset), NOT on any allow list, and absent from the plugin
 * ScopedCoreApi — the same posture as rollback (§10.12) and the journal read
 * API (§10.11). READ-ONLY: it records no mutation-journal entry and no rollback
 * move. Deterministic/offline: a `fakeModel()` core over a temp workspace.
 */
import { describe, it, expect, afterEach } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createCore } from "./boot.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { createMemoryCheckpointer } from "./adapters/checkpointer.js";
import type { ResolvedModel } from "./entities/ports/model-port.js";
import type { ModelConfigEntry } from "./config/schema.js";

const seed = {
  models: { test: { model: "test-model", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "test",
};

const tracked: Array<{ session: { shutdown: () => Promise<void> } }> = [];
afterEach(async () => {
  for (const a of tracked.splice(0)) await a.session.shutdown().catch(() => undefined);
});

async function makeCore() {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "vr-export-host-"));
  await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
  const r = await createCore({
    workspaceRoot: ws,
    configStore: new InMemoryConfigStore(seed),
    sessionRepository: new InMemorySessionRepository(),
    checkpointer: createMemoryCheckpointer(),
    chatModelFactory: (_r: ResolvedModel, _e: ModelConfigEntry) =>
      fakeModel(),
  });
  tracked.push(r.api);
  return { api: r.api, ws };
}

/** Run one completed turn so the session has a stored chain + metadata. */
async function seedSession(api: Awaited<ReturnType<typeof makeCore>>["api"], input: string): Promise<string> {
  const created = await api.session.create();
  if (!created.ok) throw new Error("create failed");
  const sent = await api.session.send(created.value.id, { input });
  if (!sent.ok) throw new Error("send failed: " + sent.error.message);
  return created.value.id;
}

describe("§10.13 — session.export host-only operation", () => {
  it("export is NOT a model tool (absent from the agent toolset)", async () => {
    const { api } = await makeCore();
    const r = await api.agents.tools();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = r.value.map((t) => t.name);
    for (const n of ["export", "session.export", "session_export"]) {
      expect(names).not.toContain(n);
    }
  });

  it("exports a stored session to JSON and Markdown from one sanitized value", async () => {
    const { api } = await makeCore();
    const id = await seedSession(api, `read ${os.homedir()}/.ssh/id with token ghp_01` + `23456789abcdefghijklmnopqrstuvwxyz`);

    const json = await api.session.export(id, { format: "json" });
    expect(json.ok).toBe(true);
    if (!json.ok) return;
    expect(json.value.content).toBeDefined();
    // The home path is rewritten; the secret is masked.
    expect(json.value.content).not.toContain("ghp_01" + "23456789abcdefghijklmnopqrstuvwxyz");
    expect(json.value.content).toContain("~/.ssh/id");
    expect(json.value.masking.pathsRewritten).toBeGreaterThanOrEqual(1);

    const md = await api.session.export(id, { format: "md" });
    expect(md.ok).toBe(true);
    if (!md.ok) return;
    // Both renderings mask the secret (same sanitized value).
    expect(md.value.content).not.toContain("ghp_01" + "23456789abcdefghijklmnopqrstuvwxyz");
  });

  it("'last' resolves to the most recent session for this workspace", async () => {
    const { api } = await makeCore();
    await seedSession(api, "first");
    const id2 = await seedSession(api, "second and most recent");
    const r = await api.session.export("last", { format: "json" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.content).toContain(id2);
  });

  it("an unknown session is SESSION_NOT_FOUND; a bad format is INVALID_INPUT", async () => {
    const { api } = await makeCore();
    const nf = await api.session.export("ffffffff");
    expect(nf.ok).toBe(false);
    if (!nf.ok) expect(nf.error.code).toBe("SESSION_NOT_FOUND");
    const id = await seedSession(api, "hello");
    const bad = await api.session.export(id, { format: "xml" as "md" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("INVALID_INPUT");
  });

  it("writes an owner-only 0600 file and refuses an existing target", async () => {
    const { api, ws } = await makeCore();
    const id = await seedSession(api, "hello world");
    const out = path.join(ws, "export.json");
    const w = await api.session.export(id, { format: "json", out });
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.value.path).toBe(out);
    const st = await fs.stat(out);
    expect(st.mode & 0o777).toBe(0o600);
    // A second export to the same path refuses.
    const again = await api.session.export(id, { format: "json", out });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("EXPORT_TARGET_EXISTS");
  });

  it("refuses a protected control path (EXPORT_TARGET_PROTECTED), writing no file", async () => {
    const { api, ws } = await makeCore();
    const id = await seedSession(api, "hello");
    const out = path.join(ws, ".voidrift", "config.json");
    const r = await api.session.export(id, { format: "json", out });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("EXPORT_TARGET_PROTECTED");
  });

  it("refuses a symlinked target (EXPORT_TARGET_EXISTS — lstat catches the link)", async () => {
    const { api, ws } = await makeCore();
    const id = await seedSession(api, "hello");
    const real = path.join(ws, "real.json");
    await fs.writeFile(real, "{}");
    const link = path.join(ws, "link.json");
    await fs.symlink(real, link);
    const r = await api.session.export(id, { format: "json", out: link });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("EXPORT_TARGET_EXISTS");
  });

  it("atomic no-overwrite: a target created before publish is not overwritten (EXPORT_TARGET_EXISTS, finding 4)", async () => {
    const { api, ws } = await makeCore();
    const id = await seedSession(api, "hello world");
    const out = path.join(ws, "pre-existing.json");
    // A file that exists at publish time (standing in for one created in the
    // old lstat→rename window) must be refused and left byte-for-byte intact.
    await fs.writeFile(out, "ORIGINAL", { mode: 0o600 });
    const r = await api.session.export(id, { format: "json", out });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("EXPORT_TARGET_EXISTS");
    expect(await fs.readFile(out, "utf8")).toBe("ORIGINAL");
    // No stray temp files left behind in the directory.
    const entries = await fs.readdir(ws);
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  it("export records no mutation-journal entry and no rollback move (read-only)", async () => {
    const { api } = await makeCore();
    const id = await seedSession(api, "hello");
    const before = await api.session.moves(id);
    const beforeCount = before.ok && before.value.moves ? before.value.moves.length : 0;
    await api.session.export(id, { format: "json" });
    const after = await api.session.moves(id);
    const afterCount = after.ok && after.value.moves ? after.value.moves.length : 0;
    expect(afterCount).toBe(beforeCount);
    // No journal entry either (default fs store has none for this session).
    const entries = await api.session.journal.list(id);
    expect(entries.every((e) => e.tool !== "session.export")).toBe(true);
  });
});
