/**
 * Substrate tripwire — core-blueprint.md §1 assumption 6.
 *
 * `durability: "exit"` writes no checkpoint for an aborted run, so a cancelled
 * turn leaves no partial state (§3.3, §5.2).
 *
 * Pins the EXACT installed @langchain/langgraph durability behavior against a
 * real SqliteSaver. Confirmed semantics for the installed versions: with
 * `durability: "exit"` a run that aborts in its first/only node leaves the
 * thread at its pre-run baseline — no checkpoint captures the aborted node's
 * in-flight mutations. The `async` default, by contrast, persists mid-run
 * checkpoints. The tripwire asserts both the absence of partial state under
 * `exit` AND that `exit` persists strictly fewer checkpoints than `async`.
 *
 * Offline/deterministic: temp-file SQLite DB under os.tmpdir(), cleaned up; no
 * network, no model.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateGraph, START, END } from "@langchain/langgraph";
import { NodeSqliteSaver } from "../adapters/node-sqlite-saver.js";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";

// Mirrors @langchain/langgraph's `Durability` union (exported only from the
// internal `pregel/types` path, not the package root).
type Durability = "exit" | "async" | "sync";

const State = z.object({ n: z.number().default(0) });

/** Run a single-node graph that always aborts; return the persisted checkpoints. */
async function runAbort(dbPath: string, durability: Durability) {
  const saver = NodeSqliteSaver.fromPath(dbPath);
  const graph = new StateGraph(State)
    .addNode("only", (): { n: number } => {
      throw new Error("aborted-mid-node");
    })
    .addEdge(START, "only")
    .addEdge("only", END)
    .compile({ checkpointer: saver });

  const config = { configurable: { thread_id: "t" }, durability };
  await expect(graph.invoke({ n: 7 }, config)).rejects.toThrow("aborted-mid-node");

  const checkpoints = [];
  for await (const tuple of saver.list({ configurable: { thread_id: "t" } })) {
    checkpoints.push(tuple);
  }
  const snapshot = await graph.getState({ configurable: { thread_id: "t" } });
  saver.close();
  return { checkpoints, snapshot };
}

describe("substrate §1.6 — durability:exit leaves no partial state for an aborted run", () => {
  let dir: string;

  beforeEach(async () => {
    dir = hermeticTmp("substrate-dur");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes no checkpoint capturing the aborted node's work", async () => {
    // Given a run that aborts inside its only node under durability:"exit".
    const { checkpoints, snapshot } = await runAbort(path.join(dir, "exit.db"), "exit");

    // Then no persisted checkpoint reflects a value the aborted node produced:
    //   the thread stays at its pre-run baseline and never advances past "only".
    for (const tuple of checkpoints) {
      expect(tuple.metadata?.source).not.toBe("update");
      expect(tuple.metadata?.step ?? -1).toBeLessThanOrEqual(0);
    }
    expect(snapshot.next).toEqual(["only"]); // the aborted node is still pending, not done
  });

  it("persists strictly fewer checkpoints than the async default", async () => {
    // Given the same aborting run under each durability mode.
    const exitRun = await runAbort(path.join(dir, "exit2.db"), "exit");
    const asyncRun = await runAbort(path.join(dir, "async.db"), "async");

    // Then "exit" writes fewer checkpoints than "async" — it defers all
    //   persistence to graph exit, so an aborted run leaves minimal state.
    expect(exitRun.checkpoints.length).toBeLessThan(asyncRun.checkpoints.length);
  });
});
