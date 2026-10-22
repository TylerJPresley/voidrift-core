/**
 * Decision-point loop-health integration tests (core-blueprint.md §3.4).
 *
 * The ONE decision point drives the per-caller `LoopHealth` counter: on a
 * detection it appends the corrective nudge to the model-facing tool result and
 * emits `WARNING_EMITTED { category: "loop", source }`. An exempt tool (`wait`)
 * never trips. Drives the SAME shared `createDecisionMiddleware` the engine uses.
 */
import { describe, it, expect } from "vitest";
import { ToolMessage } from "@langchain/core/messages";
import { z } from "zod";
import { createDecisionMiddleware, type DecisionPointDeps, type CallerContext, type AskResolver } from "./decision-point.js";
import { ToolRegistry } from "../entities/tool-registry.js";
import { EventBus } from "../entities/event-bus.js";
import { Guardian, builtinGuardrails } from "../entities/guardian.js";
import { Warden } from "../entities/warden.js";
import { ConfigSchema, type Config, type PermissionRule } from "../config/schema.js";
import { LoopHealth } from "../entities/loop-health.js";

const ctx: CallerContext = { sessionId: "s1", approvalMode: "interactive" };
const ALLOW_ALL: PermissionRule[] = [{ tool: "*", decision: "allow", priority: 100, source: "user" }];

function cfg(over: Partial<Config> = {}): Config {
  return ConfigSchema.parse({ ...over });
}

function registryWith(names: string[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const name of names) {
    r.register(
      { name, description: "d", schema: z.object({}).passthrough(), readOnly: name === "read_file" },
      async () => ({ content: "ok", status: "success" }),
    );
  }
  return r;
}

function makeDeps(over: Partial<Config>, loopHealth: LoopHealth, registry: ToolRegistry): { deps: DecisionPointDeps; bus: EventBus } {
  const bus = new EventBus();
  const deps: DecisionPointDeps = {
    guardian: new Guardian(builtinGuardrails()),
    warden: new Warden({ mode: "off" }),
    bus,
    registry,
    getConfig: () => cfg(over),
    tempDir: "/no/such",
    window: 32_000,
    getSessionRules: () => ALLOW_ALL,
    guardrailState: () => ({ readPaths: new Set(["a.txt"]), stalePaths: new Set() }),
    loopHealth: () => loopHealth,
  };
  return { deps, bus };
}

async function run(
  deps: DecisionPointDeps,
  name: string,
  args: Record<string, unknown>,
  status: "success" | "error" = "success",
): Promise<ToolMessage> {
  const mw = createDecisionMiddleware(deps, ctx, (async () => ({ decision: "allow" })) as AskResolver);
  const request = { toolCall: { name, args, id: `${name}-1` } };
  const handler = async (): Promise<ToolMessage> =>
    new ToolMessage({ content: "ok", tool_call_id: `${name}-1`, status });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mw as any).wrapToolCall(request, handler) as Promise<ToolMessage>;
}

describe("§3.4 — the decision point injects the nudge and emits the event", () => {
  it("identical read_file repeats trip a loop warning and the nudge rides the tool result", async () => {
    const registry = registryWith(["read_file"]);
    const lh = new LoopHealth(() => ({
      maxConsecutiveErrors: 3,
      maxIdenticalCalls: 4,
      fingerprintRepeats: 3,
      fingerprintWindow: 20,
    }));
    const { deps, bus } = makeDeps({}, lh, registry);
    const warnings: unknown[] = [];
    bus.subscribe("WARNING_EMITTED", (e) => warnings.push(e.payload));

    const r1 = await run(deps, "read_file", { path: "a.txt" });
    const r2 = await run(deps, "read_file", { path: "a.txt" });
    expect(String(r1.content)).not.toContain("[harness note]");
    expect(String(r2.content)).not.toContain("[harness note]");
    // The 3rd identical read trips the windowed-repeat detector (threshold 3).
    const r3 = await run(deps, "read_file", { path: "a.txt" });
    expect(String(r3.content)).toContain("[harness note]");
    expect(String(r3.content)).toContain("Loop detected");
    expect(warnings).toContainEqual({ category: "loop", source: "fingerprint_repeats" });
  });

  it("consecutive tool errors trip a consecutive_errors warning", async () => {
    const registry = registryWith(["execute_command"]);
    const lh = new LoopHealth(() => ({
      maxConsecutiveErrors: 3,
      maxIdenticalCalls: 99,
      fingerprintRepeats: 99,
      fingerprintWindow: 20,
    }));
    const { deps, bus } = makeDeps({}, lh, registry);
    const warnings: unknown[] = [];
    bus.subscribe("WARNING_EMITTED", (e) => warnings.push(e.payload));
    await run(deps, "execute_command", { command: "false1" }, "error");
    await run(deps, "execute_command", { command: "false2" }, "error");
    const r3 = await run(deps, "execute_command", { command: "false3" }, "error");
    expect(String(r3.content)).toContain("[harness note]");
    expect(warnings).toContainEqual({ category: "loop", source: "consecutive_errors" });
  });

  it("`wait` is exempt — repeated identical waits never trip (§3.4)", async () => {
    const registry = registryWith(["wait"]);
    const lh = new LoopHealth(() => ({
      maxConsecutiveErrors: 3,
      maxIdenticalCalls: 2,
      fingerprintRepeats: 2,
      fingerprintWindow: 20,
    }));
    const { deps, bus } = makeDeps({}, lh, registry);
    const warnings: unknown[] = [];
    bus.subscribe("WARNING_EMITTED", (e) => warnings.push(e.payload));
    for (let i = 0; i < 6; i++) {
      const r = await run(deps, "wait", { check: "true" });
      expect(String(r.content)).not.toContain("[harness note]");
    }
    expect(warnings.filter((w) => (w as { category?: string }).category === "loop")).toHaveLength(0);
  });
});
