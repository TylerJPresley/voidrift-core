/**
 * `config.doctor` — validate every resource, read-only (core-blueprint.md §13.9.2).
 *
 * A HOST-ONLY facade operation exactly like `config.init` (§13.9): not a tool,
 * on no allow list, absent from the plugin `ScopedCoreApi`. It READS ONLY and
 * writes NOTHING — no `.rejected`, no seeding, no session, no cache. It works
 * even when the core booted with a rejected config (it reports it), and the CLI
 * command runs WITHOUT a configured model (a doctor run on a broken install is
 * its main use): a missing model is a MODELS finding, never a crash.
 *
 * Network checks (model listing, web-search reachability) run by default, each
 * bounded by `timeoutMs` (default 5000). `offline: true` SKIPS every network
 * check and reports it `ok` with `skipped (offline)`. A finding that is not `ok`
 * MUST carry the exact `fix`.
 *
 * Secrets are never printed: env vars are reported by NAME and set/unset only,
 * URLs are stripped of any userinfo, allow-list entries are shown as stored. The
 * key of a model entry is sent only to that entry's own `baseUrl`; a redirect to
 * another host is NOT followed. A model `baseUrl` (or the webSearch endpoint)
 * that is a cloud-metadata address is NEVER probed unless `metadata-hosts` is in
 * `unlock` — the SSRF never-list category is the single source for that set. MCP
 * servers are checked as configuration only — `doctor` never starts a server
 * (that would execute a possibly-untrusted project config).
 *
 * Pure of infrastructure: every I/O and clock is through an injected dependency
 * (§1 rule 3, 7), so the whole surface is tested offline with fakes.
 */
import { seedConfigDocument, seedPermissions } from "../config/seed.js";
import { classifyAgainstManifest, type ShippedManifest } from "../config/shipped-manifest.js";
import { validateWebSearchEndpoint } from "../config/schema.js";
import type { ConfigLayer } from "../config/schema.js";
import type { ConfigCapability } from "../entities/config-capability.js";
import { DEFAULT_AGENT_ORDER } from "../entities/agent-manifest.js";
import type { AgentDefinition } from "../entities/subagents.js";
import { isMetadataHost, METADATA_HOSTS_ID } from "../entities/never-list.js";
import { limitAreas, getLimitSpec, LIMITS, limitDefault } from "../entities/limits.js";
import { resolveLimits } from "../entities/limits-resolve.js";
import { SEED_SKILLS } from "./config-init.js";

/** The ten group ids, in report order (§13.9.2). */
export type DoctorGroupId =
  | "config"
  | "agents"
  | "allow-list"
  | "models"
  | "web-search"
  | "mcp"
  | "plugins"
  | "skills-prompts"
  | "storage"
  | "rollback"
  | "limits"
  | "drift";
export type DoctorStatus = "ok" | "warn" | "fail";

/** One finding. A non-`ok` finding MUST carry `fix` (§13.9.2). */
export interface DoctorFinding {
  id: string;
  status: DoctorStatus;
  message: string;
  fix?: string;
  layer?: ConfigLayer | "builtin" | "default";
  file?: string;
}

export interface DoctorGroup {
  id: DoctorGroupId;
  title: string;
  findings: DoctorFinding[];
}

export interface DoctorReport {
  groups: DoctorGroup[];
  summary: { ok: number; warn: number; fail: number };
  exitCode: 0 | 1;
}

/** A keyless network probe result for a single endpoint (host-pinned by caller). */
export interface ProbeResult {
  /** True when the endpoint answered (any HTTP status) within the timeout. */
  reachable: boolean;
  /** The HTTP status when reachable, else null. */
  status: number | null;
  /** A short, value-free reason when not reachable (timeout, refused, …). */
  reason?: string;
  /** For a model-listing probe: the model ids the listing returned (empty when
   * unreachable or the body was not a model listing). */
  modelIds?: string[];
  /** True when the endpoint redirected to ANOTHER host (not followed, §13.9.2). */
  crossHostRedirect?: boolean;
}

/** A model-endpoint listing probe (GET <baseUrl>/models). The adapter sends the
 * key ONLY to `baseUrl`'s host and does NOT follow a cross-host redirect. */
export type ModelListProbe = (
  baseUrl: string,
  opts: { apiKeyEnv?: string; timeoutMs: number },
) => Promise<ProbeResult>;

/** A web-search / generic reachability probe (HEAD/GET, no key unless keyed). */
export type ReachProbe = (url: string, opts: { timeoutMs: number }) => Promise<ProbeResult>;

/** A storage stat for the config dir and a file: mode bits and free space. */
export interface StorageProbe {
  /** The octal permission bits of a path (e.g. 0o700), or null when absent. */
  modeOf(absPath: string): Promise<number | null>;
  /** True when the path is a symbolic link. */
  isSymlink(absPath: string): Promise<boolean>;
  /** Free bytes available on the filesystem holding `absPath`, or null. */
  freeBytes(absPath: string): Promise<number | null>;
  /** True when a dir exists or can be created without writing anything durable
   * (a dry check: exists, or its parent is writable). */
  dirUsable(absPath: string): Promise<boolean>;
  /** Read a UTF-8 file, or null when absent/unreadable. Used for skills/prompts
   * and drift template comparison. Never writes. */
  readFile(absPath: string): Promise<string | null>;
  /** List immediate child directory names of a dir, or [] when absent. */
  listDirs(absPath: string): Promise<string[]>;
  /** The backup/editor-leftover FILES found in a directory (§13.9.1): the
   * matching top-level file paths, and — when `recurseOneLevel` — those in each
   * immediate child directory too (for a live resource dir and its `<name>/`
   * subdirs). Returns absolute paths; `[]` when the dir is absent or clean.
   * Optional: a probe that does not supply it disables the leftover checks. */
  listLeftovers?(absPath: string, recurseOneLevel: boolean): Promise<string[]>;
  /** Scan a repo-local `.git/config` under `workspaceRoot` for executable-capable
   * keys (value-free): returns the distinct key-class labels present (e.g.
   * `core.fsmonitor`, `filter`, `diff.external`), or [] when the file is absent
   * or holds none. Reads no git. */
  gitConfigScan(workspaceRoot: string): Promise<string[]>;

  // ── VCS checks (STORAGE group), read-only. Optional: a probe that does not
  // supply it disables the VCS-specific storage checks. ──
  /** Check if a path is ignored by the workspace `.gitignore`. Returns true when
   * the path IS ignored (exit 0), false when NOT ignored (exit 1) or when not a
   * repo/error (exit 128+). Uses hardened git. Optional: when absent, gitignore
   * checks are skipped. */
  checkIgnore?(workspaceRoot: string): Promise<boolean>;

  // ── Rollback (§10.12), all read-only. Optional: a probe that does not supply
  // them disables the rollback-specific checks (the group still reports method
  // and snapshotCount from config alone). ──
  /** True when `workspaceRoot` is a git repository whose git runs through the
   * hardened runner (so the `git` snapshot method is available). False when the
   * dir is not a repo or git cannot run. */
  isGitRepo?(workspaceRoot: string): Promise<boolean>;
  /** The number of private rollback refs under `refs/voidrift/*`, read through
   * the hardened git runner (`git for-each-ref refs/voidrift`). 0 when not a
   * repo or none exist. Count only — never ref names or content. */
  countVoidriftRefs?(workspaceRoot: string): Promise<number>;
  /** The total size in bytes of a directory tree (recursive), or 0 when absent.
   * Used for the `.voidrift/cache/snapshots` size. */
  dirSizeBytes?(absPath: string): Promise<number>;
  /** The recorded-move count per session under the cache snapshots dir: for each
   * `<snapshotsDir>/<sessionId>/timeline.json`, the number of moves it records.
   * Returns `{ sessionId, moves }[]`; `[]` when the dir is absent. */
  movesPerSession?(snapshotsDir: string): Promise<{ sessionId: string; moves: number }[]>;
  /** The session ids under the cache snapshots dir whose `timeline.json` carries
   * a missing/invalid integrity HMAC (planted, copied from another machine, or
   * edited) and so is IGNORED as untrusted (§10.12). Value-free: ids only.
   * `[]` when the dir is absent or every session verifies. */
  untrustedRollbackSessions?(snapshotsDir: string): Promise<string[]>;

  // ── Durable registry (§12.5), read-only. Optional: a probe that does not
  // supply it disables the registry-specific storage checks. ──
  /** The saved routine and plan names found in the durable registry files under
   * `registryDir`. Value-free: NAMES ONLY (the `<id>` suffix of a `routine:` /
   * `plan:` key), never a prompt, goal, step, or any value. `{ routines: [],
   * plans: [] }` when the dir is absent. */
  registryCounts?(registryDir: string): Promise<{ routines: string[]; plans: string[] }>;
}

