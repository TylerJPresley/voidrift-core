/**
 * The Memory capability (core-blueprint.md §6) — the use-case layer.
 *
 * Owns typed memory with per-entry bounds and verified writes (§6.2–§6.4),
 * cross-session recall (§6.5), project context (§6.6), reflection → suggestions
 * (§6.7), and the one external memory provider that augments built-in memory
 * (§6.8). It writes through the `MemoryStore` port (§6.1), emits `MEMORY_*`
 * events on the bus (§14.6), and routes every provider payload through the
 * shared secret-mask seam (§10.10). It may depend on entity logic; no store
 * type crosses the facade (§2, §6.8).
 */
import type { EventBus } from "../entities/event-bus.js";
import type { LimitsPort } from "../entities/ports/limits-port.js";
import type { MemoryStore } from "../entities/ports/memory-store.js";
import type { SessionRepository } from "../entities/ports/session-repository.js";
import type { MemoryProvider, TurnContext, TurnRecord, SessionSummary } from "../entities/memory/memory-provider.js";
import {
  type MemoryEntry,
  type MemoryType,
  type MemoryScope,
  type MemoryIndex,
  ALWAYS_LOADED_TYPES,
  ENTRY_BOUNDED_TYPES,
  makeEntry,
  serializeEntry,
  parseEntry,
  entrySize,
  rankByKeywords,
  buildMemoryIndex,
  normalizeBody,
} from "../entities/memory/memory-entry.js";
import {
  type Suggestion,
  type SuggestionKind,
  type SkillAsset,
  toSuggestionDTO,
  type SuggestionDTO,
  isDuplicate,
  validateSkillAssets,
  type SequenceSignal,
  type SequenceEvidence,
  type SequenceExampleSpan,
  buildSequenceEvidence,
  SEQUENCE_EVIDENCE_MAX_CONTEXT_FRACTION,
  type FailureSignal,
} from "../entities/memory/suggestion.js";
import type { SuggestionsDirectory } from "../adapters/suggestions-directory.js";
import {
  assembleProjectHead,
  tokensToChars,
  type ProjectFile,
  type ProjectContext,
} from "../entities/memory/project-context.js";
import { coreError, err, ok, ErrorCode, type Result } from "../entities/errors.js";
import { contentHash as hashOf } from "../entities/hash.js";
import { maskValue } from "./secret-mask.js";
import { stripUnsafeChars } from "../entities/untrusted-text.js";

/** §6.2/§10.10 — drop control/bidi/ANSI characters from stored memory text so a
 * hand-edited entry file cannot inject a terminal escape into the head, the
 * TUI list line, or a tool result. Applied at write and again at render. */
function stripEntryText(s: string): string {
  return stripUnsafeChars(s);
}

/** A render-time stripped copy of an entry (§6.2); the stored entry is untouched. */
function renderSafeEntry(e: MemoryEntry): MemoryEntry {
  return {
    ...e,
    title: stripEntryText(e.title),
    summary: stripEntryText(e.summary),
    body: stripEntryText(e.body),
    keywords: e.keywords.map(stripEntryText),
  };
}

/** A DTO view of a memory entry across the facade (§2). */
export interface MemoryEntryDTO {
  id: string;
  title: string;
  summary: string;
  type: MemoryType;
  scope: MemoryScope;
  keywords: string[];
  body: string;
  /** True when the reference entry is currently loaded in context (§6.4). */
  loaded?: boolean;
}

/** A cross-session recall hit (§6.5). */
export interface RecallHit {
  sessionId: string;
  name: string;
  summary: string;
  lastActiveAt: string;
}

/** The bound-exceeded detail returned on a rejected write (§6.3). */
export interface BoundExceeded {
  id: string;
  size: number;
  limit: number;
}

