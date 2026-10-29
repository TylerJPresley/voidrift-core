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
      "worktree.includeMaxEntries",
      "permissions.exactRememberMaxChars",
      "plugins.searchMaxBytes",
      "plugins.installMaxBytes",
    ];

    for (const key of expectedDeny) {
      expect(denyKeys).toContain(key);
    }

    // §13.11 owner 2026-10-29 — these five are `warn` (they do not break the
    // run): the read lane and worktree-include emit one LIMIT_HIT and keep
    // going; the recursion operands are derivation parameters.
    const expectedWarn = [
      "toolRounds.recursionMargin",
      "toolRounds.recursionFactor",
      "lane.readCallsPerTurn",
      "lane.readContextShare",
      "worktree.includeCapBytes",
    ];
    for (const key of expectedWarn) {
      expect(denyKeys).not.toContain(key);
    }
  });
});
