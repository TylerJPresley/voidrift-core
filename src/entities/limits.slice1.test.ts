import { describe, it, expect } from "vitest";
import { LIMITS } from "./limits.js";

describe("SLICE 1: limits action field", () => {
  it("every limit has an action field (warn | deny)", () => {
    for (const limit of LIMITS) {
      expect(limit).toHaveProperty("action");
      expect(["warn", "deny"] as const).toContain(limit.action);
    }
  });

  it("deny limits match the approved table", () => {
    const denyKeys = LIMITS.filter((l) => l.action === "deny").map((l) => l.key);
    const expectedDeny = [
      "toolRounds.recursionMargin",
      "toolRounds.recursionFactor",
      "tools.webFetchBodyMaxBytes",
      "tools.webFetchMaxHops",
      "tools.webSearchBodyMaxBytes",
      "tools.imageMaxBytes",
      "tools.imagesPerMessage",
      "tools.responseSchemaMaxBytes",
      "tools.commandTimeoutMs",
      "mcp.connectTimeoutMs",
      "tools.searchTimeoutMs",
      "lane.writeCallsPerTurn",
      "lane.distinctTargetsPerTurn",
      "lane.writeContextShare",
      "lane.readCallsPerTurn",
      "lane.readContextShare",
      "worktree.includeCapBytes",
      "worktree.includeMaxEntries",
      "permissions.exactRememberMaxChars",
      "plugins.searchMaxBytes",
      "plugins.installMaxBytes",
    ];

    for (const key of expectedDeny) {
      expect(denyKeys).toContain(key);
    }
  });
});
