/**
 * The scope-targets journal reader (core-blueprint.md §9.5.1, §10.11).
 */
import { describe, it, expect } from "vitest";
import { makeScopeTargetsReader } from "./scope-targets-reader.js";
import type { JournalStore } from "../../entities/ports/journal-store.js";
import type { JournalEntry } from "../../entities/journal.js";

function entry(seq: number, target: string, planStep?: string): JournalEntry {
  return {
    seq,
    time: new Date().toISOString(),
    sessionId: "s1",
    turn: 1,
    tool: "write_file",
    call: {},
    target,
    result: { status: "ok", summary: "" },
    ...(planStep !== undefined ? { planStep } : {}),
  };
}

function storeOf(entries: JournalEntry[]): JournalStore {
  return {
    list: async () => entries,
  } as unknown as JournalStore;
}

describe("makeScopeTargetsReader (§9.5.1)", () => {
  it("returns the distinct targets whose entry planStep equals the scope id", async () => {
    const store = storeOf([
      entry(1, "src/app.ts", "step-1"),
      entry(2, "src/app.ts", "step-1"), // a second write of the same target → one
      entry(3, "docs/x.md", "step-2"), // a different scope → excluded
      entry(4, "mcp_github_issue", "step-1"),
    ]);
    const read = makeScopeTargetsReader(store, () => "s1");
    const targets = await read("step-1");
    expect(targets.sort()).toEqual(["mcp_github_issue", "src/app.ts"]);
  });

  it("returns [] with no journal store or no session", async () => {
    expect(await makeScopeTargetsReader(undefined, () => "s1")("step-1")).toEqual([]);
    expect(await makeScopeTargetsReader(storeOf([]), () => "")("step-1")).toEqual([]);
  });

  it("a journal read failure returns [] (never fails a scope close)", async () => {
    const store = { list: async () => { throw new Error("io"); } } as unknown as JournalStore;
    expect(await makeScopeTargetsReader(store, () => "s1")("step-1")).toEqual([]);
  });

  it("an entry with no planStep never belongs to a scope", async () => {
    const store = storeOf([entry(1, "src/app.ts")]);
    expect(await makeScopeTargetsReader(store, () => "s1")("step-1")).toEqual([]);
  });
});
