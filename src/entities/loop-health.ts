/**
 * Loop-health detection (core-blueprint.md §3.4).
 *
 * "Native limits cap counts; they do not detect a stuck loop. The engine adds
 * loop-health detection over the stream: a tool call repeated identically
 * `turnLoopMaxIdenticalCalls` (4) times, a tool-call fingerprint recurring
 * `turnLoopFingerprintRepeats` (3) times within the last `turnLoopFingerprintWindow`
 * (20) calls, and `turnLoopMaxConsecutiveErrors` (3) consecutive tool errors. On
 * detection the engine injects a corrective nudge rather than letting the loop
 * run to its ceiling, and surfaces the condition as an event. The nudge wording
 * is the engine's; the limits it complements are native (§3.6)."
 *
 * This is pure entity logic driven by the ONE decision point (§9.1), so the
 * orchestrator AND every dispatched worker each get their OWN counter (the
 * decision point constructs one per caller). Counters reset per turn (the engine
 * calls `reset()` at the start of each turn and on `setMode`, mirroring the chat
 * lane §3.1). No infrastructure imports.
 *
 * AMBIGUITY (stated per the task): §3.4 specifies a corrective NUDGE and an
 * EVENT; it does NOT mandate ending the turn, and the event registry (§14.6)
 * lists no `LOOP_DETECTED` family. The simplest behaviour that satisfies every
 * sentence of §3.4 is therefore: on detection, return the nudge as the tool
 * result text the model reads next, emit the generic `WARNING_EMITTED`
 * `{ category: "loop", source }` event, and let the native ceilings
 * (`turnRecursionLimit`, §3.6) remain the hard stop. The detector that tripped
 * then rearms (its counter resets) so a single stuck pattern nudges once rather
 * than on every subsequent call, "rather than letting the loop run to its
 * ceiling".
 *
 * Fingerprints are computed from the tool NAME plus its CANONICALIZED args
 * (object keys sorted) so argument order never changes the fingerprint. The
 * fingerprint is an opaque string used only for equality/recency counting and is
 * NEVER emitted or logged (§3.4, §10.10 — args never leave the process here).
 */

/** Which detector tripped, for the event `source` and the nudge text (§3.4). */
export type LoopDetector = "identical_calls" | "fingerprint_repeats" | "consecutive_errors";

/** The loop-health thresholds (§3.6 config keys), read live from config so an
 * override in any layer is honoured. */
export interface LoopHealthLimits {
  maxConsecutiveErrors: number;
  maxIdenticalCalls: number;
  fingerprintRepeats: number;
  fingerprintWindow: number;
}

/** A detection result: the detector that tripped and the corrective nudge the
 * caller injects as the model-facing tool result (§3.4). `null` when nothing
 * tripped on this call. */
export interface LoopDetection {
  detector: LoopDetector;
  nudge: string;
}

/**
 * Tools exempt from loop-health detection (§3.4): `wait` is DESIGNED to poll a
 * command repeatedly until it succeeds or times out, so a legitimately repeated
 * `wait` call is not a stuck loop and must never trip a detector. A `wait` call
 * does not advance any counter and resets the consecutive-error run the same way
 * a successful call would (its repetition is expected, not pathological).
 */
export const LOOP_EXEMPT_TOOLS: ReadonlySet<string> = new Set(["wait"]);

/** Canonicalize args to a stable string: sort object keys recursively so
 * `{a,b}` and `{b,a}` fingerprint identically. Non-objects stringify directly. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

/** The opaque per-call fingerprint: tool name + canonicalized args (§3.4). */
export function fingerprintCall(tool: string, args: Record<string, unknown>): string {
  return `${tool}\u0000${canonicalize(args)}`;
}

/** The corrective nudge wording (§3.4 — "the nudge wording is the engine's").
 * Named per detector so the model is told WHICH pattern to break out of. */
