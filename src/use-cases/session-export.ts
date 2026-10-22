/**
 * Session export (core-blueprint.md §10.13).
 *
 * Renders any stored session as a single self-contained, SANITIZED document a
 * user can read, archive or share. A HOST/USER operation, NEVER a model tool and
 * absent from the plugin ScopedCoreApi (the facade binds `session.export` to
 * this; it is on no tool list). READ-ONLY: it records no mutation-journal entry
 * and is not a rollback move.
 *
 * ONE sanitized document, two renderings (§10.13): export assembles one
 * `SessionExport` value, SANITIZES it once (path rewrite → secret mask →
 * unsafe-char strip → mask summary), then renders JSON (the value verbatim) and
 * Markdown (a human-readable projection) from that same sanitized value, so the
 * two formats never diverge and a secret masked in one is masked in both.
 *
 * Reuse, never reimplement (§10.13): the shared secret detector (`maskValue`,
 * §10.10), `stripUnsafeChars` (entities/untrusted-text.ts), `classifyControlPath`
 * (§9.4). Limits are internal constants (NO config key).
 */
import path from "node:path";
import { maskValue } from "./secret-mask.js";
import { stripUnsafeCharsKeepWhitespace } from "../entities/untrusted-text.js";
import { limitDefault } from "../entities/limits.js";

/** The export document shape (§10.13). `schemaVersion` bumps on an incompatible
 * change. */
export interface SessionExport {
  schemaVersion: 1;
  session: {
    id: string;
    name: string;
    workspace: "<workspace>";
    agent: string;
    createdAt: string;
    lastActiveAt: string;
    turns: number;
  };
  /** Distinct model names (no endpoints, no keys). */
  models: string[];
  /** Token totals; `cost` only when every model that ran was priced (§10.7). */
  totals: { tokensIn: number; tokensOut: number; cost?: number };
  messages: ExportMessage[];
  /** Journal METADATA only (§10.11), never before/after content. */
  writes?: ExportWrite[];
  masking: MaskSummary;
  /** Present when the document hit its byte bound and was clipped (§10.13). */
  truncatedNote?: string;
}

export interface ExportMessage {
  role: "user" | "assistant";
  turn: number;
  time: string;
  /** User text or the assistant's FINAL text; reasoning is never included. */
  text: string;
  /** Placeholders, never bytes. */
  images?: { type: "png" | "jpeg" | "gif" | "webp"; bytes: number }[];
  /** Omitted with `includeToolResults: false`. */
  toolCalls?: ExportToolCall[];
  events?: { kind: "plan" | "approval"; line: string }[];
}

/** One tool call on an export message (§10.13). */
export interface ExportToolCall {
  tool: string;
  /** Sanitized; file-content/edit bodies replaced by `{ bytes }`. */
  args: Record<string, unknown>;
  result?: { summary: string; truncated: boolean };
}

export interface ExportWrite {
  turn: number;
  time: string;
  tool: string;
  intent?: string;
  target: string;
  result: "ok" | "failed" | "refused";
  undoHint?: string;
}

export interface MaskSummary {
  secrets: Record<string, number>;
  pathsRewritten: number;
  unsafeStripped: number;
  truncatedResults: number;
}

/** The export byte bounds, resolved per call. `perResultBytes` caps each
 * tool-result summary; `documentBytes` caps the whole rendered document. */
export interface ExportLimits {
  perResultBytes: number;
  documentBytes: number;
}

/**
 * The DEFAULT export limits (§10.13) — the registry defaults for
 * `export.perResultBytes` / `export.documentBytes` (§13.11), read from the ONE
 * registry so there is no second source of truth. The facade passes the live
 * effective values via `buildSessionExport`; this constant is the standalone
 * fallback.
 */
export const EXPORT_LIMITS: ExportLimits = {
  perResultBytes: limitDefault("export.perResultBytes"),
  documentBytes: limitDefault("export.documentBytes"),
};

const MARKER_RE = /«redacted:([^»]{1,64})»/g;

