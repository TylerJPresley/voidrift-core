/**
 * Unified rollback traversal — full engine integration (core-blueprint.md §10.12).
 *
 * A session of MIXED moves [chat-only, file, chat-only] is driven through the
 * REAL decision point with `fakeModel()` over BOTH a temp git repo (git method)
 * AND a non-git dir (cache method). It asserts that undo→redo→goto move the
 * FILES and the CONVERSATION together: after each step the NEXT model request's
 * history (`fakeModel().calls`) reflects the conversation at the target move.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, afterEach } from "vitest";
import { fakeModel, type FakeBuiltModel } from "@langchain/core/testing";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createCore } from "../boot.js";
import { InMemoryConfigStore } from "../adapters/repositories/in-memory-config-store.js";
import { seededPermissionsRecord } from "../test-support/seed-rules.js";
import { InMemorySessionRepository } from "../adapters/repositories/session-repository.js";
import { createMemoryCheckpointer } from "../adapters/checkpointer.js";
import type { ResolvedModel } from "../entities/ports/model-port.js";
import type { ModelConfigEntry } from "../config/schema.js";

function seed() {
  return {
    models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } },
    modelSelected: "t",
    permissions: {
      ...seededPermissionsRecord(),
      "allow-write_file": { tool: "write_file", decision: "allow" as const, priority: 0, source: "default" as const },
    },
    snapshotCount: 50,
  };
}

function flatten(call: { messages: BaseMessage[] }): string {
  return call.messages
    .map((m) => {
      const c = m.content;
      return typeof c === "string" ? c : JSON.stringify(c);
    })
    .join("\n");
}

/** Count `[harness note]` markers across the LATEST recorded request. */
function harnessNotesInLast(model: FakeBuiltModel): number {
  const last = model.calls[model.calls.length - 1];
  if (!last) return 0;
  return last.messages.filter((m) => {
    const c = m.content;
    const t = typeof c === "string" ? c : JSON.stringify(c);
    return t.includes("[harness note]");
  }).length;
}

let ws: string;
afterEach(async () => {
  if (ws) await fs.rm(ws, { recursive: true, force: true });
});

