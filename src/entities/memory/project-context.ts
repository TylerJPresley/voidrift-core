/**
 * Project-context assembly (core-blueprint.md §6.6, §4.2.1 tier 1).
 *
 * `AGENTS.md` is loaded as `project` memory and rides the head WHOLE as a
 * tier-1 inline item (§4.2.1), so every rule in it influences every turn.
 * Discovery walks from the workspace root; a nested file nearer a referenced
 * path takes priority over one higher up, and a workspace file overrides a
 * global one. Multiple files merge most-specific-last so the narrower
 * instruction wins.
 *
 * The file is untrusted input (§1 rule 15, §6.6): read as content, never
 * executed. Project instructions are NEVER silently truncated and NEVER
 * digested. They ride the head whole — the same as any other content — UNLESS
 * the merged files cannot fit the window at all (§4.8/§8.7): the same fit test
 * as any content (`limits.ingest.fitFraction` of the available budget). Only
 * then are they ingested by structure-aware fan-out into a line-anchored ingest
 * digest with a pointer to the full copy in the session cache, so no instruction
 * text is cut mid-file; on the first turn when no ingest digest exists yet the
 * head carries the raw merged files with a marker while the background ingest
 * runs, and the ingest digest replaces it once ready. This is a pure function —
 * the FS walk lives in the discovery adapter and the ingest fan-out in the
 * use-case.
 */
import { contentHash } from "../hash.js";

/** The marker line the head carries when the merged project instructions cannot
 * fit the window at all (§6.6/§4.8/§8.7). Names the registry key to raise and
 * states the full text is one read away in the session cache. */
export const PROJECT_OVERFLOW_MARKER =
  "Project instructions are larger than the context window (limits.ingest.fitFraction); the full text is one read_file away in the session cache and no instruction text is dropped";

/** A discovered project-instructions file, with its depth from the root. */
export interface ProjectFile {
  path: string;
  content: string;
  /** Path-segment depth from the workspace root; deeper = more specific (§6.6). */
  depth: number;
  scope: "workspace" | "global";
}

/** The merged project context: the full text and what rides the head. */
export interface ProjectContext {
  /** The WHOLE merged content, written to the session cache (the pointer).
   * Never cut — the model can always read the full file (§4.8/§8.7). */
  full: string;
  /** The text that rides the head (§4.2.1 tier 1): the whole content when it
   * fits the window, else the ingest digest (or a marked head until one is
   * cached) plus the overflow marker. */
  head: string;
  /** True when the merged content cannot fit the window and the window-fit
   * fan-out engaged (so `head` is the digest/marked head, not the whole body). */
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

/**
 * Merge discovered files most-specific-last (§6.6), keeping the WHOLE content —
 * never cut (§4.8/§8.7). Each file is separated by a header naming its path
 * (provenance; data, never authority).
 */
export function mergeFull(files: ProjectFile[]): string {
  const ordered = orderProjectFiles(files);
  return ordered.map((f) => `# ${f.path}\n${f.content}`).join("\n\n");
}

/**
 * Assemble the project context against the WINDOW-FIT budget (§6.6/§4.8/§8.7).
 * The full merged text is always kept whole (the session-cache pointer carries
 * it). When the merge fits `budgetChars` it rides the head WHOLE (tier 1,
 * §4.2.1). Only when it CANNOT fit the window does the window-fit fan-out engage:
 * the head then carries `cachedDigest` (the §8.7 ingest digest, when one exists)
 * or, on the first turn before one is cached, a marked head up to the budget,
 * each with the overflow marker naming `limits.ingest.fitFraction`. The head is
 * NEVER blocked on a worker fan-out.
 */
export function assembleProjectHead(
  files: ProjectFile[],
  budgetChars: number,
  cachedDigest: string | null = null,
): ProjectContext {
  const full = mergeFull(files);
  const hash = contentHash(full);
  if (full.length <= budgetChars) {
    // Fits the window: the whole content rides the head (tier 1, §4.2.1).
    return { full, head: full, overflow: false, hash };
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
  return { full, head, overflow: true, hash };
}