/** The injected surface `config.doctor` reads (all read-only). */
export interface DoctorDeps {
  /** The booted (or boot-tolerant) config capability — layers, warnings,
   * rejections, provenance, never list. */
  config: ConfigCapability;
  /** Discovered agents (valid) and skipped (with reason), already cascaded. */
  agents: { definitions: AgentDefinition[]; skipped: { name: string; reason: string }[] };
  /** Every tool name known to the runtime: built-ins + discovered MCP/plugin. */
  knownTools: () => Set<string>;
  /** The set of MUTATING built-in tool names (readOnly === false). */
  mutatingTools: () => Set<string>;
  /** Discovered skill directory names and whether each has a valid SKILL.md. */
  skills: () => { name: string; valid: boolean; dir: string }[];
  /** Resolved absolute paths for storage checks. */
  paths: {
    configDir: string;
    configFile: string;
    sessionsDir: string;
    journalDir: string;
    seedAgentsDir: string;
    /** The absolute package seed-skills dir (`<pkg>/seed/skills`), for the
     * missing/drift checks on seeded skills (§12.1, §13.9.2). */
    seedSkillsDir: string;
    /** The durable registry dir `<configDir>/registry/<workspace key>` (§12.5),
     * for the registry-dir mode check and the stored routine/plan counts. */
    registryDir?: string;
    /** The workspace root, for the `.voidrift` state dir and `.git/config` checks. */
    workspaceRoot: string;
  };
  /** Read an env var; returns whether it is SET only (never the value). */
  envSet: (name: string) => boolean;
  /** Network probes (unused under `offline`). */
  modelListProbe: ModelListProbe;
  reachProbe: ReachProbe;
  storage: StorageProbe;
}

export interface DoctorOptions {
  offline?: boolean;
  timeoutMs?: number;
}

const SKIPPED_OFFLINE = "skipped (offline)";
const MIN_FREE_BYTES = 100 * 1024 * 1024; // 100 MB
const MAX_CONTEXT_LIMIT = 10_000_000;

/** Strip any userinfo (`user:pass@`) from a URL for display (§13.9.2 secrets). */
export function stripUserinfo(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    // Not a URL; strip a bare `scheme://user:pass@host` shape defensively.
    return raw.replace(/\/\/[^/@]*@/, "//");
  }
}

/** The hostname of a URL (userinfo and port stripped), or null when unparseable. */
function hostOf(raw: string): string | null {
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}

/** True when a URL points at a cloud instance-metadata address (the SSRF
 * never-list `metadata-hosts` set is the single source). An unparseable URL is
 * not a metadata host (it fails elsewhere as unreachable/invalid). */
function isMetadataUrl(raw: string): boolean {
  const host = hostOf(raw);
  return host !== null && isMetadataHost(host);
}

/** True when `metadata-hosts` is in the honored `unlock` list (global/managed). */
function metadataUnlocked(ctx: Ctx): boolean {
  return (ctx.deps.config.get().unlock ?? []).includes(METADATA_HOSTS_ID);
}

/** True when the project layer's own `models.<name>` entry declares `baseUrl`
 * (records merge by id, so a project `baseUrl` replaces the global one). */
function modelEndpointFromProject(ctx: Ctx, name: string): boolean {
  const projModels = ctx.deps.config.layerKey("project", "models");
  if (projModels === null || typeof projModels !== "object") return false;
  const entry = (projModels as Record<string, unknown>)[name];
  if (entry === null || typeof entry !== "object") return false;
  const baseUrl = (entry as { baseUrl?: unknown }).baseUrl;
  return typeof baseUrl === "string" && baseUrl !== "";
}

/** True when the webSearch setting in effect was contributed by the project
 * layer (webSearch is a per-key override, so a project `webSearch` wins). */
function webSearchFromProject(ctx: Ctx): boolean {
  const projWs = ctx.deps.config.layerKey("project", "webSearch");
  return projWs !== null && typeof projWs === "object";
}

/** The core doctor: assemble every group, tally the summary, map the exit code. */
export async function runDoctor(deps: DoctorDeps, opts: DoctorOptions = {}): Promise<DoctorReport> {
  const offline = opts.offline === true;
  const timeoutMs = opts.timeoutMs ?? limitDefault("doctor.networkTimeoutMs");
  const ctx: Ctx = { deps, offline, timeoutMs };

  const groups: DoctorGroup[] = [
    { id: "config", title: "Config", findings: await checkConfig(ctx) },
    { id: "agents", title: "Agents", findings: checkAgents(ctx) },
    { id: "allow-list", title: "Allow list", findings: checkAllowList(ctx) },
    { id: "models", title: "Models", findings: await checkModels(ctx) },
    { id: "web-search", title: "Web search", findings: await checkWebSearch(ctx) },
    { id: "mcp", title: "MCP", findings: checkMcp(ctx) },
    { id: "plugins", title: "Plugins", findings: checkPlugins(ctx) },
    { id: "skills-prompts", title: "Skills and prompts", findings: checkSkillsPrompts(ctx) },
    { id: "storage", title: "Storage", findings: await checkStorage(ctx) },
    { id: "rollback", title: "Rollback", findings: await checkRollback(ctx) },
    { id: "limits", title: "Limits", findings: checkLimits(ctx) },
    { id: "drift", title: "Drift", findings: await checkDrift(ctx) },
  ];

  let ok = 0;
  let warn = 0;
  let fail = 0;
  for (const g of groups)
    for (const f of g.findings) {
      if (f.status === "ok") ok++;
      else if (f.status === "warn") warn++;
      else fail++;
    }
  return { groups, summary: { ok, warn, fail }, exitCode: fail > 0 ? 1 : 0 };
}

interface Ctx {
  deps: DoctorDeps;
  offline: boolean;
  timeoutMs: number;
}

function okF(id: string, message: string, extra?: Partial<DoctorFinding>): DoctorFinding {
  return { id, status: "ok", message, ...extra };
}
function warnF(id: string, message: string, fix: string, extra?: Partial<DoctorFinding>): DoctorFinding {
  return { id, status: "warn", message, fix, ...extra };
}
function failF(id: string, message: string, fix: string, extra?: Partial<DoctorFinding>): DoctorFinding {
  return { id, status: "fail", message, fix, ...extra };
}

// ── CONFIG ──────────────────────────────────────────────────────────────────
function checkConfig(ctx: Ctx): Promise<DoctorFinding[]> {
  return checkConfigImpl(ctx);
}

async function checkConfigImpl(ctx: Ctx): Promise<DoctorFinding[]> {
  const out: DoctorFinding[] = [];
  const cap = ctx.deps.config;

  // Every rejected layer → fail, naming the file and its `.rejected` sibling.
  for (const r of cap.rejectedLayers()) {
    out.push(
      failF(
        `config.rejected.${r.layer}`,
        `${r.layer} config at ${r.path} failed to validate and was set aside`,
        `fix the errors in ${r.path} (the broken copy is kept at ${r.rejectedPath}), then re-run`,
        { layer: r.layer, file: r.path },
      ),
    );
  }

  // Non-fatal warnings (ignored unlock, etc.).
  for (const w of cap.configWarnings()) {
    out.push(
      warnF(`config.warning.${w.layer}.${w.key}`, w.message, `remove or move "${w.key}" to a layer where it is honored`, {
        layer: w.layer,
        file: w.path,
      }),
    );
  }

  // §13.1/§13.9.2 — every RETIRED key the versioned migration mapped to its
  // current name → one `migrated keys` warning naming the retired key, its
  // current name, and the layer/file, with the fix to persist the rename.
  for (const m of cap.configMigrations()) {
    out.push(
      warnF(
        `config.migrated.${m.layer}.${m.from}`,
        `migrated keys: "${m.from}" → "${m.to}" in the ${m.layer} layer (${m.path})${m.conflict ? ` — both were set; "${m.to}" won` : ""}`,
        `run \`voidrift init --migrate\` to persist the rename of "${m.from}" to "${m.to}"`,
        { layer: m.layer, file: m.path },
      ),
    );
  }

  // Layer+file provenance: one compact `ok` finding per distinct source file
  // with the count of entries (permission rules) it contributes.
  const paths = cap.paths();
  const perLayerCounts = permissionCountsByLayer(cap);
  for (const layer of ["managed", "global", "project", "session"] as ConfigLayer[]) {
    const p = paths[layer];
    if (!p.exists) continue;
    const n = perLayerCounts[layer] ?? 0;
    out.push(
      okF(`config.source.${layer}`, `${layer} config validated: ${p.path} (${n} permission entr${n === 1 ? "y" : "ies"})`, {
        layer,
        file: p.path,
      }),
    );
  }

  // A project layer that WIDENS the global base: a project allow rule, plugin,
  // mcp server, or union-array entry (findingsDirectories/worktreeInclude/shell*)
  // → warn naming the file.
  const projPath = paths.project?.path;
  if (projPath && paths.project.exists) {
    const projPerms = cap.layerPermissions("project");
    const projAllow = Object.values(projPerms).filter(
      (r) => typeof r === "object" && r !== null && (r as { decision?: string }).decision === "allow",
    ).length;
    if (projAllow > 0) {
      out.push(
        warnF(
          "config.widen.project.permissions",
          `the project config adds ${projAllow} allow rule(s) on top of the global base`,
          `review ${projPath} — a project allow rule widens what runs without a prompt`,
          { layer: "project", file: projPath },
        ),
      );
    }
    const projPlugins = cap.pluginLayers().project;
    if (Object.keys(projPlugins).length > 0) {
      out.push(
        warnF(
          "config.widen.project.plugins",
          `the project config enables ${Object.keys(projPlugins).length} plugin(s)`,
          `review ${projPath} — a project plugin runs in-process as trusted code`,
          { layer: "project", file: projPath },
        ),
      );
    }
    for (const key of ["findingsDirectories", "worktreeInclude", "shellSafeCommands", "shellForceAskPatterns", "shellEquivalents", "shellDenyPatterns"]) {
      const { from } = cap.resolveWithProvenance(key);
      const addsProject = Object.values(from).some((layers) => layers.includes("project") && !layers.includes("global"));
      if (addsProject) {
        out.push(
          warnF(
            `config.widen.project.${key}`,
            `the project config adds entries to "${key}" not in the global base`,
            `review ${projPath} — the project widens "${key}"`,
            { layer: "project", file: projPath },
          ),
        );
      }
    }
  }

  // Backup/editor-leftover files (§13.9.1). A leftover INSIDE a live resource
  // directory (agents/skills/prompts) is a FAIL — it blocks startup; one in the
  // config-directory ROOT is a WARN — it never blocks. Both carry the same fix.
  const st = ctx.deps.storage;
  const cfgDir = ctx.deps.paths.configDir;
  const ws = ctx.deps.paths.workspaceRoot;
  const listLeftovers = st.listLeftovers?.bind(st) ?? (async (): Promise<string[]> => []);
  const liveRoots = [cfgDir, `${ws}/.voidrift`];
  for (const root of liveRoots) {
    for (const live of ["agents", "skills", "prompts"]) {
      const found = await listLeftovers(`${root}/${live}`, true);
      for (const file of found) {
        out.push(
          failF(
            `config.leftover.${file}`,
            `backup/leftover file in a live resource directory: ${file}`,
            "voidrift init --sweep",
            { file },
          ),
        );
      }
    }
  }
  // Config-directory ROOT leftovers (e.g. `config.json.bak-*`): warn only.
  for (const file of await listLeftovers(cfgDir, false)) {
    out.push(
      warnF(
        `config.rootleftover.${file}`,
        `backup/leftover file in the config directory root: ${file}`,
        "voidrift init --sweep",
        { file },
      ),
    );
  }

  if (out.every((f) => f.status === "ok")) {
    out.push(okF("config.ok", "every config layer parses and validates"));
  }
  return out;
}

