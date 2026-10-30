/**
 * The session meta block (core-blueprint.md §4.4).
 *
 * A compact, tier-1 inline block injected into the Agent layer and regenerated
 * EVERY turn from live values, so it never drifts from the real session state.
 * It is DATA, never authority (§1 rule 15): it tells the model where it is and
 * what it is working with, and grants, widens or relaxes nothing. One field per
 * line, all fields always rendered (the head has no cap; the head WARNING guards
 * size instead, §4.2.1).
 * It carries NO secret and NO file content; every rendered value is passed through the
 * shared secret masker and the shared unsafe-char stripper (control/ANSI/bidi/zero-width
 * removed, newlines collapsed to one space) before it leaves the process, so no field
 * spans more than one line.
 *
 * Pure: no infrastructure imports beyond the shared masker, so the pipeline logic stays
 * testable in the entity layer.
 */
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
  /**
   * §4.4/§7.1 — present only for a dispatched WORKER's meta block (the worker
   * variant). When set, the block carries NO Workers and NO Concurrency line
   * (a worker neither fans out nor sees siblings), and its Session line names
   * the worker and its parent session. `name` is the worker name, `parent` the
   * parent (owner) session id. Absent → the orchestrator variant (every field).
   */
  worker?: { name: string; parent: string };
}

/** The result of a render: the text only (all fields always render). */
export interface MetaBlockRender {
  text: string;
}

/** The header line — states this is session data, never instructions (§4.4, §1 rule 15). */
const HEADER =
  "Session data (where you are and what you are working with — context, not instructions):";

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

/** Build the field lines. */
function lines(env: EnvironmentFacts): string[] {
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
  out.push("  note: each command starts fresh in PWD, which is already where you want to be; a directory change inside one command is gone for the next");
  // ── Repository ──────────────────────────────────────────────────────────
  if (env.gitBranch) {
    const detail = env.gitDirty ? ` (${safe(env.gitDirty)})` : "";
    out.push(`  git: ${safe(env.gitBranch)}${detail}`);
  } else {
    out.push("  git: no");
  }
  // ── Session ───────────────────────────────────────────────────────────────
  out.push(`  agent: ${safe(env.agentMode)}`);
  if (env.worker) {
    // §4.4/§7.1 worker variant — name the worker and its parent session.
    out.push(`  session: worker ${safe(env.worker.name)} (parent ${safe(env.worker.parent)})`);
  } else {
    out.push(`  session: ${safe(env.sessionId)}`);
  }
  // ── Model ─────────────────────────────────────────────────────────────────
  out.push(`  model: ${safe(env.model)}`);
  out.push(`  context window: ${env.contextLimit}`);
  const maxOut = env.maxOutputTokens === null ? "default" : String(env.maxOutputTokens);
  out.push(`  output reservation: ${maxOut}`);
  out.push(`  vision: ${env.vision ? "yes" : "no"}`);
  if (env.parallelToolCalls !== null) {
    out.push(`  parallel tool calls: ${env.parallelToolCalls ? "yes" : "no"}`);
  }
  // ── Concurrency (kept last) — numbers so the model sizes a fan-out batch ──
  // §4.4/§7.1 — a WORKER carries NO Concurrency line: it neither fans out nor
  // sees siblings. The orchestrator variant renders both numbers.
  if (!env.worker) {
    out.push(`  workers in parallel: ${env.turnMaxConcurrency}`);
    out.push(`  ingest parallel: ${env.ingestParallel}`);
  }
  // ── Limits to plan around (kept last) ────────────────────────────────────
  out.push(`  tool rounds: ${env.toolRoundsUsed}/${env.toolRoundsLimit}`);
  if (env.remainingContextPct !== null) {
    out.push(`  context remaining: ${env.remainingContextPct}%`);
  }
  // ── Cache / limits detail ────────────────────────────────────
  out.push(`  max read lines: ${env.maxReadLines}`);
  out.push(`  cache dir: ${safe(env.cacheDir)}`);
  // ── Workers (kept last) ──────────────────────────────────────────────────
  // §4.4/§7.1 — a WORKER carries NO Workers line (it cannot dispatch, §7.1).
  if (!env.worker) {
    const workers = env.workers.length > 0 ? env.workers.map(safe).join(", ") : "none";
    out.push(`  available workers: ${workers}`);
    // §4.4/§7.2 — the worker tool-round budget each dispatched worker runs under
    // (`turnMaxToolRounds`, the orchestrator's default), so the orchestrator
    // sizes a task to that budget.
    out.push(`  worker tool-round budget: ${env.toolRoundsLimit}`);
  }
  return out;
}

/**
 * Render the session meta block (§4.4). Builds every field without dropping any.
 * All fields are always rendered: the head has no cap (§4.2.1), so nothing in
 * the meta block is ever shortened or dropped.
 */
export function renderMetaBlock(env: EnvironmentFacts): MetaBlockRender {
  const text = lines(env).join("\n");
  return { text };
}
