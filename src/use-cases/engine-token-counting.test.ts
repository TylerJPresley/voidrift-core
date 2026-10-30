/**
 * Pre-send token counting at the engine seam (core-blueprint.md §4.8, §4.10,
 * §11.7). Deterministic and offline: a `fakeModel`/scripted model reports usage
 * so the measured chars/token ratio rebases; a `countTokens` SPY stands in for
 * the network edge (the real network path is covered by count-tokens.test.ts).
 *
 * Covers: the ratio updates from reported usage and changes the next estimate; an
 * estimate far from any threshold makes ZERO count calls; an estimate inside the
 * band calls the endpoint and the EXACT count decides refuse; a null (404-like)
 * probe marks the endpoint unsupported for the session (one call only), and the
 * ratio then drives the decision; and `CONTEXT_OVERFLOW` carries `source`.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import path from "node:path";
import fs from "node:fs/promises";
import { seededPermissionsRecord } from "../test-support/seed-rules.js";

const seed = {
  models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "t",
  permissions: seededPermissionsRecord(),
};

/** A `fakeModel` whose reply carries scripted `usage_metadata` so the engine
 * measures a chars/token ratio from the request chars / input_tokens. */
function usageModel(inputTokens: number): unknown {
  const msg = new AIMessage("done");
  (msg as { usage_metadata?: unknown }).usage_metadata = { input_tokens: inputTokens, output_tokens: 3, total_tokens: inputTokens + 3 };
  return fakeModel().respond(msg);
}

/** A model that FAILS the test if invoked — proves nothing is sent on overflow. */
class NeverCalled extends FakeListChatModel {
  invoked = false;
  constructor() {
    super({ responses: ["nope"] });
  }
  override bindTools(): this {
    return this;
  }
  override async _generate(...a: Parameters<FakeListChatModel["_generate"]>): ReturnType<FakeListChatModel["_generate"]> {
    this.invoked = true;
    return super._generate(...a);
  }
}

async function engineWith(opts: {
  model: unknown;
  id: string;
  window: number;
  maxOut: number | null;
  countTokens?: (messages: BaseMessage[], tools: { name: string }[]) => Promise<number | null>;
}) {
  const { EventBus } = await import("../entities/event-bus.js");
  const { Guardian, builtinGuardrails } = await import("../entities/guardian.js");
  const { Warden } = await import("../entities/warden.js");
  const { ToolRegistry } = await import("../entities/tool-registry.js");
  const { builtinToolDefinitions } = await import("../tools/builtin.js");
  const { ConfigSchema } = await import("../config/schema.js");
  const { Engine } = await import("./engine.js");
  const { Session } = await import("../entities/session.js");
  const bus = new EventBus();
  const registry = new ToolRegistry();
  for (const t of builtinToolDefinitions()) registry.register(t.def, t.exec);
  const config = ConfigSchema.parse(seed);
  const ws = hermeticTmp("engtok");
  await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
  const engine = new Engine({
    chatModel: opts.model as never,
    modelName: "t",
    ...(opts.countTokens ? { countTokens: opts.countTokens } : {}),
    registry,
    guardian: new Guardian(builtinGuardrails()),
    warden: new Warden({ mode: "off" }),
    checkpointer: (await import("../adapters/checkpointer.js")).createMemoryCheckpointer() as never,
    bus,
    getConfig: () => config,
    workspaceRoot: ws,
    tempDir: "/nonexistent-temp",
    window: opts.window,
    maxOutputTokens: opts.maxOut,
    modelId: "t",
    protocol: "openai",
  });
  const session = new Session({
    id: opts.id, name: "n", summary: "", workspace: ws,
    startedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
    turnCount: 0, sizeBytes: 0, namePinned: false,
  });
  return { engine, session, bus, ws };
}

