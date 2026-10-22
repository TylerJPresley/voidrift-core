/**
 * End-to-end engine test for the chat direct-write lane (core-blueprint.md §3.1).
 *
 * A scripted model attempts 10 direct `write_file` calls in ONE turn under the
 * built-in `chat` agent (a lane-limited orchestrator: write tools + delegate).
 * The harness writes the first 8, then BLOCKS the 9th and 10th with the delegate
 * guidance (nothing executed, no approval prompt) — the mechanical bound the
 * blueprint requires. Deterministic and offline.
 *
 * NOTE on "then the model calls task": the Engine now binds a model-callable
 * `task` tool to a delegating orchestrator (the built-in `chat` qualifies), but
 * this scripted model emits only `write_file` calls, so the delegate leg is not
 * driven here. The "then delegate via task" behaviour (the `task` tool is never
 * lane-blocked) is pinned in decision-point.lane.test.ts, and the model-driven
 * `task` dispatch end to end lives in engine-task-dispatch.test.ts. The headless
 * `--enable-write` path uses `vibe`, which holds NO direct write tools and is
 * never lane-limited, so this engine/facade test is the natural home for the
 * block behaviour (as the task brief notes).
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import path from "node:path";
import fs from "node:fs/promises";
import { createCore } from "../boot.js";
import { InMemoryConfigStore } from "../adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "../adapters/repositories/session-repository.js";
import type { ResolvedModel } from "../entities/ports/model-port.js";
import type { ModelConfigEntry } from "../config/schema.js";
import { seededPermissionsRecord } from "../test-support/seed-rules.js";

const seed = {
  models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "t",
  permissions: seededPermissionsRecord(),
};

function factory(script: () => ReturnType<typeof fakeModel>) {
  return (_r: ResolvedModel, _e: ModelConfigEntry) => script();
}

const tracked: { session: { shutdown: () => Promise<void> } }[] = [];
async function trackedCreateCore(opts: Parameters<typeof createCore>[0]): ReturnType<typeof createCore> {
  const ready = await createCore(opts);
  tracked.push(ready.api);
  return ready;
}

describe("chat direct-write lane — engine e2e (§3.1)", () => {
  let ws: string;
  beforeEach(async () => {
    ws = hermeticTmp("lane-e2e");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
  });
  afterEach(async () => {
    for (const c of tracked) await c.session.shutdown().catch(() => undefined);
    tracked.length = 0;
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("writes some but not all of 10 write_file calls in one turn and blocks the rest with delegate guidance", async () => {
    // Ten write_file calls in ONE assistant message, then a final message. The
    // lane reserves a slot per call as the harness runs them; once the per-turn
    // bound is reached the remaining calls are blocked with the delegate
    // guidance. The EXACT cutoff (8th allowed / 9th blocked) is pinned
    // deterministically in decision-point.lane.test.ts; this e2e proves the
    // wiring: the lane engages end-to-end, blocks real writes, and emits the
    // event. (The single-agent Engine binds no `task` tool, so the "then call
    // task" leg lives in the decision-point test; see the file header.)
    const tools = Array.from({ length: 10 }, (_, i) => ({ name: "write_file", args: { path: `f${i}.txt`, content: `v${i}` } }));
    const script = () => fakeModel().respondWithTools(tools).respond(new AIMessage("done"));

    const { api } = await trackedCreateCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
      // Auto-approve every write (chat is `unlisted: ask`). A lane BLOCK happens
      // BEFORE this prompt, so a blocked call never reaches it.
      onApproval: async (req) => ({ requestId: req.id, decision: "approve" as const }),
    });

    const laneEvents: { which: string; counts: Record<string, number> }[] = [];
    api.events.subscribe("LANE_LIMIT_REACHED", (e) => laneEvents.push(e.payload as { which: string; counts: Record<string, number> }));

    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "write ten files", approvalMode: "interactive" });
    expect(res.ok).toBe(true);

    // Some writes landed; some were blocked (strictly fewer than all 10).
    const written = (await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        fs.readFile(path.join(ws, `f${i}.txt`), "utf8").then(() => true).catch(() => false),
      ),
    )).filter(Boolean).length;
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(10);
    // No more than the per-turn write-call cap was written.
    expect(written).toBeLessThanOrEqual(8);
    // The lane engaged: exactly one event for the turn, naming a crossed limit.
    expect(laneEvents.length).toBe(1);
    expect(["writeCalls", "distinctTargets", "contextShare"]).toContain(laneEvents[0]!.which);
  });

  it("resets the lane each turn: a fresh turn blocks again rather than starting already-exhausted", async () => {
    // Two turns, each attempting 10 write_file calls in one message to NEW paths.
    // Each turn emits its own LANE_LIMIT_REACHED (the counter reset at turn start
    // — were it not reset, turn 2 would block everything with no fresh writes).
    const turnTools = (t: number) => Array.from({ length: 10 }, (_, i) => ({ name: "write_file", args: { path: `t${t}-f${i}.txt`, content: "x" } }));
    const script = () =>
      fakeModel()
        .respondWithTools(turnTools(0))
        .respond(new AIMessage("turn 0 done"))
        .respondWithTools(turnTools(1))
        .respond(new AIMessage("turn 1 done"));
    const { api } = await trackedCreateCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
      onApproval: async (req) => ({ requestId: req.id, decision: "approve" as const }),
    });
    const perTurnEvents: number[] = [0, 0];
    api.events.subscribe("LANE_LIMIT_REACHED", () => {
      // Tag to whichever turn is currently running via the files on disk is
      // awkward; instead count total and assert one-per-turn below.
      perTurnEvents[0] = perTurnEvents[0]! + 1;
    });
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";

    await api.session.send(id, { input: "turn 0", approvalMode: "interactive" });
    await api.session.send(id, { input: "turn 1", approvalMode: "interactive" });

    // Turn 2 wrote at least one NEW file — proof the counter was reset (an
    // un-reset counter would have been exhausted and blocked every turn-2 write).
    const turn1Written = (await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        fs.readFile(path.join(ws, `t1-f${i}.txt`), "utf8").then(() => true).catch(() => false),
      ),
    )).filter(Boolean).length;
    expect(turn1Written).toBeGreaterThan(0);
    // One LANE_LIMIT_REACHED per turn (reset re-arms the one-per-turn event).
    expect(perTurnEvents[0]).toBe(2);
  });
});