export interface MemoryDeps {
  store: MemoryStore;
  bus: EventBus;
  sessions: SessionRepository;
  suggestions: SuggestionsDirectory;
  /** Config bounds (§6.3) resolved per call so a config edit takes effect. */
  getBounds: () => { entryChars: number; projectChars: number; reflectionBatchSize: number };
  /** Discover AGENTS.md files for project context (§6.6). */
  discoverProjectFiles: () => Promise<ProjectFile[]>;
  /** True when the user explicitly configured `limits.memory.projectChars`
   * (source is not the registry default). When true `projectContext()` uses that
   * char budget; when false it uses `ingest.fitFraction` × the window (§6.6/§4.8).
   * Absent → treated as unconfigured (the fit fraction wins when a window is
   * available, else the legacy `getBounds().projectChars`). */
  projectCharsConfigured?: () => boolean;
  /** The selected endpoint's context window in TOKENS, so the fit-test budget is
   * `ingest.fitFraction × window` converted to chars by the §4.8 estimator.
   * Absent → fall back to the explicit/legacy char bound. */
  getContextWindow?: () => number;
  /** Consult/produce the project-instructions ingest DIGEST (§8.7) for the merged
   * content `hash`. Returns the cached digest text on a HIT; on a MISS returns
   * null and kicks the ingest in the BACKGROUND (fire-and-forget) so the next
   * turn hits the cache. NON-BLOCKING: `projectContext()` never awaits a worker
   * fan-out. Absent in a headless/no-ingest build (the head carries the marked
   * head only, §8.7). */
  projectDigest?: (merged: string, hash: string) => string | null;
  /** Optional limits port (§13.11). When present, `memory.projectChars` is read
   * from the registry and a LIMIT_HIT is emitted when the merge truncates. The
   * exemplar for the limits foundation; parallel implementers wire the same way
   * per area. Absent in callers not yet migrated (falls back to `getBounds`). */
  limits?: LimitsPort;
  /** Read the turn records for a session boundary (§6.7); the §10 record is a
   * clean seam — slice 4 reads what session metadata/the event record supplies. */
  readSessionTurns?: (sessionId: string) => Promise<TurnRecord[]>;
  /** Existing skills' SKILL.md bodies, for reflection dedup (§6.7). Optional;
   * when absent, dedup is against memory entries and pending suggestions only. */
  listSkillBodies?: () => Promise<string[]>;
  /**
   * Turn an approved `skill` candidate into a skill (§6.7, §12.1). The Memory
   * capability never writes a skill itself — the Skills capability does — so boot
   * wires this callback. It receives the proposed SKILL.md (title/body) together
   * with its validated asset files; boot writes the WHOLE directory under the
   * chosen scope through the protected-path ask. A `memory-note` candidate
   * instead writes through the verified memory path.
   */
  onApproveSkill?: (candidate: { title: string; body: string; assets?: SkillAsset[] }) => Promise<Result<unknown>>;
  /**
   * Draft a skill candidate from a repeated-sequence evidence packet (§6.7, §10.6).
   * Called ONCE per candidate by `reflectSequence`. Model-agnostic seam (like the
   * summarizer, §4.9): boot binds it to the configured endpoint with a prompt that
   * treats the evidence as DATA, phrases a `failure` outcome as a guard/alternative
   * and a `success` outcome as a script. Returns the proposed SKILL.md title/body
   * plus `scripts/` assets, or null when the model declines. Detection stays
   * model-free; only this seam calls a model. */
  draftSkillFromSequence?: (
    evidence: SequenceEvidence,
  ) => Promise<{ title: string; body: string; assets?: SkillAsset[] } | null>;
  /**
   * Draft a MEMORY-NOTE candidate from a repeated FAILURE shape (§6.7, §10.6).
   * Called ONCE per failure signature by `reflectFailure`. Model-agnostic seam
   * bound by boot to the transient utility endpoint (same path as the sequence
   * draft). The evidence is DATA (tool/error display names + redacted arg
   * summaries); the draft is phrased as 'what failed and what to do instead'.
   * Returns the note title/body, or null when the model declines. */
  draftMemoryNoteFromFailure?: (evidence: {
    kind: "tool_error" | "guardian_block";
    tool: string;
    errorClass: string;
    count: number;
    sessionIds: string[];
    argExamples: string[];
  }) => Promise<{ title: string; body: string } | null>;
  /** The selected endpoint's `contextLimit`, so the evidence packet is bounded to
   * a small fraction of it (§6.7). Defaults to 32768 when absent. */
  getContextLimit?: () => number;
}

function namespace(scope: MemoryScope): string[] {
  return ["memory", scope];
}

function toDTO(entry: MemoryEntry, loaded: boolean): MemoryEntryDTO {
  // §6.2 — strip control/bidi/ANSI at render too: `list_memory` and the TUI list
  // read a DTO, and a hand-edited on-disk entry bypasses the write-time strip.
  return {
    ...entry,
    title: stripEntryText(entry.title),
    summary: stripEntryText(entry.summary),
    body: stripEntryText(entry.body),
    keywords: entry.keywords.map(stripEntryText),
    loaded,
  };
}

/**
 * The memory capability. Holds the in-memory index of parsed entries (built at
 * boot and re-indexed on external edit, §6.2), the loaded-reference set, and the
 * one optional external provider (§6.8).
 */
export class Memory {
  /** All entries by id, workspace overriding global (§6.2). */
  private index = new Map<string, MemoryEntry>();
  /** The ids of reference (`note`) entries currently loaded in context (§6.4). */
  private readonly loaded = new Set<string>();
  /** The one external provider that augments built-in memory (§6.8). */
  private provider?: MemoryProvider;

  constructor(private readonly deps: MemoryDeps) {}

  /** Wire the approve-skill callback after construction (§6.7, §12.1). */
  setApproveSkill(cb: (candidate: { title: string; body: string; assets?: SkillAsset[] }) => Promise<Result<unknown>>): void {
    this.deps.onApproveSkill = cb;
  }

  // ── indexing (§6.2) ────────────────────────────────────────────────────────

  /**
   * (Re)build the index from the store (§6.2): both scopes, workspace overriding
   * global by id. Always-loaded types reload; loaded reference ids no longer on
   * disk drop. Called at boot and on an external edit.
   */
  async reindex(): Promise<void> {
    const next = new Map<string, MemoryEntry>();
    // Global first, then workspace, so a workspace entry overrides a global one
    // by id (§6.2).
    for (const scope of ["global", "workspace"] as MemoryScope[]) {
      for (const item of await this.deps.store.list(namespace(scope))) {
        const parsed = parseEntry(String(item.value["markdown"] ?? ""));
        if (parsed) next.set(parsed.id, { ...parsed, scope });
      }
    }
    this.index = next;
    // Drop loaded reference ids no longer on disk (§6.2).
    for (const id of [...this.loaded]) {
      if (!next.has(id)) {
        this.loaded.delete(id);
        this.deps.bus.emit("MEMORY_UNLOADED", { id }, {});
      }
    }
  }

