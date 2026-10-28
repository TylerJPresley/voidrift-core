/**
 * Substrate tripwire — core-blueprint.md §1 assumption 5.
 *
 * `interrupt` and `Command({ resume })` suspend and resume a paused run across
 * processes through the checkpointer (§5.7, §9.5).
 *
 * Pins the EXACT installed @langchain/langgraph + @langchain/langgraph-
 * checkpoint-sqlite behavior. A second "process" is simulated by constructing a
 * fresh graph and a fresh SqliteSaver over the SAME on-disk db file, closing the
 * first saver's db handle first — proving the paused state lives on disk, not in
 * process memory.
 *
 * Offline/deterministic: temp-file SQLite DB under os.tmpdir(), cleaned up; no
 * network, no model.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateGraph, START, END, interrupt, Command } from "@langchain/langgraph";
import { NodeSqliteSaver } from "../adapters/node-sqlite-saver.js";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";

const State = z.object({ value: z.string().default("") });

function buildGraph(saver: NodeSqliteSaver) {
  return new StateGraph(State)
    .addNode("ask", () => {
      const answer = interrupt("need-approval");
      return { value: `resumed-with:${answer}` };
    })
    .addEdge(START, "ask")
    .addEdge("ask", END)
    .compile({ checkpointer: saver });
}

describe("substrate §1.5 — interrupt/resume survives across processes via the checkpointer", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = hermeticTmp("substrate-cp");
    dbPath = path.join(dir, "checkpoint.db");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("suspends in one process and resumes in a fresh process over the same db file", async () => {
    const config = { configurable: { thread_id: "t1" } };

    // Given a run in "process A" that interrupts and persists to the db file.
    const saverA = NodeSqliteSaver.fromPath(dbPath);
    const graphA = buildGraph(saverA);
    const first = await graphA.invoke({ value: "" }, config);

    // Then the run is suspended at the interrupt (not completed).
    const interrupts = (first as { __interrupt__?: { value: unknown }[] }).__interrupt__;
    expect(interrupts).toBeDefined();
    expect(interrupts![0]!.value).toBe("need-approval");
    expect((first as { value?: string }).value).toBe("");

    // Simulate the process boundary: close A's db handle entirely.
    saverA.close();

    // When "process B" — a fresh saver + fresh graph over the SAME db file —
    //   resumes with Command({ resume }).
    const saverB = NodeSqliteSaver.fromPath(dbPath);
    const graphB = buildGraph(saverB);
    const resumed = await graphB.invoke(new Command({ resume: "APPROVED" }), config);

    // Then the paused run resumes to completion using the on-disk checkpoint.
    expect((resumed as { value?: string }).value).toBe("resumed-with:APPROVED");

    saverB.close();
  });
});
