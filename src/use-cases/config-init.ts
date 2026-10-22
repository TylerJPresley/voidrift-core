/**
 * `config.init` — seed and repair the installation (core-blueprint.md §13.9.1).
 *
 * The first-run bootstrap (§13.8) made repeatable, like `git init`: running it
 * again creates what is missing, preserves a broken file as `<file>.rejected`
 * and replaces it with the default, and NEVER touches a valid file (even a
 * customized one). It is idempotent — a healthy installation changes nothing.
 *
 * Two forms (§13.9.1):
 *  - GLOBAL ({ scope: "global" } or default): the full `~/.config/voidrift/`
 *    installation — `config.json` (the §13.8 seed document) and the six seeded
 *    agent directories (`agents/<name>/{agent.json,prompt.md}`), copied from the
 *    package seed templates.
 *  - PROJECT ({ scope: "project", dir }): a `<dir>/.voidrift/` skeleton — a
 *    minimal valid `config.json` (the empty `{}` document, which the schema
 *    accepts) and an empty `agents/` folder. The project form never touches the
 *    global dir; the global form never creates project files.
 *
 * Writes are atomic and private (0700 dirs, 0600 files) through the `InitFs`
 * port (§8.3). The result groups paths RELATIVE to the resolved root, sorted.
 *
 * Pure of infrastructure: all I/O is through the injected `InitFs` port and the
 * seed-template locator; no `node:fs` here (§1 rule 3, 7).
 */
import path from "node:path";
import { ConfigSchema } from "../config/schema.js";
import { seedConfigDocument, seedPermissions } from "../config/seed.js";
import {
  classifyAgainstManifest,
  type ManifestStatus,
  type ShippedManifest,
} from "../config/shipped-manifest.js";
import { parseAgentManifest } from "../entities/agent-manifest.js";
import { parseSkill } from "../entities/skills/skill.js";
import { isLeftoverName } from "../config/live-leftovers.js";
import { migrateRetiredKeys } from "../config/migrate.js";import type { InitFs } from "../entities/ports/init-fs.js";
import { coreError, ErrorCode, err, ok, type Result } from "../entities/errors.js";

/** The seeded agent directory names (§13.8), top-level then workers. */
export const SEED_AGENTS = ["research", "vibe", "researcher", "planner", "implementer", "reviewer", "summarizer"] as const;

/** The seeded skill directory names (§12.1, §13.9.1). The second seeded asset
 * class after the agents: domain-neutral skills the global base materializes. */
export const SEED_SKILLS = ["systems-thinking"] as const;

/** Options for `config.init` (§13.9.1). */
export interface ConfigInitOptions {
  /** Which installation to materialize; defaults to `global`. */
  scope?: "global" | "project";
  /** The project directory (project form only); the global form ignores it. */
  dir?: string;
  /** Names to restore to the default: a seeded agent name, a seeded skill name,
   * or `"config"`. */
  reset?: string[];
  /** Required with `reset`: without it a reset refuses and changes nothing. */
  confirmed?: boolean;
}

/** The grouped outcome (§13.9.1). Paths are relative to the resolved root, sorted. */
export interface ConfigInitResult {
  created: string[];
  repaired: string[];
  leftAlone: string[];
}

/** The `voidrift init --sweep` outcome (§13.9.1): the leftover files moved into
 * a fresh backup set, and the timestamped backup-set directory they landed in.
 * `moved` entries are display paths (home shortened by the caller). */
export interface ConfigSweepResult {
  /** The leftover files moved, as absolute paths (the caller shortens home). */
  moved: string[];
  /** The backup-set directory everything moved into, absolute (`backups/<ts>`),
   * or null when nothing matched (no set is created). */
  backupSet: string | null;
}

/** The `voidrift init --migrate` outcome (§13.9.1): the config files rewritten
 * with a retired key renamed to its current name (each original backed up to the
 * backup tree first), and the files that held no retired key (left alone). */
