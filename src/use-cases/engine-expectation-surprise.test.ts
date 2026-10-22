/**
 * Engine-level surprise detection over the REAL chain (core-blueprint.md §9.5.1,
 * §10.11; plan-blueprint.md §4–§5).
 *
 * The earlier §9.5.1 tests inject a hand-made scope→targets reader; they prove
 * the comparison, not the wiring. This drives the PRODUCTION path end to end:
 *   - a real plan-scope grant is opened via the CoreAPI under id `plan:<id>`;
 *   - an expectation is registered for the SAME id;
 *   - a real journaled write (through the decision point, a scripted fakeModel
 *     tool call) touches a target OUTSIDE the prediction;
 *   - the scope is cleared (`clearPlanScope`) — the core reads the scope's
 *     journal targets, compares, and emits ONE masked surprise;
 *   - the journal entry's `planStep` equals the scope id (so the reader finds
 *     the scope's writes AT ALL — the regression this test guards);
 *   - an honest prediction over the same real chain emits none.
 *
 * Deterministic/offline over a per-test temp workspace and in-memory stores.
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
import { InMemoryJournalStore } from "../adapters/repositories/in-memory-journal-store.js";
import type { ResolvedModel } from "../entities/ports/model-port.js";
import type { ModelConfigEntry } from "../config/schema.js";
import { seededPermissionsRecord } from "../test-support/seed-rules.js";
import type { EventEnvelope } from "../entities/event-bus.js";

const seed = {
  models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "t",
  mutationLogLevel: "action",
  permissions: {
    ...seededPermissionsRecord(),
    "allow-write": { tool: "write_file", decision: "allow" as const, priority: 0, source: "user" as const },
  },
};

function factory(script: () => ReturnType<typeof fakeModel>) {
  return (_r: ResolvedModel, _e: ModelConfigEntry) => script();
}

const tracked: { session: { shutdown: () => Promise<void> } }[] = [];

describe("Engine surprise detection over the real chain (§9.5.1)", () => {
  let ws: string;
  let journalStore: InMemoryJournalStore;
  beforeEach(async () => {
    ws = hermeticTmp("jsurprise");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    journalStore = new InMemoryJournalStore();
  });
  afterEach(async () => {
    for (const c of tracked.splice(0)) await c.session.shutdown().catch(() => undefined);
    await fs.rm(ws, { recursive: true, force: true });
  });

  async function core(script: () => ReturnType<typeof fakeModel>) {
    const ready = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      journalStore,
      chatModelFactory: factory(script),
    });
    tracked.push(ready.api);
    return ready.api;
  }

  const writeTo = (p: string, content: string) => () =>
    fakeModel()
      .respondWithTools([{ name: "write_file", args: { path: p, content } }])
      .respond(new AIMessage("done"));

  it("an unpredicted real write emits ONE masked surprise; the journal entry's planStep equals the scope id", async () => {
    const api = await core(writeTo("out/leaked.ts", "x"));
    const warnings: EventEnvelope[] = [];
    api.events.subscribe("WARNING_EMITTED", (e) => warnings.push(e));

    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";

    // Open a real plan-scope grant under `plan:<id>` and predict only src/**.
    const scopeId = "plan:step-1";
    api.register.planScope(scopeId, { writeGlobs: ["out/**", "src/**"], executePatterns: [] });
    api.expectations.register({ scope: scopeId, predicted: ["src/**"] });

    const res = await api.session.send(id, { input: "write out/leaked.ts", approvalMode: "policy_only" });
    expect(res.ok && res.value.status).toBe("completed");

    // The journal entry the scope drove MUST carry the scope id as its planStep —
    // without it the scope-targets reader returns nothing and no surprise fires.
    const entries = await api.session.journal.list(id);
    const write = entries.find((e) => e.tool === "write_file" && e.target === "out/leaked.ts");
    expect(write, "a journaled write for the scope's target").toBeTruthy();
    expect(write!.planStep).toBe(scopeId);

    // Close the scope → compare → emit.
    api.register.clearPlanScope(scopeId);
    await new Promise((r) => setTimeout(r, 0));

    const surprises = warnings.filter((w) => (w.payload as { category?: string }).category === "surprise");
    expect(surprises).toHaveLength(1);
    const payload = surprises[0]!.payload as { pattern: string; count: number; source: string };
    expect(payload.source).toBe("expectation");
    expect(payload.count).toBe(1);
    expect(payload.pattern).toContain("out/leaked.ts");
  });

  it("surprise targets are sanitized: U+202E / ESC-ANSI / BEL in a target never reach the event", async () => {
    const nasty = "out/\u202e\u001b[31mevil\u0007.ts";
    const api = await core(writeTo(nasty, "x"));
    const warnings: EventEnvelope[] = [];
    api.events.subscribe("WARNING_EMITTED", (e) => warnings.push(e));

    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const scopeId = "plan:step-2";
    api.register.planScope(scopeId, { writeGlobs: ["out/**"], executePatterns: [] });
    api.expectations.register({ scope: scopeId, predicted: ["src/**"] });
    await api.session.send(id, { input: "write nasty", approvalMode: "policy_only" });
    api.register.clearPlanScope(scopeId);
    await new Promise((r) => setTimeout(r, 0));

    const surprises = warnings.filter((w) => (w.payload as { category?: string }).category === "surprise");
    expect(surprises).toHaveLength(1);
    const pattern = (surprises[0]!.payload as { pattern: string }).pattern;
    expect(pattern).not.toMatch(/[\u202e\u001b\u0007]/);
  });

  it("an honest real prediction emits no surprise", async () => {
    const api = await core(writeTo("src/app.ts", "x"));
    const warnings: EventEnvelope[] = [];
    api.events.subscribe("WARNING_EMITTED", (e) => warnings.push(e));

    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const scopeId = "plan:step-3";
    api.register.planScope(scopeId, { writeGlobs: ["src/**"], executePatterns: [] });
    api.expectations.register({ scope: scopeId, predicted: ["src/**"] });
    await api.session.send(id, { input: "write src/app.ts", approvalMode: "policy_only" });
    api.register.clearPlanScope(scopeId);
    await new Promise((r) => setTimeout(r, 0));

    const surprises = warnings.filter((w) => (w.payload as { category?: string }).category === "surprise");
    expect(surprises).toHaveLength(0);
  });
});