  // ── typed loading into the Void layer (§6.2, §4.6) ───────────────────────────

  /** The always-loaded entries (identity, user-model, project) rendered inline
   * or as digests into the Void layer each turn (§6.2). */
  alwaysLoaded(): MemoryEntry[] {
    return [...this.index.values()].filter((e) => ALWAYS_LOADED_TYPES.has(e.type));
  }

  /** The identity memory body, inline every turn (§6.2, §4.2.1 tier 1). */
  identityText(): string {
    return this.alwaysLoaded()
      .filter((e) => e.type === "identity")
      .map((e) => stripEntryText(e.body))
      .join("\n\n");
  }

  /** The directive-beyond-identity entries (user-model) as digest+pointer
   * sources (§4.2.1 tier 2). */
  directiveEntries(): MemoryEntry[] {
    return this.alwaysLoaded()
      .filter((e) => e.type === "user-model")
      .map(renderSafeEntry);
  }

  /** The reference-memory index lines for the Void-layer manifest (§6.2 tier 3). */
  referenceIndex(): { key: string; keywords: string[] }[] {
    return [...this.index.values()]
      .filter((e) => e.type === "note")
      .map((e) => ({ key: e.id, keywords: e.keywords }));
  }

  /**
   * Surface reference (`note`) entries for a turn by weighted keyword discovery
   * (§6.2): filename (4.0×) > extension (3.0×) > plain (2.5×), zero-scored
   * excluded, ranked. Loading a surfaced entry emits `MEMORY_LOADED` (§6.4).
   */
  surfaceByKeywords(query: string): MemoryEntry[] {
    const notes = [...this.index.values()].filter((e) => e.type === "note");
    const ranked = rankByKeywords(notes, query);
    const surfaced = ranked.map((r) => r.entry);
    for (const e of surfaced) this.load(e.id);
    // §10.10 — render stripped copies; the stored entry and the `load()` side
    // effect use the real id.
    return surfaced.map(renderSafeEntry);
  }

  /** Load a reference entry into context; no-op when unknown or already loaded (§6.4). */
  load(id: string): void {
    if (!this.index.has(id)) return;
    if (this.loaded.has(id)) return;
    this.loaded.add(id);
    this.deps.bus.emit("MEMORY_LOADED", { id }, {});
  }

  /** Unload a reference entry; no-op when unknown or not loaded (§6.4). */
  unload(id: string): void {
    if (!this.loaded.has(id)) return;
    this.loaded.delete(id);
    this.deps.bus.emit("MEMORY_UNLOADED", { id }, {});
  }

  isLoaded(id: string): boolean {
    return this.loaded.has(id);
  }

  // ── verified writes + bounds (§6.3, §6.4) ────────────────────────────────────

  /**
   * Write an entry with a verified read-back (§6.4) and the per-entry bound
   * check (§6.3). Over-bound returns `MEMORY_BOUND_EXCEEDED` before any write; a
   * read-back mismatch returns `MEMORY_WRITE_UNVERIFIED` and emits NO event. On
   * success emits `MEMORY_SAVED { id, title, type }` and mirrors to the provider.
   */
  async write(input: {
    title: string;
    type: MemoryType;
    scope: MemoryScope;
    body: string;
    id?: string;
    summary?: string;
    keywords?: string[];
    sourceSessionId?: string;
  }): Promise<Result<MemoryEntryDTO>> {
    // §10.10 — strip control/bidi/ANSI from every stored field BEFORE building
    // the entry, so a saved entry can never carry a terminal escape sequence.
    const entry = makeEntry({
      ...input,
      title: stripEntryText(input.title),
      body: stripEntryText(input.body),
      ...(input.summary !== undefined ? { summary: stripEntryText(input.summary) } : {}),
      ...(input.keywords ? { keywords: input.keywords.map(stripEntryText) } : {}),
    });

    // §6.3/§13.11 — bound check at write time for every bounded type. The
    // `memory.entryChars` key is registered `warn`: an over-length entry is
    // ACCEPTED in full with ONE LIMIT_HIT naming the key; a configured
    // `{action:"deny"}` refuses before any persist with the same notice (the
    // MEMORY_BOUND_EXCEEDED shape). No port wired → warn default (accept).
    if (ENTRY_BOUNDED_TYPES.has(entry.type)) {
      const limit = this.deps.limits ? this.deps.limits.get("memory.entryChars") : this.deps.getBounds().entryChars;
      const size = entrySize(entry);
      if (size > limit) {
        const r = this.deps.limits?.hit("memory.entryChars", size, { what: `memory entry ${entry.id} is ${size} chars, over the ${limit} limit` });
        if (r?.action === "deny") {
          return err(
            coreError(ErrorCode.MEMORY_BOUND_EXCEEDED, r.notice, {
              details: { id: entry.id, size, limit } satisfies BoundExceeded,
            }),
          );
        }
      }
    }

    // §6.4 — persist, then re-read and confirm it parses with the expected id +
    // type BEFORE reporting success.
    const ns = namespace(entry.scope);
    await this.deps.store.put(ns, entry.id, { markdown: serializeEntry(entry) });
    const readBack = await this.deps.store.get(ns, entry.id);
    const parsed = readBack ? parseEntry(String(readBack.value["markdown"] ?? "")) : null;
    if (!parsed || parsed.id !== entry.id || parsed.type !== entry.type) {
      return err(
        coreError(ErrorCode.MEMORY_WRITE_UNVERIFIED, `write of ${entry.id} did not take — read-back failed`, {
          details: { id: entry.id },
        }),
      );
    }

    this.index.set(entry.id, { ...parsed, scope: entry.scope });
    this.deps.bus.emit("MEMORY_SAVED", { id: entry.id, title: entry.title, type: entry.type }, {});
    await this.mirrorToProvider(entry);
    return ok(toDTO(this.index.get(entry.id)!, this.loaded.has(entry.id)));
  }

