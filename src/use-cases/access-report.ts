/**
 * The effective-permissions report (`AccessReport`) — the data behind `/access`
 * and `voidrift access` (cli-blueprint.md §7.4; core-blueprint.md §3.1, §9.0).
 *
 * A pure builder over an already-resolved config cascade and the discovered
 * agents. It answers "what can the agent do right now?" as STRUCTURED, SECRET-
 * FREE data: every allow-list entry, rule, agent, worker, plugin, and setting is
 * tagged with the LAYER and FILE it resolved from (global, project, session,
 * managed; seeded rules carry the `default` marker). The never list and the
 * always-asks plain-words lines come from the ONE source in code (never-list.ts
 * and `ALWAYS_ASK_LINES` below), not restated here.
 *
 * SECRETS NEVER APPEAR: patterns and command text are shown AS STORED (already
 * masked by the core's approval path, §10.10); env vars are named, never read;
 * URLs are shown without any `user:pass@` userinfo. The builder reads only the
 * config capability's read accessors and the agent definitions — it opens no
 * network and starts no session, so a host can build it WITHOUT a model.
 */
import type { ConfigLayer } from "../config/schema.js";
import type { ConfigCapability } from "../entities/config-capability.js";
import type { AgentDefinition } from "../entities/subagents.js";
import { deriveAgentClass } from "../entities/subagents.js";
import { DEFAULT_AGENT_ORDER } from "../entities/agent-manifest.js";

/** The plain-words always-ask lines (§7.4, §9.0/§9.3). ONE source in code so
 * `/access`, `voidrift access`, and the docs-sync later all read the SAME text.
 * These describe the force-ask classes a WILDCARD allow can never cover — only
 * an exact-command or host/CIDR allow lifts one. */
export const ALWAYS_ASK_LINES: readonly string[] = Object.freeze([
  "dangerous-but-ordinary commands: rm -rf, git push --force,",
  "  git reset --hard, git clean -f, sudo, terraform destroy, …",
  "trust-changing: a fetch/command to a private/loopback/link-local host,",
  "  a plugin install, an MCP trust change",
  "to allow one: add an exact-command allow entry, or a host/CIDR allow entry;",
  "  a wildcard allow never covers these",
]);

/** The display tag for a layer in parentheses (`global`, `project`, …). A
 * `default` marker tags a seeded rule that is present because `init` wrote it. */
export type LayerTag = ConfigLayer | "builtin" | "default";

/** One allow-list entry, exactly as configured (§7.4 "Runs without asking"). */
export interface AccessAllowEntry {
  ruleId: string;
  tool: string;
  pattern?: string;
  exact?: boolean;
  cidr?: string;
  layer: LayerTag;
  file?: string;
}

/** A deny/ask rule or an exact/cidr allow the user added ("Your rules", §7.4). */
export interface AccessRule {
  ruleId: string;
  tool: string;
  pattern?: string;
  decision: "allow" | "deny" | "ask";
  exact?: boolean;
  cidr?: string;
  layer: LayerTag;
  file?: string;
}

/** One agent row (top-level or worker) with its source. */
export interface AccessAgent {
  name: string;
  kind: "top-level" | "worker";
  tools: string[];
  order?: number;
  unlisted?: "deny" | "ask" | "allow";
  confirm?: boolean;
  workers?: string[] | "all";
  source: "builtin" | ConfigLayer | "global" | "project";
  file?: string;
  /** A worker that holds a write-class tool is isolated when dispatched (§7.4). */
  mutates?: boolean;
}

/** One dispatchable worker under the active agent (§7.4). */
export interface AccessWorker {
  name: string;
  tools: string[];
  mutates: boolean;
  file?: string;
}

export interface AccessNeverEntry {
  id: string;
  description: string;
  unlocked: boolean;
}

/** A model endpoint redirected (or key-env-set) by a project/session layer
 * (security-audit S3). Host and env-var NAME only — never a credential value. */
export interface AccessModelEndpoint {
  name: string;
  host: string | undefined;
  apiKeyEnv: string | undefined;
  /** The layer that set the endpoint/key env (project or session). */
  layer: "project" | "session";
}

export interface AccessUnlockEntry {
  id: string;
  layer: LayerTag;
  file?: string;
}

/** One configured plugin in the access report (cli §7.4 spirit). Value-free:
 * the id, the narrowest layer + file it was enabled from, whether an `options`
 * object was provided (yes/no — never its content), and the tool NAMES it
 * contributes when a live registry is available (empty/unknown in a config-only
 * `voidrift access` run that loads no plugin). */
export interface AccessPlugin {
  id: string;
  enabled: boolean;
  layer: LayerTag;
  file?: string;
  hasOptions: boolean;
  /** Contributed tool names, when known from a live registry; empty otherwise. */
  tools: string[];
  /** True when the tool list is authoritative (a live registry supplied it);
   * false in a config-only run where contributions are not loaded. */
  toolsKnown: boolean;
}

