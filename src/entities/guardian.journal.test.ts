/**
 * Guardian journal-path protection (core-blueprint.md §9.4, §10.11).
 *
 * The mutation journal (`.voidrift/journal/`) is a PROTECTED CONTROL LOCATION:
 * the file tools can neither READ nor WRITE it (read_file, glob_files,
 * search_contents, workspace_map, write_file, edit_file, researcher_save_notes),
 * and an `execute_command` whose text references the journal path — including
 * `..`, `./`, `$HOME`/`~` forms and a `$(...)` that spells it out — is DENIED.
 */
import { describe, it, expect } from "vitest";
import { Guardian, builtinGuardrails, referencesJournalPath, isProtectedControlFile } from "./guardian.js";

const g = new Guardian(builtinGuardrails());
const gctx = { readPaths: new Set<string>(), stalePaths: new Set<string>(), tempDir: "", workspaceRoot: "/ws" };

function check(tool: string, args: Record<string, unknown>) {
  return g.runGuardrails({ tool, args }, gctx);
}

describe("§10.11 — journal is a protected control location", () => {
  it("isProtectedControlFile covers the journal dir (relative and absolute)", () => {
    expect(isProtectedControlFile(".voidrift/journal/s1/entries.jsonl")).toBe(true);
    expect(isProtectedControlFile("/ws/.voidrift/journal/s1/blobs/abc", "/ws")).toBe(true);
    expect(isProtectedControlFile(".voidrift/journal/../journal/s1/entries.jsonl")).toBe(true);
    expect(isProtectedControlFile(".voidrift/cache/session/x")).toBe(false);
  });

  it("every file tool is DENIED a read or write on the journal path", () => {
    for (const tool of ["read_file", "write_file", "edit_file", "researcher_save_notes"]) {
      const r = check(tool, { path: ".voidrift/journal/s1/entries.jsonl" });
      expect(r.allowed, tool).toBe(false);
      expect(r.reason).toContain("protected location");
    }
    expect(check("glob_files", { glob: ".voidrift/journal/**" }).allowed).toBe(false);
    expect(check("search_contents", { pattern: "secret", path: ".voidrift/journal/" }).allowed).toBe(false);
    expect(check("workspace_map", { root: ".voidrift/journal" }).allowed).toBe(false);
  });

  it("a non-journal file path is allowed", () => {
    expect(check("read_file", { path: "src/index.ts" }).allowed).toBe(true);
    expect(check("write_file", { path: "docs/readme.md" }).allowed).toBe(true);
  });

  it("execute_command referencing the journal path is DENIED (cat, .., $(...), ~ forms)", () => {
    for (const command of [
      "cat .voidrift/journal/s1/entries.jsonl",
      "cat ./x/../.voidrift/journal/s1/entries.jsonl",
      "cp $(echo .voidrift/journal/s1/blobs/a) /tmp/x",
      "cat ~/proj/.voidrift/journal/s1/entries.jsonl",
    ]) {
      const r = check("execute_command", { command });
      expect(r.allowed, command).toBe(false);
      expect(r.reason).toContain("protected location");
    }
  });

  it("an execute_command not touching the journal is allowed by this guardrail", () => {
    expect(check("execute_command", { command: "ls .voidrift/cache" }).allowed).toBe(true);
    expect(check("execute_command", { command: "echo journaling" }).allowed).toBe(true);
  });

  it("referencesJournalPath resolves .. and HOME/~ forms", () => {
    expect(referencesJournalPath(".voidrift/journal/s")).toBe(true);
    expect(referencesJournalPath("a/b/../../.voidrift/journal/s")).toBe(true);
    expect(referencesJournalPath(".voidrift/journalX/s")).toBe(false);
    expect(referencesJournalPath("/ws/.voidrift/journal/s", "/ws")).toBe(true);
  });
});
