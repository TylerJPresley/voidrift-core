/**
 * Tests for the untrusted-text sanitizer (core-blueprint.md §8.2) — PURE, no I/O.
 */
import { describe, it, expect } from "vitest";
import { stripUnsafeChars, stripUnsafeCharsKeepWhitespace } from "./untrusted-text.js";

describe("stripUnsafeChars", () => {
  it("removes C0 control, DEL/C1, bidi-override, and zero-width/BOM chars", () => {
    // Given — a string laced with BEL, ESC, DEL/C1, bidi override, ZWSP, BOM
    const hostile = "a\u202Eevil\u0007bell\u001Besc\u007Fdel\u0085nel\u200Bzwsp\uFEFFbom\u2066iso";
    // When
    const out = stripUnsafeChars(hostile);
    // Then — none of the dangerous classes survive
    expect(out).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/);
    expect(out).toBe("aevilbellescdelnelzwspbomiso");
  });

  it("leaves clean text (and its spaces) unchanged", () => {
    expect(stripUnsafeChars("a tidy title")).toBe("a tidy title");
  });

  it("drops, not spaces: a run of control bytes does not inflate length", () => {
    expect(stripUnsafeChars("x\u0000\u0001\u0002y")).toBe("xy");
  });
});

describe("stripUnsafeCharsKeepWhitespace", () => {
  it("keeps tab/newline/CR but strips the dangerous classes", () => {
    const s = "line1\nline2\tcol\r\nX\u0007\u202E\u200B";
    const out = stripUnsafeCharsKeepWhitespace(s);
    expect(out).toBe("line1\nline2\tcol\r\nX");
    expect(out).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/);
  });
});