/** The raw (pre-sanitize) assembled document the facade hands this module. The
 * facade owns the seams that read stored state (metadata, the message chain, the
 * journal metadata, the token totals); this module owns the sanitize + render. */
export interface RawExportInput {
  session: {
    id: string;
    name: string;
    agent: string;
    createdAt: string;
    lastActiveAt: string;
    turns: number;
  };
  models: string[];
  totals: { tokensIn: number; tokensOut: number; cost?: number };
  messages: ExportMessage[];
  writes?: ExportWrite[];
  /** The absolute home directory and workspace root, for the path rewrite
   * (§10.13 step 1). Longest-prefix-first is applied here. */
  home?: string;
  workspaceRoot: string;
}

/** A mutable counter bag threaded through the sanitize pipeline. */
interface SanitizeCounters {
  secrets: Record<string, number>;
  pathsRewritten: number;
  unsafeStripped: number;
  truncatedResults: number;
}

/**
 * Rewrite the home dir to `~` and the workspace root to `<workspace>` in one
 * string (§10.13 step 1), LONGEST-prefix first so a workspace nested under home
 * is rewritten as `<workspace>` not `~/...`. URL credentials and secret-named
 * query parameters are masked in step 2 by the shared detector, not here.
 *
 * The prefix must sit on a PATH BOUNDARY (finding 2): preceded by the start of
 * string or a non-path character, and followed by `/`, the end of string, or a
 * non-path character. So `/home/alice2/secret` is not rewritten from a
 * `/home/alice` prefix, and `prefix/home/alice/x` is not rewritten either. Only
 * real rewrites are counted.
 */
function rewritePaths(s: string, prefixes: { from: string; to: string }[], c: SanitizeCounters): string {
  let out = s;
  for (const { from, to } of prefixes) {
    if (from === "") continue;
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Boundary on both sides: a non-path char (or edge) before, and `/`/edge/
    // non-path char after. Lookarounds keep the surrounding characters intact.
    const re = new RegExp(`(^|[^A-Za-z0-9_./~-])${esc}(?=/|$|[^A-Za-z0-9_.~-])`, "g");
    out = out.replace(re, (_m, pre: string) => {
      c.pathsRewritten += 1;
      return `${pre}${to}`;
    });
  }
  return out;
}

/** Apply the secret detector to one string and tally each category masked. */
function maskStringCounting(s: string, c: SanitizeCounters): string {
  const masked = maskValue(s) as string;
  if (masked !== s) {
    for (const m of masked.matchAll(MARKER_RE)) {
      const cat = m[1]!;
      c.secrets[cat] = (c.secrets[cat] ?? 0) + 1;
    }
  }
  return masked;
}

/** Strip unsafe characters from one string, counting how many were removed. */
function stripCounting(s: string, c: SanitizeCounters): string {
  const stripped = stripUnsafeCharsKeepWhitespace(s);
  if (stripped.length !== s.length) c.unsafeStripped += s.length - stripped.length;
  return stripped;
}

/**
 * Run the full fixed sanitize pipeline over ONE string (§10.13): path rewrite,
 * then secret masking, then unsafe-character stripping. Idempotent. The order is
 * fixed so a path rewritten to `~`/`<workspace>` is not then secret-masked and a
 * masked value is not corrupted by the strip (markers carry no unsafe chars).
 */
function sanitizeString(s: string, prefixes: { from: string; to: string }[], c: SanitizeCounters): string {
  return stripCounting(maskStringCounting(rewritePaths(s, prefixes, c), c), c);
}

/** Deep-sanitize a JSON value (strings only; structure preserved). */
function sanitizeValue(v: unknown, prefixes: { from: string; to: string }[], c: SanitizeCounters): unknown {
  if (typeof v === "string") return sanitizeString(v, prefixes, c);
  if (Array.isArray(v)) return v.map((x) => sanitizeValue(x, prefixes, c));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = sanitizeValue(val, prefixes, c);
    }
    return out;
  }
  return v;
}