  /** Delete an entry: remove from storage, unload from context, emit
   * `MEMORY_DELETED` (§6.4). */
  async delete(id: string): Promise<Result<{ id: string }>> {
    const entry = this.index.get(id);
    if (!entry) return err(coreError(ErrorCode.NOT_FOUND, `memory ${id} not found`));
    await this.deps.store.delete(namespace(entry.scope), id);
    this.index.delete(id);
    if (this.loaded.has(id)) this.loaded.delete(id);
    this.deps.bus.emit("MEMORY_DELETED", { id }, {});
    return ok({ id });
  }

  // ── the in-turn write tool policy (§6.2, §6.4) ───────────────────────────────

  /**
   * The `save_memory` model-facing write (§6.2). It writes ONLY the two
   * agent-owned types: a call naming `identity` or `project` is hard-refused with
   * `MEMORY_TYPE_FORBIDDEN` and NOTHING is persisted — regardless of any allow
   * rule, `unlisted: allow` agent, session approval or fan-out grant (the type
   * guard is in the tool, upstream of the permission gate). `type` defaults to
   * `note`, `scope` to `workspace`. Body and summary are secret-scrubbed by the
   * shared detector (§10.10) BEFORE write; the write is deduplicated against
   * existing entries and pending suggestions by normalized body (§6.7); it is
   * then bounded (§6.3) and read-back-verified (§6.4) through `write`, and
   * carries `sourceSessionId` for provenance. A duplicate returns the existing
   * entry without a second write.
   */
  async saveInTurn(input: {
    title: string;
    body?: string;
    summary?: string;
    keywords?: string[];
    type?: string;
    scope?: MemoryScope;
    sourceSessionId?: string;
  }): Promise<Result<MemoryEntryDTO>> {
    // §6.2/§6.4 — the type guard is the single source of truth: an absent type
    // defaults to `note`; ONLY the two agent-owned types (`user-model`, `note`)
    // are writable. Anything else — `identity`/`project` (user-/project-owned),
    // an unknown word, or a wrong-case/whitespace variant — is HARD-REFUSED with
    // the documented typed `MEMORY_TYPE_FORBIDDEN` naming the two writable types,
    // and NOTHING is persisted. The exact-match check (no trimming, no
    // lowercasing) means `'Note'` and `' note'` are refused too, so the model
    // gets a precise, typed error rather than a silent coercion.
    const type = input.type ?? "note";
    if (type !== "user-model" && type !== "note") {
      return err(
        coreError(
          ErrorCode.MEMORY_TYPE_FORBIDDEN,
          `save_memory cannot write '${type}'; it writes only 'user-model' and 'note'`,
          { details: { type, writable: ["user-model", "note"] } },
        ),
      );
    }
    const body = maskValue(input.body ?? "") as string;
    const summarySource = input.summary && input.summary.trim() !== "" ? input.summary : body || input.title;
    const summary = maskValue(summarySource) as string;
    // §10.10 — title and keywords are secret-masked too (they reload into the
    // head and the TUI list line every turn, not only body/summary).
    const title = maskValue(input.title) as string;
    const keywords = input.keywords ? (maskValue(input.keywords) as string[]) : undefined;
    // §6.7 — dedup against existing memory bodies and pending suggestions.
    const pending = (await this.deps.suggestions.listPending()).map((s) => s.body);
    const existing = [...this.index.values()];
    if (isDuplicate({ body }, existing.map((e) => e.body), pending)) {
      const dup = existing.find((e) => normalizeBody(e.body) === normalizeBody(body));
      if (dup) return ok(toDTO(dup, this.loaded.has(dup.id)));
    }
    return this.write({
      title,
      type,
      scope: input.scope ?? "workspace",
      body,
      summary,
      ...(keywords ? { keywords } : {}),
      ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
    });
  }

  // ── the memory index (§4.6, §6.2) ────────────────────────────────────────────

