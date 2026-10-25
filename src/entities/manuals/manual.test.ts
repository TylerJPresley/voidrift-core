import { describe, it, expect } from "vitest";
import { parseManual, ManualValidationError } from "./manual.js";
import type { Manual } from "./manual.js";

function testManual(
  id: string,
  frontmatter: string,
  body: string,
  source: Manual["source"],
): string {
  void id; // Used in test output comments but not needed in function
  void source; // Used in test output comments but not needed in function
  return `---\n${frontmatter}\n---\n\n${body}`;
}

describe("Manual entity (§12.8)", () => {
  it("parses YAML frontmatter with summary, read-when, and type", () => {
    const raw = testManual(
      "core/intro",
      "summary: Getting started guide\nread-when: before first use\ntype: tutorial",
      "# Introduction\n\nWelcome to VoidRift.",
      "builtin",
    );
    const manual = parseManual(raw, "core/intro", "builtin");
    expect(manual.id).toBe("core/intro");
    expect(manual.frontmatter.summary).toBe("Getting started guide");
    expect(manual.frontmatter.readWhen).toBe("before first use");
    expect(manual.frontmatter.type).toBe("tutorial");
    expect(manual.body).toBe("# Introduction\n\nWelcome to VoidRift.");
  });

  it("requires summary, read-when, and type in frontmatter", () => {
    const raw = testManual("core/incomplete", "summary: A doc", "", "builtin");
    expect(() => parseManual(raw, "core/incomplete", "builtin")).toThrow(
      ManualValidationError,
    );
  });

  it("rejects malformed YAML frontmatter", () => {
    const raw = `---\nbad yaml: [unclosed\n---\n\nBody`;
    expect(() => parseManual(raw, "core/bad", "builtin")).toThrow(
      ManualValidationError,
    );
  });

  it("rejects a manual without a frontmatter block", () => {
    const raw = "No frontmatter here\nJust body";
    expect(() => parseManual(raw, "core/none", "builtin")).toThrow(
      ManualValidationError,
    );
  });

  it("enforces namespace prefix in id: core/, cli/, plugin-id/, user/, project/", () => {
    // Valid prefixes
    parseManual(testManual("core/doc", "summary: s\nread-when: rw\ntype: tutorial", "b", "builtin"), "core/doc", "builtin");
    parseManual(testManual("cli/doc", "summary: s\nread-when: rw\ntype: tutorial", "b", "builtin"), "cli/doc", "builtin");
    parseManual(testManual("plugin-x/doc", "summary: s\nread-when: rw\ntype: tutorial", "b", "builtin"), "plugin-x/doc", "builtin");
    parseManual(testManual("user/doc", "summary: s\nread-when: rw\ntype: tutorial", "b", "builtin"), "user/doc", "builtin");
    parseManual(testManual("project/doc", "summary: s\nread-when: rw\ntype: tutorial", "b", "builtin"), "project/doc", "builtin");

    // Invalid: no prefix
    expect(() =>
      parseManual(testManual("nodoc", "summary: s\nread-when: rw\ntype: tutorial", "b", "builtin"), "nodoc", "builtin"),
    ).toThrow(ManualValidationError);
  });

  it("accepts Diataxis types: tutorial, how-to, reference, explanation", () => {
    const types = ["tutorial", "how-to", "reference", "explanation"];
    for (const t of types) {
      const raw = testManual(
        "core/doc",
        `summary: test\nread-when: anytime\ntype: ${t}`,
        "body",
        "builtin",
      );
      const manual = parseManual(raw, "core/doc", "builtin");
      expect(manual.frontmatter.type).toBe(t);
    }
  });

  it("rejects an invalid Diataxis type", () => {
    const raw = testManual("core/doc", "summary: test\nread-when: anytime\ntype: invalid", "body", "builtin");
    expect(() => parseManual(raw, "core/doc", "builtin")).toThrow(ManualValidationError);
  });


});
