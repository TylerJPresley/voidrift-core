/**
 * Large-result eviction — the pure decision logic (core-blueprint.md §8.3).
 *
 * The engine runs on `createAgent`, not deepagents' `createDeepAgent`, so
 * deepagents' `toolTokenLimitBeforeEvict` never fires: a large tool result that
 * is not line-bounded (a big `execute_command` or `search_contents`) would ride
 * INLINE into the model request. This entity decides when a result is large
 * enough to pressure the window and shapes the handle the model sees in its
 * place — one rule for every tool so no two tools handle a large result
 * differently (§8.3).
 *
 * Pure and host-free (§1 rule 1): no `node:fs`, no model. Token sizing reuses
 * the §4.8 last-resort counter (`estimateTokens`); the filename reuses the ONE
 * hash utility (`contentHash`, §8.2); masking reuses the ONE secret detector
 * (`maskText`, §10.10). The write (atomic, mode 0600) is the adapter's job,
 * wired in `boot.ts`.
 */
import { contentHash } from "./hash.js";
import { estimateTokens } from "./context/budget.js";

/** The eviction fit threshold in tokens: `fitFraction` of the live available
 * budget (§8.3, §8.7, §4.8). A result within this many tokens fits whole; a
 * larger one is evicted. `availableBudget` is `window − used − output
 * reservation` (`ContextPipeline.availableBudget`). */
export function evictionThresholdTokens(availableBudget: number, fitFraction: number): number {
  return Math.floor(availableBudget * fitFraction);
}

/**
 * Whether a tool result is large enough to evict (§8.3). One delivery rule for
 * every path: a result is delivered WHOLE when it fits the remaining window —
 * the same fit test every other load uses, `limits.ingest.fitFraction` of the
 * live available budget (§4.8, §8.7) — and `true` (evict) only when its token
 * count (the §4.8 last-resort counter) does NOT fit. The test runs on the live
 * available budget (`window − used − output reservation`), so the threshold
 * tracks real headroom: a small local window evicts far earlier than a large
 * hosted one, and small output on a model with room is never evicted.
 */
export function shouldEvict(content: string, opts: { availableBudget: number; fitFraction: number }): boolean {
  const tokens = estimateTokens(content);
  const threshold = evictionThresholdTokens(opts.availableBudget, opts.fitFraction);
  // No headroom (budget or fraction non-positive): anything non-trivial cannot
  // fit, so it MUST evict — the opposite of a share-of-the-window cap, which
  // never evicted when the window was exhausted (the overflow that followed).
  if (threshold <= 0) return tokens > 0;
  return tokens > threshold;
}

/**
 * The deterministic cache filename for an evicted result (§8.3, §4.2.1). The
 * name is derived from the ONE hash utility over the FULL result content, never
 * from the model-controlled `tool_call.id` (which is untrusted — `../../x`, an
 * absolute path, or a NUL byte must not escape the cache dir). Same content ⇒
 * same name, so a handle is reproducible.
 */
export function evictionCacheName(content: string): string {
  return `tool-${contentHash(content).slice(0, 32)}.txt`;
}

/** The workspace-relative pointer to an evicted result, the ONE handle format
 * shared with compaction step 1 (§4.9, §4.2.1). */
export function evictionCachePath(sessionId: string, name: string): string {
  return `.voidrift/cache/session/${sessionId}/${name}`;
}

/** The artifact that rides the ToolMessage but NEVER reaches the model (§8.3). */
export interface EvictionArtifact {
  path: string;
  size: number;
  hash: string;
}

/** The result of shaping an eviction: the model-facing handle, the full masked
 * body to persist, the cache name, and the harness-side artifact (§8.3). */
export interface Eviction {
  /** The short handle the model sees in place of the full result (§8.3). */
  handle: string;
  /** The FULL result, masked, to write to the cache file (§10.10). */
  maskedBody: string;
  /** The cache filename (hash-derived, id-independent). */
  name: string;
  /** `{ path, size, hash }` — travels as the ToolMessage artifact, never to the model. */
  artifact: EvictionArtifact;
}

/** The INTERNAL per-excerpt-line character cap (§8.3). Not a config key — the
 * former `context.excerptLineMaxChars` key was removed (one delivery rule, P2) —
 * but the HANDLE itself must stay bounded, so a single enormous line (a 300k
 * `tr`-filled command output with no newlines) is still clipped in the excerpt
 * while the FULL body is cached off-model. Derived constant, never configurable. */
const EXCERPT_LINE_MAX_CHARS = 2000;

/** Trim a body to its first `head` and last `tail` lines, joined by an elision
 * note (§8.3). Each excerpt line is clipped at the internal `EXCERPT_LINE_MAX_CHARS`
 * so the handle stays bounded even when the body is one enormous line; the FULL
 * body is cached off-model regardless. When the body already fits (few short
 * lines), it is returned whole. */
function headTail(body: string, head: number, tail: number): string {
  const cap = (line: string): string =>
    line.length <= EXCERPT_LINE_MAX_CHARS
      ? line
      : `${line.slice(0, EXCERPT_LINE_MAX_CHARS)}… [${line.length - EXCERPT_LINE_MAX_CHARS} more chars on this line]`;
  const lines = body.split("\n");
  if (lines.length <= head + tail) {
    const capped = lines.map(cap);
    return capped.every((l, i) => l === lines[i]) ? body : capped.join("\n");
  }
  const omitted = lines.length - head - tail;
  const top = lines.slice(0, head).map(cap);
  const bottom = lines.slice(lines.length - tail).map(cap);
  return [...top, `… [${omitted} lines omitted — read the cache file for the full result] …`, ...bottom].join("\n");
}

