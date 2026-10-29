/**
 * The task limits conversion (§13.11): the `task` tool reads briefMaxChars,
 * batchMax, depSummaryMaxChars and batchResultMaxChars from the registry via the
 * injected LimitsPort. For each: the default equals today's value, a config
 * override changes behaviour, and the key-naming marker + one LIMIT_HIT appear
 * exactly when the limit bites.
 */
import { describe, it, expect, vi } from "vitest";
import type { ToolMessage } from "@langchain/core/messages";
import { buildTaskTool, validateBatch, type DispatchableWorker } from "./task-tool.js";
import { EventBus } from "../entities/event-bus.js";
import { resolveLimits } from "../entities/limits-resolve.js";
import { LimitsCapability } from "../use-cases/limits-capability.js";
import { limitDefault } from "../entities/limits.js";
import type { FanoutResult } from "../use-cases/subagents.js";

const workers: DispatchableWorker[] = [{ name: "researcher", description: "read-only" }];

function fanout(status: FanoutResult["workers"][number]["status"], summary: string): FanoutResult {
  return { fanoutId: "f1", workers: [{ workerId: "w1", agent: "researcher", status, summary, pendingApproval: false }] };
}

async function invoke(t: ReturnType<typeof buildTaskTool>, args: unknown): Promise<ToolMessage> {
  const res = await t.invoke(args as never, { toolCall: { id: "c1", name: "task", args } } as never);
  return res as unknown as ToolMessage;
}

function limitsWith(overrides?: Record<string, unknown>): { limits: LimitsCapability; hits: { key: string; value: number }[] } {
  const bus = new EventBus();
  const hits: { key: string; value: number }[] = [];
  bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string; value: number }));
  const layers = overrides ? [{ layer: "project" as const, limits: overrides }] : [];
  return { limits: new LimitsCapability(resolveLimits(layers), bus), hits };
}

describe("task tool — brief limit (task.briefMaxChars, TASK1)", () => {
  it("default equals today's value (16384) and no marker when it fits", async () => {
    expect(limitDefault("task.briefMaxChars")).toBe(16_384);
    const { limits, hits } = limitsWith();
    const dispatch = vi.fn(async () => fanout("merged", "ok"));
    const t = buildTaskTool({ workers, dispatch, limits });
    await invoke(t, { worker: "researcher", task: "short" });
    const callArgs = dispatch.mock.calls[0];
    const reqs = (callArgs && callArgs.length > 0 ? (callArgs as unknown[])[0] : undefined) as Array<{ task: string }> | undefined;
    expect(reqs?.[0]?.task).toBe("short");
    expect(hits.length).toBe(0);
  });

  it("a config override changes behaviour and clips with a key-naming marker + one LIMIT_HIT", async () => {
    const { limits, hits } = limitsWith({ task: { briefMaxChars: 20 } });
    const dispatch = vi.fn(async () => fanout("merged", "ok"));
    const t = buildTaskTool({ workers, dispatch, limits });
    await invoke(t, { worker: "researcher", task: "x".repeat(200) });
    const callArgs = dispatch.mock.calls[0];
    const reqs = (callArgs && callArgs.length > 0 ? (callArgs as unknown[])[0] : undefined) as Array<{ task: string }> | undefined;
    expect(reqs?.[0]?.task).toContain("[truncated at limits.task.briefMaxChars");
    expect(reqs?.[0]?.task.length).toBeLessThan(200);
    expect(hits.filter((h) => h.key === "task.briefMaxChars").length).toBe(1);
  });
});

describe("task tool — batch cap (task.batchMax, TASK2)", () => {
  it("default equals 8 and validateBatch passes a valid batch", () => {
    expect(limitDefault("task.batchMax")).toBe(8);
    const tasks = Array.from({ length: 3 }, (_, i) => ({ id: `t${i}`, worker: "researcher", task: "x" }));
    const valid = new Set(["researcher"]);
    expect(validateBatch(tasks, valid)).toBeNull();
  });

  it("warn (the default action): an over-cap batch is ACCEPTED in full with one LIMIT_HIT", async () => {
    const { limits, hits } = limitsWith({ task: { batchMax: 1 } });
    const dispatch = vi.fn(async () => ({ fanoutId: "f", workers: [] }) as unknown as FanoutResult);
    const t = buildTaskTool({ workers, dispatch, limits });
    await invoke(t, { tasks: [
      { id: "a", worker: "researcher", task: "x" },
      { id: "b", worker: "researcher", task: "y" },
    ] });
    // Accepted in full: both tasks dispatched in ONE fan-out.
    expect(dispatch).toHaveBeenCalledTimes(1);
    const reqs = (dispatch.mock.calls[0] as unknown[])[0] as Array<{ id: string }>;
    expect(reqs.map((r) => r.id)).toEqual(["a", "b"]);
    expect(hits.filter((h) => h.key === "task.batchMax").length).toBe(1);
  });

  it("deny (a configured action): an over-cap batch is REFUSED with the same notice, no dispatch", async () => {
    const { limits, hits } = limitsWith({ task: { batchMax: { value: 1, action: "deny" } } });
    const dispatch = vi.fn(async () => ({ fanoutId: "f", workers: [] }) as unknown as FanoutResult);
    const t = buildTaskTool({ workers, dispatch, limits });
    const msg = await invoke(t, { tasks: [
      { id: "a", worker: "researcher", task: "x" },
      { id: "b", worker: "researcher", task: "y" },
    ] });
    expect(dispatch).not.toHaveBeenCalled();
    expect(String(msg.content)).toContain("limits.task.batchMax");
    expect(hits.filter((h) => h.key === "task.batchMax").length).toBe(1);
  });
});

describe("task tool — batch result cap (task.batchResultMaxChars, TASK4)", () => {
  it("default equals 4000", () => {
    expect(limitDefault("task.batchResultMaxChars")).toBe(4000);
  });

  it("an override clips the per-worker result with a marker and emits one LIMIT_HIT", async () => {
    const { limits, hits } = limitsWith({ task: { batchResultMaxChars: 10 } });
    const dispatch = vi.fn(async () => ({
      fanoutId: "f",
      workers: [{ workerId: "w1", agent: "researcher", status: "merged", summary: "z".repeat(100), pendingApproval: false, taskId: "a" }],
    }) as unknown as FanoutResult);
    const t = buildTaskTool({ workers, dispatch, limits });
    const msg = await invoke(t, { tasks: [{ id: "a", worker: "researcher", task: "do" }] });
    expect(String(msg.content)).toContain("[truncated at limits.task.batchResultMaxChars");
    expect(hits.filter((h) => h.key === "task.batchResultMaxChars").length).toBe(1);
  });
});