/** The rollback line of the report (§7.4): the active method and tracked-move
 * count, or `off` when `snapshotCount` is 0, with the layer and file of
 * `snapshotCount`. */
export interface AccessRollback {
  /** `git` when the workspace is a git repo, `cache` otherwise, `off` when
   * `snapshotCount` is 0. */
  method: "git" | "cache" | "off";
  /** The configured `snapshotCount` (tracked-move count). */
  snapshotCount: number;
  /** The layer and file `snapshotCount` resolved from. */
  layer: LayerTag;
  file?: string;
}

/** The structured, secret-free effective-permissions report (§7.4). */
export interface AccessReport {
  activeAgent: string;
  agents: { topLevel: AccessAgent[]; worker: AccessAgent[] };
  allowList: { tools: AccessAllowEntry[]; commands: AccessAllowEntry[] };
  /** The active agent's `unlisted` behaviour as a plain sentence. */
  unlistedBehaviour: string;
  /** True when a mutating tool runs WITHOUT asking under the active agent
   * (an `unlisted: allow` agent, or a write tool on the allow list). */
  mutatingRunsFreely: boolean;
  webSearch: { provider: string; note: string };
  /** Model endpoints whose baseUrl/apiKeyEnv a project/session layer set, so the
   * API key named by `apiKeyEnv` is posted to that host (security-audit S3).
   * Host and env-var NAME only; empty when no model is project-redirected. */
  models: AccessModelEndpoint[];
  neverList: AccessNeverEntry[];
  alwaysAsks: readonly string[];
  unlock: AccessUnlockEntry[];
  rules: AccessRule[];
  workers: AccessWorker[];
  /** Configured plugins, value-free (id, layer + file, options yes/no, tools). */
  plugins: AccessPlugin[];
  rollback: AccessRollback;
  notices: { rejections: AccessNotice[]; warnings: AccessNotice[] };
}

export interface AccessNotice {
  layer?: LayerTag;
  file?: string;
  message: string;
}

export interface AccessReportInput {
  config: ConfigCapability;
  /** The cascaded agent definitions (project > global > built-in `chat`). */
  agents: AgentDefinition[];
  /** The active top-level agent name (the session's active agent, or the agent
   * `voidrift access` selected by its flags). */
  activeAgent: string;
  /** True when the workspace is a git repository (so the `git` snapshot method
   * is active); false → `cache`. Supplied by the host (the pure builder does no
   * I/O). Defaults to false. §10.12/§7.4. */
  isGitRepo?: boolean;
  /** The tool NAMES each enabled plugin contributes, keyed by plugin id, when a
   * LIVE registry is available (the TUI `/access` path via the facade). Absent
   * in a config-only `voidrift access` run that loads no plugin — the report
   * then marks each plugin's tools as not-yet-known. Value-free: names only. */
  pluginTools?: Record<string, string[]>;
}

/** The layer (narrowest-wins) whose raw document holds a permission rule id, and
 * its file. A rule present only via a seeded default (its id is in no layer's
 * own document but it is in the resolved set) is tagged `default`. */
function ruleLayer(
  config: ConfigCapability,
  ruleId: string,
): { layer: LayerTag; file?: string } {
  const paths = config.paths();
  // Narrowest first so the project override of a global id resolves to project.
  for (const layer of ["session", "project", "global", "managed"] as ConfigLayer[]) {
    if (ruleId in config.layerPermissions(layer)) {
      const p = paths[layer];
      return p?.path ? { layer, file: p.path } : { layer };
    }
  }
  return { layer: "default" };
}

/** The narrowest layer whose OWN document sets a scalar config `key`, and its
 * file (a per-key override setting, e.g. `snapshotCount`). `default` when no
 * layer's own document sets it (the schema default is in effect). */
function scalarKeyLayer(config: ConfigCapability, key: string): { layer: LayerTag; file?: string } {
  const paths = config.paths();
  for (const layer of ["session", "project", "global", "managed"] as ConfigLayer[]) {
    const v = config.layerKey(layer, key);
    if (v !== null && v !== undefined) {
      const p = paths[layer];
      return p?.path ? { layer, file: p.path } : { layer };
    }
  }
  return { layer: "default" };
}

