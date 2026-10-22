/**
 * Guardian — permissions (core-blueprint.md §9.2–§9.5).
 *
 * Guardian answers "may the agent do this, with the user's consent?" with
 * allow / ask / deny. Resolution is rule-based with inferred patterns, shell
 * classification and force-ask (§9.3), and built-in guardrails (§9.4). Guardian
 * is pure decision logic over the call plus session/config state; the engine's
 * `wrapToolCall` middleware carries out the suspension via LangGraph interrupt
 * (§9.5). No infrastructure imports.
 */
import { globMatch, toolNameGlobMatch } from "./glob-matcher.js";
import { classifyUrl } from "./url-classifier.js";
import {
  classifyNeverSegment,
  neverListDenyReason,
  isMetadataHost,
  METADATA_HOSTS_ID,
  METADATA_HOSTS_DESCRIPTION,
  type NeverHit,
} from "./never-list.js";
import { rmAllOperandsInsideWorkdir, type RmWorkdirDeps } from "./rm-workdir.js";
import { commandLeavesWorkspace } from "./outside-workspace.js";
import { splitShellSegments, pipelineSinks, extractInterpreterCommands } from "./shell-segments.js";
import { exactLiftRule, exactMatchValue, cidrContainsHost, validateCidr } from "./exact-allow.js";
import { windowScan, anchoredRegex, MAX_COMMAND_LENGTH } from "./shell-scan.js";
import { classifyControlPath, classifyResolvedControlPath, type ControlPathContext } from "./protected-paths.js";
import { controlPathWriteTargets } from "./shell-control-write.js";
import type { PermissionRule } from "../config/schema.js";

/** The classification of a shell command segment (§9.3). */
export type ShellClass = "safe" | "has-equivalent" | "dangerous" | "hard-deny" | "unknown";

/** Guardian's decision vocabulary (§9.2). */
export type GuardianDecision = "allow" | "ask" | "deny";

/** A tool call presented to the decision point. A tool's read-class is an
 * INTERNAL FACT (isolation, worker binding, display) and is NEVER a permission
 * input (§9); Guardian decides solely from the rules and force-ask classes. */
export interface GuardedCall {
  tool: string;
  args: Record<string, unknown>;
}

/** Guardrail result (§9.4). */
export interface GuardrailResult {
  allowed: boolean;
  reason?: string;
}

/** A guardrail: refines an allowed action, never widens a denied one (§9.4). */
export interface Guardrail {
  name: string;
  check(call: GuardedCall, ctx: GuardrailContext): GuardrailResult;
}

/** Context a guardrail reads (§9.4). */
export interface GuardrailContext {
  /** Paths read this session (for the unread/stale guardrail). */
  readPaths: Set<string>;
  /** Paths marked stale since read. */
  stalePaths: Set<string>;
  /** The system temp dir prefix, to block writes into it. */
  tempDir: string;
  /** The workspace root, to normalize a path before the protected-control-file
   * guardrail compares it (§8.4). Absent in older callers → relative compare. */
  workspaceRoot?: string;
}

/** The shell-classification config lists (§9.3), each an anchored regex string. */
export interface ShellLists {
  safe: string[];
  forceAsk: string[];
  equivalents: string[];
  deny: string[];
}

/** The outcome of Guardian's evaluation (before any guardrail refinement). */
export interface GuardianOutcome {
  decision: GuardianDecision;
  /** True when the ask is a force-ask immune to grants (§9.3). */
  forceAsk: boolean;
  /**
   * Which force-ask family produced this ask (§9.5). The host-only
   * `auto_approve` mode auto-approves a plain ask and a `"shell"` force-ask,
   * but NEVER an `"ssrf"` range (still needs an explicit answer) nor a
   * `"plugin-install"` trust-expanding action (always asked even in that mode).
   * Absent when `forceAsk` is false.
   */
  forceAskKind?: "shell" | "ssrf" | "plugin-install" | "control-file" | "outside-workspace";
  reason?: string;
  inferredPatterns?: string[];
  /** owner D2c — true when an EXACT allow rule LIFTED a force-ask (the decision
   * is then `allow` with no prompt). The decision point emits this so `/access`
   * and the user can see WHY no prompt appeared. No secret value is carried. */
  exactLift?: boolean;
  /** The rule id of the exact rule that lifted the force-ask, when known. */
  exactRuleId?: string;
}

/** Context for the code-level never list (§9.3, §13.10), passed to `evaluate`. */
export interface GuardianEvalOptions {
  /** Never-list category ids to LIFT (from the global/managed `unlock`; the
   * caller resolves honored-layers). A lifted category falls to the force-ask
   * list / ordinary SSRF ask. */
  unlock?: ReadonlySet<string>;
  /** The working directory `execute_command` runs in — the cwd, plumbed from the
   * caller (never `process.cwd()`), for the `rm -rf` within-workdir refinement
   * (owner D1.4). A worker in an isolated worktree passes its worktree dir. */
  workdir?: string;
  /** §9.3 outside-workspace — the home dir so a `~`/`$HOME`-prefixed cd target
   * or operand resolves statically (the decision point passes `os.homedir()`).
   * Absent → a `~`-prefixed path is not resolvable and falls back. */
  home?: string;
  /** Resolve a path's existing prefix for the `rm -rf` symlink guard (§D1.4);
   * the decision point injects `fs.realpathSync.native`. */
  realpath?: (p: string) => string;
  /** The control-path context (§8.4, §9.4): the workspace root, the global
   * config dir (`voidriftConfigDir()`), and the home dir, so `write_file`/
   * `edit_file` and write-shaped shell commands classify a control-file target
   * through the ONE `classifyControlPath`. Absent → control-file classification
   * is skipped (older callers / pure classification tests). */
  controlPath?: ControlPathContext;
}

/** Shared empty set so the common no-unlock path allocates nothing. */
const EMPTY_UNLOCK: ReadonlySet<string> = new Set<string>();

/** A metadata-host NEVER outcome, or null when the URL's host is not a
 * cloud-metadata address or `metadata-hosts` is unlocked (§9.3/§13.10). Pure. */
function metadataNever(rawUrl: string, unlocked: ReadonlySet<string>): GuardianOutcome | null {
  if (unlocked.has(METADATA_HOSTS_ID)) return null;
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return null;
  }
  // The WHATWG parser canonicalizes obfuscated IPv4 to dotted-quad in
  // `hostname`; isMetadataHost handles the canonical metadata IPs and the
  // by-name endpoints.
  if (!isMetadataHost(host)) return null;
  const hit: NeverHit = {
    id: METADATA_HOSTS_ID,
    description: METADATA_HOSTS_DESCRIPTION,
  };
  return { decision: "deny", forceAsk: false, reason: neverListDenyReason(hit) };
}

