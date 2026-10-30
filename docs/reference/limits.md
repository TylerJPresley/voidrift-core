---
summary: "Configuration limits and tunable parameters."
read-when: "before configuring VoidRift limits or understanding the available tuning options."
type: reference
---

# Configuration Limits

VoidRift has **101** configurable limits across **24** areas. Each is a
key under `limits.<area>.<name>`; a `tunable` limit follows the normal cascade (the
narrower layer wins), a `safety` limit may only be *lowered* by a project/session layer,
and an `integrity` limit may only be *raised* by a project/session layer (it protects an
audit/restore guarantee, so lowering it from an untrusted project config is ignored).

<!-- BEGIN (generated) -->

## `limits.context`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `context.estimateMarginTokens` | count | tunable | Token-estimate safety margin. |
| `context.defaultOutputReservation` | count | tunable | Default output-token reservation when a model sets none. |
| `context.summaryBudgetFloor` | count | tunable | Minimum token budget for a compaction summary. |
| `context.excerptLineMaxChars` | chars | tunable | Per-line cap in an evicted-tool-result excerpt. |

## `limits.turn`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `turn.shutdownGraceMs` | ms | tunable | Grace period before a hard turn shutdown. |

## `limits.toolRounds`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `toolRounds.recursionMargin` | count | tunable | Additive margin in the derived LangGraph recursion limit (2*rounds + margin). |
| `toolRounds.recursionFactor` | count | tunable | Multiplier on rounds in the derived LangGraph recursion limit (factor*rounds + margin). |
| `toolRounds.wrapUpRatio` | ratio | tunable | Fraction of the tool-round budget at which the wrap-up note is appended. |

## `limits.lane`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `lane.writeCallsPerTurn` | count | tunable | Direct write calls a delegating top-level agent may make per turn. |
| `lane.distinctTargetsPerTurn` | count | tunable | Distinct direct write targets per turn. |
| `lane.writeContextShare` | ratio | tunable | Write-lane tool-result share of the context window before blocking. |
| `lane.readCallsPerTurn` | count | tunable | Direct read calls per turn before the read-lane nudge. |
| `lane.readContextShare` | ratio | tunable | Read-lane tool-result share of the context window before the nudge. |

## `limits.tools`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `tools.workspaceMaxFiles` | count | tunable | Max files enumerated in the workspace surface. |
| `tools.readMaxLines` | count | tunable | read_file: max lines returned in one call (a ranged read is never refused for size below this). |
| `tools.workspaceFileMaxBytes` | bytes | tunable | Per-file byte cap in the workspace surface. |
| `tools.commandOutputMaxBytes` | bytes | tunable | Command stdout/stderr byte cap before truncation. |
| `tools.commandTimeoutMs` | ms | tunable | Command execution timeout (execute_command / wait poll). |
| `tools.commandKillGraceMs` | ms | tunable | Grace before a hard kill of a timed-out command. |
| `tools.commandHeadLines` | count | tunable | execute_command: head lines kept inline when oversized output is stored by reference. |
| `tools.commandTailLines` | count | tunable | execute_command: tail lines kept inline when oversized output is stored by reference. |
| `tools.webFetchInlineMax` | chars | tunable | web_fetch: full text inlined up to this length. |
| `tools.webFetchPreview` | chars | tunable | web_fetch: preview length when over the inline max. |
| `tools.webFetchMinExtract` | chars | tunable | web_fetch: minimum extracted text length. |
| `tools.webFetchBodyMaxBytes` | bytes | safety | web_fetch: response body byte cap (DoS bound). |
| `tools.webFetchMaxHops` | count | safety | web_fetch: max redirect hops (SSRF bound). |
| `tools.webSearchMaxResults` | count | tunable | web_search: max results returned to the model. |
| `tools.searchFallbackMax` | count | tunable | search_contents: on a content-search timeout, max results from the glob-based filename fallback (§8.2). |
| `tools.searchTimeoutMs` | ms | tunable | search_contents: wall-clock budget before falling back to the glob-based filename search (§8.2). |
| `tools.webSearchSnippetMax` | chars | tunable | web_search: per-result snippet cap. |
| `tools.webSearchTitleMax` | chars | tunable | web_search: per-result title cap. |
| `tools.webSearchBodyMaxBytes` | bytes | safety | web_search: body byte cap (DoS bound). |
| `tools.imageMaxBytes` | bytes | safety | Per-image byte cap on an attachment (DoS bound). |
| `tools.imagesPerMessage` | count | safety | Max images per message (DoS bound). |
| `tools.responseSchemaMaxBytes` | bytes | safety | Structured-output schema byte cap (DoS bound). |
| `tools.notesContentMaxBytes` | bytes | tunable | researcher_save_notes: content byte cap. |
| `tools.notesFileMaxBytes` | bytes | tunable | researcher_save_notes: total file byte cap. |