/**
 * Build the single SANITIZED `SessionExport` value from the raw assembled input
 * (§10.13). `includeToolResults: false` drops every tool-call `result` body
 * BEFORE sanitize (so a dropped body is never counted). Each tool-result summary
 * is bounded (64 KiB, counted in `masking.truncatedResults`); the whole document
 * is bounded (16 MiB) by dropping whole trailing turns and adding a note.
 */
export function buildSessionExport(
  input: RawExportInput,
  includeToolResults: boolean,
  limits: ExportLimits = EXPORT_LIMITS,
): SessionExport {
  const c: SanitizeCounters = { secrets: {}, pathsRewritten: 0, unsafeStripped: 0, truncatedResults: 0 };
  // LONGEST prefix first: a workspace nested under home wins the match.
  const prefixes: { from: string; to: string }[] = [];
  if (input.workspaceRoot) prefixes.push({ from: input.workspaceRoot, to: "<workspace>" });
  if (input.home) prefixes.push({ from: input.home, to: "~" });
  prefixes.sort((a, b) => b.from.length - a.from.length);

  // Clip over-bound tool-result summaries and drop result bodies when excluded,
  // BEFORE sanitize, so the counts reflect what is kept.
  const messages: ExportMessage[] = input.messages.map((m) => {
    const out: ExportMessage = { role: m.role, turn: m.turn, time: m.time, text: m.text };
    if (m.images && m.images.length > 0) out.images = m.images.map((i) => ({ ...i }));
    if (m.events && m.events.length > 0) out.events = m.events.map((e) => ({ ...e }));
    if (m.toolCalls && m.toolCalls.length > 0) {
      out.toolCalls = m.toolCalls.map((tc) => {
        const call: ExportToolCall = { tool: tc.tool, args: tc.args };
        if (includeToolResults && tc.result) {
          let summary = tc.result.summary;
          let truncated = tc.result.truncated;
          const bytes = Buffer.byteLength(summary, "utf8");
          if (bytes > limits.perResultBytes) {
            summary = Buffer.from(summary, "utf8").subarray(0, limits.perResultBytes).toString("utf8");
            truncated = true;
            c.truncatedResults += 1;
          }
          call.result = { summary, truncated };
        }
        return call;
      });
    }
    return out;
  });

  // The pre-sanitize document.
  const doc: SessionExport = {
    schemaVersion: 1,
    session: {
      id: input.session.id,
      name: input.session.name,
      workspace: "<workspace>",
      agent: input.session.agent,
      createdAt: input.session.createdAt,
      lastActiveAt: input.session.lastActiveAt,
      turns: input.session.turns,
    },
    models: input.models,
    totals: input.totals,
    messages,
    ...(input.writes && input.writes.length > 0 ? { writes: input.writes } : {}),
    masking: { secrets: {}, pathsRewritten: 0, unsafeStripped: 0, truncatedResults: 0 },
  };

  // SANITIZE the assembled document ONCE (every string field). `session.id`,
  // numbers, and the fixed `<workspace>` marker ride through unchanged; model
  // names, text, args, write targets/intents all pass the pipeline.
  doc.session.name = sanitizeString(doc.session.name, prefixes, c);
  doc.session.agent = sanitizeString(doc.session.agent, prefixes, c);
  doc.models = doc.models.map((m) => sanitizeString(m, prefixes, c));
  doc.messages = doc.messages.map((m) => {
    const out: ExportMessage = { ...m, text: sanitizeString(m.text, prefixes, c) };
    if (m.toolCalls) {
      out.toolCalls = m.toolCalls.map((tc) => ({
        tool: sanitizeString(tc.tool, prefixes, c),
        args: sanitizeValue(tc.args, prefixes, c) as Record<string, unknown>,
        ...(tc.result ? { result: { summary: sanitizeString(tc.result.summary, prefixes, c), truncated: tc.result.truncated } } : {}),
      }));
    }
    if (m.events) out.events = m.events.map((e) => ({ kind: e.kind, line: sanitizeString(e.line, prefixes, c) }));
    return out;
  });
  if (doc.writes) {
    doc.writes = doc.writes.map((w) => ({
      turn: w.turn,
      time: w.time,
      tool: sanitizeString(w.tool, prefixes, c),
      ...(w.intent !== undefined ? { intent: sanitizeString(w.intent, prefixes, c) } : {}),
      target: sanitizeString(w.target, prefixes, c),
      result: w.result,
      ...(w.undoHint !== undefined ? { undoHint: sanitizeString(w.undoHint, prefixes, c) } : {}),
    }));
  }
  doc.masking = { secrets: c.secrets, pathsRewritten: c.pathsRewritten, unsafeStripped: c.unsafeStripped, truncatedResults: c.truncatedResults };

  // Document byte bound: drop whole trailing turns until it fits, adding a note.
  enforceDocumentBound(doc, limits);
  return doc;
}