  /**
   * The always-present memory index (§4.6, §6.2): one `summary` line per
   * agent-written entry (`user-model`, `note`), bounded to an internal 5% of
   * `contextLimit`. When full, the OLDEST entries demote to keyword-only (still
   * stored, still keyword-discoverable, still loadable by id) and reappear when
   * room returns. Delegates to the pure `buildMemoryIndex`.
   */
  memoryIndex(contextLimit: number): MemoryIndex {
    const capPct = this.deps.limits ? this.deps.limits.get("memory.indexCapPct") : undefined;
    const idx = buildMemoryIndex([...this.index.values()], contextLimit, capPct);
    // §10.10 — strip control/bidi/ANSI at render: the active summaries ride the
    // head every turn and may come from a hand-edited on-disk entry.
    return {
      active: idx.active.map((l) => ({
        ...l,
        summary: stripEntryText(l.summary),
        keywords: l.keywords.map(stripEntryText),
      })),
      demoted: idx.demoted,
    };
  }

  /** Surface an agent-written entry by id (the `list_memory`/recall load-by-id
   * path, §6.2): returns the entry (and loads a `note` reference) or null. A
   * demoted entry stays loadable here. */
  surfaceById(id: string): MemoryEntry | null {
    const entry = this.index.get(id);
    if (!entry) return null;
    if (entry.type === "note") this.load(id);
    return entry;
  }

  // ── facade reads (§2 DTOs) ───────────────────────────────────────────────────

  list(): MemoryEntryDTO[] {
    return [...this.index.values()].map((e) => toDTO(e, this.loaded.has(e.id)));
  }

  read(id: string): Result<MemoryEntryDTO> {
    const entry = this.index.get(id);
    if (!entry) return err(coreError(ErrorCode.NOT_FOUND, `memory ${id} not found`));
    return ok(toDTO(entry, this.loaded.has(id)));
  }

  // ── cross-session recall (§6.5) ──────────────────────────────────────────────

  /**
   * Search session names, summaries, and turn content across the workspace's
   * sessions (§6.5). Reads sessions on disk; never deletes. Returns the id, name,
   * summary, and last-active time of each match.
   */
  async recall(query: string): Promise<RecallHit[]> {
    const q = query.toLowerCase();
    const metas = await this.deps.sessions.list();
    const hits: RecallHit[] = [];
    for (const m of metas) {
      let matched = m.name.toLowerCase().includes(q) || m.summary.toLowerCase().includes(q);
      if (!matched && this.deps.readSessionTurns) {
        const turns = await this.deps.readSessionTurns(m.id).catch(() => [] as TurnRecord[]);
        matched = turns.some(
          (t) => t.userInput.toLowerCase().includes(q) || t.assistantText.toLowerCase().includes(q),
        );
      }
      if (matched) {
        hits.push({ sessionId: m.id, name: m.name, summary: m.summary, lastActiveAt: m.lastActiveAt });
      }
    }
    return hits;
  }

  // ── project context (§6.6) ───────────────────────────────────────────────────

  /**
   * Load AGENTS.md as project context (§6.6, §4.8, §8.7). Discover, merge
   * most-specific-last (the WHOLE content, never cut), and size the HEAD against
   * a budget: the explicit `limits.memory.projectChars` when the user set it,
   * else the SAME fit test as any content — `limits.ingest.fitFraction` × the
   * endpoint window converted to chars by the §4.8 estimator. When the merge fits
   * the head budget it rides the head WHOLE; when it does not, the head carries
   * the cached ingest DIGEST (or, on the first turn before one is cached, a marked
   * head) plus the overflow marker naming `limits.ingest.fitFraction`, and the
   * ingest is kicked in the BACKGROUND (interactive only; never blocks the turn,
   * never started headless). One LIMIT_HIT names the key on overflow.
   */
  async projectContext(): Promise<ProjectContext> {
    const files = await this.deps.discoverProjectFiles();
    const budget = this.projectHeadBudgetChars();
    // Consult the digest cache FIRST so a cached digest rides the head; a miss
    // kicks the ingest in the background (fire-and-forget) — the turn is never
    // blocked on a worker fan-out (§8.7).
    const full = assembleProjectHead(files, budget, null).full;
    const cached = this.deps.projectDigest ? this.deps.projectDigest(full, hashOf(full)) : null;
    const ctx = assembleProjectHead(files, budget, cached);
    if (ctx.overflow && this.deps.limits) {
      // Name the explicit char key when the user set it, else the ingest
      // fit-fraction key that drove the budget — the one the user would raise.
      const key = this.projectCharsConfigured() ? "memory.projectChars" : "ingest.fitFraction";
      this.deps.limits.hit(key, ctx.full.length, { what: "project instructions exceed the head budget; a digest rides the head" });
    }
    return ctx;
  }

  /** True when the user explicitly configured `limits.memory.projectChars`. */
  private projectCharsConfigured(): boolean {
    return this.deps.projectCharsConfigured ? this.deps.projectCharsConfigured() : false;
  }

