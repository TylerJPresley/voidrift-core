/**
 * Reflection suggestions (core-blueprint.md §6.7).
 *
 * Reflection writes typed candidates to `.voidrift/suggestions/`; it never
 * creates a memory or a skill autonomously (§15.1#12). The user approves or
 * rejects each through `memory.suggestions.approve`/`reject`; only an approved
 * suggestion is written to its store. Pure types and the dedup helper live here.
 */
import type { MemoryType, MemoryScope } from "./memory-entry.js";
import { normalizeBody } from "./memory-entry.js";
import { limitDefault } from "../limits.js";

/**
 * The kind of thing a candidate proposes (§6.7). A skill candidate is a complete
 * skill directory in candidate form (SKILL.md + assets); the old `"script"` kind
 * is removed — a repeatable procedure becomes one self-contained skill.
 */
export type SuggestionKind = "memory-note" | "skill";

export type SuggestionStatus = "pending" | "approved" | "rejected";

/**
 * One asset file carried by a skill suggestion (§6.7, §12.1): a relative path
 * under `scripts/`, `references/`, or `assets/`, and its text content. Written
 * verbatim alongside SKILL.md on approval; never executed by this code.
 */
export interface SkillAsset {
  /** Relative path under one of the three asset dirs (validated). */
  path: string;
  /** Text content (secrets masked before the suggestion is written). */
  content: string;
}

/** A reflection candidate written to the suggestions directory (§6.7). */
export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  title: string;
  body: string;
  /** Suggested keywords for a `memory-note` candidate (surfaced on approval). */
  keywords: string[];
  /** The target type/scope a `memory-note` candidate is written as on approval. */
  memoryType: MemoryType;
  memoryScope: MemoryScope;
  /**
   * Asset files for a `skill` candidate (§6.7): the `scripts/`, `references/`,
   * and `assets/` entries written alongside SKILL.md on approval. Absent or empty
   * for a bare skill or a memory-note.
   */
  assets?: SkillAsset[];
  /**
   * The repeated-sequence SIGNATURE this candidate was drafted from (§10.6
   * Lifecycle), when it came from the sequence detector. Persisted so a signature
   * with a pending or approved suggestion is never signalled again, and so a
   * rejection can be remembered by signature. Absent for a reflection candidate
   * that did not come from a sequence.
   */
  signature?: string;
  status: SuggestionStatus;
  /** The session boundary that produced it, for provenance. */
  sourceSessionId: string;
  createdAt: string;
}

/** The three subdirectories a skill asset may live under (§12.1). */
export const SKILL_ASSET_DIRS = ["scripts/", "references/", "assets/"] as const;

/** Internal caps on skill-suggestion assets (§6.7); not configurable. */
export const SKILL_ASSET_LIMITS = {
  maxFiles: 16,
  maxBytesPerFile: 64 * 1024,
  maxBytesTotal: 256 * 1024,
} as const;

/**
 * Validate a skill candidate's assets (§6.7), PURE. Returns `null` when valid, or
 * a one-line reason naming the offending path when not. Rejects: absolute paths,
 * `..`, backslashes, a NUL byte, anything outside the three asset dirs, duplicate
 * or case-colliding paths, non-text content (a NUL in content), and the
 * internal caps (≤16 files, ≤64 KiB per file, ≤256 KiB total). A caller refuses
 * the approval and writes NOTHING on a non-null reason.
 */
