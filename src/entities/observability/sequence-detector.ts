/**
 * Repeated-sequence detection (core-blueprint.md §10.6, §15.1 invariant 12).
 *
 * A deterministic sequence detector over the same `info` trail the trace
 * analyzer watches. It finds a repeatable procedure — the same multi-step
 * sequence of tool calls run the long way more than once — and raises it as a
 * skill candidate. Detection is MECHANICAL code over the trail: it makes no
 * model call and never enters the model's context.
 *
 * Each completed tool span is reduced to a STEP SIGNATURE: the tool name plus a
 * shape digest of its arguments (the keys present and each value's KIND, never
 * its literal value — so a secret or a one-off path never enters a signature).
 * A sliding window of 2..`sequenceMaxLen` consecutive step signatures is counted
 * per distinct SEQUENCE SIGNATURE, within a session and across sessions (prior
 * sessions are seeded at the boundary).
 *
 * SIGNAL QUALITY (§10.6). A sequence qualifies to raise a signal only when:
 *  - it contains at least one NON-READ step — a write/mutating tool, a command
 *    execution, a `task` delegation, or a network mutation. A purely read-only
 *    sequence (reads, workspace maps, globs, content searches, web fetches)
 *    NEVER qualifies, whatever its length or however often it recurs: read-only
 *    exploration is orientation, not a procedure (the `Read → Map → Read` case);
 *    AND
 *  - it has at least THREE steps, OR contains a non-read step (a two-step
 *    mutating sequence lifts the three-step floor); AND
 *  - its DISTINCT figure — distinct sessions, or distinct turns within one
 *    session — reaches `turnSuggestionThreshold` across at least THREE distinct
 *    contexts. The figure is NOT the raw sliding-window match count: a turn
 *    counts a sequence at most once (overlapping windows and repeats in one turn
 *    never inflate it), and a prior session counts once however many windows its
 *    trail replayed; AND
 *  - it is the MAXIMAL sequence among overlapping candidates of one procedure: a
 *    shorter sequence whose figure is wholly explained by a longer qualifying
 *    sequence ending at the same step is dropped.
 * Caps: at most ONE signal per turn and THREE per session.
 *
 * Both outcomes count: a sequence that succeeds repeatedly is worth a script;
 * one that repeatedly fails or is denied is worth a guard or a different
 * approach. A window's outcome is `failure` when any step in it failed or was
 * denied, else `success`.
 */
import type { ObsRecord } from "./obs-record.js";
import { stepDisplayName } from "./tool-display.js";
import { READ_CLASS_TOOLS, TASK_TOOL_NAME } from "../subagents.js";
import { limitDefault } from "../limits.js";

/** Minimum step count that qualifies a read-only sequence (§10.6). Internal:
 * not a tunable registry limit (it is a qualification shape, not a bound). */
const MIN_QUALIFYING_STEPS = 3;

/** The outcome a repeated sequence carries (§10.6). */
export type SequenceOutcome = "success" | "failure";

/** A raised repeated-sequence suggestion (the WARNING_EMITTED payload fields, §10.6). */
export interface SequencePattern {
  /** The sequence signature: the step signatures joined, the event `pattern`. */
  pattern: string;
  /** The step signatures that make up the sequence, in order. */
  steps: string[];
  /** The DISTINCT figure that reached the threshold: distinct sessions when the
   * sequence spans more than one session, else distinct turns this session. */
  count: number;
  /** The distinct split: `within` = distinct turns this session, `across` =
   * distinct PRIOR sessions (excluding this one). */
  split: { within: number; across: number };
  /** `success` when every step succeeded, `failure` when any failed or was denied. */
  outcome: SequenceOutcome;
  /** The session ids that produced the sequence (this session plus any prior). */
  sessionIds: string[];
  /** A human sentence for the WARNING_EMITTED payload (§10.6, §14.6): names the
   * pattern by tool DISPLAY names with no literal values; the CLI renders it as
   * a dim `ℹ` info line. */
  message: string;
}

/** One completed step the detector observed: its signature and its outcome. */
export interface Step {
  signature: string;
  outcome: SequenceOutcome;
}