/** Count permission rules contributed by each layer (own document). */
function permissionCountsByLayer(cap: ConfigCapability): Record<ConfigLayer, number> {
  const out = { managed: 0, global: 0, project: 0, session: 0 } as Record<ConfigLayer, number>;
  for (const layer of ["managed", "global", "project", "session"] as ConfigLayer[]) {
    out[layer] = Object.keys(cap.layerPermissions(layer)).length;
  }
  return out;
}

// ── AGENTS ──────────────────────────────────────────────────────────────────
function checkAgents(ctx: Ctx): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  const { definitions, skipped } = ctx.deps.agents;
  const known = ctx.deps.knownTools();

  // An install with a config but an EMPTY agents folder.
  const hasConfig = ctx.deps.config.paths().global.exists;
  if (definitions.length === 0 && hasConfig) {
    out.push(
      warnF("agents.empty", "the agents folder is empty while a config is present", "voidrift init"),
    );
  }

  // Skipped agents (with their reason).
  for (const s of skipped) {
    out.push(
      failF(`agents.skipped.${s.name}`, `agent "${s.name}" was skipped: ${s.reason}`, `fix agents/${s.name}/agent.json, or run voidrift init --reset ${s.name}`),
    );
  }

  const topLevel = definitions.filter((d) => d.kind === "top-level");
  const names = new Set(definitions.map((d) => d.name));

  // Duplicate order across top-level agents.
  const orders = new Map<number, string[]>();
  for (const d of topLevel) {
    const o = d.order ?? DEFAULT_AGENT_ORDER;
    (orders.get(o) ?? orders.set(o, []).get(o)!).push(d.name);
  }
  for (const [o, ns] of orders) {
    if (ns.length > 1) {
      out.push(
        warnF(`agents.dup-order.${o}`, `agents ${ns.join(", ")} share order ${o}`, `set a distinct "order" in each of agents/{${ns.join(",")}}/agent.json`),
      );
    }
  }

  for (const d of definitions) {
    // Every named tool exists (`*` is the wildcard the built-in chat uses).
    for (const t of d.tools) {
      if (t === "*") continue;
      if (!known.has(t)) {
        out.push(
          failF(`agents.tool.${d.name}.${t}`, `agent "${d.name}" names tool "${t}" which does not exist`, `remove "${t}" from agents/${d.name}/agent.json tools, or install the plugin/MCP server that provides it`),
        );
      }
    }
    // A worker must not hold `task`.
    if (d.kind === "worker" && d.tools.includes("task")) {
      out.push(
        failF(`agents.worker-task.${d.name}`, `worker "${d.name}" holds the "task" tool (a worker cannot delegate)`, `remove "task" from agents/${d.name}/agent.json`),
      );
    }
    // unlisted: allow requires confirm: true.
    if (d.kind === "top-level" && d.unlisted === "allow" && d.confirm !== true) {
      out.push(
        failF(`agents.confirm.${d.name}`, `top-level agent "${d.name}" has unlisted: allow without confirm: true`, `set "confirm": true in agents/${d.name}/agent.json`),
      );
    }
    // Every referenced worker exists.
    if (d.kind === "top-level" && Array.isArray(d.workers)) {
      for (const w of d.workers) {
        if (!names.has(w)) {
          out.push(
            failF(`agents.worker-missing.${d.name}.${w}`, `agent "${d.name}" references worker "${w}" which does not exist`, `add agents/${w}/, or remove "${w}" from agents/${d.name}/agent.json workers`),
          );
        }
      }
    }
    // A prompt is present (discovery already enforced this; a defensive check).
    if (!d.systemPrompt || d.systemPrompt.trim() === "") {
      out.push(
        failF(`agents.prompt.${d.name}`, `agent "${d.name}" has no prompt`, `add a prompt.md or an inline "prompt" to agents/${d.name}/`),
      );
    }
  }

  if (out.every((f) => f.status === "ok")) out.push(okF("agents.ok", `${definitions.length} agent(s) valid`));
  return out;
}

// ── ALLOW LIST ────────────────────────────────────────────────────────────────
function checkAllowList(ctx: Ctx): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  const cap = ctx.deps.config;
  const cfg = cap.get();
  const perms = cfg.permissions ?? {};
  const known = ctx.deps.knownTools();
  const mutating = ctx.deps.mutatingTools();

  // Seeded default allow rules that are MISSING. Reported ONCE here (the DRIFT
  // group no longer repeats the roll-up). A single missing rule that happens to
  // be `researcher_save_notes` keeps its own distinct finding so the one write
  // a read-only research role may do is named precisely; otherwise a single
  // roll-up names the count and the first few ids.
  const seeded = seedPermissions();
  const missingIds = Object.keys(seeded).filter((id) => !(id in perms));
  if (missingIds.length === 1 && missingIds[0] === "allow-researcher_save_notes") {
    const id = missingIds[0];
    const rule = seeded[id]!;
    out.push(
      warnF(
        `allow-list.missing.${id}`,
        `seeded allow rule "${id}" (${rule.tool}${rule.pattern ? ` ${rule.pattern}` : ""}) is missing`,
        "voidrift init --update (adds the missing seeded allow rule, touching no other rule or model setting)",
      ),
    );
  } else if (missingIds.length > 0) {
    const shown = missingIds.slice(0, 5).join(", ");
    const ellipsis = missingIds.length > 5 ? "…" : "";
    out.push(
      warnF(
        "allow-list.missing",
        `${missingIds.length} seeded allow rules are missing: ${shown}${ellipsis}`,
        "voidrift init --update (adds the missing seeded allow rules, touching no other rule or model setting)",
      ),
    );
  }

  for (const [id, rule] of Object.entries(perms)) {
    if (rule.decision !== "allow") continue;
    // An entry whose tool matches no known tool and is not execute_command.
    if (rule.tool !== "execute_command" && !known.has(rule.tool)) {
      out.push(
        warnF(`allow-list.dead.${id}`, `allow rule "${id}" names tool "${rule.tool}" which matches no known tool`, `remove "${id}" from permissions or install the tool it names`),
      );
    }
    // A blanket execute_command allow (wildcard-only pattern).
    if (rule.tool === "execute_command" && (rule.pattern === undefined || rule.pattern.trim() === "*" || rule.pattern.trim() === "")) {
      out.push(
        warnF(`allow-list.blanket.${id}`, `allow rule "${id}" allows ANY execute_command (blanket allow)`, `scope "${id}" to a specific command pattern`),
      );
    }
  }

  // A MUTATING built-in on the allow list held by an unlisted: deny top-level
  // agent (research mode would run it). The seeded defaults intentionally free
  // the research-sanctioned writes (researcher_save_notes) and the network
  // tools for the read-only research role, so a rule whose `source` is
  // `default` is NOT flagged — only a user/project-added mutating allow is.
  const denyAgents = ctx.deps.agents.definitions.filter((d) => d.kind === "top-level" && d.unlisted === "deny");
  for (const [id, rule] of Object.entries(perms)) {
    if (rule.decision !== "allow" || !mutating.has(rule.tool) || rule.source === "default") continue;
    for (const d of denyAgents) {
      if (d.tools.includes("*") || d.tools.includes(rule.tool)) {
        out.push(
          warnF(
            `allow-list.mutating-in-deny.${id}.${d.name}`,
            `mutating tool "${rule.tool}" is allow-listed and held by read-only agent "${d.name}" (unlisted: deny)`,
            `remove "${id}" from permissions, or remove "${rule.tool}" from agents/${d.name}/agent.json`,
          ),
        );
      }
    }
  }

  // Discovered MCP/plugin tools NOT on the allow list (will ask).
  const allowedTools = new Set(
    Object.values(perms)
      .filter((r) => r.decision === "allow")
      .map((r) => r.tool),
  );
  for (const t of known) {
    // Heuristic: an MCP/plugin tool is one with a namespace separator or not a
    // built-in; here we only flag tools that are not allow-listed AND not a
    // core built-in managed elsewhere. We flag namespaced tools (`server__tool`).
    if ((t.includes("__") || t.includes("/")) && !allowedTools.has(t)) {
      out.push(
        warnF(`allow-list.will-ask.${t}`, `discovered tool "${t}" is not on the allow list and will ask every time`, `add an allow rule for "${t}" if you want it to run without a prompt`),
      );
    }
  }

  if (out.every((f) => f.status === "ok")) out.push(okF("allow-list.ok", "the allow list is consistent"));
  return out;
}

