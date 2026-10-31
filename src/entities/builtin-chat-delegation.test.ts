/**
 * The built-in `chat` prompt carries the delegation rule (core-blueprint.md
 * §3.1): a worker is created for a stated purpose, the `workers in parallel`
 * number is a ceiling not a target, and the old "fill the slots" wording is gone.
 */
import { describe, it, expect } from "vitest";
import { builtinChatAgent } from "./builtin-chat.js";

describe("builtin chat prompt — delegation rule (§3.1)", () => {
  const prompt = builtinChatAgent().systemPrompt;

  it("states the ceiling-not-a-target rule and the never-delegate case", () => {
    expect(prompt).toContain("a ceiling, not a target");
    expect(prompt).toContain("Never delegate");
  });

  it("drops the old fill-the-parallel-slots wording", () => {
    expect(prompt).not.toContain("Push heavy reading");
    expect(prompt).not.toContain("as many at once as");
  });
});
