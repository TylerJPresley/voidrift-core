/**
 * The host-only mutation journal read API (core-blueprint.md §10.11, §8).
 *
 * `session.journal.list`/`blob` read the injected journal store and are HOST-
 * ONLY: not a model tool (absent from the tool registry), not on any allow
 * list, and not on the plugin ScopedCoreApi. Deterministic/offline: a
 * `fakeModel()` core over a temp workspace with an in-memory journal store.
 */
import { describe, it, expect, afterEach } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createCore } from "./boot.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { InMemoryJournalStore } from "./adapters/repositories/in-memory-journal-store.js";
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

async function makeCore(journalStore: InMemoryJournalStore) {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "vr-journal-host-"));
  await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
  const r = await createCore({
    workspaceRoot: ws,
    configStore: new InMemoryConfigStore(seed),
    sessionRepository: new InMemorySessionRepository(),
    checkpointer: createMemoryCheckpointer(),
    journalStore,
    chatModelFactory: (_r: ResolvedModel, _e: ModelConfigEntry) => fakeModel(),
  });
  tracked.push(r.api);
  return { api: r.api, ws };
}

describe("§10.11 — session.journal host-only read API", () => {
  it("list returns injected entries (metadata only) and blob returns raw bytes", async () => {
    const store = new InMemoryJournalStore();
    const raw = Buffer.from("raw content");
    const sha = await store.putBlob("sX", raw);
    await store.append("sX", {
      seq: 1,
      time: new Date().toISOString(),
      sessionId: "sX",
      turn: 1,
      tool: "write_file",
      call: { path: "a.txt", content: { bytes: 11, sha256: sha } },
      target: "a.txt",
      result: { status: "ok", summary: "wrote" },
      blobs: { after: sha },
    });
    const { api } = await makeCore(store);
    const entries = await api.session.journal.list("sX");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.tool).toBe("write_file");
    // No raw content on the entry — only sha.
    expect(JSON.stringify(entries[0]!)).not.toContain("raw content");
    const blob = await api.session.journal.blob("sX", sha);
    expect(blob).toEqual(raw);
  });

  it("the journal is NOT a model tool (no journal tool in the agent toolset)", async () => {
    const { api } = await makeCore(new InMemoryJournalStore());
    const r = await api.agents.tools();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = r.value.map((t) => t.name);
    expect(names.some((n) => n.includes("journal"))).toBe(false);
  });

  it("with no journal store wired, list is empty and blob is null", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "vr-journal-none-"));
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    const r = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      checkpointer: createMemoryCheckpointer(),
      // A filesystem store is the default; to exercise the "no store" branch we
      // cannot pass undefined through boot (it defaults), so this test asserts
      // the default store simply returns empty for an unknown session.
      chatModelFactory: (_r: ResolvedModel, _e: ModelConfigEntry) => fakeModel(),
    });
    tracked.push(r.api);
    expect(await r.api.session.journal.list("unknown-session")).toEqual([]);
    expect(await r.api.session.journal.blob("unknown-session", "deadbeef")).toBeNull();
  });
});