  /** The head char budget for project instructions (§6.6/§4.8/§8.7): the explicit
   * `memory.projectChars` when configured, else the SAME fit test as any content
   * — `ingest.fitFraction` × the endpoint window (tokens → chars). Falls back to
   * the legacy char bound when no window/port is wired. */
  private projectHeadBudgetChars(): number {
    const configured = this.projectCharsConfigured();
    if (!configured && this.deps.limits && this.deps.getContextWindow) {
      const fraction = this.deps.limits.get("ingest.fitFraction");
      const windowTokens = this.deps.getContextWindow();
      const budget = Math.floor(tokensToChars(Math.floor(fraction * windowTokens)));
      if (budget > 0) return budget;
    }
    return this.deps.limits ? this.deps.limits.get("memory.projectChars") : this.deps.getBounds().projectChars;
  }

  // ── reflection + suggestions (§6.7) ──────────────────────────────────────────

  /**
   * Reflect at a session boundary (§6.7): read the available turn records,
   * detect candidates, and write non-duplicate ones to the suggestions directory.
   * NEVER creates a memory or skill autonomously. Batches by
   * `memoryReflectionBatchSize` and swallows a per-batch failure as best-effort.
   */
  async reflect(
    sessionId: string,
    detect: (turns: TurnRecord[]) => { kind: SuggestionKind; title: string; body: string; keywords?: string[]; memoryType?: MemoryType; memoryScope?: MemoryScope; assets?: SkillAsset[] }[],
    now: () => string = () => new Date().toISOString(),
  ): Promise<SuggestionDTO[]> {
    const turns = this.deps.readSessionTurns ? await this.deps.readSessionTurns(sessionId).catch(() => [] as TurnRecord[]) : [];
    const batchSize = this.deps.getBounds().reflectionBatchSize;
    const written: SuggestionDTO[] = [];
    // §6.7 — dedup against existing memory bodies AND existing skills' SKILL.md
    // bodies so the same lesson is never surfaced twice.
    const skillBodies = this.deps.listSkillBodies ? await this.deps.listSkillBodies().catch(() => [] as string[]) : [];
    const existingBodies = [...this.index.values()].map((e) => e.body).concat(skillBodies);

    for (let i = 0; i < turns.length || i === 0; i += batchSize) {
      const batch = turns.slice(i, i + batchSize);
      try {
        const candidates = detect(batch);
        for (const c of candidates) {
          const pending = (await this.deps.suggestions.listPending()).map((s) => s.body);
          // §6.7 — deduplicate against existing bodies AND pending suggestions; a
          // duplicate is dropped, never written.
          if (isDuplicate(c, existingBodies, pending)) continue;
          // §6.7/§10.10 — mask secrets in asset contents BEFORE the suggestion is
          // written to disk.
          const assets = c.assets?.map((a) => ({ path: a.path, content: maskValue(a.content) as string }));
          const suggestion: Suggestion = {
            id: `sug-${now()}-${written.length}`,
            kind: c.kind,
            title: c.title,
            body: maskValue(c.body) as string,
            keywords: c.keywords ?? [],
            memoryType: c.memoryType ?? "note",
            memoryScope: c.memoryScope ?? "workspace",
            ...(assets && assets.length > 0 ? { assets } : {}),
            status: "pending",
            sourceSessionId: sessionId,
            createdAt: now(),
          };
          await this.deps.suggestions.save(suggestion);
          written.push(toSuggestionDTO(suggestion));
        }
      } catch {
        // Best-effort: a per-batch failure is swallowed (§6.7).
      }
      if (turns.length === 0) break;
    }
    return written;
  }

