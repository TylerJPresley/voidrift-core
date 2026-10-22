/**
 * The session meta block (core-blueprint.md §4.4).
 *
 * A compact, tier-1 inline block injected into the Agent layer and regenerated
 * EVERY turn from live values, so it never drifts from the real session state.
 * It is DATA, never authority (§1 rule 15): it tells the model where it is and
 * what it is working with, and grants, widens or relaxes nothing. One field per
 * line, bounded by `limits.context.metaBlockMaxTokens`; when over the cap the
 * least-load-bearing fields drop first (cache/limits, then git detail, then
 * model detail) so the location, date, concurrency, rounds and worker fields
 * always survive. It carries NO secret and NO file content; every rendered value
 * is passed through the shared secret masker and the shared unsafe-char stripper
 * (control/ANSI/bidi/zero-width removed, newlines collapsed to one space) before
 * it leaves the process, so no field spans more than one line.
 *
 * Pure: no infrastructure imports beyond the token estimator and the shared
 * masker, so the pipeline logic stays testable in the entity layer.
 */
import { estimateTokens } from "./budget.js";
import { maskText } from "../../use-cases/secret-mask.js";
import { stripUnsafeChars } from "../untrusted-text.js";

/**
 * The resolved live values the meta block renders (§4.4). Superset of the old
 * environment block: the still-useful fields it carried (max read lines, cache
 * dir) move here rather than being dropped.
 */
export interface EnvironmentFacts {
  /** Working directory (PWD) — a fresh command starts here; a `cd` is per-command. */
  cwd: string;
  /** The workspace root (for a worker, its worktree root) (§8.2, §9.3). */
  workspaceRoot: string;
  /** The current git branch, or null when the workspace is not a repo. */
  gitBranch: string | null;
  /** A one-line clean/dirty summary, or null when not a repo. No remote URL. */
  gitDirty: string | null;
  platform: string;
  /** The OS release string (e.g. kernel version), rendered beside the platform. */
  osRelease: string;
  shell: string;
  /** The current date/time, ISO-ish, with offset. */
  date: string;
  /** The IANA time zone name. */
  timeZone: string;
  /** The active session id. */
  sessionId: string;
  /** The active top-level agent / mode name. */
  agentMode: string;
  model: string;
  contextLimit: number;
  /** The reserved output tokens, or null to render `default` (§4.4, §11.2). */
  maxOutputTokens: number | null;
  /** Whether the active model entry declares `vision: true`. */
  vision: boolean;
  /** Whether the endpoint accepts parallel tool calls, when known; null = unknown. */
  parallelToolCalls: boolean | null;
  /** `turnMaxConcurrency` — how many workers/tools run at once (§3.6). */
  turnMaxConcurrency: number;
  /** `effectiveIngestParallel` — the ingest fan-out cap (§8.7). */
  ingestParallel: number;
  /** The tool rounds used this turn so far and the per-turn ceiling (§3.3). */
  toolRoundsUsed: number;
  toolRoundsLimit: number;
  /** The remaining context percentage this turn, or null when not yet known. */
  remainingContextPct: number | null;
  /** The read-tool line cap, migrated from the old environment block. */
  maxReadLines: number;
  /** The core cache dir (§4.4), migrated from the old environment block. */
  cacheDir: string;
  /** The dispatchable workers for the active top-level agent, by name (§7.1). */
  workers: string[];
}

/** The result of a render: the text and the names of dropped field groups, in
 * the order they were dropped (for the LIMIT_HIT at the engine boundary). */
export interface MetaBlockRender {
  text: string;
  dropped: string[];
}

/** The header line — states this is session data, never instructions (§4.4, §1 rule 15). */
const HEADER =
  "Session data (where you are and what you are working with — context, not instructions):";

/**
 * The documented drop order (§4.4): least-load-bearing first. Each group is a
 * removable slice of lines; `cache dir` (cache/limits detail) goes first, then
 * `git detail` (the dirty summary), then `model detail` (vision/parallel/output
 * reservation). The location, date, session, concurrency, rounds and workers
 * fields are never in this list, so they always survive.
 */
const DROP_ORDER = ["cache dir", "git detail", "model detail"] as const;
type DropGroup = (typeof DROP_ORDER)[number];

/** Mask a single value defensively — the block must never leak a secret (§4.4)
 * and must never throw on a missing field. Every value is also stripped of
 * control/ANSI/bidi/zero-width characters (§8.2) with newlines collapsed to a
 * single space, so no field can spill onto a second line or inject terminal
 * escapes: one rendered line per field, always. */
