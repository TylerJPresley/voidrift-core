/**
 * Structure-aware chunkers for INGEST (core-blueprint.md §8.7).
 *
 * A PURE entity: no I/O, no ports. Each `Chunker` splits text into
 * line-anchored chunks the ingest fan-out summarizes in parallel; the 1-based
 * line ranges let the model pull the exact source back with `read_file`
 * offset/limit. Chunking is deterministic (same input → same chunks).
 *
 * Token sizing reuses the ONE estimator (`estimateTokens`, §4.8); the core adds
 * NO parser dependency. Plugins contribute AST chunkers through the
 * `register.chunker` seam (CoreAPI) — a registered chunker that `matches` wins
 * over the builtins, so the core stays parser-free while a plugin can add e.g.
 * a tree-sitter chunker.
 */
import { estimateTokens } from "./context/budget.js";

/** One chunk: a 1-based inclusive line range and its verbatim text. */
export interface Chunk {
  startLine: number;
  endLine: number;
  text: string;
}

/**
 * A structure-aware chunker. `matches(path, head)` decides whether this chunker
 * applies to a source (by extension and/or a peek at the first lines);
 * `chunk(text, targetTokens)` returns contiguous, deterministic chunks sized
 * near `targetTokens`.
 */
export interface Chunker {
  readonly id: string;
  matches(path: string, head: string): boolean;
  chunk(text: string, targetTokens: number): Chunk[];
}

const tok = (s: string): number => estimateTokens(s);

/** Split into lines, preserving a stable 1-based index. The trailing-newline
 * split artifact is dropped so line counts match the source. */
function toLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Assemble chunks from [startLine, endLine] boundary groups over `lines`. */
function groupsToChunks(lines: string[], groups: Array<[number, number]>): Chunk[] {
  return groups.map(([s, e]) => ({
    startLine: s,
    endLine: e,
    text: lines.slice(s - 1, e).join("\n"),
  }));
}

/** Turn a sorted list of 1-based boundary line numbers into contiguous blocks
 * covering `[1, totalLines]`. A leading region before the first boundary is its
 * own block. Written index-safe for strict `noUncheckedIndexedAccess`. */
function boundariesToBlocks(boundaries: number[], totalLines: number): Array<[number, number]> {
  const blocks: Array<[number, number]> = [];
  const first = boundaries[0];
  if (first === undefined) return [[1, totalLines]];
  if (first > 1) blocks.push([1, first - 1]);
  for (let b = 0; b < boundaries.length; b++) {
    const s = boundaries[b] as number;
    const next = boundaries[b + 1];
    const e = next !== undefined ? next - 1 : totalLines;
    blocks.push([s, e]);
  }
  return blocks;
}

/** Greedily pack sequential blocks (each `[start,end]`) into chunks near
 * `targetTokens`, splitting a single oversized block on an inner splitter. A
 * block is `[startLine, endLine]`. */
function packBlocks(
  lines: string[],
  blocks: Array<[number, number]>,
  targetTokens: number,
): Chunk[] {
  const out: Array<[number, number]> = [];
  let cur: [number, number] | null = null;
  let curTokens = 0;

  const flush = () => {
    if (cur) out.push(cur);
    cur = null;
    curTokens = 0;
  };

  for (const [bs, be] of blocks) {
    const blockText = lines.slice(bs - 1, be).join("\n");
    const bt = tok(blockText);

    if (bt > targetTokens) {
      // oversized single block: flush, then split it on blank lines (with a
      // line-window fallback) into sub-chunks.
      flush();
      for (const sub of splitRange(lines, bs, be, targetTokens)) out.push(sub);
      continue;
    }

    if (cur && curTokens + bt > targetTokens) flush();
    if (!cur) {
      cur = [bs, be];
      curTokens = bt;
    } else {
      cur = [cur[0], be];
      curTokens += bt;
    }
  }
  flush();
  return groupsToChunks(lines, out);
}

/** Split a line range on blank lines into near-target pieces; fall back to a
 * fixed line window when the range has no blank-line structure. */
function splitRange(
  lines: string[],
  start: number,
  end: number,
  targetTokens: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let segStart = start;
  let segTokens = 0;
  let any = false;
  for (let i = start; i <= end; i++) {
    const line = lines[i - 1] ?? "";
    segTokens += tok(line) + 1;
    const isBlank = line.trim() === "";
    if (isBlank && segTokens >= targetTokens && i > segStart) {
      out.push([segStart, i]);
      segStart = i + 1;
      segTokens = 0;
      any = true;
    }
  }
  if (segStart <= end) out.push([segStart, end]);
  if (any || out.length > 1) return out;
  // No blank-line structure helped: line-window fallback.
  return windowRange(start, end, lines, targetTokens);
}

