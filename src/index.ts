/**
 * @voidrift/core — the SDK interface.
 *
 * Exports exactly what a consumer imports (core-blueprint.md §1 rule 4, §2):
 * `createCore`, the CoreAPI with its DTO, event, and config types, and the port
 * interfaces a consumer implements. Everything else is internal.
 */

import { coreVersion } from "./version.js";

/** The core SDK's semantic version marker, surfaced for diagnostics. */
export const CORE_VERSION = coreVersion();

// Construction and the facade.
export { createCore } from "./boot.js";
// Host-level `config.init` (§13.9.1), usable WITHOUT a core (no model/network):
// the SAME use-case the facade `config.init` delegates to. The CLI's
// `voidrift init` binds to these directly (CLI §2.1).
export {
  initConfigHome,
  previewInitReset,
  initResetNames,
  isFirstRun,
  voidriftConfigDir,
  doctorConfigHome,
  accessReportConfigHome,
} from "./boot.js";
export type { CoreOptions, CoreReady, ManagedStatus } from "./boot.js";
export { CoreAPI } from "./facade.js";
export type {
  SendRequest,
  SessionInfo,
  ResumedSession,
  HousekeepingNotice,
  ApprovalHandler,
  AgentInfo,
  DocumentInfo,
  MessageDTO,
} from "./facade.js";

// Session export (§10.13): the sanitized document shape + mask summary a host
// renders. `session.export` is HOST-ONLY (not a model tool, absent from the
// plugin ScopedCoreApi); these types let a client type the returned document.
export type {
  SessionExport,
  ExportMessage,
  ExportWrite,
  MaskSummary,
} from "./use-cases/session-export.js";

// DTO, event, and config types a consumer reads.
export type { CoreError, Result } from "./entities/errors.js";
export type { EventEnvelope, EventScope } from "./entities/event-bus.js";
export type { TurnResult } from "./use-cases/engine.js";
export type {
  WorkerStatus,
  WorkerResult,
  WorkInFlight,
  WorkerInfo,
  WorkerStreamEvent,
  AgentDefinition,
} from "./entities/subagents.js";
export type { DispatchRequest, FanoutResult } from "./use-cases/subagents.js";
export type {
  RollbackOutcome,
  MovesReport,
} from "./use-cases/rollback.js";
export type { Move, MovePath, NotUndoable, SnapshotMethod } from "./entities/rollback.js";
export type { ApprovalMode, SessionMetadata, SessionMode } from "./entities/session.js";
export type {
  PendingApproval,
  ApprovalResponse,
  ApprovalDecision,
  FanoutApprovalBatch,
} from "./entities/approvals.js";
export type { Config, ConfigLayer, ModelConfigEntry, PermissionRule } from "./config/schema.js";
export type { ConfigRejection, ConfigWarning, ValidationResult } from "./entities/config-capability.js";
export type { ConfigInitOptions, ConfigInitResult } from "./use-cases/config-init.js";
export type { ConfigUpdatePreview, ConfigUpdatePlan, ConfigUpdateResult } from "./use-cases/config-init.js";
// Known-shipped manifest (§13.9.1): the seeded allow-rule set builder and the
// manifest hash helpers the generator script and the completeness test reach.
export { seedPermissions, seedConfigDocument } from "./config/seed.js";
export { sha256, permissionsFingerprint, classifyAgainstManifest } from "./config/shipped-manifest.js";
export type { ShippedManifest, ManifestStatus } from "./config/shipped-manifest.js";
export { previewInitUpdate, applyInitUpdate } from "./boot.js";
export { seededDefaultsOutOfDate } from "./boot.js";
export { sweepConfigHome, scanLiveLeftovers } from "./boot.js";
export type { ConfigSweepResult } from "./use-cases/config-init.js";
export { migrateConfigHome } from "./boot.js";
export type { ConfigMigrateResult } from "./use-cases/config-init.js";
export type {
  DoctorReport,
  DoctorGroup,
  DoctorFinding,
  DoctorGroupId,
  DoctorStatus,
  DoctorOptions,
} from "./use-cases/config-doctor.js";
export {
  buildAccessReport,
  ALWAYS_ASK_LINES,
} from "./use-cases/access-report.js";
export type {
  AccessReport,
  AccessAllowEntry,
  AccessRule,
  AccessAgent,
  AccessWorker,
  AccessNeverEntry,
  AccessUnlockEntry,
  AccessPlugin,
  AccessRollback,
  AccessNotice,
  AccessReportInput,
  LayerTag,
} from "./use-cases/access-report.js";

// The mutation journal (§10.11): the entry/level types and the store port a
// host reads through `session.journal`, plus the in-memory store as a test seam.
export type {
  JournalEntry,
  JournalResult,
  JournalBlobs,
  MutationLogLevel,
} from "./entities/journal.js";
export { JOURNAL_LIMITS } from "./entities/journal.js";
export type { JournalStore } from "./entities/ports/journal-store.js";
export { InMemoryJournalStore } from "./adapters/repositories/in-memory-journal-store.js";