  /**
   * Consume a repeated-sequence signal from the detector (§10.6) and draft ONE
   * pending skill candidate (§6.7). Called from the ObsWriter's `onSequenceSignal`
   * seam at the moment the sequence fires. The flow:
   *   1. Build a bounded evidence packet (step signatures, counts, split, outcome,
   *      sessions, a few trimmed example spans) — capped to a small fraction of the
   *      endpoint's `contextLimit` so it fits a 32k window. The packet carries no
   *      literal argument values (the detector stripped them) and no span input/
   *      output (only `{source,name,status}`), so no secret rides along.
   *   2. Call the reflection model ONCE per candidate (model-free detection stays
   *      upstream). A missing seam or a declined/failed draft writes nothing.
   *   3. Mask the drafted body + asset contents (§10.10), dedup against existing
   *      memory bodies, skills' SKILL.md bodies and pending suggestions (§6.7),
   *      validate assets and caps (§6.7), and write a PENDING skill suggestion
   *      only — nothing reaches the skills directory until `approveSuggestion`.
   * Best-effort: any failure is swallowed so a reflection miss never disturbs a
   * turn. Returns the written suggestion DTO, or null when nothing was written.
   */
  async reflectSequence(
    signal: SequenceSignal,
    exampleSpans: SequenceExampleSpan[] = [],
    now: () => string = () => new Date().toISOString(),
  ): Promise<SuggestionDTO | null> {
    if (!this.deps.draftSkillFromSequence) return null;
    try {
      const contextLimit = this.deps.getContextLimit?.() ?? 32768;
      // §13.11 — the evidence-packet fraction is the registry key
      // `memory.sequenceEvidenceFraction`; the in-code constant is the fallback
      // default when no limits port is wired (behaviour byte-identical at default).
      const fraction = this.deps.limits?.get("memory.sequenceEvidenceFraction") ?? SEQUENCE_EVIDENCE_MAX_CONTEXT_FRACTION;
      // Chars ≈ 4× tokens; bound to a fraction of the window in TOKENS → chars.
      const maxChars = Math.floor(contextLimit * fraction * 4);
      // §13.11 `sequence.evidenceExamplesPerStep` — live cap on redacted arg
      // examples per step; the registry default applies when no port is wired.
      const maxArgsPerStep = this.deps.limits?.get("sequence.evidenceExamplesPerStep");
      const evidence = buildSequenceEvidence(signal, exampleSpans, maxChars, maxArgsPerStep);
      // §6.7 — ONE model call per candidate.
      const draft = await this.deps.draftSkillFromSequence(evidence);
      if (!draft) return null;

      const body = maskValue(draft.body) as string;
      // §6.7 — dedup against memory bodies, skills' bodies and pending suggestions.
      const skillBodies = this.deps.listSkillBodies ? await this.deps.listSkillBodies().catch(() => [] as string[]) : [];
      const existingBodies = [...this.index.values()].map((e) => e.body).concat(skillBodies);
      const pending = (await this.deps.suggestions.listPending()).map((s) => s.body);
      if (isDuplicate({ body }, existingBodies, pending)) return null;

      // §6.7/§10.10 — mask asset contents BEFORE the suggestion is written.
      const assets = draft.assets?.map((a) => ({ path: a.path, content: maskValue(a.content) as string }));
      // §6.7 — validate assets and caps up front; a bad asset writes nothing.
      const invalid = validateSkillAssets(assets);
      if (invalid) return null;

      const suggestion: Suggestion = {
        id: `sug-seq-${now()}`,
        kind: "skill",
        title: draft.title,
        body,
        keywords: [],
        memoryType: "note",
        memoryScope: "workspace",
        ...(assets && assets.length > 0 ? { assets } : {}),
        // §10.6 Lifecycle — persist the sequence signature so the detector never
        // re-signals a signature that already has a pending/approved suggestion.
        signature: signal.pattern,
        status: "pending",
        sourceSessionId: signal.sessionIds[signal.sessionIds.length - 1] ?? "",
        createdAt: now(),
      };
      await this.deps.suggestions.save(suggestion);
      return toSuggestionDTO(suggestion);
    } catch {
      // Best-effort (§6.7): a reflection failure never disturbs the turn.
      return null;
    }
  }
  /**
   * Consume a repeated-FAILURE signal from the trace analyzer (§10.6) and draft
   * ONE pending MEMORY-NOTE candidate (§6.7), phrased as 'what failed and what to
   * do instead'. Mirrors `reflectSequence`: ONE model call, mask the drafted
   * body, dedup against memory bodies and pending suggestions, and write a
   * PENDING note suggestion carrying the failure SIGNATURE so the same signature
   * never re-surfaces (suppressed by the pending/approved/rejected machinery,
   * §10.6 Lifecycle). Best-effort: any failure is swallowed. Returns the written
   * suggestion DTO, or null when nothing was written (no seam, declined draft,
   * duplicate, or an already-pending/approved/rejected signature).
   */
  async reflectFailure(
    signal: FailureSignal,
    now: () => string = () => new Date().toISOString(),
  ): Promise<SuggestionDTO | null> {
    if (!this.deps.draftMemoryNoteFromFailure) return null;
    try {
      // §10.6 Lifecycle — a signature that already has a pending/approved
      // suggestion, or was rejected, is never re-drafted.
      const existing = await this.deps.suggestions.list();
      const suppressed = new Set<string>(await this.deps.suggestions.rejectedSignatures().catch(() => [] as string[]));
      for (const s of existing) {
        if ((s.status === "pending" || s.status === "approved") && s.signature) suppressed.add(s.signature);
      }
      if (suppressed.has(signal.signature)) return null;

      const draft = await this.deps.draftMemoryNoteFromFailure({
        kind: signal.kind,
        tool: signal.tool,
        errorClass: signal.errorClass,
        count: signal.count,
        sessionIds: signal.sessionIds,
        argExamples: signal.argExamples,
      });
      if (!draft) return null;

      const body = maskValue(draft.body) as string;
      // §6.7 — dedup against memory bodies and pending suggestions.
      const existingBodies = [...this.index.values()].map((e) => e.body);
      const pending = existing.filter((s) => s.status === "pending").map((s) => s.body);
      if (isDuplicate({ body }, existingBodies, pending)) return null;

      const suggestion: Suggestion = {
        id: `sug-fail-${now()}`,
        kind: "memory-note",
        title: draft.title,
        body,
        keywords: [],
        memoryType: "note",
        memoryScope: "workspace",
        // §10.6 Lifecycle — the failure signature, so a drafted/approved/rejected
        // note suppresses re-signalling for that signature.
        signature: signal.signature,
        status: "pending",
        sourceSessionId: signal.sessionIds[signal.sessionIds.length - 1] ?? "",
        createdAt: now(),
      };
      await this.deps.suggestions.save(suggestion);
      return toSuggestionDTO(suggestion);
    } catch {
      return null;
    }
  }


  /** List suggestions (§6.7). */
  async listSuggestions(): Promise<SuggestionDTO[]> {    return (await this.deps.suggestions.list()).map(toSuggestionDTO);
  }