/** The per-sequence tally the detector keeps. Counting is by DISTINCT CONTEXT
 * (§10.6): a turn counts a sequence AT MOST ONCE and the reported figure is the
 * number of distinct sessions (across) or distinct turns (within) — never the
 * raw sliding-window match count. */
interface Tally {
  /** Distinct prior SESSIONS this sequence occurred in (seeded at the boundary). */
  sessions: Set<string>;
  /** Distinct live-session turn ids this sequence occurred in (§10.6 "distinct
   * turns"). A turn id is added at most once per turn, so several overlapping
   * matches or several repeats in one turn never inflate the figure. */
  turns: Set<number>;
  outcome: SequenceOutcome;
  steps: string[];
}

export class SequenceDetector {
  /** Recent completed step signatures, trimmed to `maxLen` (the longest window). */
  private readonly recent: Step[] = [];
  /** Per sequence-signature tally (within + across + producing sessions). */
  private readonly tallies = new Map<string, Tally>();
  /** Fired-once guard: a sequence signature signals at most once per session. */
  private readonly fired = new Set<string>();
  /** §10.6 Lifecycle — signatures with a pending/approved/rejected suggestion.
   * A window that CONTAINS or IS CONTAINED IN one of these (as a contiguous
   * sub-sequence) never signals, so neither a sub-window nor a supersequence of
   * an already-surfaced procedure re-surfaces in a later session. */
  private readonly lifecycleSuppressed = new Set<string>();
  /** Args captured at a tool's pending span, consumed at its completed span. */
  private readonly pendingArgs = new Map<string, unknown>();
  /** The current live turn id (bumped by `beginTurn`); each occurrence records
   * it so a sequence can qualify on three distinct turns within one session. */
  private turnId = 0;
  /** Signals already raised in the current turn (per-turn cap, §10.6). */
  private signalsThisTurn = 0;
  /** Signals already raised in this session (per-session cap, §10.6). */
  private signalsThisSession = 0;
  /** §10.6 — qualifying windows buffered during the current turn, keyed by
   * signature. Flushed to the maximal set at the turn boundary (`flushTurnSignals`)
   * so a shorter sub-window that closed on an earlier record never pre-empts the
   * maximal procedure. */
  private readonly turnCandidates = new Map<string, { window: Step[]; tally: Tally; sig: string }>();

  /**
   * @param threshold  `turnSuggestionThreshold` — the combined count a sequence
   *                    must reach to be a candidate.
   * @param maxLen     `sequenceMaxLen` — the longest window matched as one unit.
   * @param sessionId  this session's id, carried in the evidence.
   * @param caps       the detector caps from the limits registry (§13.11):
   *                   `sequence.maxSignalsPerSession`, `sequence.maxSignalsPerTurn`,
   *                   and `sequence.minDistinctSessions`. Default to the registry
   *                   values so the detector is usable standalone.
   */
  constructor(
    private readonly threshold: number,
    private readonly maxLen: number,
    private readonly sessionId: string,
    private readonly caps: { maxSignalsPerSession: number; maxSignalsPerTurn: number; minDistinctSessions: number } = {
      maxSignalsPerSession: limitDefault("sequence.maxSignalsPerSession"),
      maxSignalsPerTurn: limitDefault("sequence.maxSignalsPerTurn"),
      minDistinctSessions: limitDefault("sequence.minDistinctSessions"),
    },
  ) {}

  /**
   * Mark a new live turn (§10.6 per-turn accounting). Resets the per-turn signal
   * cap and advances the turn id so a sequence repeated across turns counts
   * toward the "three distinct turns" qualifier. Called by the writer at each
   * turn boundary; a detector that never sees a `beginTurn` behaves as a single
   * turn (turn id 0).
   */
  beginTurn(): void {
    this.turnId += 1;
    this.recent.length = 0; // a new turn starts a fresh contiguous run (§10.6)
    // The per-turn signal cap resets when the PRIOR turn's buffered signals are
    // flushed (`flushTurnSignals`), not here, so a flush that runs after the next
    // turn has begun still honours the one-signal-per-turn cap for its own turn.
  }

