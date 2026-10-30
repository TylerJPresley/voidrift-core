/**
 * traceAnalyzerMessage wording (core-blueprint.md §10.6; session-review product
 * finding 3).
 *
 * A repeated `guardian_block:<tool>` is a PERMISSION denial, not a loop the user
 * resolves in `/memory`: its suggestion names what happened and what actually
 * helps (first-class tools or an approval). A repeated `tool_error:<name>` keeps
 * its prior wording.
 */
import { describe, it, expect } from "vitest";
import { traceAnalyzerMessage } from "./obs-writer.js";

describe("traceAnalyzerMessage (§10.6, finding 3)", () => {
  it("a guardian_block suggestion names the guard and the first-class tools, NOT /memory", () => {
    const msg = traceAnalyzerMessage("guardian_block:execute_command", 3);
    // MUTATION PROOF: the old wording ("a guard or a different approach may help;
    // review with /memory.") fails this assertion.
    expect(msg).toBe(
      "Run was denied 3× by the permission guard; use the first-class tools (read_file, glob_files, search) or ask for approval.",
    );
    expect(msg).not.toContain("/memory");
  });

  it("a tool_error suggestion keeps the prior wording unchanged", () => {
    const msg = traceAnalyzerMessage("tool_error:write_file", 3);
    expect(msg).toBe(
      "Repeated failure: Write failed 3× — a guard or a different approach may help; review with /memory.",
    );
  });
});
