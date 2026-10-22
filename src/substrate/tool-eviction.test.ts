/**
 * Substrate tripwire — core-blueprint.md §1 assumption 4.
 *
 * `toolTokenLimitBeforeEvict` evicts an oversized tool result to the session
 * cache rather than returning it inline (§8.3).
 *
 * Pins the EXACT installed deepagents filesystem middleware behavior: an
 * oversized tool result is replaced in the message transcript by a short
 * pointer and the full content is written into the agent's filesystem state.
 *
 * Offline/deterministic: scripted `fakeModel()` and an in-process tool, no
 * network, no model.
 */
import { describe, it, expect } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createDeepAgent } from "deepagents";

describe("substrate §1.4 — oversized tool results are evicted, not returned inline", () => {
  it("evicts a result over `toolTokenLimitBeforeEvict` to the filesystem and inlines a pointer", async () => {
    // Given a tool that returns a payload far larger than the eviction limit,
    const oversized = "X".repeat(200_000); // ~50k tokens, well over the 20k default
    const bigTool = tool(async () => oversized, {
      name: "big_tool",
      description: "returns a large result",
      schema: z.object({}),
    });

    // and an agent whose model calls that tool once with a low eviction limit set.
    const model = fakeModel()
      .respondWithTools([{ name: "big_tool", args: {} }])
      .respond(new AIMessage("done"));
    const agent = createDeepAgent({
      model,
      tools: [bigTool],
      // `toolTokenLimitBeforeEvict` (filesystem middleware) and
      // `generalPurposeAgent` (subagent middleware) are documented runtime
      // options forwarded by createDeepAgent but absent from its exported param
      // type, so they are attached as extra keys.
      ...({ toolTokenLimitBeforeEvict: 1_000, generalPurposeAgent: false } as {
        toolTokenLimitBeforeEvict: number;
        generalPurposeAgent: boolean;
      }),
    });

    // When the agent runs the turn.
    const result = await agent.invoke({ messages: [{ role: "user", content: "go" }] });

    // Then the tool message is NOT the inline payload: it is a short pointer to
    //   the evicted content, far smaller than the raw result.
    const toolMessage = result.messages.find((m) => m.getType() === "tool");
    expect(toolMessage).toBeDefined();
    const content = String(toolMessage!.content);
    expect(content.length).toBeLessThan(oversized.length);
    expect(content).toContain("Tool result too large");
    expect(content).toContain("/large_tool_results/");
    expect(content).not.toContain(oversized);

    // And the full result was evicted into the agent's filesystem state.
    const files = (result as { files?: Record<string, unknown> }).files ?? {};
    const evictedPath = Object.keys(files).find((p) => p.startsWith("/large_tool_results/"));
    expect(evictedPath).toBeDefined();
  });
});