  /**
   * Seed the detector with a completed sequence counted from a PRIOR session's
   * trail (cross-session counting, §10.6). Call this at the session boundary,
   * before live observation, once per distinct sequence signature found in each
   * prior session's trail. It never fires a signal — it only primes the count.
   */
  seedPrior(steps: Step[], priorSessionId: string): void {
    if (steps.length < 2 || steps.length > this.maxLen) return;
    const t = this.tallyFor(steps);
    // A prior session counts ONCE toward the distinct-session figure however many
    // overlapping windows of the same signature its trail replayed (§10.6).
    t.sessions.add(priorSessionId);
    if (steps.some((s) => s.outcome === "failure")) t.outcome = "failure";
  }

  /**
   * Suppress a sequence signature so it is NEVER signalled (§10.6 Lifecycle).
   * Called at the session boundary with the signatures of every pending/approved
   * suggestion and every remembered rejected signature, so a procedure already
   * surfaced or declined does not re-surface — within or across sessions. Adding
   * a signature to the fired set is exactly the never-signal-again mechanism the
   * per-session guard already uses.
   */
  suppressSignature(signature: string): void {
    if (signature) this.lifecycleSuppressed.add(signature);
  }

  /**
   * Observe one record. Returns the sequence signals newly raised on this record
   * (§10.6), or an empty array. A single completed step can close several
   * overlapping windows; only the MAXIMAL qualifying sequence is reported, and
   * the per-turn (1) and per-session (3) caps bound how many signals ever leave
   * the detector. Never a model call.
   */
  observe(record: ObsRecord): SequencePattern[] {
    // Capture a tool's arguments at its pending span; they are not on the
    // completed span. Keyed by spanId so a concurrent tool never crosses wires.
    if (record.source === "tool" && record.status === "pending") {
      if (record.input !== undefined) this.pendingArgs.set(record.spanId, record.input);
      return [];
    }

    const step = this.stepOf(record);
    if (!step) return [];

    this.recent.push(step);
    if (this.recent.length > this.maxLen) this.recent.shift();

    // Tally every window of length 2..maxLen ENDING at this newest step, and
    // collect the ones that QUALIFY (non-read step / threshold / distinct
    // contexts) and have not yet fired this session. A window records only the
    // DISTINCT turn id (a Set), so several overlapping sliding windows closing on
    // this record, and several matches of the same sequence in one turn, add the
    // turn AT MOST ONCE — the figure is distinct turns, never the raw match count
    // (§10.6). Maximal reporting then drops a shorter qualifying window whose
    // count is wholly explained by a longer one.
    const qualifying: { window: Step[]; tally: Tally; sig: string }[] = [];
    for (let len = 2; len <= this.maxLen && len <= this.recent.length; len++) {
      const window = this.recent.slice(this.recent.length - len);
      const t = this.tallyFor(window);
      t.sessions.add(this.sessionId);
      t.turns.add(this.turnId);
      if (window.some((s) => s.outcome === "failure")) t.outcome = "failure";
      const sig = this.signatureOf(window);
      if (!this.fired.has(sig) && !this.lifecycleBlocked(sig) && this.qualifies(window, t)) {
        qualifying.push({ window, tally: t, sig });
      }
    }
    if (qualifying.length === 0) return [];

    // Maximal only: sort longest-first; drop a shorter candidate whose step
    // signature is a suffix of (fully contained in) a longer reported one with a
    // distinct figure no greater than the longer's (its occurrences are explained
    // by it).
    qualifying.sort((a, b) => b.window.length - a.window.length);
    const reported: { window: Step[]; tally: Tally; sig: string }[] = [];
    for (const cand of qualifying) {
      const explained = reported.some(
        (r) =>
          r.window.length > cand.window.length &&
          endsWith(r.window, cand.window) &&
          distinctFigure(cand.tally) <= distinctFigure(r.tally),
      );
      if (!explained) reported.push(cand);
    }

    // DEFER firing to the turn boundary (§10.6 maximal-only). A shorter window
    // closes on an earlier record than a longer one that contains it, so firing
    // per-record would raise the shorter sequence before the maximal one has
    // formed. Instead buffer every qualifying window seen this turn and emit only
    // the maximal set at `flushTurnSignals` (the writer calls it when the turn is
    // settled). `observe` therefore never returns a hit directly.
    for (const cand of reported) {
      const prior = this.turnCandidates.get(cand.sig);
      if (!prior || distinctFigure(cand.tally) >= distinctFigure(prior.tally)) {
        this.turnCandidates.set(cand.sig, cand);
      }
    }
    return [];
  }

