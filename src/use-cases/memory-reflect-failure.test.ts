/**
 * Memory.reflectFailure (core-blueprint.md §6.7, §10.6) — a repeated FAILURE
 * shape becomes ONE pending human-approved memory-note suggestion ('what failed
 * and what to do instead'), deduped against memory and pending suggestions,
 * carrying the failure SIGNATURE so the same signature never re-surfaces
 * (pending/approved/rejected suppression), with the body masked. Deterministic,
 * offline, in-memory store.
 */
import { describe, it, expect } from "vitest";
import { Memory, type MemoryDeps } from "./memory.js";
import { InMemoryMemoryStore } from "../adapters/repositories/in-memory-memory-store.js";
import { SuggestionsDirectory } from "../adapters/suggestions-directory.js";
import { InMemoryFileSystem } from "../adapters/in-memory-filesystem.js";
import { EventBus } from "../entities/event-bus.js";
import { InMemorySessionRepository } from "../adapters/repositories/session-repository.js";

function harness(draft: MemoryDeps["draftMemoryNoteFromFailure"]) {
  const bus = new EventBus();
  const store = new InMemoryMemoryStore();
  const suggestions = new SuggestionsDirectory(new InMemoryFileSystem(), ".voidrift/suggestions");
  const deps: MemoryDeps = {
    store,
    bus,
    sessions: new InMemorySessionRepository(),
    suggestions,
    getBounds: () => ({ entryChars: 2200, reflectionBatchSize: 3 }),
    discoverProjectFiles: async () => [],
    readSessionTurns: async () => [],
    ...(draft ? { draftMemoryNoteFromFailure: draft } : {}),
  };
  return { memory: new Memory(deps), suggestions };
}

const signal = {
  signature: "tool_error:edit_file",
  kind: "tool_error" as const,
  tool: "Edit file",
  errorClass: "ENOENT",
  count: 3,
  sessionIds: ["s0", "s1"],
  argExamples: ["{\"path\":\"«redacted»\"}"],
};

describe("§6.7/§10.6 — Memory.reflectFailure", () => {
  it("drafts ONE pending memory-note carrying the failure signature", async () => {
    const { memory } = harness(async () => ({ title: "Read Before Edit", body: "edit_file failed ENOENT; read the file first." }));
    const out = await memory.reflectFailure(signal, () => "2026-01-01T00:00:00.000Z");
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("memory-note");
    const pending = await memory.listSuggestions();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.title).toBe("Read Before Edit");
  });

  it("the drafted body is masked (§10.10)", async () => {
    const { memory } = harness(async () => ({ title: "T", body: "use key sk-ABC" + "DEF0123456789 to retry" }));
    const out = await memory.reflectFailure(signal, () => "t");
    expect(out!.body).not.toContain("sk-ABC" + "DEF0123456789");
  });

  it("a declined draft (null) writes nothing", async () => {
    const { memory } = harness(async () => null);
    expect(await memory.reflectFailure(signal)).toBeNull();
    expect(await memory.listSuggestions()).toHaveLength(0);
  });

  it("no draft seam → null, nothing written", async () => {
    const { memory } = harness(undefined);
    expect(await memory.reflectFailure(signal)).toBeNull();
  });

  it("the same signature is not re-drafted while a suggestion is pending (§10.6 Lifecycle)", async () => {
    let calls = 0;
    const { memory } = harness(async () => {
      calls += 1;
      return { title: `N${calls}`, body: `body ${calls}` };
    });
    await memory.reflectFailure(signal, () => "a");
    const again = await memory.reflectFailure(signal, () => "b");
    expect(again).toBeNull(); // suppressed by the pending suggestion's signature
    expect(calls).toBe(1);
    expect(await memory.listSuggestions()).toHaveLength(1);
  });

  it("a rejected signature is never re-drafted (§10.6 Lifecycle)", async () => {
    const { memory } = harness(async () => ({ title: "N", body: "b" }));
    const first = await memory.reflectFailure(signal, () => "a");
    await memory.rejectSuggestion(first!.id);
    const again = await memory.reflectFailure(signal, () => "b");
    expect(again).toBeNull();
  });
});