// ── MODELS ──────────────────────────────────────────────────────────────────
async function checkModels(ctx: Ctx): Promise<DoctorFinding[]> {
  const out: DoctorFinding[] = [];
  const cfg = ctx.deps.config.get();
  const models = cfg.models ?? {};
  const names = Object.keys(models);

  if (names.length === 0) {
    out.push(failF("models.none", "no model is configured", "add a model entry under \"models\" and set \"modelSelected\" (voidrift init seeds a local default)"));
    return out;
  }

  // modelSelected names an existing entry.
  const selected = cfg.modelSelected;
  if (!selected || !(selected in models)) {
    out.push(
      failF("models.selected", `modelSelected ${selected ? `"${selected}"` : "is unset"} and names no configured entry`, `set "modelSelected" to one of: ${names.join(", ")}`),
    );
  }

  // §11.6 — modelUtility (the background/utility endpoint) is OPTIONAL; when set
  // it must name a configured entry (an unset value falls back to modelSelected
  // at the call site, so no finding). Shown in the models group when present.
  const utility = cfg.modelUtility;
  if (utility !== undefined) {
    out.push(
      utility in models
        ? okF("models.utility", `modelUtility "${utility}" (background calls) names a configured entry`)
        : failF("models.utility", `modelUtility "${utility}" names no configured entry`, `set "modelUtility" to one of: ${names.join(", ")}, or remove it to use modelSelected`),
    );
  }

  for (const [name, entry] of Object.entries(models)) {
    const e = entry as {
      model: string;
      baseUrl?: string;
      apiKeyEnv?: string;
      contextLimit?: number;
      maxOutputTokens?: number;
      maxConcurrency?: number;
    };
    // contextLimit plausible.
    if (e.contextLimit !== undefined && (e.contextLimit <= 0 || e.contextLimit > MAX_CONTEXT_LIMIT)) {
      out.push(
        failF(`models.ctx.${name}`, `model "${name}" has an implausible contextLimit (${e.contextLimit})`, `set "contextLimit" between 1 and ${MAX_CONTEXT_LIMIT} for "${name}"`),
      );
    }
    // §11.2 — the output reservation must fit inside the window: a
    // `maxOutputTokens` >= `contextLimit` leaves no room for the prompt and every
    // request is refused before sending. (The config schema also rejects this;
    // doctor names both values so the fix is obvious.)
    if (e.maxOutputTokens !== undefined && e.contextLimit !== undefined && e.maxOutputTokens >= e.contextLimit) {
      out.push(
        failF(
          `models.output.${name}`,
          `model "${name}" has maxOutputTokens (${e.maxOutputTokens}) >= contextLimit (${e.contextLimit}); no room is left for the prompt`,
          `lower "maxOutputTokens" below "contextLimit" for "${name}" (or raise "contextLimit")`,
        ),
      );
    }
    if (e.maxConcurrency !== undefined && e.maxConcurrency <= 0) {
      out.push(failF(`models.conc.${name}`, `model "${name}" has an invalid maxConcurrency (${e.maxConcurrency})`, `set "maxConcurrency" to a positive integer for "${name}"`));
    }
    // apiKeyEnv set-or-not (name only).
    if (e.apiKeyEnv) {
      const set = ctx.deps.envSet(e.apiKeyEnv);
      out.push(
        set
          ? okF(`models.key.${name}`, `model "${name}" key env ${e.apiKeyEnv} is set`)
          : warnF(`models.key.${name}`, `model "${name}" key env ${e.apiKeyEnv} is NOT set`, `export ${e.apiKeyEnv} with the provider API key`),
      );
    }
    // Endpoint reachability + listing.
    if (!e.baseUrl) {
      out.push(okF(`models.endpoint.${name}`, `model "${name}" uses a bundled provider default (no baseUrl to probe)`));
      continue;
    }
    const displayUrl = stripUserinfo(e.baseUrl);

    // VISIBILITY: a baseUrl contributed by the PROJECT layer (an untrusted-repo
    // surface) is called out so the user knows a repo config points inference
    // (and this probe) at a host (credentials stripped).
    if (modelEndpointFromProject(ctx, name)) {
      const host = hostOf(e.baseUrl) ?? displayUrl;
      out.push(
        warnF(
          `models.endpoint.project.${name}`,
          `model endpoint '${name}' comes from ${ctx.deps.config.paths().project.path}: ${host}`,
          "check that you trust this project",
          { layer: "project", file: ctx.deps.config.paths().project.path },
        ),
      );
    }

    // SSRF: NEVER probe a cloud-metadata address unless `metadata-hosts` is
    // unlocked — zero requests, a fail finding instead (the probe is not called).
    if (isMetadataUrl(e.baseUrl) && !metadataUnlocked(ctx)) {
      out.push(
        failF(
          `models.endpoint.${name}`,
          `model "${name}" baseUrl is a cloud-metadata address — not probed`,
          `point "baseUrl" at your real model server for "${name}" (a metadata address is never probed unless you add "metadata-hosts" to "unlock")`,
        ),
      );
      continue;
    }

    if (ctx.offline) {
      out.push(okF(`models.endpoint.${name}`, `model "${name}" (${displayUrl}): ${SKIPPED_OFFLINE}`));
      continue;
    }
    const probe = await ctx.deps.modelListProbe(e.baseUrl, {
      ...(e.apiKeyEnv ? { apiKeyEnv: e.apiKeyEnv } : {}),
      timeoutMs: ctx.timeoutMs,
    });
    if (probe.crossHostRedirect) {
      out.push(failF(`models.endpoint.${name}`, `model "${name}" (${displayUrl}) redirected to another host (not followed)`, `point "baseUrl" at the real endpoint for "${name}"`));
      continue;
    }
    if (!probe.reachable) {
      out.push(failF(`models.endpoint.${name}`, `model "${name}" endpoint ${displayUrl} is not reachable${probe.reason ? ` (${probe.reason})` : ""}`, `start the server at ${displayUrl} or correct "baseUrl" for "${name}"`));
      continue;
    }
    out.push(okF(`models.endpoint.${name}`, `model "${name}" endpoint ${displayUrl} is reachable (HTTP ${probe.status})`));
    // Model id present in the listing.
    const ids = probe.modelIds ?? [];
    if (ids.length > 0 && !ids.includes(e.model)) {
      // A router id (listing non-empty, id absent) → warn, not fail.
      out.push(
        warnF(`models.id.${name}`, `model id "${e.model}" is not in the listing at ${displayUrl} (may be a router)`, `confirm "${e.model}" is served by ${displayUrl}, or set it to a listed id`),
      );
    }
  }

  if (out.every((f) => f.status === "ok")) out.push(okF("models.ok", `${names.length} model(s) configured`));
  return out;
}

