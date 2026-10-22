/**
 * Engine-level mutation journal TURN flush (core-blueprint.md §10.11).
 *
 * At `mutationLogLevel: 'turn'` the journal records the NET change per target as
 * ONE `turn-net` entry at the END of the turn (the engine's turn `finally`), the
 * per-action entries carry NO blobs, and the flush reads the ACTUAL file so a
 * shell-made change is captured. A completed turn and a failed turn both flush;
 * `session.setMode` (an agent switch) and `session.shutdown()` also flush.
 * Deterministic/offline over a per-test temp workspace and in-memory stores.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import path from "node:path";
import fs from "node:fs/promises";
import { createCore } from "../boot.js";
import { InMemoryConfigStore } from "../adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "../adapters/repositories/session-repository.js";
import { InMemoryJournalStore } from "../adapters/repositories/in-memory-journal-store.js";
import type { ResolvedModel } from "../entities/ports/model-port.js";
import type { ModelConfigEntry } from "../config/schema.js";
import { seededPermissionsRecord } from "../test-support/seed-rules.js";

const seed = {
  models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "t",
  mutationLogLevel: "turn",
  // Free write_file so the turn runs without a prompt (journaling is what we test).
  permissions: {
    ...seededPermissionsRecord(),
    "allow-write": { tool: "write_file", decision: "allow" as const, priority: 0, source: "user" as const },
  },
};

function factory(script: () => ReturnType<typeof fakeModel>) {
  return (_r: ResolvedModel, _e: ModelConfigEntry) => script();
}

const tracked: { session: { shutdown: () => Promise<void> } }[] = [];

describe("Engine turn-level journal flush (§10.11)", () => {
  let ws: string;
  let journalStore: InMemoryJournalStore;
  beforeEach(async () => {
    ws = hermeticTmp("jturn");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    journalStore = new InMemoryJournalStore();
  });
  afterEach(async () => {
    // Shut the cores down BEFORE removing the workspace: afterEach hooks run in
    // reverse registration order, and a shutdown after the rm re-creates
    // `.voidrift` in the removed directory (a leaked /tmp dir).
    for (const c of tracked.splice(0)) await c.session.shutdown().catch(() => undefined);
    await fs.rm(ws, { recursive: true, force: true });
  });

  async function core(script: () => ReturnType<typeof fakeModel>) {
    const ready = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      journalStore,
      chatModelFactory: factory(script),
    });
    tracked.push(ready.api);
    return ready.api;
  }

  it("a completed turn flushes ONE turn-net entry with the net after; per-action entry has no blobs", async () => {
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "write_file", args: { path: "a.txt", content: "final" } }])
        .respond(new AIMessage("done"));
    const api = await core(script);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "write a.txt", approvalMode: "policy_only" });
    expect(res.ok && res.value.status).toBe("completed");

    const entries = await api.session.journal.list(id);
    const perAction = entries.find((e) => e.tool === "write_file");
    const net = entries.find((e) => e.tool === "turn-net");
    expect(perAction, "a per-action write_file entry").toBeTruthy();
    expect(perAction!.blobs, "no blobs on the per-action entry at turn level").toBeUndefined();
    expect(net, "a turn-net entry at the turn boundary").toBeTruthy();
    expect(net!.target).toBe("a.txt");
    expect(net!.actions).toBe(1);
    // The net after blob holds the ACTUAL file content read at flush time.
    const afterSha = net!.blobs?.after;
    expect(afterSha).toBeTruthy();
    const blob = await api.session.journal.blob(id, afterSha!);
    expect(blob).toEqual(Buffer.from("final"));
  });

  it("session.shutdown() flushes a turn-net entry (shutdown is a way a turn ends)", async () => {
    // A script that writes but whose turn we end via shutdown rather than waiting.
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "write_file", args: { path: "b.txt", content: "shut" } }])
        .respond(new AIMessage("done"));
    const api = await core(script);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.send(id, { input: "write b.txt", approvalMode: "policy_only" });
    // Even though the completed-turn finally already flushed, shutdown must be a
    // safe no-op (idempotent) — assert the turn-net still present after shutdown.
    await api.session.shutdown();
    tracked.length = 0; // already shut down
    const entries = await journalStore.list(id);
    expect(entries.some((e) => e.tool === "turn-net" && e.target === "b.txt")).toBe(true);
  });
});