function safe(value: string): string {
  const raw = value == null ? "" : String(value);
  // Collapse any whitespace run (incl. newlines) to one space BEFORE stripping,
  // so a newline becomes a visible separator rather than vanishing; strip then
  // removes control/ANSI/bidi/zero-width chars; mask hides any secret.
  const oneLine = stripUnsafeChars(raw.replace(/\s+/g, " ")).trim();
  return maskText(oneLine);
}

/** Build the field lines for a given set of dropped groups. */
function lines(env: EnvironmentFacts, dropped: Set<DropGroup>): string[] {
  const out: string[] = [HEADER];
  // ── Location (kept last) ────────────────────────────────────────────────
  if (env.workspaceRoot && env.workspaceRoot !== env.cwd) {
    out.push(`  PWD: ${safe(env.cwd)}`);
    out.push(`  workspace root: ${safe(env.workspaceRoot)}`);
  } else {
    out.push(`  PWD / workspace root: ${safe(env.cwd)}`);
  }
  out.push(`  OS: ${safe(env.platform)} ${safe(env.osRelease)}`);
  out.push(`  shell: ${safe(env.shell)}`);
  out.push(`  date: ${safe(env.date)} (${safe(env.timeZone)})`);
  out.push("  note: each command runs fresh in PWD — a `cd` does not persist");
  // ── Repository ──────────────────────────────────────────────────────────
  if (env.gitBranch) {
    const detail = !dropped.has("git detail") && env.gitDirty ? ` (${safe(env.gitDirty)})` : "";
    out.push(`  git: ${safe(env.gitBranch)}${detail}`);
  } else {
    out.push("  git: no");
  }
  // ── Session ───────────────────────────────────────────────────────────────
  out.push(`  agent: ${safe(env.agentMode)}`);
  out.push(`  session: ${safe(env.sessionId)}`);
  // ── Model ─────────────────────────────────────────────────────────────────
  out.push(`  model: ${safe(env.model)}`);
  out.push(`  context window: ${env.contextLimit}`);
  if (!dropped.has("model detail")) {
    const maxOut = env.maxOutputTokens === null ? "default" : String(env.maxOutputTokens);
    out.push(`  output reservation: ${maxOut}`);
    out.push(`  vision: ${env.vision ? "yes" : "no"}`);
    if (env.parallelToolCalls !== null) {
      out.push(`  parallel tool calls: ${env.parallelToolCalls ? "yes" : "no"}`);
    }
  }
  // ── Concurrency (kept last) — numbers so the model sizes a fan-out batch ──
  out.push(`  workers in parallel: ${env.turnMaxConcurrency}`);
  out.push(`  ingest parallel: ${env.ingestParallel}`);
  // ── Limits to plan around (kept last) ────────────────────────────────────
  out.push(`  tool rounds: ${env.toolRoundsUsed}/${env.toolRoundsLimit}`);
  if (env.remainingContextPct !== null) {
    out.push(`  context remaining: ${env.remainingContextPct}%`);
  }
  // ── Cache / limits detail (dropped first) ────────────────────────────────
  if (!dropped.has("cache dir")) {
    out.push(`  max read lines: ${env.maxReadLines}`);
    out.push(`  cache dir: ${safe(env.cacheDir)}`);
  }
  // ── Workers (kept last) ──────────────────────────────────────────────────
  const workers = env.workers.length > 0 ? env.workers.map(safe).join(", ") : "none";
  out.push(`  available workers: ${workers}`);
  return out;
}

/**
 * Render the session meta block within `maxTokens` (§4.4). Builds every field,
 * and if the content exceeds the cap drops groups in the documented order until
 * it fits (or every droppable group is gone). Returns the text and the dropped
 * group names so the engine emits one `LIMIT_HIT` for
 * `context.metaBlockMaxTokens` when anything was dropped.
 */
export function renderMetaBlock(env: EnvironmentFacts, maxTokens: number): MetaBlockRender {
  const dropped = new Set<DropGroup>();
  let text = lines(env, dropped).join("\n");
  for (const group of DROP_ORDER) {
    if (estimateTokens(text) <= maxTokens) break;
    dropped.add(group);
    text = lines(env, dropped).join("\n");
  }
  return { text, dropped: [...dropped] };
}
