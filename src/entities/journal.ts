/**
 * The mutation journal — entity layer (core-blueprint.md §10.11).
 *
 * An append-only, per-session record of every WRITE action so a change can be
 * reverted without a version-control system. It is SEPARATE from the
 * observability trail (§10.3): the trail is the neutral, masked, exporter-facing
 * record of what happened; the journal is a protected, RAW local store of how to
 * undo it. This module is pure (no I/O): it defines the entry shape, the capture
 * limits, content-addressing, truncation, and binary/over-cap detection. The
 * `JournalStore` port (ports/journal-store.ts) and its adapters do the I/O.
 *
 * RAW storage stance (same as checkpoint.db): the journal is stored UNMASKED so
 * a revert can restore real contents including secrets. It never crosses into
 * the masked observability trail or any exporter payload (§10.10) — the two
 * stores never mix.
 */
import { createHash } from "node:crypto";

/** The content-capture level (§10.11, §13.10). A config scalar
 * (`mutationLogLevel`). */
export type MutationLogLevel = "off" | "turn" | "action";

/**
 * Internal, fixed journal limits (§10.11). NOT configuration — a new config key
 * needs a demonstrated need (AGENTS.md), and these are harness invariants. One
 * exported object so a consumer reads a single source of truth.
 */
export const JOURNAL_LIMITS = {
  /** Per-target content cap: 1 MiB. Over the cap, the first 1 MiB is stored,
   * `truncated: true` is set, and the overflow is dropped with a note. */
  perTargetContentBytes: 1024 * 1024,
  /** Per-session retention: at most 20,000 entries kept. */
  maxEntries: 20_000,
  /** Per-session blob retention: at most 512 MiB of blob bytes; when exceeded,
   * the OLDEST blobs are deleted first. */
  maxBlobBytes: 512 * 1024 * 1024,
  /** Bytes of a target inspected for a NUL to classify it binary. */
  binarySniffBytes: 8 * 1024,
  /** Per (session, worker, turn) turn-net aggregator cap: at most 2,000 distinct
   * targets are netted. Targets beyond the cap are journaled per-action metadata
   * only; ONE `turn-net-cap` note entry at flush states how many were not netted
   * (§10.11). Bounds aggregator memory on a pathological fan-out turn. */
  turnNetMaxTargets: 2_000,
} as const;

/** The result of a tool-call execution, recorded on the entry (§10.11). */
export interface JournalResult {
  status: "ok" | "error" | "denied-after-start";
  summary: string;
}

/** The before/after blob references on an entry (sha256-hex of RAW content). */
export interface JournalBlobs {
  before?: string;
  after?: string;
}

/**
 * One journal entry (§10.11). Metadata is ALWAYS written, at every level
 * including `off`. `call` carries the exact command or the tool args with file
 * CONTENT and edit text REPLACED by `{ bytes, sha256 }` — never the content
 * itself; content lives only in blobs (content-addressed). `blobs` is present
 * only when content was captured (`action`/`turn`).
 */
export interface JournalEntry {
  seq: number;
  time: string;
  sessionId: string;
  turn: number;
  workerId?: string;
  /** The plan step id/intent driving the write, when the plan plugin exposes
   * one in the run context; absent otherwise (§10.11). */
  planStep?: string;
  tool: string;
  /** Exact command / tool args with content fields replaced by byte-len+sha256. */
  call: Record<string, unknown>;
  target: string;
  result: JournalResult;
  /** An undo hint the harness or the tool supplied (§10.11). */
  undoHint?: string;
  blobs?: JournalBlobs;
  /** Set when a captured content exceeded the per-target cap and was clipped. */
  truncated?: boolean;
  /** Set on an entry whose captured blob(s) were evicted by retention. */
  blobsEvicted?: boolean;
  /** The count of per-action writes a `turn-net` entry merged (§10.11). */
  actions?: number;
  /** A free-text note on the entry: `"no net change"` for a target whose first
   * and last content match (or created-then-deleted), or the reason an
   * after-state could not be captured. */
  note?: string;
  /** Set on an `edit_file` entry whose post-write after-state read failed
   * (§10.11): the after blob is absent and a WARNING was surfaced. */
  afterUnavailable?: boolean;
}

/** The sha256-hex of RAW bytes — the content-addressing key for a blob. */
export function blobHash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Whether a target's content is BINARY: a NUL byte within the first
 * `binarySniffBytes`. Binary targets fall back to `turn` granularity even at
 * `action` (§10.11).
 */
export function isBinaryContent(content: Buffer): boolean {
  const end = Math.min(content.length, JOURNAL_LIMITS.binarySniffBytes);
  for (let i = 0; i < end; i++) {
    if (content[i] === 0) return true;
  }
  return false;
}

/** A captured blob after applying the per-target cap. `truncated` marks a clip;
 * the overflow is dropped (§10.11). */
export interface CapturedBlob {
  sha: string;
  bytes: Buffer;
  truncated: boolean;
}

/**
 * Apply the per-target content cap: store the first 1 MiB when over, mark
 * `truncated`, and content-address the STORED bytes (so the cap is part of the
 * identity — a clipped copy and the full copy differ). The overflow is dropped.
 */
export function captureBlob(content: Buffer, perTargetContentBytes = JOURNAL_LIMITS.perTargetContentBytes): CapturedBlob {
  const cap = perTargetContentBytes;
  if (content.length > cap) {
    const clipped = content.subarray(0, cap);
    return { sha: blobHash(clipped), bytes: clipped, truncated: true };
  }
  return { sha: blobHash(content), bytes: content, truncated: false };
}