/**
 * Shape an evicted result into its handle + artifact (§8.3). The FULL result is
 * masked once (`mask`) — the cache file persists on disk, so a value the §10.10
 * detector recognizes must never land there as plaintext (the blueprint masks
 * before any record is persisted). The head/tail excerpts are taken from the
 * ALREADY-MASKED body, so the handle the model sees carries no secret either.
 * The artifact's `size` and `hash` describe the masked body actually written.
 */
export function evict(
  content: string,
  opts: {
    sessionId: string;
    headLines: number;
    tailLines: number;
    mask: (s: string) => string;
  },
): Eviction {
  const maskedBody = opts.mask(content);
  const name = evictionCacheName(maskedBody);
  const relPath = evictionCachePath(opts.sessionId, name);
  const excerpt = headTail(maskedBody, opts.headLines, opts.tailLines);
  const size = Buffer.byteLength(maskedBody, "utf8");
  const tokens = estimateTokens(maskedBody);
  const handle = [
    `[tool result evicted — ${size} chars / ~${tokens} tokens, cached at ${relPath}]`,
    excerpt,
    `[Inspect the full result with read_file ${relPath} or grep over it; this handle is a bounded excerpt.]`,
  ].join("\n");
  return {
    handle,
    maskedBody,
    name,
    artifact: { path: relPath, size, hash: contentHash(maskedBody) },
  };
}

/**
 * The ONE eviction gate (§8.3 "one policy, every path"). Returns an {@link
 * Eviction} when `content` is large enough to pressure the window, else `null`
 * (left untouched). Every content path — a direct tool, a worker tool, an MCP
 * tool/resource read, a plugin tool, shell output, a web fetch/search, and a
 * `read_file` body — routes string-shaped results through THIS one function via
 * the decision point, so no path has a private cap and none bypasses (the
 * Gemini-CLI two-paths-one-policy failure). The pass-by-reference run-cache
 * sites (task brief/dep/batch, command output, web page) bound BEFORE the result
 * reaches the gate and ride through it already shaped; this gate is the final
 * backstop that catches anything else.
 */
export function applyResultPolicy(
  content: string,
  opts: {
    sessionId: string;
    availableBudget: number;
    fitFraction: number;
    headLines: number;
    tailLines: number;
    mask: (s: string) => string;
  },
): Eviction | null {
  if (!shouldEvict(content, { availableBudget: opts.availableBudget, fitFraction: opts.fitFraction })) return null;
  return evict(content, {
    sessionId: opts.sessionId,
    headLines: opts.headLines,
    tailLines: opts.tailLines,
    mask: opts.mask,
  });
}

/** One MCP content block (§8.4). The SDK returns an array of these; a `text`
 * block carries `text`, an `image` block carries base64 `data`, and an embedded
 * `resource` block carries `text` or base64 `blob`. */
interface McpContentBlock {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
}

/** Decode the byte length of a base64 payload WITHOUT allocating the buffer. */
function base64Bytes(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - pad;
}

/**
 * Flatten an MCP tool-call content array to the string the model sees (§8.4,
 * §8.3). A `text` block passes through. An `image` or embedded binary
 * `resource` block is NEVER embedded as base64 — the raw payload would blow the
 * window straight past the eviction gate (the two-paths failure) — it is
 * replaced by an explicit bounded **marker** naming its mime type and decoded
 * byte size: `[mcp image: <mime>, <N> bytes — omitted]`. The `imageMaxBytes`
 * cap (the `tools.imageMaxBytes` registry key, §13.11) is named in the marker so
 * the bound is visible. Text-bearing resources keep their text (it rides the
 * normal string gate). A non-array input falls back to `String()`.
 */
export function flattenMcpContent(content: unknown, opts: { imageMaxBytes: number }): string {
  if (!Array.isArray(content)) return String(content ?? "");
  const parts: string[] = [];
  for (const raw of content as McpContentBlock[]) {
    const block = raw ?? {};
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (block.type === "image" && typeof block.data === "string") {
      const bytes = base64Bytes(block.data);
      const mime = block.mimeType ?? "application/octet-stream";
      parts.push(`[mcp image: ${mime}, ${bytes} bytes — omitted (cap tools.imageMaxBytes=${opts.imageMaxBytes})]`);
      continue;
    }
    if (block.type === "resource" && block.resource) {
      const r = block.resource;
      if (typeof r.text === "string") {
        parts.push(r.text);
        continue;
      }
      const bytes = typeof r.blob === "string" ? base64Bytes(r.blob) : 0;
      const mime = r.mimeType ?? "application/octet-stream";
      const uri = r.uri ?? "";
      parts.push(`[mcp resource: ${uri} ${mime}, ${bytes} bytes — omitted (cap tools.imageMaxBytes=${opts.imageMaxBytes})]`);
      continue;
    }
    // Any other block type: a compact JSON fallback, but never a huge base64
    // field — strip `data`/`blob` so an unknown binary shape can't slip through.
    const { data, resource, ...rest } = block;
    void data;
    void resource;
    parts.push(JSON.stringify(rest));
  }
  return parts.join("\n");
}
