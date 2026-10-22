/**
 * Approval DTOs (core-blueprint.md §9.5).
 *
 * A `PendingApproval` always carries the full action — the tool name and its
 * full arguments or command — at every log level (invariant §15.1.6). The
 * fan-out batch shape is present even though fan-out lands in slice 3.
 */

export type ApprovalDecision = "approve" | "edit" | "reject";

export interface PendingApproval {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  workerId?: string;
  choices: ApprovalDecision[];
  mode: "interactive" | "policy_only" | "out_of_band" | "headless";
  inferredPatterns?: string[];
  diff?: string;
  /**
   * `true` when this ask is a FORCE-ASK (§9.5) — a dangerous shell family, an
   * SSRF/private-range network fetch, a plugin install, or a protected
   * control-file write. A force-ask is NEVER satisfied by an allow rule, a
   * fan-out grant, a session approval, or a plan scope, and a host MUST NEVER
   * batch it: every force-ask is routed to a single-action dialog, one decision
   * each (the four choices / always-asked line, as for the main agent). The
   * specific family is in `forceAskKind`. Absent is treated as `false`.
   */
  forceAsk?: boolean;
  /**
   * The force-ask family when this ask is a force-ask (§9.5): `"shell"` (a
   * dangerous shell command), `"ssrf"` (a web_fetch to an SSRF-protected
   * range), or `"plugin-install"` (a trust-expanding install). Absent for a
   * plain policy ask. Read-only metadata a non-interactive host uses to explain
   * WHY the run cannot proceed and which remedies apply — an allow rule cannot
   * satisfy a force-ask, so a host must not suggest one when this is set.
   */
  forceAskKind?: "shell" | "ssrf" | "plugin-install" | "control-file" | "outside-workspace";
  /**
   * Whether this ask may be remembered (§9.2, Slice C3). `true` for a plain
   * policy ask: a host offers APPROVE ONCE, APPROVE FOR THIS SESSION, PERSIST TO
   * THIS PROJECT, and REJECT. A force-ask (dangerous shell, SSRF range, plugin
   * install) is also rememberable (owner D2a) but ONLY as an EXACT entry —
   * `exactOnly: true` then rides alongside, its `inferredPatterns` is the single
   * masked exact value, and the core builds an `{ exact: true }` rule. A
   * force-ask whose exact value contains a masked secret or exceeds 4096 chars
   * is NOT rememberable (a saved masked rule could never match). Absent is
   * treated as `false` (conservative).
   */
  rememberable?: boolean;
  /**
   * EXACT-ONLY remember (owner D2a). Present and `true` only on a REMEMBERABLE
   * force-ask: the single offered pattern is the literal exact value (whole
   * command / `<package>@<version>` / URL host) and a saved rule carries
   * `exact: true`. A host shows the four choices plus a one-line note that the
   * save is for this exact command / host / package version only. Absent on a
   * plain policy ask (an ordinary glob remember). Absent is treated as `false`.
   */
  exactOnly?: boolean;
  /**
   * The classified pieces of a COMPOUND shell command (§9.3, §6.1). Present only
   * when the asking tool is an `execute_command` whose command the shared
   * segment splitter cut into MORE THAN ONE piece: each entry carries the piece
   * in command order with a `decision` of `ask` (that piece requires approval)
   * or `ok` (an existing allow rule / safe classification already covers it),
   * masked by the shared secret detector before it leaves the process (§10.10).
   * READ-ONLY display metadata — the gate is still decided over the WHOLE
   * command, never per segment — so a host shows the user WHICH piece is asking
   * rather than one opaque block. Bounded (the splitter is bounded) and absent
   * for a single-segment command or a non-shell tool. Absent is treated as none.
   */
  segments?: { text: string; decision: "ask" | "ok" }[];
}

/**
 * The host's answer to a pending interactive approval (§9.5, Slice C3). ONE
 * closed shape used by every host. `decision` is the terminal choice; `remember`
 * — present only with `decision: "allow"` — asks the core to remember the rule
 * either in-memory for this `"session"` or persisted to the PROJECT allow list
 * (`"project"`, `<workspace>/.voidrift/config.json`). The core, never the host,
 * builds the rule: `chosenPattern` MUST be one of the `inferredPatterns` the
 * core attached to THAT request (absent ⇒ the exact tool name / value the
 * request carried); anything else is rejected and the call falls back to
 * approve-once. There is no "persist globally" — the user copies an entry to the
 * global file by hand. `editedArgs` carries an edited argument set (§3.8).
 */
export interface ApprovalResponse {
  requestId: string;
  decision: ApprovalDecision;
  editedArgs?: Record<string, unknown>;
  remember?: "session" | "project";
  chosenPattern?: string;
}

/** A fan-out batch decision shape — the four choices (§9.5); fan-out is slice 3. */
export interface FanoutApprovalBatch {
  workerIds: string[];
  pending: PendingApproval[];
  choices: ["approve_all", "approve_all_and_grant", "review_individually", "cancel"];
}