// ── WEB SEARCH ────────────────────────────────────────────────────────────────
async function checkWebSearch(ctx: Ctx): Promise<DoctorFinding[]> {
  const out: DoctorFinding[] = [];
  const ws = ctx.deps.config.get().webSearch ?? { provider: "duckduckgo" };
  const provider = ws.provider ?? "duckduckgo";
  const keyed = provider === "brave" || provider === "tavily";

  // key env var set when keyed.
  if (keyed) {
    if (!ws.apiKeyEnv) {
      out.push(warnF("web-search.key-env", `provider "${provider}" needs a key but no apiKeyEnv is set`, `set webSearch.apiKeyEnv to the env var holding the ${provider} key`));
    } else if (!ctx.deps.envSet(ws.apiKeyEnv)) {
      out.push(warnF("web-search.key", `provider "${provider}" key env ${ws.apiKeyEnv} is NOT set`, `export ${ws.apiKeyEnv} with the ${provider} API key`));
    } else {
      out.push(okF("web-search.key", `provider "${provider}" key env ${ws.apiKeyEnv} is set`));
    }
  }

  // searxng endpoint rules.
  if (ws.endpoint) {
    const err = validateWebSearchEndpoint(ws.endpoint);
    const display = stripUserinfo(ws.endpoint);
    if (err) {
      out.push(failF("web-search.endpoint", `webSearch.endpoint ${display} is invalid: ${err}`, "fix webSearch.endpoint (https required except a loopback/private host; no embedded credentials)"));
    } else {
      out.push(okF("web-search.endpoint", `webSearch.endpoint ${display} obeys the rules`));
      // A private/loopback endpoint asks every call.
      try {
        const host = new URL(ws.endpoint).hostname;
        if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(host)) {
          out.push(warnF("web-search.private", `webSearch.endpoint ${display} is a private/loopback host (asks on every web_search call)`, "use a public https endpoint if you want web_search to run without a prompt"));
        }
      } catch {
        /* ignore */
      }
    }
  }

  // VISIBILITY: a webSearch setting in effect that was contributed by the
  // PROJECT layer (an untrusted-repo surface) is called out (host stripped).
  if (webSearchFromProject(ctx)) {
    const host = ws.endpoint ? (hostOf(ws.endpoint) ?? stripUserinfo(ws.endpoint)) : provider;
    out.push(
      warnF(
        "web-search.project",
        `model endpoint '${provider}' comes from ${ctx.deps.config.paths().project.path}: ${host}`,
        "check that you trust this project",
        { layer: "project", file: ctx.deps.config.paths().project.path },
      ),
    );
  }

  // provider reachability. NEVER probe a cloud-metadata endpoint unless
  // `metadata-hosts` is unlocked — a fail finding, zero requests.
  const metadataEndpoint = !!ws.endpoint && isMetadataUrl(ws.endpoint) && !metadataUnlocked(ctx);
  if (metadataEndpoint) {
    out.push(
      failF(
        "web-search.reach",
        "webSearch.endpoint is a cloud-metadata address — not probed",
        'point webSearch.endpoint at your real search server (a metadata address is never probed unless you add "metadata-hosts" to "unlock")',
      ),
    );
  } else if (ctx.offline) {
    out.push(okF("web-search.reach", `provider "${provider}": ${SKIPPED_OFFLINE}`));
  } else if (ws.endpoint || provider === "duckduckgo") {
    const url = ws.endpoint ?? "https://duckduckgo.com/";
    const probe = await ctx.deps.reachProbe(url, { timeoutMs: ctx.timeoutMs });
    if (probe.reachable) {
      out.push(okF("web-search.reach", `provider "${provider}" is reachable (HTTP ${probe.status})`));
    } else {
      // duckduckgo is best-effort → warn either way (it is the keyless default).
      out.push(warnF("web-search.reach", `provider "${provider}" is not reachable${probe.reason ? ` (${probe.reason})` : ""}`, `check network/${provider} availability (search will fall back or fail at call time)`));
    }
  }

  // Proxy env: undici (the web_fetch transport) honours HTTP_PROXY/HTTPS_PROXY/
  // ALL_PROXY, so a configured proxy means the SSRF connect-pin vets the PROXY
  // connection, not the final host (security-audit S3). Value-free: NAME only,
  // either case. One warn per set variable.
  for (const base of PROXY_ENV_VARS) {
    for (const name of [base, base.toLowerCase()]) {
      if (ctx.deps.envSet(name)) {
        out.push(
          warnF(
            `web-search.proxy.${name}`,
            `proxy environment variable is set (${name}); web_fetch private-address checks apply to the proxy connection, not to the final host`,
            "unset it or route web access through a network policy you control",
          ),
        );
      }
    }
  }

  if (out.every((f) => f.status === "ok")) out.push(okF("web-search.ok", `web search provider "${provider}" is configured`));
  return out;
}

/** The proxy env vars undici honours; a set one means the SSRF connect-pin vets
 * the proxy hop, not the final host (security-audit S3). Checked in BOTH cases
 * (per name). */
const PROXY_ENV_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] as const;

// ── MCP ───────────────────────────────────────────────────────────────────────
// Configuration + pin-state checks ONLY. `doctor` never starts an MCP server:
// that would execute a command from a possibly-untrusted project config. Connect
// health is observed at runtime when the core lists the server's tools.
function checkMcp(ctx: Ctx): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  const mcp = (ctx.deps.config.get().mcp ?? {}) as Record<string, { transport?: string; url?: string }>;
  const names = Object.keys(mcp);
  if (names.length === 0) {
    out.push(okF("mcp.none", "no MCP server configured"));
    return out;
  }
  for (const [name, server] of Object.entries(mcp)) {
    out.push(
      okF(`mcp.${name}`, `MCP server "${name}" (${server.transport ?? "stdio"}) configured; doctor does not start servers (connect not checked)`),
    );
  }
  if (out.every((f) => f.status === "ok")) out.push(okF("mcp.ok", `${names.length} MCP server(s) configured`));
  return out;
}

// ── PLUGINS ─────────────────────────────────────────────────────────────────
// Configuration-only: the license scan and peer-version check in `plugins.ts`
// (`loader.licenseScan` over a `ResolvedPlugin`, `toReview`/`satisfiesRange`)
// require the booted plugin loader, which the host doctor does not construct —
// so no plugin code runs here and the per-plugin license/peer verdict is left to
// load time. A PROJECT-layer plugin (an untrusted-repo surface) is still called
// out, and every plugin carries the "checked when the plugin loads" note.

/** First-party plugins that cannot do their job without `options` (§12.4): the
 * exporters need `options.config` (endpoint/credentials) and retrieval reads
 * `options.config`/backends. Doctor WARNs when one is enabled with none. */
const PLUGINS_REQUIRING_OPTIONS = new Set([
  "@voidrift/plugin-otel-exporter",
  "@voidrift/plugin-langfuse-exporter",
  "@voidrift/plugin-retrieval",
]);

/** Read a plugin entry's `enabled`/`options` defensively (the layer record holds
 * `unknown` values). An entry defaults to enabled; options present means a
 * non-empty object. Value-free: only WHETHER options exist, never their content. */
function pluginEntryInfo(entry: unknown): { enabled: boolean; hasOptions: boolean } {
  const e = (entry ?? {}) as { enabled?: unknown; options?: unknown };
  const enabled = e.enabled !== false;
  const hasOptions = typeof e.options === "object" && e.options !== null && Object.keys(e.options as object).length > 0;
  return { enabled, hasOptions };
}

/** The exporter config object under `options.config` (defensive read). */
function exporterConfigOf(entry: unknown): Record<string, unknown> | undefined {
  const opts = (entry as { options?: { config?: unknown } } | undefined)?.options;
  const cfg = (opts as { config?: unknown } | undefined)?.config;
  return typeof cfg === "object" && cfg !== null ? (cfg as Record<string, unknown>) : undefined;
}

/** The exporter endpoint HOST (credentials/path stripped) from an entry's
 * `options.config.endpoint` (otel) or `options.config.host` (langfuse), or null
 * when neither is a parseable URL. Value-free: the hostname only. */
function exporterEndpointHost(entry: unknown): string | null {
  const cfg = exporterConfigOf(entry);
  if (!cfg) return null;
  const raw = typeof cfg["endpoint"] === "string" ? (cfg["endpoint"] as string) : typeof cfg["host"] === "string" ? (cfg["host"] as string) : undefined;
  return raw ? hostOf(raw) : null;
}

/** A header NAME that names a secret: a literal VALUE for it leaks a credential
 * into config and must be referenced by `headerEnv` instead (FX-C2). */
const SECRET_HEADER_NAME = /authorization|token|key|secret/i;

/**
 * Value-free config checks for the exporter plugins (FX-C2). The owner's rule:
 * secrets never live in config. So doctor FAILs the Langfuse plugin when its
 * config carries a literal `publicKey`/`secretKey` (use `publicKeyEnv`/
 * `secretKeyEnv`), and WARNs the OTel plugin when a `headers` entry names a
 * secret header with a literal value (use `headerEnv`). It reports only WHICH
 * key is wrong, NEVER the secret value. */
function checkExporterSecrets(id: string, entry: unknown, layer: ConfigLayer): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  const cfg = exporterConfigOf(entry);
  if (!cfg) return out;
  if (id === "@voidrift/plugin-langfuse-exporter") {
    if (cfg["publicKey"] !== undefined || cfg["secretKey"] !== undefined) {
      out.push(
        failF(
          `plugins.secrets.${id}`,
          `plugin "${id}" config carries a literal publicKey/secretKey (secrets must not live in config)`,
          `remove publicKey/secretKey and set publicKeyEnv/secretKeyEnv (the names of the env vars holding the keys)`,
          { layer },
        ),
      );
    }
  }
  if (id === "@voidrift/plugin-otel-exporter") {
    const headers = cfg["headers"];
    if (typeof headers === "object" && headers !== null) {
      for (const name of Object.keys(headers as object)) {
        if (SECRET_HEADER_NAME.test(name)) {
          out.push(
            warnF(
              `plugins.secrets.${id}.${name}`,
              `plugin "${id}" header "${name}" has a literal value that looks like a secret`,
              `move it to headerEnv (e.g. headerEnv: { "${name}": "OTEL_AUTH_HEADER" }) so the value is read from the environment`,
              { layer },
            ),
          );
        }
      }
    }
  }
  return out;
}

