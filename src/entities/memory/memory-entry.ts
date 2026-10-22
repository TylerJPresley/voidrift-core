/**
 * Typed memory entries and their pure logic (core-blueprint.md §6.2, §6.3).
 *
 * An entry is markdown with YAML frontmatter. These are pure data shapes and
 * pure functions — slug derivation, summary derivation, frontmatter parse and
 * serialize, keyword-discovery ranking, and the dedup normalization — so the
 * memory logic stays in the entity layer with no infrastructure imports.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { estimateTokens } from "../context/budget.js";
import { limitDefault } from "../limits.js";

/** The four memory types (§6.2). Each fixes where it loads and who owns it. */
export type MemoryType = "identity" | "user-model" | "note" | "project";

/** The two scopes backing every type; workspace overrides global by id (§6.2). */
export type MemoryScope = "workspace" | "global";

/** A parsed memory entry (§6.2). */
export interface MemoryEntry {
  id: string;
  title: string;
  summary: string;
  type: MemoryType;
  scope: MemoryScope;
  keywords: string[];
  body: string;
  /** The session that wrote the entry, for provenance (§6.2, §6.4). Absent on a
   * user-authored or legacy on-disk entry. */
  sourceSessionId?: string;
}

/** The always-loaded types rendered into the Void layer each turn (§6.2, §4.6). */
export const ALWAYS_LOADED_TYPES: ReadonlySet<MemoryType> = new Set<MemoryType>([
  "identity",
  "user-model",
  "project",
]);

/** The agent-written, per-entry-bounded types (§6.3). `identity` is uncapped. */
export const ENTRY_BOUNDED_TYPES: ReadonlySet<MemoryType> = new Set<MemoryType>([
  "user-model",
  "note",
]);

/**
 * Slug of a title (§6.2): lowercased, non-alphanumerics to hyphens, trimmed of
 * leading/trailing hyphens, sliced to 60 characters. When the slug is empty a
 * timestamp fallback is used so an entry always has an id.
 */
export function slugId(title: string, now: () => number = Date.now): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug === "" ? `mem-${now()}` : slug;
}

/** Derive the one-line summary from the body's first line to 120 chars (§6.2). */
export function deriveSummary(body: string): string {
  const firstLine = body.split("\n").find((l) => l.trim() !== "") ?? "";
  return firstLine.trim().slice(0, 120);
}

/** The frontmatter fields written to YAML (body rides below the fence). */
interface Frontmatter {
  id: string;
  title: string;
  summary: string;
  type: MemoryType;
  scope: MemoryScope;
  keywords: string[];
  sourceSessionId?: string;
}

/**
 * Serialize an entry to markdown-with-frontmatter: a leading `---` fenced YAML
 * block followed by the body. The single source of the on-disk/stored shape.
 */
export function serializeEntry(entry: MemoryEntry): string {
  const fm: Frontmatter = {
    id: entry.id,
    title: entry.title,
    summary: entry.summary,
    type: entry.type,
    scope: entry.scope,
    keywords: entry.keywords,
    ...(entry.sourceSessionId ? { sourceSessionId: entry.sourceSessionId } : {}),
  };
  const yaml = stringifyYaml(fm).trimEnd();
  return `---\n${yaml}\n---\n${entry.body}`;
}

/**
 * Parse markdown-with-frontmatter back into an entry, or null when the text does
 * not carry a well-formed `---`-fenced frontmatter with the required fields.
 * This is what verified writes (§6.4) re-read and re-parse to confirm a save.
 */
export function parseEntry(text: string): MemoryEntry | null {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return null;
  let fm: unknown;
  try {
    fm = parseYaml(match[1]!);
  } catch {
    return null;
  }
  if (!fm || typeof fm !== "object") return null;
  const o = fm as Record<string, unknown>;
  const type = o["type"];
  const scope = o["scope"];
  if (typeof o["id"] !== "string" || typeof o["title"] !== "string") return null;
  if (type !== "identity" && type !== "user-model" && type !== "note" && type !== "project") return null;
  if (scope !== "workspace" && scope !== "global") return null;
  const body = match[2] ?? "";
  const keywords = Array.isArray(o["keywords"]) ? (o["keywords"] as unknown[]).map(String) : [];
  const summary = typeof o["summary"] === "string" && o["summary"] !== "" ? o["summary"] : deriveSummary(body);
  return {
    id: o["id"],
    title: o["title"],
    summary,
    type,
    scope,
    keywords,
    body,
    ...(typeof o["sourceSessionId"] === "string" ? { sourceSessionId: o["sourceSessionId"] } : {}),
  };
}

/**
 * Build a complete entry from partial input (§6.2): derive the id from the title
 * when absent, derive the summary from the body when absent, default keywords.
 */
export function makeEntry(
  input: {
    title: string;
    type: MemoryType;
    scope: MemoryScope;
    body: string;
    id?: string;
    summary?: string;
    keywords?: string[];
    sourceSessionId?: string;
  },
  now: () => number = Date.now,
): MemoryEntry {
  const id = input.id && input.id.trim() !== "" ? input.id : slugId(input.title, now);
  const summary = input.summary && input.summary.trim() !== "" ? input.summary : deriveSummary(input.body);
  return {
    id,
    title: input.title,
    summary,
    type: input.type,
    scope: input.scope,
    keywords: input.keywords ?? [],
    body: input.body,
    ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
  };
}

/** The agent-written types whose one-line summary rides the memory index (§6.2):
 * `user-model` and `note`. `identity`/`project` are user-/project-owned and
 * render inline/as a digest, not in this index. */
