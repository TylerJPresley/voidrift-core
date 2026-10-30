/**
 * Guardian compound has-equivalent denial (core-blueprint.md §9.3; session-review
 * product finding 1).
 *
 * A compound shell command whose segments redirect to a first-class tool is
 * denied with ONE reason listing EVERY offending fragment and the tool to use
 * for each, so the model fixes them all in one round rather than one per denial.
 * A single redirectable fragment keeps the prior single-fragment wording
 * byte-identical; a clean command is untouched.
 */
import { describe, it, expect } from "vitest";
import {
  Guardian,
  builtinGuardrails,
  hasEquivalentReason,
  hasEquivalentFragments,
  firstClassToolFor,
  type ShellLists,
} from "./guardian.js";
import { DEFAULT_SHELL_SAFE, DEFAULT_SHELL_FORCE_ASK, DEFAULT_SHELL_EQUIVALENTS } from "../config/schema.js";

const lists: ShellLists = {
  safe: DEFAULT_SHELL_SAFE,
  forceAsk: DEFAULT_SHELL_FORCE_ASK,
  equivalents: DEFAULT_SHELL_EQUIVALENTS,
  deny: [],
};

describe("compound has-equivalent denial (§9.3, finding 1)", () => {
  const guardian = new Guardian(builtinGuardrails());

  it("a three-segment command with TWO redirectable fragments denies ONCE naming BOTH and their tools", () => {
    // `cat` → read_file, `pwd` safe, `find` → glob_files.
    const command = "cat .gitignore && pwd && find _internal/backups -type f";
    const out = guardian.evaluate({ tool: "execute_command", args: { command } }, [], lists);
    expect(out.decision).toBe("deny");
    // MUTATION PROOF: a single-fragment implementation would name only one
    // fragment and omit the per-fragment tool mapping — this fails it.
    expect(out.reason).toBe(
      "use the first-class tool instead of: cat .gitignore -> read_file; find _internal/backups -type f -> glob_files",
    );
  });

  it("a command with ONE redirectable fragment keeps the unchanged single-fragment text", () => {
    const out = guardian.evaluate({ tool: "execute_command", args: { command: "cat f" } }, [], lists);
    expect(out.decision).toBe("deny");
    // Byte-identical to the prior wording (no `-> tool`, no `;`).
    expect(out.reason).toBe("use the first-class tool instead of: cat f");
  });

  it("a clean command is unchanged (allowed, no has-equivalent denial)", () => {
    const out = guardian.evaluate({ tool: "execute_command", args: { command: "ls -la && pwd" } }, [], lists);
    expect(out.decision).toBe("allow");
  });

  it("hasEquivalentFragments lists every top-level redirectable segment with its tool", () => {
    const frags = hasEquivalentFragments("cat a && grep x b && find . -type f", lists);
    expect(frags).toEqual([
      { segment: "cat a", tool: "read_file" },
      { segment: "grep x b", tool: "search_contents" },
      { segment: "find . -type f", tool: "glob_files" },
    ]);
  });

  it("firstClassToolFor maps the known verbs and strips a binary path", () => {
    expect(firstClassToolFor("cat x")).toBe("read_file");
    expect(firstClassToolFor("/bin/cat x")).toBe("read_file");
    expect(firstClassToolFor("find . -type f")).toBe("glob_files");
    expect(firstClassToolFor("grep x")).toBe("search_contents");
    expect(firstClassToolFor("mystery x")).toBe("a first-class tool");
  });

  it("hasEquivalentReason falls back to the raw segment when no top-level fragment surfaces", () => {
    // No has-equivalent fragment in the (empty-equivalents) lists → fall back.
    const empty: ShellLists = { ...lists, equivalents: [] };
    expect(hasEquivalentReason("cat f", empty, "cat f")).toBe("use the first-class tool instead of: cat f");
  });
});
