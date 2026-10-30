/**
 * Memory index + provenance entity tests (core-blueprint.md §4.6, §6.2).
 *
 * Covers the pure `buildMemoryIndex` (loads WHOLE — nothing demoted or capped)
 * and the `sourceSessionId` frontmatter round-trip. Deterministic, no I/O (§15.3).
 */
import { describe, it, expect } from "vitest";
import {
  buildMemoryIndex,
  makeEntry,
  serializeEntry,
  parseEntry,
  type MemoryEntry,
} from "./memory-entry.js";

function note(id: string, summary: string): MemoryEntry {
  return makeEntry({ id, title: id, type: "note", scope: "workspace", body: summary, summary, keywords: [id] });
}

describe("§4.6/§6.2 — the memory index loads WHOLE", () => {
  it("every agent-written entry's summary is active and nothing is demoted", () => {
    const entries = [note("a", "alpha"), note("b", "beta"), makeEntry({ title: "Prefs", type: "user-model", scope: "workspace", body: "likes tabs", summary: "likes tabs" })];
    const idx = buildMemoryIndex(entries, 32_000);
    expect(idx.active.map((l) => l.id)).toEqual(["a", "b", "prefs"]);
    expect(idx.demoted).toEqual([]);
  });

  it("identity/project entries never appear in the index", () => {
    const entries = [
      makeEntry({ title: "Id", type: "identity", scope: "global", body: "x" }),
      makeEntry({ title: "Proj", type: "project", scope: "workspace", body: "y" }),
      note("n", "kept"),
    ];
    const idx = buildMemoryIndex(entries, 32_000);
    expect(idx.active.map((l) => l.id)).toEqual(["n"]);
  });

  it("200 entries all appear whole — nothing is demoted even on a tiny window", () => {
    const entries = Array.from({ length: 200 }, (_, i) => note(`n${i}`, "s".repeat(80)));
    const idx = buildMemoryIndex(entries, 200);
    expect(idx.active.length).toBe(200);
    expect(idx.demoted).toEqual([]);
    expect(idx.active.map((l) => l.id)).toContain("n0");
    expect(idx.active.map((l) => l.id)).toContain("n199");
  });

  it("the index never demotes regardless of the window size argument", () => {
    const entries = [note("a", "x".repeat(400)), note("b", "y".repeat(400)), note("c", "z".repeat(400))];
    expect(buildMemoryIndex(entries, 1).demoted).toEqual([]);
    expect(buildMemoryIndex(entries, 32_000).demoted).toEqual([]);
    expect(buildMemoryIndex(entries).demoted).toEqual([]);
  });
});

describe("§6.2/§6.4 — sourceSessionId provenance round-trips", () => {
  it("serialize → parse preserves sourceSessionId", () => {
    const e = makeEntry({ title: "Lesson", type: "note", scope: "workspace", body: "do X", sourceSessionId: "sess-7" });
    const parsed = parseEntry(serializeEntry(e));
    expect(parsed?.sourceSessionId).toBe("sess-7");
  });

  it("an entry without a sourceSessionId round-trips with the field absent", () => {
    const e = makeEntry({ title: "Lesson", type: "note", scope: "workspace", body: "do X" });
    const parsed = parseEntry(serializeEntry(e));
    expect(parsed?.sourceSessionId).toBeUndefined();
  });
});