function checkPlugins(ctx: Ctx): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  const layers = ctx.deps.config.pluginLayers();
  const all: { id: string; layer: ConfigLayer; entry: unknown }[] = [];
  for (const layer of ["managed", "global", "project", "session"] as ConfigLayer[]) {
    for (const [id, entry] of Object.entries(layers[layer] ?? {})) all.push({ id, layer, entry });
  }
  if (all.length === 0) {
    out.push(okF("plugins.none", "no plugin configured"));
    return out;
  }
  for (const { id, layer, entry } of all) {
    if (layer === "project") {
      out.push(
        warnF(
          `plugins.project.${id}`,
          `plugin "${id}" is enabled from the PROJECT layer (runs in-process as trusted code); license and peer version are checked when the plugin loads`,
          `move "${id}" to the global config if you trust it, or remove it from the project config`,
          { layer, file: ctx.deps.config.paths().project.path },
        ),
      );
    } else {
      out.push(okF(`plugins.${id}`, `plugin "${id}" declared in the ${layer} layer; license and peer version are checked when the plugin loads`, { layer }));
    }
    // §12.4 visibility — a first-party plugin that cannot work without options is
    // flagged (value-free) when enabled with none: the exporters silently drop
    // every span and retrieval indexes nothing otherwise.
    const info = pluginEntryInfo(entry);
    if (info.enabled && !info.hasOptions && PLUGINS_REQUIRING_OPTIONS.has(id)) {
      out.push(
        warnF(
          `plugins.options.${id}`,
          `plugin "${id}" is enabled but has no options configured`,
          `add an "options" object to the plugin entry (e.g. options.config.endpoint) so it can do its job`,
          { layer },
        ),
      );
    }
    // FX-C2 — a secret in exporter config is a config error (Langfuse keys) or a
    // warning (OTel secret-named header literal); value-free.
    out.push(...checkExporterSecrets(id, entry, layer));
    // security audit (LOW) — VISIBILITY: an exporter endpoint/host set by the
    // PROJECT or SESSION layer sends MASKED telemetry to a host a repo config
    // chose. Mirror the model-endpoint warn (host only, names the file).
    if (layer === "project" || layer === "session") {
      const host = exporterEndpointHost(entry);
      if (host) {
        const where = layer === "session" ? "the session overrides" : ctx.deps.config.paths().project.path;
        out.push(
          warnF(
            `plugins.endpoint.${id}`,
            `exporter '${id}' endpoint ${host} comes from ${where}; masked telemetry is sent there`,
            "check that you trust this project",
            { layer, file: ctx.deps.config.paths().project.path },
          ),
        );
      }
    }
  }
  return out;
}

// ── SKILLS and PROMPTS ────────────────────────────────────────────────────────
function checkSkillsPrompts(ctx: Ctx): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  const skills = ctx.deps.skills();
  for (const s of skills) {
    out.push(
      s.valid
        ? okF(`skills.${s.name}`, `skill "${s.name}" has a valid SKILL.md`)
        : failF(`skills.${s.name}`, `skill "${s.name}" has no valid SKILL.md`, `add a valid SKILL.md to ${s.dir}`),
    );
  }
  // A seeded skill (§12.1) that is MISSING entirely — advisory, restorable with
  // `voidrift init`, so reported as `warn` (same severity as a missing seeded
  // agent), not a failure (a drifted seeded skill is reported under DRIFT).
  const present = new Set(skills.map((s) => s.name));
  for (const name of SEED_SKILLS) {
    if (!present.has(name)) {
      out.push(
        warnF(`skills.seeded-missing.${name}`, `seeded skill "${name}" is missing`, "voidrift init", {
          file: `${ctx.deps.paths.configDir}/skills/${name}/SKILL.md`,
        }),
      );
    }
  }
  // Agent prompts: discovery enforced presence; report each as readable.
  for (const d of ctx.deps.agents.definitions) {
    if (d.systemPrompt && d.systemPrompt.trim() !== "") {
      out.push(okF(`prompts.${d.name}`, `agent "${d.name}" prompt is present`));
    }
  }
  if (out.length === 0) out.push(okF("skills-prompts.none", "no skill configured; agent prompts are present"));
  return out;
}

// ── STORAGE ─────────────────────────────────────────────────────────────────
async function checkStorage(ctx: Ctx): Promise<DoctorFinding[]> {
  const out: DoctorFinding[] = [];
  const { configDir, configFile, sessionsDir, journalDir } = ctx.deps.paths;
  const st = ctx.deps.storage;

  // A symlinked config FILE is a fail (it could redirect a write).
  if (await st.isSymlink(configFile)) {
    out.push(failF("storage.symlink", `config file ${configFile} is a symbolic link`, `replace the symlink at ${configFile} with a real file`, { file: configFile }));
  }

  // Config dir mode 0700.
  const dirMode = await st.modeOf(configDir);
  if (dirMode !== null && (dirMode & 0o777) !== 0o700) {
    out.push(warnF("storage.dir-mode", `config dir ${configDir} mode is ${modeStr(dirMode)} (expected 0700)`, `chmod 700 ${configDir}`, { file: configDir }));
  } else if (dirMode !== null) {
    out.push(okF("storage.dir-mode", `config dir ${configDir} is 0700`));
  }

  // Config file mode 0600.
  const fileMode = await st.modeOf(configFile);
  if (fileMode !== null && (fileMode & 0o777) !== 0o600) {
    out.push(warnF("storage.file-mode", `config file ${configFile} mode is ${modeStr(fileMode)} (expected 0600)`, `chmod 600 ${configFile}`, { file: configFile }));
  } else if (fileMode !== null) {
    out.push(okF("storage.file-mode", `config file ${configFile} is 0600`));
  }

  // Free space ≥ 100 MB.
  const free = await st.freeBytes(configDir);
  if (free !== null && free < MIN_FREE_BYTES) {
    out.push(failF("storage.space", `only ${Math.round(free / 1024 / 1024)} MB free on ${configDir}`, `free disk space on the volume holding ${configDir} (need ≥ 100 MB)`, { file: configDir }));
  } else if (free !== null) {
    out.push(okF("storage.space", `${Math.round(free / 1024 / 1024)} MB free on ${configDir}`));
  }

  // Sessions + journal dirs creatable-or-existing.
  for (const [id, dir] of [["sessions", sessionsDir], ["journal", journalDir]] as const) {
    const usable = await st.dirUsable(dir);
    out.push(
      usable
        ? okF(`storage.${id}`, `${id} directory ${dir} is usable`)
        : failF(`storage.${id}`, `${id} directory ${dir} cannot be created`, `ensure ${dir} (or its parent) is writable`, { file: dir }),
    );
  }

  // The workspace `.voidrift` state dir (0700) and `checkpoint.db` (0600):
  // VoidRift creates these owner-only; a looser mode leaks session/checkpoint
  // content (security-audit S2). Only reported when the path exists.
  const workspaceRoot = ctx.deps.paths.workspaceRoot;
  const stateDir = `${workspaceRoot}/.voidrift`;
  const stateDirMode = await st.modeOf(stateDir);
  if (stateDirMode !== null && (stateDirMode & 0o777) !== 0o700) {
    out.push(warnF("storage.state-dir-mode", `state dir ${stateDir} mode is ${modeStr(stateDirMode)} (expected 0700)`, `chmod 700 ${stateDir}`, { file: stateDir }));
  } else if (stateDirMode !== null) {
    out.push(okF("storage.state-dir-mode", `state dir ${stateDir} is 0700`));
  }
  const dbPath = `${stateDir}/checkpoint.db`;
  const dbMode = await st.modeOf(dbPath);
  if (dbMode !== null && (dbMode & 0o777) !== 0o600) {
    out.push(warnF("storage.checkpoint-mode", `checkpoint db ${dbPath} mode is ${modeStr(dbMode)} (expected 0600)`, `chmod 600 ${dbPath}`, { file: dbPath }));
  } else if (dbMode !== null) {
    out.push(okF("storage.checkpoint-mode", `checkpoint db ${dbPath} is 0600`));
  }

  // The workspace `.git/config` executable-capable keys: a cloned/untrusted
  // repo can ship keys git runs with the user's privileges (fsmonitor, pager,
  // sshCommand, diff.external, filter drivers, …). VoidRift neutralises them for
  // its own git operations, but the user should review the file (security-audit
  // S2). Value-free: names the key classes only.
  const execKeys = await st.gitConfigScan(workspaceRoot);
  if (execKeys.length > 0) {
    out.push(
      warnF(
        "storage.git-config-exec",
        `the workspace .git/config defines executable-capable keys (${execKeys.join(", ")})`,
        "review .git/config",
        { file: `${workspaceRoot}/.git/config` },
      ),
    );
  }

  // The workspace `.voidrift/` state dir must be in `.gitignore` when the
  // workspace is a git repo (core-blueprint §13.9.2). Doctor checks this by
  // running `git check-ignore -q -- .voidrift/` through the hardened runner
  // (exit 0 = ignored ok, exit 1 = not ignored warn, 128+ = not a repo or error
  // = no finding). Lists existing folders under `.voidrift/` for the warning.
  if (st.checkIgnore) {
    const isRepo = st.isGitRepo ? await st.isGitRepo(workspaceRoot) : false;
    if (isRepo) {
      const ignored = await st.checkIgnore(workspaceRoot);
      if (!ignored) {
        // List which folders actually exist under .voidrift
        const voidriftDir = `${workspaceRoot}/.voidrift`;
        const existingFolders = await st.listDirs(voidriftDir);
        // Add known folder names that might not exist yet for the message
        const knownFolders = ["cache", "sessions", "journal", "logs"];
        const allFolders = new Set(existingFolders);
        for (const name of knownFolders) allFolders.add(name);
        // Also check for plugin dirs
        const pluginsDir = `${voidriftDir}/plugins`;
        try {
          const pluginDirs = await st.listDirs(pluginsDir);
          for (const dir of pluginDirs) allFolders.add(`plugins/${dir}`);
        } catch {
          // plugins dir doesn't exist yet
        }
        const folderList = Array.from(allFolders)
          .filter((f) => existingFolders.includes(f) || knownFolders.includes(f))
          .sort()
          .join(", ");
        out.push(
          warnF(
            "storage.gitignore",
            `workspace .voidrift/ directory (${folderList}) is not matched by .gitignore`,
            "add `.voidrift/` to `.gitignore`",
            { file: `${workspaceRoot}/.gitignore` },
          ),
        );
      }
    }
  }

  // The durable registry dir `<config dir>/registry/<workspace key>` (§12.5):
  // it is owner-only (0700) and holds one JSON file per plugin. Doctor reports
  // its mode and a value-free count of stored routines and plans (names only).
  const registryDir = ctx.deps.paths.registryDir;
  if (registryDir) {
    const regMode = await st.modeOf(registryDir);
    if (regMode !== null && (regMode & 0o777) !== 0o700) {
      out.push(
        warnF(
          "storage.registry-dir-mode",
          `registry dir ${registryDir} mode is ${modeStr(regMode)} (expected 0700)`,
          `chmod 700 ${registryDir}`,
          { file: registryDir },
        ),
      );
    } else if (regMode !== null) {
      out.push(okF("storage.registry-dir-mode", `registry dir ${registryDir} is 0700`));
    }
    if (st.registryCounts) {
      const counts = await st.registryCounts(registryDir);
      out.push(
        okF(
          "storage.registry-counts",
          `${counts.routines.length} saved routine(s), ${counts.plans.length} saved plan(s) in the durable registry`,
        ),
      );
    }
  }

  if (out.every((f) => f.status === "ok") && out.length === 0) out.push(okF("storage.ok", "storage layout is healthy"));
  return out;
}