/** Drop whole trailing turns until the rendered JSON fits the document bound,
 * then record a one-line truncation note (§10.13). */
function enforceDocumentBound(doc: SessionExport, limits: ExportLimits): void {
  const size = (): number => Buffer.byteLength(JSON.stringify(doc), "utf8");
  if (size() <= limits.documentBytes) return;
  const originalTurns = doc.messages.length > 0 ? doc.messages[doc.messages.length - 1]!.turn : 0;
  while (doc.messages.length > 0 && size() > limits.documentBytes) {
    const lastTurn = doc.messages[doc.messages.length - 1]!.turn;
    // Drop every message of the last turn at once.
    while (doc.messages.length > 0 && doc.messages[doc.messages.length - 1]!.turn === lastTurn) {
      doc.messages.pop();
    }
  }
  const keptTurns = doc.messages.length > 0 ? doc.messages[doc.messages.length - 1]!.turn : 0;
  doc.truncatedNote = `export truncated at ${keptTurns} turns (of ${originalTurns}); the document exceeded ${limits.documentBytes} bytes`;
}

/** Render the sanitized value verbatim as pretty JSON (§10.13). */
export function renderJson(doc: SessionExport): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

/**
 * Markdown hardening (§10.13, finding 1). The sanitize pipeline removes secrets
 * and terminal-dangerous control bytes, but the Markdown projection must not let
 * untrusted text break the document's STRUCTURE or carry active HTML. Trusted
 * structure (headings, labels, bullets) is emitted plain; every untrusted value
 * is wrapped so it is inert:
 *   - multi-line text → a fenced code block whose fence is longer than any
 *     backtick run inside it (so an embedded ``` cannot close it early);
 *   - one-line text → an inline code span with a backtick run longer than any
 *     inside it (so `<script>`, `##`, `[x](y)` render as literal code).
 * A value with no backticks and no newline still gets a single-backtick span.
 * JSON is UNCHANGED — this is projection-only.
 */

/** The longest run of consecutive backticks in a string (0 when none). */
function longestBacktickRun(s: string): number {
  let max = 0;
  let cur = 0;
  for (const ch of s) {
    if (ch === "`") {
      cur += 1;
      if (cur > max) max = cur;
    } else {
      cur = 0;
    }
  }
  return max;
}

/** Wrap untrusted MULTI-LINE text in a fenced block that the content cannot
 * close early (fence length = longest inner backtick run + 1, min 3). */
function fencedBlock(s: string): string[] {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(s) + 1));
  return [fence, ...s.split("\n"), fence];
}

/** Wrap untrusted ONE-LINE text as an inline code span with a backtick run
 * longer than any inside it; a leading/trailing backtick gets padding spaces so
 * the span is well-formed. */
function inlineCode(s: string): string {
  const run = longestBacktickRun(s);
  const ticks = "`".repeat(run + 1);
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return `${ticks}${pad}${s}${pad}${ticks}`;
}

/** Render an untrusted value for Markdown: a fenced block if it spans multiple
 * lines, else an inline code span. Returns the lines to push. */
function untrustedLines(s: string): string[] {
  return s.includes("\n") ? fencedBlock(s) : [inlineCode(s)];
}

