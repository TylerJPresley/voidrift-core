/**
 * DP1 — the exact-remember char cap (`permissions.exactRememberMaxChars`,
 * core-blueprint.md §13.11, inventory DP1). A force-ask is rememberable-as-exact
 * only when its literal value is unmasked AND within the cap. The cap is now a
 * SAFETY registry limit (a project may only LOWER it); the pure
 * `computeForceAskFields` builder takes the effective value as a parameter so
 * the use-case passes `limits.get("permissions.exactRememberMaxChars")`.
 */
import { describe, it, expect } from "vitest";
import { computeForceAskFields, exactRememberMaxCharsDefault, type AskRequest } from "./decision-point.js";

function forceAskFor(command: string): AskRequest {
  return {
    call: { tool: "execute_command", args: { command } },
    forceAsk: true,
    forceAskKind: "shell",
    inferredPatterns: undefined,
    ctx: { sessionId: "s0", approvalMode: "interactive" },
  };
}

describe("§13.11 DP1 — exact-remember cap", () => {
  it("the default cap is 4096 (the registry limit)", () => {
    expect(exactRememberMaxCharsDefault()).toBe(4096);
  });

  it("at the default cap, a short force-ask value is rememberable as an exact rule", () => {
    const fields = computeForceAskFields(forceAskFor("curl http://169.254.169.254/x"));
    expect(fields.rememberable).toBe(true);
    expect(fields.exactOnly).toBe(true);
    expect(fields.inferredPatterns).toEqual(["curl http://169.254.169.254/x"]);
  });

  it("a LOWERED cap makes a longer value NOT rememberable (project may only lower)", () => {
    const cmd = "echo " + "x".repeat(50);
    // Default cap: rememberable.
    expect(computeForceAskFields(forceAskFor(cmd)).rememberable).toBe(true);
    // A tiny cap below the value length: not rememberable, not exact.
    const capped = computeForceAskFields(forceAskFor(cmd), 10);
    expect(capped.rememberable).toBe(false);
    expect(capped.exactOnly).toBe(false);
    expect(capped.inferredPatterns).toBeUndefined();
  });
});
