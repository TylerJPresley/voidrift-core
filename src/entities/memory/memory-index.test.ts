/**
 * Memory index + provenance entity tests (core-blueprint.md §4.6, §6.2).
 *
 * Covers the pure `buildMemoryIndex` cap/demotion (oldest-first, keyword-only,
 * never dropped) and the `sourceSessionId` frontmatter round-trip. Deterministic,
 * no I/O (§15.3).
 */
import { describe, it, expect } from "vitest";
import {
  buildMemoryIndex,
  memoryIndexCapPctDefault,
  makeEntry,
  serializeEntry,
  parseEntry,
  type MemoryEntry,
} from "./memory-entry.js";

function note(id: string, summary: string): MemoryEntry {
  return makeEntry({ id, title: id, type: "note", scope: "workspace", body: summary, summary, keywords: [id] });
}

describe("§4.6/§6.2 — the memory index (summaries + cap/demotion)", () => {
  it("under the cap, every agent-written entry's summary is active and nothing is demoted", () => {
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

  it("over the cap, the OLDEST entries demote oldest-first and the newest stay active", () => {
    // Tiny window → a cap of a few tokens forces demotion of the front.
    const window = 200; // cap = 200 * 0.05 = 10 tokens
    const entries = [note("oldest", "x".repeat(80)), note("mid", "y".repeat(80)), note("newest", "z")];
    const idx = buildMemoryIndex(entries, window);
    // At least the oldest is demoted; the newest (small) remains active.
    expect(idx.demoted).toContain("oldest");
    expect(idx.active.map((l) => l.id)).toContain("newest");
    // Demotion removes from the FRONT: a demoted id never co-exists as active.
    for (const d of idx.demoted) expect(idx.active.find((l) => l.id === d)).toBeUndefined();
    // Nothing is dropped: active + demoted == all agent-written entries.
    expect(idx.active.length + idx.demoted.length).toBe(3);
  });

  it("the default cap is 5% of the window (memory.indexCapPct)", () => {
    expect(memoryIndexCapPctDefault()).toBe(0.05);
  });

  it("a smaller capPct demotes more entries (the registry limit is honored)", () => {
    const window = 32_000;
    const entries = [note("a", "x".repeat(40)), note("b", "y".repeat(40)), note("c", "z".repeat(40))];
    const generous = buildMemoryIndex(entries, window, 0.05);
    const tiny = buildMemoryIndex(entries, window, 0.0005);
    expect(tiny.demoted.length).toBeGreaterThan(generous.demoted.length);
    // Nothing is dropped under either cap.
    expect(tiny.active.length + tiny.demoted.length).toBe(3);
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