/**
 * Split a compound command into segments via the ONE shared quote/heredoc-aware
 * splitter (owner D2c, `shell-segments.ts`). It splits on newline/CR, `;`, `&&`,
 * `||`, `|`, `|&`, a single background `&`, and the group delimiters `(` `)`
 * `{` `}`, joins line continuations, and leaves separators inside quotes or a
 * heredoc body as text. On a lex it cannot prove safe (unbalanced quote, open
 * heredoc) it fails closed by returning the whole command as a segment too.
 * `splitSegments` returns only the segment list (the whole-command fail-closed
 * entry is already folded in by the splitter), so its old callers are unchanged.
 */
export function splitSegments(command: string): string[] {
  return splitShellSegments(command).segments;
}

/**
 * The pipeline-sink segments of a command (§9.3), via the shared splitter: every
 * pipeline stage that reads the stdout of a preceding stage (any `|`/`|&` stage
 * after the first), within each statement. A lone interpreter reading piped
 * stdin (`curl … | sh`, `… | python`) is dangerous ONLY as such a sink — a
 * standalone interpreter invocation (`python -c 'x'`, bare `node` REPL) is not —
 * so the interpreter-sink force-ask pattern (§9.3) is tested against sinks
 * alone, prefixed with `PIPE_SINK_MARKER`.
 */
export const PIPE_SINK_MARKER = "\u0000pipe-sink\u0000 ";
export { pipelineSinks };

/**
 * The maximum command-substitution / interpreter-wrapper NESTING depth the
 * classifier will walk (owner D2d). A model-supplied string of deeper nesting
 * (`'$('.repeat(200) + 'reboot' + ')'.repeat(200)`) would otherwise recurse
 * once per level and blow the call stack — crashing the gate rather than
 * denying. Exceeding the cap throws `ClassificationError`, which `evaluate`
 * catches and turns into a fail-closed DENY; it never yields an allow or ask.
 */
const MAX_SUBSTITUTION_DEPTH = 8;

/**
 * Thrown when a command cannot be classified safely (owner D2d): nesting deeper
 * than `MAX_SUBSTITUTION_DEPTH`, or any other error raised while classifying.
 * `Guardian.evaluate` catches it and denies fail-closed. The message carries NO
 * command text so nothing sensitive is logged.
 */
export class ClassificationError extends Error {
  constructor() {
    super("command could not be classified safely");
    this.name = "ClassificationError";
  }
}

/**
 * Extract the contents of every command substitution — `$(...)` and backtick
 * `` `...` `` — recursively, including nested ones (§9.3). Each extracted inner
 * command is returned so the SAME classifier can run against it: a dangerous
 * match inside a substitution forces the ask just as a top-level one does.
 * Nesting beyond `MAX_SUBSTITUTION_DEPTH` throws `ClassificationError` (owner
 * D2d) rather than recursing unbounded, so a pathological input fails closed to
 * a DENY instead of exhausting the call stack.
 */