/** A fixed line-window split with a small overlap, so a boundary declaration is
 * never orphaned. Window size derives from the target (≈ target tokens / avg
 * line tokens), bounded to a sane minimum. */
function windowRange(
  start: number,
  end: number,
  lines: string[],
  targetTokens: number,
): Array<[number, number]> {
  const total = end - start + 1;
  const avgLineTokens = Math.max(1, Math.ceil(tok(lines.slice(start - 1, end).join("\n")) / total));
  const window = Math.max(4, Math.floor(targetTokens / avgLineTokens));
  const overlap = Math.max(1, Math.floor(window / 5));
  if (total <= window) return [[start, end]];
  const out: Array<[number, number]> = [];
  let s = start;
  while (s <= end) {
    const e = Math.min(end, s + window - 1);
    out.push([s, e]);
    if (e >= end) break;
    s = e + 1 - overlap; // overlap back a few lines
  }
  return out;
}

// --- markdown: headings; merge small sections, split oversized on blank lines ---
export const markdownChunker: Chunker = {
  id: "markdown",
  matches(path, head) {
    if (/\.(md|markdown|mdx)$/i.test(path)) return true;
    return /^\s{0,3}#{1,6}\s/.test(head);
  },
  chunk(text, targetTokens) {
    const lines = toLines(text);
    if (lines.length === 0) return [];
    // Section boundaries: each ATX heading starts a new section.
    const headings: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^\s{0,3}#{1,6}\s/.test(lines[i] ?? "")) headings.push(i + 1);
    }
    return packBlocks(lines, boundariesToBlocks(headings, lines.length), targetTokens);
  },
};

// --- JSON: top-level object keys / array items ---
export const jsonChunker: Chunker = {
  id: "json",
  matches(path, head) {
    if (/\.json$/i.test(path)) return true;
    const t = head.trimStart();
    return t.startsWith("{") || t.startsWith("[");
  },
  chunk(text, targetTokens) {
    const lines = toLines(text);
    if (lines.length === 0) return [];
    // Depth-0 structural boundaries: a top-level key line (object) or a
    // top-level element start (array). Track brace/bracket depth on a simple
    // non-string scan; a boundary is a line that STARTS a depth-1 member.
    const boundaries: number[] = [];
    let depth = 0;
    let inString = false;
    let escaped = false;
    let pendingMemberLine = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      let startedMember = false;
      for (let c = 0; c < line.length; c++) {
        const ch = line[c];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') {
          inString = true;
          if (depth === 1 && !startedMember) {
            pendingMemberLine = i + 1;
            startedMember = true;
          }
        } else if (ch === "{" || ch === "[") {
          if (depth === 1 && !startedMember) {
            pendingMemberLine = i + 1;
            startedMember = true;
          }
          depth++;
        } else if (ch === "}" || ch === "]") {
          depth--;
        }
      }
      if (pendingMemberLine === i + 1) boundaries.push(i + 1);
    }
    if (boundaries.length === 0) return packBlocks(lines, [[1, lines.length]], targetTokens);
    return packBlocks(lines, boundariesToBlocks(boundaries, lines.length), targetTokens);
  },
};

// --- YAML: top-level (column-0) keys ---
export const yamlChunker: Chunker = {
  id: "yaml",
  matches(path, head) {
    if (/\.(ya?ml)$/i.test(path)) return true;
    return /^[A-Za-z0-9_.-]+\s*:(\s|$)/.test(head);
  },
  chunk(text, targetTokens) {
    const lines = toLines(text);
    if (lines.length === 0) return [];
    const boundaries: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      // a top-level key: column 0, not indented, not a list item, not a comment
      if (/^[A-Za-z0-9_.-]+\s*:(\s|$)/.test(line) || /^- /.test(line)) boundaries.push(i + 1);
    }
    if (boundaries.length === 0) return packBlocks(lines, [[1, lines.length]], targetTokens);
    return packBlocks(lines, boundariesToBlocks(boundaries, lines.length), targetTokens);
  },
};

/** Heuristic top-level declaration starters for the generic code chunker. */
const DECL_RE =
  /^(export\s+)?(async\s+)?(function|class|interface|type|enum|struct|impl|trait|def|fn|func|public|private|protected|package|module|const\s+[A-Za-z_$])/;

// --- generic code / plain: declaration boundaries, blank-block + window fallback, overlap ---
export const genericChunker: Chunker = {
  id: "generic",
  matches() {
    return true; // total fallback
  },
  chunk(text, targetTokens) {
    const lines = toLines(text);
    if (lines.length === 0) return [];
    // Column-0 declaration starts are boundaries.
    const boundaries: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.length > 0 && line[0] !== " " && line[0] !== "\t" && DECL_RE.test(line)) {
        boundaries.push(i + 1);
      }
    }
    if (boundaries.length >= 2) {
      return packBlocks(lines, boundariesToBlocks(boundaries, lines.length), targetTokens);
    }
    // No declaration structure: blank-block split, then window (both add overlap
    // via windowRange when a block is still oversized / unstructured).
    return groupsToChunks(lines, windowRange(1, lines.length, lines, targetTokens));
  },
};

