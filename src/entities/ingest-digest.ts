/**
 * The ingest DIGEST value and its render (core-blueprint.md §8.7).
 *
 * A PURE entity: no I/O, no ports. The digest is the line-anchored reduction an
 * ingest fan-out produces (§8.7): `{ source, contentHash, purpose, ranges, overall }`
 * plus the parameters it was keyed by and bookkeeping. It is cached under
 * `.voidrift/cache/ingest/` by `digestKey(contentHash, purpose, params)` — a
 * second ingest of an unchanged source for the same purpose and parameters is a
 * cache hit (§8.7). A changed `contentHash` is a different key (a miss → re-ingest).
 *
 * Every string is sanitized (control/bidi stripped, §8.2 untrusted-text) and
 * bounded so a hostile source can neither inject terminal escapes nor inflate
 * the cached/ rendered size. `renderDigest(d)` returns the compact text handed
 * to the model: the `overall`, each range with a `lines a-b:` anchor, and the
 * one affordance line telling the model to pull exact lines with `read_file`.
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import { stripUnsafeChars, stripUnsafeCharsKeepWhitespace } from "./untrusted-text.js";

/** The current on-disk digest schema version. A cache file at a different
 * version is a miss (ignored) so an older/newer shape never deserializes wrong. */
export const DIGEST_VERSION = 1 as const;

// --- bounded sizes (fixed in code; the TOKEN budgets are `limits.ingest.*`) ---
/** Max chars of `source` (a workspace-relative path or a normalized URL). */
const MAX_SOURCE = 2048;
/** Max chars of `purpose` (the model-supplied reason the content was ingested). */
const MAX_PURPOSE = 1024;
/** Max chars of one range `summary`. */
const MAX_SUMMARY = 8192;
/** Max chars of `overall`. */
const MAX_OVERALL = 16384;
/** Max chars of one chunker id. */
const MAX_ID = 128;
/** Max ranges carried in one digest (mirrors `limits.ingest.maxChunks` ceiling,
 * bounded independently so a planted cache file cannot carry unbounded ranges). */
const MAX_RANGES = 10_000;

/** Collapse a single-line field: strip control/bidi, fold whitespace, cap. */
function oneLine(s: string, max: number): string {
  return stripUnsafeChars(s).replace(/\s+/g, " ").trim().slice(0, max);
}

/** Sanitize a multi-line field: strip control/bidi (keep \t\n\r), cap length. */
function multiLine(s: string, max: number): string {
  return stripUnsafeCharsKeepWhitespace(s).slice(0, max);
}

/** The ingest parameters a digest is keyed by (§8.7): the chunk target, the
 * digest token budget, and the chunker id that produced it. Different params
 * are a different key (and so a different cache entry). */
export const digestParamsSchema = z
  .object({
    chunkTargetTokens: z.number().int().positive(),
    digestTokens: z.number().int().positive(),
    chunkerId: z.string().min(1).max(MAX_ID),
  })
  .strict();
export type DigestParams = z.infer<typeof digestParamsSchema>;

/** One line-anchored range summary (1-based inclusive lines). */
export const digestRangeSchema = z
  .object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    summary: z.string().max(MAX_SUMMARY),
  })
  .strict();
export type DigestRange = z.infer<typeof digestRangeSchema>;

/** The ingest digest (§8.7). `missing` lists ranges that could not be
 * summarized (a map worker failed) so a gap is never silent. */
export const digestSchema = z
  .object({
    version: z.literal(DIGEST_VERSION),
    source: z.string().min(1).max(MAX_SOURCE),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    purpose: z.string().max(MAX_PURPOSE),
    params: digestParamsSchema,
    ranges: z.array(digestRangeSchema).max(MAX_RANGES),
    overall: z.string().max(MAX_OVERALL),
    missing: z.array(digestRangeSchema).max(MAX_RANGES),
    createdAt: z.string().min(1).max(64),
  })
  .strict();
