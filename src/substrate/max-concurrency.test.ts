/**
 * Substrate tripwire — core-blueprint.md §1 assumption 7.
 *
 * `maxConcurrency` bounds the parallel tool tasks in a step (§3.6, §7.2).
 *
 * VoidRift's `turnMaxConcurrency` maps directly to LangGraph's `maxConcurrency`
 * run option and caps every parallel task in a super-step. This pins the EXACT
 * installed @langchain/langgraph behavior by fanning out N parallel `Send`
 * tasks into one node and instrumenting the peak number running at once.
 *
 * Offline/deterministic: pure in-process graph, no network, no model.
 */
import { describe, it, expect } from "vitest";
import { StateGraph, START, END, Send } from "@langchain/langgraph";
import { z } from "zod";

const FanState = z.object({ items: z.array(z.number()).default(() => []) });

/** Fan `items.length` parallel tasks into one node; return the peak concurrency. */
async function peakConcurrency(itemCount: number, maxConcurrency?: number): Promise<number> {
  let current = 0;
  let peak = 0;

  const graph = new StateGraph(FanState)
    .addNode(
      "worker",
      async (): Promise<Record<string, never>> => {
        current += 1;
        peak = Math.max(peak, current);
        await new Promise((resolve) => setTimeout(resolve, 50));
        current -= 1;
        return {};
      },
      { ends: [END] },
    )
    .addConditionalEdges(START, (state) => state.items.map((i) => new Send("worker", { item: i })), ["worker"])
    .compile();

  const items = Array.from({ length: itemCount }, (_, i) => i);
  await graph.invoke(
    { items },
    maxConcurrency === undefined ? {} : { maxConcurrency },
  );
  return peak;
}

describe("substrate §1.7 — maxConcurrency bounds parallel tasks in a step", () => {
  it("caps the number of tasks running concurrently at the configured limit", async () => {
    // Given six parallel tasks fanned out in one super-step.
    // When maxConcurrency is 2, no more than 2 ever run at once.
    expect(await peakConcurrency(6, 2)).toBe(2);

    // When maxConcurrency is 3, the cap is 3 (a higher explicit bound).
    expect(await peakConcurrency(6, 3)).toBe(3);
  });

  it("runs all tasks concurrently when unbounded — proving the cap is what limits it", async () => {
    // Given the same six parallel tasks with no maxConcurrency.
    // Then all six run at once — the control proving the bound above is the cap,
    //   not an artifact of the graph or scheduler.
    expect(await peakConcurrency(6, undefined)).toBe(6);
  });
});
