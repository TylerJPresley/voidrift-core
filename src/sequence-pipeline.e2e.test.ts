/**
 * End-to-end repeated-sequence pipeline (core-blueprint.md §6.7/§10.6).
 *
 * Wires the PRODUCTION chain the way boot does — ObsWriter (detection) →
 * `onSequenceSignal` → Memory.reflectSequence (draft via a scripted model) →
 * SuggestionsDirectory (pending suggestion) → approve (skills callback) /
 * reject (remembered signature) → suppressed-signature seed (never re-signals).
 *
 * The same mutating three-step procedure (read_file → execute_command →
 * write_file) runs across three distinct sessions and must raise EXACTLY ONE
 * signal; at idle the flow drafts ONE pending skill suggestion (SKILL.md + a
 * scripts/ asset) listed by the suggestions API the `/memory` panel uses;
 * approving it writes the directory through the skills callback and the same
 * procedure thereafter never signals again; rejecting remembers the signature.
 */
import { describe, it, expect } from "vitest";
import { EventBus } from "./entities/event-bus.js";
import { ObsWriter } from "./use-cases/obs-writer.js";
import { Memory } from "./use-cases/memory.js";
import { SuggestionsDirectory } from "./adapters/suggestions-directory.js";
import { InMemoryFileSystem } from "./adapters/in-memory-filesystem.js";
import { InMemoryMemoryStore } from "./adapters/repositories/in-memory-memory-store.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
import type { ObsLogStore } from "./entities/ports/obs-log-store.js";
import type { SessionRepository } from "./entities/ports/session-repository.js";
import type { SessionMetadata } from "./entities/session.js";
import type { SkillAsset } from "./entities/memory/suggestion.js";

/** A shared, persistent obs store so a prior session's trail can be replayed for
 * cross-session sequence seeding (as the real store allows). */
function sharedStore(): ObsLogStore & { ids: () => string[] } {
  const ws = new Map<string, string[]>();
  return {
    ids: () => [...ws.keys()],
    async appendWorkspace(id, line) {
      (ws.get(id) ?? ws.set(id, []).get(id)!).push(line);
    },
    async appendGlobal() {},
    async readWorkspace(id) {
      return [...(ws.get(id) ?? [])].reverse();
    },
  };
}

/** A minimal sessions repo whose `list()` returns the prior traces newest-first,
 * so the writer seeds each new session's detector from them (§10.6). */
function fakeSessions(order: string[]): SessionRepository {
  return {
    async save() {},
    async load() {
      return null;
    },
    async list() {
      // newest-active first (§2.4)
      return [...order].reverse().map((id) => ({ id, workspace: "/ws" }) as SessionMetadata);
    },
    async delete() {},
  } as unknown as SessionRepository;
}

/** Wire ObsWriter + Memory + SuggestionsDirectory exactly as boot does. */
function wire(draftCalls: { n: number }, order: string[]) {
  const bus = new EventBus();
  const fs = new InMemoryFileSystem();
  const suggestions = new SuggestionsDirectory(fs, ".voidrift/suggestions");
  const skillsWritten: { title: string; assets?: SkillAsset[] }[] = [];
  const memory = new Memory({
    store: new InMemoryMemoryStore(),
    bus,
    sessions: new InMemorySessionRepository(),
    suggestions,
    getBounds: () => ({ entryChars: 2200, projectChars: 8000, reflectionBatchSize: 3 }),
    discoverProjectFiles: async () => [],
    readSessionTurns: async () => [],
    getContextLimit: () => 32768,
    // The scripted reflection model: one SKILL.md body + a scripts/ asset.
    draftSkillFromSequence: async () => {
      draftCalls.n += 1;
      return {
        title: "Read, Run, Write",
        body: "When reading a file, running a command, then writing a file recurs, do X.",
        assets: [{ path: "scripts/run.sh", content: "#!/bin/sh\necho go\n" }],
      };
    },
    // Approve writes the whole skill directory (boot binds this to the skills
    // capability's protected-path ask).
    onApproveSkill: async (candidate) => {
      skillsWritten.push({ title: candidate.title, ...(candidate.assets ? { assets: candidate.assets } : {}) });
      return { ok: true, value: undefined } as const;
    },
  });
  const writer = new ObsWriter({
    bus,
    store: sharedStore(),
    sessions: fakeSessions(order),
    getLevel: () => "info",
    getSuggestionThreshold: () => 3,
    getSequenceMaxLen: () => 6,
    getSuppressedSignatures: () => suggestions.suppressedSignatures(),
    onSequenceSignal: (signal, examples) =>
      memory
        .reflectSequence(
          signal,
          examples.map((s) => {
            const args = (s.attributes as Record<string, unknown> | undefined)?.["args"];
            return {
              source: s.source,
              name: s.name,
              status: s.status,
              ...(args !== undefined ? { argSummary: JSON.stringify(args).slice(0, 200) } : {}),
            };
          }),
        )
        .catch(() => undefined),
  });
  writer.start();
  return { bus, writer, memory, suggestions, skillsWritten };
}