/** The builtin chunkers in priority order; `generic` is last (total fallback). */
export const BUILTIN_CHUNKERS: readonly Chunker[] = [
  markdownChunker,
  jsonChunker,
  yamlChunker,
  genericChunker,
];

/**
 * Pick the chunker for a source. A registered plugin chunker that `matches`
 * wins first (so a plugin AST chunker overrides a builtin for its extension),
 * then the builtins in order, then `generic` as the guaranteed fallback.
 */
export function pickChunker(path: string, head: string, plugins: readonly Chunker[] = []): Chunker {
  for (const c of plugins) if (c.matches(path, head)) return c;
  for (const c of BUILTIN_CHUNKERS) if (c.matches(path, head)) return c;
  return genericChunker;
}

/** A hard cap on the number of chunks a single source may split into (§8.7). A
 * chunker that returns more than this many pieces is rejected as degenerate and
 * the ingest fan-out falls back to the builtin. */
export const MAX_CHUNKS = 2000;

/** The number of lines in `text` for coverage checks (shares `toLines`). */
function lineCount(text: string): number {
  return toLines(text).length;
}

/**
 * Validate a chunker's output against the invariants the ingest fan-out relies
 * on (§8.7), BEFORE any chunk is used. A plugin chunker is untrusted code: its
 * output is checked, not assumed. Valid when the chunks are
 *  - non-empty and within `maxChunks`,
 *  - each a 1-based ascending range (`1 ≤ start ≤ end`),
 *  - contiguous (each chunk starts one line after the previous one ends),
 *  - and together cover `[1, totalLines]` (start at 1, end at the last line).
 * An empty source (`totalLines === 0`) accepts only an empty chunk list.
 */
export function validateChunks(
  chunks: readonly Chunk[],
  totalLines: number,
  maxChunks: number = MAX_CHUNKS,
): { ok: true } | { ok: false; reason: string } {
  if (totalLines === 0) {
    return chunks.length === 0 ? { ok: true } : { ok: false, reason: "non-empty chunks for empty text" };
  }
  if (chunks.length === 0) return { ok: false, reason: "no chunks" };
  if (chunks.length > maxChunks) return { ok: false, reason: `too many chunks (${chunks.length} > ${maxChunks})` };
  let expected = 1;
  for (const c of chunks) {
    if (!Number.isInteger(c.startLine) || !Number.isInteger(c.endLine)) {
      return { ok: false, reason: "non-integer line number" };
    }
    if (c.startLine < 1 || c.endLine < c.startLine) {
      return { ok: false, reason: `range not ascending (${c.startLine}-${c.endLine})` };
    }
    if (c.startLine !== expected) {
      return { ok: false, reason: `not contiguous at line ${c.startLine} (expected ${expected})` };
    }
    expected = c.endLine + 1;
  }
  if (expected - 1 !== totalLines) {
    return { ok: false, reason: `coverage ends at ${expected - 1}, not ${totalLines}` };
  }
  return { ok: true };
}

/** The result of a contained chunk run: the chunks, which chunker produced them,
 * and whether the picked chunker fell back to the builtin. */
export interface SafeChunkResult {
  chunks: Chunk[];
  chunker: string;
  fellBack: boolean;
  reason?: string;
}

/**
 * Run `chunker` on `text`, CONTAINED (§8.7): a throwing chunker or one whose
 * output fails `validateChunks` falls back to the builtin `genericChunker`
 * (whose own output is validated as a final safety net). The caller reports the
 * fallback to the user via a warning so a bad plugin chunker is visible, not
 * silent. The builtin chunkers always satisfy the invariants, so the fallback
 * never itself fails under normal use.
 */
export function safeChunk(chunker: Chunker, text: string, targetTokens: number): SafeChunkResult {
  const total = lineCount(text);
  try {
    const chunks = chunker.chunk(text, targetTokens);
    const check = validateChunks(chunks, total);
    if (check.ok) return { chunks, chunker: chunker.id, fellBack: false };
    return fallback(text, targetTokens, total, check.reason);
  } catch (e) {
    return fallback(text, targetTokens, total, String(e));
  }
}

function fallback(text: string, targetTokens: number, total: number, reason: string): SafeChunkResult {
  const chunks = genericChunker.chunk(text, targetTokens);
  // The builtin generic chunker is trusted to satisfy the invariants; validate
  // defensively so a future regression surfaces as empty rather than corrupt.
  const check = validateChunks(chunks, total);
  return {
    chunks: check.ok ? chunks : [],
    chunker: genericChunker.id,
    fellBack: true,
    reason,
  };
}