export type Digest = z.infer<typeof digestSchema>;

/** The raw fields a caller supplies to build a digest (before sanitization). */
export interface DigestInput {
  source: string;
  contentHash: string;
  purpose: string;
  params: DigestParams;
  ranges: DigestRange[];
  overall: string;
  missing?: DigestRange[];
  createdAt?: string;
}

/** Sanitize one range (summary multi-line; line numbers normalized to ≥1 and
 * ordered start ≤ end). */
function sanitizeRange(r: DigestRange): DigestRange {
  const startLine = Math.max(1, Math.floor(r.startLine));
  const endLine = Math.max(startLine, Math.floor(r.endLine));
  return { startLine, endLine, summary: multiLine(r.summary, MAX_SUMMARY) };
}

/**
 * Build a validated, sanitized `Digest` from raw fields. Every string is
 * control/bidi-stripped and bounded; the result is parsed through the schema so
 * a malformed build throws at the boundary (never a half-formed digest).
 */
export function makeDigest(input: DigestInput): Digest {
  const ranges = (input.ranges ?? []).slice(0, MAX_RANGES).map(sanitizeRange);
  const missing = (input.missing ?? []).slice(0, MAX_RANGES).map(sanitizeRange);
  const candidate: Digest = {
    version: DIGEST_VERSION,
    source: oneLine(input.source, MAX_SOURCE),
    contentHash: input.contentHash,
    purpose: oneLine(input.purpose, MAX_PURPOSE),
    params: {
      chunkTargetTokens: Math.max(1, Math.floor(input.params.chunkTargetTokens)),
      digestTokens: Math.max(1, Math.floor(input.params.digestTokens)),
      chunkerId: oneLine(input.params.chunkerId, MAX_ID) || "generic",
    },
    ranges,
    overall: multiLine(input.overall, MAX_OVERALL),
    missing,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  return digestSchema.parse(candidate);
}

/**
 * The cache key for a digest: a hex SHA-256 over the content hash, the purpose,
 * and the canonical parameters (§8.7). Deterministic and collision-resistant, so
 * an unchanged source + same purpose + same params hits the same file, and ANY
 * change (content, purpose, chunk target, digest budget, chunker) is a new key.
 * The key is a safe filename component (hex only) — no path separators.
 */
export function digestKey(contentHash: string, purpose: string, params: DigestParams): string {
  const canonical = JSON.stringify({
    v: DIGEST_VERSION,
    c: contentHash,
    p: oneLine(purpose, MAX_PURPOSE),
    k: {
      chunkTargetTokens: Math.max(1, Math.floor(params.chunkTargetTokens)),
      digestTokens: Math.max(1, Math.floor(params.digestTokens)),
      chunkerId: oneLine(params.chunkerId, MAX_ID),
    },
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** The affordance line every rendered digest ends with (§8.7): how to pull the
 * exact source lines back. Stable wording clients may match. */
export const READ_EXACT_LINE = "Read exact lines with read_file path offset limit";

/**
 * Render the compact digest text returned to the model (§8.7): the `overall`,
 * then each range as `lines a-b:` + its summary, then any `missing` ranges, then
 * the one `read_file` affordance line. Pure and deterministic. The text is
 * already sanitized (the fields were sanitized at build time).
 */
export function renderDigest(d: Digest): string {
  const parts: string[] = [];
  if (d.overall.trim() !== "") parts.push(d.overall.trim());
  for (const r of d.ranges) {
    parts.push(`lines ${r.startLine}-${r.endLine}: ${r.summary.trim()}`);
  }
  if (d.missing.length > 0) {
    const gaps = d.missing.map((r) => `lines ${r.startLine}-${r.endLine}`).join(", ");
    parts.push(`Not summarized (read directly): ${gaps}`);
  }
  parts.push(READ_EXACT_LINE);
  return parts.join("\n");
}