/** Build the structured report (pure). */
export function buildAccessReport(input: AccessReportInput): AccessReport {
  const { config, agents, activeAgent } = input;
  const cfg = config.get();
  const paths = config.paths();

  // ── Agents, grouped by kind. Top-level in ascending order. ──
  const topLevel: AccessAgent[] = [];
  const worker: AccessAgent[] = [];
  for (const d of agents) {
    const mutates = deriveAgentClass(d) === "write";
    const row: AccessAgent = {
      name: d.name,
      kind: d.kind === "top-level" ? "top-level" : "worker",
      tools: d.tools.slice(),
      source: d.source ?? "project",
      ...(d.filePath !== undefined ? { file: d.filePath } : {}),
    };
    if (row.kind === "top-level") {
      row.order = d.order ?? DEFAULT_AGENT_ORDER;
      if (d.unlisted !== undefined) row.unlisted = d.unlisted;
      if (d.confirm !== undefined) row.confirm = d.confirm;
      if (d.workers !== undefined) row.workers = d.workers;
      topLevel.push(row);
    } else {
      row.mutates = mutates;
      worker.push(row);
    }
  }
  topLevel.sort((a, b) => (a.order ?? DEFAULT_AGENT_ORDER) - (b.order ?? DEFAULT_AGENT_ORDER) || a.name.localeCompare(b.name));
  worker.sort((a, b) => a.name.localeCompare(b.name));

  // ── Allow list: tool allows and execute_command allows, exactly as stored. ──
  const perms = cfg.permissions ?? {};
  const tools: AccessAllowEntry[] = [];
  const commands: AccessAllowEntry[] = [];
  const rules: AccessRule[] = [];
  for (const [ruleId, rule] of Object.entries(perms)) {
    const { layer, file } = ruleLayer(config, ruleId);
    const base = {
      ruleId,
      tool: rule.tool,
      ...(rule.pattern !== undefined ? { pattern: rule.pattern } : {}),
      ...(rule.exact !== undefined ? { exact: rule.exact } : {}),
      ...(rule.cidr !== undefined ? { cidr: rule.cidr } : {}),
      layer,
      ...(file !== undefined ? { file } : {}),
    };
    if (rule.decision === "allow") {
      if (rule.tool === "execute_command") commands.push(base);
      else tools.push(base);
      // An exact/cidr allow is ALSO a "Your rules" entry (the user added it to
      // lift a force-ask) — a wildcard allow is not.
      if (rule.exact === true || rule.cidr !== undefined) {
        rules.push({ ...base, decision: "allow" });
      }
    } else {
      rules.push({ ...base, decision: rule.decision });
    }
  }
  // Deny rules above allow rules (§7.4).
  rules.sort((a, b) => {
    const rank = (d: string): number => (d === "deny" ? 0 : d === "ask" ? 1 : 2);
    return rank(a.decision) - rank(b.decision) || a.ruleId.localeCompare(b.ruleId);
  });

  // ── Active agent `unlisted` behaviour, plain sentence. ──
  const active = topLevel.find((a) => a.name === activeAgent);
  const unlisted = active?.unlisted ?? "ask";
  const unlistedBehaviour =
    unlisted === "deny" ? "are denied" : unlisted === "allow" ? "run without asking" : "ask first";
  // A mutating tool runs freely under this agent when it is `unlisted: allow`,
  // or a write tool sits on the allow list AND the agent holds it.
  const allowWriteTool = tools.some((t) => {
    const holds = active && (active.tools.includes("*") || active.tools.includes(t.tool));
    return holds && isWriteTool(t.tool);
  });
  const mutatingRunsFreely = unlisted === "allow" || allowWriteTool;

  // ── Web search. ──
  const ws = cfg.webSearch ?? { provider: "duckduckgo" };
  const provider = ws.provider ?? "duckduckgo";
  let note: string;
  if (ws.endpoint) {
    let host = "endpoint";
    try {
      host = new URL(ws.endpoint).hostname;
    } catch {
      /* keep the fallback label; never print the raw URL */
    }
    note = `(${host}) — your queries are sent there`;
  } else if (provider === "duckduckgo") {
    note = "(default) — your queries are sent there";
  } else {
    note = "— your queries are sent there";
  }

  // ── Model endpoints redirected by a project/session layer (security-audit
  // S3). Host and env-var NAME only. ──
  const models: AccessModelEndpoint[] = [];
  for (const p of config.modelEndpointProvenance()) {
    if (!p.fromProject) continue;
    const layer: "project" | "session" =
      p.baseUrlLayer === "session" || p.apiKeyEnvLayer === "session" ? "session" : "project";
    models.push({ name: p.name, host: p.host, apiKeyEnv: p.apiKeyEnv, layer });
  }

  // ── Never list (code, via the config view) and unlock entries. ──
  // `unlock` is honored only from global/managed (§13.10); `resolveWithProvenance`
  // already drops an ignored project/session `unlock` from `from`, so every id
  // it reports carries its honored layer and file.
  const neverList = config.neverList();
  const unlock: AccessUnlockEntry[] = [];
  const unlockProv = config.resolveWithProvenance("unlock");
  for (const el of unlockProv.value as string[]) {
    const layers = unlockProv.from[`string:${el}`] ?? [];
    // Narrowest honored layer wins the display (managed over global).
    const layer: ConfigLayer = layers.includes("managed") ? "managed" : "global";
    const p = paths[layer];
    unlock.push({ id: el, layer, ...(p?.path ? { file: p.path } : {}) });
  }

  // ── Workers dispatchable under the active agent. ──
  const workerDefs = agents.filter((d) => d.kind === "worker");
  const dispatchable = resolveDispatchable(active, workerDefs);
  const workers: AccessWorker[] = dispatchable.map((d) => ({
    name: d.name,
    tools: d.tools.slice(),
    mutates: deriveAgentClass(d) === "write",
    ...(d.filePath !== undefined ? { file: d.filePath } : {}),
  }));

  // ── Notices: rejected layers and ignored-key warnings. ──
  const rejections: AccessNotice[] = config.rejectedLayers().map((r) => ({
    layer: r.layer,
    file: r.path,
    message: `${r.layer} config at ${r.path} failed to validate and was set aside`,
  }));
  const warnings: AccessNotice[] = config.configWarnings().map((w) => ({
    layer: w.layer,
    file: w.path,
    message: w.message,
  }));

  // ── Configured plugins, value-free (cli §7.4 spirit). One row per enabled
  // entry, tagged with the narrowest layer + file it came from, whether an
  // `options` object was provided (yes/no), and the tool NAMES it contributes
  // when a live registry supplied them (empty + not-known in a config-only run). ──
  const plugins = buildPluginRows(config, input.pluginTools);

  // ── Rollback (§10.12/§7.4): the active method + tracked-move count, or off. ──
  const snapshotCount = Number(cfg.snapshotCount ?? 50);
  const scProv = scalarKeyLayer(config, "snapshotCount");
  const rollback: AccessRollback = {
    method: snapshotCount <= 0 ? "off" : input.isGitRepo ? "git" : "cache",
    snapshotCount,
    layer: scProv.layer,
    ...(scProv.file !== undefined ? { file: scProv.file } : {}),
  };

  return {
    activeAgent,
    agents: { topLevel, worker },
    allowList: { tools, commands },
    unlistedBehaviour,
    mutatingRunsFreely,
    webSearch: { provider, note },
    models,
    neverList,
    alwaysAsks: ALWAYS_ASK_LINES,
    unlock,
    rules,
    workers,
    plugins,
    rollback,
    notices: { rejections, warnings },
  };
}