export const INDEX_TYPES: ReadonlySet<MemoryType> = ENTRY_BOUNDED_TYPES;

/** A one-line memory-index entry — the `summary` that rides the head (§4.6). */
export interface MemoryIndexLine {
  id: string;
  summary: string;
  keywords: string[];
}

/** The memory index split by the aggregate cap (§6.2): `active` summaries ride
 * the head; `demoted` ids are keyword-only (still stored, still surfaced by
 * keyword and loadable by id) because the index is full. Nothing is dropped. */
export interface MemoryIndex {
  active: MemoryIndexLine[];
  demoted: string[];
}

/**
 * The aggregate memory-index cap as a fraction of the endpoint window (§6.2,
 * §13.11): default 5% (the `memory.indexCapPct` registry limit), so it scales
 * with `contextLimit` and never crowds the 10% head it shares. The default is
 * read from the limits registry; a use-case passes the effective value from the
 * injected `LimitsPort` so the entity stays pure.
 */
export function memoryIndexCapPctDefault(): number {
  return limitDefault("memory.indexCapPct");
}

/** Token estimate of one rendered index line (`- <id>: <summary>`). */
function indexLineTokens(line: MemoryIndexLine): number {
  return estimateTokens(`- ${line.id}: ${line.summary}`);
}

/**
 * Build the memory index from the agent-written entries in index order (§6.2,
 * §4.6). Every entry contributes a one-line `summary`; the index is bounded to
 * `capPct` of `contextLimit` (token estimate per summary), defaulting to the
 * `memory.indexCapPct` registry limit. When the summaries exceed the cap, the
 * OLDEST entries (first in `entries`) are demoted to keyword-only — still
 * stored, still keyword-discoverable and loadable by id — until the remainder
 * fits; demotion is reversible (room returns → the entry reappears) and never
 * deletes. No event is emitted.
 *
 * `entries` is already in index order (global-then-workspace build, §6.2), so
 * "oldest" is simply the front of the list. `capPct` is supplied by a use-case
 * from the injected `LimitsPort`; it defaults to the registry value so the pure
 * entity and its tests need no port.
 */
export function buildMemoryIndex(
  entries: MemoryEntry[],
  contextLimit: number,
  capPct: number = memoryIndexCapPctDefault(),
): MemoryIndex {
  const lines: MemoryIndexLine[] = entries
    .filter((e) => INDEX_TYPES.has(e.type))
    .map((e) => ({ id: e.id, summary: e.summary, keywords: e.keywords }));
  const cap = Math.max(0, Math.floor(contextLimit * capPct));
  const total = lines.reduce((sum, l) => sum + indexLineTokens(l), 0);
  if (total <= cap) return { active: lines, demoted: [] };
  // Demote oldest-first until the remaining active lines fit the cap.
  const demoted: string[] = [];
  let used = total;
  let start = 0;
  while (start < lines.length && used > cap) {
    used -= indexLineTokens(lines[start]!);
    demoted.push(lines[start]!.id);
    start += 1;
  }
  return { active: lines.slice(start), demoted };
}

/** The character size counted against a per-entry bound (§6.3): the whole body. */
export function entrySize(entry: MemoryEntry): number {
  return entry.body.length;
}

/**
 * Normalize a body for deduplication (§6.7): fold case and collapse all runs of
 * whitespace to a single space, trimmed. Two bodies that differ only in case or
 * spacing normalize equal, so the same lesson is never surfaced twice.
 */
export function normalizeBody(body: string): string {
  return body.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Weighted keyword discovery for `note` entries (§6.2). A term that matches a
 * filename-looking keyword scores 4.0×, an extension-looking one 3.0×, a plain
 * keyword 2.5×. Zero-scored entries are excluded. Returns entries ranked by
 * descending score (ties keep input order — a stable sort).
 *
 * A keyword is "filename-like" when it contains a dot with a name and extension
 * (e.g. `config.ts`), "extension-like" when it is a bare `.ext` or `*.ext`
 * (e.g. `.ts`, `*.ts`), and "plain" otherwise.
 */
export interface RankedEntry {
  entry: MemoryEntry;
  score: number;
}

function classifyKeyword(keyword: string): "filename" | "extension" | "plain" {
  const k = keyword.trim();
  if (/^\*?\.[a-z0-9]+$/i.test(k)) return "extension";
  if (/^[^.\s]+\.[a-z0-9]+$/i.test(k)) return "filename";
  return "plain";
}

const WEIGHT = { filename: 4.0, extension: 3.0, plain: 2.5 } as const;

/** Tokenize a query into lowercased terms for matching. */
function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9.*]+/)
    .filter((t) => t !== "");
}

/**
 * Rank `note` entries against a query by weighted keyword match (§6.2). An entry
 * scores the sum of its matched keyword weights; a keyword matches when its
 * lowercased form appears as a query term (or the query contains it). Zero-scored
 * entries are dropped.
 */
export function rankByKeywords(entries: MemoryEntry[], query: string): RankedEntry[] {
  const terms = new Set(queryTerms(query));
  const lowerQuery = query.toLowerCase();
  const ranked: RankedEntry[] = [];
  for (const entry of entries) {
    let score = 0;
    for (const keyword of entry.keywords) {
      const k = keyword.toLowerCase().trim();
      if (k === "") continue;
      const matched = terms.has(k) || lowerQuery.includes(k);
      if (!matched) continue;
      score += WEIGHT[classifyKeyword(keyword)];
    }
    if (score > 0) ranked.push({ entry, score });
  }
  // Stable sort by descending score.
  return ranked
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.score - a.r.score || a.i - b.i)
    .map(({ r }) => r);
}