export function extractSubstitutions(command: string, depth = 0): string[] {
  if (depth > MAX_SUBSTITUTION_DEPTH) throw new ClassificationError();
  const out: string[] = [];

  // `$( ... )` with balanced parentheses in ONE linear pass: a stack of open
  // `$(` positions, popped on the matching `)`. A per-opener rescan would be
  // O(n²) — a 30 KB run of unclosed `$(` took seconds (a fail-OPEN cost defect,
  // owner D2d). The stack bounds the cost to O(n) and ALSO caps nesting: an
  // open-substitution stack deeper than `MAX_SUBSTITUTION_DEPTH` fails closed to
  // a DENY rather than extracting (and recursing into) unbounded nesting.
  const stack: number[] = [];
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "$" && command[i + 1] === "(") {
      stack.push(i + 2);
      if (stack.length > MAX_SUBSTITUTION_DEPTH + 1) throw new ClassificationError();
      i++; // consume the `(`
    } else if (ch === "(") {
      // A plain `(` inside an open `$(` must be balanced before its `)` can
      // close the substitution; push a sentinel so the matching `)` pops it.
      if (stack.length > 0) stack.push(-1);
    } else if (ch === ")") {
      const open = stack.pop();
      if (open !== undefined && open >= 0) {
        // Only a TOP-LEVEL `$()` close yields an extracted inner here; nested
        // ones are reached by recursing into this inner below. Recurse only when
        // the stack is now empty (this was an outermost substitution) so each
        // substitution is extracted exactly once.
        const inner = command.slice(open, i);
        out.push(inner);
        if (stack.length === 0) out.push(...extractSubstitutions(inner, depth + 1));
      }
    }
  }

  // Backtick substitution (non-nesting in POSIX; a single level per pair).
  const bt = command.match(/`([^`]*)`/g);
  if (bt) {
    for (const m of bt) {
      const inner = m.slice(1, -1);
      out.push(inner);
      out.push(...extractSubstitutions(inner, depth + 1));
    }
  }

  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Every nested command LINE carried by `command` that the SAME classifier must
 * run against (owner D2c): command substitutions (`$()`/backtick, via
 * `extractSubstitutions`) PLUS the string argument of an interpreter/dispatcher
 * wrapper (`bash -c`/`sh -c`/`eval`/`xargs`/`ssh host "…"`, via
 * `extractInterpreterCommands`). Each result is itself scanned for further
 * nesting so `bash -c "$(reboot)"` and `eval "sh -c 'reboot'"` are caught. A
 * depth cap bounds pathological nesting.
 */
function innerCommands(command: string, depth = 0): string[] {
  if (depth > MAX_SUBSTITUTION_DEPTH) throw new ClassificationError();
  const direct = [...extractSubstitutions(command), ...extractInterpreterCommands(command)];
  const out: string[] = [...direct];
  for (const inner of direct) out.push(...innerCommands(inner, depth + 1));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

function matchesAny(patterns: string[], value: string): boolean {
  return patterns.some((p) => {
    const re = anchoredRegex(p);
    if (re === null) return false;
    // Scan in bounded overlapping windows so a long segment stays linear-cost
    // (owner D2d); a segment within one window is tested byte-for-byte.
    return windowScan(value, (w) => re.test(w));
  });
}

/**
 * Normalize shell word-splitting and quoting evasions to canonical single-space
 * form so the anchored config patterns (which use literal spaces) match
 * regardless of how a command spaces or quotes its arguments (§9.3, §15.1#5).
 * Applied in one place — every segment, top-level or extracted from a
 * substitution, flows through here, so the fix covers both levels.
 *
 * In order:
 *   0. Backslash-escaped spaces collapse to a space (`chmod\ -R\ 777\ /` →
 *      `chmod -R 777 /`) — the shell treats `\ ` as a literal word space, so
 *      the classifier must too, closing the backslash-space split evasion.
 *   1. Backslash-escapes of a word char collapse (`r\m` → `rm`, `s\udo` →
 *      `sudo`) so escape obfuscation cannot evade the anchored patterns.
 *   2. Empty quote splices inside a word are removed (`r""m` → `rm`,
 *      `s''udo` → `sudo`) — the shell expands these to a single word, so the
 *      classifier must too.
 *   3. Remaining single/double quote characters are stripped (`'rm'` → `rm`,
 *      `s"u"do` → `sudo`): the shell removes quote metacharacters during word
 *      expansion, so a quoted command word runs the same binary and must
 *      classify the same. Stripping cannot create a false positive on an
 *      ordinary command (benign use does not quote a bare command word to hide
 *      it), while it closes the `'rm' -rf /` / `r""m -rf /` evasions.
 *   4. `${IFS}`/`$IFS` and runs of any whitespace collapse to one space, so
 *      `rm${IFS}-rf${IFS}/`, `rm\t-rf\t/`, and `rm -rf\n/` all become
 *      `rm -rf /` and force-ask.
 */
function normalizeShell(segment: string): string {
  let value = segment
    .replace(/\\ /g, " ")
    .replace(/\\([A-Za-z0-9])/g, "$1")
    .replace(/''|""/g, "")
    .replace(/['"]/g, "")
    .replace(/\$\{IFS\}|\$IFS/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Strip surrounding subshell/grouping tokens — `( rm -rf / )`, `(rm -rf /)`,
  // and nested `(( … ))` — so a dangerous command wrapped in a subshell
  // classifies the same as the bare command (§9.3: a dangerous command hidden
  // inside a subshell is not missed). Iterated for nesting; braces grouping
  // (`{ …; }`) carries a `;` and is already split by splitSegments.
  let prev: string;
  do {
    prev = value;
    if (value.startsWith("(") && value.endsWith(")")) {
      value = value.slice(1, -1).trim();
    }
  } while (value !== prev);
  return value;
}

/** Classify a single shell command segment against the lists (§9.3). */
export function classifySegment(segment: string, lists: ShellLists): ShellClass {
  const value = normalizeShell(segment);
  if (matchesAny(lists.deny, value)) return "hard-deny";
  if (matchesAny(lists.forceAsk, value)) return "dangerous";
  if (matchesAny(lists.safe, value)) return "safe";
  if (matchesAny(lists.equivalents, value)) return "has-equivalent";
  return "unknown";
}

/** Classify a whole command: the most severe segment wins; dangerous anywhere forces ask (§9.3). */
export function classifyCommand(
  command: string,
  lists: ShellLists,
): { cls: ShellClass; segment: string } {
  // Top-level segments plus the contents of every command substitution
  // (`$(...)`/backtick, recursively). A dangerous or denied command hidden
  // inside a substitution is classified too, so the force-ask guarantee holds
  // against subshell bypass (§9.3, §15.1#5). `innerCommands` is computed ONCE
  // (it can be costly on a long input) and reused for both the segment and sink
  // passes (owner D2d).
  const inner = innerCommands(command);
  const segments = [
    ...splitSegments(command),
    ...inner.flatMap((c) => splitSegments(c)),
  ];
  // Pipeline sinks (stdin-reading stages), top-level and inside substitutions,
  // classified with the sink marker so the interpreter-sink force-ask (§9.3)
  // fires for `curl … | sh` but not a standalone `python -c 'x'`.
  const sinks = [
    ...pipelineSinks(command),
    ...inner.flatMap((c) => pipelineSinks(c)),
  ];
  const result: { cls: ShellClass; segment: string } = { cls: "safe", segment: command };
  let sawUnknown = false;
  let sawEquivalent: string | null = null;
  for (const seg of segments) {
    const cls = classifySegment(seg, lists);
    if (cls === "hard-deny") return { cls, segment: seg };
    if (cls === "dangerous") return { cls, segment: seg };
    if (cls === "has-equivalent") sawEquivalent = seg;
    if (cls === "unknown") sawUnknown = true;
  }
  // A pipeline sink is only tested for the extra sink-only danger (an
  // interpreter reading piped stdin); the marker lets the anchored pattern
  // require the pipe without the sink segment losing it to the split.
  for (const sink of sinks) {
    if (classifySegment(PIPE_SINK_MARKER + sink, lists) === "dangerous") {
      return { cls: "dangerous", segment: sink };
    }
  }
  if (sawEquivalent) return { cls: "has-equivalent", segment: sawEquivalent };
  if (sawUnknown) return { cls: "unknown", segment: command };
  return result;
}

/** One classified piece of a compound shell command (§6.1, §9.3). */
export interface SegmentVerdict {
  text: string;
  decision: "ask" | "ok";
}

/**
 * The per-segment ask/ok verdicts for a shell command (§6.1, §9.3), for
 * READ-ONLY display on a pending approval — the gate itself still decides over
 * the whole command, never per segment. Each TOP-LEVEL segment (the shared
 * `splitShellSegments` pieces) is `ok` when it classifies safe/has-equivalent OR
 * the caller's `allowCovers` predicate reports an existing allow rule covers it,
 * else `ask`. Returns an empty array when the command splits into ONE segment
 * (a host then shows the whole command with no per-segment breakdown) so the
 * field is present only for a genuinely compound command. PURE. Bounded by the
 * splitter; the result is capped so a pathological command never produces an
 * unbounded list.
 */
export function commandSegmentVerdicts(
  command: string,
  lists: ShellLists,
  allowCovers: (segment: string) => boolean,
): SegmentVerdict[] {
  const segments = splitShellSegments(command).segments;
  if (segments.length <= 1) return [];
  const MAX_SEGMENTS = 32;
  return segments.slice(0, MAX_SEGMENTS).map((text) => {
    let decision: "ask" | "ok" = "ask";
    const cls = classifySegment(text, lists);
    if (cls === "safe" || cls === "has-equivalent" || allowCovers(text)) decision = "ok";
    return { text, decision };
  });
}

/**
 * Whether an `allow` permission rule for `execute_command` already covers a bare
 * shell segment (§6.1 display helper): the segment is tested against each
 * `execute_command` allow rule's `pattern` with the same glob matcher the gate
 * uses. A deny or ask rule never marks a segment `ok`. PURE over the rules.
 */
export function commandAllowCovers(segment: string, rules: PermissionRule[]): boolean {
  const value = segment.trim();
  if (value === "") return false;
  return rules.some(
    (r) =>
      r.decision === "allow" &&
      toolNameGlobMatch(r.tool, "execute_command") &&
      typeof r.pattern === "string" &&
      globMatch(r.pattern, value),
  );
}

/**
 * Classify a whole command against the code-level NEVER LIST (§9.3, §13.10),
 * honoring `unlocked` (an id in it is skipped and falls back to the force-ask
 * list). Every top-level segment, the contents of every command substitution,
 * and every pipeline sink is NORMALIZED (the same quote/escape/`$IFS`/subshell
 * folding `classifySegment` applies) and tested — so a wrapper (`sudo`), quoting
 * (`'reboot'`), a substitution (`$(reboot)`), or a pipeline (`… | sh -c reboot`)
 * cannot bypass it. Returns the first category hit or null.
 */
export function classifyNever(command: string, unlocked: ReadonlySet<string>): NeverHit | null {
  // `innerCommands` is computed ONCE (costly on a long input) and reused for
  // both the segment and sink passes (owner D2d).
  const inner = innerCommands(command);
  const segments = [
    ...splitSegments(command),
    ...inner.flatMap((c) => splitSegments(c)),
    ...pipelineSinks(command),
    ...inner.flatMap((c) => pipelineSinks(c)),
  ];
  for (const seg of segments) {
    const hit = classifyNeverSegment(normalizeShell(seg), unlocked);
    if (hit) return hit;
  }
  return null;
}

/** The match value a rule tests: path, command, or url (§9.2). */
function callMatchValue(call: GuardedCall): string {
  const a = call.args;
  if (typeof a["command"] === "string") return a["command"];
  if (typeof a["path"] === "string") return a["path"];
  if (typeof a["url"] === "string") return a["url"];
  return "";
}

/**
 * Does a rule's pattern/cidr match the call value (§9.2, owner D2a)? Ordinary
 * rules glob-match the value. An `exact: true` rule matches by STRING EQUALITY
 * against the exact match value (whole command, `name@version`, or URL host —
 * see `exactMatchValue`) after trimming surrounding whitespace only; its `*` is
 * a literal character, never a glob. A `cidr` rule matches when the call's
 * IP-literal host falls inside the range. A rule without `pattern`/`cidr`
 * matches on the tool name alone (an MCP/plugin tool-name rule). Shared by the
 * deny and allow matchers so exact/cidr rules work for ordinary resolution too,
 * not just force-ask lifting.
 */
function rulePatternMatches(rule: PermissionRule, call: GuardedCall, globValue: string): boolean {
  if (rule.cidr !== undefined) {
    const v = validateCidr(rule.cidr);
    const host = exactMatchValue(call.tool, call.args);
    return "cidr" in v && host !== null && cidrContainsHost(v.cidr, host);
  }
  if (rule.exact === true && rule.pattern !== undefined) {
    const v = exactMatchValue(call.tool, call.args);
    return v !== null && rule.pattern.trim() === v;
  }
  return rule.pattern === undefined || globMatch(rule.pattern, globValue);
}

/**
 * Infer trust suggestions from specific to broad for an ask (§9.2).
 *
 * For a shell command or a file/url path the suggestions are command/path
 * GLOBS matched against that value (the rule carries them as `pattern`). For an
 * MCP or plugin tool there is no command/path/url value to match, so the
 * suggestion is a TOOL-NAME glob (§8.4, §9.2): an MCP call `mcp_<server>_<tool>`
 * suggests the server-wide `mcp_<server>_*`, and a plugin/other tool suggests
 * its own exact name. `engine.persistRule` turns such a suggestion into a rule
 * whose `tool` FIELD is the glob with NO `pattern`, which the matcher tests
 * against the call's tool name (an empty match value otherwise never matched).
 */
export function inferPatterns(call: GuardedCall): string[] {
  const a = call.args;
  if (typeof a["path"] === "string") {
    const path = a["path"];
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
    return [path, `${dir}/**`];
  }
  if (typeof a["command"] === "string") {
    const cmd = a["command"].trim();
    const parts = cmd.split(/\s+/);
    const base = parts[0] ?? cmd;
    const patterns = [`${base} *`];
    if (parts.length > 1) patterns.push(`${base} ${parts[1]} *`);
    patterns.push(cmd);
    return patterns;
  }
  // An MCP tool name is `mcp_<server>_<tool>` with the two structural `_`
  // separators only (segments escape their own `_`), so `parts[1]` is the
  // (escaped) server segment and `mcp_<server>_*` is the server-wide glob.
  if (call.tool.startsWith("mcp_")) {
    const server = call.tool.split("_")[1] ?? "";
    return [`mcp_${server}_*`, call.tool];
  }
  // A plugin or other internal tool has no value to match; the suggestion is
  // its own exact name as a tool-name rule.
  return [call.tool];
}

export class Guardian {
  constructor(private readonly guardrails: Guardrail[]) {}

  /**
   * Active fan-out grants, keyed by a fan-out id (§7.5, §9.5). A grant
   * auto-approves the actions of its fan-out — including merges and applies —
   * for the span of the fan-out; it is cleared when the fan-out concludes
   * (merged or abandoned) and is never persisted across sessions unless the
   * user chooses to. A grant NEVER overrides a hard deny, and Warden runs before
   * Guardian, so a grant can never approve what policy blocks (§7.5).
   */
  private readonly fanoutGrants = new Set<string>();

  /**
   * Live plan-scope auto-approvals, keyed by a registrant identifier (§9.5). A
   * scope is a set of write globs and execute patterns; a non-read call that
   * matches auto-approves BEFORE Guardian's rules evaluate — but NEVER a
   * force-ask (§9.3). A scope is cleared explicitly by the registrant and is
   * never persisted across sessions unless re-registered. The seam is core and
   * plan-agnostic; the first-party Plan plugin supplies a scope from the active
   * step. A scope NEVER overrides a hard-deny or a force-ask.
   */
  private readonly scopes = new Map<string, { writeGlobs: string[]; executePatterns: string[] }>();

  /** Register (or replace) a plan-scope under an identifier (§9.5). */
  registerScope(id: string, scope: { writeGlobs?: string[]; executePatterns?: string[] }): void {
    this.scopes.set(id, {
      writeGlobs: scope.writeGlobs ?? [],
      executePatterns: scope.executePatterns ?? [],
    });
  }

  /** Clear a plan-scope — the registrant does this explicitly (§9.5). */
  clearScope(id: string): void {
    this.scopes.delete(id);
  }

  /** True when any live scope covers a non-force-ask call (§9.5). */
  private scopeCovers(call: GuardedCall): boolean {
    if (this.scopes.size === 0) return false;
    const isExecute = call.tool === "execute_command" || call.tool === "wait";
    const value = callMatchValue(call);
    if (!value) return false;
    for (const s of this.scopes.values()) {
      const patterns = isExecute ? s.executePatterns : s.writeGlobs;
      if (patterns.some((p) => globMatch(p, value))) return true;
    }
    return false;
  }

  /** Open a fan-out grant at dispatch (§7.5, §9.5). */
  grantFanout(fanoutId: string): void {
    this.fanoutGrants.add(fanoutId);
  }

  /** Clear a fan-out grant when the fan-out concludes (§7.5). */
  clearFanout(fanoutId: string): void {
    this.fanoutGrants.delete(fanoutId);
  }

  /** True when a live grant covers this fan-out (§7.5). */
  hasFanoutGrant(fanoutId: string): boolean {
    return this.fanoutGrants.has(fanoutId);
  }

  /**
   * The first rule matching this call whose decision is `deny`, or undefined
   * (§9.2, §13.1). DENY ANYWHERE WINS: a deny in ANY layer at ANY priority
   * matching the call denies it — this is what blocks a force-ask outright
   * (§9.3) and what overrides a lower-layer or session-persisted allow. The rule
   * is returned (not a boolean) so the deny message can name its layer/source.
   */
  private matchingDenyRule(call: GuardedCall, rules: PermissionRule[]): PermissionRule | undefined {
    const value = callMatchValue(call);
    // DENY ANYWHERE WINS (§9.2, §13.1): among ALL rules that match this call —
    // from any layer, at any priority — a single `deny` denies the call. Priority
    // and layer order decide between `allow` and `ask`, never over a deny. This
    // also beats a session-persisted allow (a higher-priority allow a user
    // persisted) because the deny is found regardless of priority.
    return rules
      .filter((r) => toolNameGlobMatch(r.tool, call.tool))
      .filter((r) => rulePatternMatches(r, call, value))
      .find((r) => r.decision === "deny");
  }

  /** The deny reason naming the matching rule's layer/source and tool/pattern so
   * `/access` and the user can see WHICH rule (and from which layer) denied the
   * call (§9.2). The config map key (rule id) is not carried on the rule object;
   * the source label (the layer) plus tool+pattern identifies it. */
  private denyReason(rule: PermissionRule): string {
    const where = `${rule.tool}${rule.pattern ? ` "${rule.pattern}"` : ""}`;
    return `denied by ${rule.source} rule (${where})`;
  }

  /** The non-secret id and reason for an exact-lift (owner D2c). A rule carries
   * no config-map key on the object, so the id is `<source>:<tool>` (the tool
   * and layer identify it; the pattern/command value is NOT included — it may
   * hold a secret). The `allow` outcome carries this so the decision point can
   * tell the user WHY a force-ask ran with no prompt. */
  private exactLiftOutcome(rule: PermissionRule): GuardianOutcome {
    const ruleId = `${rule.source}:${rule.tool}`;
    return {
      decision: "allow",
      forceAsk: false,
      exactLift: true,
      exactRuleId: ruleId,
      reason: `allowed by exact rule ${ruleId}`,
    };
  }

  /**
   * Evaluate a call in Guardian's fixed order (§9.1 step 5): the code-level
   * NEVER LIST first (denied outright, no prompt, §9.3/§13.10), then force-ask
   * classification, then rules, then default ask. A tool's read-class is NEVER
   * a permission input (§9) — a read is decided by a matching allow rule (or the
   * active agent's posture) exactly like any other call; the seeded allow list
   * (§13.8) is what makes the read built-ins free.
   *
   * `opts` carries the never-list context (§13.10): `unlock` (category ids to
   * lift, honored only from the global/managed layers — the caller resolves
   * that), the `workdir` the shell command runs in (the cwd of
   * `execute_command`, plumbed cleanly — never `process.cwd()`), and `realpath`
   * for the `rm -rf` symlink guard. Omitted → no unlock, no workdir refinement.
   *
   * FAIL CLOSED (owner D2d): a shell `command` longer than `MAX_COMMAND_LENGTH`
   * is denied up front, before any regex runs, because the anchored classifier
   * patterns are super-linear on a very long string. And the whole
   * classification is wrapped: ANY error thrown while classifying (pathological
   * nesting past the depth cap, an unexpected regex/engine failure, anything)
   * becomes a DENY with a fixed sentence — never an allow, never an ask, never
   * an uncaught throw that would crash the gate. Nothing containing the command
   * text is logged.
   */
  evaluate(
    call: GuardedCall,
    rules: PermissionRule[],
    lists: ShellLists,
    opts: GuardianEvalOptions = {},
  ): GuardianOutcome {
    // §D2d — a command too long to classify safely is denied BEFORE any regex
    // scan: the anchored force-ask/never patterns are quadratic on a huge single
    // string, so an over-long model-supplied command is refused with guidance to
    // run it from a file instead.
    if (
      (call.tool === "execute_command" || call.tool === "wait") &&
      typeof call.args["command"] === "string" &&
      call.args["command"].length > MAX_COMMAND_LENGTH
    ) {
      return {
        decision: "deny",
        forceAsk: false,
        reason: `blocked: command is too long to classify safely (limit ${MAX_COMMAND_LENGTH} characters); write it to a file with write_file and run the file`,
      };
    }
    // §D2d — fail closed on ANY classification error: a thrown error (e.g.
    // nesting past the depth cap) becomes a DENY, never an allow/ask/throw. The
    // message carries NO command text.
    try {
      return this.evaluateInner(call, rules, lists, opts);
    } catch {
      return {
        decision: "deny",
        forceAsk: false,
        reason: "blocked: this command could not be classified safely",
      };
    }
  }

  private evaluateInner(
    call: GuardedCall,
    rules: PermissionRule[],
    lists: ShellLists,
    opts: GuardianEvalOptions = {},
  ): GuardianOutcome {
    const unlocked = opts.unlock ?? EMPTY_UNLOCK;
    const rmDeps: RmWorkdirDeps = opts.realpath ? { realpath: opts.realpath } : {};
    // DENY ANYWHERE WINS (§9.2, §9.3, §13.1): a deny rule matching this call in
    // ANY layer at ANY priority blocks it — even a force-ask class (a dangerous
    // command, an SSRF-range URL, a plugin install) is denied outright, never
    // merely asked, and even a session-persisted higher-priority allow is beaten.
    const denyRule = this.matchingDenyRule(call, rules);

    // §8.4/§9.4 — CONTROL-FILE classification for the file tools. A
    // `write_file`/`edit_file` whose `path` resolves (via the ONE
    // `classifyControlPath`) to a `deny` control file is DENIED (use
    // `config.set`/`mcp.approve`, never the file tools); an `ask` control file is
    // a FORCE-ASK (`control-file`) — never auto-approved, liftable only by an
    // EXACT allow rule whose value is the normalized relative path (`exactLift`).
    // A deny rule anywhere still wins; the exact match value is the path.
    if ((call.tool === "write_file" || call.tool === "edit_file") && opts.controlPath) {
      const path = typeof call.args["path"] === "string" ? call.args["path"] : "";
      // Classify the RAW model path AND (S5 LOW) the SYMLINK-RESOLVED target, so
      // an in-workspace symlink pointing at a protected file cannot slip a write
      // through on the harmless-looking raw path. `realpath` is injected by the
      // decision point; absent (pure classification tests), only the raw path is
      // classified — identical to the prior behaviour.
      const cls = opts.realpath
        ? classifyResolvedControlPath(path, opts.controlPath, opts.realpath)
        : classifyControlPath(path, opts.controlPath);
      if (cls === "deny") {
        return {
          decision: "deny",
          forceAsk: false,
          reason: "protected control file: use config.set / mcp.approve, never the file tools",
        };
      }
      if (cls === "ask") {
        if (denyRule) return { decision: "deny", forceAsk: false, reason: this.denyReason(denyRule) };
        const lift = exactLiftRule(call, rules, "control-file");
        if (!lift) {
          return {
            decision: "ask",
            forceAsk: true,
            forceAskKind: "control-file",
            reason: `protected control file (always asked): ${path}`,
            inferredPatterns: inferPatterns(call),
          };
        }
        return this.exactLiftOutcome(lift);
      }
    }

    // Force-ask classification for shell and wait-check commands (§9.3). The
    // core shell tool is `execute_command` (§8.2); §9.3 keys off that name.
    if ((call.tool === "execute_command" || call.tool === "wait") && typeof call.args["command"] === "string") {
      const command = call.args["command"];
      // §9.3/§13.10 — the NEVER LIST runs FIRST and is immune to everything: no
      // allow rule, `unlisted: allow`, session approval, plan scope, or fan-out
      // grant can satisfy it, and there is no prompt. An id in `unlock` lifts its
      // category (it then falls to the force-ask list below).
      const never = classifyNever(command, unlocked);
      if (never) {
        return { decision: "deny", forceAsk: false, reason: neverListDenyReason(never) };
      }
      // §8.4/§9.4 — a WRITE-SHAPED shell command whose redirect target or any
      // operand resolves to a control path (via the ONE `classifyControlPath`).
      // A `deny` path is DENIED BEFORE the safe-list / exact lifting (so a safe
      // `echo x > .voidrift/config.json` can no longer slip through); an `ask`
      // path is a FORCE-ASK `control-file`, liftable only by an exact rule whose
      // value is the WHOLE command. A path that cannot be resolved statically
      // (variable indirection) is not matched here — the ordinary classification
      // then applies (accepted limitation).
      if (call.tool === "execute_command" && opts.controlPath) {
        const targets = controlPathWriteTargets(command);
        let askTarget: string | null = null;
        for (const t of targets) {
          const cls = classifyControlPath(t, opts.controlPath);
          if (cls === "deny") {
            return {
              decision: "deny",
              forceAsk: false,
              reason: `blocked: this command would change a VoidRift control file (${t}); use config.set / mcp.approve`,
            };
          }
          if (cls === "ask" && askTarget === null) askTarget = t;
        }
        if (askTarget !== null) {
          if (denyRule) return { decision: "deny", forceAsk: false, reason: this.denyReason(denyRule) };
          const lift = exactLiftRule(call, rules, "control-file");
          if (!lift) {
            return {
              decision: "ask",
              forceAsk: true,
              forceAskKind: "control-file",
              reason: `command writes a protected control file (always asked): ${askTarget}`,
              inferredPatterns: inferPatterns(call),
            };
          }
          return this.exactLiftOutcome(lift);
        }
      }
      // §4.4/§8.2/§9.3 — OUTSIDE-WORKSPACE force-ask. The working directory is
      // explicit state rooted at the workspace (a worker's worktree root for a
      // worker). A command that `cd`s to, or names an absolute path outside, the
      // root is force-asked so the agent never silently reads/writes outside the
      // workspace through the shell — mirroring the file tools (§8.2). Checked
      // BEFORE the safe/equivalent classification so a safe-listed command naming
      // an outside path (`ls /tmp`) still asks; the never list already ran above
      // (catastrophic system targets are denied, not asked). Classification over
      // the command text, not an OS sandbox: an unresolvable path (variable/glob/
      // `~user`) falls back to the ordinary classification. Lifted by an EXACT
      // whole-command allow rule like any other force-ask (the `shell` lift).
      if (opts.workdir && commandLeavesWorkspace(command, opts.workdir, opts.home ? { home: opts.home } : {})) {
        if (denyRule) return { decision: "deny", forceAsk: false, reason: this.denyReason(denyRule) };
        const owLift = exactLiftRule(call, rules, "shell");
        if (!owLift) {
          return {
            decision: "ask",
            forceAsk: true,
            forceAskKind: "outside-workspace",
            reason: "command touches paths outside the workspace (always asked)",
            inferredPatterns: inferPatterns(call),
          };
        }
        return this.exactLiftOutcome(owLift);
      }
      const { cls, segment } = classifyCommand(command, lists);
      if (cls === "hard-deny") {
        return { decision: "deny", forceAsk: false, reason: `hard-deny: ${segment}` };
      }
      if (cls === "dangerous") {
        // Owner D1.4 — a recursive+force `rm` whose every operand resolves
        // strictly INSIDE the workdir is NOT a force-ask: it flows normally (the
        // agent posture + ordinary allow/deny rules decide). A `.git`/`.voidrift`
        // operand, the workdir itself, a glob/variable, or an outside path keeps
        // it a force-ask. Checked only for the `rm` dangerous class.
        if (rmAllOperandsInsideWorkdir(segment, opts.workdir, rmDeps, command)) {
          // Fall through to the normal rule/posture path below.
        } else {
          if (denyRule) return { decision: "deny", forceAsk: false, reason: this.denyReason(denyRule) };
          const shellLift = exactLiftRule(call, rules, "shell");
          if (!shellLift) {
            return {
              decision: "ask",
              forceAsk: true,
              forceAskKind: "shell",
              reason: `dangerous command: ${segment}`,
              inferredPatterns: inferPatterns(call),
            };
          }
          // Lifted by an exact rule → allow directly, carrying the lift reason
          // (deny was checked above; a literal pattern must not be re-tested
          // through the glob matcher below).
          return this.exactLiftOutcome(shellLift);
        }
      } else if (cls === "has-equivalent") {
        return { decision: "deny", forceAsk: false, reason: `use the first-class tool instead of: ${segment}` };
      } else if (cls === "safe") {
        return { decision: "allow", forceAsk: false };
      }
      // unknown, or an inside-workdir rm → fall through to rules
    }

    // Force-ask classification for web_fetch SSRF-range URLs (§8.2, §9.3 last
    // paragraph, §15.1#5): a private, loopback, link-local, metadata,
    // unspecified, CGNAT, or IPv4-mapped URL is force-asked regardless of
    // policy rules, a plan scope, or a fan-out grant — immune by the same
    // principle as a dangerous shell command. Only an explicit deny blocks it.
    // A bad scheme is rejected structurally (never fetched). The host is the
    // PARSED host (classifyUrl uses the WHATWG parser), closing userinfo/IDN/
    // obfuscation evasions. The adapter re-checks DNS and every redirect hop.
    if (call.tool === "web_fetch" && typeof call.args["url"] === "string") {
      const u = classifyUrl(call.args["url"]);
      if (u.verdict === "reject") {
        return { decision: "deny", forceAsk: false, reason: `web_fetch scheme/url rejected: ${u.reason}` };
      }
      // §9.3/§13.10 — a cloud-metadata address is a code-level NEVER (denied),
      // checked BEFORE the SSRF verdict because a by-NAME metadata host
      // (`metadata.google.internal`) classifies as a public name; `unlock`ing
      // `metadata-hosts` lifts it back to the ordinary SSRF force-ask below.
      const mnever = metadataNever(call.args["url"], unlocked);
      if (mnever) return mnever;
      if (u.verdict === "force-ask") {
        if (denyRule) return { decision: "deny", forceAsk: false, reason: this.denyReason(denyRule) };
        // owner D2a.2 — an EXACT host allow rule (the URL host equal) or a
        // matching `cidr` rule LIFTS this SSRF force-ask: fall through to rules.
        // Metadata addresses are a NEVER (handled above) and are never liftable.
        const ssrfLift = exactLiftRule(call, rules, "ssrf");
        if (!ssrfLift) {
          return {
            decision: "ask",
            forceAsk: true,
            forceAskKind: "ssrf",
            reason: `SSRF-range URL (${u.reason})`,
            inferredPatterns: inferPatterns(call),
          };
        }
        // Lifted by an exact host / cidr rule → allow directly.
        return this.exactLiftOutcome(ssrfLift);
      }
      // allow (public) → fall through to rules so an allow/deny rule still applies.
    }

    // Force-ask classification for `web_search` (§8.2, §9.3). The model supplies
    // only `{ query }` — never a URL — so the gate classifies the CONFIGURED
    // endpoint host (§13.9), injected by the decision point as `webSearchEndpoint`
    // (never model-supplied). The keyless default (`duckduckgo`) and the keyed
    // cloud providers have no endpoint → a public host → fall through to rules.
    // A self-hosted `searxng` on a private, loopback, link-local or cloud-metadata
    // host is a trust-changing always-ask on EVERY call — there is no
    // configured-endpoint exemption: visibility (`/access`, `doctor`), not a
    // layer gate, is the safeguard. Only an explicit deny blocks it outright; an
    // exact host/CIDR allow is a later slice.
    if (call.tool === "web_search") {
      const endpoint = typeof call.args["webSearchEndpoint"] === "string" ? call.args["webSearchEndpoint"] : "";
      if (endpoint !== "") {
        const u = classifyUrl(endpoint);
        if (u.verdict === "force-ask") {
          const mnever = metadataNever(endpoint, unlocked);
          if (mnever) return mnever;
          if (denyRule) return { decision: "deny", forceAsk: false, reason: this.denyReason(denyRule) };
          // owner D2a.2 — an EXACT host rule or matching `cidr` rule on
          // `web_search` LIFTS this endpoint force-ask (the match value is the
          // endpoint host, carried on the guard copy as `webSearchEndpoint`).
          const searchLift = exactLiftRule(call, rules, "ssrf");
          if (!searchLift) {
            return {
              decision: "ask",
              forceAsk: true,
              forceAskKind: "ssrf",
              reason: `web_search endpoint is a ${u.reason} host`,
              inferredPatterns: inferPatterns(call),
            };
          }
          // Lifted by an exact host / cidr rule → allow directly.
          return this.exactLiftOutcome(searchLift);
        }
      }
      // Public host → fall through to rules.
    }

    // Force-ask classification for `plugins_install` (§12.4.1): installing a
    // plugin stages trusted in-process code that runs on the next boot, so it is
    // a force-ask on the same principle as a dangerous shell command — nothing
    // auto-approves it (not a wildcard `allow`, not an explicit `plugins_install`
    // allow, not a plan scope, not a fan-out grant), and only an explicit,
    // highest-priority DENY blocks it. The gate routes the resulting ask to the
    // out-of-band masked review. (`search`/`inspect` are reads and never reach
    // here.)
    if (call.tool === "plugins_install") {
      if (denyRule) return { decision: "deny", forceAsk: false, reason: this.denyReason(denyRule) };
      // owner D2a.2 — an EXACT `plugins_install` allow rule whose pattern equals
      // the call's `<package>@<version>` LIFTS this force-ask: fall through to
      // the normal rule/posture path (it then allows). A glob/wildcard never
      // lifts it.
      const installLift = exactLiftRule(call, rules, "plugin-install");
      if (!installLift) {
        return { decision: "ask", forceAsk: true, forceAskKind: "plugin-install", reason: "plugin install requires out-of-band review" };
      }
      // Lifted by an exact `name@version` rule → allow directly.
      return this.exactLiftOutcome(installLift);
    }

    // Plan-scope auto-approval (§9.5): a registered scope auto-approves a
    // matching non-read call BEFORE the rules evaluate — but it never reaches
    // here for a force-ask (that returned above) and never overrides a hard-deny
    // (also returned above). A plan step that declares its writes/executes thus
    // proceeds without a prompt, while a dangerous command still force-asks.
    if (this.scopeCovers(call)) return { decision: "allow", forceAsk: false };

    // Rule resolution (§9.2, §13.1). DENY ANYWHERE WINS: a matching deny in any
    // layer at any priority was handled up front — if one exists, deny now
    // naming its layer/source. Between `allow` and `ask`, today's
    // highest-priority-wins ordering decides; a rule's `tool` field is a glob
    // matched against the call's TOOL NAME (`"*"` = any, an exact name, or a
    // wildcard like `mcp_github_*`/`mcp_*`); its optional `pattern` is a
    // command/path/url glob matched against the call value (§8.4).
    if (denyRule) return { decision: "deny", forceAsk: false, reason: this.denyReason(denyRule) };
    const value = callMatchValue(call);
    const matching = rules
      .filter((r) => toolNameGlobMatch(r.tool, call.tool))
      .filter((r) => rulePatternMatches(r, call, value))
      .sort((a, b) => b.priority - a.priority);
    // Deny was resolved above; only allow/ask remain, ordered by priority.
    const top = matching.find((r) => r.decision !== "deny");
    if (top) {
      if (top.decision === "allow") return { decision: "allow", forceAsk: false };
    }
    // No matching rule → ask, offering inferred trust patterns.
    return { decision: "ask", forceAsk: false, inferredPatterns: inferPatterns(call) };
  }

  /** Run guardrails after the decision allows; the first block wins (§9.4). */
  runGuardrails(call: GuardedCall, ctx: GuardrailContext): GuardrailResult {
    for (const g of this.guardrails) {
      const r = g.check(call, ctx);
      if (!r.allowed) return r;
    }
    return { allowed: true };
  }
}

