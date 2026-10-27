/**
 * The Memory capability (core-blueprint.md §6) — verified writes + bounds (§6.3,
 * §6.4), typed loading + keyword surfacing (§6.2), delete/load/unload events
 * (§6.4), cross-session recall (§6.5), project context (§6.6), reflection →
 * suggestions → approve + dedup (§6.7), and the secret-scrubbed provider contract
 * (§6.8). Deterministic, offline, in-memory store (§15.3).
 */
import { describe, it, expect } from "vitest";
import { Memory, type MemoryDeps } from "./memory.js";
import { InMemoryMemoryStore } from "../adapters/repositories/in-memory-memory-store.js";
import { SuggestionsDirectory } from "../adapters/suggestions-directory.js";
import { InMemoryFileSystem } from "../adapters/in-memory-filesystem.js";
import { EventBus, type EventEnvelope } from "../entities/event-bus.js";
import { InMemorySessionRepository } from "../adapters/repositories/session-repository.js";
import type { MemoryStore } from "../entities/ports/memory-store.js";
import type { TurnRecord } from "../entities/memory/memory-provider.js";
import type { ProjectFile } from "../entities/memory/project-context.js";

interface Harness {
  memory: Memory;
  bus: EventBus;
  events: EventEnvelope[];
  store: MemoryStore;
  sessions: InMemorySessionRepository;
}

function harness(opts: {
  store?: MemoryStore;
  projectFiles?: ProjectFile[];
  turns?: TurnRecord[];
  entryChars?: number;
  draftSkillFromSequence?: MemoryDeps["draftSkillFromSequence"];
  getContextLimit?: MemoryDeps["getContextLimit"];
  limits?: MemoryDeps["limits"];
  listSkillBodies?: MemoryDeps["listSkillBodies"];
  onApproveSkill?: MemoryDeps["onApproveSkill"];
  projectCharsConfigured?: MemoryDeps["projectCharsConfigured"];
  getContextWindow?: MemoryDeps["getContextWindow"];
  projectDigest?: MemoryDeps["projectDigest"];
} = {}): Harness {
  const bus = new EventBus();
  const events: EventEnvelope[] = [];
  bus.subscribe("*", (e) => events.push(e));
  const store = opts.store ?? new InMemoryMemoryStore();
  const sessions = new InMemorySessionRepository();
  const suggestions = new SuggestionsDirectory(new InMemoryFileSystem(), ".voidrift/suggestions");
  const deps: MemoryDeps = {
    store,
    bus,
    sessions,
    suggestions,
    getBounds: () => ({ entryChars: opts.entryChars ?? 2200, projectChars: 8000, reflectionBatchSize: 3 }),
    discoverProjectFiles: async () => opts.projectFiles ?? [],
    readSessionTurns: async () => opts.turns ?? [],
    ...(opts.draftSkillFromSequence ? { draftSkillFromSequence: opts.draftSkillFromSequence } : {}),
    ...(opts.getContextLimit ? { getContextLimit: opts.getContextLimit } : {}),
    ...(opts.limits ? { limits: opts.limits } : {}),
    ...(opts.listSkillBodies ? { listSkillBodies: opts.listSkillBodies } : {}),
    ...(opts.onApproveSkill ? { onApproveSkill: opts.onApproveSkill } : {}),
    ...(opts.projectCharsConfigured ? { projectCharsConfigured: opts.projectCharsConfigured } : {}),
    ...(opts.getContextWindow ? { getContextWindow: opts.getContextWindow } : {}),
    ...(opts.projectDigest ? { projectDigest: opts.projectDigest } : {}),
  };
  return { memory: new Memory(deps), bus, events, store, sessions };
}

