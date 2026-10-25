/**
 * `createCore` — the composition root (core-blueprint.md §2.1, §14.1, §1 boot.ts).
 *
 * The only place concrete adapters are known (§1 rule 3). It wires adapters into
 * capabilities, builds the engine factory, computes the housekeeping notice, and
 * returns the CoreAPI. A recoverable condition surfaces as an event, never a
 * throw; a missing workspace root throws synchronously (§2.1).
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { EventBus } from "./entities/event-bus.js";
import { ConfigCapability } from "./entities/config-capability.js";
import type { Config, PermissionRule } from "./config/schema.js";
import type { ConfigStore } from "./entities/ports/config-store.js";
import { ModelProviderAdapter, type ChatModelFactory } from "./adapters/model-provider.js";
import { Warden, loadPolicy, type WardenEvents } from "./entities/warden.js";
import { Guardian, builtinGuardrails } from "./entities/guardian.js";
import { ToolRegistry } from "./entities/tool-registry.js";
import { builtinToolDefinitions } from "./tools/builtin.js";
import type { FileSystemPort, ShellPort } from "./entities/ports/host.js";
import type { SessionRepository } from "./entities/ports/session-repository.js";
import { FilesystemSessionRepository } from "./adapters/repositories/session-repository.js";
import { FilesystemConfigStore } from "./adapters/repositories/filesystem-config-store.js";
import { createSqliteCheckpointer } from "./adapters/checkpointer.js";
import { coreVersion } from "./version.js";
import { Engine } from "./use-cases/engine.js";
import { suggestSessionName, draftSkillFromSequence, draftMemoryNoteFromFailure } from "./use-cases/engine.js";
import { noopNamingPort, type NamingPort } from "./entities/ports/naming-port.js";
import { Subagents } from "./use-cases/subagents.js";
import { Ingest } from "./use-cases/ingest.js";
import { FilesystemIngestCache } from "./adapters/ingest-cache.js";
import { RollbackIntegrity } from "./adapters/rollback-integrity.js";
import { FilesystemRunCache } from "./adapters/run-cache.js";
import { webCachePath } from "./use-cases/web-fetch.js";
import type { AgentDefinition } from "./entities/subagents.js";
import { Memory } from "./use-cases/memory.js";
import { LimitsCapability } from "./use-cases/limits-capability.js";
import { resolveLimits } from "./entities/limits-resolve.js";import { ManagedLayer } from "./use-cases/managed-layer.js";
import { FilesystemAdapter } from "./adapters/filesystem.js";
import { FilesystemMemoryStore } from "./adapters/repositories/filesystem-memory-store.js";
import { SuggestionsDirectory } from "./adapters/suggestions-directory.js";
import { discoverProjectFiles } from "./adapters/project-discovery.js";
import { VcsAdapter } from "./adapters/vcs.js";
import { FilesystemStagingAdapter } from "./adapters/staging.js";
import { GitSnapshotStore } from "./adapters/git-snapshot-store.js";
import { CacheSnapshotStore } from "./adapters/cache-snapshot-store.js";
import { RollbackService } from "./use-cases/rollback.js";
import type { SnapshotStore } from "./entities/ports/snapshot-store.js";
import { FetchHttpAdapter } from "./adapters/http-fetch.js";
import { Skills } from "./use-cases/skills.js";
import { Manuals } from "./use-cases/manuals.js";
import { Prompts } from "./use-cases/prompts.js";
import { Plugins, type CoreServices, type PluginCommandHandler } from "./use-cases/plugins.js";
import { SkillsDirectory } from "./adapters/skills-directory.js";
import { ManualsDirectory } from "./adapters/manuals-directory.js";
import { AgentsDirectory } from "./adapters/agents-directory.js";
import { ConfigInit } from "./use-cases/config-init.js";
import { NodeInitFs } from "./adapters/init-fs.js";
import { seedConfigDocument } from "./config/seed.js";import { WorkspaceMap } from "./use-cases/workspace-map.js";
import { WorkspaceSurfaceImpl } from "./use-cases/workspace-surface.js";
import { PromptsDirectory } from "./adapters/prompts-directory.js";
import { PluginLoader } from "./adapters/plugin-loader.js";
import { PluginRegistryClient } from "./adapters/plugin-registry-client.js";
import { NpmInstallerAdapter } from "./adapters/npm-installer.js";
import { maskValue } from "./use-cases/secret-mask.js";
import { RegistryStore, CORE_NAMESPACE, PANELS_KEY_PREFIX, DATASETS_KEY_PREFIX } from "./entities/registry/registry-store.js";
import { NodeRegistryPersistence, workspaceKey, isRegistryFile } from "./entities/registry/registry-persistence.js";
import { validatePanelDeclaration } from "./entities/registry/panel-schema.js";
import { validateDatasetDeclaration } from "./entities/registry/dataset-schema.js";
import { registerBuiltinDatasets } from "./use-cases/builtin-datasets.js";
import { CoreErrorException, coreError, ErrorCode } from "./entities/errors.js";
import { ObsWriter } from "./use-cases/obs-writer.js";
import { toolDisplayName } from "./entities/observability/tool-display.js";
import { NdjsonLogStore } from "./adapters/ndjson-log-store.js";
import { McpClient } from "./use-cases/mcp-client.js";
import { connectMcpServer } from "./adapters/mcp-connection.js";
import { FilesystemMcpPinStore } from "./adapters/mcp-pin-store.js";
import { LazyCredentialStore } from "./adapters/credential-store.js";
import type { MemoryStore } from "./entities/ports/memory-store.js";
import type { CredentialStore } from "./entities/ports/credential-store.js";
import type { McpServerConfig } from "./entities/mcp/mcp-types.js";
import { CoreAPI, systemTempDir, type ApprovalHandler, type HousekeepingNotice } from "./facade.js";
import { FilesystemJournalStore } from "./adapters/repositories/filesystem-journal-store.js";
import { readTargetBytesBounded } from "./adapters/repositories/journal-target-reader.js";
import { JournalRecorder } from "./use-cases/journal-recorder.js";

export interface CoreOptions {
  workspaceRoot?: string;
  configOverrides?: Partial<Config>;
  /** Path or integrity-verified source of the managed config layer; its presence
   * makes the deployment managed (§13.5, §2.1). */
  managedSource?: string;
  /**
   * The host-selected starting top-level agent (§2.1, §2.7): a NEW or RESUMED
   * session starts in this agent instead of the built-in `chat`. The host (the
   * `voidrift` CLI) picks it — interactively the built-in `chat`, and in
   * headless the first top-level agent by `order` whose `unlisted` is `deny`
   * (read-only, default) or, with `--enable-write`, whose `unlisted` is `allow`.
   * A start agent with `confirm: true` counts as confirmed because the host
   * passed it explicitly. An `unlisted: allow` start agent is subject to the
   * managed `autoApproveAllowed: false` refusal. This is the ONLY way to start
   * in a non-`chat` agent; the removed `autoApprove` alias no longer exists.
   * Omitted → `chat`. */
  startAgent?: string;
  /**
   * The approval mode every NEW host-launched session is created with (§2.5,
   * §8). Omitted → `interactive` (the TUI default: an unresolved call ASKS).
   * The headless CLI sets `"headless"` so a run NEVER asks — and, critically, a
   * routine run (`runInNewSession`, which starts a SEPARATE session) inherits
   * the same posture rather than silently reverting to `interactive` and
   * reaching `waiting_for_approval`/exit 5 (cli §8). It is process-fixed like
   * `startAgent`; a per-send `approvalMode` still overrides it for one turn. */
  startSessionApprovalMode?: import("./entities/session.js").ApprovalMode;
  output?: (text: string) => void;
  openPanel?: (name: string) => void;
  onApproval?: ApprovalHandler;
  checkpointer?: BaseCheckpointSaver;
  /** Long-term memory port (§6.1); omitted → durable filesystem default (§2.1). */
  store?: MemoryStore;
  /** MCP OAuth/HTTP-auth credential store (§8.4); omitted → keychain/encrypted-file
   * selection built internally (§2.1). Construction-time injection only. */
  credentialStore?: CredentialStore;
  installSignalHandlers?: boolean;
  // ── test/host injection seams (not part of the public SDK surface) ──
  /** Inject a config store; defaults to the filesystem store at the workspace. */
  configStore?: ConfigStore;
  /** Inject a session repository; defaults to in-memory for determinism. */
  sessionRepository?: SessionRepository;
  /** Inject the chat-model factory (tests pass a `fakeModel()` factory). */
  chatModelFactory?: ChatModelFactory;
  /** Inject the session-naming port (§5.5). Default: the real implementation
   * over `transientChatModel` when NO `chatModelFactory` is injected; a NO-OP
   * (first-line fallback only) when a `chatModelFactory` IS injected (so finite
   * scripted `fakeModel` fixtures are never perturbed by a passive model call),
   * UNLESS the caller passes a `namingPort` here explicitly. */
  namingPort?: import("./entities/ports/naming-port.js").NamingPort;
  /** Inject host ports (tests pass in-memory implementations, §1 rule 7). */
  fileSystem?: FileSystemPort;
  shell?: ShellPort;
  /** Inject the mutation journal store (§10.11); defaults to the filesystem
   * store under `<workspaceRoot>/.voidrift/journal/`. Tests pass the in-memory
   * store. */
  journalStore?: import("./entities/ports/journal-store.js").JournalStore;
  /** Inject the plugin registry client (§12.4.1); defaults to the fetch adapter.
   * Tests pass a fake so discovery runs with no network. */
  pluginRegistry?: import("./entities/ports/plugin-registry-port.js").PluginRegistryPort;
  /** Inject the npm installer (§12.4.1); defaults to the argv-spawn adapter. */
  pluginInstaller?: import("./entities/ports/plugin-registry-port.js").PluginInstallerPort;
}

export type ManagedStatus = {
  status: "none" | "ok" | "unavailable" | "invalid";
  reason?: string;
  source?: string;
};

export interface CoreReady {
  api: CoreAPI;
  housekeeping: HousekeepingNotice;
  managed: ManagedStatus;
}

/** The global config home (§6.2 global scope, §13.1): `$XDG_CONFIG_HOME` or `~/.config`. */
function configHome(): string {
  return process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config");
}

/** Shorten a leading home-directory prefix to `~` (on a path boundary), matching
 * how other user-facing messages render paths. Non-home paths pass through. */
function tildeHome(p: string, home: string): string {
  if (!home) return p;
  if (p === home) return "~";
  if (p.startsWith(home + path.sep)) return "~" + p.slice(home.length);
  return p;
}

/**
 * The ONE resolver for the global `~/.config/voidrift` directory (§13.1, §6.2).
 * Every global-scope consumer — the config store, the credentials file, logs,
 * skills, prompts, agents, and memory — resolves its global root from here so
 * they can never diverge: honor `$XDG_CONFIG_HOME/voidrift` when set, else
 * `~/.config/voidrift`.
 */
export function voidriftConfigDir(): string {
  return path.join(configHome(), "voidrift");
}

/**
 * The absolute path of the package's SEED agent templates (`<pkg>/seed/agents`,
 * §13.9.1). Resolved MODULE-RELATIVE so it points at the same `seed/agents`
 * directory whether this module runs from `src/` (vitest) or the installed
 * `dist/` — both sit one level under the package root, so `../seed/agents/` from
 * either resolves to `<pkg>/seed/agents`. Shipped via `package.json` `files`.
 */
export function seedAgentsDir(): string {
  return fileURLToPath(new URL("../seed/agents/", import.meta.url));
}

/**
 * The absolute path of the package's SEED skill templates (`<pkg>/seed/skills`,
 * §12.1, §13.9.1), resolved module-relative like {@link seedAgentsDir} so it
 * points at the same directory from `src/` (vitest) or the installed `dist/`.
 * Shipped via `package.json` `files`.
 */
export function seedSkillsDir(): string {
  return fileURLToPath(new URL("../seed/skills/", import.meta.url));
}

/**
 * The absolute path of the package's shipped docs (`<pkg>/docs`,
 * §12.8), resolved module-relative like {@link seedSkillsDir} so it
 * points at the same directory from `src/` (vitest) or the installed `dist/`.
 * Shipped via `package.json` `files`.
 */
export function shippedDocsDir(): string {
  return fileURLToPath(new URL("../docs/", import.meta.url));
}

/**
 * The HOST-LEVEL `config.init` (core-blueprint.md §13.9.1), usable WITHOUT a
 * full core — no model, no network, no engine. It constructs the SAME
 * `ConfigInit` use-case the `createCore` facade's `config.init` delegates to
 * (one implementation, §13.9.1), rooted at the resolved global config dir and
 * the package seed templates, and runs it. The `voidrift init` command binds to
 * this directly so `voidrift init` on a fresh, offline machine seeds and repairs
 * the installation without booting a core (CLI §2.1). First-run seeding inside
 * `createCore` uses the identical use-case, so both paths stay in lock-step.
 */
export async function initConfigHome(
  opts: import("./use-cases/config-init.js").ConfigInitOptions = {},
): Promise<import("./entities/errors.js").Result<import("./use-cases/config-init.js").ConfigInitResult>> {
  return new ConfigInit(new NodeInitFs(), voidriftConfigDir(), seedAgentsDir).run(opts);
}

/**
 * Preview a `voidrift init --reset <name>` without writing (§13.9.1): the files
 * the reset would touch, each with the current on-disk content and the default
 * template. The CLI renders a line diff from this and asks for confirmation.
 * Host-level, like {@link initConfigHome}: no core, no model, no network.
 */
export async function previewInitReset(
  name: string,
): Promise<
  import("./entities/errors.js").Result<{ rel: string; current: string | null; def: string }[]>
> {
  return new ConfigInit(new NodeInitFs(), voidriftConfigDir(), seedAgentsDir).previewReset(name);
}

/** The valid `voidrift init --reset <name>` targets (`config` + seeded agents,
 * §13.9.1), for the CLI's unknown-name message. Host-level: no core. */
