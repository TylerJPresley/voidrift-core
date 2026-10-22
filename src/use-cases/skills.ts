/**
 * The Skills capability (core-blueprint.md §12.1) — the use-case layer.
 *
 * Orchestrates the three-source cascade (builtin + the workspace/global
 * directories), the `config.skills` allowlist, progressive disclosure (index →
 * load), the CRUD namespace, the model-facing `list_skills`/`load_skill` tools,
 * and the Void-layer seam the engine reads (§4.6). The directory adapter does
 * the I/O and the registry entity does the cascade; this wires them and emits
 * `SKILL_LOADED`/`RESOURCE_CHANGED`.
 */
import { z } from "zod";
import type { EventBus } from "../entities/event-bus.js";
import { SkillRegistry, type SkillCandidates } from "../entities/skills/skill-registry.js";
import type { Skill, SkillIndexLine, SkillScope } from "../entities/skills/skill.js";
import { parseSkill, SkillValidationError } from "../entities/skills/skill.js";
import type { SkillsDirectory } from "../adapters/skills-directory.js";
import type { ToolRegistry, ToolDefinition, ToolExecutor } from "../entities/tool-registry.js";
import { coreError, err, ok, ErrorCode, type Result } from "../entities/errors.js";

/** A DTO view of a skill across the facade (§2, no entity crosses). */
export interface SkillDTO {
  name: string;
  description: string;
  source: Skill["source"];
  /** The advisory tool allowlist, surfaced but never auto-approving (§12.1, §9). */
  allowedTools: string[];
  loaded: boolean;
}

export interface SkillsDeps {
  bus: EventBus;
  directory: SkillsDirectory;
  /** The `config.skills` allowlist (empty = all), resolved live (§12.1). */
  getAllowlist: () => string[];
  /** Register the model-facing tools through the tool registry (§8.1). */
  toolRegistry: ToolRegistry;
}

export class Skills {
  private readonly registry = new SkillRegistry();
  /** Builtin skills registered programmatically (§12.1), from core and plugins. */
  private readonly builtins = new Map<string, Skill>();

  constructor(private readonly deps: SkillsDeps) {
    this.registerTools();
  }

  /** Register a builtin skill programmatically (§12.1). Plugins use this seam too. */
  registerBuiltin(raw: string, name: string): Result<SkillDTO> {
    try {
      const skill = parseSkill(raw, name, "builtin");
      this.builtins.set(name, skill);
      return ok(this.toDTO(skill));
    } catch (e) {
      const reason = e instanceof SkillValidationError ? e.message : String(e);
      return err(coreError(ErrorCode.INVALID_INPUT, reason, { field: "skill" }));
    }
  }

  /** Re-index from all three sources (§12.1). Drops loaded names no longer resolved. */
  async reindex(): Promise<void> {
    const ws = await this.deps.directory.load("project");
    const gl = await this.deps.directory.load("global");
    const candidates: SkillCandidates = {
      builtin: [...this.builtins.values()],
      global: gl.skills,
      project: ws.skills,
    };
    const dropped = this.registry.reindex(candidates, this.deps.getAllowlist());
    for (const name of dropped) {
      // A loaded name no longer resolved is dropped; no SKILL_LOADED is undone,
      // the Void layer simply stops rendering it next turn.
      void name;
    }
  }

  // ── the index + loaded seams the engine reads (§4.6) ──────────────────────

  /** The Void-layer index manifest (name + description only, §12.1). */
  indexLines(): SkillIndexLine[] {
    return this.registry.indexLines();
  }

  /** The rendered loaded bodies for the Void layer (§12.1). */
  loadedBodies(): string[] {
    return this.registry.loadedBodies();
  }

  /** Drop a loaded name when its loading turn is folded by compaction (§4.9). */
  unload(name: string): void {
    this.registry.unload(name);
  }

  // ── the model-facing tools (§8.1, §12.1) ──────────────────────────────────

  private registerTools(): void {
    const listDef: ToolDefinition = {
      name: "list_skills",
      description: "List available skills (name and description). Call load_skill to activate one.",
      schema: z.object({}),
      readOnly: true,
    };
    const listExec: ToolExecutor = async () => {
      const lines = this.indexLines();
      const content = lines.length === 0
        ? "No skills available."
        : "## Available Skills\n" + lines.map((l) => `- ${l.name}: ${l.description}`).join("\n") +
          "\n\nCall load_skill(name) to activate a skill.";
      return { content, status: "success" };
    };

    const loadDef: ToolDefinition = {
      name: "load_skill",
      description: "Activate a skill by name, loading its full instructions into context.",
      schema: z.object({ name: z.string() }),
      readOnly: true,
    };
    const loadExec: ToolExecutor = async (args) => {
      const { name } = args as { name: string };
      const result = this.load(name);
      if (!result.loaded) {
        return { content: `Skill "${name}" is not available or already loaded.`, status: "success" };
      }
      const skill = this.registry.get(name)!;
      return { content: `Loaded skill "${name}".\n\n${skill.body}`, status: "success" };
    };

    this.modelToolDefs = [
      { def: listDef, exec: listExec },
      { def: loadDef, exec: loadExec },
    ];
    this.deps.toolRegistry.register(listDef, listExec);
    this.deps.toolRegistry.register(loadDef, loadExec);
  }