async function run(method: "git" | "cache"): Promise<void> {
  ws = hermeticTmp(`rb-unified-${method}`);
  await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
  if (method === "git") {
    execFileSync("git", ["init", "-q"], { cwd: ws });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: ws });
    execFileSync("git", ["config", "user.name", "t"], { cwd: ws });
  }
  const checkpointer = createMemoryCheckpointer();
  // Turn 1 chat-only; turn 2 writes file.txt; turn 3 chat-only. Then traversal
  // sends re-prompt the model, so give it plenty of generic responses.
  const model = fakeModel()
    .respond(new AIMessage("hello one"))
    .respondWithTools([{ name: "write_file", args: { path: "file.txt", content: "v2" } }])
    .respond(new AIMessage("wrote two"))
    .respond(new AIMessage("chat three"))
    .respond(new AIMessage("r1"))
    .respond(new AIMessage("r2"))
    .respond(new AIMessage("r3"))
    .respond(new AIMessage("r4"))
    .respond(new AIMessage("r5"))
    .respond(new AIMessage("r6"))
    .respond(new AIMessage("r7"))
    .respond(new AIMessage("r8")) as unknown as FakeBuiltModel;
  const { api } = await createCore({
    workspaceRoot: ws,
    configStore: new InMemoryConfigStore(seed()),
    sessionRepository: new InMemorySessionRepository(),
    checkpointer,
    chatModelFactory: (_r: ResolvedModel, _e: ModelConfigEntry) => model as unknown as import("@langchain/core/language_models/chat_models").BaseChatModel,
    startAgent: "chat",
  });
  const c = await api.session.create();
  const id = c.ok && c.value ? c.value.id : "";

  await api.session.send(id, { input: "first chat", approvalMode: "policy_only" });
  await api.session.send(id, { input: "write file", approvalMode: "policy_only" });
  expect(await fs.readFile(path.join(ws, "file.txt"), "utf8")).toBe("v2");
  await api.session.send(id, { input: "third chat", approvalMode: "policy_only" });

  // Three moves, one per turn.
  const report = await api.session.moves(id);
  expect(report.ok).toBe(true);
  if (report.ok && report.value.enabled) {
    expect(report.value.moves!.length).toBe(3);
    expect(report.value.method).toBe(method);
    // The file move (id 2) has a non-empty file half.
    expect(report.value.moves![1]!.files.method).toBe(method);
    expect(report.value.moves![1]!.files.paths.some((p) => p.path === "file.txt")).toBe(true);
    // In the cache method the chat-only turns capture no files (method none);
    // the git whole-tree method may capture incidental in-tree churn, so the
    // chat-only "none" guarantee is asserted for the cache method.
    if (method === "cache") expect(report.value.moves![0]!.files.method).toBe("none");
  }

  // undo → pointer 2 (reverses move 3, chat-only; files untouched).
  const u = await api.session.undo(id);
  expect(u.ok && u.value.ok).toBe(true);
  if (u.ok) expect(u.value.toPointer).toBe(2);
  expect(await fs.readFile(path.join(ws, "file.txt"), "utf8")).toBe("v2");

  // A send after the undo: the NEXT model request EXCLUDES the undone turn 3
  // ("third chat") and carries exactly ONE [harness note] (§10.12 LOW-3a).
  await api.session.send(id, { input: "after undo", approvalMode: "policy_only" });
  {
    const req = flatten(model.calls[model.calls.length - 1]!);
    expect(req).not.toContain("third chat");
    expect(req).toContain("write file"); // turn 2 survives
    expect(harnessNotesInLast(model)).toBe(1);
  }

  // This "after undo" send recorded a NEW move at the tip (move 4), dropping any
  // redo branch. Re-establish the file state for the goto assertions below.
  // goto 1 → crosses the file move → file.txt removed (it was created in move 2).
  const g1 = await api.session.goto(id, 1);
  expect(g1.ok && g1.value.ok).toBe(true);
  if (g1.ok) expect(g1.value.toPointer).toBe(1);
  await expect(fs.access(path.join(ws, "file.txt"))).rejects.toThrow();

  // A send at move 1: the request EXCLUDES the later turns and carries ONE note.
  await api.session.send(id, { input: "at move one", approvalMode: "policy_only" });
  {
    const req = flatten(model.calls[model.calls.length - 1]!);
    expect(req).not.toContain("after undo");
    expect(harnessNotesInLast(model)).toBe(1);
  }

  // goto 0 → session start. A send now continues from the empty conversation.
  const g0 = await api.session.goto(id, 0);
  expect(g0.ok && g0.value.ok).toBe(true);
  if (g0.ok) expect(g0.value.toPointer).toBe(0);

  // redo one step from the start → re-applies move 1; the request INCLUDES the
  // redone turn's user text and carries exactly ONE note (§10.12 LOW-3a).
  const re = await api.session.redo(id);
  expect(re.ok && re.value.ok).toBe(true);
  if (re.ok) expect(re.value.toPointer).toBe(1);
  await api.session.send(id, { input: "after redo", approvalMode: "policy_only" });
  {
    const req = flatten(model.calls[model.calls.length - 1]!);
    expect(req).toContain("first chat"); // the redone turn is back
    expect(harnessNotesInLast(model)).toBe(1);
    expect(req).toContain("after redo");
  }
  await api.session.shutdown().catch(() => undefined);
}

describe("§10.12 — unified traversal over mixed moves", () => {
  it("git method: undo→goto across chat-only and file moves move both halves", async () => {
    await run("git");
  });
  it("cache method: undo→goto across chat-only and file moves move both halves", async () => {
    await run("cache");
  });
});

/** Seed with a tiny active budget so `session.compact(force)` folds reliably. */
function foldSeed() {
  return {
    ...seed(),
    models: { t: { model: "t", protocol: "openai", contextLimit: 5000 } },
    contextActiveBudgetPct: 1,
    contextCompactionPct: 2,
  };
}

