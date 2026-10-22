/**
 * Substrate tripwire — core-blueprint.md §1 assumption 1.
 *
 * `task` dispatches an isolated `SubAgent` with fresh context that sees only
 * its delegated task description, never the orchestrator's conversation
 * (§3.1, §7.1).
 *
 * This test pins the behavior of the EXACT installed deepagents version. A
 * failure here means a dependency upgrade changed worker context isolation —
 * investigate before upgrading, do not relax the assertion.
 *
 * Offline/deterministic: scripted `fakeModel()` from @langchain/core, no
 * network, no live model.
 */
import { describe, it, expect } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import { createDeepAgent } from "deepagents";

describe("substrate §1.1 — task dispatches an isolated SubAgent with fresh context", () => {
  it("the worker sees only its delegated task description, never the orchestrator conversation", async () => {
    // Given an orchestrator that dispatches one `task` to a named worker then stops,
    //   and a worker that records every message it is handed on invocation.
    const orchestrator = fakeModel()
      .respondWithTools([
        { name: "task", args: { description: "DELEGATED-TASK-DESCRIPTION", subagent_type: "worker" } },
      ])
      .respond(new AIMessage("orchestrator-done"));

    let workerSaw: { type: string; content: string }[] | null = null;
    const worker = fakeModel().respond((messages) => {
      workerSaw = messages.map((m) => ({
        type: m.getType(),
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      }));
      return new AIMessage("worker-reply");
    });

    const agent = createDeepAgent({
      model: orchestrator,
      subagents: [
        { name: "worker", description: "a worker", systemPrompt: "WORKER-SYSTEM-PROMPT", model: worker },
      ],
      // `generalPurposeAgent` is a documented runtime option forwarded to the
      // subagent middleware (VoidRift disables it, §3.1) but is absent from
      // deepagents' exported param type, so it is attached as an extra key.
      ...({ generalPurposeAgent: false } as { generalPurposeAgent: boolean }),
    });

    // When the orchestrator runs a turn whose user message carries a secret.
    await agent.invoke({
      messages: [{ role: "user", content: "ORCHESTRATOR-CONVERSATION-SECRET" }],
    });

    // Then the worker was invoked with a fresh context: only its own system
    //   prompt plus the delegated task description — never the orchestrator's
    //   conversation.
    expect(workerSaw).not.toBeNull();
    const serialized = JSON.stringify(workerSaw);
    expect(serialized).toContain("DELEGATED-TASK-DESCRIPTION");
    expect(serialized).toContain("WORKER-SYSTEM-PROMPT");
    expect(serialized).not.toContain("ORCHESTRATOR-CONVERSATION-SECRET");

    // And the worker received exactly the isolated pair (system prompt + task).
    expect(workerSaw!.map((m) => m.type)).toEqual(["system", "human"]);
    expect(workerSaw![1]!.content).toBe("DELEGATED-TASK-DESCRIPTION");
  });
});
