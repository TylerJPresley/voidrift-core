import { describe, it, expect } from "vitest";
import { globMatch } from "./glob-matcher.js";

describe("globMatch — one matcher for Guardian/Warden/scope (§9.2)", () => {
  it("`*` matches anything", () => {
    expect(globMatch("*", "anything/at/all")).toBe(true);
  });

  it("a command glob (no separator) treats `*` as match-anything", () => {
    expect(globMatch("git *", "git commit x")).toBe(true);
    expect(globMatch("git *", "npm test")).toBe(false);
    expect(globMatch("npm test", "npm test")).toBe(true);
  });

  it("a path glob uses `*` within a segment and `**` across segments", () => {
    expect(globMatch("src/*.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/*.ts", "src/sub/a.ts")).toBe(false);
    expect(globMatch("src/**", "src/sub/a.ts")).toBe(true);
    expect(globMatch("src/**/*.ts", "src/a/b/c.ts")).toBe(true);
  });
});
