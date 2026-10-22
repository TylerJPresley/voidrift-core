/**
 * The host-only rollback API (core-blueprint.md §10.12).
 *
 * `session.moves/undo/redo/goto` are HOST-ONLY: not model tools (absent from the
 * agent toolset), not on any allow list, and absent from the plugin
 * ScopedCoreApi. Deterministic/offline: a `fakeModel()` core over a temp
 * workspace. The capture→move→restore logic is covered by the store and service
 * tests; this exercises the facade posture, the disabled path, and NOT_FOUND.
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

const baseSeed = {
  models: { test: { model: "test-model", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "test",
};

const tracked: Array<{ session: { shutdown: () => Promise<void> } }> = [];
afterEach(async () => {
  for (const a of tracked.splice(0)) await a.session.shutdown().catch(() => undefined);
});

async function makeCore(seed: Record<string, unknown> = baseSeed) {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "vr-rollback-host-"));
  await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
  const r = await createCore({
    workspaceRoot: ws,
    configStore: new InMemoryConfigStore(seed),
    sessionRepository: new InMemorySessionRepository(),
    checkpointer: createMemoryCheckpointer(),
    chatModelFactory: (_r: ResolvedModel, _e: ModelConfigEntry) => fakeModel(),
  });
  tracked.push(r.api);
  return { api: r.api, ws };
}

describe("§10.12 — session rollback host-only API", () => {
  it("rollback ops are NOT model tools", async () => {
    const { api } = await makeCore();
    const r = await api.agents.tools();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = r.value.map((t) => t.name);
    for (const n of ["undo", "redo", "goto", "moves", "rollback"]) {
      expect(names).not.toContain(n);
    }
  });

  it("moves() reports the method and an empty timeline for a fresh session", async () => {
    const { api } = await makeCore();
    const s = await api.session.create();
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    const report = await api.session.moves(s.value.id);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.enabled).toBe(true);
    // No git repo in the temp workspace → the cache method.
    expect(report.value.method).toBe("cache");
    expect(report.value.moves).toEqual([]);
    expect(report.value.pointer).toBe(0);
  });

  it("snapshotCount 0 disables rollback (moves reports disabled; undo refuses)", async () => {
    const { api } = await makeCore({ ...baseSeed, snapshotCount: 0 });
    const s = await api.session.create();
    if (!s.ok) return;
    const report = await api.session.moves(s.value.id);
    expect(report.ok && report.value.enabled).toBe(false);
    const undo = await api.session.undo(s.value.id);
    expect(undo.ok).toBe(true); // the op returns a structured outcome
    if (undo.ok) {
      expect(undo.value.ok).toBe(false);
      expect(undo.value.message).toContain("rollback is off");
    }
  });

  it("goto an unknown id returns NOT_FOUND naming the valid range", async () => {
    const { api } = await makeCore();
    const s = await api.session.create();
    if (!s.ok) return;
    const g = await api.session.goto(s.value.id, 99);
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.error.code).toBe("NOT_FOUND");
      expect(g.error.message).toContain("valid range");
    }
  });

  it("undo on an empty timeline returns a structured refusal (not a throw)", async () => {
    const { api } = await makeCore();
    const s = await api.session.create();
    if (!s.ok) return;
    const u = await api.session.undo(s.value.id);
    expect(u.ok).toBe(true);
    if (u.ok) {
      expect(u.value.ok).toBe(false);
      expect(u.value.restored).toEqual([]);
    }
  });
});
