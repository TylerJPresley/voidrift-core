/**
 * The limits registry (core-blueprint.md §13.11, §13.10 limits rows).
 *
 * The single source of truth for every rigid limit (size, count, time, ratio)
 * that bounds behaviour. Owner principle (2026-10-21): "any rigid limit HAS to
 * be a configuration point. No hidden limits." Each limit is one row here with a
 * stable dotted key (`area.name`), its default (= today's value), a unit, a
 * class (`tunable` | `safety`), validated `min`/`max` bounds, and a one-line doc.
 *
 * This is a PURE entity: a plain table and lookup helpers, no I/O and no ports.
 * The config schema (`config/schema.ts`), `/config`, `voidrift doctor`, the
 * mechanical guard (`scripts/check-limits.mjs`), and the runtime `LimitsPort`
 * all read this one table so they see the identical set.
 *
 * Layering (enforced in the config cascade, §13.11): a `tunable` limit overrides
 * normally (narrower layer wins). A `safety` limit may be SET by the global or
 * managed layer; a PROJECT value is honored only if it LOWERS the effective
 * value (never raises it), and a managed layer may pin a ceiling a lower layer
 * can only tighten. The registry carries the classification; the cascade applies
 * the rule.
 *
 * Every row maps 1:1 to an id in the hidden-limits inventory maintained outside this repository
 * (the `inv` field), so the completeness guard can prove each inventoried limit
 * has a key. Keys NOT yet wired to their call site are still registered now so
 * the schema, `/config`, doctor and the guard see the full set; parallel
 * implementers convert call sites area by area on top of this foundation.
 */

/** The unit a limit is measured in (display + doctor sanity). */
export type LimitUnit = "bytes" | "chars" | "lines" | "count" | "ms" | "seconds" | "ratio";

/** `tunable` — any layer may change it (narrower wins). `safety` — a project may
 * only LOWER it; raising is honored only from global/managed (§13.11, inventory
 * part c). `integrity` — the inverse of `safety`: a project/session may only
 * RAISE it (never lower below the effective global/managed value or the registry
 * default), so an untrusted project config cannot weaken an audit/restore
 * guarantee (shrink the mutation journal, disable rollback). */
export type LimitClass = "tunable" | "safety" | "integrity";

/** The default action when a limit is exceeded: `warn` (continue + notice) or
 * `deny` (refuse the request). A limit warns by default; it denies only when
 * going past it would crash the run or let a request reach something it
 * shouldn't (§13.11). */
export type LimitAction = "warn" | "deny";

/** One registry row. `key` is the dotted `area.name`; `inv` is the inventory id. */
export interface LimitSpec {
  key: string;
  area: string;
  default: number;
  unit: LimitUnit;
  class: LimitClass;
  action: LimitAction;
  min: number;
  max: number;
  doc: string;
  /** The inventory id (hidden-limits-inventory.md) this row implements. */
  inv: string;
  /** A legacy top-level config key that already controls the same value. When
   * set, `resolveLimits` reads `limits.<key>` first, else this legacy key's
   * value in the same layer, else the default — and reports the source as the
   * legacy key's layer/file with `aliasOf: <legacy key>`. The registry is then
   * the SINGLE reader and every consumer reads through the port, never the
   * legacy key directly (§13.11). */
  alias?: string;
  /** This key is enforced at schema-validation time (before the limits
   * capability exists) and has no separate runtime `limits.get` consumer. The
   * inert-key guard accepts the row on this marker with the one-line reason.
   * The value is the reason. */
  schemaTimeOnly?: string;
  /** This key legitimately has no runtime consumer that calls `limits.get` (it
   * is read another way the guard cannot see). The value is the one-line
   * reason the guard accepts. */
  noRuntimeConsumer?: string;
  /** This key is read ONLY through `limitDefault(...)` (the registry default) and
   * has no live port consumer, so a `limits.<key>` override does NOT change
   * behaviour. Rare and explained: the value is the one-line reason. `/config`
   * and `voidrift doctor` mark such a key "default only" so the UI never claims a
   * live knob (§13.11, "no hidden limits"). The inert/default-only guards accept
   * the row on this marker. */
  noLiveOverride?: string;
}