function modeStr(mode: number): string {
  return "0" + (mode & 0o777).toString(8).padStart(3, "0");
}

/** The narrowest layer whose OWN document holds a scalar config `key`, and its
 * file — for a per-key override setting (e.g. `snapshotCount`). `default` when
 * no layer's own document sets it (the schema default is in effect). */
function scalarKeyLayer(
  ctx: Ctx,
  key: string,
): { layer: ConfigLayer | "default"; file?: string } {
  const paths = ctx.deps.config.paths();
  for (const layer of ["session", "project", "global", "managed"] as ConfigLayer[]) {
    const v = ctx.deps.config.layerKey(layer, key);
    if (v !== null && v !== undefined) {
      const p = paths[layer];
      return p?.path ? { layer, file: p.path } : { layer };
    }
  }
  return { layer: "default" };
}

// ── ROLLBACK (§10.12) ──────────────────────────────────────────────────────
/** 256 MiB — the cache snapshot blob budget (§10.12); doctor WARNS at it. */
const ROLLBACK_CACHE_WARN_BYTES = 256 * 1024 * 1024;

async function checkRollback(ctx: Ctx): Promise<DoctorFinding[]> {
  const out: DoctorFinding[] = [];
  const st = ctx.deps.storage;
  const workspaceRoot = ctx.deps.paths.workspaceRoot;
  const snapshotCount = Number(ctx.deps.config.get().snapshotCount ?? 50);
  const prov = scalarKeyLayer(ctx, "snapshotCount");
  const provExtra: Partial<DoctorFinding> = {
    layer: prov.layer,
    ...(prov.file !== undefined ? { file: prov.file } : {}),
  };

  // snapshotCount 0 → rollback off (a warn), and nothing else to check.
  if (snapshotCount <= 0) {
    out.push(
      warnF(
        "rollback.off",
        "rollback is off (snapshotCount 0)",
        'set "snapshotCount" to a number from 1 to 500',
        provExtra,
      ),
    );
    return out;
  }

  // The active method: git when the workspace is a git repo (and git runs
  // through the hardened runner), else cache.
  const isRepo = st.isGitRepo ? await st.isGitRepo(workspaceRoot) : false;
  const method = isRepo ? "git" : "cache";
  out.push(okF("rollback.method", `rollback method is ${method} (snapshotCount ${snapshotCount})`, provExtra));

  // Recorded moves per session (from each session's timeline.json).
  const snapshotsDir = `${workspaceRoot}/.voidrift/cache/snapshots`;
  const perSession = st.movesPerSession ? await st.movesPerSession(snapshotsDir) : [];
  const totalMoves = perSession.reduce((n, s) => n + s.moves, 0);
  out.push(
    okF("rollback.moves", `${totalMoves} recorded move(s) across ${perSession.length} session(s)`),
  );

  // Cache snapshot dir size; WARN over the 256 MiB budget.
  const cacheBytes = st.dirSizeBytes ? await st.dirSizeBytes(snapshotsDir) : 0;
  const cacheMiB = Math.round(cacheBytes / 1024 / 1024);
  if (cacheBytes > ROLLBACK_CACHE_WARN_BYTES) {
    out.push(
      warnF(
        "rollback.cache-size",
        `snapshot cache ${snapshotsDir} is ${cacheMiB} MiB (over 256 MiB)`,
        "voidrift doctor does not delete; remove old sessions' snapshots with /goto or delete the folder",
        { file: snapshotsDir },
      ),
    );
  } else {
    out.push(okF("rollback.cache-size", `snapshot cache is ${cacheMiB} MiB`));
  }

  // Private git refs count; WARN when stale refs exceed 5x snapshotCount (left
  // by dead sessions). Skip entirely when not a repo.
  if (isRepo) {
    const refs = st.countVoidriftRefs ? await st.countVoidriftRefs(workspaceRoot) : 0;
    if (refs > 5 * snapshotCount) {
      out.push(
        warnF(
          "rollback.stale-refs",
          `${refs} private refs under refs/voidrift/* (over 5x snapshotCount ${snapshotCount} — stale from dead sessions)`,
          "voidrift doctor does not delete; remove old sessions' snapshots with /goto or delete the folder",
        ),
      );
    } else {
      out.push(okF("rollback.refs", `${refs} private ref(s) under refs/voidrift/*`));
    }
  }

  // The cache snapshot dir and its files must be owner-only (0700/0600).
  const dirMode = await st.modeOf(snapshotsDir);
  if (dirMode !== null && (dirMode & 0o777) !== 0o700) {
    out.push(
      warnF(
        "rollback.cache-dir-mode",
        `snapshot cache dir ${snapshotsDir} mode is ${modeStr(dirMode)} (expected 0700)`,
        `chmod 700 ${snapshotsDir}`,
        { file: snapshotsDir },
      ),
    );
  } else if (dirMode !== null) {
    out.push(okF("rollback.cache-dir-mode", `snapshot cache dir ${snapshotsDir} is 0700`));
  }

  // §10.12 — the per-install integrity key `rollback.key` under the GLOBAL
  // config dir binds rollback history to this install (HMAC). It must be
  // owner-only (0600) and present; absence means history is not yet bound (it is
  // created lazily on first use) or the global dir is read-only (degraded to a
  // per-process key — history is not trusted across restarts).
  const keyPath = `${ctx.deps.paths.configDir}/rollback.key`;
  const keyMode = await st.modeOf(keyPath);
  if (keyMode === null && totalMoves === 0) {
    // Nothing recorded yet, so nothing to protect: the key is created on first capture.
    out.push(okF("rollback.key", "rollback integrity key will be created on first use"));
  } else if (keyMode === null) {
    out.push(
      warnF(
        "rollback.key",
        "rollback integrity key not present (created on first capture; if the global config dir is read-only, history is not trusted across restarts)",
        "ensure the global config dir is writable so rollback.key can be created",
        { file: keyPath },
      ),
    );
  } else if ((keyMode & 0o777) !== 0o600) {
    out.push(
      warnF(
        "rollback.key-mode",
        `rollback integrity key ${keyPath} mode is ${modeStr(keyMode)} (expected 0600)`,
        `chmod 600 ${keyPath}`,
        { file: keyPath },
      ),
    );
  } else {
    out.push(okF("rollback.key", "rollback integrity key is present and 0600"));
  }

  // §10.12 — planted/untrusted session state: a session timeline whose HMAC does
  // not verify against this install's key is ignored. The probe reports those
  // session ids (value-free); each is a WARN.
  const untrusted = st.untrustedRollbackSessions ? await st.untrustedRollbackSessions(snapshotsDir) : [];
  for (const sid of untrusted) {
    out.push(
      warnF(
        `rollback.untrusted.${sid}`,
        `rollback history for session ${sid} was not created by this install and was ignored`,
        "remove the planted .voidrift/cache/snapshots/<session> directory if it came from a cloned repo",
        { file: `${snapshotsDir}/${sid}` },
      ),
    );
  }

  return out;
}