  /**
   * Emit the maximal qualifying signals buffered during the current turn (§10.6),
   * then clear the buffer. The writer calls this when the turn is settled (idle),
   * NEVER mid-turn, so only the MAXIMAL sequence of a procedure is raised — a
   * shorter sub-window whose occurrences are explained by a longer qualifying one
   * is dropped even when it closed on an earlier record. The per-turn (1) and
   * per-session (3) caps apply here, longest-first.
   */
  flushTurnSignals(): SequencePattern[] {
    const candidates = [...this.turnCandidates.values()];
    this.turnCandidates.clear();
    this.signalsThisTurn = 0; // the cap is per-turn; this flush closes one turn
    // Maximal only across the whole turn: drop a shorter window that is a
    // contiguous sub-sequence of a longer qualifying one with no greater figure.
    candidates.sort((a, b) => b.window.length - a.window.length);
    const reported: typeof candidates = [];
    for (const cand of candidates) {
      const explained = reported.some(
        (r) =>
          r.window.length > cand.window.length &&
          containsSubsequence(
            r.window.map((s) => s.signature),
            cand.window.map((s) => s.signature),
          ) &&
          distinctFigure(cand.tally) <= distinctFigure(r.tally),
      );
      if (!explained) reported.push(cand);
    }

    const hits: SequencePattern[] = [];
    for (const { window, tally, sig } of reported) {
      if (this.signalsThisTurn >= this.caps.maxSignalsPerTurn || this.signalsThisSession >= this.caps.maxSignalsPerSession) break;
      if (this.fired.has(sig) || this.lifecycleBlocked(sig)) continue;
      this.fired.add(sig);
      // Suppress every contiguous sub-window of this reported sequence so a
      // shorter sequence explained by it never fires on a later turn (§10.6).
      const sigs = window.map((s) => s.signature);
      for (let len = 2; len < window.length; len++) {
        for (let start = 0; start + len <= sigs.length; start++) {
          this.fired.add(sigs.slice(start, start + len).join(" → "));
        }
      }
      this.signalsThisTurn += 1;
      this.signalsThisSession += 1;
      const multiSession = tally.sessions.size > 1;
      const unit: "sessions" | "turns" = multiSession ? "sessions" : "turns";
      const figure = multiSession ? tally.sessions.size : tally.turns.size;
      hits.push({
        pattern: sig,
        steps: window.map((s) => s.signature),
        count: figure,
        split: { within: tally.turns.size, across: Math.max(0, tally.sessions.size - 1) },
        outcome: tally.outcome,
        sessionIds: [...tally.sessions],
        message: sequenceMessage(window, figure, unit),
      });
    }
    return hits;
  }

  /**
   * Whether a window QUALIFIES to raise a signal (§10.6): it contains at least
   * one MUTATING step (a write/edit tool, a command execution, or a network
   * mutation — NOT a read and NOT a `task` delegation); AND its distinct figure
   * (distinct sessions, or distinct turns within one session) has reached the
   * threshold across at least three distinct contexts. A purely read-only
   * sequence (reads, workspace maps, globs, content searches, web fetches) and a
   * read+dispatch sequence (`Read → Read → Task`) NEVER qualify, whatever their
   * length or however often they recur — orientation and delegation are not
   * procedures worth automating.
   */
  private qualifies(window: Step[], t: Tally): boolean {
    // §10.6 — at least one MUTATING step, else it is orientation/delegation noise
    // and never qualifies (the `Read → Map → Read` and `Read → Read → Task` cases).
    if (!window.some((s) => isMutatingStep(s.signature))) return false;
    const figure = distinctFigure(t);
    if (figure < this.threshold) return false;
    // At least three distinct contexts (sessions or turns, §10.6): a short run
    // repeated a few times in a single turn never qualifies.
    if (t.sessions.size < this.caps.minDistinctSessions && t.turns.size < this.caps.minDistinctSessions) return false;
    const hasMutating = window.some((s) => isMutatingStep(s.signature));
    return window.length >= MIN_QUALIFYING_STEPS || hasMutating;
  }