describe("§6.3/§6.4 — verified writes and bounds", () => {
  it("a user-model write at the bound succeeds and is read-back confirmed", async () => {
    const { memory, events } = harness({ entryChars: 2200 });
    const res = await memory.write({ title: "Prefs", type: "user-model", scope: "workspace", body: "x".repeat(2200) });
    expect(res.ok).toBe(true);
    expect(events.filter((e) => e.type === "MEMORY_SAVED")).toHaveLength(1);
  });

  it("a write one char over the bound is rejected MEMORY_BOUND_EXCEEDED and emits no event", async () => {
    const { memory, events } = harness({ entryChars: 2200 });
    const res = await memory.write({ title: "Prefs", type: "user-model", scope: "workspace", body: "x".repeat(2201) });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("MEMORY_BOUND_EXCEEDED");
      expect(res.error.details).toMatchObject({ size: 2201, limit: 2200 });
    }
    expect(events.filter((e) => e.type === "MEMORY_SAVED")).toHaveLength(0);
  });

  it("identity is uncapped", async () => {
    const { memory } = harness({ entryChars: 10 });
    const res = await memory.write({ title: "Me", type: "identity", scope: "workspace", body: "y".repeat(5000) });
    expect(res.ok).toBe(true);
  });

  it("a non-persisting write returns MEMORY_WRITE_UNVERIFIED and emits no MEMORY_SAVED", async () => {
    // A store whose put is a no-op → read-back fails.
    const store = new InMemoryMemoryStore();
    store.put = async () => undefined;
    const { memory, events } = harness({ store });
    const res = await memory.write({ title: "Ghost", type: "note", scope: "workspace", body: "did not persist" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("MEMORY_WRITE_UNVERIFIED");
    expect(events.filter((e) => e.type === "MEMORY_SAVED")).toHaveLength(0);
  });
});

describe("§6.2/§6.4 — typed loading, keyword surfacing, delete/load events", () => {
  it("always-loaded types feed the Void layer; identity is inline", async () => {
    const { memory } = harness();
    await memory.write({ title: "Me", type: "identity", scope: "workspace", body: "I am the user" });
    await memory.write({ title: "Style", type: "user-model", scope: "workspace", body: "concise" });
    await memory.write({ title: "Lesson", type: "note", scope: "workspace", body: "a lesson", keywords: ["deploy"] });
    expect(memory.identityText()).toContain("I am the user");
    expect(memory.directiveEntries().map((e) => e.title)).toEqual(["Style"]);
    // The note is a reference manifest line, not always-loaded.
    expect(memory.referenceIndex().map((r) => r.key)).toEqual(["lesson"]);
    expect(memory.alwaysLoaded().some((e) => e.type === "note")).toBe(false);
  });

  it("a note surfaces only on a keyword match and emits MEMORY_LOADED", async () => {
    const { memory, events } = harness();
    await memory.write({ title: "Deploy note", type: "note", scope: "workspace", body: "deploy with care", keywords: ["deploy.sh"] });
    expect(memory.surfaceByKeywords("unrelated query")).toEqual([]);
    const surfaced = memory.surfaceByKeywords("run deploy.sh now");
    expect(surfaced.map((e) => e.id)).toEqual(["deploy-note"]);
    expect(events.filter((e) => e.type === "MEMORY_LOADED")).toHaveLength(1);
  });

  it("load/unload are no-ops when unknown or already in state (§6.4)", async () => {
    const { memory, events } = harness();
    memory.load("nope");
    memory.unload("nope");
    expect(events.filter((e) => e.type === "MEMORY_LOADED")).toHaveLength(0);
    expect(events.filter((e) => e.type === "MEMORY_UNLOADED")).toHaveLength(0);
  });

  it("delete removes, unloads, and emits MEMORY_DELETED (§6.4)", async () => {
    const { memory, events } = harness();
    await memory.write({ title: "Lesson", type: "note", scope: "workspace", body: "b", keywords: ["x"] });
    memory.surfaceByKeywords("x");
    expect(memory.isLoaded("lesson")).toBe(true);
    const res = await memory.delete("lesson");
    expect(res.ok).toBe(true);
    expect(memory.isLoaded("lesson")).toBe(false);
    expect(memory.read("lesson").ok).toBe(false);
    expect(events.filter((e) => e.type === "MEMORY_DELETED")).toHaveLength(1);
  });

  it("workspace overrides a global entry by id on reindex (§6.2)", async () => {
    const store = new InMemoryMemoryStore();
    const mk = (scope: string, body: string) =>
      `---\nid: dup\ntitle: Dup\ntype: note\nscope: ${scope}\nkeywords: []\n---\n${body}`;
    await store.put(["memory", "global"], "dup", { markdown: mk("global", "global body") });
    await store.put(["memory", "workspace"], "dup", { markdown: mk("workspace", "workspace body") });
    const { memory } = harness({ store });
    await memory.reindex();
    expect(memory.read("dup").ok).toBe(true);
    const dto = memory.read("dup");
    if (dto.ok) expect(dto.value.body).toBe("workspace body");
  });

  it("reindex drops a loaded reference id no longer on disk (§6.2)", async () => {
    const store = new InMemoryMemoryStore();
    const { memory, events } = harness({ store });
    await memory.write({ title: "Gone", type: "note", scope: "workspace", body: "b", keywords: ["x"] });
    memory.surfaceByKeywords("x");
    await store.delete(["memory", "workspace"], "gone");
    await memory.reindex();
    expect(memory.isLoaded("gone")).toBe(false);
    expect(events.filter((e) => e.type === "MEMORY_UNLOADED").length).toBeGreaterThan(0);
  });
});

describe("§6.5 — cross-session recall", () => {
  it("matches session names, summaries, and turn content; never deletes", async () => {
    const { memory, sessions } = harness({
      turns: [{ sessionId: "s2", turn: 1, userInput: "deploy the service", assistantText: "done", toolsUsed: [] }],
    });
    const now = new Date().toISOString();
    await sessions.save({
      metadata: { id: "s1", name: "payments work", summary: "fixed billing", workspace: "/ws", startedAt: now, lastActiveAt: now, turnCount: 1, sizeBytes: 0, namePinned: false },
      documents: [], pending: [], sessionRules: [], approvalMode: "interactive", lastStatus: "completed",
    });
    await sessions.save({
      metadata: { id: "s2", name: "misc", summary: "nothing", workspace: "/ws", startedAt: now, lastActiveAt: now, turnCount: 1, sizeBytes: 0, namePinned: false },
      documents: [], pending: [], sessionRules: [], approvalMode: "interactive", lastStatus: "completed",
    });
    const byName = await memory.recall("payments");
    expect(byName.map((h) => h.sessionId)).toContain("s1");
    const byTurn = await memory.recall("deploy");
    expect(byTurn.map((h) => h.sessionId)).toContain("s2");
    // Still present — recall never deletes.
    expect((await sessions.list()).length).toBe(2);
  });
});

describe("§6.6 — project context", () => {
  it("merges most-specific-last and stops at the project bound", async () => {
    const { memory } = harness({
      projectFiles: [
        { path: "AGENTS.md", content: "root", depth: 0, scope: "workspace" },
        { path: "pkg/AGENTS.md", content: "nested", depth: 1, scope: "workspace" },
      ],
    });
    const ctx = await memory.projectContext();
    expect(ctx.full.indexOf("nested")).toBeGreaterThan(ctx.full.indexOf("root"));
    expect(ctx.digest.length).toBeGreaterThan(0);
  });
});

describe("§6.7 — reflection → suggestions → approve, with dedup", () => {
  const detector = () => [
    { kind: "memory-note" as const, title: "Use pnpm", body: "Always use pnpm", keywords: ["pnpm"] },
  ];

  it("writes a candidate to the suggestions dir and NEVER to the store autonomously", async () => {
    const { memory } = harness({ turns: [{ sessionId: "s1", turn: 1, userInput: "x", assistantText: "y", toolsUsed: [] }] });
    const written = await memory.reflect("s1", detector, () => "fixed");
    expect(written).toHaveLength(1);
    // Not in the memory store yet.
    expect(memory.list()).toHaveLength(0);
    expect((await memory.listSuggestions())[0]!.status).toBe("pending");
  });

  it("writes to the store ONLY after approve (§6.7)", async () => {
    const { memory, events } = harness({ turns: [{ sessionId: "s1", turn: 1, userInput: "x", assistantText: "y", toolsUsed: [] }] });
    const [sug] = await memory.reflect("s1", detector, () => "fixed");
    const res = await memory.approveSuggestion(sug!.id);
    expect(res.ok).toBe(true);
    expect(memory.list().map((e) => e.title)).toEqual(["Use pnpm"]);
    expect(events.filter((e) => e.type === "MEMORY_SAVED")).toHaveLength(1);
  });

  it("reject marks rejected and never writes (§6.7)", async () => {
    const { memory } = harness({ turns: [{ sessionId: "s1", turn: 1, userInput: "x", assistantText: "y", toolsUsed: [] }] });
    const [sug] = await memory.reflect("s1", detector, () => "fixed");
    await memory.rejectSuggestion(sug!.id);
    expect((await memory.listSuggestions())[0]!.status).toBe("rejected");
    expect(memory.list()).toHaveLength(0);
  });

  it("deduplicates a candidate matching an existing memory body (§6.7)", async () => {
    const { memory } = harness({ turns: [{ sessionId: "s1", turn: 1, userInput: "x", assistantText: "y", toolsUsed: [] }] });
    await memory.write({ title: "Existing", type: "note", scope: "workspace", body: "Always use pnpm" });
    const written = await memory.reflect("s1", detector, () => "fixed");
    expect(written).toHaveLength(0);
  });

  it("swallows a per-batch detector failure as best-effort (§6.7)", async () => {
    const { memory } = harness({ turns: [{ sessionId: "s1", turn: 1, userInput: "x", assistantText: "y", toolsUsed: [] }] });
    const written = await memory.reflect("s1", () => {
      throw new Error("boom");
    });
    expect(written).toEqual([]);
  });

  it("approve/reject of an unknown or non-pending suggestion errors (§6.7)", async () => {
    const { memory } = harness({ turns: [{ sessionId: "s1", turn: 1, userInput: "x", assistantText: "y", toolsUsed: [] }] });
    expect((await memory.approveSuggestion("nope")).ok).toBe(false);
    expect((await memory.rejectSuggestion("nope")).ok).toBe(false);
    const [sug] = await memory.reflect("s1", detector, () => "fixed");
    await memory.approveSuggestion(sug!.id);
    // Already approved → a second approve is rejected.
    expect((await memory.approveSuggestion(sug!.id)).ok).toBe(false);
  });

  it("reflects with no turns and no readSessionTurns dep (empty best-effort)", async () => {
    const bus = new EventBus();
    const memory = new Memory({
      store: new InMemoryMemoryStore(),
      bus,
      sessions: new InMemorySessionRepository(),
      suggestions: new SuggestionsDirectory(new InMemoryFileSystem(), ".voidrift/suggestions"),
      getBounds: () => ({ entryChars: 2200, projectChars: 8000, reflectionBatchSize: 3 }),
      discoverProjectFiles: async () => [],
    });
    expect(await memory.reflect("s1", () => [])).toEqual([]);
  });

  it("approving a skill candidate hands SKILL.md + assets to the callback (§6.7, §12.1)", async () => {
    const { memory } = harness({ turns: [{ sessionId: "s1", turn: 1, userInput: "x", assistantText: "y", toolsUsed: [] }] });
    let got: { title: string; body: string; assets?: { path: string; content: string }[] } | undefined;
    memory.setApproveSkill(async (c) => {
      got = c;
      return { ok: true as const, value: { name: "built-step" } };
    });
    const skillDetector = () => [
      {
        kind: "skill" as const,
        title: "Build step",
        body: "run the build",
        assets: [{ path: "scripts/run.sh", content: "#!/bin/sh\nnpm run build\n" }],
      },
    ];
    const [sug] = await memory.reflect("s1", skillDetector, () => "fixed");
    const res = await memory.approveSuggestion(sug!.id);
    expect(res.ok).toBe(true);
    expect(got?.title).toBe("Build step");
    expect(got?.assets).toEqual([{ path: "scripts/run.sh", content: "#!/bin/sh\nnpm run build\n" }]);
  });

  it("an invalid asset refuses approval and writes nothing — callback never runs (§6.7)", async () => {
    const { memory } = harness({ turns: [{ sessionId: "s1", turn: 1, userInput: "x", assistantText: "y", toolsUsed: [] }] });
    let called = false;
    memory.setApproveSkill(async () => {
      called = true;
      return { ok: true as const, value: {} };
    });
    const badDetector = () => [
      { kind: "skill" as const, title: "Bad", body: "b", assets: [{ path: "../escape", content: "x" }] },
    ];
    const [sug] = await memory.reflect("s1", badDetector, () => "fixed");
    const res = await memory.approveSuggestion(sug!.id);
    expect(res.ok).toBe(false);
    expect(called).toBe(false);
    // The suggestion stays pending — nothing partial.
    expect((await memory.listSuggestions())[0]!.status).toBe("pending");
  });

  it("deduplicates a candidate matching an existing skill's SKILL.md body (§6.7)", async () => {
    const { memory } = harness({ turns: [{ sessionId: "s1", turn: 1, userInput: "x", assistantText: "y", toolsUsed: [] }] });
    (memory as unknown as { deps: { listSkillBodies: () => Promise<string[]> } }).deps.listSkillBodies = async () => [
      "run the build",
    ];
    const skillDetector = () => [{ kind: "skill" as const, title: "Build", body: "RUN the  build" }];
    const written = await memory.reflect("s1", skillDetector, () => "fixed");
    expect(written).toHaveLength(0);
  });
});

describe("§6 — reads, recall without turn-reader, and provider failure isolation", () => {
  it("read of an unknown id errors; delete of an unknown id errors", async () => {
    const { memory } = harness();
    expect(memory.read("nope").ok).toBe(false);
    expect((await memory.delete("nope")).ok).toBe(false);
  });

  it("recall without a turn reader matches names/summaries only (§6.5)", async () => {
    const bus = new EventBus();
    const sessions = new InMemorySessionRepository();
    const now = new Date().toISOString();
    await sessions.save({
      metadata: { id: "s1", name: "alpha", summary: "beta", workspace: "/ws", startedAt: now, lastActiveAt: now, turnCount: 0, sizeBytes: 0, namePinned: false },
      documents: [], pending: [], sessionRules: [], approvalMode: "interactive", lastStatus: "completed",
    });
    const memory = new Memory({
      store: new InMemoryMemoryStore(),
      bus,
      sessions,
      suggestions: new SuggestionsDirectory(new InMemoryFileSystem(), ".voidrift/suggestions"),
      getBounds: () => ({ entryChars: 2200, projectChars: 8000, reflectionBatchSize: 3 }),
      discoverProjectFiles: async () => [],
    });
    expect((await memory.recall("alpha")).map((h) => h.sessionId)).toEqual(["s1"]);
    expect(await memory.recall("nomatch")).toEqual([]);
  });

  it("provider syncTurn/extract/mirrorWrite failures are isolated and warn (§6.8)", async () => {
    const { memory, events } = harness();
    memory.setProvider({
      inject: async () => [],
      prefetch: async () => [],
      syncTurn: async () => { throw new Error("x"); },
      extract: async () => { throw new Error("x"); },
      mirrorWrite: async () => { throw new Error("x"); },
      tools: () => [],
    });
    await memory.providerSyncTurn({ sessionId: "s1", turn: 1, userInput: "u", assistantText: "a", toolsUsed: [] });
    await memory.providerExtract({ sessionId: "s1", name: "n", summary: "s", lastActiveAt: "t" });
    // A built-in write still succeeds even though the provider mirror throws.
    const res = await memory.write({ title: "T", type: "note", scope: "workspace", body: "b" });
    expect(res.ok).toBe(true);
    expect(events.filter((e) => e.type === "WARNING_EMITTED").length).toBeGreaterThanOrEqual(3);
  });

  it("provider inject/syncTurn/extract are no-ops with no provider registered (§6.8)", async () => {
    const { memory } = harness();
    expect(await memory.providerInject({ sessionId: "s1", turn: 1, userInput: "u" })).toEqual([]);
    await memory.providerSyncTurn({ sessionId: "s1", turn: 1, userInput: "u", assistantText: "a", toolsUsed: [] });
    await memory.providerExtract({ sessionId: "s1", name: "n", summary: "s", lastActiveAt: "t" });
    expect(memory.hasProvider()).toBe(false);
  });
});

describe("§6.7/§10.6 — reflectSequence: a repeated-sequence signal → ONE pending skill candidate", () => {
  const signal = {
    pattern: "read_file({path:string}) → search_contents({path:string}) → write_file({path:string})",
    steps: ["read_file({path:string})", "search_contents({path:string})", "write_file({path:string})"],
    count: 3,
    split: { within: 2, across: 1 },
    outcome: "success" as const,
    sessionIds: ["s0", "s1"],
  };

  it("builds a bounded evidence packet, calls the model ONCE, and writes one PENDING skill suggestion with a scripts/ asset", async () => {
    let calls = 0;
    let seenEvidence: unknown;
    const { memory } = harness({
      getContextLimit: () => 32768,
      draftSkillFromSequence: async (evidence) => {
        calls += 1;
        seenEvidence = evidence;
        return {
          title: "Grep Then Edit",
          body: "When reading a file, grepping it, then writing it recurs, run this.",
          assets: [{ path: "scripts/run.sh", content: "#!/bin/sh\necho hi\n" }],
        };
      },
    });
    const written = await memory.reflectSequence(signal, [
      { source: "tool", name: "read_file", status: "ok" },
    ]);
    expect(calls).toBe(1); // ONE model call per candidate
    expect(seenEvidence).toMatchObject({ steps: signal.steps, count: 3, outcome: "success", split: { within: 2, across: 1 } });
    expect(written).not.toBeNull();
    expect(written!.kind).toBe("skill");
    expect(written!.status).toBe("pending");
    // The whole suggestion is pending in the suggestions directory — nothing was
    // handed to the skills callback.
    const pending = await memory.listSuggestions();
    expect(pending.filter((s) => s.status === "pending")).toHaveLength(1);
  });

  it("reads memory.sequenceEvidenceFraction from the limits port to size the packet (M8 convert)", async () => {
    // A tiny effective fraction → a tiny maxChars → the evidence builder drops
    // example spans to fit. The in-code default (0.1) would keep them. Proving
    // the caller reads limits.get('memory.sequenceEvidenceFraction').
    let seen: { examples?: unknown[] } | undefined;
    const makeLimits = (fraction: number): MemoryDeps["limits"] =>
      ({ get: (k: string) => (k === "memory.sequenceEvidenceFraction" ? fraction : 0), hit: () => ({ notice: "", action: "warn", first: false }), resetTurn: () => {} });
    const spans = Array.from({ length: 6 }, () => ({ source: "tool", name: "read_file", status: "ok", argSummary: "x".repeat(50) }));

    const tiny = harness({
      getContextLimit: () => 32768,
      limits: makeLimits(0.00001),
      draftSkillFromSequence: async (ev) => {
        seen = ev as { examples?: unknown[] };
        return { title: "T", body: "b".repeat(40), assets: [{ path: "scripts/r.sh", content: "echo" }] };
      },
    });
    await tiny.memory.reflectSequence(signal, spans);
    const tinyExamples = (seen?.examples ?? []).length;

    const big = harness({
      getContextLimit: () => 32768,
      limits: makeLimits(0.1),
      draftSkillFromSequence: async (ev) => {
        seen = ev as { examples?: unknown[] };
        return { title: "T2", body: "c".repeat(40), assets: [{ path: "scripts/r.sh", content: "echo" }] };
      },
    });
    await big.memory.reflectSequence(signal, spans);
    const bigExamples = (seen?.examples ?? []).length;

    expect(tinyExamples).toBeLessThan(bigExamples);
  });

  it("a second identical boundary does not duplicate the candidate (dedup, §6.7)", async () => {
    const { memory } = harness({
      getContextLimit: () => 32768,
      draftSkillFromSequence: async () => ({
        title: "Grep Then Edit",
        body: "Same body both times, so the second is a duplicate.",
        assets: [{ path: "scripts/run.sh", content: "echo x" }],
      }),
    });
    const first = await memory.reflectSequence(signal, []);
    const second = await memory.reflectSequence(signal, []);
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // dropped by dedup against the pending suggestion
    const all = await memory.listSuggestions();
    expect(all).toHaveLength(1);
  });

  it("the detector path makes no model call when no draft seam is wired (writes nothing)", async () => {
    const { memory } = harness(); // no draftSkillFromSequence
    const written = await memory.reflectSequence(signal, []);
    expect(written).toBeNull();
    expect(await memory.listSuggestions()).toHaveLength(0);
  });

  it("a secret in the drafted body or asset never reaches the written suggestion (§10.10)", async () => {
    const secret = "sk-liv" + "e-ABCDEF1234567890";
    const { memory } = harness({
      getContextLimit: () => 32768,
      draftSkillFromSequence: async () => ({
        title: "Leaky Skill",
        body: `Use the key ${secret} to authenticate.`,
        assets: [{ path: "scripts/run.sh", content: `curl -H 'Authorization: Bearer ${secret}'` }],
      }),
    });
    const written = await memory.reflectSequence(signal, []);
    expect(written).not.toBeNull();
    const raw = JSON.stringify(await memory.listSuggestions());
    expect(raw).not.toContain(secret);
  });

  it("a candidate whose body matches an existing skill's SKILL.md body is dropped (dedup, §6.7)", async () => {
    const { memory } = harness({
      getContextLimit: () => 32768,
      listSkillBodies: async () => ["This exact body already lives in a skill."],
      draftSkillFromSequence: async () => ({
        title: "Dup Of A Skill",
        body: "This exact body already lives in a skill.",
      }),
    });
    const written = await memory.reflectSequence(signal, []);
    expect(written).toBeNull();
    expect(await memory.listSuggestions()).toHaveLength(0);
  });

  it("an invalid asset refuses the candidate and writes nothing", async () => {
    const { memory } = harness({
      getContextLimit: () => 32768,
      draftSkillFromSequence: async () => ({
        title: "Bad Asset",
        body: "Tries to escape the asset dir.",
        assets: [{ path: "../../etc/evil", content: "x" }],
      }),
    });
    const written = await memory.reflectSequence(signal, []);
    expect(written).toBeNull();
    expect(await memory.listSuggestions()).toHaveLength(0);
  });

  it("approving the pending candidate writes the skill directory via the callback (nothing before approval)", async () => {
    let wroteSkill: { title: string; assets?: unknown } | undefined;
    const { memory } = harness({
      getContextLimit: () => 32768,
      draftSkillFromSequence: async () => ({
        title: "Grep Then Edit",
        body: "A real procedure.",
        assets: [{ path: "scripts/run.sh", content: "echo hi" }],
      }),
      onApproveSkill: async (candidate) => {
        wroteSkill = { title: candidate.title, assets: candidate.assets };
        return { ok: true as const, value: { name: "grep-then-edit" } };
      },
    });
    const written = await memory.reflectSequence(signal, []);
    expect(written).not.toBeNull();
    expect(wroteSkill).toBeUndefined(); // nothing written to the skills dir yet
    const approved = await memory.approveSuggestion(written!.id);
    expect(approved.ok).toBe(true);
    expect(wroteSkill).toMatchObject({ title: "Grep Then Edit" });
    expect((wroteSkill!.assets as unknown[]).length).toBe(1);
  });
});
