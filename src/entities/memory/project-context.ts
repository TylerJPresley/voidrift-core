/**
 * Project-context assembly (core-blueprint.md §6.6, §4.2.1 tier 2).
 *
 * `AGENTS.md` is loaded as `project` memory and rendered into the head as a
 * DIGEST plus a POINTER to its full copy in the session cache, so its rules
 * influence every turn without the whole file occupying the head. Discovery
 * walks from the workspace root; a nested file nearer a referenced path takes
 * priority over one higher up, and a workspace file overrides a global one.
 * Multiple files merge most-specific-last so the narrower instruction wins.
 *
 * The file is untrusted input (§1 rule 15, §6.6): read as content, never
 * executed. The whole merge is kept (never silently cut, §4.8/§8.7); when it
 * exceeds the head budget the head carries an INGEST DIGEST (or, until one is
 * cached, a marked head) plus a pointer to the full copy and the marker line
 * naming `limits.ingest.fitFraction` (and `limits.memory.projectChars` as the
 * explicit override). These are pure functions — the FS walk lives in the
 * discovery adapter and the ingest fan-out in the use-case.
 */
import { contentHash } from "../hash.js";
import { limitDefault } from "../limits.js";

/** The marker line the head carries when the project instructions are larger
 * than the head budget (§4.8/§8.7). Names the registry key to raise. */
export const PROJECT_OVERFLOW_MARKER =
  "Project instructions are larger than the head budget (limits.ingest.fitFraction, or set limits.memory.projectChars to override); this is a digest - read the full file with read_file for exact wording";

/** The §4.8 token estimate (4 chars/token) shared with Ingest and the chunkers,
 * used to convert the fraction-of-window budget into a char budget. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}
export function tokensToChars(tokens: number): number {
  return tokens * 4;
}

/** A discovered project-instructions file, with its depth from the root. */
export interface ProjectFile {
  path: string;
  content: string;
  /** Path-segment depth from the workspace root; deeper = more specific (§6.6). */
  depth: number;
  scope: "workspace" | "global";
}

/** The merged project context: the full text, the head, and the budget. */
export interface ProjectContext {
  /** The WHOLE merged content, written to the session cache (tier 2 pointer).
   * Never cut — the model can always read the full file (§4.8/§8.7). */
  full: string;
  /** The text that rides the head (§4.2.1 tier 2): the whole content when it
   * fits the head budget, else the ingest DIGEST (or a marked head until one is
   * cached) plus the overflow marker. */
  digest: string;
  /** True when the merged content exceeds the head budget (so `digest` is a
   * reduced head, not the whole content). Kept named `truncated` for back-compat
   * with existing callers; the FULL text is never actually cut. */
  truncated: boolean;
  /** The char budget applied to the head. */
  limit: number;
  /** True when the content exceeds the head budget (alias of `truncated`). */
  overflow: boolean;
  /** SHA-256 of the full merged content — the ingest/digest cache key input. */
  hash: string;
}

/**
 * Order files most-specific-LAST (§6.6): global before workspace, then shallower
 * before deeper, so a deeper workspace file is appended last and its rules win on
 * a merge-most-specific-last read. Stable within equal (depth, scope).
 */
export function orderProjectFiles(files: ProjectFile[]): ProjectFile[] {
  const scopeRank = (s: ProjectFile["scope"]): number => (s === "global" ? 0 : 1);
  return files
    .map((f, i) => ({ f, i }))
    .sort((a, b) => scopeRank(a.f.scope) - scopeRank(b.f.scope) || a.f.depth - b.f.depth || a.i - b.i)
    .map(({ f }) => f);
}

/** Derive a short digest from merged content: the first non-empty lines up to
 * `maxChars` (§4.2.1 tier 2). The pointer carries the full copy. The default
 * cap is the `memory.projectDigestMaxChars` registry limit. */
export function deriveDigest(full: string, maxChars = limitDefault("memory.projectDigestMaxChars")): string {
  const lines = full.split("\n").filter((l) => l.trim() !== "");
  let digest = "";
  for (const line of lines) {
    if (digest.length + line.length + 1 > maxChars) break;
    digest += (digest === "" ? "" : "\n") + line;
  }
  if (digest === "") digest = full.slice(0, maxChars);
  return digest;
}

/**
 * Merge discovered files most-specific-last (§6.6), keeping the WHOLE content —
 * never cut (§4.8/§8.7). Each file is separated by a header naming its path
 * (provenance; data, never authority). The budget decision (whole vs digest) is
 * made by `assembleProjectHead`, so the full text here is always complete.
 */
export function mergeFull(files: ProjectFile[]): string {
  const ordered = orderProjectFiles(files);
  return ordered.map((f) => `# ${f.path}\n${f.content}`).join("\n\n");
}

/**
 * Assemble the project context against the head budget (§4.8/§8.7). The full
 * merged text is kept whole. When it fits within `budgetChars`, the whole text
 * rides the head. When it does not, the head carries `cachedDigest` (the ingest
 * digest, when one exists) or a marked head of the content up to the budget,
 * each with the overflow marker naming `limits.ingest.fitFraction`.
 *
 * `cachedDigest` is null on the FIRST turn (no digest cached yet): the head then
 * carries the marked head and the caller kicks the ingest in the background so
 * the next turn hits the cache. The head is NEVER blocked on a worker fan-out.
 */
export function assembleProjectHead(
  files: ProjectFile[],
  budgetChars: number,
  cachedDigest: string | null = null,
): ProjectContext {
  const full = mergeFull(files);
  const hash = contentHash(full);
  if (full.length <= budgetChars) {
    return { full, digest: full, truncated: false, limit: budgetChars, overflow: false, hash };
  }
  let head: string;
  if (cachedDigest && cachedDigest.trim() !== "") {
    head = `${PROJECT_OVERFLOW_MARKER}\n\n${cachedDigest}`;
  } else {
    // First turn (no digest yet): carry the head of the content up to the budget
    // WITH the marker and pointer. The ingest is kicked in the background.
    const room = Math.max(0, budgetChars - PROJECT_OVERFLOW_MARKER.length - 2);
    head = `${PROJECT_OVERFLOW_MARKER}\n\n${full.slice(0, room)}`;
  }
  return { full, digest: head, truncated: true, limit: budgetChars, overflow: true, hash };
}

/**
 * Back-compat merge that stops at a byte bound (used by legacy call sites and
 * the §6.6 ordering tests). It merges most-specific-last and, when the content
 * exceeds `limit`, keeps the whole text but flags `overflow`/`truncated`. It
 * never cuts `full` (§4.8/§8.7); the head reduction is `assembleProjectHead`.
 */
export function mergeProjectContext(files: ProjectFile[], limit: number): ProjectContext {
  return assembleProjectHead(files, limit, null);
}