export interface ConfigMigrateResult {
  /** Per rewritten file: the absolute path and the renames it received. */
  migrated: { file: string; renames: { from: string; to: string }[] }[];
  /** Config files that exist but hold no retired key (absolute paths). */
  leftAlone: string[];
  /** The backup-set directory the originals were backed up into, or null when
   * no file needed migrating. */
  backupSet: string | null;
}

/** Retention: the newest N backup sets under `<configDir>/backups/` are kept;
 * older sets are pruned (§13.9.1). Fixed in code — not a config key. */
const BACKUP_SETS_KEPT = 5;

/** A single sortable UTC timestamp for one command's backup set (§13.9.1):
 * `YYYYMMDDTHHMMSSmmmZ` plus a monotonic per-process counter suffix, so two
 * operations in the same millisecond still produce distinct, chronologically
 * sortable set directories (retention keeps the newest N by name). The same
 * value is used for every file an operation backs up. */
let backupSeq = 0;
function backupTimestamp(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.]/g, "");
  const seq = (backupSeq++).toString().padStart(6, "0");
  return `${stamp}-${seq}`;
}

/** One `init --update` item (§13.9.1), classified against the known-shipped
 * manifest. `rel` is relative to the global config dir. */
export interface ConfigUpdatePreview {
  rel: string;
  /** `stale` = unmodified older default (will be refreshed); `customized` =
   * user-changed (left alone, reset hint); `missing` = not on disk (created). */
  status: "stale" | "customized" | "missing";
  /** The reset name the CLI hints for a customized item (agent/skill name). */
  resetName?: string;
  /** The current on-disk content (null when missing). */
  current: string | null;
  /** The current shipped default content. */
  def: string;
}

/** The full `init --update` plan: the per-file items plus the missing seeded
 * allow-rule ids that would be added to `config.json` (§13.9.1). */
export interface ConfigUpdatePlan {
  files: ConfigUpdatePreview[];
  /** Seeded allow-rule ids absent from the installed config.json, to be added. */
  missingAllowRules: string[];
}

/** The grouped `init --update` outcome (§13.9.1). */
export interface ConfigUpdateResult {
  /** Stale defaults refreshed (old content moved into the backup tree). */
  updated: string[];
  /** Customized files left alone, each with its reset name for the CLI hint. */
  leftAloneCustomized: { rel: string; resetName: string }[];
  /** Created missing files + added allow-rule ids (prefixed `permissions:`). */
  added: string[];
}

/** How to validate a target file's content; `null` means "valid". */
type Validator = (content: string) => string | null;

/** True when target `rel` belongs to the reset `name`: `config` → config.json;
 * a seeded agent → `agents/<name>/*`; a seeded skill → `skills/<name>/*`. One
 * matcher shared by `reset` and `previewReset` so both accept the same names. */
function matchesReset(rel: string, name: string): boolean {
  if (name === "config") return rel === "config.json";
  return rel.startsWith(`agents/${name}/`) || rel.startsWith(`skills/${name}/`);
}

/** Validate a `config.json` document the same way the config loader does (§13.3). */
function validateConfig(content: string): string | null {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch (e) {
    return `invalid JSON: ${e instanceof Error ? e.message : String(e)}`;
  }
  const parsed = ConfigSchema.partial().safeParse(doc);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "invalid config");
}

/** Validate an `agent.json` the same way discovery does (§3.1). The validator is
 * built per agent because `parseAgentManifest` needs the directory name. */