  /**
   * Approve a suggestion (§6.7): ONLY now is it written to its store. A
   * `memory-note` candidate becomes a `note` entry through the verified write
   * path. A `skill` candidate — its SKILL.md and asset files — is validated and
   * handed to the approve-skill callback, which writes the whole directory under
   * the chosen scope through the protected-path ask (§9). The user's explicit
   * approval IS the human decision; nothing is written for an unapproved
   * suggestion. On a validation failure NOTHING is written and the suggestion
   * stays pending. Returns the written entry DTO for a memory-note.
   */
  async approveSuggestion(id: string): Promise<Result<SuggestionDTO>> {
    const s = await this.deps.suggestions.get(id);
    if (!s) return err(coreError(ErrorCode.NOT_FOUND, `suggestion ${id} not found`));
    if (s.status !== "pending") {
      return err(coreError(ErrorCode.INVALID_INPUT, `suggestion ${id} is already ${s.status}`));
    }
    if (s.kind === "memory-note") {
      const write = await this.write({
        title: s.title,
        type: s.memoryType,
        scope: s.memoryScope,
        body: s.body,
        keywords: s.keywords,
      });
      if (!write.ok) return err(write.error);
    } else if (s.kind === "skill") {
      // §6.7 — validate the candidate's assets BEFORE any write; a bad asset
      // refuses the approval and writes nothing.
      const invalid = validateSkillAssets(s.assets);
      if (invalid) {
        return err(coreError(ErrorCode.INVALID_INPUT, `skill suggestion ${id} has an invalid asset: ${invalid}`));
      }
      // Only now does an approved skill candidate become a skill (§6.7, §12.1).
      if (this.deps.onApproveSkill) {
        const written = await this.deps.onApproveSkill({
          title: s.title,
          body: s.body,
          ...(s.assets ? { assets: s.assets } : {}),
        });
        if (!written.ok) return err(written.error);
      }
    }
    s.status = "approved";
    await this.deps.suggestions.save(s);
    return ok(toSuggestionDTO(s));
  }

  /** Reject a suggestion (§6.7): marked rejected, never written to any store. A
   * sequence suggestion's signature is remembered per workspace (§10.6
   * Lifecycle) so the declined procedure never re-surfaces. */
  async rejectSuggestion(id: string): Promise<Result<SuggestionDTO>> {
    const s = await this.deps.suggestions.get(id);
    if (!s) return err(coreError(ErrorCode.NOT_FOUND, `suggestion ${id} not found`));
    s.status = "rejected";
    await this.deps.suggestions.save(s);
    // §10.6 Lifecycle — remember the rejected sequence signature so a procedure
    // the user declined is never signalled again (best-effort; a persist failure
    // never fails the rejection).
    if (s.signature) {
      await this.deps.suggestions.rememberRejectedSignature(s.signature).catch(() => undefined);
    }
    return ok(toSuggestionDTO(s));
  }

  // ── memory provider contract (§6.8) ──────────────────────────────────────────

  /** Register the one external provider (§6.8). Built-in memory always runs. */
  setProvider(provider: MemoryProvider): void {
    this.provider = provider;
  }

  hasProvider(): boolean {
    return this.provider !== undefined;
  }

  /**
   * Call `inject` on the provider with a SECRET-SCRUBBED turn context (§6.8,
   * §10.10). A provider failure is logged as a warning and never crashes the
   * session; built-in memory continues unaffected.
   */
  async providerInject(context: TurnContext): Promise<{ id: string; content: string }[]> {
    if (!this.provider) return [];
    const scrubbed = maskValue(context) as unknown as TurnContext;
    try {
      return await this.provider.inject(scrubbed);
    } catch (e) {
      this.warnProvider("inject", e);
      return [];
    }
  }

  /** Call `syncTurn` with a secret-scrubbed record (§6.8). Best-effort. */
  async providerSyncTurn(turn: TurnRecord): Promise<void> {
    if (!this.provider) return;
    const scrubbed = maskValue(turn) as unknown as TurnRecord;
    try {
      await this.provider.syncTurn(scrubbed);
    } catch (e) {
      this.warnProvider("syncTurn", e);
    }
  }

  /** Call `extract` with a secret-scrubbed summary (§6.8). Best-effort. */
  async providerExtract(summary: SessionSummary): Promise<void> {
    if (!this.provider) return;
    const scrubbed = maskValue(summary) as unknown as SessionSummary;
    try {
      await this.provider.extract(scrubbed);
    } catch (e) {
      this.warnProvider("extract", e);
    }
  }

  /** Mirror a built-in write to the provider with a scrubbed entry (§6.8). */
  private async mirrorToProvider(entry: MemoryEntry): Promise<void> {
    if (!this.provider) return;
    const scrubbed = maskValue(entry) as unknown as MemoryEntry;
    try {
      await this.provider.mirrorWrite(scrubbed);
    } catch (e) {
      this.warnProvider("mirrorWrite", e);
    }
  }

  private warnProvider(method: string, e: unknown): void {
    this.deps.bus.emit(
      "WARNING_EMITTED",
      { category: "memory-provider", source: method, pattern: String(e) },
      {},
    );
  }
}