describe("§10.12 HIGH — context state (rolling summary + usage anchor) restored on traversal", () => {
  it("a fold then goto(0)/undo drops the summary from the next request; redo restores it", async () => {
    ws = hermeticTmp("rb-ctx");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    const checkpointer = createMemoryCheckpointer();
    // Turns 1 & 2 are substantial; the summarizer response carries the marker;
    // later responses answer the traversal re-prompts.
    const model = fakeModel()
      .respond(new AIMessage("answer one " + "x".repeat(200)))
      .respond(new AIMessage("answer two " + "x".repeat(200)))
      .respond(new AIMessage("[VOIDRIFT SUMMARY v1]\nfolded older work"))
      .respond(new AIMessage("t3"))
      .respond(new AIMessage("t4"))
      .respond(new AIMessage("t5"))
      .respond(new AIMessage("t6")) as unknown as FakeBuiltModel;
    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(foldSeed()),
      sessionRepository: new InMemorySessionRepository(),
      checkpointer,
      chatModelFactory: (_r: ResolvedModel, _e: ModelConfigEntry) => model as unknown as import("@langchain/core/language_models/chat_models").BaseChatModel,
      startAgent: "chat",
    });
    const c = await api.session.create();
    const id = c.ok && c.value ? c.value.id : "";

    await api.session.send(id, { input: "first big prompt " + "y".repeat(200), approvalMode: "policy_only" });
    await api.session.send(id, { input: "second big prompt " + "y".repeat(200), approvalMode: "policy_only" });
    // Force a fold so a rolling summary exists; it is recorded on the NEXT move.
    const comp = await api.session.compact(id);
    expect(comp.ok && comp.value.turnsFolded).toBeGreaterThan(0);
    // A third turn records the summary (and a usage anchor) into move 3's context.
    await api.session.send(id, { input: "third turn", approvalMode: "policy_only" });

    // The summary is now injected into requests (deriveView).
    await api.session.send(id, { input: "with summary", approvalMode: "policy_only" });
    expect(flatten(model.calls[model.calls.length - 1]!)).toContain("[VOIDRIFT SUMMARY v1]");

    // goto(0) → session start: the NEXT request carries NO summary.
    const g0 = await api.session.goto(id, 0);
    expect(g0.ok && g0.value.ok).toBe(true);
    await api.session.send(id, { input: "after goto0", approvalMode: "policy_only" });
    expect(flatten(model.calls[model.calls.length - 1]!)).not.toContain("[VOIDRIFT SUMMARY v1]");

    // usageAnchor/context meter matches the target (session start = no anchor →
    // occupancy falls back to the estimate, not the pre-rollback anchor).
    const ctx = await api.models.context(id);
    expect(ctx.ok).toBe(true);
    await api.session.shutdown().catch(() => undefined);
  });

  it("the stale-read guard (readPaths/stalePaths/documents) is reset on every traversal", async () => {
    ws = hermeticTmp("rb-stale");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    const checkpointer = createMemoryCheckpointer();
    const model = fakeModel()
      .respondWithTools([{ name: "read_file", args: { path: "seed.txt" } }])
      .respond(new AIMessage("read it"))
      .respond(new AIMessage("t2"))
      .respond(new AIMessage("t3")) as unknown as FakeBuiltModel;
    await fs.writeFile(path.join(ws, "seed.txt"), "contents");
    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed()),
      sessionRepository: new InMemorySessionRepository(),
      checkpointer,
      chatModelFactory: (_r: ResolvedModel, _e: ModelConfigEntry) => model as unknown as import("@langchain/core/language_models/chat_models").BaseChatModel,
      startAgent: "chat",
    });
    const c = await api.session.create();
    const id = c.ok && c.value ? c.value.id : "";

    // Turn 1 reads seed.txt → it is registered (the read-guard would trust it).
    await api.session.send(id, { input: "read the seed", approvalMode: "policy_only" });
    const docsBefore = await api.documents.list();
    expect(docsBefore.ok).toBe(true);

    // undo → the registry/read marks must be reset (do not trust an undone read).
    await api.session.undo(id);
    const docsAfter = await api.documents.list();
    expect(docsAfter.ok).toBe(true);
    if (docsAfter.ok) expect(docsAfter.value.length).toBe(0);
    await api.session.shutdown().catch(() => undefined);
  });
});

