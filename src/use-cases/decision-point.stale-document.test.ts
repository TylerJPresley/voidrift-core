/**
 * Stale-document → read-before-edit guardrail, end to end (core-blueprint.md
 * §4.5, §9.4). The document registry marks an entry `[STALE]` when its on-disk
 * content drifts (or when compaction folds its turn); the read-before-edit
 * guardrail then treats a stale path the same as an UNREAD one — an `edit_file`
 * against it is blocked until the model re-reads the current content. Re-reading
 * (registry.add → markRead) clears the stale flag, after which the edit runs.
 *
 * This proves the real linkage: DocumentRegistry → Session.stalePaths →
 * the decision point's `guardrailState` → the `unread-or-stale-edit` guardrail.
 */
import { describe, it, expect } from "vitest";
import { ToolMessage } from "@langchain/core/messages";
import { z } from "zod";
import { createDecisionMiddleware, type DecisionPointDeps, type CallerContext } from "./decision-point.js";
import { ToolRegistry } from "../entities/tool-registry.js";
import { EventBus } from "../entities/event-bus.js";
import { Guardian, builtinGuardrails } from "../entities/guardian.js";
import { Warden } from "../entities/warden.js";
import { ConfigSchema, type Config } from "../config/schema.js";
import { DocumentRegistry } from "../entities/document-registry.js";
import { Session, type SessionMetadata } from "../entities/session.js";
import type { AgentDefinition } from "../entities/subagents.js";

const agent: AgentDefinition = {
  name: "chat",
  description: "d",
  kind: "top-level",
  systemPrompt: "",
  tools: ["*"],
  workers: "all",
  unlisted: "allow", // allow-posture so nothing but the guardrail can block the edit
  confirm: true,
};

function cfg(over: Partial<Config> = {}): Config {
  return ConfigSchema.parse({ ...over });
}

function session(): Session {
  const meta: SessionMetadata = {
    id: "s1", name: "n", summary: "", workspace: "/ws", startedAt: "t", lastActiveAt: "t",
    turnCount: 0, sizeBytes: 0, namePinned: false,
  };
  return new Session(meta);
}

function deps(s: Session, bus: EventBus): DecisionPointDeps {
  const registry = new ToolRegistry();
  registry.register(
    { name: "edit_file", description: "d", schema: z.object({ path: z.string(), search: z.string(), replace: z.string() }), readOnly: false, origin: "builtin" },
    async () => ({ content: "edited", status: "success" }),
  );
  return {
    guardian: new Guardian(builtinGuardrails()),
    warden: new Warden({ mode: "off" }),
    bus,
    registry,
    getConfig: () => cfg(),
    getActiveAgent: () => agent,
    tempDir: "/no/such",
    workspaceRoot: "/ws",
    globalConfigDir: "/home/u/.config/voidrift",
    home: "/home/u",
    window: 32_000,
    getSessionRules: () => [],
    // The real linkage: the guardrail reads the SAME sets the session owns, so a
    // stale document (marked via the registry) blocks an edit through the gate.
    guardrailState: () => ({ readPaths: s.readPaths, stalePaths: s.stalePaths }),
  };
}

function editCall(s: Session, bus: EventBus, id: string) {
  const mw = createDecisionMiddleware(deps(s, bus), { sessionId: "s1", approvalMode: "interactive" } as CallerContext, async () => ({ decision: "allow" as const }));
  const request = { toolCall: { name: "edit_file", args: { path: "src/a.ts", search: "v1", replace: "v2" }, id } };
  const handler = async () => new ToolMessage({ content: "executed", tool_call_id: id, status: "success" as const });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mw as any).wrapToolCall(request, handler) as Promise<ToolMessage>;
}

describe("stale document re-read before edit (§4.5, §9.4)", () => {
  it("a read lets an edit through; a drift marks it STALE and blocks the edit; a re-read clears it", async () => {
    const s = session();
    const bus = new EventBus();
    const reg = new DocumentRegistry(s, (t, p) => bus.emit(t, p, { session: s.id }));

    // 1) The model reads the file into context → the registry records it and
    //    markRead() lets an edit through.
    reg.add({ path: "src/a.ts", content: "v1", trust: "live", turn: 1 });
    const okRes = await editCall(s, bus, "e1");
    expect(okRes.status).toBe("success");

    // 2) The on-disk content drifts → the registry marks the entry STALE, which
    //    populates session.stalePaths, so the next edit is BLOCKED (treated as
    //    unread) until the model re-reads.
    expect(reg.checkStale("src/a.ts", "v1-CHANGED")).toBe(true);
    expect(s.stalePaths.has("src/a.ts")).toBe(true);
    const blocked = await editCall(s, bus, "e2");
    expect(blocked.status).toBe("error");
    expect(String(blocked.content)).toMatch(/stale|re-read/i);

    // 3) The model re-reads the current content → registry.add → markRead clears
    //    the stale flag, and the edit runs again.
    reg.add({ path: "src/a.ts", content: "v1-CHANGED", trust: "live", turn: 2 });
    expect(s.stalePaths.has("src/a.ts")).toBe(false);
    const allowedAgain = await editCall(s, bus, "e3");
    expect(allowedAgain.status).toBe("success");
  });

  it("a folded turn's document is marked STALE and blocks an edit until re-read (§4.9)", async () => {
    const s = session();
    const bus = new EventBus();
    const reg = new DocumentRegistry(s, (t, p) => bus.emit(t, p, { session: s.id }));
    reg.add({ path: "src/a.ts", content: "v1", trust: "live", turn: 1 });
    // Compaction folds turns 1..2 → the document is stale.
    expect(reg.markFoldedStale(2)).toContain("src/a.ts");
    const blocked = await editCall(s, bus, "f1");
    expect(blocked.status).toBe("error");
    expect(String(blocked.content)).toMatch(/stale|re-read/i);
  });
});