const B = 1;
const KIB = 1024;
const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

/**
 * The registry table. Grouped by area for readability; the dotted `key` is
 * authoritative. Defaults equal today's in-code values. `safety` marks a row a
 * project layer may only tighten (security/DoS bounds, inventory part c).
 *
 * To ADD a limit: add one row here (key `area.name`, default = current value,
 * sensible min/max, class, doc, inventory id) and remove the matching
 * `scripts/limits-allowlist.json` entry when its call site is converted.
 */
export const LIMITS: readonly LimitSpec[] = [
  // --- context (A) ---
  { key: "context.estimateMarginTokens", area: "context", default: 2000, unit: "count", class: "tunable", action: "warn", min: 0, max: 100_000, doc: "Token-estimate safety margin.", inv: "CTX5" },
  { key: "context.defaultOutputReservation", area: "context", default: 1024, unit: "count", class: "tunable", action: "warn", min: 1, max: 1_000_000, doc: "Default output-token reservation when a model sets none.", inv: "CTX7" },
  { key: "context.summaryBudgetFloor", area: "context", default: 2000, unit: "count", class: "tunable", action: "warn", min: 0, max: 1_000_000, doc: "Minimum token budget for a compaction summary.", inv: "CTX8" },
  { key: "context.excerptLineMaxChars", area: "context", default: 2000, unit: "chars", class: "tunable", action: "warn", min: 1, max: 1_000_000, doc: "Per-line cap in an evicted-tool-result excerpt.", inv: "CTX12" },

  // --- turn (A) ---
  { key: "turn.shutdownGraceMs", area: "turn", default: 5000, unit: "ms", class: "tunable", action: "warn", min: 0, max: 600_000, doc: "Grace period before a hard turn shutdown.", inv: "CTX20", alias: "turnShutdownGraceMs" },

  // --- toolRounds (A, §3.3/§3.6) ---
  { key: "toolRounds.recursionMargin", area: "toolRounds", default: 5, unit: "count", class: "tunable", action: "warn", min: 0, max: 1000, doc: "Additive margin in the derived LangGraph recursion limit (2*rounds + margin).", inv: "CTX14a" },
  { key: "toolRounds.recursionFactor", area: "toolRounds", default: 2, unit: "count", class: "tunable", action: "warn", min: 1, max: 100, doc: "Multiplier on rounds in the derived LangGraph recursion limit (factor*rounds + margin).", inv: "CTX14b" },
  { key: "toolRounds.wrapUpRatio", area: "toolRounds", default: 0.8, unit: "ratio", class: "tunable", action: "warn", min: 0, max: 1, doc: "Fraction of the tool-round budget at which the wrap-up note is appended.", inv: "CTX13a" },

  // --- lane (B) ---
  { key: "lane.writeCallsPerTurn", area: "lane", default: 8, unit: "count", class: "tunable", action: "deny", min: 1, max: 1000, doc: "Direct write calls a delegating top-level agent may make per turn.", inv: "LANE1" },
  { key: "lane.distinctTargetsPerTurn", area: "lane", default: 5, unit: "count", class: "tunable", action: "deny", min: 1, max: 1000, doc: "Distinct direct write targets per turn.", inv: "LANE2" },
  { key: "lane.writeContextShare", area: "lane", default: 0.35, unit: "ratio", class: "tunable", action: "deny", min: 0, max: 1, doc: "Write-lane tool-result share of the context window before blocking.", inv: "LANE3" },
  { key: "lane.readCallsPerTurn", area: "lane", default: 8, unit: "count", class: "tunable", action: "warn", min: 1, max: 1000, doc: "Direct read calls per turn before the read-lane nudge.", inv: "LANE4" },
  { key: "lane.readContextShare", area: "lane", default: 0.25, unit: "ratio", class: "tunable", action: "warn", min: 0, max: 1, doc: "Read-lane tool-result share of the context window before the nudge.", inv: "LANE5" },

  // --- tools (C) ---
  { key: "tools.workspaceMaxFiles", area: "tools", default: 20000, unit: "count", class: "tunable", action: "warn", min: 1, max: 10_000_000, doc: "Max files enumerated in the workspace surface.", inv: "TOOL3" },
  { key: "tools.readMaxLines", area: "tools", default: 2000, unit: "count", class: "tunable", action: "warn", min: 1, max: 10_000_000, doc: "read_file: max lines returned in one call (a ranged read is never refused for size below this).", inv: "TOOL1" },
  { key: "tools.workspaceFileMaxBytes", area: "tools", default: 1 * MIB, unit: "bytes", class: "tunable", action: "warn", min: 1, max: 1 * GIB, doc: "Per-file byte cap in the workspace surface.", inv: "TOOL4" },
  { key: "tools.commandOutputMaxBytes", area: "tools", default: 100_000, unit: "bytes", class: "tunable", action: "warn", min: 1, max: 1 * GIB, doc: "Command stdout/stderr byte cap before truncation.", inv: "TOOL5" },
  { key: "tools.commandTimeoutMs", area: "tools", default: 120_000, unit: "ms", class: "tunable", action: "deny", min: 1, max: 86_400_000, doc: "Command execution timeout (execute_command / wait poll).", inv: "TOOL6" },
  { key: "tools.commandKillGraceMs", area: "tools", default: 500, unit: "ms", class: "tunable", action: "warn", min: 0, max: 600_000, doc: "Grace before a hard kill of a timed-out command.", inv: "TOOL7" },
  { key: "tools.commandHeadLines", area: "tools", default: 100, unit: "count", class: "tunable", action: "warn", min: 0, max: 1_000_000, doc: "execute_command: head lines kept inline when oversized output is stored by reference.", inv: "TOOL8" },
  { key: "tools.commandTailLines", area: "tools", default: 50, unit: "count", class: "tunable", action: "warn", min: 0, max: 1_000_000, doc: "execute_command: tail lines kept inline when oversized output is stored by reference.", inv: "TOOL9" },
  { key: "tools.webFetchInlineMax", area: "tools", default: 5000, unit: "chars", class: "tunable", action: "warn", min: 1, max: 10_000_000, doc: "web_fetch: full text inlined up to this length.", inv: "TOOL10" },
  { key: "tools.webFetchPreview", area: "tools", default: 2000, unit: "chars", class: "tunable", action: "warn", min: 1, max: 10_000_000, doc: "web_fetch: preview length when over the inline max.", inv: "TOOL11" },
  { key: "tools.webFetchMinExtract", area: "tools", default: 200, unit: "chars", class: "tunable", action: "warn", min: 1, max: 10_000_000, doc: "web_fetch: minimum extracted text length.", inv: "TOOL12" },
  { key: "tools.webFetchBodyMaxBytes", area: "tools", default: 5 * MIB, unit: "bytes", class: "safety", action: "deny", min: 1, max: 1 * GIB, doc: "web_fetch: response body byte cap (DoS bound).", inv: "TOOL13" },
  { key: "tools.webFetchMaxHops", area: "tools", default: 5, unit: "count", class: "safety", action: "deny", min: 0, max: 50, doc: "web_fetch: max redirect hops (SSRF bound).", inv: "TOOL14" },
  { key: "tools.webSearchMaxResults", area: "tools", default: 8, unit: "count", class: "tunable", action: "warn", min: 1, max: 100, doc: "web_search: max results returned to the model.", inv: "TOOL16" },
  { key: "tools.searchFallbackMax", area: "tools", default: 100, unit: "count", class: "tunable", action: "warn", min: 1, max: 10_000, doc: "search_contents: on a content-search timeout, max results from the glob-based filename fallback (§8.2).", inv: "TOOL16" },
  { key: "tools.searchTimeoutMs", area: "tools", default: 10_000, unit: "ms", class: "tunable", action: "deny", min: 1000, max: 600_000, doc: "search_contents: wall-clock budget before falling back to the glob-based filename search (§8.2).", inv: "TOOL16" },
  { key: "tools.webSearchSnippetMax", area: "tools", default: 1000, unit: "chars", class: "tunable", action: "warn", min: 1, max: 100_000, doc: "web_search: per-result snippet cap.", inv: "TOOL17" },
  { key: "tools.webSearchTitleMax", area: "tools", default: 300, unit: "chars", class: "tunable", action: "warn", min: 1, max: 100_000, doc: "web_search: per-result title cap.", inv: "TOOL17b" },
  { key: "tools.webSearchBodyMaxBytes", area: "tools", default: 2 * MIB, unit: "bytes", class: "safety", action: "deny", min: 1, max: 1 * GIB, doc: "web_search: body byte cap (DoS bound).", inv: "TOOL18" },
  { key: "tools.imageMaxBytes", area: "tools", default: 5 * MIB, unit: "bytes", class: "safety", action: "deny", min: 1, max: 1 * GIB, doc: "Per-image byte cap on an attachment (DoS bound).", inv: "TOOL20a" },
  { key: "tools.imagesPerMessage", area: "tools", default: 4, unit: "count", class: "safety", action: "deny", min: 1, max: 100, doc: "Max images per message (DoS bound).", inv: "TOOL20b" },
  { key: "tools.responseSchemaMaxBytes", area: "tools", default: 64 * KIB, unit: "bytes", class: "safety", action: "deny", min: 1, max: 16 * MIB, doc: "Structured-output schema byte cap (DoS bound).", inv: "TOOL21" },
  { key: "tools.notesContentMaxBytes", area: "tools", default: 256 * KIB, unit: "bytes", class: "tunable", action: "warn", min: 1, max: 1 * GIB, doc: "researcher_save_notes: content byte cap.", inv: "NOTE1" },
  { key: "tools.notesFileMaxBytes", area: "tools", default: 5 * MIB, unit: "bytes", class: "tunable", action: "warn", min: 1, max: 1 * GIB, doc: "researcher_save_notes: total file byte cap.", inv: "NOTE1b" },

  // --- task (D) ---
  { key: "task.briefMaxChars", area: "task", default: 16384, unit: "chars", class: "tunable", action: "warn", min: 1, max: 10_000_000, doc: "Max chars of a task brief to a worker.", inv: "TASK1" },
  { key: "task.batchMax", area: "task", default: 8, unit: "count", class: "tunable", action: "warn", min: 1, max: 100, doc: "Max tasks in one batch task call.", inv: "TASK2" },
  { key: "task.depSummaryMaxChars", area: "task", default: 2000, unit: "chars", class: "tunable", action: "warn", min: 1, max: 10_000_000, doc: "Dependency-result summary passed to a dependent task.", inv: "TASK3" },
  { key: "task.batchResultMaxChars", area: "task", default: 4000, unit: "chars", class: "tunable", action: "warn", min: 1, max: 10_000_000, doc: "Per-worker consolidated batch-result summary cap.", inv: "TASK4" },
  { key: "task.journalFanoutMaxPaths", area: "task", default: 256, unit: "count", class: "tunable", action: "warn", min: 1, max: 1_000_000, doc: "Max fan-out journal paths tracked.", inv: "TASK5" },

  // --- ingest (A, §8.7) ---
  { key: "ingest.fitFraction", area: "ingest", default: 0.4, unit: "ratio", class: "tunable", action: "warn", min: 0, max: 1, doc: "Content within this fraction of the available budget loads whole; larger is ingested by fan-out.", inv: "ING1" },
  { key: "ingest.chunkTargetTokens", area: "ingest", default: 3000, unit: "count", class: "tunable", action: "warn", min: 1, max: 1_000_000, doc: "Target token size of one ingest chunk.", inv: "ING2" },
  { key: "ingest.maxChunks", area: "ingest", default: 32, unit: "count", class: "tunable", action: "warn", min: 1, max: 10_000, doc: "Max chunks (and map workers) in one ingest.", inv: "ING3" },
  { key: "ingest.chunkSummaryTokens", area: "ingest", default: 400, unit: "count", class: "tunable", action: "warn", min: 1, max: 1_000_000, doc: "Max tokens of a per-chunk summary.", inv: "ING4" },
  { key: "ingest.digestTokens", area: "ingest", default: 1200, unit: "count", class: "tunable", action: "warn", min: 1, max: 1_000_000, doc: "Max tokens of the reduced ingest digest.", inv: "ING5" },
  { key: "ingest.cacheMaxBytes", area: "ingest", default: 256 * MIB, unit: "bytes", class: "tunable", action: "warn", min: 1, max: 16 * GIB, doc: "Ingest digest cache byte cap (oldest-first eviction).", inv: "ING6" },
  // unset = follow turnMaxConcurrency, resolved by effectiveIngestParallel; the
  // ingest fan-out (`Ingest.runText` → boot's `ingestParallel`) reads it live.
  { key: "ingest.maxParallel", area: "ingest", default: 64, unit: "count", class: "tunable", action: "warn", min: 1, max: 64, doc: "Max parallel ingest summarizer workers (unset follows turnMaxConcurrency).", inv: "ING9" },

  // --- run (A, §7.2/§8.7 pass-by-reference run cache) ---
  // inv ING7/ING8: pass-by-reference is the §7.2/§8.7 run-cache side of the
  // inventory's HIGH-priority fan-out/ingest replacement for the former brief/
  // dep-summary/batch-result clips, matched against the inventory's fan-out
  // caveat (same pattern as the other ING* rows).
  { key: "run.cacheMaxBytes", area: "run", default: 128 * MIB, unit: "bytes", class: "tunable", action: "warn", min: 1, max: 16 * GIB, doc: "Run cache byte cap for pass-by-reference blobs (oldest-first eviction).", inv: "ING7" },
  { key: "run.entryMaxBytes", area: "run", default: 16 * MIB, unit: "bytes", class: "tunable", action: "warn", min: 1, max: 1 * GIB, doc: "Max bytes of a single run-cache blob (brief, dep summary, or batch result).", inv: "ING8" },

  // --- memory (E) ---
  { key: "memory.entryChars", area: "memory", default: 2200, unit: "chars", class: "tunable", action: "warn", min: 1, max: 1_000_000, doc: "Max chars of a single memory entry.", inv: "M1", alias: "memoryMaxEntryChars" },
  { key: "memory.reflectionBatchSize", area: "memory", default: 3, unit: "count", class: "tunable", action: "warn", min: 1, max: 1000, doc: "Reflection batch size.", inv: "M6", alias: "memoryReflectionBatchSize" },
  { key: "memory.sequenceMaxLen", area: "memory", default: 6, unit: "count", class: "tunable", action: "warn", min: 1, max: 1000, doc: "Longest repeated tool sequence the detector matches.", inv: "M7", alias: "sequenceMaxLen" },
  { key: "memory.evidencePacketMaxChars", area: "memory", default: 8000, unit: "chars", class: "tunable", action: "warn", min: 1, max: 10_000_000, doc: "Skill-draft evidence-packet cap.", inv: "M10" },
  { key: "memory.sequenceEvidenceFraction", area: "memory", default: 0.1, unit: "ratio", class: "tunable", action: "warn", min: 0, max: 1, doc: "Sequence evidence-packet cap as a fraction of the context window.", inv: "M8" },

  // --- sequence (E, §10.6 detector caps) ---
  { key: "sequence.maxSignalsPerSession", area: "sequence", default: 3, unit: "count", class: "tunable", action: "warn", min: 1, max: 1000, doc: "Max repeated-sequence signals raised per session.", inv: "M11a" },
  { key: "sequence.maxSignalsPerTurn", area: "sequence", default: 1, unit: "count", class: "tunable", action: "warn", min: 1, max: 1000, doc: "Max repeated-sequence signals raised per turn.", inv: "M11b" },
  { key: "sequence.queueCap", area: "sequence", default: 8, unit: "count", class: "tunable", action: "warn", min: 1, max: 10_000, doc: "Bounded per-session recorded-but-undrafted sequence-candidate cap.", inv: "M12a" },
  { key: "sequence.priorSessions", area: "sequence", default: 20, unit: "count", class: "tunable", action: "warn", min: 0, max: 10_000, doc: "Recent prior sessions seeded into the detector at the boundary.", inv: "M12b" },
  { key: "sequence.minDistinctSessions", area: "sequence", default: 3, unit: "count", class: "tunable", action: "warn", min: 1, max: 1000, doc: "Minimum distinct contexts a sequence must span to qualify.", inv: "M11c" },
  { key: "sequence.evidenceExamplesPerStep", area: "sequence", default: 3, unit: "count", class: "tunable", action: "warn", min: 1, max: 1000, doc: "Max redacted argument-summary examples per step in an evidence packet.", inv: "M9a" },

  // --- session (F) ---
  { key: "session.nameMaxChars", area: "session", default: 60, unit: "chars", class: "tunable", action: "warn", min: 1, max: 10_000, doc: "Max session-name length.", inv: "NAME1" },
  { key: "session.namingTimeoutMs", area: "session", default: 5000, unit: "ms", class: "tunable", action: "warn", min: 1, max: 600_000, doc: "Background session-naming call timeout.", inv: "NAME3" },
  { key: "stats.recordCap", area: "stats", default: 4096, unit: "count", class: "tunable", action: "warn", min: 1, max: 10_000_000, doc: "Stats record cap.", inv: "STAT1" },

  // --- rollback / journal / snapshots (G) ---
  // `integrity`-class (2026-10-21 security review): LOWERING any of these from an
  // untrusted PROJECT config would weaken the mutation journal (audit) or the
  // rollback restore guarantee, so a project/session layer may only RAISE them;
  // a lowering attempt is ignored and warned (the inverse of `safety`). For
  // rollback.snapshotCount, 0 (= rollback OFF) is a lowering and so is honored
  // ONLY from the global/managed layer, never a project.
  { key: "rollback.snapshotCount", area: "rollback", default: 50, unit: "count", class: "integrity", action: "warn", min: 0, max: 500, doc: "Recent moves kept for rollback (0 disables; 0 allowed only from the global layer).", inv: "ROLL1", alias: "snapshotCount" },
  { key: "rollback.harnessNoteMaxChars", area: "rollback", default: 2000, unit: "chars", class: "tunable", action: "warn", min: 1, max: 1_000_000, doc: "Rollback harness-note char cap.", inv: "ROLL3" },
  { key: "rollback.cachePerFileBytes", area: "rollback", default: 5 * MIB, unit: "bytes", class: "integrity", action: "warn", min: 1, max: 1 * GIB, doc: "Cache snapshot: per-file byte cap (lowering drops files from a restore).", inv: "SNAP1a" },
  { key: "rollback.cacheSessionBytes", area: "rollback", default: 256 * MIB, unit: "bytes", class: "integrity", action: "warn", min: 1, max: 16 * GIB, doc: "Cache snapshot: per-session byte cap (lowering drops a restore's completeness).", inv: "SNAP1b" },
  { key: "rollback.gitCaptureTimeoutMs", area: "rollback", default: 20_000, unit: "ms", class: "tunable", action: "warn", min: 1, max: 600_000, doc: "Git snapshot capture timeout.", inv: "SNAP2" },
  { key: "worktree.includeCapBytes", area: "worktree", default: 1 * GIB, unit: "bytes", class: "tunable", action: "warn", min: 1, max: 1024 * GIB, doc: "Worktree include total byte cap (DoS bound).", inv: "SNAP4" },
  { key: "worktree.includeMaxEntries", area: "worktree", default: 64, unit: "count", class: "safety", action: "deny", min: 1, max: 10_000, doc: "Max worktree-include entries per layer.", inv: "SNAP5", schemaTimeOnly: "enforced at config-validation time by WORKTREE_INCLUDE_MAX_ENTRIES in config/schema.ts, before the limits capability exists" },
  { key: "journal.perTargetContentBytes", area: "journal", default: 1 * MIB, unit: "bytes", class: "integrity", action: "warn", min: 1, max: 1 * GIB, doc: "Journal: per-target captured content byte cap (lowering weakens the audit record).", inv: "JRNL2" },
  { key: "journal.maxBlobBytes", area: "journal", default: 512 * MIB, unit: "bytes", class: "integrity", action: "warn", min: 1, max: 16 * GIB, doc: "Journal: max blob byte cap (lowering weakens the audit record).", inv: "JRNL3" },
  { key: "journal.maxEntries", area: "journal", default: 20000, unit: "count", class: "integrity", action: "warn", min: 1, max: 10_000_000, doc: "Journal: max entries (lowering weakens the audit record).", inv: "JRNL5" },

  // --- logs (G) ---
  { key: "logs.maxSizeMB", area: "logs", default: 50, unit: "count", class: "tunable", action: "warn", min: 1, max: 1_000_000, doc: "Log rotation size (MB).", inv: "LOG1", alias: "logMaxSizeMB" },
  { key: "logs.vcsWorktreeTtlMinutes", area: "logs", default: 120, unit: "count", class: "tunable", action: "warn", min: 1, max: 1_000_000, doc: "Worktree TTL prune (minutes).", inv: "LOG2", alias: "vcsWorktreeTtlMinutes" },
  { key: "logs.housekeepingIdleDays", area: "logs", default: 30, unit: "count", class: "tunable", action: "warn", min: 1, max: 100_000, doc: "Housekeeping idle threshold (days).", inv: "LOG3", alias: "housekeepingIdleDays" },

  // --- mcp (H) ---
  { key: "mcp.connectTimeoutMs", area: "mcp", default: 10_000, unit: "ms", class: "tunable", action: "deny", min: 1, max: 600_000, doc: "MCP connect timeout.", inv: "MCP1" },
  { key: "mcp.descriptionMaxChars", area: "mcp", default: 2000, unit: "chars", class: "tunable", action: "warn", min: 1, max: 1_000_000, doc: "MCP tool-description cap shown to the model.", inv: "MCP2" },
  { key: "mcp.readyGraceMs", area: "mcp", default: 5000, unit: "ms", class: "tunable", action: "warn", min: 0, max: 120_000, doc: "how long a turn waits once for MCP auto-connect to finish", inv: "MCP3" },

  // --- plugins (H) ---
  { key: "plugins.optionsMaxBytes", area: "plugins", default: 64 * KIB, unit: "bytes", class: "tunable", action: "warn", min: 1, max: 16 * MIB, doc: "Plugin options byte cap (payload bound).", inv: "PLG1", schemaTimeOnly: "schema accepts any size at validation; runtime check in plugins.ts loadResolved() enforces this limit with the effective action (warn → accept + emit, deny → refuse)" },
  { key: "plugins.registryFileMaxBytes", area: "plugins", default: 1 * MIB, unit: "bytes", class: "safety", action: "warn", min: 1, max: 100 * MIB, doc: "Registry file byte cap (§12.5): file over limit is set aside as .rejected on deny, accepted on warn with LIMIT_HIT.", inv: "REG1" },
  { key: "plugins.registryValueMaxBytes", area: "plugins", default: 64 * KIB, unit: "bytes", class: "safety", action: "warn", min: 1, max: 16 * MIB, doc: "Registry per-value byte cap (§12.5): value over limit is refused on deny, stored on warn with LIMIT_HIT.", inv: "REG1" },
  { key: "plugins.searchMaxBytes", area: "plugins", default: 5_000_000, unit: "bytes", class: "safety", action: "deny", min: 1, max: 1 * GIB, doc: "Plugin registry search response byte cap.", inv: "PLG2a" },
  { key: "plugins.installMaxBytes", area: "plugins", default: 100_000_000, unit: "bytes", class: "safety", action: "deny", min: 1, max: 16 * GIB, doc: "Plugin install payload byte cap.", inv: "PLG2b" },
  { key: "plugins.listPageDefault", area: "plugins", default: 20, unit: "count", class: "tunable", action: "warn", min: 1, max: 250, doc: "Plugin list default page size.", inv: "PLG3" },

  // --- permissions (H) ---
  { key: "permissions.exactRememberMaxChars", area: "permissions", default: 4096, unit: "chars", class: "safety", action: "deny", min: 1, max: 1_000_000, doc: "Max chars a force-ask save may remember (security).", inv: "DP1" },

  // --- approval (H) ---
  { key: "approval.autoDenySeconds", area: "approval", default: 0, unit: "seconds", class: "tunable", action: "warn", min: 0, max: 86400, doc: "Auto-deny a pending approval after this many seconds (0 = off, wait indefinitely).", inv: "DP1" },

  // --- docs (I) ---
  { key: "docs.maxFiles", area: "docs", default: 500, unit: "count", class: "tunable", action: "warn", min: 1, max: 100_000, doc: "Max manual doc files read per registered docs directory.", inv: "DOCS1" },
  { key: "docs.maxFileBytes", area: "docs", default: 262144, unit: "bytes", class: "tunable", action: "warn", min: 1, max: 100 * MIB, doc: "Max size of one manual doc file; larger files are skipped.", inv: "DOCS2" },

  // --- doctor (H) ---
  { key: "doctor.networkTimeoutMs", area: "doctor", default: 5000, unit: "ms", class: "tunable", action: "warn", min: 1, max: 600_000, doc: "Doctor network-check timeout.", inv: "DOC1" },

  // --- export (I) ---
  { key: "export.perResultBytes", area: "export", default: 64 * KIB, unit: "bytes", class: "tunable", action: "warn", min: 1, max: 1 * GIB, doc: "Export: per-tool-result byte cap.", inv: "EXP1" },
  { key: "export.documentBytes", area: "export", default: 16 * MIB, unit: "bytes", class: "tunable", action: "warn", min: 1, max: 1 * GIB, doc: "Export: whole-document byte cap.", inv: "EXP2" },

  // --- plan (plan plugin, J) ---
  { key: "plan.maxFieldLength", area: "plan", default: 500, unit: "chars", class: "tunable", action: "warn", min: 1, max: 100_000, doc: "Plan system-map: per free-text field char cap.", inv: "PLAN1" },
  { key: "plan.maxTouches", area: "plan", default: 50, unit: "count", class: "tunable", action: "warn", min: 1, max: 10_000, doc: "Plan system-map: max predicted `touches` entries.", inv: "PLAN2" },
  { key: "plan.maxEntryLength", area: "plan", default: 256, unit: "chars", class: "tunable", action: "warn", min: 1, max: 100_000, doc: "Plan system-map: per `touches` entry char cap.", inv: "PLAN3" },
];

