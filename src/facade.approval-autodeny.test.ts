/**
 * §9.5 — the unattended-approval countdown (`limits.approval.autoDenySeconds`).
 *
 * An interactive `ask` left unanswered past the countdown AUTO-DENIES
 * (deny-and-continue, the same fail-closed outcome as a human reject): the turn
 * continues as on a reject and the auto-deny is recorded in the trail
 * (PERMISSION_RESOLVED `decision: "reject"`). The default `0` disables the
 * countdown and the ask waits. A human answer BEFORE the countdown cancels the
 * timer so it never fires.
 *
 * Deterministic and offline: `fakeModel()` drives the engine and an INJECTED
 * timer seam (`setApprovalTimer`) drives the countdown with a scripted fire — NO
 * real sleep. The fire is captured, not scheduled, so "fires at N seconds and
 * not before" is proven by whether the test invokes the captured callback.
 */
import { hermeticTmp } from "./test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import path from "node:path";
import fs from "node:fs/promises";
import { createCore, type CoreReady } from "./boot.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { InMemoryJournalStore } from "./adapters/repositories/in-memory-journal-store.js";
import { seededPermissionsRecord } from "./test-support/seed-rules.js";
import type { ResolvedModel } from "./entities/ports/model-port.js";
import type { ModelConfigEntry } from "./config/schema.js";
import type { ApprovalResponse, PendingApproval } from "./entities/approvals.js";
import type { Config } from "./config/schema.js";

const seed = {
  models: { test: { model: "test-model", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "test",
  permissions: seededPermissionsRecord(),
};

function fakeFactory(script: () => ReturnType<typeof fakeModel>) {
  return (_r: ResolvedModel, _e: ModelConfigEntry) => script();
}

/** A write-then-finish script: the write_file ask gates, the second response
 * completes the turn once the ask resolves (approve OR reject). */
function writeThenDone() {
  return fakeModel()
    .respondWithTools([{ name: "write_file", args: { path: "b.txt", content: "from B" } }])
    .respond(new AIMessage("done"));
}

/** A controllable fake timer: capture the latest armed `fire` and whether it was
 * cancelled, so a test fires it on demand (never a real sleep). */
function makeFakeTimer() {
  const armed: { ms: number; fire: () => void; cancelled: boolean }[] = [];
  const setApprovalTimer = (ms: number, fire: () => void): (() => void) => {
    const rec = { ms, fire, cancelled: false };
    armed.push(rec);
    return () => {
      rec.cancelled = true;
    };
  };
  return { setApprovalTimer, armed };
}

describe("§9.5 — approval.autoDenySeconds unattended countdown", () => {
  let ws: string;
  const tracked: CoreReady[] = [];

  beforeEach(async () => {
    ws = hermeticTmp("autodeny");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
  });
  afterEach(async () => {
    for (const c of tracked.splice(0)) await c.api.session.shutdown().catch(() => undefined);
    await fs.rm(ws, { recursive: true, force: true });
  });

  async function makeCore(opts: {
    autoDenySeconds: number;
    onApproval: (p: PendingApproval) => Promise<ApprovalResponse>;
    setApprovalTimer?: (ms: number, fire: () => void) => () => void;
  }) {
    const configOverrides = { limits: { approval: { autoDenySeconds: opts.autoDenySeconds } } } as unknown as Partial<Config>;
    const ready = await createCore({
      workspaceRoot: ws,
      configOverrides,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: fakeFactory(writeThenDone),
      journalStore: new InMemoryJournalStore(),
      onApproval: opts.onApproval,
      ...(opts.setApprovalTimer ? { setApprovalTimer: opts.setApprovalTimer } : {}),
    });
    tracked.push(ready);
    return ready.api;
  }

  it("auto-denies when the countdown fires: the write is rejected, the turn continues, and the trail records a reject", async () => {
    // Given a non-zero countdown and an onApproval that NEVER answers (unattended).
    // The fake timer AUTO-FIRES on the next tick after it is armed (the fake
    // clock reaching N seconds), deterministically and with no real sleep.
    const armedMs: number[] = [];
    const setApprovalTimer = (ms: number, fire: () => void): (() => void) => {
      armedMs.push(ms);
      const h = setImmediate(fire);
      return () => clearImmediate(h);
    };
    const resolved: { decision: string }[] = [];
    let onApprovalCalled = 0;
    const api = await makeCore({
      autoDenySeconds: 30,
      setApprovalTimer,
      onApproval: () => {
        onApprovalCalled += 1;
        return new Promise<ApprovalResponse>(() => {}); // never resolves
      },
    });
    api.events.subscribe("PERMISSION_RESOLVED", (e) => resolved.push(e.payload as { decision: string }));

    const created = await api.session.create({ name: "s" });
    const id = created.ok ? created.value.id : "";

    // When the turn runs (interactive): the gated write arms the countdown, which
    // fires because no human answered.
    const res = await api.session.send(id, { input: "write b.txt" });
    expect(res.ok).toBe(true);
    // Then the turn continues to completion (deny-and-continue, as on a reject).
    if (res.ok) expect(res.value.status).toBe("completed");
    expect(onApprovalCalled, "onApproval was invoked for the gated write").toBe(1);
    expect(armedMs[0], "the countdown is autoDenySeconds × 1000 ms").toBe(30_000);
    // The write never landed (fail-closed).
    await expect(fs.readFile(path.join(ws, "b.txt"), "utf8")).rejects.toBeTruthy();
    // The trail records the auto-deny as PERMISSION_RESOLVED decision: reject.
    expect(resolved.some((r) => r.decision === "reject")).toBe(true);
  });

  it("a human answer BEFORE the countdown cancels the timer: the write is approved and the timer is cancelled", async () => {
    // Given a non-zero countdown and an onApproval that approves immediately.
    const timer = makeFakeTimer();
    const api = await makeCore({
      autoDenySeconds: 30,
      setApprovalTimer: timer.setApprovalTimer,
      onApproval: async (p) => ({ requestId: p.id, decision: "approve" }),
    });
    const created = await api.session.create({ name: "s" });
    const id = created.ok ? created.value.id : "";

    const res = await api.session.send(id, { input: "write b.txt" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.status).toBe("completed");
    // The write landed (approved).
    expect(await fs.readFile(path.join(ws, "b.txt"), "utf8")).toBe("from B");
    // The armed countdown was cancelled, never fired.
    expect(timer.armed.length).toBe(1);
    expect(timer.armed[0]!.cancelled, "the countdown is cancelled once a human answers").toBe(true);
  });

  it("0 disables the countdown: no timer is armed and the ask waits for the human answer", async () => {
    // Given the default 0 and a human that approves.
    const timer = makeFakeTimer();
    const api = await makeCore({
      autoDenySeconds: 0,
      setApprovalTimer: timer.setApprovalTimer,
      onApproval: async (p) => ({ requestId: p.id, decision: "approve" }),
    });
    const created = await api.session.create({ name: "s" });
    const id = created.ok ? created.value.id : "";

    const res = await api.session.send(id, { input: "write b.txt" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.status).toBe("completed");
    // NO countdown was ever armed with 0 (disabled).
    expect(timer.armed.length, "0 disables the countdown — no timer armed").toBe(0);
    expect(await fs.readFile(path.join(ws, "b.txt"), "utf8")).toBe("from B");
  });
});