/** Render the sanitized value as a human-readable Markdown projection (§10.13).
 * Every field comes from the SAME sanitized value, so a secret masked in JSON is
 * masked here too. Untrusted text is fenced/inline-coded so it cannot break
 * structure or carry active HTML (finding 1). */
export function renderMarkdown(doc: SessionExport): string {
  const L: string[] = [];
  L.push(`# Session ${doc.session.id} — ${inlineCode(doc.session.name)}`);
  L.push("");
  L.push(`- workspace: ${doc.session.workspace}`);
  L.push(`- agent: ${inlineCode(doc.session.agent)}`);
  L.push(`- created: ${doc.session.createdAt}`);
  L.push(`- last active: ${doc.session.lastActiveAt}`);
  L.push(`- turns: ${doc.session.turns}`);
  L.push(`- models: ${doc.models.length > 0 ? doc.models.map((m) => inlineCode(m)).join(", ") : "(none)"}`);
  const cost = doc.totals.cost !== undefined ? `, cost ${doc.totals.cost}` : "";
  L.push(`- tokens: ${doc.totals.tokensIn} in / ${doc.totals.tokensOut} out${cost}`);
  if (doc.truncatedNote) L.push(`- note: ${doc.truncatedNote}`);
  L.push("");
  L.push("## Conversation");
  L.push("");
  for (const m of doc.messages) {
    L.push(`### ${m.role} · turn ${m.turn} · ${m.time}`);
    if (m.text) {
      L.push("");
      // Untrusted message text: fenced (multi-line) or inline code (one-line).
      for (const line of untrustedLines(m.text)) L.push(line);
    }
    if (m.images && m.images.length > 0) {
      L.push("");
      for (const img of m.images) L.push(`- image: ${img.type} (${img.bytes} bytes)`);
    }
    if (m.toolCalls && m.toolCalls.length > 0) {
      L.push("");
      for (const tc of m.toolCalls) {
        L.push(`- tool ${inlineCode(tc.tool)}: ${inlineCode(JSON.stringify(tc.args))}`);
        if (tc.result) {
          const t = tc.result.truncated ? " (truncated)" : "";
          // Tool-result summaries are untrusted; fence/inline them.
          const resLines = untrustedLines(tc.result.summary);
          if (resLines.length === 1) {
            L.push(`  - result${t}: ${resLines[0]}`);
          } else {
            L.push(`  - result${t}:`);
            for (const line of resLines) L.push(line);
          }
        }
      }
    }
    if (m.events && m.events.length > 0) {
      L.push("");
      for (const e of m.events) L.push(`- ${e.kind}: ${inlineCode(e.line)}`);
    }
    L.push("");
  }
  if (doc.writes && doc.writes.length > 0) {
    L.push("## Writes");
    L.push("");
    for (const w of doc.writes) {
      const intent = w.intent ? ` — ${inlineCode(w.intent)}` : "";
      const hint = w.undoHint ? ` (undo: ${inlineCode(w.undoHint)})` : "";
      L.push(`- turn ${w.turn} · ${w.time} · ${inlineCode(w.tool)} → ${inlineCode(w.target)} [${w.result}]${intent}${hint}`);
    }
    L.push("");
  }
  L.push("## Masking");
  L.push("");
  const secretLines = Object.entries(doc.masking.secrets);
  if (secretLines.length > 0) {
    for (const [cat, n] of secretLines) L.push(`- secrets masked (${inlineCode(cat)}): ${n}`);
  } else {
    L.push("- secrets masked: 0");
  }
  L.push(`- paths rewritten: ${doc.masking.pathsRewritten}`);
  L.push(`- unsafe characters stripped: ${doc.masking.unsafeStripped}`);
  L.push(`- tool results truncated: ${doc.masking.truncatedResults}`);
  L.push("");
  return L.join("\n");
}

/** Normalize an absolute path for the symlink/containment check used by the
 * writer; a trailing slash is stripped. */
export function normalizeOutPath(workspaceRoot: string, out: string): string {
  return path.isAbsolute(out) ? out : path.resolve(workspaceRoot, out);
}