  /** The completed step a record carries, or null when it is not one. */
  private stepOf(record: ObsRecord): Step | null {
    return stepFromRecord(record, this.pendingArgs);
  }

  /**
   * Whether a signature is blocked by the lifecycle-suppressed set (§10.6): true
   * when it equals, CONTAINS, or IS CONTAINED IN any suppressed signature as a
   * contiguous step sub-sequence. A suggestion records one (possibly non-maximal)
   * signature; blocking both directions means neither a sub-window nor a
   * supersequence of an already-surfaced or declined procedure re-signals.
   */
  private lifecycleBlocked(sig: string): boolean {
    if (this.lifecycleSuppressed.size === 0) return false;
    if (this.lifecycleSuppressed.has(sig)) return true;
    const steps = sig.split(" → ");
    for (const suppressed of this.lifecycleSuppressed) {
      const sup = suppressed.split(" → ");
      if (containsSubsequence(steps, sup) || containsSubsequence(sup, steps)) return true;
    }
    return false;
  }

  /** Discard the current turn's buffered (un-flushed) candidate signals (§6.7):
   * called on a mode switch / session clear so a procedure recorded mid-turn is
   * not drafted after the switch. */
  discardTurnSignals(): void {
    this.turnCandidates.clear();
  }

  private tallyFor(steps: Step[]): Tally {
    const sig = this.signatureOf(steps);
    let t = this.tallies.get(sig);
    if (!t) {
      t = {
        sessions: new Set(),
        turns: new Set(),
        outcome: "success",
        steps: steps.map((s) => s.signature),
      };
      this.tallies.set(sig, t);
    }
    return t;
  }

  private signatureOf(steps: Step[]): string {
    return steps.map((s) => s.signature).join(" → ");
  }
}

/** The raw tool name a step signature carries (`read_file({path})` → `read_file`). */
function toolName(signature: string): string {
  const paren = signature.indexOf("(");
  return paren >= 0 ? signature.slice(0, paren) : signature;
}

/** The DISTINCT figure a tally reports (§10.6): distinct sessions when the
 * sequence spans more than one session, otherwise distinct turns this session —
 * never the raw sliding-window match count. */
function distinctFigure(t: Tally): number {
  return t.sessions.size > 1 ? t.sessions.size : t.turns.size;
}

/** The dispatch tool name (`task`). Delegation is neither a read nor a mutating
 * step: a sequence whose only non-read step is `task` (e.g. `Read → Read → Task`)
 * is orchestration, not a repeatable procedure worth a skill, so it NEVER
 * qualifies (§10.6 corrected rule). The single source is `TASK_TOOL_NAME`
 * (entity layer, `../subagents.js`). */

/** Whether a step's tool is a MUTATING step that can qualify a sequence (§10.6):
 * a write/edit tool, a command execution, or a network mutation — anything NOT
 * in the read-class set AND NOT the `task` dispatch. A read-class tool (read,
 * glob, map, search, web fetch, web search, skills, ingest, notes) and `task`
 * are both non-qualifying. Fails OPEN to mutating for an unknown tool so a novel
 * mutating tool is never miscounted as orientation noise. */
function isMutatingStep(signature: string): boolean {
  const name = toolName(signature);
  if (name === TASK_TOOL_NAME) return false;
  return !READ_CLASS_TOOLS.has(name);
}

/** True when `outer` contains `inner` as a CONTIGUOUS sub-sequence of step
 * signatures (§10.6 lifecycle containment). Equal arrays count as contained. */