function agentValidator(dirName: string, promptMd: string): Validator {
  return (content: string): string | null => {
    try {
      parseAgentManifest(content, dirName, promptMd);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
}

/** Validate a seeded `SKILL.md` the same way discovery does (§12.1). The
 * validator is built per skill because `parseSkill` enforces `name === dirName`.
 * A skill whose frontmatter is broken is set aside as `.rejected` and replaced,
 * the same three-outcome rule as a config or an agent (§13.9.1). */
function skillValidator(dirName: string): Validator {
  return (content: string): string | null => {
    try {
      parseSkill(content, dirName, "global");
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
}

/**
 * One default target: the absolute destination, the default content to write
 * (or a copy source), and how to tell a healthy file from a broken one.
 */
interface Target {
  /** Path relative to the resolved root, for the result groups. */
  rel: string;
  /** Absolute destination. */
  abs: string;
  /** The default content to write when missing/broken. */
  content: string;
  /** Validate existing content; `null` = valid (never touched). */
  validate: Validator;
}

export class ConfigInit {
  /**
   * @param fs           the init filesystem port (absolute-path I/O, §13.9).
   * @param globalDir    the resolved global config dir (`voidriftConfigDir()`).
   * @param seedAgentsDir the absolute package seed-templates dir
   *                     (`<pkg>/seed/agents`), resolved module-relative so it
   *                     works from `src` (tests) AND the installed `dist`.
   */
  constructor(
    private readonly fs: InitFs,
    private readonly globalDir: string,
    private readonly seedAgentsDir: () => string,
  ) {}

  /** Seed and repair per §13.9.1. */
  async run(opts: ConfigInitOptions = {}): Promise<Result<ConfigInitResult>> {
    const scope = opts.scope ?? "global";
    const root = scope === "project" ? this.projectRoot(opts.dir) : this.globalDir;
    if (scope === "project" && root === null) {
      return err(coreError(ErrorCode.INVALID_INPUT, "project scope requires a dir", { field: "dir" }));
    }
    const targets = scope === "project" ? await this.projectTargets(root!) : await this.globalTargets();

    if (opts.reset && opts.reset.length > 0) {
      return this.reset(root!, targets, opts.reset, opts.confirmed === true);
    }

    const created: string[] = [];
    const repaired: string[] = [];
    const leftAlone: string[] = [];
    const stamp = backupTimestamp();
    for (const t of targets) {
      const existing = await this.fs.readFile(t.abs);
      if (existing === null) {
        await this.fs.writeFile(t.abs, t.content);
        created.push(t.rel);
      } else if (t.validate(existing) !== null) {
        // Broken: preserve the old content, then replace with the default
        // (§13.3, §13.9.1). A seeded AGENT/SKILL/PROMPT file goes to the backup
        // tree (the live directory keeps only its canonical files); an invalid
        // `config.json` is the one exception, kept as a `.rejected` sibling
        // (§13.3 — a single document, not a live resource directory).
        if (t.rel === "config.json") {
          await this.preserveRejected(t.abs);
        } else {
          await this.backupFile(root!, t.rel, t.abs, stamp);
        }
        await this.fs.writeFile(t.abs, t.content);
        repaired.push(t.rel);
      } else {
        leftAlone.push(t.rel);
      }
    }
    if (repaired.length > 0) await this.pruneBackupSets(root!);
    // The project form also materializes an empty `agents/` folder (§13.9.1).
    if (scope === "project") await this.fs.mkdirp(path.join(root!, "agents"));

    return ok({ created: created.sort(), repaired: repaired.sort(), leftAlone: leftAlone.sort() });
  }

  /**
   * The valid global reset names (§13.9.1): `config` plus each seeded agent and
   * each seeded skill. The CLI lists these when the caller passes an unknown
   * `--reset <name>`.
   */
  resetNames(): string[] {
    return ["config", ...SEED_AGENTS, ...SEED_SKILLS];
  }

  // ── `init --update` (§13.9.1) ────────────────────────────────────────────

  /** Load the known-shipped manifest from the package seed dir (§13.9.1). The
   * manifest sits beside the seeded `agents/`/`skills/` dirs as
   * `seed/shipped-hashes.json`. A missing/broken manifest yields an empty one
   * (everything then reads as `customized` — fail safe: nothing is refreshed). */
  private async loadManifest(): Promise<ShippedManifest> {
    const abs = path.join(this.seedDir(), "shipped-hashes.json");
    const raw = await this.fs.readFile(abs);
    if (raw === null) return { version: 0, entries: {} };
    try {
      const doc = JSON.parse(raw) as ShippedManifest;
      return doc && typeof doc === "object" && doc.entries ? doc : { version: 0, entries: {} };
    } catch {
      return { version: 0, entries: {} };
    }
  }

  /** The package seed dir (`<pkg>/seed`), the parent of the seeded agents dir. */
  private seedDir(): string {
    return path.dirname(this.seedAgentsDir().replace(/[\\/]+$/, ""));
  }

  /** Map a seeded relative path to its reset name (`agents/<n>/…` →`<n>`). */
  private resetNameFor(rel: string): string {
    const m = /^(?:agents|skills)\/([^/]+)\//.exec(rel);
    return m?.[1] ?? rel;
  }

  /**
   * Preview `voidrift init --update` without writing (§13.9.1): every seeded
   * agent/skill file that differs from the current shipped default, classified
   * `stale` (unmodified older default — will be refreshed) or `customized`
   * (user-changed — left alone), plus `missing` files and the seeded allow-rule
   * ids absent from the installed `config.json`. The CLI renders the diffs and
   * asks ONE batched confirmation before calling `applyUpdate`.
   */
  async previewUpdate(): Promise<Result<ConfigUpdatePlan>> {
    const manifest = await this.loadManifest();
    const targets = (await this.globalTargets()).filter((t) => t.rel !== "config.json");
    const files: ConfigUpdatePreview[] = [];
    for (const t of targets) {
      const existing = await this.fs.readFile(t.abs);
      if (existing === null) {
        files.push({ rel: t.rel, status: "missing", current: null, def: t.content });
        continue;
      }
      if (existing === t.content) continue; // already current — nothing to do
      const status: ManifestStatus = classifyAgainstManifest(manifest, t.rel, existing);
      if (status === "stale") {
        files.push({ rel: t.rel, status: "stale", current: existing, def: t.content });
      } else {
        // `customized` or `unknown` (no manifest entry): treat as customized —
        // never touched, reset hint. (A current-hash file was skipped above.)
        files.push({
          rel: t.rel,
          status: "customized",
          resetName: this.resetNameFor(t.rel),
          current: existing,
          def: t.content,
        });
      }
    }
    files.sort((a, b) => a.rel.localeCompare(b.rel));
    const missingAllowRules = await this.missingSeededAllowRules();
    return ok({ files, missingAllowRules });
  }

  /** The seeded allow-rule ids ABSENT from the installed global `config.json`
   * (§13.9.1). An existing rule of the same id — seeded or a user's own — is
   * never reported, so `--update` only ever ADDS. A broken config yields `[]`. */
  private async missingSeededAllowRules(): Promise<string[]> {
    const configAbs = path.join(this.globalDir, "config.json");
    const raw = await this.fs.readFile(configAbs);
    if (raw === null) return [];
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return [];
    }
    const perms = (doc.permissions ?? {}) as Record<string, unknown>;
    return Object.keys(seedPermissions())
      .filter((id) => !(id in perms))
      .sort();
  }

  /**
   * Apply `voidrift init --update` after the caller confirmed the batch
   * (§13.9.1). For each `stale` file the old content is kept as `<file>.previous`
   * (single generation — an existing `.previous` is replaced) and the current
   * default is written; a `missing` file is created; a `customized` file is left
   * alone and reported with its reset name. Missing seeded allow rules are added
   * to `config.json` atomically — existing rules and all other keys (model
   * settings included) are preserved byte-equivalently. `confirmed:false`
   * refuses and changes nothing.
   */
  async applyUpdate(confirmed: boolean): Promise<Result<ConfigUpdateResult>> {
    const plan = await this.previewUpdate();
    if (!plan.ok) return plan;
    if (!confirmed) {
      return err(
        coreError(ErrorCode.INVALID_INPUT, "update requires confirmed:true; nothing was changed", {
          field: "confirmed",
        }),
      );
    }
    const updated: string[] = [];
    const leftAloneCustomized: { rel: string; resetName: string }[] = [];
    const added: string[] = [];
    const stamp = backupTimestamp();

    for (const f of plan.value.files) {
      const abs = path.join(this.globalDir, f.rel);
      if (f.status === "stale") {
        await this.backupFile(this.globalDir, f.rel, abs, stamp);
        await this.fs.writeFile(abs, f.def);
        updated.push(f.rel);
      } else if (f.status === "missing") {
        await this.fs.writeFile(abs, f.def);
        added.push(f.rel);
      } else {
        leftAloneCustomized.push({ rel: f.rel, resetName: f.resetName ?? this.resetNameFor(f.rel) });
      }
    }
    if (updated.length > 0) await this.pruneBackupSets(this.globalDir);

    // Add missing seeded allow rules to config.json, touching nothing else.
    if (plan.value.missingAllowRules.length > 0) {
      const addedIds = await this.addSeededAllowRules(plan.value.missingAllowRules);
      for (const id of addedIds) added.push(`permissions:${id}`);
    }

    return ok({
      updated: updated.sort(),
      leftAloneCustomized: leftAloneCustomized.sort((a, b) => a.rel.localeCompare(b.rel)),
      added: added.sort(),
    });
  }

  /** Add the named seeded allow rules to the installed global `config.json`,
   * preserving every existing rule and every other key (§13.9.1). The write is
   * atomic (InitFs.writeFile = temp + rename). Returns the ids actually added. */
  private async addSeededAllowRules(ids: string[]): Promise<string[]> {
    const configAbs = path.join(this.globalDir, "config.json");
    const raw = await this.fs.readFile(configAbs);
    if (raw === null) return [];
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return [];
    }
    const seeded = seedPermissions();
    const perms = { ...((doc.permissions ?? {}) as Record<string, unknown>) };
    const addedIds: string[] = [];
    for (const id of ids) {
      if (id in perms || !(id in seeded)) continue; // never overwrite an existing rule
      perms[id] = seeded[id]!;
      addedIds.push(id);
    }
    if (addedIds.length === 0) return [];
    // Detect the trailing-newline convention of the file so the rewrite matches.
    const trailingNl = raw.endsWith("\n");
    doc.permissions = perms;
    await this.fs.writeFile(configAbs, JSON.stringify(doc, null, 2) + (trailingNl ? "\n" : ""));
    return addedIds;
  }

  /**
   * Move the file at `abs` into the single backup tree
   * (`<root>/backups/<stamp>/<rel>`), 0700 dirs / 0600 files, the whole
   * operation's backups grouped under ONE timestamped set (§13.9.1). Used by
   * repair, `--reset`, `--update`, and `--sweep` for agents/skills/prompts; a
   * live resource directory keeps only its canonical files. A missing source is
   * a no-op. The caller prunes old sets once per operation (`pruneBackupSets`).
   */
  private async backupFile(root: string, rel: string, abs: string, stamp: string): Promise<void> {
    const content = await this.fs.readFile(abs);
    if (content === null) return;
    const dest = path.join(root, "backups", stamp, rel);
    // Move: write the backup copy (atomic, 0600, parents 0700) then remove the
    // live file — so the live directory is left with only its canonical files.
    await this.fs.writeFile(dest, content);
    await this.fs.remove(abs);
  }

  /** Prune the backup tree to the newest {@link BACKUP_SETS_KEPT} sets, removing
   * older timestamped set directories (§13.9.1). Set names are the sortable UTC
   * stamps `backupTimestamp` produces, so a lexicographic sort is chronological. */
  private async pruneBackupSets(root: string): Promise<void> {
    const backupsDir = path.join(root, "backups");
    const entries = await this.fs.listDir(backupsDir);
    const sets = entries
      .filter((e) => e.isDir)
      .map((e) => e.name)
      .sort(); // oldest first
    const excess = sets.length - BACKUP_SETS_KEPT;
    for (let i = 0; i < excess; i++) {
      await this.fs.remove(path.join(backupsDir, sets[i]!));
    }
  }

  /**
   * `voidrift init --sweep` (§13.9.1): move exactly the backup- and
   * editor-leftover-pattern files — from the live resource directories
   * (`agents/`, `skills/`, `prompts/`) and from the config-directory ROOT — into
   * a FRESH `<root>/backups/<stamp>/` set, the same tree/modes/retention as a
   * repair. It moves nothing else: canonical files are never touched; it is
   * idempotent (a clean install moves nothing) and never deletes. When
   * `projectRoot` is given its `.voidrift/{agents,skills,prompts}` live dirs and
   * `.voidrift` root are swept into that project's own backup tree.
   */
  async sweep(projectDir?: string): Promise<Result<ConfigSweepResult>> {
    const stamp = backupTimestamp();
    const moved: string[] = [];
    // Global root: the config dir root (e.g. `config.json.bak-*`) plus the three
    // live resource dirs beneath it.
    await this.sweepRoot(this.globalDir, stamp, moved);
    // Project root (optional, its own backup tree so project leftovers stay
    // local to the project): the `.voidrift` root plus its live dirs.
    const projRoot = this.projectRoot(projectDir);
    if (projRoot) await this.sweepRoot(projRoot, stamp, moved);
    let backupSet: string | null = null;
    if (moved.length > 0) {
      await this.pruneBackupSets(this.globalDir);
      if (projRoot) await this.pruneBackupSets(projRoot);
      backupSet = path.join(this.globalDir, "backups", stamp);
    }
    return ok({ moved: moved.sort(), backupSet });
  }

  /** Sweep one config root: its own ROOT leftovers and the leftovers inside its
   * `agents/`, `skills/`, and `prompts/` live resource directories. Each moved
   * file lands under `<root>/backups/<stamp>/<rel>` so the backup mirrors its
   * origin. The backups dir itself is never scanned. */
  private async sweepRoot(root: string, stamp: string, moved: string[]): Promise<void> {
    // Root-level leftovers (e.g. `config.json.bak-*`), top-level files only.
    for (const e of await this.fs.listDir(root)) {
      if (e.isDir || !isLeftoverName(e.name)) continue;
      await this.moveToBackup(root, e.name, stamp);
      moved.push(path.join(root, e.name));
    }
    // Live resource directories: a leftover inside `<dir>/` or `<dir>/<name>/`.
    for (const live of ["agents", "skills", "prompts"]) {
      const liveAbs = path.join(root, live);
      for (const e of await this.fs.listDir(liveAbs)) {
        if (!e.isDir && isLeftoverName(e.name)) {
          await this.moveToBackup(root, path.posix.join(live, e.name), stamp);
          moved.push(path.join(liveAbs, e.name));
          continue;
        }
        if (!e.isDir) continue;
        // One level deeper: `<dir>/<name>/<leftover>`.
        const subAbs = path.join(liveAbs, e.name);
        for (const f of await this.fs.listDir(subAbs)) {
          if (f.isDir || !isLeftoverName(f.name)) continue;
          await this.moveToBackup(root, path.posix.join(live, e.name, f.name), stamp);
          moved.push(path.join(subAbs, f.name));
        }
      }
    }
  }

  /** Move `<root>/<rel>` into `<root>/backups/<stamp>/<rel>` (0700/0600). */
  private async moveToBackup(root: string, rel: string, stamp: string): Promise<void> {
    await this.backupFile(root, rel, path.join(root, rel), stamp);
  }

  /**
   * `voidrift init --migrate` (§13.9.1): persist the in-memory key migration
   * (§13.1). For each layer (global, project) whose `config.json` still names a
   * RETIRED key, back the original file up to the backup tree
   * (`<root>/backups/<stamp>/`) and rewrite the file with the key renamed and its
   * value preserved. It changes nothing else, never touches a file with no
   * retired key, and reports the renames per file plus the files left alone. An
   * unparseable config is left untouched (migration cannot be trusted to rewrite
   * invalid bytes — `doctor`/`init` repair it first). Its own invocation.
   */
  async migrate(projectDir?: string): Promise<Result<ConfigMigrateResult>> {
    const stamp = backupTimestamp();
    const migrated: ConfigMigrateResult["migrated"] = [];
    const leftAlone: string[] = [];
    let anyBacked = false;
    const projRoot = this.projectRoot(projectDir);
    // The global config.json sits at the config-dir root; a project config.json
    // sits at `<dir>/.voidrift/config.json` (projectRoot already returns that).
    const files: { root: string; abs: string }[] = [
      { root: this.globalDir, abs: path.join(this.globalDir, "config.json") },
    ];
    if (projRoot) files.push({ root: projRoot, abs: path.join(projRoot, "config.json") });
    for (const { root, abs } of files) {
      const raw = await this.fs.readFile(abs);
      if (raw === null) continue; // absent layer — nothing to migrate
      let doc: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          leftAlone.push(abs);
          continue;
        }
        doc = parsed as Record<string, unknown>;
      } catch {
        leftAlone.push(abs); // unparseable — repaired by init/doctor, not here
        continue;
      }
      const { doc: next, migrations } = migrateRetiredKeys(doc);
      if (migrations.length === 0) {
        leftAlone.push(abs);
        continue;
      }
      // Back the original up to the backup tree, then rewrite atomically.
      await this.backupFile(root, "config.json", abs, stamp);
      anyBacked = true;
      await this.fs.writeFile(abs, JSON.stringify(next, null, 2) + "\n");
      migrated.push({ file: abs, renames: migrations.map((m) => ({ from: m.from, to: m.to })) });
    }
    let backupSet: string | null = null;
    if (anyBacked) {
      await this.pruneBackupSets(this.globalDir);
      if (projRoot) await this.pruneBackupSets(projRoot);
      backupSet = path.join(this.globalDir, "backups", stamp);
    }
    return ok({ migrated, leftAlone: leftAlone.sort(), backupSet });
  }

  /**
   * Preview a `--reset <name>` without writing (§13.9.1): the file(s) the reset
   * would touch, each with the CURRENT on-disk content (`null` when absent) and
   * the DEFAULT template content. The CLI renders a line diff from this and asks
   * for confirmation before calling `run({ reset, confirmed: true })`. Returns
   * an `INVALID_INPUT` error (naming the valid names) for an unknown target, the
   * same validation `reset` applies — so the CLI refuses an unknown name the
   * same way whether or not it is interactive.
   */
  async previewReset(name: string): Promise<Result<{ rel: string; current: string | null; def: string }[]>> {
    const targets = await this.globalTargets();
    const matches = targets.filter((t) => matchesReset(t.rel, name));
    if (matches.length === 0) {
      return err(
        coreError(ErrorCode.INVALID_INPUT, `unknown reset target "${name}"`, { field: "reset" }),
      );
    }
    const out: { rel: string; current: string | null; def: string }[] = [];
    for (const t of matches) {
      out.push({ rel: t.rel, current: await this.fs.readFile(t.abs), def: t.content });
    }
    return ok(out);
  }

  /** `reset(['name'|'config'])`: restore a default ONLY with `confirmed` (§13.9.1).
   * The previous content is preserved as `<file>.rejected` first. */
  private async reset(
    root: string,
    targets: Target[],
    names: string[],
    confirmed: boolean,
  ): Promise<Result<ConfigInitResult>> {
    // Map a reset name to its target file(s): `config` → config.json; an agent
    // name → that agent's agent.json + prompt.md.
    const selected: Target[] = [];
    for (const name of names) {
      const matches = targets.filter((t) => matchesReset(t.rel, name));
      if (matches.length === 0) {
        return err(coreError(ErrorCode.INVALID_INPUT, `unknown reset target "${name}"`, { field: "reset" }));
      }
      selected.push(...matches);
    }
    if (!confirmed) {
      return err(
        coreError(ErrorCode.INVALID_INPUT, "reset requires confirmed:true; nothing was changed", {
          field: "confirmed",
        }),
      );
    }
    const repaired: string[] = [];
    const stamp = backupTimestamp();
    for (const t of selected) {
      if ((await this.fs.readFile(t.abs)) !== null) {
        if (t.rel === "config.json") await this.preserveRejected(t.abs);
        else await this.backupFile(root, t.rel, t.abs, stamp);
      }
      await this.fs.writeFile(t.abs, t.content);
      repaired.push(t.rel);
    }
    if (repaired.length > 0) await this.pruneBackupSets(root);
    return ok({ created: [], repaired: repaired.sort(), leftAlone: [] });
  }

  /** Set a broken/reset file aside as `<file>.rejected`, keeping any prior one:
   * the OLDEST `.rejected` is never destroyed — a new copy takes a numeric suffix
   * (`.rejected.1`, `.rejected.2`, …) at the first free slot (§13.9.1). */
  private async preserveRejected(abs: string): Promise<void> {
    const content = await this.fs.readFile(abs);
    if (content === null) return;
    let dest = abs + ".rejected";
    if (await this.fs.exists(dest)) {
      let n = 1;
      while (await this.fs.exists(`${abs}.rejected.${n}`)) n++;
      dest = `${abs}.rejected.${n}`;
    }
    await this.fs.rename(abs, dest);
  }

  /** The global-form targets: config.json + the six agents' agent.json/prompt.md. */
  private async globalTargets(): Promise<Target[]> {
    const targets: Target[] = [
      {
        rel: "config.json",
        abs: path.join(this.globalDir, "config.json"),
        content: JSON.stringify(seedConfigDocument(), null, 2) + "\n",
        validate: validateConfig,
      },
    ];
    for (const name of SEED_AGENTS) {
      const agentJson = await this.readSeed(name, "agent.json");
      const promptMd = await this.readSeed(name, "prompt.md");
      targets.push({
        rel: path.posix.join("agents", name, "agent.json"),
        abs: path.join(this.globalDir, "agents", name, "agent.json"),
        content: agentJson,
        validate: agentValidator(name, promptMd),
      });
      targets.push({
        rel: path.posix.join("agents", name, "prompt.md"),
        abs: path.join(this.globalDir, "agents", name, "prompt.md"),
        content: promptMd,
        // A prompt.md has no schema; it is "valid" whenever present and non-empty
        // (an empty prompt would make the agent.json invalid, repaired above).
        validate: (c: string) => (c.trim().length > 0 ? null : "empty prompt.md"),
      });
    }
    // The seeded skills (§12.1): each `skills/<name>/SKILL.md`, under the same
    // three-outcome rule as config and the agents. Discovered by the ordinary
    // skills loader once on disk; a project/global copy overrides by the cascade.
    for (const name of SEED_SKILLS) {
      const skillMd = await this.readSeedSkill(name);
      targets.push({
        rel: path.posix.join("skills", name, "SKILL.md"),
        abs: path.join(this.globalDir, "skills", name, "SKILL.md"),
        content: skillMd,
        validate: skillValidator(name),
      });
    }
    return targets;
  }

  /** The project-form targets: a minimal valid config.json (empty `{}`). */
  private async projectTargets(root: string): Promise<Target[]> {
    return [
      {
        rel: "config.json",
        abs: path.join(root, "config.json"),
        content: "{}\n",
        validate: validateConfig,
      },
    ];
  }

  /** Resolve the project `.voidrift/` root under `dir`, or null when absent. */
  private projectRoot(dir?: string): string | null {
    if (dir === undefined || dir === "") return null;
    return path.join(dir, ".voidrift");
  }

  /** Read a seed template file's content (module-relative, §13.9.1). */
  private async readSeed(agent: string, file: string): Promise<string> {
    const abs = path.join(this.seedAgentsDir(), agent, file);
    const content = await this.fs.readFile(abs);
    if (content === null) {
      throw new Error(`seed template missing: ${abs}`);
    }
    return content;
  }

  /** The seeded skills template dir (`<pkg>/seed/skills`), the sibling of the
   * seeded agents dir (`<pkg>/seed/agents`) — so a single injected locator
   * resolves both from either `src/` (tests) or the installed `dist/`. */
  private seedSkillsDir(): string {
    return path.join(path.dirname(this.seedAgentsDir().replace(/[\\/]+$/, "")), "skills");
  }

  /** Read a seeded `SKILL.md` template's content (§12.1, §13.9.1). */
  private async readSeedSkill(name: string): Promise<string> {
    const abs = path.join(this.seedSkillsDir(), name, "SKILL.md");
    const content = await this.fs.readFile(abs);
    if (content === null) {
      throw new Error(`seed skill template missing: ${abs}`);
    }
    return content;
  }
}