export function validateSkillAssets(assets: readonly SkillAsset[] | undefined): string | null {
  if (!assets || assets.length === 0) return null;
  if (assets.length > SKILL_ASSET_LIMITS.maxFiles) {
    return `too many asset files (${assets.length} > ${SKILL_ASSET_LIMITS.maxFiles})`;
  }
  const seen = new Set<string>();
  let total = 0;
  for (const a of assets) {
    const p = a.path;
    if (typeof p !== "string" || p.length === 0) return `empty asset path`;
    if (p.includes("\0")) return `asset path contains a NUL byte`;
    if (p.includes("\\")) return `asset path '${p}' contains a backslash`;
    if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return `asset path '${p}' is absolute`;
    // Reject `..` as a whole segment anywhere (traversal).
    if (p.split("/").some((seg) => seg === "..")) return `asset path '${p}' escapes with '..'`;
    if (!SKILL_ASSET_DIRS.some((d) => p.startsWith(d))) {
      return `asset path '${p}' is not under scripts/, references/, or assets/`;
    }
    const key = p.toLowerCase();
    if (seen.has(key)) return `duplicate or case-colliding asset path '${p}'`;
    seen.add(key);
    if (typeof a.content !== "string" || a.content.includes("\0")) {
      return `asset '${p}' has non-text content`;
    }
    const bytes = Buffer.byteLength(a.content, "utf8");
    if (bytes > SKILL_ASSET_LIMITS.maxBytesPerFile) {
      return `asset '${p}' is ${bytes} bytes, over the ${SKILL_ASSET_LIMITS.maxBytesPerFile} per-file limit`;
    }
    total += bytes;
  }
  if (total > SKILL_ASSET_LIMITS.maxBytesTotal) {
    return `assets total ${total} bytes, over the ${SKILL_ASSET_LIMITS.maxBytesTotal} limit`;
  }
  return null;
}

/**
 * A repeated-sequence signal as the §6.7 reflection flow receives it from the
 * detector (§10.6): the fields of the raised `sequence-detector` WARNING plus the
 * producing sessions. Mirrors `SequencePattern` without importing the entity, so
 * the suggestion layer stays independent of observability.
 */
export interface SequenceSignal {
  pattern: string;
  steps: string[];
  count: number;
  split: { within: number; across: number };
  outcome: "success" | "failure";
  sessionIds: string[];
}

/**
 * The bounded evidence packet handed to the reflection model to draft a skill
 * candidate from a repeated sequence (§6.7). It carries the step signatures (no
 * literal values — the detector already stripped them), the counts, the split,
 * the outcome, the producing sessions, at most a few trimmed example spans from
 * the masked `info` trail, and — per step — up to three REDACTED example argument
 * summaries (§10.6) so the reviewer can judge whether the recurrence is genuinely
 * the same procedure. It is DATA, never instructions.
 */
export interface SequenceEvidence {
  steps: string[];
  count: number;
  split: { within: number; across: number };
  outcome: "success" | "failure";
  sessionIds: string[];
  examples: { source: string; name: string; status: string }[];
  /** Up to three redacted example argument summaries per step, aligned to
   * `steps` by index (§10.6). Each summary is already masked; it is a short,
   * length-bounded JSON of the tool call's arguments, never the raw content. */
  stepArgExamples: string[][];
}

/** Internal cap: the evidence packet is at most this fraction of the endpoint's
 * `contextLimit` (§6.7), so it fits a 32k window with room to spare. */
export const SEQUENCE_EVIDENCE_MAX_CONTEXT_FRACTION = 0.1;
/** At most this many example spans ride an evidence packet (§6.7). */
export const SEQUENCE_EVIDENCE_MAX_EXAMPLES = 6;
/** At most this many redacted argument summaries per step (§10.6). The default
 * is the `sequence.evidenceExamplesPerStep` registry limit. */
export const SEQUENCE_EVIDENCE_MAX_ARGS_PER_STEP = limitDefault("sequence.evidenceExamplesPerStep");
/** Each redacted argument summary is capped to this many chars (§10.6). */
export const SEQUENCE_EVIDENCE_ARG_SUMMARY_CHARS = 200;

/** One example span the evidence builder consumes (§10.6): the step's tool name,
 * status, and a REDACTED (already-masked) argument summary. The writer supplies
 * these from its bounded ring of recent masked spans. */
export interface SequenceExampleSpan {
  source: string;
  name: string;
  status: string;
  /** A masked, bounded JSON summary of the tool call's arguments, or undefined. */
  argSummary?: string;
}

/**
 * Build the bounded evidence packet for a sequence signal (§6.7), PURE. Example
 * spans are reduced to `{source,name,status}` (no input/output/attributes, so no
 * secret rides along) and capped to `SEQUENCE_EVIDENCE_MAX_EXAMPLES`; up to three
 * redacted argument summaries are collected PER STEP from the example spans whose
 * tool name matches that step (§10.6); the whole packet is then size-bounded to
 * `maxChars` by dropping example spans, then per-step arg examples, until it fits.
 */