void B;

/** Every registry key, for schema building and the guard. */
export const LIMIT_KEYS: readonly string[] = LIMITS.map((l) => l.key);

const BY_KEY: ReadonlyMap<string, LimitSpec> = new Map(LIMITS.map((l) => [l.key, l]));

/** Look up a spec by dotted key, or `undefined` when unknown. */
export function getLimitSpec(key: string): LimitSpec | undefined {
  return BY_KEY.get(key);
}

/** Every distinct area name, in first-seen order. */
export function limitAreas(): string[] {
  const seen: string[] = [];
  for (const l of LIMITS) if (!seen.includes(l.area)) seen.push(l.area);
  return seen;
}

/** The default value for a key. Throws on an unknown key — a programming error,
 * never a config path. */
export function limitDefault(key: string): number {
  const spec = BY_KEY.get(key);
  if (!spec) throw new Error(`unknown limit key: ${key}`);
  return spec.default;
}

/** The legacy top-level config key a registry key aliases, or `undefined`.
 * When set, the registry is the single reader (`limits.<key>` first, else the
 * legacy key, else the default) and every consumer reads through the port. */
export function limitAlias(key: string): string | undefined {
  return BY_KEY.get(key)?.alias;
}

/** Every registry key that aliases a legacy top-level config key. */
export const ALIASED_LIMIT_KEYS: readonly string[] = LIMITS.filter((l) => l.alias).map((l) => l.key);

/** The minimal shape of a resolved-limits set this entity reads (the full type
 * lives in `limits-resolve.ts`, which imports THIS file — so the helper takes a
 * structural parameter to avoid an import cycle). */
interface ResolvedLimitsLike {
  values: ReadonlyMap<string, { value: number; source: string }>;
}

/**
 * The effective ingest parallelism (core-blueprint.md §8.7).
 *
 * `ingest.maxParallel` is unset by default (no layer set it → its resolved
 * `source` is `"default"`), which means "follow `turnMaxConcurrency`". When a
 * layer SETS it, that explicit value wins (already bounded to [1, 64] by the
 * registry min/max at schema time). The result is always clamped to at least 1.
 */
export function effectiveIngestParallel(resolved: ResolvedLimitsLike, turnMaxConcurrency: number): number {
  const r = resolved.values.get("ingest.maxParallel");
  const value = r && r.source !== "default" ? r.value : turnMaxConcurrency;
  return Math.max(1, Math.floor(value));
}