  /** The model-facing tools (list_skills, load_skill) for the engine to bind (§8.1). */
  private modelToolDefs: { def: ToolDefinition; exec: ToolExecutor }[] = [];
  modelTools(): { def: ToolDefinition; exec: ToolExecutor }[] {
    return this.modelToolDefs;
  }

  /** Load a skill into the session set (§12.1). Idempotent; unknown ignored. */
  load(name: string): { loaded: boolean } {
    const newlyLoaded = this.registry.load(name);
    if (newlyLoaded) {
      this.deps.bus.emit("SKILL_LOADED", { name }, {});
    }
    return { loaded: newlyLoaded };
  }

  // ── the skills CoreAPI namespace (§2.2, §12.1) ────────────────────────────

  list(): SkillDTO[] {
    return this.registry.list().map((s) => this.toDTO(s));
  }

  /** Scaffold a SKILL.md under a scope and re-index (§12.1 create). */
  async create(name: string, scope: SkillScope): Promise<Result<SkillDTO>> {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
      return err(coreError(ErrorCode.INVALID_INPUT, "invalid skill name", { field: "name" }));
    }
    await this.deps.directory.scaffold(name, scope);
    await this.reindex();
    this.resourceChanged();
    const skill = this.registry.get(name);
    return skill ? ok(this.toDTO(skill)) : err(coreError(ErrorCode.NOT_FOUND, `skill ${name} not indexed after create`));
  }

  /** Seed a workspace/global copy from a builtin (§12.1 override). */
  async override(name: string, scope: SkillScope): Promise<Result<SkillDTO>> {
    const builtin = this.builtins.get(name);
    if (!builtin) return err(coreError(ErrorCode.NOT_FOUND, `no builtin skill "${name}" to override`));
    const content = this.serialize(builtin);
    await this.deps.directory.write(name, scope, content);
    await this.reindex();
    this.resourceChanged();
    const skill = this.registry.get(name);
    return skill ? ok(this.toDTO(skill)) : err(coreError(ErrorCode.NOT_FOUND, `skill ${name} not indexed after override`));
  }

  /** Rename a skill (§12.1); rejects a builtin. */
  async rename(name: string, newName: string, scope: SkillScope): Promise<Result<SkillDTO>> {
    if (this.builtins.has(name)) return err(coreError(ErrorCode.INVALID_INPUT, "cannot rename a builtin skill", { field: "name" }));
    const raw = await this.deps.directory.read(name, scope);
    if (raw === null) return err(coreError(ErrorCode.NOT_FOUND, `skill ${name} not found in ${scope}`));
    const rebodied = raw.replace(/^(\s*name:\s*).*$/m, `$1${newName}`);
    await this.deps.directory.write(newName, scope, rebodied);
    await this.deps.directory.remove(name, scope);
    await this.reindex();
    this.resourceChanged();
    const skill = this.registry.get(newName);
    return skill ? ok(this.toDTO(skill)) : err(coreError(ErrorCode.NOT_FOUND, `skill ${newName} not indexed after rename`));
  }

  /** Delete a skill (§12.1); rejects a builtin. */
  async delete(name: string, scope: SkillScope): Promise<Result<{ name: string }>> {
    if (this.builtins.has(name)) return err(coreError(ErrorCode.INVALID_INPUT, "cannot delete a builtin skill", { field: "name" }));
    const existed = await this.deps.directory.remove(name, scope);
    if (!existed) return err(coreError(ErrorCode.NOT_FOUND, `skill ${name} not found in ${scope}`));
    await this.reindex();
    this.resourceChanged();
    return ok({ name });
  }

  private serialize(skill: Skill): string {
    const fm = skill.frontmatter;
    const lines = [`name: ${fm.name}`, `description: ${fm.description}`];
    if (fm.license) lines.push(`license: ${fm.license}`);
    if (fm.allowedTools.length > 0) lines.push(`allowed-tools: ${fm.allowedTools.join(" ")}`);
    return `---\n${lines.join("\n")}\n---\n\n${skill.body}\n`;
  }

  private resourceChanged(): void {
    this.deps.bus.emit("RESOURCE_CHANGED", { type: "skill" }, {});
  }

  private toDTO(skill: Skill): SkillDTO {
    return {
      name: skill.name,
      description: skill.description,
      source: skill.source,
      allowedTools: skill.frontmatter.allowedTools,
      loaded: this.registry.loadedNames().includes(skill.name),
    };
  }
}
