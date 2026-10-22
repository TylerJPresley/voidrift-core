import { describe, it, expect } from "vitest";
import { isLeftoverName } from "./live-leftovers.js";

describe("§13.9.1 leftover pattern matcher", () => {
  it("matches every retired-sibling and editor/VCS leftover pattern", () => {
    for (const name of [
      "agent.json.rejected",
      "config.json.rejected",
      "agent.json.rejected.1",
      "prompt.md.previous",
      "config.json.bak",
      "config.json.bak-20261020",
      "config.json.bak.1",
      "SKILL.md.orig",
      "agent.json~",
      ".agent.json.swp",
      "agent.json.tmp-abc123",
      ".#agent.json",
    ]) {
      expect(isLeftoverName(name), name).toBe(true);
    }
  });

  it("never matches a canonical or an ordinary file name", () => {
    for (const name of [
      "agent.json",
      "prompt.md",
      "SKILL.md",
      "config.json",
      "notes.md",
      "readme.txt",
      "run.sh",
      "helper.py",
      "data.json",
    ]) {
      expect(isLeftoverName(name), name).toBe(false);
    }
  });
});