/** A completed tool span through the writer's callback surface (pending→ok). */
function tool(writer: ObsWriter, trace: string, span: string, name: string, args: unknown) {
  writer.writeFromCallback({ traceId: trace, spanId: span, source: "tool", name, status: "pending", input: args });
  writer.writeFromCallback({ traceId: trace, spanId: span, source: "tool", name, status: "ok" });
}

/** Run the mutating 3-step procedure once in a session trace, one turn. */
function runProcedure(writer: ObsWriter, trace: string, round: number) {
  writer.beginSequenceTurn(trace);
  tool(writer, trace, `${trace}-${round}-1`, "read_file", { path: "config.ts" });
  tool(writer, trace, `${trace}-${round}-2`, "execute_command", { command: "npm test" });
  tool(writer, trace, `${trace}-${round}-3`, "write_file", { path: "config.ts", content: "x" });
}

describe("§6.7/§10.6 — repeated-sequence pipeline, end to end", () => {
  it("three sessions → ONE signal → ONE pending skill suggestion → approve writes it → no re-signal", async () => {
    const draftCalls = { n: 0 };
    const order: string[] = [];
    const { bus, writer, memory, suggestions, skillsWritten } = wire(draftCalls, order);
    const signals: Record<string, unknown>[] = [];
    bus.subscribe("WARNING_EMITTED", (e) => {
      const p = e.payload as Record<string, unknown>;
      if (p["source"] === "sequence-detector") signals.push(p);
    });

    // Three DISTINCT sessions, the same procedure once each. Each session seeds
    // its detector from the prior sessions' trails at the boundary (the
    // production call site), so the distinct-session figure grows 1 → 2 → 3.
    for (const [i, trace] of ["s1", "s2", "s3"].entries()) {
      await writer.seedSequencesFromPriorSessions(trace);
      runProcedure(writer, trace, i);
      await writer.flush();
      await writer.drainSequenceCandidates(trace);
      order.push(trace); // becomes a prior session for the next
    }

    // EXACTLY ONE signal across the three sessions, message reads "seen in 3 sessions".
    expect(signals).toHaveLength(1);
    expect(String(signals[0]!["message"])).toContain("seen in 3 sessions");
    // ONE model draft call, ONE pending skill suggestion.
    expect(draftCalls.n).toBe(1);
    const pending = (await memory.listSuggestions()).filter((s) => s.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.kind).toBe("skill");

    // The suggestion record carries the sequence signature (lifecycle key).
    const full = await suggestions.get(pending[0]!.id);
    expect(full?.signature).toBeTruthy();
    expect(full?.assets?.some((a) => a.path.startsWith("scripts/"))).toBe(true);

    // Approve writes the directory through the skills callback.
    const approved = await memory.approveSuggestion(pending[0]!.id);
    expect(approved.ok).toBe(true);
    expect(skillsWritten).toHaveLength(1);
    expect(skillsWritten[0]!.assets?.[0]!.path).toBe("scripts/run.sh");

    // A FOURTH session of the same procedure raises NO new signal: the approved
    // signature is suppressed at the seed boundary.
    signals.length = 0;
    await writer.seedSequencesFromPriorSessions("s4");
    runProcedure(writer, "s4", 3);
    await writer.flush();
    await writer.drainSequenceCandidates("s4");
    expect(signals).toHaveLength(0);
  });

  it("rejecting a sequence suggestion remembers the signature; the procedure never re-signals", async () => {
    const draftCalls = { n: 0 };
    const order: string[] = [];
    const { bus, writer, memory, suggestions } = wire(draftCalls, order);
    const signals: Record<string, unknown>[] = [];
    bus.subscribe("WARNING_EMITTED", (e) => {
      const p = e.payload as Record<string, unknown>;
      if (p["source"] === "sequence-detector") signals.push(p);
    });

    for (const [i, trace] of ["a1", "a2", "a3"].entries()) {
      await writer.seedSequencesFromPriorSessions(trace);
      runProcedure(writer, trace, i);
      await writer.flush();
      await writer.drainSequenceCandidates(trace);
      order.push(trace);
    }
    const pending = (await memory.listSuggestions()).filter((s) => s.status === "pending");
    expect(pending).toHaveLength(1);

    // Reject it → the signature is remembered per workspace.
    const rejected = await memory.rejectSuggestion(pending[0]!.id);
    expect(rejected.ok).toBe(true);
    const remembered = await suggestions.rejectedSignatures();
    expect(remembered).toHaveLength(1);

    // A later session of the same procedure never re-signals.
    signals.length = 0;
    await writer.seedSequencesFromPriorSessions("a4");
    runProcedure(writer, "a4", 3);
    await writer.flush();
    await writer.drainSequenceCandidates("a4");
    expect(signals).toHaveLength(0);
  });
});