## `limits.task`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `task.briefMaxChars` | chars | tunable | Max chars of a task brief to a worker. |
| `task.batchMax` | count | tunable | Max tasks in one batch task call. |
| `task.depSummaryMaxChars` | chars | tunable | Dependency-result summary passed to a dependent task. |
| `task.batchResultMaxChars` | chars | tunable | Per-worker consolidated batch-result summary cap. |
| `task.journalFanoutMaxPaths` | count | tunable | Max fan-out journal paths tracked. |

## `limits.ingest`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `ingest.fitFraction` | ratio | tunable | Content within this fraction of the available budget loads whole; larger is ingested by fan-out. |
| `ingest.chunkTargetTokens` | count | tunable | Target token size of one ingest chunk. |
| `ingest.maxChunks` | count | tunable | Max chunks (and map workers) in one ingest. |
| `ingest.chunkSummaryTokens` | count | tunable | Max tokens of a per-chunk summary. |
| `ingest.digestTokens` | count | tunable | Max tokens of the reduced ingest digest. |
| `ingest.cacheMaxBytes` | bytes | tunable | Ingest digest cache byte cap (oldest-first eviction). |
| `ingest.maxParallel` | count | tunable | Max parallel ingest summarizer workers (unset follows turnMaxConcurrency). |

## `limits.run`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `run.cacheMaxBytes` | bytes | tunable | Run cache byte cap for pass-by-reference blobs (oldest-first eviction). |
| `run.entryMaxBytes` | bytes | tunable | Max bytes of a single run-cache blob (brief, dep summary, or batch result). |

## `limits.memory`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `memory.entryChars` | chars | tunable | Max chars of a single memory entry. |
| `memory.projectChars` | chars | tunable | Project-instructions head bound (AGENTS.md etc.); explicit override of the ingest.fitFraction fit test. |
| `memory.reflectionBatchSize` | count | tunable | Reflection batch size. |
| `memory.indexCapPct` | ratio | tunable | Memory index cap as a share of the context window. |
| `memory.projectDigestMaxChars` | chars | tunable | Project-context structural head digest length (owner-set 2000; 14/16 real AGENTS.md fit fully); the per-section sentence allowance is derived from this (floor(maxChars / sectionCount)), not a separate key; the full body rides the session-cache pointer. |
| `memory.sequenceMaxLen` | count | tunable | Longest repeated tool sequence the detector matches. |
| `memory.evidencePacketMaxChars` | chars | tunable | Skill-draft evidence-packet cap. |
| `memory.sequenceEvidenceFraction` | ratio | tunable | Sequence evidence-packet cap as a fraction of the context window. |

## `limits.sequence`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `sequence.maxSignalsPerSession` | count | tunable | Max repeated-sequence signals raised per session. |
| `sequence.maxSignalsPerTurn` | count | tunable | Max repeated-sequence signals raised per turn. |
| `sequence.queueCap` | count | tunable | Bounded per-session recorded-but-undrafted sequence-candidate cap. |
| `sequence.priorSessions` | count | tunable | Recent prior sessions seeded into the detector at the boundary. |
| `sequence.minDistinctSessions` | count | tunable | Minimum distinct contexts a sequence must span to qualify. |
| `sequence.evidenceExamplesPerStep` | count | tunable | Max redacted argument-summary examples per step in an evidence packet. |