/** Build the value-free plugin rows (cli §7.4 spirit). Reads only the config
 * layer records (the narrowest-wins layer + file each enabled plugin came from,
 * and whether an `options` object was supplied — never its content). Contributed
 * tool NAMES are filled only when a live registry supplied them via
 * `pluginTools`; a config-only run leaves them empty and `toolsKnown: false`. */
function buildPluginRows(
  config: ConfigCapability,
  pluginTools: Record<string, string[]> | undefined,
): AccessPlugin[] {
  const layers = config.pluginLayers();
  const paths = config.paths();
  // Narrowest-wins so a project override of a global id resolves to project.
  const order: ConfigLayer[] = ["session", "project", "global", "managed"];
  const seen = new Map<string, AccessPlugin>();
  for (const layer of order) {
    for (const [id, raw] of Object.entries(layers[layer] ?? {})) {
      if (seen.has(id)) continue; // a narrower layer already claimed this id
      const e = (raw ?? {}) as { enabled?: unknown; options?: unknown };
      const enabled = e.enabled !== false;
      const hasOptions =
        typeof e.options === "object" && e.options !== null && Object.keys(e.options as object).length > 0;
      const p = paths[layer];
      const tools = pluginTools?.[id];
      seen.set(id, {
        id,
        enabled,
        layer,
        ...(p?.path ? { file: p.path } : {}),
        hasOptions,
        tools: tools ? tools.slice() : [],
        toolsKnown: pluginTools !== undefined && tools !== undefined,
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The write-class built-in tool names (§9). A conservative list used only to * decide the "a mutating tool runs without asking" note; the authoritative
 * class is the registry's `readOnly` flag, surfaced to the host via the agent
 * class already. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(["edit_file", "write_file", "execute_command", "apply_patch"]);
function isWriteTool(tool: string): boolean {
  return WRITE_TOOLS.has(tool);
}

/** The workers a top-level agent may dispatch: its `workers` allow list, or ALL
 * workers when `"all"` or undefined (the built-in `chat` default). */
function resolveDispatchable(
  active: AccessAgent | undefined,
  workerDefs: AgentDefinition[],
): AgentDefinition[] {
  if (!active) return [];
  const w = active.workers;
  if (w === undefined || w === "all") return workerDefs.slice();
  const allow = new Set(w);
  return workerDefs.filter((d) => allow.has(d.name));
}