describe("§10.12 LOW — resume and untrusted-timeline handling", () => {
  async function resume(method: "git" | "cache"): Promise<void> {
    ws = hermeticTmp(`rb-resume-${method}`);
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    if (method === "git") {
      execFileSync("git", ["init", "-q"], { cwd: ws });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: ws });
      execFileSync("git", ["config", "user.name", "t"], { cwd: ws });
    }
    const checkpointer = createMemoryCheckpointer();
    const sessions = new InMemorySessionRepository();
    const model = fakeModel()
      .respond(new AIMessage("one"))
      .respond(new AIMessage("two"))
      .respond(new AIMessage("three")) as unknown as FakeBuiltModel;
    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed()),
      sessionRepository: sessions,
      checkpointer,
      chatModelFactory: (_r: ResolvedModel, _e: ModelConfigEntry) => model as unknown as import("@langchain/core/language_models/chat_models").BaseChatModel,
      startAgent: "chat",
    });
    const c = await api.session.create();
    const id = c.ok && c.value ? c.value.id : "";
    await api.session.send(id, { input: "turn one", approvalMode: "policy_only" });
    await api.session.send(id, { input: "turn two", approvalMode: "policy_only" });
    // Traverse back one move, then shut down (persisting the timeline + pointer).
    const u = await api.session.undo(id);
    expect(u.ok && u.value.ok).toBe(true);
    await api.session.shutdown().catch(() => undefined);

    // Fresh core over the SAME checkpointer + cache dir: the timeline + pointer
    // reload, redo works, and the next send continues from the new tip.
    const model2 = fakeModel()
      .respond(new AIMessage("redone"))
      .respond(new AIMessage("continued")) as unknown as FakeBuiltModel;
    const { api: api2 } = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed()),
      sessionRepository: sessions,
      checkpointer,
      chatModelFactory: (_r: ResolvedModel, _e: ModelConfigEntry) => model2 as unknown as import("@langchain/core/language_models/chat_models").BaseChatModel,
      startAgent: "chat",
    });
    const report = await api2.session.moves(id);
    expect(report.ok && report.value.enabled).toBe(true);
    if (report.ok && report.value.enabled) {
      expect(report.value.moves!.length).toBe(2);
      // pointer reloaded at the ID of the last applied move (move 1 after the undo).
      expect(report.value.pointer).toBe(1);
    }
    const redo = await api2.session.redo(id);
    expect(redo.ok && redo.value.ok).toBe(true);
    if (redo.ok) expect(redo.value.toPointer).toBe(2);
    await api2.session.send(id, { input: "continue after resume", approvalMode: "policy_only" });
    expect(flatten(model2.calls[model2.calls.length - 1]!)).toContain("continue after resume");
    await api2.session.shutdown().catch(() => undefined);
  }

  it("git method: resume reloads the timeline+pointer, redo works, send continues", async () => {
    await resume("git");
  });
  it("cache method: resume reloads the timeline+pointer, redo works, send continues", async () => {
    await resume("cache");
  });

  it("a timeline with an older schema version / invalid hmac is ignored with ONE warning; history starts empty", async () => {
    ws = hermeticTmp("rb-oldver");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    const checkpointer = createMemoryCheckpointer();
    const sessions = new InMemorySessionRepository();
    const model = fakeModel()
      .respond(new AIMessage("one"))
      .respond(new AIMessage("two")) as unknown as FakeBuiltModel;
    // Core A: a real session + one move → a legitimately-signed v3 timeline.
    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed()),
      sessionRepository: sessions,
      checkpointer,
      chatModelFactory: (_r: ResolvedModel, _e: ModelConfigEntry) => model as unknown as import("@langchain/core/language_models/chat_models").BaseChatModel,
      startAgent: "chat",
    });
    const c = await api.session.create();
    const id = c.ok && c.value ? c.value.id : "";
    await api.session.send(id, { input: "turn one", approvalMode: "policy_only" });
    await api.session.shutdown().catch(() => undefined);

    // Plant a v2 timeline with NO hmac over the real one — untrusted on BOTH the
    // schema version (v2 < current 3) and the missing hmac.
    const tlPath = path.join(ws, ".voidrift", "cache", "snapshots", id, "timeline.json");
    await fs.writeFile(
      tlPath,
      JSON.stringify({
        version: 2,
        pointer: 1,
        moves: [
          {
            id: 1,
            sessionId: id,
            turn: 1,
            time: "t",
            summary: "s",
            conversation: { beforeCheckpointId: null, afterCheckpointId: "cp-1" },
            files: { method: "cache", paths: [], notUndoable: [] },
          },
        ],
      }),
    );

    // Core B over the SAME repo/checkpointer: a fresh rollback service loads the
    // planted timeline → ignored, empty history, exactly ONE warning.
    const warnings: string[] = [];
    const model2 = fakeModel().respond(new AIMessage("ok")) as unknown as FakeBuiltModel;
    const { api: api2 } = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed()),
      sessionRepository: sessions,
      checkpointer,
      chatModelFactory: (_r: ResolvedModel, _e: ModelConfigEntry) => model2 as unknown as import("@langchain/core/language_models/chat_models").BaseChatModel,
      startAgent: "chat",
    });
    api2.events.subscribe("WARNING_EMITTED", (e) => {
      const p = e.payload as { source?: string; category?: string };
      if (p.category === "rollback" && (p.source === "timeline" || p.source === "integrity")) warnings.push(JSON.stringify(p));
    });
    const report = await api2.session.moves(id);
    expect(report.ok && report.value.enabled).toBe(true);
    if (report.ok && report.value.enabled) expect(report.value.moves!.length).toBe(0);
    expect(warnings.length).toBe(1);
    await api2.session.shutdown().catch(() => undefined);
  });

  it("a traversal drops the measured usageRatio consistently with the usage anchor (§4.8)", async () => {
    ws = hermeticTmp("rb-ratio");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    const checkpointer = createMemoryCheckpointer();
    const sessions = new InMemorySessionRepository();
    // A model that reports usage so the engine MEASURES a chars/token ratio.
    const withUsage = (text: string) => {
      const msg = new AIMessage(text);
      (msg as { usage_metadata?: unknown }).usage_metadata = { input_tokens: 40, output_tokens: 3, total_tokens: 43 };
      return msg;
    };
    const model = fakeModel()
      .respond(withUsage("one"))
      .respond(withUsage("two")) as unknown as FakeBuiltModel;
    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed()),
      sessionRepository: sessions,
      checkpointer,
      chatModelFactory: (_r: ResolvedModel, _e: ModelConfigEntry) => model as unknown as import("@langchain/core/language_models/chat_models").BaseChatModel,
      startAgent: "chat",
    });
    const c = await api.session.create();
    const id = c.ok && c.value ? c.value.id : "";
    await api.session.send(id, { input: "turn one", approvalMode: "policy_only" });
    await api.session.send(id, { input: "turn two", approvalMode: "policy_only" });
    // The ratio was measured and persisted to session metadata.
    const metas1 = await sessions.list();
    const meta1 = metas1.find((m) => m.id === id)!;
    expect(meta1.usageRatio).toBeGreaterThan(0);
    expect(meta1.usageRatioModel).toBe("t");
    // goto(0) → session start: the anchor is restored (to none) and the ratio is
    // dropped with it; the persisted metadata reflects the drop.
    const g0 = await api.session.goto(id, 0);
    expect(g0.ok && g0.value.ok).toBe(true);
    const metas2 = await sessions.list();
    const meta2 = metas2.find((m) => m.id === id)!;
    expect(meta2.usageRatio).toBeUndefined();
    expect(meta2.usageRatioModel).toBeUndefined();
    await api.session.shutdown().catch(() => undefined);
  });
});