describe("pre-send token counting (§4.8, §4.10, §11.7)", () => {
  let wss: string[] = [];
  beforeEach(() => {
    wss = [];
  });
  afterEach(async () => {
    for (const ws of wss) await fs.rm(ws, { recursive: true, force: true });
  });

  it("the measured ratio rebases from reported usage and changes the next estimate", async () => {
    // input_tokens is HALF the request chars/4 → ratio ~2 → next estimate doubles.
    const { engine, session, ws } = await engineWith({ model: usageModel(50), id: "ratio001", window: 32_000, maxOut: 1000 });
    wss.push(ws);
    const pipeline = engine.pipeline(session);
    const before = pipeline.effectiveRatio("t");
    expect(before).toEqual({ ratio: 4, hasMeasured: false });
    const res = await engine.runTurn(session, "please do some work ".repeat(20));
    expect(res.status).toBe("completed");
    // The ratio was measured against model "t" and persisted.
    const after = pipeline.effectiveRatio("t");
    expect(after.hasMeasured).toBe(true);
    expect(after.ratio).toBeGreaterThanOrEqual(1.5);
    expect(after.ratio).toBeLessThanOrEqual(8);
    expect(session.metadata.usageRatio).toBe(after.ratio);
    // A model switch (different id) drops it — the ratio is per selected model.
    expect(pipeline.effectiveRatio("other")).toEqual({ ratio: 4, hasMeasured: false });
  });

  it("an estimate far from any threshold makes ZERO countTokens calls", async () => {
    let calls = 0;
    const { engine, session, ws } = await engineWith({
      model: fakeModel().respond(new AIMessage("ok")),
      id: "far00001",
      window: 1_000_000, // a huge window: a short request is nowhere near a threshold
      maxOut: 1000,
      countTokens: async () => {
        calls += 1;
        return 10;
      },
    });
    wss.push(ws);
    const res = await engine.runTurn(session, "hi");
    expect(res.status).toBe("completed");
    expect(calls).toBe(0);
  });

  it("an estimate inside the band calls the endpoint and the EXACT count decides the refusal (source endpoint)", async () => {
    let calls = 0;
    const never = new NeverCalled();
    // Tiny window so the estimate sits within estimateMarginTokens of the hard
    // stop; the exact count (huge) forces the refusal.
    const { engine, session, bus, ws } = await engineWith({
      model: never,
      id: "band0001",
      window: 2_100,
      maxOut: 100,
      countTokens: async () => {
        calls += 1;
        return 5_000; // exact count far over the window → refuse
      },
    });
    wss.push(ws);
    const overflows: { source?: string; estimatedInput?: number }[] = [];
    bus.subscribe("CONTEXT_OVERFLOW", (e) => overflows.push(e.payload as { source?: string }));
    const res = await engine.runTurn(session, "a short-ish instruction near the band");
    expect(res.status).toBe("failed");
    expect(never.invoked).toBe(false);
    expect(calls).toBe(1);
    expect(overflows[0]?.source).toBe("endpoint");
  });

  it("the exact count INCLUDES the bound tool schemas: with tools it crosses the limit, without it would not (§4.8)", async () => {
    // The engine must forward the bound tool definitions to countTokens so the
    // exact count matches the assembled request. The spy returns an over-limit
    // count ONLY when tools are present; an empty tools array would stay under.
    let seenTools: { name: string }[] | undefined;
    const never = new NeverCalled();
    const { engine, session, bus, ws } = await engineWith({
      model: never,
      id: "bndtool1",
      window: 2_100,
      maxOut: 100,
      countTokens: async (_messages, tools) => {
        seenTools = tools;
        // WITH tools → over the window (refuse); WITHOUT → comfortably under.
        return tools.length > 0 ? 5_000 : 10;
      },
    });
    wss.push(ws);
    const overflows: { source?: string }[] = [];
    bus.subscribe("CONTEXT_OVERFLOW", (e) => overflows.push(e.payload as { source?: string }));
    const res = await engine.runTurn(session, "a short-ish instruction near the band");
    expect(res.status).toBe("failed");
    expect(never.invoked).toBe(false);
    // The engine passed the registry's bound tools (builtin suite is non-empty).
    expect(seenTools && seenTools.length).toBeGreaterThan(0);
    expect(seenTools?.some((t) => t.name === "read_file")).toBe(true);
    expect(overflows[0]?.source).toBe("endpoint");
  });

  it("a null (404-like) probe marks the endpoint unsupported: one call only, then the ratio drives it", async () => {
    let calls = 0;
    const never = new NeverCalled();
    const { engine, session, bus, ws } = await engineWith({
      model: never,
      id: "unsup001",
      window: 2_100, // the same in-band window as the exact-count test: the probe fires
      maxOut: 100,
      countTokens: async () => {
        calls += 1;
        return null; // 404/unsupported shape
      },
    });
    wss.push(ws);
    const warnings: { source?: string; message?: string }[] = [];
    const overflows: { source?: string }[] = [];
    bus.subscribe("WARNING_EMITTED", (e) => warnings.push(e.payload as { source?: string; message?: string }));
    bus.subscribe("CONTEXT_OVERFLOW", (e) => overflows.push(e.payload as { source?: string }));
    // First turn: probes (one call), null → unsupported; the ratio estimate drives
    // the refusal (default 4 before any measurement).
    const r1 = await engine.runTurn(session, "a short-ish instruction near the band");
    expect(r1.status).toBe("failed");
    // Second turn: already unsupported → NO second probe.
    const r2 = await engine.runTurn(session, "a short-ish instruction near the band");
    expect(r2.status).toBe("failed");
    expect(calls).toBe(1); // one probe for the whole session
    const ctWarnings = warnings.filter((w) => w.source === "count-tokens");
    expect(ctWarnings).toHaveLength(1);
    // §14.6 — every WARNING_EMITTED carries a one-sentence human message.
    expect(typeof ctWarnings[0]?.message).toBe("string");
    expect(ctWarnings[0]?.message).toMatch(/exact token counting/i);
    // The refusal rested on the default ratio (no measurement happened), not the endpoint.
    expect(overflows[0]?.source).toBe("default");
    expect(never.invoked).toBe(false);
  });

  it("CONTEXT_OVERFLOW carries source `default` before any measurement (hard stop)", async () => {
    const never = new NeverCalled();
    const { engine, session, bus, ws } = await engineWith({ model: never, id: "src00001", window: 50, maxOut: 40 });
    wss.push(ws);
    const overflows: { source?: string }[] = [];
    bus.subscribe("CONTEXT_OVERFLOW", (e) => overflows.push(e.payload as { source?: string }));
    const res = await engine.runTurn(session, "x ".repeat(400));
    expect(res.status).toBe("failed");
    expect(never.invoked).toBe(false);
    expect(overflows[0]?.source).toBe("default");
  });

  it("near the compaction threshold the EXACT count (not only the hard stop) drives the crossing on a fresh session (§4.8)", async () => {
    // A fresh session has no provider/anchor count, so the compaction/safety-net
    // crossing rests on the pre-flight estimate — UNLESS an exact endpoint count
    // was taken in the band, which stands in "for that one decision" (§4.8). A
    // large input places the estimate within estimateMarginTokens of the 40%
    // compaction trigger without tripping the hard stop; the two runs differ
    // ONLY in the exact count the spy returns.
    const input = "x ".repeat(23_000); // ~46k chars → estimate ~13.5k, in the band
    const run = async (id: string, exact: number) => {
      const { engine, session, bus, ws } = await engineWith({
        model: usageModel(exact), // the reply reports usage so nothing else moves the meter
        id,
        window: 40_000,
        maxOut: 2_000,
        countTokens: async () => exact,
      });
      wss.push(ws);
      const crossed: string[] = [];
      bus.subscribe("CONTEXT_THRESHOLD_CROSSED", (e) => crossed.push((e.payload as { level: string }).level));
      const res = await engine.runTurn(session, input);
      expect(res.status).toBe("completed");
      return crossed;
    };
    // Exact count well below 40% of the working budget → NO compaction crossing.
    const low = await run("compLow0", 5_000);
    expect(low).not.toContain("compaction");
    // Exact count above 40% of the working budget → the compaction crossing fires.
    const high = await run("compHigh", 20_000);
    expect(high).toContain("compaction");
  });
});
