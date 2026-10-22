/**
 * FX-A regression (cli §8, core §2.5/§12.3) — a routine run through
 * `session.command("routine", id)` starts a SEPARATE session via
 * `runInNewSession`. That session MUST inherit the host's launch posture: the
 * selected start agent and the approval mode. Before the fix it was born in the
 * default agent with `approvalMode: "interactive"`, so a routine whose prompt
 * asks to write a file reached `waiting_for_approval` (exit 5) with no output —
 * the opposite of a headless run, which NEVER asks.
 *
 * Here the posture is set two ways, both of which must take effect:
 *  - `CoreOptions.startSessionApprovalMode` (construction-time), and
 *  - `api.session.setLaunchDefaults(...)` (the post-boot path the headless CLI
 *    uses once it has picked the start agent from `agents.list()`).
 *
 * Deterministic and offline: a `fakeModel` emits one `write_file` tool call.
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
import { createMemoryCheckpointer } from "../adapters/checkpointer.js";
import { seededPermissionsRecord } from "../test-support/seed-rules.js";
import type { EventEnvelope } from "../entities/event-bus.js";

const seed = {
  models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "t",
  permissions: seededPermissionsRecord(),
};

const tracked: { session: { shutdown: () => Promise<void> } }[] = [];

/** Build a core whose only model emits a single `write_file` tool call, then a
 * closing message — the routine prompt "asks" to write a file. */
async function makeCore(opts: { startAgent?: string; startSessionApprovalMode?: "headless" | "interactive" }, ws: string) {
  const script = () =>
    fakeModel()
      .respondWithTools([{ name: "write_file", args: { path: "routine-out.txt", content: "hi" } }])
      .respond(new AIMessage("routine done"));
  const ready = await createCore({
    workspaceRoot: ws,
    configStore: new InMemoryConfigStore(seed),
    sessionRepository: new InMemorySessionRepository(),
    checkpointer: createMemoryCheckpointer(),
    chatModelFactory: () => script(),
    ...(opts.startAgent ? { startAgent: opts.startAgent } : {}),
    ...(opts.startSessionApprovalMode ? { startSessionApprovalMode: opts.startSessionApprovalMode } : {}),
  });
  tracked.push(ready.api);
  // Seed the two top-level agents a headless run selects between.
  await ready.api.agents.create({ name: "research", description: "r", kind: "top-level", systemPrompt: "r", tools: ["read_file", "write_file"], workers: "all", unlisted: "deny", order: 20 });
  await ready.api.agents.create({ name: "vibe", description: "v", kind: "top-level", systemPrompt: "v", tools: ["read_file", "write_file"], workers: "all", unlisted: "allow", confirm: true, order: 30 });
  // Register the routine command exactly like the routines plugin does.
  ready.api.register.command("writer", "run a routine", async (args: unknown) => {
    const id = typeof args === "string" ? args : "";
    return ready.api.session.runInNewSession(`write a file for ${id}`, { name: `routine:${id}` });
  });
  return ready.api;
}

describe("FX-A — a routine's new session inherits the headless launch posture", () => {
  let ws: string;
  beforeEach(async () => {
    ws = hermeticTmp("routine-posture");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
  });
  afterEach(async () => {
    for (const c of tracked) await c.session.shutdown().catch(() => undefined);
    tracked.length = 0;
    await fs.rm(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("read-only (deny) + headless: the routine completes denied-and-continue, the file is never written, and a posture denial is emitted", async () => {
    const api = await makeCore({ startAgent: "research", startSessionApprovalMode: "headless" }, ws);
    const denials: string[] = [];
    api.events.subscribe("PERMISSION_DENIED", (e: EventEnvelope) => {
      const cause = (e.payload as { cause?: string }).cause;
      if (cause) denials.push(cause);
    });
    const res = await api.session.command("writer", "daily");
    expect(res.ok).toBe(true);
    if (res.ok) {
      const turn = res.value as { status?: string };
      // Never `waiting_for_approval` (that would be exit 5 in headless).
      expect(turn.status).not.toBe("waiting_for_approval");
      expect(turn.status).toBe("completed");
    }
    // The write never ran under the read-only deny agent.
    await expect(fs.readFile(path.join(ws, "routine-out.txt"), "utf8")).rejects.toThrow();
    // A posture/headless denial was emitted so the host's "N action(s) denied"
    // line is non-zero even for the routine's separate session.
    expect(denials.some((c) => c === "read_only_posture" || c === "headless_no_ask")).toBe(true);
  });

  it("the post-boot setLaunchDefaults path (headless CLI) is honored too", async () => {
    const api = await makeCore({}, ws); // no construction-time posture
    api.session.setLaunchDefaults({ agent: "research", approvalMode: "headless" });
    const res = await api.session.command("writer", "nightly");
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.value as { status?: string }).status).toBe("completed");
    await expect(fs.readFile(path.join(ws, "routine-out.txt"), "utf8")).rejects.toThrow();
  });

  it("interactive (no launch posture) still ASKS — proving the TUI /routine run behavior is unchanged", async () => {
    const api = await makeCore({}, ws); // interactive default, chat agent
    const res = await api.session.command("writer", "adhoc");
    expect(res.ok).toBe(true);
    if (res.ok) {
      // With no headless posture and no onApproval handler, the interactive ask
      // cannot be resolved inline and the turn pauses waiting for approval —
      // the write has NOT run. This is the ask-path the TUI resolves via a dialog.
      const turn = res.value as { status?: string };
      expect(turn.status).toBe("waiting_for_approval");
    }
    await expect(fs.readFile(path.join(ws, "routine-out.txt"), "utf8")).rejects.toThrow();
  });
});