// ── LIMITS (§13.11) ───────────────────────────────────────────────────────────
/**
 * The `limits` group (§13.11): one `ok` summary per area (the number of keys and
 * how many a layer set), plus a WARN for every project/session attempt to RAISE
 * a `safety` limit (the resolver ignores it and records the attempt, naming the
 * key, layer and file). Read-only: resolves the layered `limits` the same way
 * the runtime capability does. Prints no value a secret could hide in (numeric
 * limits only).
 */
/**
 * Per core-blueprint.md §13.9.2 LIMITS: every effective limit with its value,
 * action, class, and source layer; warn on download- or network-class limits
 * set to `action: "warn"`.
 */
function checkLimits(ctx: Ctx): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  const resolved = resolveLimits(ctx.deps.config.limitLayers());

  // One ok line per area: how many keys it has and how many a layer customized.
  for (const area of limitAreas()) {
    const keys = LIMITS.filter((l) => l.area === area);
    const set = keys.filter((l) => {
      const r = resolved.values.get(l.key);
      return r && r.source !== "default";
    });
    out.push(
      okF(
        `limits.${area}`,
        set.length === 0
          ? `${area}: ${keys.length} limit(s), all at defaults`
          : `${area}: ${keys.length} limit(s), ${set.length} customized`,
      ),
    );
  }

  // A project/session RAISE of a safety limit, or LOWER of an integrity limit,
  // is ignored → WARN naming key+file. The resolver's `message` already carries
  // the class-aware explanation; the doctor summarises it by class.
  for (const w of resolved.warnings) {
    const spec = getLimitSpec(w.key);
    const cls = spec?.class === "integrity" ? "integrity" : "safety";
    const verb = cls === "integrity" ? "lower" : "raise";
    const direction = cls === "integrity" ? "above the effective value" : "below the effective value";
    const rule = cls === "integrity" ? "integrity limits may only be raised" : "safety limits may only be tightened";
    out.push(
      warnF(
        `limits.${cls}-${verb}.${w.key}`,
        `${w.key} is a ${cls} limit; the ${w.layer} layer tried to ${verb} it (ignored)`,
        `remove limits.${w.key} from the ${w.layer} layer, or set it ${direction} (${rule} by a project/session layer)`,
        { layer: w.layer, ...(w.path ? { file: w.path } : {}) },
      ),
    );
  }

  // Download-/network-class limits set to action: warn need explicit confirmation.
  // Per §13.9.2: warn on tools.webFetch*, tools.webSearch*, plugins.searchMaxBytes,
  // plugins.installMaxBytes, or tools.imageMaxBytes with action warn.
  const downloadNetworkKeys = new Set([
    "tools.webFetchBodyMaxBytes",
    "tools.webFetchMaxHops",
    "tools.webSearchBodyMaxBytes",
    "tools.imageMaxBytes",
    "plugins.searchMaxBytes",
    "plugins.installMaxBytes",
  ]);
  for (const [key, resolved_entry] of resolved.values) {
    if (downloadNetworkKeys.has(key) && resolved_entry.action === "warn" && resolved_entry.source !== "default") {
      out.push(
        warnF(
          `limits.action-warn.${key}`,
          `${key} is set to action: warn (requires explicit confirmation)`,
          `set action: deny in the appropriate config layer, or remove the limit setting`,
          { layer: resolved_entry.source, ...(resolved_entry.sourcePath ? { file: resolved_entry.sourcePath } : {}) },
        ),
      );
    }
  }

  // Report each customized limit with value/action/class/source.
  for (const [key, resolved_entry] of resolved.values) {
    if (resolved_entry.source !== "default") {
      const spec = getLimitSpec(key);
      const className = spec?.class || "unknown";
      out.push(
        okF(
          `limits.customized.${key}`,
          `${key}: value=${resolved_entry.value}, action=${resolved_entry.action}, class=${className}, source=${resolved_entry.source}`,
        ),
      );
    }
  }

  return out;
}

// ── DRIFT ─────────────────────────────────────────────────────────────────────
async function checkDrift(ctx: Ctx): Promise<DoctorFinding[]> {
  const out: DoctorFinding[] = [];
  const st = ctx.deps.storage;
  const { configFile, configDir, seedAgentsDir } = ctx.deps.paths;

  // config.json drift: compare the on-disk global config against the seed doc.
  // Drift is reported only for the seeded KEYS (a user may add keys freely); a
  // changed seeded value is drift.
  const onDisk = await st.readFile(configFile);
  if (onDisk !== null) {
    try {
      const parsed = JSON.parse(onDisk) as Record<string, unknown>;
      const seed = seedConfigDocument();
      // Compare the stable seeded scalars that signal a reset is warranted.
      for (const key of ["webSearch", "mutationLogLevel"] as const) {
        if (key in parsed && JSON.stringify(parsed[key]) !== JSON.stringify(seed[key])) {
          out.push(warnF(`drift.config.${key}`, `config "${key}" differs from the shipped default`, "voidrift init --reset config", { file: configFile }));
        }
      }
    } catch {
      /* a broken config is already a CONFIG fail */
    }
  }

  // Missing seeded allow rules are reported ONCE in the ALLOW LIST group (not
  // repeated here). DRIFT still reports agent/prompt/config-value drift below.

  // Load the known-shipped manifest (§13.9.1) to tell an OUT OF DATE (unmodified
  // older) default — fix `voidrift init --update` — from a CUSTOMIZED one — fix
  // `init --reset <name>`. The manifest sits beside the seeded dirs.
  const manifest = await loadShippedManifest(st, seedAgentsDir);

  // Agent drift: each seeded agent's agent.json/prompt.md differing from the
  // shipped template → warn. Classified against the manifest (§13.9.2).
  const agentDirs = await st.listDirs(`${configDir}/agents`);
  for (const name of agentDirs) {
    const tmplJson = await st.readFile(`${seedAgentsDir}/${name}/agent.json`);
    if (tmplJson === null) continue; // not a seeded agent (user's own) — no drift
    const diskJson = await st.readFile(`${configDir}/agents/${name}/agent.json`);
    const tmplPrompt = await st.readFile(`${seedAgentsDir}/${name}/prompt.md`);
    const diskPrompt = await st.readFile(`${configDir}/agents/${name}/prompt.md`);
    const jsonDrift = diskJson !== null && diskJson !== tmplJson;
    const promptDrift = diskPrompt !== null && tmplPrompt !== null && diskPrompt !== tmplPrompt;
    if (!jsonDrift && !promptDrift) continue;
    // An agent is OUT OF DATE only when BOTH differing files are unmodified
    // older defaults (stale); any customization makes the whole agent customized.
    const stale =
      (!jsonDrift || classifyAgainstManifest(manifest, `agents/${name}/agent.json`, diskJson!) === "stale") &&
      (!promptDrift || classifyAgainstManifest(manifest, `agents/${name}/prompt.md`, diskPrompt!) === "stale");
    out.push(driftFinding(`agent.${name}`, "agent", name, stale, `${configDir}/agents/${name}/agent.json`));
  }

  // Seeded skill drift: each seeded skill's SKILL.md differing → warn,
  // classified against the manifest (§12.1, §13.9.2).
  for (const name of SEED_SKILLS) {
    const tmpl = await st.readFile(`${ctx.deps.paths.seedSkillsDir}/${name}/SKILL.md`);
    if (tmpl === null) continue;
    const disk = await st.readFile(`${configDir}/skills/${name}/SKILL.md`);
    if (disk === null || disk === tmpl) continue;
    const stale = classifyAgainstManifest(manifest, `skills/${name}/SKILL.md`, disk) === "stale";
    out.push(driftFinding(`skill.${name}`, "skill", name, stale, `${configDir}/skills/${name}/SKILL.md`));
  }

  if (out.length === 0) out.push(okF("drift.ok", "no drift from the shipped defaults"));
  return out;
}

/** Load the known-shipped manifest beside the seeded dirs (§13.9.1). The
 * manifest is `<seedDir>/shipped-hashes.json`, and `seedAgentsDir` is
 * `<seedDir>/agents`. A missing/broken manifest is empty (everything then reads
 * `customized` — fail safe: doctor hints `init --reset`, never a bad refresh). */
async function loadShippedManifest(st: StorageProbe, seedAgentsDir: string): Promise<ShippedManifest> {
  const seedDir = seedAgentsDir.replace(/[\\/]+$/, "").replace(/[\\/]agents$/, "");
  const raw = await st.readFile(`${seedDir}/shipped-hashes.json`);
  if (raw === null) return { version: 0, entries: {} };
  try {
    const doc = JSON.parse(raw) as ShippedManifest;
    return doc && typeof doc === "object" && doc.entries ? doc : { version: 0, entries: {} };
  } catch {
    return { version: 0, entries: {} };
  }
}

/** Build the DRIFT finding for a seeded agent/skill, worded per §13.9.2: an OUT
 * OF DATE (unmodified) default carries the fix `voidrift init --update`; a
 * CUSTOMIZED one carries `voidrift init --reset <name>`. */
function driftFinding(
  idSuffix: string,
  kind: "agent" | "skill",
  name: string,
  stale: boolean,
  file: string,
): DoctorFinding {
  const message = stale
    ? `seeded ${kind} "${name}" is out of date (unmodified older default)`
    : `seeded ${kind} "${name}" differs from the shipped default (customized)`;
  const fix = stale ? "voidrift init --update" : `voidrift init --reset ${name}`;
  return warnF(`drift.${idSuffix}`, message, fix, { file });
}