/**
 * The effective capture decision for a file target at a given level (§10.11).
 * `off` → no content. `turn` → net-at-turn. `action` → per-write, UNLESS the
 * target is binary or over the per-target cap, which both fall back to `turn`.
 * This governs where a file tool's content blobs are recorded; non-file tools
 * (execute_command, MCP, plugin) never capture content here.
 */
export function captureGranularity(
  level: MutationLogLevel,
  content: Buffer | undefined,
  perTargetContentBytes = JOURNAL_LIMITS.perTargetContentBytes,
): "none" | "action" | "turn" {
  if (level === "off") return "none";
  if (level === "turn") return "turn";
  // level === "action": fall back to turn for binary or over-cap targets.
  if (content && (isBinaryContent(content) || content.length > perTargetContentBytes)) {
    return "turn";
  }
  return "action";
}

/**
 * Replace a file-content / edit-text field in tool args with its byte length +
 * sha256, so the recorded `call` never holds content. Non-string values pass
 * through unchanged. The content itself lives only in a blob (§10.11).
 */
export function redactContentFields(
  args: Record<string, unknown>,
  contentKeys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (contentKeys.includes(k) && typeof v === "string") {
      const buf = Buffer.from(v, "utf8");
      out[k] = { bytes: buf.length, sha256: blobHash(buf) };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** The content-bearing arg keys per tool, for `redactContentFields` (§8.2). */
export const CONTENT_ARG_KEYS: Record<string, readonly string[]> = {
  write_file: ["content"],
  edit_file: ["search", "replace"],
  researcher_save_notes: ["content"],
};

// The journal's `isWriteAction` (decision-point.ts) is intentionally BROADER
// than the lane/isolation `WRITE_CLASS_TOOLS` (chat-lane.ts / subagents.ts):
// the lane only needs the direct-write tools it caps (write_file/edit_file/
// execute_command), while the journal must record EVERY mutating effect it may
// later have to revert — also researcher_save_notes, merge/apply, and every MCP
// or plugin tool (treated as mutating) — so undo coverage is never narrower
// than the set of things that can change the world.

/**
 * Compute a retention plan for a session's blobs (§10.11). Given the blobs in
 * append order with their byte sizes and the entries that reference them, decide
 * which blob shas to EVICT (oldest first) so total blob bytes drop to within the
 * cap, and which entry seqs lose a referenced blob (so they are marked
 * `blobsEvicted`). Entries themselves are never deleted for the byte cap; the
 * entry-count cap is handled separately by the store. Content-addressed: a sha
 * referenced by a still-live entry is only counted once.
 */
export interface RetentionInput {
  /** Blobs in append order: sha + size in bytes. */
  blobs: { sha: string; bytes: number }[];
  /** Live references: sha → set of entry seqs referencing it. */
  refs: Map<string, Set<number>>;
  /** Shas the live turn aggregator still holds (a first-before or pending-after
   * blob) that have no referencing `turn-net` entry yet. These are NEVER
   * evicted mid-turn, even when over the byte cap — the referencing entry is
   * appended at flush and the blob must survive until then (§10.11). */
  pinned?: ReadonlySet<string>;
}

export interface RetentionPlan {
  evictShas: string[];
  evictedEntrySeqs: Set<number>;
}

export function planBlobRetention(input: RetentionInput, maxBlobBytes = JOURNAL_LIMITS.maxBlobBytes): RetentionPlan {
  let total = input.blobs.reduce((s, b) => s + b.bytes, 0);
  const pinned = input.pinned;
  const evictShas: string[] = [];
  const evictedEntrySeqs = new Set<number>();
  for (const b of input.blobs) {
    if (total <= maxBlobBytes) break;
    if (pinned?.has(b.sha)) continue; // a live-aggregator blob is never evicted
    evictShas.push(b.sha);
    total -= b.bytes;
    for (const seq of input.refs.get(b.sha) ?? []) evictedEntrySeqs.add(seq);
  }
  return { evictShas, evictedEntrySeqs };
}

/** A blob name is a content-address: EXACTLY 64 lowercase hex chars (sha256).
 * A name failing this is rejected BEFORE any `path.join` so a `../…`, uppercase,
 * short-hex, or NUL-bearing value can never build a traversal path (LOW-1). */
const SHA256_HEX = /^[0-9a-f]{64}$/;
export function isBlobSha(sha: unknown): sha is string {
  return typeof sha === "string" && SHA256_HEX.test(sha);
}

/**
 * Sanitize a model-visible error message (LOW-2). A raw `String(e)` can echo an
 * absolute path outside the workspace (e.g. `/etc/shadow` in an EACCES message)
 * into the model's context. Keep the error's own `message`, cap it at 200 chars,
 * and replace any absolute path that is NOT under `workspaceRoot` with `<path>`.
 * The in-workspace TARGET is named by the caller separately (never redacted).
 */
export function sanitizeJournalErrorMessage(e: unknown, workspaceRoot?: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  // Match POSIX absolute paths and Windows drive paths in the message.
  const withPlaceholders = raw.replace(/(?:[A-Za-z]:)?(?:\/[^\s"'`]+|\\[^\s"'`]+)/g, (m) => {
    if (workspaceRoot && (m === workspaceRoot || m.startsWith(workspaceRoot + "/") || m.startsWith(workspaceRoot + "\\"))) {
      return m; // an in-workspace path is safe to name
    }
    return "<path>";
  });
  return withPlaceholders.slice(0, 200);
}