/** The journal directory tails a path (after normalization) resolves under
 * (§10.11): the project store `.voidrift/journal/` or the global store tail
 * `voidrift/journal/`. */
const JOURNAL_DIR_TAILS = [".voidrift/journal", "voidrift/journal"];

/**
 * True when a raw string references the mutation journal path (§9.4, §10.11),
 * after statically resolving `..`, `./`, and `$HOME`/`~` forms we can. Used for
 * BOTH a file-tool path arg and an `execute_command` command text: a command is
 * a free-form string, so the match is substring-based over the normalized text
 * (every occurrence is normalized independently). A dynamic form we cannot
 * resolve statically (a shell variable other than HOME, a substitution) that
 * still spells out the journal tail literally is caught by the substring check.
 */
export function referencesJournalPath(raw: string, workspaceRoot?: string): boolean {
  if (!raw) return false;
  // Normalize separators and statically-resolvable home forms, then collapse
  // `./` and `..` per slash-run so an obfuscated path still lands on the tail.
  let text = raw.replace(/\\/g, "/");
  const home = process.env["HOME"];
  if (home) text = text.split(home.replace(/\\/g, "/")).join("~");
  // Strip a workspace-root absolute prefix to a relative form.
  if (workspaceRoot) {
    const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    text = text.split(root + "/").join("");
  }
  // Collapse ./ and resolve .. within each path-like run (a run of path chars).
  const collapsed = text.replace(/[^\s"'`=:,()]+/g, (run) => {
    if (!run.includes("/")) return run;
    const segs: string[] = [];
    for (const seg of run.split("/")) {
      if (seg === "." ) continue;
      if (seg === "..") { segs.pop(); continue; }
      segs.push(seg);
    }
    return segs.join("/");
  });
  const needle = collapsed.replace(/^~\//, "").replace(/\/+/g, "/");
  for (const tail of JOURNAL_DIR_TAILS) {
    if (needle.includes(tail + "/") || needle.endsWith(tail)) return true;
  }
  return false;
}

/** True when `rawPath` targets a protected control file (§8.4) — a thin wrapper
 * over the ONE `classifyControlPath` (owner S1): the old behaviour is the `deny`
 * class (project/global `config.json`/`managed.json`/`mcp-pins.json`, the plugin
 * stores, the journal). The global config dir and home are read from the
 * environment here (as `referencesJournalPath` already does) so older callers
 * that pass only a workspace root keep working; the decision point passes an
 * explicit `controlPath` context to `evaluate` for the full classification. */
export function isProtectedControlFile(rawPath: string, workspaceRoot?: string): boolean {
  if (!rawPath) return false;
  const configHome = process.env["XDG_CONFIG_HOME"] ?? (process.env["HOME"] ? `${process.env["HOME"]}/.config` : undefined);
  const ctx: ControlPathContext = {
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(configHome ? { globalConfigDir: `${configHome}/voidrift` } : {}),
    ...(process.env["HOME"] ? { home: process.env["HOME"] } : {}),
  };
  return classifyControlPath(rawPath, ctx) === "deny";
}

/** The built-in guardrails (§9.4). */
export function builtinGuardrails(): Guardrail[] {
  return [
    {
      // §9.4 / §10.11 — the mutation journal (`.voidrift/journal/`) is a
      // PROTECTED CONTROL LOCATION the file AND shell tools can neither READ nor
      // WRITE. This widens beyond the write-only control-file guard below to
      // also cover the read-class tools and `researcher_save_notes`, and denies
      // any `execute_command` whose command text references the journal path.
      name: "protected-journal",
      check(call, ctx) {
        const JOURNAL_DENY =
          "the mutation journal is a protected location: the file and shell tools can neither read nor write it";
        // File-path tools: read-class and write-class alike.
        const PATH_TOOLS = new Set([
          "read_file",
          "glob_files",
          "search_contents",
          "workspace_map",
          "write_file",
          "edit_file",
          "researcher_save_notes",
        ]);
        if (PATH_TOOLS.has(call.tool)) {
          // The various tools name their target differently; check every plausible
          // path-bearing field.
          for (const key of ["path", "dir", "root", "glob", "pattern", "query"]) {
            const v = call.args[key];
            if (typeof v === "string" && referencesJournalPath(v, ctx.workspaceRoot)) {
              return { allowed: false, reason: JOURNAL_DENY };
            }
          }
          return { allowed: true };
        }
        if (call.tool === "execute_command") {
          const cmd = typeof call.args["command"] === "string" ? call.args["command"] : "";
          if (cmd && referencesJournalPath(cmd, ctx.workspaceRoot)) {
            return { allowed: false, reason: JOURNAL_DENY };
          }
        }
        return { allowed: true };
      },
    },
    {
      name: "protected-control-file-write",
      check(call, ctx) {
        if (call.tool !== "write_file" && call.tool !== "edit_file") return { allowed: true };
        const path = typeof call.args["path"] === "string" ? call.args["path"] : "";
        if (isProtectedControlFile(path, ctx.workspaceRoot)) {
          return {
            allowed: false,
            reason: "protected control file: use mcp.approve / config.set, never the file tools",
          };
        }
        return { allowed: true };
      },
    },
    {
      name: "unread-or-stale-edit",
      check(call, ctx) {
        if (call.tool !== "edit_file") return { allowed: true };
        const path = typeof call.args["path"] === "string" ? call.args["path"] : "";
        if (ctx.stalePaths.has(path)) {
          return { allowed: false, reason: "file is stale, re-read" };
        }
        if (!ctx.readPaths.has(path)) {
          return { allowed: false, reason: "read the file first" };
        }
        return { allowed: true };
      },
    },
    {
      name: "temp-dir-write",
      check(call, ctx) {
        if (call.tool !== "write_file" && call.tool !== "edit_file") return { allowed: true };
        const path = typeof call.args["path"] === "string" ? call.args["path"] : "";
        if (ctx.tempDir && path.startsWith(ctx.tempDir)) {
          return { allowed: false, reason: "write under .voidrift/cache/ instead of a system temp dir" };
        }
        return { allowed: true };
      },
    },
    {
      name: "large-edit",
      check(call) {
        if (call.tool !== "edit_file") return { allowed: true };
        const search = typeof call.args["search"] === "string" ? call.args["search"] : "";
        if (search.split("\n").length > 50) {
          return { allowed: false, reason: "narrow the edit: search block exceeds 50 lines" };
        }
        return { allowed: true };
      },
    },
  ];
}
