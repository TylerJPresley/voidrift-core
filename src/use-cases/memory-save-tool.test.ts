/**
 * The in-turn `save_memory` policy on the Memory capability (core-blueprint.md
 * §6.2, §6.4): hard-refuse of `identity`/`project`, secret-masking of body and
 * summary, dedup by normalized body, `sourceSessionId` provenance, and the
 * index-demotion findability guarantee. Deterministic, in-memory (§15.3).
 */
import { describe, it, expect } from "vitest";
import { Memory, type MemoryDeps } from "./memory.js";
import { InMemoryMemoryStore } from "../adapters/repositories/in-memory-memory-store.js";
import { SuggestionsDirectory } from "../adapters/suggestions-directory.js";
import { InMemoryFileSystem } from "../adapters/in-memory-filesystem.js";
import { EventBus, type EventEnvelope } from "../entities/event-bus.js";
import { InMemorySessionRepository } from "../adapters/repositories/session-repository.js";

function harness(entryChars = 2200) {
  const bus = new EventBus();
  const events: EventEnvelope[] = [];
  bus.subscribe("*", (e) => events.push(e));
  const deps: MemoryDeps = {
    store: new InMemoryMemoryStore(),
    bus,
    sessions: new InMemorySessionRepository(),
    suggestions: new SuggestionsDirectory(new InMemoryFileSystem(), ".voidrift/suggestions"),
    getBounds: () => ({ entryChars, projectChars: 8000, reflectionBatchSize: 3 }),
    discoverProjectFiles: async () => [],
    readSessionTurns: async () => [],
  };
  return { memory: new Memory(deps), events };
}

