/**
 * Substrate tripwire — core-blueprint.md §1 assumption 2.
 *
 * A worker compiled WITHOUT the subagent middleware holds no `task` tool and
 * cannot dispatch, so recursion is structurally impossible (§3.1, §7.1).
 *
 * Pins the EXACT installed deepagents / langchain versions. Two independent
 * checks: (a) the structural fact that `createSubAgentMiddleware` is the sole
 * source of the `task` tool, and (b) the behavioral fact that a plain
 * `createAgent` worker given no such tool executes no dispatch even when its
 * model attempts a `task` call.
 *
 * Offline/deterministic: scripted `fakeModel()`, no network.
 */
import { describe, it, expect } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import { createAgent } from "langchain";
import { createDeepAgent, createSubAgentMiddleware } from "deepagents";

describe("substrate §1.2 — a worker without subagent middleware cannot dispatch", () => {
  it("the subagent middleware is the sole source of the `task` tool", () => {
    // Given the subagent middleware configured with one worker,
    const mw = createSubAgentMiddleware({
      defaultModel: fakeModel(),
      subagents: [{ name: "w", description: "w", model: fakeModel() }],
      generalPurposeAgent: false,
    });

    // Then it contributes exactly the `task` tool. A worker compiled without
    //   this middleware therefore has no `task` tool by construction.
    expect(mw.tools?.map((t) => t.name)).toEqual(["task"]);
  });

  it("a plain worker's attempted `task` call dispatches nothing", async () => {
    // Given a plain createAgent worker (no subagent middleware, no tools) whose
    //   model attempts to emit a `task` tool call to spawn another worker.
    const workerModel = fakeModel()
      .respondWithTools([{ name: "task", args: { description: "spawn-a-worker", subagent_type: "x" } }])
      .respond(new AIMessage("worker-fallback"));
    const worker = createAgent({ model: workerModel, tools: [] });

    // When the worker runs.
    const result = await worker.invoke({ messages: [{ role: "user", content: "go" }] });

    // Then no `task` tool executed: there is no ToolMessage and thus no
    //   dispatched subagent result in the transcript — recursion is impossible.
    const toolMessages = result.messages.filter((m) => m.getType() === "tool");
    expect(toolMessages).toHaveLength(0);
  });

  it("the orchestrator with the middleware DOES resolve and dispatch `task`", async () => {
    // Given an orchestrator built with createDeepAgent (which attaches the
    //   subagent middleware) and a worker that replies with a sentinel.
    const orchestrator = fakeModel()
      .respondWithTools([{ name: "task", args: { description: "do-it", subagent_type: "w" } }])
      .respond(new AIMessage("orchestrator-done"));
    const agent = createDeepAgent({
      model: orchestrator,
      subagents: [{ name: "w", description: "w", model: fakeModel().respond(new AIMessage("WORKER-SENTINEL")) }],
      // Runtime option forwarded to the subagent middleware; not in deepagents'
      // exported param type, so attached as an extra key.
      ...({ generalPurposeAgent: false } as { generalPurposeAgent: boolean }),
    });

    // When it runs.
    const result = await agent.invoke({ messages: [{ role: "user", content: "go" }] });

    // Then the dispatch resolved: the worker's result returns as a ToolMessage.
    //   This is the control that proves the previous test's negative is caused
    //   by the missing tool, not by the scripted model.
    const toolMessage = result.messages.find((m) => m.getType() === "tool");
    expect(toolMessage?.content).toContain("WORKER-SENTINEL");
  });
});
