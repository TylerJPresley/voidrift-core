/**
 * Regression for the §808d5d21 audit "Product finding 4" log defects
 * (core-blueprint.md §9.5, §10.2, §10.4, §14.6):
 *
 *  4a — a `permission_resolved` audit record MUST carry the full action (the
 *       masked tool and args, redacted exactly as `permission_requested`) and
 *       the decision, not `tool: ""` / `args: null`.
 *  4b — ONE `PERMISSION_REQUESTED` per human ask. The LangGraph `interrupt`
 *       re-executes the ask node on resume, which previously emitted a SECOND
 *       requested event (a few seconds apart) with a fresh id.
 *  4c — `turn.complete.attributes.toolsUsed` holds the REAL tool name for a
 *       Guardian-denied call, never `""` (a denied call still names its tool,
 *       and denied calls DO appear in the list — a denial is still a call).
 *
 * Driven over the full core (real engine, real decision point, real Guardian) so
 * the assertions cover the live emit path, not a stub.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, afterEach } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import path from "node:path";
import fs from "node:fs/promises";
import { createCore } from "../boot.js";
import { InMemoryConfigStore } from "../adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "../adapters/repositories/session-repository.js";
import { seededPermissionsRecord } from "../test-support/seed-rules.js";

const seed = {
  models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "t",
  permissions: seededPermissionsRecord(),
};

const cores: { session: { shutdown: () => Promise<void> } }[] = [];
afterEach(async () => {
  for (const c of cores) await c.session.shutdown().catch(() => undefined);
  cores.length = 0;
});

async function makeCore(ws: string, onApproval?: (req: { id: string }) => Promise<unknown>) {
  await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
  const ready = await createCore({
    workspaceRoot: ws,
    configStore: new InMemoryConfigStore(seed),
    sessionRepository: new InMemorySessionRepository(),
    chatModelFactory: (_r, _e) =>
      fakeModel()
        .respondWithTools([{ name: "write_file", args: { path: "i.txt", content: "yo" } }])
        .respond(new AIMessage("done")) as never,
    ...(onApproval ? { onApproval: onApproval as never } : {}),
  });
  cores.push(ready.api);
  return ready.api;
}

describe("§9.5/§14.6 permission log defects (audit finding 4)", () => {
  it("4b — ONE PERMISSION_REQUESTED per ask across the interrupt replay (mutation guard)", async () => {
    // Given an interactive ask resolved by the host, When the turn runs,
    // Then exactly one PERMISSION_REQUESTED fires (the interrupt replays the
    // ask node, but the duplicate is suppressed) — one requested, one resolved,
    // one stable requestId shared between them.
    const ws = hermeticTmp("permdef-4b");
    const api = await makeCore(ws, async (req) => ({ requestId: req.id, decision: "approve" }));
    const requested: { requestId?: string }[] = [];
    const resolved: { requestId?: string }[] = [];
    api.events.subscribe("PERMISSION_REQUESTED", (e) => requested.push(e.payload as { requestId?: string }));
    api.events.subscribe("PERMISSION_RESOLVED", (e) => resolved.push(e.payload as { requestId?: string }));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.send(id, { input: "write i.txt", approvalMode: "interactive" });

    expect(requested).toHaveLength(1);
    expect(resolved).toHaveLength(1);
    expect(requested[0]!.requestId).toBe(resolved[0]!.requestId);
  });

  it("4a — PERMISSION_RESOLVED carries the full action (tool + masked args) and the decision", async () => {
    // Given an interactive ask approved by the host, Then the resolution payload
    // names the tool and the args (redacted exactly as the request), not "" / null.
    const ws = hermeticTmp("permdef-4a");
    const api = await makeCore(ws, async (req) => ({ requestId: req.id, decision: "approve" }));
    const requested: { tool?: string; args?: unknown }[] = [];
    const resolved: { tool?: string; args?: unknown; decision?: string }[] = [];
    api.events.subscribe("PERMISSION_REQUESTED", (e) => requested.push(e.payload as { tool?: string; args?: unknown }));
    api.events.subscribe("PERMISSION_RESOLVED", (e) => resolved.push(e.payload as { tool?: string; args?: unknown; decision?: string }));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.send(id, { input: "write i.txt", approvalMode: "interactive" });

    expect(resolved).toHaveLength(1);
    const r = resolved[0]!;
    expect(r.decision).toBe("approve");
    expect(r.tool).toBe("write_file");
    // The resolved args mirror the request's masked args exactly (§10.2).
    expect(r.args).toEqual(requested[0]!.args);
    expect(r.args).toEqual({ path: "i.txt", content: "yo" });
  });

  it("4a (trail) — the permission_resolved obs record carries the action, not tool \"\"/args null", async () => {
    // A unit check over the ObsWriter: a PERMISSION_RESOLVED event carrying the
    // tool and masked args (as the engine now emits) mints an audit record whose
    // `tool` and `action` name the call and whose `decision` is the resolution —
    // never `tool: ""` / `args: null` (§10.2/§10.4/§14.6). Deterministic: the
    // writer is flushed, so this never races the best-effort on-disk write.
    const { EventBus } = await import("../entities/event-bus.js");
    const { ObsWriter } = await import("./obs-writer.js");
    const bus = new EventBus();
    const lines: string[] = [];
    const writer = new ObsWriter({
      bus,
      store: {
        async appendWorkspace(_id, line) {
          lines.push(line);
        },
        async appendGlobal() {},
        async readWorkspace() {
          return [];
        },
      },
      getLevel: () => "info",
      getSuggestionThreshold: () => 3,
      getSequenceMaxLen: () => 6,
    });
    writer.start();
    bus.emit(
      "PERMISSION_RESOLVED",
      { requestId: "appr-1", decision: "approve", tool: "write_file", args: { path: "i.txt", content: "yo" } },
      { session: "s1" },
    );
    await writer.flush();
    await writer.close();

    const recs = lines.map((l) => JSON.parse(l) as { name: string; attributes: Record<string, unknown> });
    const resolved = recs.find((r) => r.name === "permission_resolved");
    expect(resolved).toBeDefined();
    const attrs = resolved!.attributes as { tool?: string; decision?: string; action?: { tool?: string; args?: unknown } };
    expect(attrs.tool).toBe("write_file");
    expect(attrs.decision).toBe("approve");
    expect(attrs.action?.tool).toBe("write_file");
    expect(attrs.action?.args).toEqual({ path: "i.txt", content: "yo" });
  });

  it("4c — a Guardian-denied call names its real tool in turn.complete.toolsUsed (mutation guard)", async () => {
    // Given a model that calls execute_command with a shellDenyPatterns command
    // (denied outright by the Guardian never list), When the turn completes,
    // Then toolsUsed holds the real tool name, not "" — a denied call still names
    // its tool, and denied calls DO appear in the list.
    const ws = hermeticTmp("permdef-4c");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    const ready = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: (_r, _e) =>
        fakeModel()
          .respondWithTools([{ name: "execute_command", args: { command: "rm -rf /" } }])
          .respond(new AIMessage("done")) as never,
    });
    cores.push(ready.api);
    const api = ready.api;
    const turns: { toolsUsed?: unknown }[] = [];
    const denied: { tool?: string }[] = [];
    api.events.subscribe("TURN_COMPLETE", (e) => turns.push(e.payload as { toolsUsed?: unknown }));
    api.events.subscribe("PERMISSION_DENIED", (e) => denied.push(e.payload as { tool?: string }));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.send(id, { input: "run it", approvalMode: "interactive" });

    expect(denied).toHaveLength(1);
    expect(denied[0]!.tool).toBe("execute_command");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.toolsUsed).toEqual(["execute_command"]);
    // The real tool name, never the "" the raw ToolMessage.name defaulted to.
    expect((turns[0]!.toolsUsed as string[])).not.toContain("");
  });
});
