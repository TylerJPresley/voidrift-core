/**
 * Suggestions-directory adapter (core-blueprint.md §6.7): a file with an
 * unknown kind (e.g. an old `script`) is skipped with a one-line warning naming
 * it, never crashing listing.
 */
import { describe, it, expect } from "vitest";
import { SuggestionsDirectory } from "./suggestions-directory.js";
import { InMemoryFileSystem } from "./in-memory-filesystem.js";
import type { Suggestion } from "../entities/memory/suggestion.js";

function valid(id: string): Suggestion {
  return {
    id,
    kind: "memory-note",
    title: "T",
    body: "B",
    keywords: [],
    memoryType: "note",
    memoryScope: "workspace",
    status: "pending",
    sourceSessionId: "s1",
    createdAt: id,
  };
}

describe("§6.7 — unknown suggestion kind is skipped with a warning", () => {
  it("list drops an old 'script' file, warns once naming it, keeps the valid ones", async () => {
    const fs = new InMemoryFileSystem();
    const warnings: string[] = [];
    const dir = new SuggestionsDirectory(fs, ".voidrift/suggestions", (m) => warnings.push(m));
    await dir.save(valid("a"));
    // An old-format file written straight to disk with the removed kind.
    await fs.writeFile(".voidrift/suggestions/old.json", JSON.stringify({ ...valid("old"), kind: "script" }));

    const list = await dir.list();
    expect(list.map((s) => s.id)).toEqual(["a"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("old.json");
    expect(warnings[0]).toContain("script");
  });

  it("get returns null and warns for an unknown-kind file", async () => {
    const fs = new InMemoryFileSystem();
    const warnings: string[] = [];
    const dir = new SuggestionsDirectory(fs, ".voidrift/suggestions", (m) => warnings.push(m));
    await fs.writeFile(".voidrift/suggestions/old.json", JSON.stringify({ ...valid("old"), kind: "script" }));
    expect(await dir.get("old")).toBeNull();
    expect(warnings).toHaveLength(1);
  });
});

describe("§10.6 Lifecycle — rejected-signature list and suppressed signatures", () => {
  it("remembers a rejected signature, is idempotent, and reads it back", async () => {
    const fs = new InMemoryFileSystem();
    const dir = new SuggestionsDirectory(fs, ".voidrift/suggestions");
    await dir.rememberRejectedSignature("read_file({}) → write_file({})");
    await dir.rememberRejectedSignature("read_file({}) → write_file({})"); // idempotent
    await dir.rememberRejectedSignature("a({}) → b({})");
    expect(await dir.rejectedSignatures()).toEqual([
      "read_file({}) → write_file({})",
      "a({}) → b({})",
    ]);
  });

  it("the rejected-signature file is written owner-only (0600)", async () => {
    const fs = new InMemoryFileSystem();
    let mode: number | undefined;
    const orig = fs.writeFileAtomic.bind(fs);
    fs.writeFileAtomic = async (p: string, c: string, opts?: { mode?: number }) => {
      mode = opts?.mode;
      return orig(p, c, opts);
    };
    const dir = new SuggestionsDirectory(fs, ".voidrift/suggestions");
    await dir.rememberRejectedSignature("x({}) → y({})");
    expect(mode).toBe(0o600);
  });

  it("suppressedSignatures unions pending/approved suggestion signatures with the rejected list", async () => {
    const fs = new InMemoryFileSystem();
    const dir = new SuggestionsDirectory(fs, ".voidrift/suggestions");
    await dir.save({ ...valid("p1"), kind: "skill", signature: "pending-sig", status: "pending" });
    await dir.save({ ...valid("a1"), kind: "skill", signature: "approved-sig", status: "approved" });
    // A rejected suggestion's signature is remembered via the list, not re-added here.
    await dir.save({ ...valid("r1"), kind: "skill", signature: "rejected-sug-sig", status: "rejected" });
    await dir.rememberRejectedSignature("remembered-rejected-sig");
    const suppressed = (await dir.suppressedSignatures()).sort();
    expect(suppressed).toEqual(["approved-sig", "pending-sig", "remembered-rejected-sig"].sort());
    // A rejected suggestion's own signature is NOT auto-suppressed from the file
    // list (only pending/approved are); the rejected LIST carries the memory.
    expect(suppressed).not.toContain("rejected-sug-sig");
  });
});
