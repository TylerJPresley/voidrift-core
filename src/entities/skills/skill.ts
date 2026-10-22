/**
 * Skill entity (core-blueprint.md §12.1).
 *
 * A skill is a directory whose name is the skill name, containing a required
 * `SKILL.md` with YAML frontmatter and a markdown body. Frontmatter parses with
 * the YAML library (§1), never regex. A skill that fails validation is skipped at
 * index so one malformed skill never breaks discovery. `allowed-tools` is
 * advisory — parsed and surfaced but never auto-approving (§9, §1 rule 15).
 *
 * This is pure logic: parsing, validation, the name rule, and the cascade. No
 * filesystem — the directory adapter (§12.1) reads the files and hands the raw
 * text here.
 */
import { parse as parseYaml } from "yaml";

/** The source a skill resolves from, broad → narrow (§12.1). */
export type SkillSource = "builtin" | "global" | "project";

/** The scopes a `skills.create`/`override` can target (§12.1). Builtins never write. */
export type SkillScope = "global" | "project";

/** Validated SKILL.md frontmatter (§12.1). */
export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  /** The advisory tool allowlist, parsed from the space-separated string (§12.1). */
  allowedTools: string[];
}

/** A resolved skill in the index — frontmatter plus the markdown body and source. */
export interface Skill {
  name: string;
  description: string;
  body: string;
  source: SkillSource;
  frontmatter: SkillFrontmatter;
}

/** A manifest line for the Void-layer skills index (§4.6, §12.1): name + description only. */
export interface SkillIndexLine {
  name: string;
  description: string;
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export class SkillValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillValidationError";
  }
}

/**
 * Split a SKILL.md file into its YAML frontmatter block and markdown body. The
 * frontmatter is delimited by `---` lines; a file without a frontmatter block is
 * invalid (name and description are required).
 */
export function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const normalized = raw.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(normalized);
  if (!match) {
    throw new SkillValidationError("SKILL.md has no YAML frontmatter block");
  }
  return { frontmatter: match[1] ?? "", body: (match[2] ?? "").trim() };
}

/**
 * Parse and validate a SKILL.md file against the frontmatter rules (§12.1). The
 * directory name is required so `name === dirName` is enforced. Throws
 * `SkillValidationError` on any violation; the caller skips an invalid skill.
 */
export function parseSkill(raw: string, dirName: string, source: SkillSource): Skill {
  const { frontmatter, body } = splitFrontmatter(raw);

  let data: unknown;
  try {
    data = parseYaml(frontmatter);
  } catch (e) {
    throw new SkillValidationError(`invalid YAML frontmatter: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (data === null || typeof data !== "object") {
    throw new SkillValidationError("frontmatter is not a mapping");
  }
  const fm = data as Record<string, unknown>;

  const name = fm["name"];
  if (typeof name !== "string" || name.length < 1 || name.length > 64) {
    throw new SkillValidationError("name is required (1–64 chars)");
  }
  if (!NAME_RE.test(name)) {
    throw new SkillValidationError(`name must match ${NAME_RE.source}`);
  }
  if (name !== dirName) {
    throw new SkillValidationError(`name "${name}" must equal the directory name "${dirName}"`);
  }

  const description = fm["description"];
  if (typeof description !== "string" || description.length < 1 || description.length > 1024) {
    throw new SkillValidationError("description is required (1–1024 chars)");
  }

  const license = fm["license"];
  if (license !== undefined && typeof license !== "string") {
    throw new SkillValidationError("license must be a string");
  }

  const compatibility = fm["compatibility"];
  if (compatibility !== undefined) {
    if (typeof compatibility !== "string" || compatibility.length > 500) {
      throw new SkillValidationError("compatibility must be a string ≤500 chars");
    }
  }

  const metadataRaw = fm["metadata"];
  let metadata: Record<string, string> | undefined;
  if (metadataRaw !== undefined) {
    if (metadataRaw === null || typeof metadataRaw !== "object" || Array.isArray(metadataRaw)) {
      throw new SkillValidationError("metadata must be a string map");
    }
    metadata = {};
    for (const [k, v] of Object.entries(metadataRaw as Record<string, unknown>)) {
      if (typeof v !== "string") {
        throw new SkillValidationError(`metadata.${k} must be a string`);
      }
      metadata[k] = v;
    }
  }

  const allowedToolsRaw = fm["allowed-tools"];
  let allowedTools: string[] = [];
  if (allowedToolsRaw !== undefined) {
    if (typeof allowedToolsRaw !== "string") {
      throw new SkillValidationError("allowed-tools must be a space-separated string");
    }
    allowedTools = allowedToolsRaw.split(/\s+/).filter((t) => t.length > 0);
  }

  const parsed: SkillFrontmatter = {
    name,
    description,
    allowedTools,
    ...(license !== undefined ? { license } : {}),
    ...(compatibility !== undefined ? { compatibility: compatibility as string } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };

  return { name, description, body, source, frontmatter: parsed };
}

/** Render a scaffold SKILL.md for `skills.create` (§12.1). */
export function scaffoldSkill(name: string, description = "Describe when to use this skill."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSkill instructions go here.\n`;
}

/** Render the loaded body for the Void layer (§12.1): \`### <name>\` + markdown body. */
export function renderLoadedBody(skill: Skill): string {
  return `### ${skill.name}\n${skill.body}`;
}