## `limits.session`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `session.nameMaxChars` | chars | tunable | Max session-name length. |
| `session.namingTimeoutMs` | ms | tunable | Background session-naming call timeout. |

## `limits.stats`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `stats.recordCap` | count | tunable | Stats record cap. |

## `limits.rollback`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `rollback.snapshotCount` | count | integrity | Recent moves kept for rollback (0 disables; 0 allowed only from the global layer). |
| `rollback.rollingSummaryMaxBytes` | bytes | tunable | Rolling-summary byte cap. |
| `rollback.harnessNoteMaxChars` | chars | tunable | Rollback harness-note char cap. |
| `rollback.cachePerFileBytes` | bytes | integrity | Cache snapshot: per-file byte cap (lowering drops files from a restore). |
| `rollback.cacheSessionBytes` | bytes | integrity | Cache snapshot: per-session byte cap (lowering drops a restore's completeness). |
| `rollback.gitCaptureTimeoutMs` | ms | tunable | Git snapshot capture timeout. |

## `limits.worktree`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `worktree.includeCapBytes` | bytes | safety | Worktree include total byte cap (DoS bound). |
| `worktree.includeMaxEntries` | count | safety | Max worktree-include entries per layer. |

## `limits.journal`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `journal.perTargetContentBytes` | bytes | integrity | Journal: per-target captured content byte cap (lowering weakens the audit record). |
| `journal.maxBlobBytes` | bytes | integrity | Journal: max blob byte cap (lowering weakens the audit record). |
| `journal.maxEntries` | count | integrity | Journal: max entries (lowering weakens the audit record). |

## `limits.logs`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `logs.maxSizeMB` | count | tunable | Log rotation size (MB). |
| `logs.vcsWorktreeTtlMinutes` | count | tunable | Worktree TTL prune (minutes). |
| `logs.housekeepingIdleDays` | count | tunable | Housekeeping idle threshold (days). |

## `limits.mcp`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `mcp.connectTimeoutMs` | ms | tunable | MCP connect timeout. |
| `mcp.descriptionMaxChars` | chars | tunable | MCP tool-description cap shown to the model. |
| `mcp.readyGraceMs` | ms | tunable | how long a turn waits once for MCP auto-connect to finish |

## `limits.plugins`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `plugins.optionsMaxBytes` | bytes | safety | Plugin options byte cap (payload bound). |
| `plugins.registryFileMaxBytes` | bytes | safety | Registry file byte cap (§12.5): file over limit is set aside as .rejected on deny, accepted on warn with LIMIT_HIT. |
| `plugins.registryValueMaxBytes` | bytes | safety | Registry per-value byte cap (§12.5): value over limit is refused on deny, stored on warn with LIMIT_HIT. |
| `plugins.searchMaxBytes` | bytes | safety | Plugin registry search response byte cap. |
| `plugins.installMaxBytes` | bytes | safety | Plugin install payload byte cap. |
| `plugins.listPageDefault` | count | tunable | Plugin list default page size. |

## `limits.permissions`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `permissions.exactRememberMaxChars` | chars | safety | Max chars a force-ask save may remember (security). |

## `limits.approval`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `approval.autoDenySeconds` | seconds | tunable | Auto-deny a pending approval after this many seconds (0 = off, wait indefinitely). |

## `limits.docs`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `docs.maxFiles` | count | tunable | Max manual doc files read per registered docs directory. |
| `docs.maxFileBytes` | bytes | tunable | Max size of one manual doc file; larger files are skipped. |

## `limits.doctor`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `doctor.networkTimeoutMs` | ms | tunable | Doctor network-check timeout. |

## `limits.export`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `export.perResultBytes` | bytes | tunable | Export: per-tool-result byte cap. |
| `export.documentBytes` | bytes | tunable | Export: whole-document byte cap. |

## `limits.plan`

| Key | Unit | Class | Meaning |
|---|---|---|---|
| `plan.maxFieldLength` | chars | tunable | Plan system-map: per free-text field char cap. |
| `plan.maxTouches` | count | tunable | Plan system-map: max predicted `touches` entries. |
| `plan.maxEntryLength` | chars | tunable | Plan system-map: per `touches` entry char cap. |


<!-- END (generated) -->