export function buildSequenceEvidence(
  signal: SequenceSignal,
  exampleSpans: SequenceExampleSpan[],
  maxChars: number,
  maxArgsPerStep: number = SEQUENCE_EVIDENCE_MAX_ARGS_PER_STEP,
): SequenceEvidence {
  const base = {
    steps: signal.steps,
    count: signal.count,
    split: signal.split,
    outcome: signal.outcome,
    sessionIds: signal.sessionIds,
  };
  // Per-step redacted argument examples: match each step signature's tool name
  // against the example spans and take up to three distinct masked summaries.
  const toolOf = (sig: string): string => {
    const paren = sig.indexOf("(");
    return paren >= 0 ? sig.slice(0, paren) : sig;
  };
  const buildStepArgs = (): string[][] =>
    signal.steps.map((stepSig) => {
      const tool = toolOf(stepSig);
      const summaries: string[] = [];
      for (const span of exampleSpans) {
        if (span.name !== tool || !span.argSummary) continue;
        const capped = span.argSummary.slice(0, SEQUENCE_EVIDENCE_ARG_SUMMARY_CHARS);
        if (!summaries.includes(capped)) summaries.push(capped);
        if (summaries.length >= maxArgsPerStep) break;
      }
      return summaries;
    });
  let examples = exampleSpans
    .slice(-SEQUENCE_EVIDENCE_MAX_EXAMPLES)
    .map((s) => ({ source: s.source, name: s.name, status: s.status }));
  let stepArgExamples = buildStepArgs();
  // Shrink until the serialized packet fits the budget: drop oldest examples
  // first, then thin the per-step arg examples.
  for (;;) {
    const packet: SequenceEvidence = { ...base, examples, stepArgExamples };
    if (JSON.stringify(packet).length <= maxChars) return packet;
    if (examples.length > 0) {
      examples = examples.slice(1);
      continue;
    }
    if (stepArgExamples.some((s) => s.length > 0)) {
      stepArgExamples = stepArgExamples.map((s) => s.slice(0, Math.max(0, s.length - 1)));
      continue;
    }
    return { ...base, examples, stepArgExamples };
  }
}

/** A repeated-FAILURE signal as the §6.7 reflection flow receives it from the
 * trace analyzer (§10.6): the failing tool/action by DISPLAY name, the failure
 * kind and error class, the repeat count, and the producing sessions. The
 * signature is the raised pattern (`tool_error:<name>` or `guardian_block:<tool>`)
 * so a drafted note's suggestion can suppress re-signalling by signature. */
export interface FailureSignal {
  /** `tool_error:<name>` or `guardian_block:<tool>` — the raised pattern. */
  signature: string;
  kind: "tool_error" | "guardian_block";
  /** The tool/action DISPLAY name (no raw internal name). */
  tool: string;
  /** The error class / denial reason, bounded; no secrets. */
  errorClass: string;
  count: number;
  sessionIds: string[];
  /** Up to a few already-redacted argument summaries (§10.6); no literal values. */
  argExamples: string[];
}

/** A DTO view of a suggestion across the facade (§2, no entity crosses). */
export interface SuggestionDTO {
  id: string;
  kind: SuggestionKind;
  title: string;
  body: string;
  status: SuggestionStatus;
  sourceSessionId: string;
  createdAt: string;
}

export function toSuggestionDTO(s: Suggestion): SuggestionDTO {
  return {
    id: s.id,
    kind: s.kind,
    title: s.title,
    body: s.body,
    status: s.status,
    sourceSessionId: s.sourceSessionId,
    createdAt: s.createdAt,
  };
}

/**
 * True when a candidate is a duplicate (§6.7): its normalized body matches an
 * existing memory entry's body OR an already-pending suggestion's body. Case and
 * whitespace are folded via `normalizeBody` before comparison.
 */
export function isDuplicate(
  candidate: { body: string },
  existingMemoryBodies: string[],
  pendingSuggestionBodies: string[],
): boolean {
  const norm = normalizeBody(candidate.body);
  for (const b of existingMemoryBodies) if (normalizeBody(b) === norm) return true;
  for (const b of pendingSuggestionBodies) if (normalizeBody(b) === norm) return true;
  return false;
}
