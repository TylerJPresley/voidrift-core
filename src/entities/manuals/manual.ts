/**
 * Manual entity (core-blueprint.md §12.8).
 *
 * A manual is a Markdown document with YAML frontmatter containing summary,
 * read-when hint, and Diataxis type. Manual ids are namespaced by source:
 * core/, cli/, <plugin-id>/ — ensuring no two sources ever register the same id
 * (append-only, no shadowing). The directory adapter reads files; this handles
 * parsing, validation, and the registry.
 */
import { parse as parseYaml } from "yaml";

/** Diataxis document types. */
export type DiataxisType = "tutorial" | "how-to" | "reference" | "explanation";

/** The source a manual resolves from. */
export type ManualSource = "builtin";

/** Validated front-matter from a manual document. */
export interface ManualFrontmatter {
  /** One-line summary for the table of contents. */
  summary: string;
  /** Moment to open this doc (user-facing guidance). */
  readWhen: string;
  /** Diataxis type for organization. */
  type: DiataxisType;
}

/** A resolved manual in the registry: id, frontmatter, body, and source. */
export interface Manual {
  /** Namespaced id: core/…, cli/…, <plugin-id>/… */
  id: string;
  body: string;
  source: ManualSource;
  frontmatter: ManualFrontmatter;
}

export class ManualValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManualValidationError";
  }
}

/**
 * Split a manual markdown file into YAML frontmatter and body.
 * Frontmatter is delimited by `---` lines.
 */
export function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const normalized = raw.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(normalized);
  if (!match) {
    throw new ManualValidationError("Manual has no YAML frontmatter block");
  }
  return { frontmatter: match[1] ?? "", body: (match[2] ?? "").trim() };
}

/**
 * Validate that the id follows the namespace pattern: prefix/slug
 * Valid prefixes: core, cli, <plugin-id>.
 */
function validateId(id: string): void {
  const parts = id.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ManualValidationError(
      `id must be namespaced as prefix/slug; got "${id}"`,
    );
  }
  // Allow core, cli, or any plugin id (lowercase alphanumerics + hyphens)
  const prefix = parts[0];
  if (!/^([a-z0-9]+(-[a-z0-9]+)*|core|cli)$/.test(prefix)) {
    throw new ManualValidationError(
      `id prefix must be core, cli, or a valid plugin id; got "${prefix}"`,
    );
  }
}

/**
 * Parse and validate a manual markdown file. The id must follow the
 * namespace pattern; frontmatter is required with summary, read-when, and type.
 * Throws ManualValidationError on violation; the caller skips an invalid manual.
 */
export function parseManual(raw: string, id: string, source: ManualSource): Manual {
  validateId(id);

  const { frontmatter, body } = splitFrontmatter(raw);

  let data: unknown;
  try {
    data = parseYaml(frontmatter);
  } catch (e) {
    throw new ManualValidationError(
      `invalid YAML frontmatter: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (data === null || typeof data !== "object") {
    throw new ManualValidationError("frontmatter is not a mapping");
  }
  const fm = data as Record<string, unknown>;

  const summary = fm["summary"];
  if (typeof summary !== "string" || summary.length < 1) {
    throw new ManualValidationError("summary is required and must be a non-empty string");
  }

  const readWhen = fm["read-when"];
  if (typeof readWhen !== "string" || readWhen.length < 1) {
    throw new ManualValidationError("read-when is required and must be a non-empty string");
  }

  const type = fm["type"];
  if (!["tutorial", "how-to", "reference", "explanation"].includes(type as string)) {
    throw new ManualValidationError(
      `type must be one of: tutorial, how-to, reference, explanation; got "${String(type)}"`,
    );
  }

  return {
    id,
    body,
    source,
    frontmatter: {
      summary,
      readWhen,
      type: type as DiataxisType,
    },
  };
}