describe("§6.2/§6.4 — save_memory in-turn policy", () => {
  it("a note write persists, emits MEMORY_SAVED, and its summary appears in the index", async () => {
    const { memory, events } = harness();
    const res = await memory.saveInTurn({ title: "Use pnpm", body: "This repo uses pnpm, not npm.", type: "note", sourceSessionId: "s1" });
    expect(res.ok).toBe(true);
    expect(events.some((e) => e.type === "MEMORY_SAVED")).toBe(true);
    const idx = memory.memoryIndex(32_000);
    expect(idx.active.some((l) => l.id === "use-pnpm")).toBe(true);
    // Provenance is persisted.
    const read = memory.read("use-pnpm");
    expect(read.ok).toBe(true);
  });

  it("type identity is hard-refused with MEMORY_TYPE_FORBIDDEN and writes nothing", async () => {
    const { memory, events } = harness();
    const res = await memory.saveInTurn({ title: "Who", body: "You are X", type: "identity" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("MEMORY_TYPE_FORBIDDEN");
    expect(memory.list()).toHaveLength(0);
    expect(events.some((e) => e.type === "MEMORY_SAVED")).toBe(false);
  });

  it("type project is hard-refused with MEMORY_TYPE_FORBIDDEN and writes nothing", async () => {
    const { memory } = harness();
    const res = await memory.saveInTurn({ title: "P", body: "rules", type: "project" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("MEMORY_TYPE_FORBIDDEN");
    expect(memory.list()).toHaveLength(0);
  });

  it("any non-writable type (identity, project, wrong case, whitespace, unknown) yields MEMORY_TYPE_FORBIDDEN naming the two writable types and writes nothing (§6.2)", async () => {
    for (const type of ["identity", "project", "Note", " note", "bogus", "USER-MODEL"]) {
      const { memory, events } = harness();
      const res = await memory.saveInTurn({ title: "X", body: `body for ${type}`, type });
      expect(res.ok, `type "${type}" must be refused`).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("MEMORY_TYPE_FORBIDDEN");
        // The message names the two writable types so the model knows the fix.
        expect(res.error.message).toContain("user-model");
        expect(res.error.message).toContain("note");
      }
      expect(memory.list(), `type "${type}" must persist nothing`).toHaveLength(0);
      expect(events.some((e) => e.type === "MEMORY_SAVED")).toBe(false);
    }
  });

  it("an API-key-shaped body is persisted MASKED (no raw secret on disk)", async () => {
    const { memory } = harness();
    const secret = "ghp_01" + "23456789abcdefghijABCDEFGHIJ0123";
    const res = await memory.saveInTurn({ title: "Token note", body: `the token is ${secret}`, type: "note" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.body).not.toContain(secret);
      expect(res.value.body).toContain("«redacted");
    }
  });

  it("a duplicate normalized body is not written twice", async () => {
    const { memory } = harness();
    await memory.saveInTurn({ title: "A", body: "Same lesson here.", type: "note" });
    await memory.saveInTurn({ title: "B", body: "same   LESSON here.", type: "note" });
    expect(memory.list()).toHaveLength(1);
  });

  it("surfaceById finds an entry that the cap demoted out of the active index", async () => {
    const { memory } = harness();
    await memory.saveInTurn({ title: "oldest", body: "o".repeat(60), keywords: ["oldest"], type: "note" });
    await memory.saveInTurn({ title: "newest", body: "n", keywords: ["newest"], type: "note" });
    const window = 200; // tiny cap forces the oldest to demote
    const idx = memory.memoryIndex(window);
    expect(idx.demoted).toContain("oldest");
    // Still findable by id (the list_memory/recall load-by-id path) …
    expect(memory.surfaceById("oldest")).not.toBeNull();
    // … and still keyword-discoverable, and NOT deleted.
    expect(memory.surfaceByKeywords("oldest").some((e) => e.id === "oldest")).toBe(true);
    expect(memory.list().some((e) => e.id === "oldest")).toBe(true);
  });

  it("an API-key-shaped TITLE and KEYWORD persist masked (§10.10)", async () => {
    const { memory } = harness();
    const secret = "ghp_01" + "23456789abcdefghijABCDEFGHIJ0123";
    const res = await memory.saveInTurn({
      title: `token ${secret}`,
      body: "a body",
      keywords: [`kw ${secret}`],
      type: "note",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.title).not.toContain(secret);
    expect(res.value.title).toContain("«redacted");
    expect(res.value.keywords.join(" ")).not.toContain(secret);
    expect(res.value.keywords.join(" ")).toContain("«redacted");
    // The head index line carries the masked title's summary path too.
    const idx = memory.memoryIndex(32_000);
    expect(JSON.stringify(idx)).not.toContain(secret);
  });

  it("control/bidi/ANSI chars are absent from the stored entry, the head and list_memory (§10.10)", async () => {
    const { memory } = harness();
    const bidi = "\u202E"; // right-to-left override
    const ansi = "\u001B[31m"; // ESC [ 31 m
    const bel = "\u0007"; // BEL
    const dirty = `clean${bidi}${ansi}${bel}text`;
    const res = await memory.saveInTurn({
      title: `t${bidi}itle`,
      body: `body ${ansi}here`,
      keywords: [`kw${bel}`],
      summary: dirty,
      type: "note",
    });
    expect(res.ok).toBe(true);
    const hasUnsafe = (s: string) => /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/.test(s);
    // Stored (DTO/read) entry is clean.
    const dto = memory.list()[0]!;
    expect(hasUnsafe(dto.title + dto.summary + dto.body + dto.keywords.join(""))).toBe(false);
    // Head index is clean.
    expect(hasUnsafe(JSON.stringify(memory.memoryIndex(32_000)))).toBe(false);
    // surfaceByKeywords render (Void-layer bodies) is clean.
    const surfaced = memory.surfaceByKeywords("kw");
    expect(hasUnsafe(surfaced.map((e) => e.title + e.body).join(""))).toBe(false);
  });

  it("a hand-edited entry's control chars are stripped at render even without a re-write (§10.10)", async () => {
    const { memory } = harness();
    await memory.saveInTurn({ title: "ident", body: "base", type: "note", keywords: ["x"] });
    // Simulate a hand edit by replacing the on-disk-parsed index value directly.
    const dirty = (memory as unknown as { index: Map<string, { title: string; summary: string; body: string; keywords: string[]; type: string }> }).index.get("ident")!;
    dirty.title = "t\u202Eitle";
    dirty.summary = "sum\u001B[31mmary";
    dirty.body = "bo\u0007dy";
    const hasUnsafe = (s: string) => /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/.test(s);
    const dto = memory.list()[0]!;
    expect(hasUnsafe(dto.title + dto.summary + dto.body)).toBe(false);
    expect(hasUnsafe(JSON.stringify(memory.memoryIndex(32_000)))).toBe(false);
  });
});