export function initResetNames(): string[] {
  return new ConfigInit(new NodeInitFs(), voidriftConfigDir(), seedAgentsDir).resetNames();
}

/**
 * Preview `voidrift init --update` (§13.9.1) without writing: the seeded
 * agent/skill files that are stale/customized/missing and the missing seeded
 * allow rules. Host-level, like {@link initConfigHome}: no core, no model, no
 * network. The CLI renders the diffs and asks ONE batched confirmation.
 */
export async function previewInitUpdate(): Promise<
  import("./entities/errors.js").Result<import("./use-cases/config-init.js").ConfigUpdatePlan>
> {
  return new ConfigInit(new NodeInitFs(), voidriftConfigDir(), seedAgentsDir).previewUpdate();
}

/** Apply `voidrift init --update` after the batch is confirmed (§13.9.1).
 * Host-level: no core, no model, no network. */
export async function applyInitUpdate(
  confirmed: boolean,
): Promise<import("./entities/errors.js").Result<import("./use-cases/config-init.js").ConfigUpdateResult>> {
  return new ConfigInit(new NodeInitFs(), voidriftConfigDir(), seedAgentsDir).applyUpdate(confirmed);
}

/** Apply `voidrift init --sweep` (§13.9.1): move the backup/editor-leftover
 * files from the global live directories and config root — and, when `dir` is a
 * project, that project's `.voidrift` live dirs and root — into fresh backup
 * sets. Host-level: no core, no model, no network. */
export async function sweepConfigHome(
  dir?: string,
): Promise<import("./entities/errors.js").Result<import("./use-cases/config-init.js").ConfigSweepResult>> {
  return new ConfigInit(new NodeInitFs(), voidriftConfigDir(), seedAgentsDir).sweep(dir);
}

/** Apply `voidrift init --migrate` (§13.9.1): persist the in-memory key
 * migration (§13.1) by rewriting each config layer (global and, when `dir` is a
 * project, that project's) that still names a retired key, backing the original
 * up first. Host-level: no core, no model, no network. */
export async function migrateConfigHome(
  dir?: string,
): Promise<import("./entities/errors.js").Result<import("./use-cases/config-init.js").ConfigMigrateResult>> {
  return new ConfigInit(new NodeInitFs(), voidriftConfigDir(), seedAgentsDir).migrate(dir);
}

/**
 * Scan the GLOBAL and PROJECT live resource directories (`agents/`, `skills/`,
 * `prompts/`) for backup- or editor-leftover files (§13.9.1, §12.1). A live
 * directory must hold only its canonical files; a leftover inside one makes
 * STARTUP FAIL (exit 3) with the fix `voidrift init --sweep`. The CLI calls this
 * BEFORE boot for a runnable command (chat / --prompt / --routine); `doctor`,
 * `init`, `--help`, and `--version` never call it, so they still run.
 *
 * Host-level and cheap: a shallow directory walk over `node:fs`, no model, no
 * network, no session. It scans a live dir itself, each `<dir>/<name>/`, and the
 * config-directory ROOT is NOT scanned here (a root `config.json.bak-*` never
 * blocks startup — it is a doctor warn, §13.9.2). Returns the offending absolute
 * paths (empty when clean). `workspaceRoot` defaults to `process.cwd()`.
 */
export async function scanLiveLeftovers(workspaceRoot: string = process.cwd()): Promise<string[]> {
  const { isLeftoverName } = await import("./config/live-leftovers.js");
  const roots = [voidriftConfigDir(), path.join(workspaceRoot, ".voidrift")];
  const offending: string[] = [];
  const scanTop = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() && isLeftoverName(e.name)) offending.push(path.join(dir, e.name));
    }
  };
  for (const root of roots) {
    for (const live of ["agents", "skills", "prompts"]) {
      const liveAbs = path.join(root, live);
      scanTop(liveAbs); // a leftover directly in the live dir
      let names: fs.Dirent[];
      try {
        names = fs.readdirSync(liveAbs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const n of names) {
        if (n.isDirectory()) scanTop(path.join(liveAbs, n.name)); // `<live>/<name>/<leftover>`
      }
    }
  }
  return offending;
}

/**
 * A cheap count of seeded defaults that are OUT OF DATE (unmodified older
 * defaults) or missing, for the interactive startup notice (cli §5.5, §13.9.1).
 * It reuses the `init --update` preview (hash compare of a handful of files, no
 * model, no network) and returns only what `--update` would actually change:
 * the stale/missing file rels plus any missing seeded allow rules. A customized
 * file is EXCLUDED (the notice never nags about a deliberate change). Returns
 * `{ count: 0, names: [] }` on any error so the notice is simply skipped.
 */
export async function seededDefaultsOutOfDate(): Promise<{ count: number; names: string[] }> {
  try {
    const plan = await previewInitUpdate();
    if (!plan.ok) return { count: 0, names: [] };
    const names = plan.value.files
      .filter((f) => f.status === "stale" || f.status === "missing")
      .map((f) => f.rel);
    const count = names.length + plan.value.missingAllowRules.length;
    if (plan.value.missingAllowRules.length > 0) names.push("seeded allow rules");
    return { count, names };
  } catch {
    return { count: 0, names: [] };
  }
}

/** True when the global `~/.config/voidrift/config.json` is ABSENT — i.e. this
 * is a first run that would trigger first-run seeding (§13.8). The CLI calls
 * this BEFORE boot to decide whether to print the one-time first-run notice.
 * Host-level and cheap: a single existence check through the one resolver. */
export function isFirstRun(): boolean {
  return !fs.existsSync(path.join(voidriftConfigDir(), "config.json"));
}

/**
 * The HOST-LEVEL `config.doctor` (core-blueprint.md §13.9.2), usable WITHOUT a
 * full core — no model, no engine, no session. It loads the config cascade,
 * discovers agents and skills, and runs every validation group READ-ONLY. Like
 * {@link initConfigHome}, the `voidrift doctor` command binds to this directly
 * so a doctor run works on a broken or model-less install (its main use). It
 * writes NOTHING. Network checks use real probes over undici unless `offline`.
 */
export async function doctorConfigHome(
  opts: import("./use-cases/config-doctor.js").DoctorOptions & { workspaceRoot?: string } = {},
): Promise<import("./use-cases/config-doctor.js").DoctorReport> {
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  const globalDir = voidriftConfigDir();
  const bus = new EventBus();
  const emit = (type: string, payload: unknown): void => bus.emit(type, payload, {});

  // Config cascade, loaded read-only. A rejected layer is recorded (reported),
  // never crashes. No seeding, no overlay — doctor only observes.
  const configStore = new FilesystemConfigStore(workspaceRoot, undefined, globalDir);
  const config = new ConfigCapability(configStore, emit);
  await config.load().catch(() => undefined);

  // Agents, cascaded project > global (the built-in `chat` is in code).
  const projectFs = new FilesystemAdapter(workspaceRoot);
  const globalFs = new FilesystemAdapter(globalDir);
  const agentsDir = new AgentsDirectory(projectFs, { project: ".voidrift/agents", global: "agents" }, globalFs);
  const definitions: AgentDefinition[] = [];
  const skippedAgents: { name: string; reason: string }[] = [];
  const seenAgent = new Set<string>();
  for (const source of ["project", "global"] as const) {
    const r = await agentsDir.discover(source).catch(() => ({ definitions: [], skipped: [] }));
    for (const d of r.definitions) {
      if (seenAgent.has(d.name)) continue; // project wins the cascade
      seenAgent.add(d.name);
      definitions.push(d);
    }
    skippedAgents.push(...r.skipped);
  }

  // Skills, cascaded, valid/invalid noted. The global dir sits outside the
  // workspace, so it is read through the dedicated `globalFs` (like the agents).
  const skillsDir = new SkillsDirectory(projectFs, { workspace: ".voidrift/skills", global: "skills" }, globalFs);
  const skillRows: { name: string; valid: boolean; dir: string }[] = [];
  const seenSkill = new Set<string>();
  for (const source of ["project", "global"] as const) {
    const r = await skillsDir.load(source).catch(() => ({ skills: [], skipped: [] as { name: string; reason: string }[] }));
    for (const s of r.skills) {
      if (seenSkill.has(s.name)) continue;
      seenSkill.add(s.name);
      skillRows.push({ name: s.name, valid: true, dir: skillsDir.skillFile(s.name, source) });
    }
    for (const s of r.skipped) {
      if (seenSkill.has(s.name)) continue;
      seenSkill.add(s.name);
      skillRows.push({ name: s.name, valid: false, dir: skillsDir.skillFile(s.name, source) });
    }
  }

  // Known tool names (built-ins; MCP/plugin tools are added once their
  // registries are read in a full boot — host doctor sees built-ins + config).
  const builtinDefs = builtinToolDefinitions();
  const knownNames = new Set<string>([
    ...builtinDefs.map((t) => t.def.name),
    "task",
    "wait",
    "ingest",
    "query_logs",
    "list_skills",
    "load_skill",
  ]);
  const mutatingNames = new Set<string>(builtinDefs.filter((t) => !t.def.readOnly).map((t) => t.def.name));

  const http = new FetchHttpAdapter();
  const deps: import("./use-cases/config-doctor.js").DoctorDeps = {
    config,
    agents: { definitions, skipped: skippedAgents },
    knownTools: () => knownNames,
    mutatingTools: () => mutatingNames,
    skills: () => skillRows,
    paths: {
      configDir: globalDir,
      configFile: path.join(globalDir, "config.json"),
      sessionsDir: path.join(workspaceRoot, ".voidrift", "sessions"),
      journalDir: path.join(workspaceRoot, ".voidrift", "journal"),
      seedAgentsDir: seedAgentsDir(),
      seedSkillsDir: seedSkillsDir(),
      registryDir: path.join(globalDir, "registry", registryWorkspaceKey(workspaceRoot)),
      workspaceRoot,
    },
    envSet: (name) => process.env[name] !== undefined && process.env[name] !== "",
    modelListProbe: makeModelListProbe(http),
    reachProbe: makeReachProbe(http),
    storage: makeStorageProbe(),
  };
  const { runDoctor } = await import("./use-cases/config-doctor.js");
  // §13.11 — when the caller did not force a timeout, use the resolved
  // `doctor.networkTimeoutMs` from the loaded cascade (falls back to the
  // registry default inside runDoctor when the config is unreadable).
  const { resolveLimits: resolveDoctorLimits } = await import("./entities/limits-resolve.js");
  const resolvedDoctorTimeout = (() => {
    try {
      const r = resolveDoctorLimits(config.limitLayers());
      return r.values.get("doctor.networkTimeoutMs")?.value;
    } catch {
      return undefined;
    }
  })();
  const effectiveTimeout = opts.timeoutMs ?? resolvedDoctorTimeout;
  return runDoctor(deps, { ...(opts.offline !== undefined ? { offline: opts.offline } : {}), ...(effectiveTimeout !== undefined ? { timeoutMs: effectiveTimeout } : {}) });
}

/**
 * The HOST-LEVEL `config.access` (cli-blueprint.md §7.4; core §3.1, §9.0), usable
 * WITHOUT a full core — no model, no engine, no session. It loads the config
 * cascade READ-ONLY, discovers agents (plus the built-in `chat` in code), and
 * builds the structured, secret-free {@link AccessReport}. Like
 * {@link doctorConfigHome} it binds directly so `voidrift access` works on a
 * model-less or broken install; it writes nothing and opens no network.
 *
 * `agent` names the top-level agent the report is about; when omitted the active
 * agent defaults to the first top-level agent by `order` (the built-in `chat`
 * unless an earlier one is seeded). `voidrift access [--enable-write]` passes the
 * agent its flags select (first `unlisted: deny`, or first `unlisted: allow`).
 */
export async function accessReportConfigHome(
  opts: { agent?: string; workspaceRoot?: string } = {},
): Promise<import("./use-cases/access-report.js").AccessReport> {
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  const globalDir = voidriftConfigDir();
  const bus = new EventBus();
  const emit = (type: string, payload: unknown): void => bus.emit(type, payload, {});

  const configStore = new FilesystemConfigStore(workspaceRoot, undefined, globalDir);
  const config = new ConfigCapability(configStore, emit);
  await config.load().catch(() => undefined);

  // Agents, cascaded project > global; the built-in `chat` (code) is always
  // present and can never be overridden out of the cycle (§3.1).
  const projectFs = new FilesystemAdapter(workspaceRoot);
  const globalFs = new FilesystemAdapter(globalDir);
  const agentsDir = new AgentsDirectory(projectFs, { project: ".voidrift/agents", global: "agents" }, globalFs);
  const definitions: AgentDefinition[] = [];
  const seen = new Set<string>();
  for (const source of ["project", "global"] as const) {
    const r = await agentsDir.discover(source).catch(() => ({ definitions: [], skipped: [] }));
    for (const d of r.definitions) {
      if (seen.has(d.name)) continue; // project wins
      seen.add(d.name);
      definitions.push(d);
    }
  }
  const { builtinChatAgent } = await import("./entities/builtin-chat.js");
  if (!seen.has("chat")) definitions.push(builtinChatAgent());

  // The active agent: the named one if given and top-level, else the first
  // top-level by `order` (tie: name).
  const topLevel = definitions
    .filter((d) => d.kind === "top-level")
    .slice()
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.name.localeCompare(b.name));
  const named = opts.agent ? topLevel.find((d) => d.name === opts.agent) : undefined;
  const active = named?.name ?? topLevel[0]?.name ?? "chat";

  const { buildAccessReport } = await import("./use-cases/access-report.js");
  const isGitRepo = await (async () => {
    const r = await runHardenedGit(workspaceRoot, ["rev-parse", "--is-inside-work-tree"]);
    return r.ok && r.stdout.trim() === "true";
  })();
  return buildAccessReport({ config, agents: definitions, activeAgent: active, isGitRepo });
}

