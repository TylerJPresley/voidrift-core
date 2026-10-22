/**
 * Pass-by-reference for the `task` tool (core-blueprint.md §7.2, §8.7, §14.6):
 * an oversized brief reaches the worker with a `[brief continues: … at <handle>]`
 * footer (not a silent clip) and the full text round-trips through the run cache;
 * an oversized per-task batch result returns a bounded head + `[full result:
 * <handle>]`; a BY_REFERENCE event reaches a subscriber naming {what, bytes, key};
 * secrets in stored text are masked; limits overrides change the inline sizes.
 */
import { describe, it, expect, vi } from "vitest";
import type { ToolMessage } from "@langchain/core/messages";
import { buildTaskTool, type DispatchableWorker } from "./task-tool.js";
import { EventBus } from "../entities/event-bus.js";
import { resolveLimits } from "../entities/limits-resolve.js";
import { LimitsCapability } from "../use-cases/limits-capability.js";
import { InMemoryRunCache } from "../adapters/run-cache.js";
import type { FanoutResult } from "../use-cases/subagents.js";

const workers: DispatchableWorker[] = [{ name: "researcher", description: "read-only" }];

function single(status: FanoutResult["workers"][number]["status"], summary: string): FanoutResult {
  return { fanoutId: "f1", workers: [{ workerId: "w1", agent: "researcher", status, summary, pendingApproval: false }] };
}
function batch(summary: string): FanoutResult {
  return { fanoutId: "f1", workers: [{ workerId: "w1", agent: "researcher", status: "merged", summary, pendingApproval: false, taskId: "a" }] };
}

async function invoke(t: ReturnType<typeof buildTaskTool>, args: unknown): Promise<ToolMessage> {
  return (await t.invoke(args as never, { toolCall: { id: "c1", name: "task", args } } as never)) as unknown as ToolMessage;
}

function wire(overrides?: Record<string, unknown>): {
  limits: LimitsCapability;
  bus: EventBus;
  runCache: InMemoryRunCache;
  byRef: { what: string; bytes: number; key: string }[];
} {
  const bus = new EventBus();
  const byRef: { what: string; bytes: number; key: string }[] = [];
  bus.subscribe("BY_REFERENCE", (e) => byRef.push(e.payload as { what: string; bytes: number; key: string }));
  const layers = overrides ? [{ layer: "project" as const, limits: overrides }] : [];
  const runCache = new InMemoryRunCache({ sessionId: "s1" });
  return { limits: new LimitsCapability(resolveLimits(layers), bus), bus, runCache, byRef };
}

describe("task tool — brief pass-by-reference (§7.2)", () => {
  it("a 20k-char brief reaches the worker with a handle footer and the full text round-trips", async () => {
    const { limits, bus, runCache, byRef } = wire();
    const dispatch = vi.fn(async () => single("merged", "ok"));
    const t = buildTaskTool({ workers, dispatch, limits, bus, runCache, sessionId: "s1" });
    const brief = "Q".repeat(20_000);
    await invoke(t, { worker: "researcher", task: brief });
    const sent = (dispatch.mock.calls[0]![0] as { task: string }[])[0]!.task;
    expect(sent).toMatch(/\[brief continues: \d+ bytes at \.voidrift\/cache\/run\/s1\/.+\.txt — read it with read_file\]/);
    expect(sent).not.toContain("[truncated");
    const handle = sent.match(/at (\.voidrift\/cache\/run\/\S+\.txt)/)![1]!;
    expect(runCache.read(handle)).toBe(brief);
    expect(byRef).toContainEqual(expect.objectContaining({ what: "task brief", key: "task.briefMaxChars" }));
  });

  it("without a run cache it falls back to the inline truncation marker", async () => {
    const { limits } = wire({ task: { briefMaxChars: 20 } });
    const dispatch = vi.fn(async () => single("merged", "ok"));
    const t = buildTaskTool({ workers, dispatch, limits });
    await invoke(t, { worker: "researcher", task: "x".repeat(200) });
    const sent = (dispatch.mock.calls[0]![0] as { task: string }[])[0]!.task;
    expect(sent).toContain("[truncated at limits.task.briefMaxChars");
  });
});

describe("task tool — batch result pass-by-reference (§7.2)", () => {
  it("a 40k-char result returns a head + full-result handle and read_file returns the full text", async () => {
    const { limits, bus, runCache, byRef } = wire();
    const full = "R".repeat(40_000);
    const dispatch = vi.fn(async () => batch(full));
    const t = buildTaskTool({ workers, dispatch, limits, bus, runCache, sessionId: "s1" });
    const msg = await invoke(t, { tasks: [{ id: "a", worker: "researcher", task: "do" }] });
    const content = String(msg.content);
    expect(content).toMatch(/\[full result: \.voidrift\/cache\/run\/s1\/.+\.txt\]/);
    expect(content).not.toContain("[truncated");
    const handle = content.match(/\[full result: (\.voidrift\/cache\/run\/\S+\.txt)\]/)![1]!;
    expect(runCache.read(handle)).toBe(full);
    expect(byRef).toContainEqual(expect.objectContaining({ what: 'batch result for "a"', key: "task.batchResultMaxChars" }));
  });

  it("an override changes the inline head size", async () => {
    const { limits, bus, runCache } = wire({ task: { batchResultMaxChars: 10 } });
    const dispatch = vi.fn(async () => batch("z".repeat(100)));
    const t = buildTaskTool({ workers, dispatch, limits, bus, runCache, sessionId: "s1" });
    const msg = await invoke(t, { tasks: [{ id: "a", worker: "researcher", task: "do" }] });
    expect(String(msg.content)).toContain("[full result:");
  });
});

describe("task tool — secrets in stored text are masked (§10.10)", () => {
  it("masks a secret in the stored brief so the cached copy carries no raw value", async () => {
    const { limits, bus, runCache } = wire();
    const dispatch = vi.fn(async () => single("merged", "ok"));
    const t = buildTaskTool({ workers, dispatch, limits, bus, runCache, sessionId: "s1" });
    const secret = "ghp_" + "a".repeat(36);
    const brief = "x".repeat(20_000) + "\ntoken " + secret;
    await invoke(t, { worker: "researcher", task: brief });
    const sent = (dispatch.mock.calls[0]![0] as { task: string }[])[0]!.task;
    const handle = sent.match(/at (\.voidrift\/cache\/run\/\S+\.txt)/)![1]!;
    const stored = runCache.read(handle)!;
    expect(stored).not.toContain(secret);
    expect(stored).toContain("«redacted:");
  });
});
