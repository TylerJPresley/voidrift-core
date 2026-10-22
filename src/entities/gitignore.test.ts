import { describe, it, expect } from "vitest";
import { compileIgnoreFile, isIgnored, type CompiledIgnoreFile } from "./gitignore.js";

/** Compile a single root-level .gitignore for brevity. */
function root(text: string): CompiledIgnoreFile[] {
  return [compileIgnoreFile("", text)];
}

describe("gitignore semantics (FX-B)", () => {
  it("ignores a basename pattern at any depth", () => {
    const f = root("secret.txt");
    expect(isIgnored("secret.txt", false, f)).toBe(true);
    expect(isIgnored("a/b/secret.txt", false, f)).toBe(true);
    expect(isIgnored("secret.txt.keep", false, f)).toBe(false);
  });

  it("anchors a pattern that contains a non-trailing slash", () => {
    const f = root("build/out.js");
    expect(isIgnored("build/out.js", false, f)).toBe(true);
    expect(isIgnored("sub/build/out.js", false, f)).toBe(false);
  });

  it("anchors a leading-slash pattern to the base dir", () => {
    const f = root("/top.txt");
    expect(isIgnored("top.txt", false, f)).toBe(true);
    expect(isIgnored("nested/top.txt", false, f)).toBe(false);
  });

  it("a trailing slash matches directories only (and everything beneath)", () => {
    const f = root("logs/");
    expect(isIgnored("logs", true, f)).toBe(true);
    expect(isIgnored("logs/app.log", false, f)).toBe(true);
    // a FILE named logs is not matched by a dir-only rule
    expect(isIgnored("logs", false, f)).toBe(false);
  });

  it("supports negation re-including a previously ignored path", () => {
    const f = root("*.log\n!keep.log");
    expect(isIgnored("app.log", false, f)).toBe(true);
    expect(isIgnored("keep.log", false, f)).toBe(false);
  });

  it("a single `*` stays within a segment; a double star spans segments", () => {
    expect(isIgnored("a/x.js", false, root("*.js"))).toBe(true);
    expect(isIgnored("a/b/x.js", false, root("a/**/x.js"))).toBe(true);
    expect(isIgnored("a/x.js", false, root("a/**/x.js"))).toBe(true);
    // a single star does not cross a slash when anchored
    expect(isIgnored("a/b/x.js", false, root("a/*.js"))).toBe(false);
  });

  it("supports character classes with ranges and negation", () => {
    expect(isIgnored("file1.tmp", false, root("file[0-9].tmp"))).toBe(true);
    expect(isIgnored("fileA.tmp", false, root("file[0-9].tmp"))).toBe(false);
    expect(isIgnored("fileA.tmp", false, root("file[!0-9].tmp"))).toBe(true);
  });

  it("ignores comments and blank lines; a leading escaped # is literal", () => {
    const f = root("# a comment\n\n\\#real");
    expect(isIgnored("#real", false, f)).toBe(true);
    expect(isIgnored("a comment", false, f)).toBe(false);
  });

  it("strips trailing spaces unless escaped", () => {
    expect(isIgnored("name", false, root("name   "))).toBe(true);
    // an escaped trailing space keeps it literal (so plain 'name' won't match)
    expect(isIgnored("name", false, root("name\\ "))).toBe(false);
    expect(isIgnored("name ", false, root("name\\ "))).toBe(true);
  });

  it("a deeper .gitignore governs only its subtree and later rules win", () => {
    const files = [
      compileIgnoreFile("", "*.log"),
      compileIgnoreFile("sub", "!important.log"),
    ];
    expect(isIgnored("top.log", false, files)).toBe(true);
    expect(isIgnored("sub/important.log", false, files)).toBe(false);
    expect(isIgnored("sub/other.log", false, files)).toBe(true);
  });
});