/** A model-listing probe over the HTTP port: GET <baseUrl>/models, sending the
 * key ONLY to the baseUrl host and NOT following a cross-host redirect (§13.9.2). */
function makeModelListProbe(
  http: FetchHttpAdapter,
): import("./use-cases/config-doctor.js").ModelListProbe {
  return async (baseUrl, { apiKeyEnv, timeoutMs }) => {
    let base: URL;
    try {
      base = new URL(baseUrl);
    } catch {
      return { reachable: false, status: null, reason: "invalid baseUrl" };
    }
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const headers: Record<string, string> = {};
    const key = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
    if (key) headers["authorization"] = `Bearer ${key}`;
    try {
      const res = await http.fetchOnce({ url, timeoutMs, userAgent: "voidrift-doctor", ...(Object.keys(headers).length ? { headers } : {}) });
      // A cross-host redirect is NOT followed: flag and stop.
      if (res.status >= 300 && res.status < 400 && res.location) {
        try {
          const dest = new URL(res.location, url);
          if (dest.host !== base.host) return { reachable: true, status: res.status, crossHostRedirect: true };
        } catch {
          /* ignore */
        }
      }
      let modelIds: string[] = [];
      try {
        const { bytes } = await res.readBodyCapped(1_000_000);
        const body = JSON.parse(Buffer.from(bytes).toString("utf8")) as { data?: { id?: string }[] };
        if (Array.isArray(body.data)) modelIds = body.data.map((d) => d.id).filter((x): x is string => typeof x === "string");
      } catch {
        /* a non-JSON or truncated body: endpoint reachable, listing unknown */
      }
      return { reachable: true, status: res.status, modelIds };
    } catch (e) {
      return { reachable: false, status: null, reason: e instanceof Error && e.name === "AbortError" ? "timeout" : "unreachable" };
    }
  };
}

/** A generic reachability probe (GET, no key) that does not follow redirects. */
function makeReachProbe(http: FetchHttpAdapter): import("./use-cases/config-doctor.js").ReachProbe {
  return async (url, { timeoutMs }) => {
    try {
      const res = await http.fetchOnce({ url, timeoutMs, userAgent: "voidrift-doctor" });
      return { reachable: true, status: res.status };
    } catch (e) {
      return { reachable: false, status: null, reason: e instanceof Error && e.name === "AbortError" ? "timeout" : "unreachable" };
    }
  };
}

/** Storage probes over node:fs — all read-only (stat/lstat/statfs). */
function makeStorageProbe(): import("./use-cases/config-doctor.js").StorageProbe {
  return {
    async modeOf(abs) {
      try {
        return (await fsp.stat(abs)).mode;
      } catch {
        return null;
      }
    },
    async isSymlink(abs) {
      try {
        return (await fsp.lstat(abs)).isSymbolicLink();
      } catch {
        return false;
      }
    },
    async freeBytes(abs) {
      try {
        const s = await fsp.statfs(abs);
        return s.bavail * s.bsize;
      } catch {
        return null;
      }
    },
    async dirUsable(abs) {
      try {
        await fsp.access(abs);
        return true;
      } catch {
        // Walk up to the nearest EXISTING ancestor; the dir is creatable when
        // that ancestor is accessible (writable). A bare workspace has neither
        // `.voidrift` nor its children yet, but the workspace root exists.
        let cur = path.dirname(abs);
        for (;;) {
          try {
            await fsp.access(cur);
            return true;
          } catch {
            const parent = path.dirname(cur);
            if (parent === cur) return false;
            cur = parent;
          }
        }
      }
    },
    async readFile(abs) {
      try {
        return await fsp.readFile(abs, "utf8");
      } catch {
        return null;
      }
    },
    async listDirs(abs) {
      try {
        const entries = await fsp.readdir(abs, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        return [];
      }
    },
    async listLeftovers(abs, recurseOneLevel) {
      const { isLeftoverName } = await import("./config/live-leftovers.js");
      const out: string[] = [];
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fsp.readdir(abs, { withFileTypes: true });
      } catch {
        return out;
      }
      for (const e of entries) {
        if (!e.isDirectory() && isLeftoverName(e.name)) out.push(path.join(abs, e.name));
      }
      if (recurseOneLevel) {
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const sub = path.join(abs, e.name);
          let subEntries: import("node:fs").Dirent[];
          try {
            subEntries = await fsp.readdir(sub, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const s of subEntries) {
            if (!s.isDirectory() && isLeftoverName(s.name)) out.push(path.join(sub, s.name));
          }
        }
      }
      return out;
    },
    async gitConfigScan(workspaceRoot) {
      const { scanRepoConfig } = await import("./adapters/git-harden.js");
      return scanRepoConfig(workspaceRoot).classes;
    },

    async isGitRepo(workspaceRoot) {
      const code = await runHardenedGit(workspaceRoot, ["rev-parse", "--is-inside-work-tree"]);
      return code.ok && code.stdout.trim() === "true";
    },

    async countVoidriftRefs(workspaceRoot) {
      const res = await runHardenedGit(workspaceRoot, ["for-each-ref", "--format=%(refname)", "refs/voidrift"]);
      if (!res.ok) return 0;
      return res.stdout.split("\n").filter((l) => l.trim() !== "").length;
    },

    async dirSizeBytes(abs) {
      let total = 0;
      async function walk(dir: string): Promise<void> {
        let entries: import("node:fs").Dirent[];
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) await walk(p);
          else if (e.isFile()) {
            try {
              total += (await fsp.stat(p)).size;
            } catch {
              /* unreadable file counts 0 */
            }
          }
        }
      }
      await walk(abs);
      return total;
    },

    async movesPerSession(snapshotsDir) {
      const out: { sessionId: string; moves: number }[] = [];
      let sessions: import("node:fs").Dirent[];
      try {
        sessions = await fsp.readdir(snapshotsDir, { withFileTypes: true });
      } catch {
        return out;
      }
      for (const s of sessions) {
        if (!s.isDirectory()) continue;
        let moves = 0;
        try {
          const raw = await fsp.readFile(path.join(snapshotsDir, s.name, "timeline.json"), "utf8");
          const parsed = JSON.parse(raw) as { moves?: unknown[] };
          moves = Array.isArray(parsed.moves) ? parsed.moves.length : 0;
        } catch {
          moves = 0;
        }
        out.push({ sessionId: s.name, moves });
      }
      return out;
    },

    async untrustedRollbackSessions(snapshotsDir) {
      // §10.12 — verify each session's timeline.json HMAC against THIS install's
      // key; a missing/invalid one is planted/untrusted. Value-free: ids only.
      const { RollbackIntegrity } = await import("./adapters/rollback-integrity.js");
      const integrity = new RollbackIntegrity(voidriftConfigDir());
      // The workspace realpath binding matches the store's: snapshotsDir is
      // `<workspaceRoot>/.voidrift/cache/snapshots`, so strip that suffix.
      const marker = `${path.sep}.voidrift${path.sep}cache${path.sep}snapshots`;
      const ws = snapshotsDir.endsWith(marker) ? snapshotsDir.slice(0, -marker.length) : snapshotsDir;
      const out: string[] = [];
      let sessions: import("node:fs").Dirent[];
      try {
        sessions = await fsp.readdir(snapshotsDir, { withFileTypes: true });
      } catch {
        return out;
      }
      for (const s of sessions) {
        if (!s.isDirectory()) continue;
        let parsed: { hmac?: string; refs?: unknown } & Record<string, unknown>;
        try {
          const raw = await fsp.readFile(path.join(snapshotsDir, s.name, "timeline.json"), "utf8");
          parsed = JSON.parse(raw) as typeof parsed;
        } catch {
          continue; // no/broken timeline → nothing to flag here
        }
        const { hmac, ...rest } = parsed;
        if (!integrity.verify(rest, s.name, ws, hmac)) out.push(s.name);
      }
      return out;
    },

    async registryCounts(registryDir) {
      // §12.5 — read each plugin's registry file under the workspace's registry
      // dir and count `routine:`/`plan:` keys by NAME only (never a value).
      const result = { routines: [] as string[], plans: [] as string[] };
      let files: import("node:fs").Dirent[];
      try {
        files = await fsp.readdir(registryDir, { withFileTypes: true });
      } catch {
        return result;
      }
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith(".json")) continue;
        try {
          const raw = await fsp.readFile(path.join(registryDir, f.name), "utf8");
          const parsed: unknown = JSON.parse(raw);
          if (!isRegistryFile(parsed)) continue;
          for (const key of Object.keys(parsed.entries)) {
            if (key.startsWith("routine:")) result.routines.push(key.slice("routine:".length));
            else if (key.startsWith("plan:")) result.plans.push(key.slice("plan:".length));
          }
        } catch {
          /* a malformed file is skipped (the store sets it aside at load) */
        }
      }
      return result;
    },
  };
}

/** The 16-hex workspace key the durable registry uses (§12.5): the first 16 hex
 * of SHA-256 of the workspace REAL path, so the doctor registry-dir path matches
 * the store's. Falls back to the resolved path when realpath cannot resolve. */
function registryWorkspaceKey(workspaceRoot: string): string {
  let real = workspaceRoot;
  try {
    real = fs.realpathSync.native(workspaceRoot);
  } catch {
    real = path.resolve(workspaceRoot);
  }
  return workspaceKey(real);
}

/** Run a read-only git command through the hardened runner for the doctor
 * rollback checks (§10.12, §13.9.2). Never throws; returns `{ ok, stdout }`. */
