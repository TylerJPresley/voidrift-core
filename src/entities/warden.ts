/**
 * Warden — configured compliance (core-blueprint.md §9.6).
 *
 * Warden is pure decision logic over a loaded policy plus an injected judge
 * port. It runs FIRST at the decision point (§9.1 step 4), before Guardian; a
 * deny is final (the user is never asked to approve what policy blocks). The
 * three modes are `enforcing` (a violation is blocked and logged), `permissive`
 * (a violation is logged but allowed), and `off` (no policy loaded).
 *
 * Deterministic rules `{ match, effect }` decide actions through the shared
 * glob matcher (§9.2 — reused, not forked). A judge's typed verdict decides an
 * outcome, routed to the injected judge port ONLY when the acceptance criterion
 * is a typed verdict and not a deterministic rule; an unreachable or unsure
 * judge is a FAILURE when enforcing and a logged ALLOW when permissive.
 *
 * No infrastructure imports: policy loading and the judge transport live behind
 * ports the composition root wires (§1 rule 3).
 */
import { globMatch } from "./glob-matcher.js";
import { contentHash } from "./hash.js";

export type WardenMode = "off" | "permissive" | "enforcing";

/** A deterministic rule: `match` selects by tool/path/command, `effect` blocks
 * or allows (§9.6). `kind` scopes the match value the way Guardian does (§9.2):
 * a path glob, a command glob, or a tool-name glob. */
export interface WardenRule {
  match: string;
  kind?: "tool" | "path" | "command";
  effect: "block" | "allow";
  /** When present, this rule's acceptance criterion is a typed-verdict OUTCOME
   * check routed to the judge rather than decided deterministically (§9.6). */
  judge?: WardenJudgeCriterion;
}

/** The acceptance criterion a judge decides (§9.6). The artifact is drawn from
 * the call; a `check` verdict pass→allow, fail→block. */
export interface WardenJudgeCriterion {
  criterionId: string;
  instructions: string;
  standardVersion?: string;
}

/** A typed verdict the judge port returns (mirrors @voidrift/mcp-judge CheckVerdict;
 * only the fields Warden routes on are required here). */
export interface JudgeVerdict {
  type: "check" | "choose" | "score";
  pass?: boolean;
  probability?: number;
}

/** The judge port: Warden routes an outcome check and gets a typed verdict, or a
 * rejection meaning unreachable/unsure (§9.6, §8.4). Satisfied in production by
 * the MCP Judge, in tests by an in-memory implementation. */
export interface JudgePort {
  check(input: {
    artifact: unknown;
    criterion: WardenJudgeCriterion;
  }): Promise<JudgeVerdict>;
}

/** A loaded policy with its recorded version and content hash (§9.6). */
export interface WardenPolicy {
  version: string;
  hash: string;
  rules: WardenRule[];
  /** The policy text injected into protected context (§4.2). */
  text?: string;
}

/** Build a policy from a raw source document, recording the content hash so a
 * decision records version+hash and a cached source never needs the network
 * (§9.6, §8.5). */
export function loadPolicy(raw: {
  version?: string;
  rules?: WardenRule[];
  text?: string;
}): WardenPolicy {
  const rules = raw.rules ?? [];
  const canonical = JSON.stringify({ version: raw.version ?? "", rules });
  const hash = contentHash(canonical).slice(0, 16);
  return {
    version: raw.version ?? hash,
    hash,
    rules,
    ...(raw.text !== undefined ? { text: raw.text } : {}),
  };
}

/** A call presented to Warden at the decision point (§9.1 step 4). */
export interface WardenCall {
  tool: string;
  args: Record<string, unknown>;
}

/** Warden's verdict on a call (§9.6). A `block` is final (§9.1 step 4). */
export interface WardenOutcome {
  effect: "allow" | "block";
  reason?: string;
  version?: string;
  hash?: string;
  rule?: string;
}

/** An audit entry for a denial or a permissive-mode violation (§9.6 decisions). */
export interface WardenDecision {
  action: string;
  effect: "blocked" | "violation";
  rule: string;
  version: string;
  mode: WardenMode;
  reason?: string;
  at: number;
}

export interface WardenConfig {
  mode: WardenMode;
  source?: string;
}

/** The event sink Warden emits through — the composition root maps it to the
 * bus (§14.6). Keeps the entity free of the EventBus import. */
export interface WardenEvents {
  loaded(payload: { version: string; source: string | null; mode: WardenMode }): void;
  violation(payload: { action: string; rule: string; version: string; mode: WardenMode }): void;
  blocked(payload: { action: string; rule: string; version: string }): void;
}

const NO_EVENTS: WardenEvents = {
  loaded: () => undefined,
  violation: () => undefined,
  blocked: () => undefined,
};

/** The match value a rule tests, by kind (§9.2 shared semantics). */
function matchValue(call: WardenCall, kind: WardenRule["kind"]): string {
  const a = call.args;
  if (kind === "tool") return call.tool;
  if (kind === "command") return typeof a["command"] === "string" ? a["command"] : "";
  if (kind === "path") return typeof a["path"] === "string" ? a["path"] : "";
  // Default: prefer command, then path, then url, then tool name.
  if (typeof a["command"] === "string") return a["command"];
  if (typeof a["path"] === "string") return a["path"];
  if (typeof a["url"] === "string") return a["url"];
  return call.tool;
}

/** True when a rule matches the call under the shared glob matcher (§9.2). */
function ruleMatches(rule: WardenRule, call: WardenCall): boolean {
  const value = matchValue(call, rule.kind);
  if (rule.kind === "tool") return globMatch(rule.match, call.tool);
  // A tool-name match always applies regardless of path/command.
  if (globMatch(rule.match, call.tool)) return true;
  return value !== "" && globMatch(rule.match, value);
}