export function loopNudge(detector: LoopDetector): string {
  switch (detector) {
    case "identical_calls":
      return (
        "Loop detected: you have repeated the same tool call with identical arguments several times. " +
        "This is not making progress — stop repeating it. Change your approach, try a different tool or " +
        "different arguments, or explain to the user what is blocking you."
      );
    case "fingerprint_repeats":
      return (
        "Loop detected: you keep issuing the same few tool calls in a cycle without making progress. " +
        "Break the cycle — reconsider the goal, change your approach, or explain to the user what is blocking you."
      );
    case "consecutive_errors":
      return (
        "Loop detected: several tool calls in a row have failed. Do not keep retrying the same way — read the " +
        "error messages, fix the root cause, try a different approach, or explain to the user what is blocking you."
      );
  }
}

/**
 * The per-turn loop-health counter (§3.4). One instance per caller (the
 * orchestrator and each worker get their own, built by the decision point). The
 * decision point calls `observe(tool, args, wasError)` after every GATED tool
 * call (a call that actually executed, pass or fail); the engine calls `reset()`
 * at the start of each turn and on `setMode`.
 */
export class LoopHealth {
  private consecutiveErrors = 0;
  private lastFingerprint: string | null = null;
  private identicalRun = 0;
  /** Recent fingerprints, most-recent last, bounded to the window (§3.4). */
  private readonly recent: string[] = [];

  constructor(private readonly getLimits: () => LoopHealthLimits) {}

  /** Reset every counter (start of a turn, and on `setMode`) (§3.4, §3.1). */
  reset(): void {
    this.consecutiveErrors = 0;
    this.lastFingerprint = null;
    this.identicalRun = 0;
    this.recent.length = 0;
  }

  /**
   * Observe one executed tool call and return a detection (nudge + detector)
   * when a loop is detected, else null (§3.4). An exempt tool (`wait`) never
   * advances a counter and clears the consecutive-error run (its repetition is
   * expected). Order of checks: consecutive errors first (a run of failures is
   * the strongest signal), then identical calls, then windowed fingerprint
   * repeats. A trip REARMS that detector so one stuck pattern nudges once rather
   * than on every subsequent call.
   */
  observe(tool: string, args: Record<string, unknown>, wasError: boolean): LoopDetection | null {
    const limits = this.getLimits();

    if (LOOP_EXEMPT_TOOLS.has(tool)) {
      // A polling tool is not a stuck loop: it does not advance the fingerprint
      // or identical-run counters, and a success/poll clears the error run.
      this.consecutiveErrors = 0;
      return null;
    }

    // (c) consecutive tool errors.
    if (wasError) {
      this.consecutiveErrors += 1;
      if (this.consecutiveErrors >= limits.maxConsecutiveErrors) {
        this.consecutiveErrors = 0; // rearm
        return { detector: "consecutive_errors", nudge: loopNudge("consecutive_errors") };
      }
    } else {
      this.consecutiveErrors = 0;
    }

    const fp = fingerprintCall(tool, args);

    // (a) identical consecutive calls.
    if (fp === this.lastFingerprint) this.identicalRun += 1;
    else this.identicalRun = 1;
    this.lastFingerprint = fp;

    // (b) windowed fingerprint recency.
    this.recent.push(fp);
    while (this.recent.length > limits.fingerprintWindow) this.recent.shift();

    if (this.identicalRun >= limits.maxIdenticalCalls) {
      this.identicalRun = 0; // rearm
      this.lastFingerprint = null;
      return { detector: "identical_calls", nudge: loopNudge("identical_calls") };
    }

    const repeats = this.recent.filter((f) => f === fp).length;
    if (repeats >= limits.fingerprintRepeats) {
      // Rearm: clear this fingerprint's occurrences from the window so the next
      // nudge only fires after another full run of repeats.
      let i = this.recent.length;
      while (i--) if (this.recent[i] === fp) this.recent.splice(i, 1);
      return { detector: "fingerprint_repeats", nudge: loopNudge("fingerprint_repeats") };
    }

    return null;
  }
}