async function runHardenedGit(
  root: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string }> {
  const { hardenedGitArgs, hardenedGitEnv, scanRepoConfig } = await import("./adapters/git-harden.js");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const scan = scanRepoConfig(root);
  const hardened = hardenedGitArgs(args, scan, true);
  try {
    const { stdout } = await execFileAsync("git", hardened, {
      cwd: root,
      env: hardenedGitEnv(),
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout) };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/**
 * The §4.4 session-meta-block git fields through the hardened runner. Returns the
 * current branch and a one-line clean/dirty summary (a count of changed paths),
 * or `{ branch: null }` when the directory is not a repo or git fails. NEVER
 * carries a remote URL and never throws — it must never block or fail a turn.
 */
async function gitMetaForEngine(
  root: string,
): Promise<{ branch: string | null; dirty: string | null }> {
  const inside = await runHardenedGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") return { branch: null, dirty: null };
  const br = await runHardenedGit(root, ["branch", "--show-current"]);
  const branch = br.ok && br.stdout.trim() !== "" ? br.stdout.trim() : null;
  const st = await runHardenedGit(root, ["status", "--porcelain"]);
  let dirty: string | null = null;
  if (st.ok) {
    const changed = st.stdout.split("\n").filter((l) => l.trim() !== "").length;
    dirty = changed === 0 ? "clean" : `${changed} changed`;
  }
  return { branch, dirty };
}

/**
 * A short random id for an out-of-band plugin-install approval request (§12.4.1).
 */
function newApprovalId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * A tiny module-local promise-queue mutex (§9.2, Slice C3) — no dependency. It
 * serialises the `persistProjectRule` read-modify-write PER PROCESS so two
 * approvals resolving at once can never read-then-overwrite each other and lose
 * an update: each `run` chains after the previous one, success or failure.
 */
let persistQueue: Promise<unknown> = Promise.resolve();
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = persistQueue.then(fn, fn);
  // Keep the chain alive regardless of this task's outcome (never reject the
  // shared tail), so a failed persist does not wedge later ones.
  persistQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
/** Slugify a candidate title into a valid skill name (§12.1 name rule). */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "skill";
}

/** Construct the core and return the ready result (§2.1). */
export async function createCore(opts: CoreOptions = {}): Promise<CoreReady> {
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  const bus = new EventBus();
  const emit = (type: string, payload: unknown): void => bus.emit(type, payload, {});

  // Config cascade (§13). The production default is the on-disk filesystem store
  // rooted at the workspace with the global layer under the one `~/.config/voidrift`
  // resolver (§13.1); the in-memory store is an explicit injected test seam only.
  const configStore =
    opts.configStore ?? new FilesystemConfigStore(workspaceRoot, undefined, voidriftConfigDir());
  const config = new ConfigCapability(configStore, emit);
  // The host-only `config.init` use-case (§13.9.1), constructed once and shared
  // with the facade deps below so first-run seeding and `voidrift init` use the
  // SAME code path (§13.8).
  const configInit = new ConfigInit(new NodeInitFs(), voidriftConfigDir(), seedAgentsDir);
  // §13.8 — first-run seeding is `config.init` (global form), run ONLY for the
  // production default store (no injected `configStore`) when the global
  // `config.json` is absent. An injected store (VS Code, web, desktop, tests)
  // never triggers it, so existing host behaviour is unchanged; the old
  // `seedConfig()` seed is replaced by the full §13.8 document `config.init`
  // writes. An unwritable dir is recoverable (§2.1): `config.init` fails soft and
  // the seed document is held IN MEMORY so the endpoint still resolves and boot
  // proceeds — never a construction error (§13.3).
  let inMemorySeed: Record<string, unknown> | undefined;
  if (!opts.configStore && !config.paths().global.exists) {
    const seeded = await configInit.run({ scope: "global" }).catch(() => null);
    if (!seeded || !seeded.ok || !config.paths().global.exists) {
      inMemorySeed = seedConfigDocument();
      bus.emit(
        "WARNING_EMITTED",
        { category: "config-seed", source: "config", reason: "first-run config dir not writable; using the in-memory seed (§13.3)" },
        {},
      );
    }
  }
  await config.load(inMemorySeed);
  // Per-process overrides compose above the session layer, for the span of the
  // core (§2.1, §13.1); never written to disk.
  if (opts.configOverrides) {
    config.setProcessOverlay(opts.configOverrides as Record<string, unknown>);
  }

  // §13.11 — the ONE runtime limits capability. Built from the layered config
  // (`config.limitLayers()`) through the pure `resolveLimits`, injected as the
  // `LimitsPort` into every use-case and tool factory that bounds behaviour, and
  // re-resolved on `CONFIG_RESOLVED` so a config edit (or managed install) takes
  // effect immediately. The engine calls `limits.resetTurn()` at each turn
  // boundary (like the chat/read lanes). Pieces built directly in tests default
  // to the registry defaults, so this is the only place the layered set is read.
  const limits = new LimitsCapability(resolveLimits(config.limitLayers()), bus, { workspace: workspaceRoot });
  bus.subscribe("CONFIG_RESOLVED", () => limits.setResolved(resolveLimits(config.limitLayers())));

  // Model port (§11).
  const model = new ModelProviderAdapter(
    () => config.get(),
    emit,
    opts.chatModelFactory,
  );

  // §5.5 — the session-naming port. The PRODUCTION default wraps the primitive
  // `suggestSessionName` over a FRESH client (`transientChatModel`) so the
  // passive call never shares or races the interactive turn's cached client.
  // When a host/test injected a custom `chatModelFactory`, the default is a
  // NO-OP (first-line fallback only) — so finite scripted `fakeModel` fixtures
  // are never perturbed by an extra passive model call — UNLESS the caller
  // injected a `namingPort` explicitly.
  const namingPort: NamingPort =
    opts.namingPort ??
    (opts.chatModelFactory
      ? noopNamingPort
      : {
          suggest: (ctx) =>
            suggestSessionName(model.transientUtilityModel(), ctx.current, ctx.turnSummary, {
              nameMaxChars: limits.get("session.nameMaxChars"),
              timeoutMs: limits.get("session.namingTimeoutMs"),
            }),
        });

  // §8.5/§13.9 — the effective `webSearch` is the cascaded config as-is. A
  // `webSearch` block (including its `endpoint`) may be set in ANY layer; a
  // project `.voidrift/config.json` may point the user at a self-hosted
  // instance. The schema's endpoint-validity rules still apply (searxng must be
  // https, or http only to a loopback/private host; no embedded credentials),
  // and a private/loopback/link-local/metadata endpoint is force-asked on every
  // `web_search` call at the one gate (§9.3) — visibility, not a layer gate, is
  // the safeguard.
  const resolveWebSearch = (): import("./config/schema.js").WebSearchConfig => config.get().webSearch;

  // Warden runs FIRST at the decision point, then Guardian (§9.1). Warden emits
  // its compliance events through an injected sink mapped onto the bus (§14.6);
  // a judge port decides typed-verdict OUTCOMES (§9.6) — wired from the MCP Judge
  // when configured, else null (a judge rule then fails like an unreachable
  // judge). Policy is loaded from the configured source and cached (§8.5).
  const complianceCfg = config.get().compliance;
  const wardenEvents: WardenEvents = {
    loaded: (p) => bus.emit("COMPLIANCE_LOADED", p, {}),
    violation: (p) => bus.emit("COMPLIANCE_VIOLATION", p, { session: "orchestrator" }),
    blocked: (p) => bus.emit("COMPLIANCE_BLOCKED", p, { session: "orchestrator" }),
  };
  const warden = new Warden(
    { mode: complianceCfg.mode, ...(complianceCfg.source ? { source: complianceCfg.source } : {}) },
    null,
    wardenEvents,
  );
  const guardian = new Guardian(builtinGuardrails());

  // Tool registry + built-in suite classification surface (§8.1, §8.2).
  // deepagents supplies the executable filesystem/shell tools over its backend;
  // the registry is the §8.1 readOnly-classification and listing surface.
  const registry = new ToolRegistry();
  void opts.shell;
  for (const t of builtinToolDefinitions()) {
    registry.register(t.def, t.exec);
  }

  // Checkpointer (§5 default). The durable default is `SqliteSaver` writing
  // `.voidrift/checkpoint.db` under the workspace state dir (§5.1); an injected
  // checkpointer (tests, hosted Postgres) overrides it (§2.1). The run-level
  // `durability: "exit"` is applied by the engine per turn (§5.2, substrate #6).
  const checkpointer = opts.checkpointer ?? createSqliteCheckpointer(workspaceRoot);

  // Session repository (§5.1). The production default is the durable filesystem
  // store writing the partition under `.voidrift/sessions/{id}/` so a resume in
  // ANY process restores the whole session (§5.3); the in-memory store stays an
  // explicit injected test seam (§1 rule 7, §2.1).
  const sessions = opts.sessionRepository ?? new FilesystemSessionRepository(workspaceRoot);

  // The managed layer (§13.5) — resolved after the FileSystemPort is wired
  // below. Declared here so the engine factory (a lazy closure) can read its
  // gate without a forward reference.
  let managedLayer: ManagedLayer | undefined;
  const managedGate = (): { reason: string } | null => managedLayer?.gate() ?? null;

  // §8.4 — the bounded MCP-connect barrier the first turn awaits (assigned at the
  // autoConnect site below, once `mcpClient` exists). Declared here so the lazy
  // engine closure can read it without a forward reference; defaults to resolved.
  let mcpAutoConnect: Promise<void> = Promise.resolve();
  const mcpReady = (): Promise<void> => mcpAutoConnect;

  // §2.7 — the shared active-agent resolver: the ONE place a session's active
  // top-level agent name resolves to its definition, read live by the engine
  // and every worker. Late-bound to the facade's shared Subagents registry
  // after the CoreAPI is constructed (the registry owner), so a reindexed or
  // overridden agent is reflected everywhere. Until bound it resolves to
  // undefined → the engine falls back to the complete tool set and an `ask`
  // posture.
  let resolveActiveAgent: ((mode: string) => AgentDefinition | undefined) | undefined;
  // §7 — the engine's `task` tool fans out through the facade's SHARED Subagents
  // (the SAME instance `api.subagents.dispatch` uses). Late-bound to the facade
  // after the CoreAPI is constructed, exactly like `resolveActiveAgent`. Until
  // bound, `task` is simply not built (the engine falls back to no delegation).
  let dispatchForEngine:
    | ((requests: import("./use-cases/subagents.js").DispatchRequest[], signal?: AbortSignal, maxConcurrency?: number) => Promise<import("./use-cases/subagents.js").FanoutResult>)
    | undefined;
  let resolveDispatchableWorkers: ((agent: AgentDefinition) => { name: string; description: string }[]) | undefined;
  // §8.7 — the Ingest use-case, wired below over the real seams (workspace read
  // path, the digest cache, registered chunkers, and the INTERNAL summarizer
  // dispatch into the SAME shared Subagents). Late-bound like `dispatchForEngine`
  // because its `dispatchSummarize` routes through the facade, which is built
  // after `makeEngine` is defined. Until bound, the engine simply does not bind
  // the `ingest` tool.
  let ingestForEngine: import("./use-cases/ingest.js").Ingest | undefined;

  // §10.11 — the mutation journal. The fs store lives under the session storage
  // root (`<workspaceRoot>/.voidrift/journal/<sessionId>/`), the same state dir
  // as `checkpoint.db`. Stored RAW (unmasked), directories 0700 / files 0600;
  // it is a PROTECTED CONTROL LOCATION (Guardian). The recorder builds one entry
  // per write action; the content-capture level is `config.mutationLogLevel`.
  const journalStore = opts.journalStore ?? new FilesystemJournalStore({ stateDir: path.join(workspaceRoot, ".voidrift"), getLimit: (key) => limits.get(key) });
  const journalRecorder = new JournalRecorder({
    store: journalStore,
    getLevel: () => config.get().mutationLogLevel,
    getLimit: (key) => limits.get(key),
  });

  const makeEngine = (turnMetadata?: () => string[]): Engine => {
    // send() guards model resolution before this is called (§3.3), so chatModel
    // resolves here.
    const chatModel: BaseChatModel = model.chatModel();
    const resolved = model.resolve();
    const cfg = config.get();
    const entry = cfg.models[resolved.name];
    const endpointPercents = {
      ...(entry?.contextActiveBudgetPct !== undefined ? { activeBudgetPct: entry.contextActiveBudgetPct } : {}),
      ...(entry?.contextCompactionPct !== undefined ? { compactionPct: entry.contextCompactionPct } : {}),
      ...(entry?.contextSafetyNetPct !== undefined ? { safetyNetPct: entry.contextSafetyNetPct } : {}),
      ...(entry?.contextHeadBudgetPct !== undefined ? { headBudgetPct: entry.contextHeadBudgetPct } : {}),
      ...(entry?.contextNoticePcts !== undefined ? { noticePcts: entry.contextNoticePcts } : {}),
    };
    return new Engine({
      chatModel,
      modelName: resolved.name,
      registry,
      guardian,
      warden,
      checkpointer,
      bus,
      getConfig: () => config.get(),
      managedGate,
      limits,
      // §9.2 / Slice C3 — persist an approved allow rule to the PROJECT allow
      // list only. Serialised per process by `runExclusive` so two approvals
      // can never read-then-overwrite and lose an update (§9.2, Slice C3). Read
      // the project layer's CURRENT permissions first so existing entries are
      // preserved and never reordered, merge by id (idempotent: an identical
      // entry is a no-op), and write through the Config capability (validation,
      // managed floor, atomic write; it creates `<workspace>/.voidrift/config.json`
      // 0700/0600 if missing). Resolves to a reason on failure so the engine
      // falls back to approve-once.
      persistProjectRule: (rule, id) =>
        runExclusive(async () => {
          try {
            const existing = config.layerPermissions("project");
            const res = await config.set("permissions", { ...existing, [id]: rule }, "project");
            if (!res.ok) return { reason: res.error.message };
            return null;
          } catch (e) {
            return { reason: e instanceof Error ? e.message : String(e) };
          }
        }),
      workspaceRoot,
      globalConfigDir: voidriftConfigDir(),
      home: os.homedir(),
      tempDir: systemTempDir(),
      window: resolved.contextLimit,
      maxOutputTokens: resolved.maxOutputTokens ?? null,
      modelId: resolved.model,
      protocol: resolved.protocol,
      vision: resolved.vision,
      resolveModelEntryFile: (name) => {
        const p = config.modelEntryFile(name);
        return p ? tildeHome(p, os.homedir()) : undefined;
      },
      endpointPercents,
      memory,
      skills,
      manuals,
      mcpReady,
      voidProviders: () => {
        // §4.2 / §9.6 — the Warden policy text goes into protected (void-layer)
        // context whenever a policy is configured, independent of mode, so the
        // model always knows the standard it works under.
        const blocks = contextBlocks("void");
        const policyText = warden.policyText();
        if (policyText) blocks.push(`# Compliance policy (Warden)\n${policyText}`);
        return blocks;
      },
      // §2.7a/§12.2 — the active top-level agent's prompt IS the system-prompt
      // overlay (resolved live from the shared Subagents registry); it replaces
      // the former `mode.*` prompt-cascade keys. The engine also uses this to
      // filter the bound tool set and the decision point reads the agent's
      // `unlisted` posture.
      getActiveAgent: (mode) => resolveActiveAgent?.(mode),
      // §7 — fan out one or more worker requests through the facade's shared
      // Subagents; the engine binds the model-callable `task` tool over it (and
      // resolves the dispatchable workers for the per-agent description). Both
      // are late-bound to the CoreAPI; `makeEngine` is only CALLED per turn, long
      // after the CoreAPI is constructed, so both are bound by then.
      dispatchTask: (reqs, signal) =>
        dispatchForEngine
          ? dispatchForEngine(reqs, signal)
          : Promise.reject(new Error("subagents dispatch not ready")),
      resolveDispatchableWorkers: (agent) => resolveDispatchableWorkers?.(agent) ?? [],
      // §8.7 — the Ingest use-case backing the model-callable `ingest` tool. A
      // getter so the per-turn `makeEngine` sees the late-bound instance (bound
      // after the facade is constructed). Absent → `ingest` is not bound.
      get ingest() {
        return ingestForEngine;
      },
      // §4.4 — the session meta block's git fields through the HARDENED runner:
      // branch + a one-line porcelain clean/dirty summary, never a remote URL,
      // never blocking (a failure yields `{ branch: null }` → `git: no`).
      gitMeta: () => gitMetaForEngine(workspaceRoot),
      // §4.4/§8.7 — the effective ingest fan-out cap for the concurrency line.
      ingestParallel: () => limits.effectiveIngestParallel(config.get().turnMaxConcurrency),
      writeCache: async (sessionId, name, content) => {
        await fileSystem.writeFile(path.join(".voidrift", "cache", "session", sessionId, name), content);
      },
      // §8.3 — the evicted large-result cache is written atomically and private
      // (mode 0600): the file persists on disk and holds the FULL (already
      // masked) tool result, so it must never be world-readable nor seen
      // half-written. The adapter's `resolve` proves containment under the
      // workspace, and `session.delete` removes the whole session cache dir.
      writeEvictedResult: async (sessionId, name, content) => {
        await fileSystem.writeFileAtomic(
          path.join(".voidrift", "cache", "session", sessionId, name),
          content,
          { mode: 0o600 },
        );
      },
      ...(turnMetadata ? { turnMetadata } : {}),
      // §8.2 — the HTTP seam `web_fetch` reaches the network through; the real
      // adapter uses Node's global fetch (undici) + dns.lookup, with manual
      // redirects and a mid-stream body cap. SSRF-range URLs are force-asked at
      // the gate (§9.3); the use-case re-checks DNS and every redirect hop.
      http: new FetchHttpAdapter(),
      // §8.5/§13.9 — the effective (cascaded) `webSearch` config the search
      // executor uses. A private/loopback/link-local/metadata endpoint is
      // force-asked on every `web_search` call at the one gate (§9.3).
      resolveWebSearch: () => resolveWebSearch(),
      // §8.6 — `researcher_save_notes` writes confined to `findingsDirectories`
      // through the SAME workspace-rooted FileSystemPort the file tools use
      // (symlink-safe containment chokepoint + atomic 0600/0700 writes).
      notesFileSystem: fileSystem,
      workspaceFileSystem: fileSystem,
      // §10.11 — the mutation journal. The orchestrator records every write
      // through the recorder; `readTargetBytes` reads a file target's RAW
      // before-state through the DoS-safe bounded reader (LOW-3): it STATS first
      // and, for a target over the per-target cap, reads at most cap+1 bytes
      // (positioned) instead of loading the whole file. The journal store is a
      // PROTECTED CONTROL LOCATION the file/shell tools can neither read nor
      // write (Guardian).
      journal: journalRecorder,
      // §10.11/§9.5.1 — the active plan-scope id a journaled write stamps as its
      // `planStep` (recorded metadata only; it influences no decision, invariant
      // 27), so the scope-targets reader can bind a scope's prediction to the
      // writes it drove. Undefined when no plan-scope grant is live.
      getActiveScopeId: () => apiRef?.getActiveJournalScopeId(),
      // §10.12 — rollback capture for the orchestrator's writing turns. The
      // service is constructed just below (after the VCS adapter resolves the
      // method); makeEngine is only CALLED later, so the closure captures it.
      get rollback() {
        return rollbackService;
      },
      readTargetBytes: async (relPath: string): Promise<Buffer | null> => {
        try {
          const abs = path.isAbsolute(relPath) ? relPath : path.join(workspaceRoot, relPath);
          const res = readTargetBytesBounded(abs);
          return res ? res.bytes : null;
        } catch {
          return null;
        }
      },
    });
  };

  // The VCS adapter owns the worktree lifecycle and the branch watch (§7.3).
  const vcs = new VcsAdapter(workspaceRoot, emit, () => limits.get("worktree.includeCapBytes"));

  // §10.12 — rollback: the move timeline + whole-tree snapshots. The METHOD is
  // fixed per process at first use: `git` when the workspace is a git repository
  // (and git runs — every call goes through the hardened runner), else the
  // best-effort `cache` method under `.voidrift/cache/snapshots/` (a PROTECTED
  // CONTROL LOCATION). The service owns the per-session timeline + id counter,
  // captures around a writing turn, and serves the host-only undo/redo/goto.
  const snapshotStore: SnapshotStore = vcs.isRepo()
    ? new GitSnapshotStore({
        root: workspaceRoot,
        globalConfigDir: voidriftConfigDir(),
        // §13.11 SNAP2 — effective git-capture timeout.
        captureTimeoutMs: limits.get("rollback.gitCaptureTimeoutMs"),
        // §10.12 — ONE value-free warning when planted/untrusted rollback state
        // is found, or a capture degrades under the cost budget.
        onUntrusted: (sessionId) =>
          bus.emit(
            "WARNING_EMITTED",
            { category: "rollback", source: "integrity", pattern: `rollback history for session ${sessionId} was not created by this install and was ignored` },
            { session: sessionId },
          ),
        onSnapshotDegraded: (sessionId) =>
          bus.emit("WARNING_EMITTED", { category: "rollback", source: "snapshot-cost" }, { session: sessionId }),
        onSwept: (sessionId, count) =>
          bus.emit(
            "WARNING_EMITTED",
            { category: "rollback", source: "crash-sweep", pattern: `recovered ${count} leftover rollback staging file(s) from a prior crash` },
            { session: sessionId },
          ),
      })
    : new CacheSnapshotStore({
        workspaceRoot,
        globalConfigDir: voidriftConfigDir(),
        // §13.11 SNAP1 — effective per-file / per-session snapshot caps.
        perFileBytes: limits.get("rollback.cachePerFileBytes"),
        sessionBytes: limits.get("rollback.cacheSessionBytes"),
        onUntrusted: (sessionId) =>
          bus.emit(
            "WARNING_EMITTED",
            { category: "rollback", source: "integrity", pattern: `rollback history for session ${sessionId} was not created by this install and was ignored` },
            { session: sessionId },
          ),
        onSwept: (sessionId, count) =>
          bus.emit(
            "WARNING_EMITTED",
            { category: "rollback", source: "crash-sweep", pattern: `recovered ${count} leftover rollback staging file(s) from a prior crash` },
            { session: sessionId },
          ),
      });
  const rollbackService = new RollbackService({
    store: snapshotStore,
    getSnapshotCount: () => limits.get("rollback.snapshotCount"),
    getLimit: (key) => limits.get(key),
    emit: (type, payload, sessionId) => bus.emit(type, payload, { session: sessionId }),
    // §10.11 — each applied rollback step is itself a write action journaled as
    // tool `rollback`, target = the restored paths, undoHint = the opposite cmd.
    journalStep: async (sessionId, step) => {
      try {
        await journalRecorder.record({
          sessionId,
          turn: 0,
          tool: "rollback",
          args: { action: step.action, paths: step.paths },
          target: step.paths.join(", ").slice(0, 200),
          result: { status: "ok", summary: `rollback ${step.action}: ${step.paths.length} file(s) restored` },
          undoHint: step.undoHint,
        });
      } catch {
        /* a journal failure must not fail the restore it is recording */
      }
    },
  });

  // The durable staging adapter owns the no-repo writer path (§7.4): read-through
  // staging under `.voidrift/cache/staging/{run}/` with temp-and-rename durability.
  const staging = new FilesystemStagingAdapter(workspaceRoot);

  // The Memory capability (§6). The default durable adapter is filesystem-backed
  // (§6.1); a hosted deployment swaps another BaseStore behind the seam. The
  // suggestions directory and AGENTS.md discovery reach the host through the
  // FileSystemPort (§1 rule 3); tests inject in-memory implementations.
  const fileSystem: FileSystemPort = opts.fileSystem ?? new FilesystemAdapter(workspaceRoot);

  // ── Managed layer (§13.5) ───────────────────────────────────────────────────
  // When `managedSource` is configured the deployment is managed: the layer is
  // read from a source the user process cannot write, validated, and installed as
  // the highest-priority loosen-proof layer. A missing/unreadable/invalid managed
  // layer fails closed (every gated action denied with `managed_layer_unavailable`)
  // and the status is reported on CoreReady + MANAGED_LAYER_STATUS (§2.1, §14.6).
  managedLayer = new ManagedLayer({
    ...(opts.managedSource ? { source: opts.managedSource } : {}),
    fs: fileSystem,
    installManagedDoc: async (doc) => config.installManagedLayer(doc),
    emitStatus: (payload) => bus.emit("MANAGED_LAYER_STATUS", payload, {}),
  });
  const managedStatus = await managedLayer.resolve();

  // The process-start active agent (§2.1, §2.7) is the host's
  // `CoreOptions.startAgent` (the CLI's headless selection — first `deny`, or
  // first `allow` under `--enable-write`), passed to the facade deps below. The
  // `autoApprove` alias was removed; the managed `autoApproveAllowed: false`
  // refusal for an `unlisted: allow` start agent is enforced by boot after the
  // agent reindex (and by `setMode` mid-session).

  // ── Warden policy (§9.6) ────────────────────────────────────────────────────
  // Load the configured policy source and cache it locally with a recorded
  // version/hash so a decision never needs the network (§8.5). A directory or
  // file source is read through the FileSystemPort; the loaded policy's text goes
  // into protected context whenever configured, independent of mode (§4.2). A
  // source that cannot be read leaves Warden with no policy — enforcing then fails
  // closed at the decision point (§9.6).
  if (complianceCfg.source) {
    try {
      const raw = await fileSystem.readFile(complianceCfg.source);
      const parsed = JSON.parse(raw) as { version?: string; rules?: never; text?: string };
      warden.setPolicy(loadPolicy(parsed));
    } catch (e) {
      bus.emit("ERROR_OCCURRED", { source: "warden", message: `policy load failed: ${String(e)}` }, {});
    }
  }

  // The durable long-term store (§6.1). The default adapter is filesystem-backed;
  // a consumer-supplied `opts.store` replaces it behind the same seam (§2.1, §6.8).
  const memoryStore: MemoryStore =
    opts.store ??
    new FilesystemMemoryStore(fileSystem, {
      workspace: ".voidrift/memory",
      global: path.join(voidriftConfigDir(), "memory"),
    });
  const suggestionsDir = new SuggestionsDirectory(fileSystem, ".voidrift/suggestions", (message) =>
    bus.emit("WARNING_EMITTED", { category: "suggestions", source: "list", pattern: message }, {}),
  );
  // Late-bound: the skills directory is constructed below; reflection dedup
  // reads existing SKILL.md bodies through this holder (§6.7).
  let skillsDirRef: SkillsDirectory | undefined;
  const memory = new Memory({
    store: memoryStore,
    bus,
    sessions,
    suggestions: suggestionsDir,
    limits,
    listSkillBodies: async () => {
      if (!skillsDirRef) return [];
      const project = await skillsDirRef.load("project").catch(() => ({ skills: [], skipped: [] }));
      const global = await skillsDirRef.load("global").catch(() => ({ skills: [], skipped: [] }));
      return [...project.skills, ...global.skills].map((s) => s.body);
    },
    getBounds: () => {
      // Read through the limits registry (alias-aware): `limits.memory.*` wins,
      // else the legacy top-level key, else the registry default (§13.11).
      return {
        entryChars: limits.get("memory.entryChars"),
        projectChars: limits.get("memory.projectChars"),
        reflectionBatchSize: limits.get("memory.reflectionBatchSize"),
      };
    },
    discoverProjectFiles: () =>
      discoverProjectFiles(fileSystem, {
        workspace: workspaceRoot,
        global: path.join(voidriftConfigDir(), "AGENTS.md"),
      }),
    // §4.8/§8.7 — the project-instructions head budget. When the user explicitly
    // set `limits.memory.projectChars` that char bound drives the head; otherwise
    // `ingest.fitFraction` × the endpoint window (tokens) does — the same fit test
    // as any content. The WHOLE merge is always kept; only the HEAD is reduced to
    // a digest on overflow.
    projectCharsConfigured: () => config.limitSource("memory.projectChars") !== "default",
    getContextWindow: () => model.resolve().contextLimit,
    // §8.7 — the non-blocking project-instructions digest. Returns the cached
    // digest on a hit; on a miss returns null and kicks the ingest in the
    // BACKGROUND so the next turn hits the cache. Never blocks the turn. Absent
    // until `ingestForEngine` is late-bound (the head carries the marked head).
    projectDigest: (merged: string) =>
      ingestForEngine ? ingestForEngine.projectDigest(merged, model.resolve().contextLimit) : null,
    // §6.7/§10.6 — the evidence packet is bounded to a fraction of the selected
    // endpoint's window.
    getContextLimit: () => model.resolve().contextLimit,
    // §6.7 — draft a skill candidate from a repeated-sequence evidence packet with
    // ONE transient model call (the same lightweight seam session-naming uses).
    // The evidence is DATA: the prompt wraps it fenced and instructs the model to
    // treat it as data, never instructions. A `failure` outcome is framed as a
    // guard/alternative; a `success` outcome as a script. Detection stays
    // model-free. Structured output (LangChain-first); a failure yields null and
    // writes nothing.
    draftSkillFromSequence: (evidence) =>
      draftSkillFromSequence(model.transientUtilityModel(), evidence, {
        evidencePacketMaxChars: limits.get("memory.evidencePacketMaxChars"),
        timeoutMs: limits.get("session.namingTimeoutMs"),
      }),
    // §6.7/§10.6 — draft a memory-NOTE candidate from a repeated FAILURE shape
    // with ONE transient utility-model call (same seam as the sequence draft).
    draftMemoryNoteFromFailure: (evidence) =>
      draftMemoryNoteFromFailure(model.transientUtilityModel(), evidence, {
        evidencePacketMaxChars: limits.get("memory.evidencePacketMaxChars"),
        timeoutMs: limits.get("session.namingTimeoutMs"),
      }),
  });
  // Index memory from disk at boot (§6.2); a failure never blocks boot.
  await memory.reindex().catch((e) => bus.emit("ERROR_OCCURRED", { source: "memory", message: String(e) }, {}));

  // ── Skills, Prompts, Plugins, Registry (§12) ──────────────────────────────
  // The registry is DURABLE (§12.5): one JSON file per (workspace, plugin) under
  // `<global config dir>/registry/<workspace key>/`, outside the workspace, so a
  // routine saved or a plan authored in one run is present in the next and a
  // cloned repo cannot ship either. Reserved core namespaces stay in memory.
  const registryPersistence = new NodeRegistryPersistence(voidriftConfigDir(), workspaceRoot, (message) =>
    bus.emit("ERROR_OCCURRED", { source: "registry", message }, {}),
  );
  const registryStore = new RegistryStore(registryPersistence);
  const commands = new Map<string, { pluginId: string; handler: PluginCommandHandler }>();

  // The global skills dir is outside the workspace, so — like the agents — it is
  // read/written through a dedicated global-rooted port. With an injected
  // `fileSystem` (tests), keep the single-port form so in-memory suites are
  // unaffected.
  const skillsGlobalFs = opts.fileSystem ? undefined : new FilesystemAdapter(voidriftConfigDir());
  const manualsGlobalFs = opts.fileSystem ? undefined : new FilesystemAdapter(voidriftConfigDir());
  const skillsDir = new SkillsDirectory(
    fileSystem,
    {
      workspace: ".voidrift/skills",
      global: skillsGlobalFs ? "skills" : path.join(voidriftConfigDir(), "skills"),
    },
    skillsGlobalFs,
  );
  const skills = new Skills({
    bus,
    directory: skillsDir,
    getAllowlist: () => config.get().skills,
    toolRegistry: registry,
  });
  await skills.reindex().catch((e) => bus.emit("ERROR_OCCURRED", { source: "skills", message: String(e) }, {}));

  // Manuals: the append-only registry for the manual (§12.8). Filesystem-sourced
  // docs are loaded from .voidrift/docs (project/) and ~/.config/voidrift/docs
  // (user/) through the same pattern as skills (§12.1, separate workspace/global
  // FileSystemPort). RESOURCE_CHANGED is emitted on reindex (§14.2, §14.6).
  const manualsDir = new ManualsDirectory(
    fileSystem,
    {
      workspace: ".voidrift/docs",
      global: manualsGlobalFs ? "docs" : path.join(voidriftConfigDir(), "docs"),
    },
    manualsGlobalFs,
  );
  const manuals = new Manuals({ bus, toolRegistry: registry, directory: manualsDir });

  // Load shipped core docs (§12.8). Register each *.md under docs/ with
  // manuals.registerBuiltin(raw, `core/<slug>`) where slug is the basename
  // without extension. This runs BEFORE manuals.reindex() so core/ ids exist
  // first. registerBuiltin is silent (no RESOURCE_CHANGED), matching builtin
  // skills. A malformed doc is an ERROR_OCCURRED, not a crash.
  let docsDir: string | null = null;
  try {
    docsDir = shippedDocsDir();
  } catch (e) {
    bus.emit(
      "ERROR_OCCURRED",
      {
        source: "manuals",
        message: `Failed to resolve shipped docs directory: ${String(e)}`,
      },
      {}
    );
  }
  const { readdirSync } = await import("node:fs");
  const { readFileSync } = await import("node:fs");
  const registerShippedDocs = (dirPath: string, prefix: string): void => {
    if (!readdirSync(dirPath, { withFileTypes: true })) return;
    try {
      const files = readdirSync(dirPath, { withFileTypes: true });
      for (const file of files) {
        if (file.isDirectory()) {
          // Recursively load from subdirectories like explanation/, guides/, reference/
          registerShippedDocs(path.join(dirPath, file.name), prefix);
        } else if (file.isFile() && file.name.endsWith(".md")) {
          const slug = file.name.replace(/\.md$/, "");
          const fullPath = path.join(dirPath, file.name);
          const raw = readFileSync(fullPath, "utf8");
          const id = `${prefix}/${slug}`;
          const result = manuals.registerBuiltin(raw, id);
          if (!result.ok) {
            bus.emit(
              "ERROR_OCCURRED",
              {
                source: "manuals",
                message: `Failed to register shipped doc ${id}: ${String(result.error)}`,
              },
              {}
            );
          }
        }
      }
    } catch (e) {
      bus.emit(
        "ERROR_OCCURRED",
        {
          source: "manuals",
          message: `Failed to load shipped docs from ${dirPath}: ${String(e)}`,
        },
        {}
      );
    }
  };
  if (docsDir) {
    registerShippedDocs(docsDir, "core");
  }

  await manuals.reindex().catch((e) => bus.emit("ERROR_OCCURRED", { source: "manuals", message: String(e) }, {}));

  // Start the filesystem watcher for manual hot-reload (§14.2, §14.6). The watcher
  // monitors both the project .voidrift/docs and global ~/.config/voidrift/docs
  // directories and triggers reindex on add/change/unlink, emitting RESOURCE_CHANGED.
  const projectDocsPath = path.resolve(workspaceRoot, ".voidrift/docs");
  const globalDocsPath = path.resolve(voidriftConfigDir(), "docs");
  await manuals.startWatch(projectDocsPath, globalDocsPath).catch((e) => bus.emit("ERROR_OCCURRED", { source: "manuals", message: String(e) }, {}));

  // An approved skill candidate becomes a workspace skill (§6.7, §12.1): the core
  // never writes a skill on its own — only approval (the human decision) does.
  // The WHOLE directory — SKILL.md plus every validated asset — is written under
  // the chosen scope; a skill definition is a protected control path (§9), so the
  // approval IS the protected-path human ask. Assets are written verbatim; this
  // code never executes them.
  skillsDirRef = skillsDir;
  memory.setApproveSkill(async (candidate) => {
    const name = slugify(candidate.title);
    const content = `---\nname: ${name}\ndescription: ${candidate.title}\n---\n\n${candidate.body}\n`;
    // §12.1/§6.7 — the WHOLE skill directory (SKILL.md + every validated asset)
    // is written atomically: a staging dir then a single rename, so a mid-write
    // failure leaves no partial skill directory.
    await skillsDir.writeSkill(
      name,
      "project",
      content,
      (candidate.assets ?? []).map((a) => ({ path: a.path, content: a.content })),
    );
    await skills.reindex();
    bus.emit("RESOURCE_CHANGED", { type: "skill" }, {});
    return { ok: true as const, value: { name } };
  });

  const promptsDir = new PromptsDirectory(fileSystem, {
    workspace: ".voidrift/prompts",
    global: path.join(voidriftConfigDir(), "prompts"),
  });  const prompts = new Prompts({ bus, directory: promptsDir });
  await prompts.init().catch((e) => bus.emit("ERROR_OCCURRED", { source: "prompts", message: String(e) }, {}));

  // The scoped-CoreAPI service surface (§12.4): every registration tagged with
  // the plugin id and torn down wholesale on disable.
  let apiRef: CoreAPI | undefined;
  type CtxEntry = { layer: "agent" | "void" | "rift"; provider: () => string | string[] };
  const contextProviderStore = new Map<string, CtxEntry>();
  const exporterStore = new Map<string, unknown>();
  // §8.7 — plugin-contributed INGEST chunkers, keyed by a plugin-qualified id for
  // wholesale teardown. The Ingest use-case reads the live set via the facade's
  // internal `chunkers()` accessor; a registered chunker that `matches` wins over
  // the builtins (core stays parser-free). Order is insertion order.
  const chunkerStore = new Map<string, import("./entities/chunker.js").Chunker>();
  let chunkerSeq = 0;
  let ctxSeq = 0;
  let expSeq = 0;
  const registerContextProvider = (layer: "agent" | "void" | "rift", provider: () => string | string[]): string => {
    const id = `ctx:${ctxSeq++}`;
    contextProviderStore.set(id, { layer, provider });
    return id;
  };
  const contextBlocks = (layer: "agent" | "void" | "rift"): string[] => {
    const out: string[] = [];
    for (const e of contextProviderStore.values()) {
      if (e.layer !== layer) continue;
      try {
        const v = e.provider();
        if (Array.isArray(v)) out.push(...v);
        else if (v) out.push(v);
      } catch {
        // A throwing provider is isolated (§12.4).
      }
    }
    return out;
  };
  const services: CoreServices = {
    registerCommand: (pluginId, name, handler) => commands.set(name, { pluginId, handler }),
    unregisterCommand: (name) => void commands.delete(name),
    registerTool: (_pluginId, def, exec) => {
      // Tag a plugin tool with origin "plugin" (§8.1, §12.4): it binds via
      // `pluginModelEntries` and ASKS until allow-listed (§9). A def that already
      // declares an origin is respected.
      const d = def as { origin?: string };
      const tagged = d.origin ? d : { ...(def as object), origin: "plugin" };
      registry.register(tagged as never, exec as never);
    },
    unregisterTool: (name) => registry.unregister(name),
    registerPrompt: (_pluginId, key, content) => prompts.register(key, content),
    overridePrompt: (_pluginId, key, content) => prompts.overridePrompt(key, content),
    extendPrompt: (_pluginId, key, content) => prompts.extendPrompt(key, content),
    removePrompt: (key) => prompts.removePlugin(key),
    registerContextProvider: (_pluginId, layer, provider) => registerContextProvider(layer, provider),
    unregisterContextProvider: (id) => void contextProviderStore.delete(id),
    registerModelProvider: (_pluginId, protocol, factory) =>
      model.registerProvider(protocol, factory as import("./adapters/model-provider.js").ProviderFactory),
    unregisterModelProvider: (protocol) => model.unregisterProvider(protocol),
    registerExporter: (_pluginId, exporter) => {
      const id = `exp:${expSeq++}`;
      exporterStore.set(id, exporter);
      return id;
    },
    unregisterExporter: (id) => void exporterStore.delete(id),
    registerPanel: (_pluginId, name, definition) => {
      // The core validates a panel declaration against the ONE Zod schema (§12.6)
      // before storing it under the reserved core `panels.{name}` key (§12.5,
      // panels §3), readable by a client at registry.get("panels.{name}"). A
      // validation failure throws a typed CoreError the plugin loader contains
      // and logs like any plugin failure (§12.4); the panel is simply absent.
      const result = validatePanelDeclaration(definition);
      if (!result.ok) {
        throw new CoreErrorException(
          coreError(ErrorCode.INVALID_INPUT, `panel "${name}": ${result.error.message}`, { field: result.error.field }),
        );
      }
      const key = `${PANELS_KEY_PREFIX}${name}`;
      registryStore.set(CORE_NAMESPACE, key, result.value);
      return key;
    },
    unregisterPanel: (key) => registryStore.remove(CORE_NAMESPACE, key),
    registerDataset: (_pluginId, name, declaration) => {
      // The core validates a dataset declaration against the ONE Zod schema plus
      // the zero-argument `rows` rule (§12.7) before storing it under the
      // reserved core `datasets.{name}` key (§12.5). The name is a lowercase slug
      // (no dots). A validation failure throws a typed CoreError the plugin
      // loader contains and logs like any plugin failure (§12.4); the dataset is
      // simply absent. The reserved core namespace is never persisted, so the
      // `rows` reader function stays in memory.
      if (typeof name !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
        throw new CoreErrorException(
          coreError(ErrorCode.INVALID_INPUT, `dataset name "${String(name)}" must be a lowercase slug ([a-z0-9-]+, no dots)`, { field: "name" }),
        );
      }
      const result = validateDatasetDeclaration(declaration);
      if (!result.ok) {
        throw new CoreErrorException(
          coreError(ErrorCode.INVALID_INPUT, `dataset "${name}": ${result.error.message}`, { field: result.error.field }),
        );
      }
      const key = `${DATASETS_KEY_PREFIX}${name}`;
      registryStore.set(CORE_NAMESPACE, key, result.value);
      return key;
    },
    unregisterDataset: (key) => registryStore.remove(CORE_NAMESPACE, key),
    registerAgent: () => {
      /* agent manifests register through the subagents instance; seam present */
    },
    registerGuardrail: () => {
      /* guardrails refine allowed actions (§9.4); seam present */
    },
    // §9.5 plan-scope seam: qualify the identifier by plugin id so one plugin
    // cannot touch another's scope, then map onto the Guardian entity. The scope
    // lives only in-process (never persisted, §9.5); force-ask/hard-deny immunity
    // is Guardian's by construction (§9.3) and is unaffected here.
    registerScope: (pluginId, id, scope) => {
      const key = `${pluginId}:${id}`;
      guardian.registerScope(key, scope);
      // §10.11 — note the UNQUALIFIED id as live so a journaled write stamps it
      // as `planStep` (recorded metadata only, invariant 27). The expectation
      // and the journal both speak the unqualified id (§9.5.1).
      apiRef?.noteActiveScope(id);
      return key;
    },
    unregisterScope: (pluginId, id) => {
      guardian.clearScope(`${pluginId}:${id}`);
      apiRef?.clearActiveScope(id);
    },
    unregisterScopeKey: (key) => guardian.clearScope(key),
    // §9.5.1 expectation seam — plugin-callable register/clear; the core drives
    // the comparison at scope close. The journal read is CORE-INTERNAL (never
    // reachable by the plugin, invariant 27) and lives on the facade.
    registerExpectation: (scope, predicted) => apiRef!.expectations.register({ scope, predicted }),
    clearExpectation: (scope) => apiRef!.expectations.clear(scope),
    closeExpectation: (scope) => apiRef!.closeExpectationScope(scope),
    // §8.7 — store a plugin chunker under a qualified key; the Ingest use-case
    // reads the live set via the facade's internal `chunkers()` accessor. The
    // chunker's output is validated and its failures contained AT USE (ingest),
    // never here — storing is a pure, side-effect-free registration.
    registerChunker: (pluginId, def) => {
      const key = `${pluginId}:chunker:${chunkerSeq++}`;
      chunkerStore.set(key, def as import("./entities/chunker.js").Chunker);
      return key;
    },
    unregisterChunker: (key) => void chunkerStore.delete(key),
    runInNewSession: async (firstPrompt, sopts) => {
      // The ONE implementation lives on the facade (§12.3, §5.7). It starts a
      // NEW session (never inheriting a prior conversation) that DOES inherit the
      // process launch posture (§2.5, §8): the effective start agent and the
      // effective start approval mode. So a headless `--routine` NEVER asks and
      // can never reach `waiting_for_approval`/exit 5, exactly like `--prompt`;
      // the TUI leaves it `interactive`, so interactive `/routine run` still asks.
      return apiRef!.session.runInNewSession(firstPrompt, sopts);
    },
    // The read-only workspace surface (retrieval-blueprint §3, §5). Containment
    // and the ignore mechanism are the FileSystemPort's; the exclusion rules
    // (`.voidrift`, secret names, binary, >1 MiB, 20k cap) and the turn-input /
    // focus accessors live in the surface. Not a model tool; plugin-only.
    workspace: new WorkspaceSurfaceImpl({
      fileSystem,
      workspaceRoot,
      // FX-B — the hardened `git ls-files` set inside a repo (gitignore applied
      // the way git does); null outside a repo so the surface parses .gitignore.
      gitListFiles: () => vcs.listFiles(),
      getTurnInput: () => apiRef?.activeTurnInput() ?? "",
      getFocusPaths: () => apiRef?.activeFocusPaths() ?? [],
      limits,
    }),
  };

  const pluginLoader = new PluginLoader(workspaceRoot, voidriftConfigDir());
  // The workspace file-change seam (retrieval-blueprint §3): a coarse, batched,
  // content-free `{ paths }` signal a host watcher emits so the retrieval plugin
  // can refresh its index without owning a watcher. Registered here as a known
  // core event; the retrieval plugin subscribes to it (and to RESOURCE_CHANGED)
  // and reconciles incrementally on the next query. No watcher is started here.
  bus.register("WORKSPACE_FILES_CHANGED");
  const plugins = new Plugins({
    bus,
    loader: pluginLoader,
    services,
    registryStore,
    getPlugins: () => config.get().plugins,
    setPlugins: (entries, layer) => config.set("plugins", entries, layer),
    // §13.11 — read-only effective-limits accessor for the plugin
    // `core.limits.get(key)` surface (a plugin reads, never sets).
    getLimit: (key: string) => limits.get(key),
    // §12.4.1 — per-layer provenance so `plugins.list` can report which layer
    // each plugin came from and a project-layer load is logged at info level.
    // Records merge by id (narrower layer replaces the same id); a project entry
    // loads exactly like a global one — there is no workspace-trust gate.
    getPluginLayers: () => config.pluginLayers(),
    // §12.4.1 — user-initiated discovery/install. The registry read and the npm
    // install pass the ONE decision point exactly as `mcp.approve` does: managed
    // gate → Warden → Guardian. `search`/`inspect` gate as a network read
    // (default allow for an ordinary read, still subject to managed/Warden);
    // `install` gates as a HIGH-RISK write+exec+network action carrying the
    // review. With no interactive resolver at this seam a non-allow decision
    // fails fast (policy_only semantics); a client answers the out-of-band
    // approval the same way it does for MCP.
    discovery: {
      registryClient: opts.pluginRegistry ?? new PluginRegistryClient(),
      installer: opts.pluginInstaller ?? new NpmInstallerAdapter(),
      getRegistryUrl: () => config.get().pluginsRegistry,
      hostCoreVersion: coreVersion(),
      installDirFor: (scope) =>
        scope === "global"
          ? path.join(voidriftConfigDir(), "plugins")
          : path.join(workspaceRoot, ".voidrift", "plugins"),
      networkTimeoutMs: config.get().webFetchTimeoutMs,
      searchMaxBytes: limits.get("plugins.searchMaxBytes"),
      installTimeoutMs: 120_000,
      installMaxBytes: limits.get("plugins.installMaxBytes"),
      gate: async (op, detail) => {
        const tool = op; // plugins_search | plugins_inspect | plugins_install
        const g = managedGate();
        if (g) return { decision: "deny", reason: `managed_layer_unavailable: ${g.reason}` };
        const w = await warden.evaluate({ tool, args: { name: detail.name } });
        if (w.effect === "block") return { decision: "deny", reason: `blocked by compliance: ${w.reason ?? "policy"}` };
        // `plugins_search`/`plugins_inspect` are reads of the plugin registry
        // (plugin-trust seam, not a model-facing tool); only `plugins_install`
        // is a force-asked, trust-expanding write (§12.4.1). The read ops are
        // free here; the write passes Guardian (readOnly is never a Guardian
        // permission input, §9).
        if (op !== "plugins_install") return { decision: "allow" };
        // owner D2a — the exact match value for a `plugins_install` force-ask is
        // `<package>@<version>`, so an exact allow rule can lift it. Build it
        // from the review (which carries the resolved version); fall back to the
        // bare name when no review is present.
        const installName =
          detail.review ? `${detail.review.name}@${detail.review.version}` : (detail.name ?? "");
        const outcome = guardian.evaluate(
          { tool, args: { name: installName } },
          Object.values(config.get().permissions),
          {
            safe: config.get().shellSafeCommands,
            forceAsk: config.get().shellForceAskPatterns,
            equivalents: config.get().shellEquivalents,
            deny: config.get().shellDenyPatterns,
          },
        );
        if (outcome.decision === "allow") return { decision: "allow" };
        if (outcome.decision === "deny") return { decision: "deny", reason: outcome.reason ?? "denied" };
        // An ask: install is a HIGH-RISK out-of-band approval that MUST show the
        // review (§12.4.1). Surface it through the host approval handler, with
        // the review masked (§10.10). With no handler the op fails fast
        // (policy_only), exactly as the MCP approve seam does.
        if (!opts.onApproval) return { decision: "ask", reason: "waiting_for_approval" };
        const review = detail.review ? (maskValue(detail.review) as typeof detail.review) : undefined;
        const response = await opts.onApproval({
          id: newApprovalId(),
          tool,
          args: {
            name: detail.name,
            ...(review ? { review } : {}),
            // The §12.4.1 note the approver must see.
            note: "--ignore-scripts stops install-time execution, but a loaded plugin is trusted in-process code on the next boot.",
          },
          choices: ["approve", "reject"],
          mode: "out_of_band",
        });
        return response.decision === "approve" ? { decision: "allow" } : { decision: "deny", reason: "rejected" };
      },
    },
  });

  // The Subagents use-case (§7). Shared across the facade's subagents namespace;
  // registered agents and live workers persist on the one instance.
  const makeSubagents = (
    getSessionRules: () => PermissionRule[],
    getOwnerSessionId?: () => string,
    getApprovalMode?: () => import("./entities/session.js").ApprovalMode,
    getActiveAgent?: () => AgentDefinition | undefined,
  ): Subagents => {
    const chatModel: BaseChatModel = model.chatModel();
    return new Subagents({
      chatModel,
      guardian,
      warden,
      bus,
      vcs,
      limits,
      // §7.2 — the run cache for pass-by-reference of oversized dependency
      // summaries and dependent briefs. Scoped to the OWNING session per store
      // (the shared Subagents serves whichever session dispatched), so a handle
      // lands under `.voidrift/cache/run/<owner session>/`.
      runCache: new FilesystemRunCache({
        workspaceRoot,
        sessionId: () => (getOwnerSessionId ? getOwnerSessionId() : "orchestrator"),
        maxBytes: limits.get("run.cacheMaxBytes"),
        entryMaxBytes: limits.get("run.entryMaxBytes"),
        onLimitHit: (info) => bus.emit("LIMIT_HIT", info, { session: getOwnerSessionId ? getOwnerSessionId() : "orchestrator" }),
      }),
      staging,
      // §15.1#4 — a worker's tool calls pass the SAME decision point as the
      // orchestrator's, built from these shared deps (registry/tempDir/window/
      // managedGate) plus a §9.5 ask resolver.
      registry,
      tempDir: systemTempDir(),
      window: model.resolve().contextLimit,
      maxOutputTokens: model.resolve().maxOutputTokens ?? null,
      // §11 / invariant 14 — resolve a worker's `AgentDefinition.model` STRING
      // endpoint key to a bound model internally; an unknown key is rejected at
      // registration with MODEL_NOT_CONFIGURED.
      resolveModel: (key: string) => model.chatModelFor(key),
      managedGate,
      getConfig: () => config.get(),
      workspaceRoot,
      globalConfigDir: voidriftConfigDir(),
      home: os.homedir(),
      sessionId: "orchestrator",
      resolveWebSearch: () => resolveWebSearch(),
      // §8.2 — a worker that lists `web_fetch`/`web_search` (the researcher)
      // reaches the network through the SAME HttpPort seam the engine uses, so a
      // worker's web calls run over the SAME SSRF controls, DNS/redirect
      // re-checks, timeout, and masking, gated at the SAME single decision point.
      http: new FetchHttpAdapter(),
      // §8.6 — a worker's `researcher_save_notes` writes under the REAL session
      // workspace root (this `fileSystem`, NOT the worker's worktree), so notes
      // land in the user's tree confined to `findingsDirectories`.
      notesFileSystem: fileSystem,
      interactive: Boolean(opts.onApproval),
      getSessionRules,
      ...(getApprovalMode ? { getApprovalMode } : {}),
      ...(getActiveAgent ? { getActiveAgent } : {}),
      // §7/§8.3 — a worker's large result evicts into the PARENT session cache.
      writeEvictedResult: async (sessionId, name, content) => {
        await fileSystem.writeFileAtomic(
          path.join(".voidrift", "cache", "session", sessionId, name),
          content,
          { mode: 0o600 },
        );
      },
      // §9.5 — a worker's interactive/out-of-band ask surfaces through the host
      // approval callback (the durable `out_of_band` resume rides `session.confirm`).
      ...(opts.onApproval ? { requestWorkerApproval: (pending) => opts.onApproval!(pending) } : {}),
      ...(getOwnerSessionId ? { getOwnerSessionId } : {}),
      // §10.11 — a worker's writes journal into the SESSION's journal with its
      // workerId. The before-state reader reads a file target within the
      // worker's OWN tree (`rootDir`) via node fs (a worktree is an absolute
      // path outside the workspace FileSystemPort's root).
      journal: journalRecorder,
      // §10.11/§9.5.1 — a worker's journaled write stamps the active plan-scope
      // id as its `planStep` (metadata only, invariant 27), the SAME seam the
      // orchestrator's decision point uses, so a surprise caused by a dispatched
      // worker is visible to the scope-targets reader. Undefined when no grant.
      getActiveScopeId: () => apiRef?.getActiveJournalScopeId(),
      readWorkerTargetBytes: async (rootDir: string, relPath: string): Promise<Buffer | null> => {
        try {
          const abs = path.isAbsolute(relPath) ? relPath : path.join(rootDir, relPath);
          // §10.11 / LOW-3 — DoS-safe bounded before-capture (stat first, read at
          // most cap+1 bytes for an over-cap target), the same seam as the
          // orchestrator's reader.
          const res = readTargetBytesBounded(abs);
          return res ? res.bytes : null;
        } catch {
          return null;
        }
      },
    });
  };

  // ── Observability (§10) ────────────────────────────────────────────────────
  // The NDJSON dual-layer store (§10.3) over the host FileSystemPort; the writer
  // subscribes to the significant events at boot (§10.4), masks every record
  // (§10.10), feeds registered exporters (§10.8), and backs query/tail (§10.5).
  // An exporter/write failure is reported OUT OF BAND through `onError` — never
  // re-emitted on the bus the writer subscribes to, which would recurse (§10.8).
  const obsStore = new NdjsonLogStore({
    fs: fileSystem,
    workspaceLogDir: ".voidrift/logs",
    // The global error log lives under `~/.config/voidrift/logs`, outside the
    // workspace, so it is written through a dedicated global-rooted FS port and
    // addressed relative to it — the workspace-confined adapter would reject the
    // absolute path (§10.3).
    globalFs: new FilesystemAdapter(voidriftConfigDir()),
    globalLogDir: "logs",
    getMaxSizeMB: () => limits.get("logs.maxSizeMB"),
    getMaxAgeDays: () => config.get().logMaxAgeDays,
    onError: (message) => opts.output?.(message),
  });
  const obsWriter = new ObsWriter({
    bus,
    store: obsStore,
    sessions,
    getLevel: () => config.get().logLevel,
    getSuggestionThreshold: () => config.get().turnSuggestionThreshold,
    getSequenceMaxLen: () => limits.get("memory.sequenceMaxLen"),
    getStatsRecordCap: () => limits.get("stats.recordCap"),
    getSequenceCaps: () => ({
      maxSignalsPerSession: limits.get("sequence.maxSignalsPerSession"),
      maxSignalsPerTurn: limits.get("sequence.maxSignalsPerTurn"),
      minDistinctSessions: limits.get("sequence.minDistinctSessions"),
    }),
    getSequencePriorSessions: () => limits.get("sequence.priorSessions"),
    getSequenceQueueCap: () => limits.get("sequence.queueCap"),
    // §10.6 Lifecycle — the signatures the detector must not signal again: every
    // pending/approved suggestion's signature plus the remembered rejected list.
    getSuppressedSignatures: () => suggestionsDir.suppressedSignatures(),
    // §10.6 → §6.7 — a raised repeated sequence is consumed by reflection, which
    // drafts ONE pending skill candidate per signal. Detection stays model-free;
    // only this consumer calls a model. Best-effort (fire-and-forget): a
    // reflection miss never disturbs the write path.
    onSequenceSignal: (signal, examples) =>
      memory
        .reflectSequence(
          signal,
          // §10.6 — each example span carries its tool name, status, and a masked,
          // bounded argument summary (from the TOOL_STARTED span's `args`) so the
          // evidence can show up to three redacted arg summaries per step. The
          // record is already masked; stringify its args for the summary.
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
    // §10.6 → §6.7 — a raised repeated FAILURE is consumed by reflection, which
    // drafts ONE pending memory-note candidate ('what failed and what to do
    // instead') per signature. Best-effort; a miss never disturbs the write path.
    onFailureSignal: (signal, examples) => {
      const colon = signal.pattern.indexOf(":");
      const kind = signal.pattern.slice(0, colon) === "guardian_block" ? "guardian_block" : "tool_error";
      const rawTool = colon >= 0 ? signal.pattern.slice(colon + 1) : signal.pattern;
      return memory
        .reflectFailure({
          signature: signal.pattern,
          kind,
          tool: toolDisplayName(rawTool),
          errorClass: signal.errorClass,
          count: signal.count,
          // The producing session ids from the example spans (deduped), bounded.
          sessionIds: [...new Set(examples.map((s) => s.traceId))].slice(0, 8),
          // Up to three already-masked, bounded argument summaries (§10.6).
          argExamples: examples
            .map((s) => {
              const args = (s.attributes as Record<string, unknown> | undefined)?.["args"];
              return args !== undefined ? JSON.stringify(args).slice(0, 200) : "";
            })
            .filter((x) => x !== "")
            .slice(0, 3),
        })
        .catch(() => undefined);
    },
    getPrice: (modelName) => {
      const entry = config.get().models[modelName];
      if (!entry) return undefined;
      const price = {
        ...(entry.costPer1kInput !== undefined ? { costPer1kInput: entry.costPer1kInput } : {}),
        ...(entry.costPer1kOutput !== undefined ? { costPer1kOutput: entry.costPer1kOutput } : {}),
      };
      return price.costPer1kInput === undefined && price.costPer1kOutput === undefined ? undefined : price;
    },
    exporters: () => [...exporterStore.values()] as import("./entities/observability/obs-record.js").ObsExporter[],
    onError: (message) => opts.output?.(message),
  });
  obsWriter.start();

  // ── MCP client (§8.4) ───────────────────────────────────────────────────────
  // The single decision point over every MCP tool call is the registry/Guardian
  // path the exposed `mcp_<server>_<tool>` tools route through (§8.4, §9). A
  // connect failure is non-fatal (§8.4). Config save/remove go through the config
  // capability so they are validated and recoverable (§13).
  const mcpClient = new McpClient({
    bus,
    registry,
    limits,
    connect: connectMcpServer,
    // The credential store holds HTTP Authorization headers and OAuth tokens off
    // disk (§8.4): a consumer-supplied store replaces the internal keychain /
    // AES-256-GCM encrypted-file selection (§2.1). Resolved lazily so boot stays
    // synchronous.
    credentials:
      opts.credentialStore ??
      new LazyCredentialStore({
        filePath: path.join(voidriftConfigDir(), "credentials.enc"),
        ...(process.env["VOIDRIFT_CREDENTIAL_KEY"] ? { secret: process.env["VOIDRIFT_CREDENTIAL_KEY"] } : {}),
      }),
    getConfigs: () => (config.get().mcp ?? {}) as Record<string, McpServerConfig>,
    saveConfig: async (name, cfg, layer) => {
      const next = { ...(config.get().mcp ?? {}), [name]: cfg };
      return config.set("mcp", next, layer);
    },
    removeConfig: async (name, layer) => {
      const next = { ...(config.get().mcp ?? {}) };
      delete next[name];
      return config.set("mcp", next, layer);
    },
    // §8.4 — the durable pin store (`.voidrift/mcp-pins.json`) through the one
    // filesystem containment chokepoint. Trust-on-first-use: only approved
    // tools are bound/callable.
    pinStore: new FilesystemMcpPinStore(fileSystem),
    // §8.4 — `mcp.approve` passes the ONE gate as a config-like write
    // (`mcp_approve`): managed gate → Warden → Guardian (default ask). With no
    // interactive resolver at this seam a non-allow decision fails fast
    // (policy_only semantics); the full diff is already masked by the client.
    approveGate: async (server) => {
      const gate = managedGate();
      if (gate) return { decision: "reject", reason: `managed_layer_unavailable: ${gate.reason}` };
      const w = await warden.evaluate({ tool: "mcp_approve", args: { server } });
      if (w.effect === "block") return { decision: "reject", reason: `blocked by compliance: ${w.reason ?? "policy"}` };
      const outcome = guardian.evaluate(
        { tool: "mcp_approve", args: { server } },
        Object.values(config.get().permissions),
        {
          safe: config.get().shellSafeCommands,
          forceAsk: config.get().shellForceAskPatterns,
          equivalents: config.get().shellEquivalents,
          deny: config.get().shellDenyPatterns,
        },
      );
      if (outcome.decision === "allow") return { decision: "allow" };
      return { decision: "reject", reason: outcome.decision === "deny" ? (outcome.reason ?? "denied") : "waiting_for_approval" };
    },
  });
  // Auto-connect configured servers, non-blocking and non-fatal (§8.4). Boot
  // never blocks on a server, but the FIRST turn awaits `mcpReady()` (bounded)
  // so an approved MCP tool is bound before the agent is built — otherwise a
  // fast headless `--prompt` would race the stdio handshake and bind no MCP
  // tool at all (a handshake-race defect the real-stdio E2E caught).
  if (config.get().mcpAutoConnect !== false) {
    mcpAutoConnect = mcpClient
      .autoConnect()
      .catch((e) => bus.emit("ERROR_OCCURRED", { source: "mcp", message: String(e) }, {}));
    void mcpAutoConnect;
  }
  const api = new CoreAPI({
    bus,
    config,
    model,
    warden,
    guardian,
    registry,
    sessions,
    workspaceRoot,
    vcs,
    staging,
    fileSystem,
    makeEngine,
    getLimit: (key) => limits.get(key),
    makeSubagents,
    ...(opts.startAgent ? { startAgent: opts.startAgent } : {}),
    ...(opts.startSessionApprovalMode ? { startSessionApprovalMode: opts.startSessionApprovalMode } : {}),
    autoApproveAllowed: () => managedLayer.autoApproveAllowed(),
    memory,
    skills,
    manuals,
    prompts,
    plugins,
    registryStore,
    workspaceMap: new WorkspaceMap({ fileSystem, getDepth: () => config.get().workspaceMapDepth }),
    agentDiscovery: new AgentsDirectory(
      fileSystem,
      {
        project: ".voidrift/agents",
        // Relative to the dedicated global-rooted FS below (`~/.config/voidrift`).
        global: "agents",
      },
      // The global agents dir sits outside the workspace, so it is read through
      // a dedicated global-rooted FileSystemPort — exactly like the obs log
      // store's `globalFs` (§10.3) — since the workspace-confined adapter would
      // reject the absolute path (§3.1, §12.1 workspace > global > builtin).
      new FilesystemAdapter(voidriftConfigDir()),
    ),
    configInit,
    configDoctor: (opts) => doctorConfigHome({ ...(opts ?? {}), workspaceRoot }),
    configAccess: (opts) => accessReportConfigHome({ ...(opts ?? {}), workspaceRoot }),
    journalStore,
    rollback: rollbackService,
    namingPort,
    registerExporter: (exporter) => void exporterStore.set(`exp:${expSeq++}`, exporter),
    chunkers: () => [...chunkerStore.values()],
    commands,
    contextProviders: {
      register: (layer, provider) => void registerContextProvider(layer, provider),
      blocks: (layer) => contextBlocks(layer),
    },
    obsWriter,
    mcpClient,
    ...(opts.onApproval ? { onApproval: opts.onApproval } : {}),
    ...(opts.output ? { output: opts.output } : {}),
  });
  apiRef = api;

  // Load listed, enabled plugins at boot (§12.4, §14.1). A failure is isolated.
  await plugins.loadAll().catch((e) => bus.emit("ERROR_OCCURRED", { source: "plugins", message: String(e) }, {}));

  // §3.1/§12.1 — register the cascade of agent definitions at boot: the four
  // builtin defaults shipped in the core package's `agents/` folder, then any
  // global and workspace overrides (a same-named override replaces the builtin).
  // A failure never blocks boot; a malformed manifest is skipped by discovery.
  await api.agents.reindex().catch((e) => bus.emit("ERROR_OCCURRED", { source: "engine", message: `agent reindex failed: ${String(e)}` }, {}));

  // §2.7 — bind the shared active-agent resolver to the facade's Subagents
  // registry now that it is populated by the reindex above. The engine and
  // every worker read it live, so a `session.setMode`, reindex, or override is
  // reflected everywhere through this ONE resolver (§15.1#4).
  resolveActiveAgent = (mode) => api.resolveActiveAgent(mode);
  // §7 — bind the shared dispatch + dispatchable-workers resolvers to the same
  // facade Subagents instance, so the engine's `task` tool fans out through the
  // ONE registry (shared live workers, fan-out grant, and gates) (§15.1#4).
  dispatchForEngine = (reqs, signal, max) => api.dispatchForEngine(reqs, signal, max);
  resolveDispatchableWorkers = (agent) => api.dispatchableWorkers(agent);

  // §12.7 — register the 16 built-in datasets at startup, from the core's OWN
  // services, through the SAME `register.dataset` seam a plugin uses (so each is
  // validated and stored under `datasets.{name}`). Done AFTER the CoreAPI is
  // built and the agents are reindexed, so the `tools` dataset reads the active
  // agent's effective set. A product registers panels, never these datasets; a
  // dataset whose capability is a disabled plugin (the Plan plugin's `plan`) is
  // absent because the plugin — not the core — registers it.
  registerBuiltinDatasets(api, (name, declaration) => services.registerDataset(CORE_NAMESPACE, name, declaration));

  // §8.7 — the Ingest use-case backing the model-callable `ingest` tool. It is
  // wired over the REAL seams:
  //   - `cache`: the fs digest cache under `.voidrift/cache/ingest/` (owner-only,
  //     atomic, integrity-checked, bounded by `limits.ingest.cacheMaxBytes` with
  //     oldest-first eviction + a LIMIT_HIT event). The cache dir is a PROTECTED
  //     control path for file-WRITE tools (§9.4), so only the core writes it.
  //   - `chunkers`: the live set of plugin-contributed chunkers (`api.chunkers()`);
  //     the use-case merges them with the builtins via `pickChunker`.
  //   - `readSource`: the EXISTING workspace read path — `fileSystem.readFile`
  //     is the one workspace-root containment/symlink chokepoint (§8.2); a url is
  //     read ONLY from the `web_fetch` cache it already populated (never a fresh
  //     network fetch), so an un-fetched url is a typed miss, never an SSRF.
  //   - `dispatchSummarize`: the INTERNAL summarizer fan-out through the SAME
  //     shared Subagents (`internal: true` lifts the active agent's `workers`
  //     allowance for the literal `summarizer` worker only; every other gate,
  //     isolation, concurrency, cancel and the fan-out grant are unchanged).
  const ingestCache = new FilesystemIngestCache({
    workspaceRoot,
    maxBytes: limits.get("ingest.cacheMaxBytes"),
    onLimitHit: (info) => bus.emit("LIMIT_HIT", { key: info.key, value: info.value }, { workspace: workspaceRoot }),
    // §10.12 (HIGH): authenticate every cached digest with the per-install HMAC
    // that rollback already uses (the SAME `rollback.key` loader — never a second
    // key file). A planted/foreign/unsigned/old-format file is a miss + deleted,
    // so a cloned repo cannot poison the head via a forged AGENTS.md digest.
    signer: new RollbackIntegrity(voidriftConfigDir()),
  });
  ingestForEngine = new Ingest({
    workspaceRoot,
    limits,
    cache: ingestCache,
    chunkers: () => api.chunkers(),
    readSource: async (src) => {
      if (src.path !== undefined) {
        const text = await fileSystem.readFile(src.path);
        return { text, source: src.path };
      }
      const url = src.url as string;
      const rel = webCachePath(url);
      if (!(await fileSystem.exists(rel))) {
        throw new Error(`url not in the web_fetch cache — fetch it with web_fetch first: ${url}`);
      }
      const text = await fileSystem.readFile(rel);
      return { text, source: url };
    },
    dispatchSummarize: (reqs, signal, max) => api.dispatchForEngine(reqs, signal, max),
    // §3.3/§8.7 — a HEADLESS run (the host fixed `approvalMode: "headless"`) must
    // not start a background project-instructions fan-out; the process may exit
    // before it finishes and write nothing. The marked head is used instead. An
    // interactive session proceeds with the background kick. The posture is read
    // LIVE (not the boot-time `startSessionApprovalMode`, which the headless CLI
    // sets only AFTER boot via `setLaunchDefaults`) so every embedding is right.
    interactive: () => api.liveApprovalMode() !== "headless",
    // §6.6/§8.7 — a FAILED background ingest is logged to the trail as a warning
    // (never swallowed) so a project-instructions digest that silently produced
    // nothing is visible.
    onBackgroundError: (info) =>
      bus.emit(
        "WARNING_EMITTED",
        { category: "ingest", source: info.source, pattern: info.message },
        { workspace: workspaceRoot },
      ),
    // §8.7 — the EXPLICIT ingest fan-out cap: effectiveIngestParallel over the
    // live resolved limits + live turnMaxConcurrency (so a config edit applies).
    ingestParallel: () => limits.effectiveIngestParallel(config.get().turnMaxConcurrency),
    onIngest: (info) =>
      bus.emit(
        "INGEST",
        { source: info.source, kind: info.kind, inputTokens: info.inputTokens, available: info.available, chunks: info.chunks, cacheHit: info.cacheHit, key: info.key },
        { workspace: workspaceRoot },
      ),
  });

  // §2.1/§13.5 — the managed `autoApproveAllowed: false` refusal applies to a
  // `startAgent` that resolves to an `unlisted: allow` agent too (not only the
  // `autoApprove` alias, refused at construction above). Checked after reindex,
  // when the registry can resolve the named agent's posture.
  if (opts.startAgent && !managedLayer.autoApproveAllowed()) {
    const startDef = api.resolveActiveAgent(opts.startAgent);
    if (startDef && startDef.unlisted === "allow") {
      throw new CoreErrorException(
        coreError(
          ErrorCode.AUTO_APPROVE_FORBIDDEN,
          `starting agent "${opts.startAgent}" (unlisted: allow) is forbidden by the managed layer (autoApproveAllowed: false)`,
        ),
      );
    }
  }

  // Housekeeping notice at boot (§5.8).
  const housekeeping = await api.session.housekeeping();
  bus.emit("HOUSEKEEPING_NOTICE", housekeeping, {});

  // VCS worktree boot cleanup (§7.3 step 5) and the branch watch (§7.3, §14.6).
  // Both are no-ops outside a git repo. A failed cleanup never blocks boot.
  try {
    const pruned = await vcs.bootCleanup(limits.get("logs.vcsWorktreeTtlMinutes"));
    if (pruned.length > 0) bus.emit("WORKTREES_PRUNED", { ids: pruned }, {});
    await vcs.startBranchWatch();
    // §7.4 — prune dead-owner staging folders older than the TTL, mirroring the
    // worktree boot cleanup. Unfinished folders of a live/current owner are left
    // for recovery (apply/discard) which a session resume drives (§7.4).
    const stagingPruned = await staging.bootCleanup(limits.get("logs.vcsWorktreeTtlMinutes"));
    if (stagingPruned.length > 0) bus.emit("STAGING_PRUNED", { runs: stagingPruned }, {});
  } catch (e) {
    bus.emit("ERROR_OCCURRED", { source: "vcs", message: String(e) }, {});
  }

  // Managed layer status at boot (§13.5): "none" when unmanaged, else the
  // resolved status (ok | unavailable | invalid).
  const managed: ManagedStatus = managedStatus;

  if (opts.installSignalHandlers) {
    const onSignal = (): void => void api.session.shutdown();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  // Reference os to keep the import meaningful on platforms without a tmp seam.
  void os.tmpdir;

  return { api, housekeeping, managed };
}