export class Warden {
  private policy: WardenPolicy | null = null;
  private readonly auditLog: WardenDecision[] = [];

  constructor(
    private config: WardenConfig,
    private readonly judge: JudgePort | null = null,
    private readonly events: WardenEvents = NO_EVENTS,
  ) {}

  /** Install (or replace) the loaded policy and announce it (§9.6
   * `COMPLIANCE_LOADED`). Policy text goes into protected context whenever a
   * policy is configured, independent of mode (§4.2); the engine reads
   * `policyText()`. */
  setPolicy(policy: WardenPolicy | null): void {
    this.policy = policy;
    if (policy) {
      this.events.loaded({
        version: policy.version,
        source: this.config.source ?? null,
        mode: this.config.mode,
      });
    }
  }

  /** The current mode and loaded-policy status (§2.2 compliance.status). */
  status(): {
    mode: WardenMode;
    version: string | null;
    hash: string | null;
    source: string | null;
  } {
    return {
      mode: this.config.mode,
      version: this.policy?.version ?? null,
      hash: this.policy?.hash ?? null,
      source: this.config.source ?? null,
    };
  }

  /** The loaded rule set and judge configuration (§2.2 compliance.policies). */
  policies(): { rules: WardenRule[]; judgeConfigured: boolean } {
    return {
      rules: this.policy?.rules ?? [],
      judgeConfigured: this.judge !== null,
    };
  }

  /** The audit record of denials and permissive-mode violations (§2.2
   * compliance.decisions). */
  decisions(): WardenDecision[] {
    return [...this.auditLog];
  }

  /** The policy text to place in protected context, whenever configured (§4.2). */
  policyText(): string | null {
    return this.policy?.text ?? null;
  }

  /** Reload config (hot-reload seam, §13 cascade). */
  configure(config: WardenConfig): void {
    this.config = config;
  }

  private record(entry: Omit<WardenDecision, "at">): void {
    this.auditLog.push({ ...entry, at: Date.now() });
  }

  /**
   * Evaluate a call (§9.6). Resolution:
   *  - `off`: allow (no policy loaded).
   *  - a policy is configured (source set) but none loaded: `enforcing` fails
   *    closed (deny every gated action); `permissive`/`off` allow.
   *  - the highest-matching deterministic rule decides; a `judge` rule routes an
   *    outcome check to the judge port.
   *  - `enforcing`: a `block` effect (or judge fail / unreachable judge) denies
   *    and logs; `permissive`: the same case is logged and allowed.
   */
  async evaluate(call: WardenCall): Promise<WardenOutcome> {
    const mode = this.config.mode;
    if (mode === "off") return { effect: "allow" };

    // Fail-closed: a configured policy source that produced no loaded policy
    // denies every gated action under enforcing (§9.6).
    if (!this.policy) {
      if (this.config.source && mode === "enforcing") {
        const reason = "no policy loaded (fail-closed)";
        this.record({ action: call.tool, effect: "blocked", rule: "(no-policy)", version: "", mode, reason });
        this.events.blocked({ action: call.tool, rule: "(no-policy)", version: "" });
        return { effect: "block", reason };
      }
      return { effect: "allow" };
    }

    const version = this.policy.version;
    const hash = this.policy.hash;

    // Highest-match wins by declaration order; the first matching rule decides.
    const rule = this.policy.rules.find((r) => ruleMatches(r, call));
    if (!rule) return { effect: "allow", version, hash };

    // A judge rule routes an OUTCOME check (§9.6): verdict pass→allow, fail→block;
    // an unreachable/unsure judge is a failure when enforcing, a logged allow when
    // permissive.
    if (rule.judge) {
      return this.evaluateJudge(call, rule, version, hash, mode);
    }

    if (rule.effect === "allow") return { effect: "allow", version, hash, rule: rule.match };

    // effect === "block"
    return this.applyBlock(call, rule.match, version, hash, mode, "blocked by policy rule");
  }

  private async evaluateJudge(
    call: WardenCall,
    rule: WardenRule,
    version: string,
    hash: string,
    mode: WardenMode,
  ): Promise<WardenOutcome> {
    const criterion = rule.judge!;
    if (!this.judge) {
      // No judge wired is treated like an unreachable judge.
      return this.applyBlock(call, rule.match, version, hash, mode, "judge unavailable (no judge configured)");
    }
    try {
      const verdict = await this.judge.check({ artifact: call.args, criterion });
      if (verdict.type === "check" && verdict.pass === true) {
        return { effect: "allow", version, hash, rule: rule.match };
      }
      // A fail verdict is a violation/block.
      return this.applyBlock(call, rule.match, version, hash, mode, "judge verdict: fail");
    } catch (e) {
      // An unreachable or unsure judge: failure when enforcing, logged allow when
      // permissive (§9.6).
      const reason = `judge unavailable: ${e instanceof Error ? e.message : String(e)}`;
      return this.applyBlock(call, rule.match, version, hash, mode, reason);
    }
  }

  /** Apply a block/violation per mode: enforcing blocks+logs, permissive
   * logs+allows (§9.6). */
  private applyBlock(
    call: WardenCall,
    rule: string,
    version: string,
    hash: string,
    mode: WardenMode,
    reason: string,
  ): WardenOutcome {
    if (mode === "enforcing") {
      this.record({ action: call.tool, effect: "blocked", rule, version, mode, reason });
      this.events.blocked({ action: call.tool, rule, version });
      return { effect: "block", reason, version, hash, rule };
    }
    // permissive: log the violation and allow.
    this.record({ action: call.tool, effect: "violation", rule, version, mode, reason });
    this.events.violation({ action: call.tool, rule, version, mode });
    return { effect: "allow", version, hash, rule };
  }
}