// Slice-5 surface: skills, prompts, plugins, registry (§12).
export type { SkillDTO } from "./use-cases/skills.js";
export type { PromptDTO } from "./use-cases/prompts.js";
export type {
  ScopedCoreApi,
  ContextLayer,
  ContextProvider,
  PluginCommandHandler,
  WorkspaceSurface,
  NetworkSurface,
  LimitsSurface,
} from "./use-cases/plugins.js";
export type { PluginFileEntry } from "./use-cases/plugin-files-accessor.js";
export type { PluginMeta } from "./entities/plugins/plugin-meta.js";
export type { PluginSearchResult, PluginReview } from "./entities/plugins/plugin-registry.js";
export type { SkillScope } from "./entities/skills/skill.js";
export type { RegistryEntry } from "./entities/registry/registry-store.js";
// The panel declaration standard — the ONE pure-data shape every client and
// plugin builds panels by (§12.6, panels §2). The same contract class as the
// tool/guardrail/context-provider shapes; the core validates it at register.panel.
export type { PanelDeclaration, PanelColumn, PanelAction } from "./entities/registry/panel-schema.js";
export type { PanelFormat, PanelPage, PanelDetail } from "./entities/registry/panel-schema.js";

// The dataset standard — the ONE read-only data seam behind every panel (§12.7).
// A dataset is pure data (`description`, `fields`) plus one zero-argument,
// read-only `rows` reader; CoreAPI exposes `datasets.list`/`datasets.rows`
// (secret-masked) so a client reads panel rows without importing core internals.
export type { DatasetDeclaration, DatasetField, Row } from "./entities/registry/dataset-schema.js";
export type { DatasetInfo } from "./facade.js";

// The §8.7 INGEST chunker contract a plugin contributes through
// `register.chunker` (a tree-sitter/AST chunker, say). `Chunker.matches` wins
// over the core builtins for its source; its output is validated and its
// failures contained by the core at use. The builtins stay internal.
export type { Chunker, Chunk } from "./entities/chunker.js";

// Memory DTOs, ports, and provider contract a consumer reads/implements (§6).
export type { MemoryEntryDTO, RecallHit, BoundExceeded } from "./use-cases/memory.js";
export type { MemoryType, MemoryScope } from "./entities/memory/memory-entry.js";
export type { SuggestionDTO, SuggestionKind, SuggestionStatus } from "./entities/memory/suggestion.js";
export type { MemoryStore, StoredItem } from "./entities/ports/memory-store.js";
export type { CredentialStore } from "./entities/ports/credential-store.js";
export type { NamingPort, NamingContext } from "./entities/ports/naming-port.js";
export type {
  MemoryProvider,
  MemoryItem,
  TurnContext,
  TurnRecord,
  SessionSummary,
} from "./entities/memory/memory-provider.js";

// Port interfaces and shapes a consumer implements/registers.
export type { ToolDefinition, ToolExecutor, ToolResult, ToolContext } from "./entities/tool-registry.js";
export type { Guardrail, GuardrailResult, GuardrailContext } from "./entities/guardian.js";
export type { ModelPort, ResolvedModel, ModelInfo } from "./entities/ports/model-port.js";
export type { SessionRepository, PersistedSession } from "./entities/ports/session-repository.js";
// The in-memory session repository — an explicit construction-time test/host
// seam (CoreOptions.sessionRepository); the production default is the durable
// filesystem repository writing `.voidrift/sessions/{id}/` (§5.1, §15.3).
export { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
export type { ConfigStore } from "./entities/ports/config-store.js";
export { ConfigReadError } from "./entities/ports/config-store.js";
// The in-memory config store — an explicit construction-time test/host seam
// (CoreOptions.configStore); the production default is the filesystem store (§13.1, §15.3).
export { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
export type { FileSystemPort, ShellPort, ShellResult } from "./entities/ports/host.js";

// The limits registry foundation (§13.11): the typed table, the layered
// resolver, and the runtime port a consumer (/config, doctor, CLI) reads. The
// LimitsCapability is the runtime implementation (LIMIT_HIT once per key/turn).
export { LIMITS, LIMIT_KEYS, getLimitSpec, limitAreas, limitDefault, effectiveIngestParallel } from "./entities/limits.js";
export type { LimitSpec, LimitUnit, LimitClass } from "./entities/limits.js";
export {
  resolveLimits,
  effectiveLimit,
} from "./entities/limits-resolve.js";
export type {
  ResolvedLimit,
  ResolvedLimits,
  LimitLayerInput,
  LimitWarning,
} from "./entities/limits-resolve.js";
export { limitNotice } from "./entities/ports/limits-port.js";
export type { LimitsPort, LimitHitContext, LimitHitResult } from "./entities/ports/limits-port.js";
export { limitMarker } from "./entities/ports/limits-port.js";
export { LimitsCapability } from "./use-cases/limits-capability.js";

// Observability record + exporter contract an export plugin consumes (§10.1, §10.8).
export type {
  ObsRecord,
  ObsExporter,
  TokenUsage,
  ObsSource,
  ObsSeverity,
  ObsStatus,
} from "./entities/observability/obs-record.js";

// Cost/token/time view types (§10.14, §2.4, §11.9).
export type { StatsReport, StatsBucket } from "./entities/observability/stats-report.js";

// Cost derivation (§10.7): the one formula a client reuses for the per-turn
// footer `$cost` so the CLI never duplicates the arithmetic.
export { deriveCost } from "./entities/observability/cost.js";
export type { ModelPrice } from "./entities/observability/cost.js";