function containsSubsequence(outer: string[], inner: string[]): boolean {
  if (inner.length === 0 || inner.length > outer.length) return false;
  for (let start = 0; start + inner.length <= outer.length; start++) {
    let all = true;
    for (let i = 0; i < inner.length; i++) {
      if (outer[start + i] !== inner[i]) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/** True when the last `inner.length` steps of `outer` equal `inner` by signature
 * — i.e. `inner` is the trailing sub-window of `outer` (both end at the same
 * newest step), so `inner`'s occurrences are a subset of `outer`'s. */
function endsWith(outer: Step[], inner: Step[]): boolean {
  if (inner.length > outer.length) return false;
  const off = outer.length - inner.length;
  for (let i = 0; i < inner.length; i++) {
    if (outer[off + i]!.signature !== inner[i]!.signature) return false;
  }
  return true;
}

/**
 * The human WARNING_EMITTED `message` for a raised sequence (§10.6, §14.6): the
 * pattern by tool DISPLAY names and the DISTINCT figure, with NO literal argument
 * values (the step signatures already stripped them). `unit` chooses the exact
 * wording the blueprint pins:
 *   - `"sessions"` → `Repeated pattern: Read → Write (seen in 3 sessions). …`
 *   - `"turns"`    → `Repeated pattern: Read → Write (in 3 turns this session). …`
 */
export function sequenceMessage(
  window: Step[],
  count: number,
  unit: "sessions" | "turns" = "sessions",
): string {
  const names = window.map((s) => stepDisplayName(s.signature)).join(" → ");
  const figure =
    unit === "sessions" ? `seen in ${count} sessions` : `in ${count} turns this session`;
  return `Repeated pattern: ${names} (${figure}). A skill suggestion will be drafted when the session is idle; review with /memory.`;
}

/**
 * A shape digest of a value: its KIND, and for an object the keys present with
 * each value's kind — NEVER a literal value, so a secret or a one-off path can
 * never enter a signature. Deterministic (keys sorted). Two argument sets with
 * the same shape but different values produce the same digest.
 */
export function shapeDigest(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (Array.isArray(value)) return `[${value.length === 0 ? "" : kindOf(value[0])}]`;
  const kind = kindOf(value);
  if (kind !== "object") return kind;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${k}:${kindOf(obj[k])}`).join(",")}}`;
}

/** The kind of a value, never its literal content. */
function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  return t === "object" ? "object" : t;
}

/**
 * The completed step a record carries, or null when it is not one (§10.6). Pure
 * over the record and a span→args correlation map (a tool's args ride its pending
 * span, consumed at the completed span). Shared by the live detector and the
 * prior-trail replay so a seeded signature matches a live one byte-for-byte.
 */
export function stepFromRecord(record: ObsRecord, pendingArgs: Map<string, unknown>): Step | null {
  if (record.source === "tool" && record.status === "pending") {
    if (record.input !== undefined) pendingArgs.set(record.spanId, record.input);
    return null;
  }
  // A completed tool span (success or error).
  if (record.source === "tool" && (record.status === "ok" || record.status === "error")) {
    const args = pendingArgs.get(record.spanId);
    pendingArgs.delete(record.spanId);
    return {
      signature: `${record.name}(${shapeDigest(args)})`,
      outcome: record.status === "ok" ? "success" : "failure",
    };
  }
  // A denied permission decision — a step that was never allowed to run.
  if (record.source === "guardian" && record.attributes["decision"] === "deny") {
    const tool = String(record.attributes["tool"] ?? record.name);
    const action = record.attributes["action"] as { args?: unknown } | undefined;
    return { signature: `${tool}(${shapeDigest(action?.args)})`, outcome: "failure" };
  }
  return null;
}

/**
 * Every consecutive window of length 2..`maxLen` of completed steps in a prior
 * session's records, in trail order (§10.6 cross-session seeding). Pure; used to
 * seed the live detector so a procedure repeated in a past session counts toward
 * this session's threshold. Records must be oldest-first.
 */
export function windowsFromRecords(records: ObsRecord[], maxLen: number): Step[][] {
  const pending = new Map<string, unknown>();
  const steps: Step[] = [];
  for (const r of records) {
    const s = stepFromRecord(r, pending);
    if (s) steps.push(s);
  }
  const windows: Step[][] = [];
  for (let end = 0; end < steps.length; end++) {
    for (let len = 2; len <= maxLen && len <= end + 1; len++) {
      windows.push(steps.slice(end - len + 1, end + 1));
    }
  }
  return windows;
}
