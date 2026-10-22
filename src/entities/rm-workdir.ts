/**
 * `rm -rf` within-workdir analysis (core-blueprint.md §9.3; owner D1.4).
 *
 * A recursive+force `rm` is NORMALLY an always-ask (dangerous shell). The owner
 * refined it: such an `rm` is NOT a force-ask when EVERY operand is a literal
 * path that resolves strictly INSIDE the working directory — then it follows the
 * normal flow (the agent's `unlisted` posture and ordinary allow/deny rules
 * decide). Everything else (outside the workdir, the workdir itself, a glob or
 * variable, a `.git`/`.voidrift` operand, a system dir via the never list) stays
 * force-ask or never.
 *
 * This is pure path logic over the ALREADY-NORMALIZED segment (quotes/escapes
 * collapsed by `normalizeShell`), plus an injected `realpath` so a symlink whose
 * existing prefix points OUTSIDE the workdir does not qualify. No fs import here;
 * the decision point injects `fs.realpathSync.native`. Without a resolver (pure
 * unit tests) the lexical checks still apply and only the symlink step is
 * skipped — a resolver is injected in production so the symlink guard is live.
 */

/** A segment is a recursive+force `rm` whose operands we may inspect. */
const REC_FORCE_RM =
  // rm (optional binary path), recursive AND force in any order/spelling, then
  // the operands. Mirrors the force-ask `rm` family but captures the tail.
  new RegExp(
    "^((?:\\S*/)?rm)((?: -\\S+)*)\\s+(.*)$",
  );

/** Does this normalized segment carry BOTH recursive and force rm flags? */
function hasRecursiveAndForce(flagRun: string): boolean {
  const flags = flagRun.trim().split(/\s+/).filter(Boolean);
  let rec = false;
  let force = false;
  for (const f of flags) {
    if (!f.startsWith("-")) continue;
    if (f.startsWith("--")) {
      if (f === "--recursive") rec = true;
      if (f === "--force") force = true;
    } else {
      // Combined short flags: -rf, -fr, -Rf, -rvf …
      if (/[rR]/.test(f)) rec = true;
      if (/f/.test(f)) force = true;
    }
  }
  return rec && force;
}

/** Operand characters that make a path non-literal: shell expansion and globs. */
function isLiteralOperand(op: string): boolean {
  if (op.length === 0) return false;
  // No variable/command/home expansion.
  if (/[$`]/.test(op)) return false;
  if (op.startsWith("~")) return false;
  // No glob metacharacters.
  if (/[*?[\]{}]/.test(op)) return false;
  return true;
}

/** Split a POSIX path into segments, dropping empty and `.` segments; a `..`
 * that would climb above the root is kept so an escaping path is detected. */
function normalizeRelative(p: string): string[] {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      // Climb: pop a real segment, or record an escape marker if at the top.
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
    } else {
      out.push(seg);
    }
  }
  return out;
}

/** Operands that remain always-ask even when inside the workdir (D1.4). */
function isProtectedOperand(relSegs: string[]): boolean {
  return relSegs.length > 0 && (relSegs[0] === ".git" || relSegs[0] === ".voidrift");
}

/** Command words that change the working directory (D1b). As the FIRST word of
 * a tokenized segment these move the shell's cwd, so a relative operand of a
 * later `rm` no longer resolves against the workdir. */
const DIR_CHANGE_COMMANDS: ReadonlySet<string> = new Set(["cd", "pushd", "popd", "chdir"]);

/** Interpreter wrappers whose `-c`/string argument is a nested command line:
 * a `cd` inside it also moves the directory (D1b). */
const INTERPRETER_WRAPPERS: ReadonlySet<string> = new Set(["bash", "sh", "eval", "zsh", "dash"]);

/** A directory-changing flag on a wrapper (`env -C DIR`, `env --chdir=DIR`,
 * `--directory=DIR`): `-C`/`--chdir`/`--directory` with or without `=VALUE`. */
const CHDIR_FLAG = /^(-C|--chdir|--directory)(=.*)?$/;

/** A `NAME=value` environment-assignment prefix that precedes a command word. */
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;

/** A lexed token: a plain `word` (quotes collapsed) or a shell `op` separator. */
type Lexed = { kind: "word"; value: string } | { kind: "op"; value: string };

/**
 * Lex a command string into words and operator separators, honoring single and
 * double quotes (a quoted run is ONE word; its inner text is not re-lexed) and
 * backslash escapes. Operators recognized: `&&`, `||`, `;`, `|`, `(`, `)`,
 * `{`, `}`, `&`. Enough structure to tell a `cd` COMMAND WORD (first word of a
 * statement) from the word `cd` passed as an argument or quoted.
 */
function lex(command: string): Lexed[] {
  const out: Lexed[] = [];
  let cur = "";
  let has = false;
  const flush = () => {
    if (has) {
      out.push({ kind: "word", value: cur });
      cur = "";
      has = false;
    }
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const two = command.slice(i, i + 2);
    if (ch === '"' || ch === "'") {
      // Consume the quoted run verbatim.
      const close = command.indexOf(ch, i + 1);
      const end = close === -1 ? command.length : close;
      cur += command.slice(i + 1, end);
      has = true;
      i = end;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      cur += command[i + 1]!;
      has = true;
      i++;
      continue;
    }
    if (two === "&&" || two === "||") {
      flush();
      out.push({ kind: "op", value: two });
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "(" || ch === ")" || ch === "{" || ch === "}" || ch === "&") {
      flush();
      out.push({ kind: "op", value: ch });
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    cur += ch;
    has = true;
  }
  flush();
  return out;
}

/**
 * True when `command` contains ANY directory-changing construct (D1b): a `cd`/
 * `pushd`/`popd`/`chdir` COMMAND WORD at the start of any statement; a
 * `-C`/`--chdir`/`--directory` flag on a wrapper (`env -C DIR cmd`); or an
 * interpreter wrapper (`bash -c`/`sh -c`/`eval`) whose argument string contains
 * such a construct. Any one of these in the same command string disables the
 * inside-workdir refinement for the whole command, regardless of order relative
 * to the `rm`.
 *
 * Statement-aware: the word `cd` is a trigger only as the first word of a
 * statement (after start, `&&`, `||`, `;`, `|`, a subshell `(`, a group `{`, or
 * `&`), never as an argument. So `echo cd && rm -rf build` and `rm -rf cd` do
 * NOT trip it, while `cd /`, `(cd /; …)`, `{ cd /; …}`, and `bash -c 'cd …'` do.
 */
export function commandChangesDirectory(command: string): boolean {
  const toks = lex(command);
  let atCommandStart = true;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind === "op") {
      // Every separator (incl. opening a subshell/group) starts a new statement.
      if (["&&", "||", ";", "|", "(", "{", "&"].includes(t.value)) atCommandStart = true;
      continue;
    }
    // A leading `NAME=value` env assignment does not consume the command slot.
    if (atCommandStart && ENV_ASSIGN.test(t.value)) continue;
    if (atCommandStart) {
      if (DIR_CHANGE_COMMANDS.has(t.value)) return true;
      if (INTERPRETER_WRAPPERS.has(t.value)) {
        // The nested string argument of an interpreter is a command line; a
        // `cd` inside it also changes the directory. Re-examine each later word
        // of this statement as its own command line.
        for (let j = i + 1; j < toks.length; j++) {
          const n = toks[j]!;
          if (n.kind === "op" && ["&&", "||", ";", "&"].includes(n.value)) break;
          if (n.kind === "word" && commandChangesDirectory(n.value)) return true;
        }
      }
      atCommandStart = false;
    }
    // A chdir flag anywhere among a statement's words is a wrapper dir change.
    if (CHDIR_FLAG.test(t.value)) return true;
  }
  return false;
}

export interface RmWorkdirDeps {
  /** Resolve a path's existing prefix to a real path (symlinks followed). When
   * absent, the symlink guard is skipped (lexical checks still apply). */
  realpath?: (p: string) => string;
}

/**
 * True when `command`'s recursive+force `rm` has EVERY operand strictly inside
 * `workdir` (so it should flow normally rather than force-ask). Returns false
 * for anything that is not a rec+force `rm`, has no operands, has a non-literal
 * or escaping operand, targets the workdir itself, or targets `.git`/`.voidrift`.
 * The caller only consults this when the segment already classified `dangerous`.
 *
 * `fullCommand` (D1b) is the WHOLE command string the `rm` segment came from. If
 * it contains ANY directory-changing construct (`cd`/`pushd`/`popd`/`chdir`, a
 * `-C`/`--chdir`/`--directory` wrapper flag, a subshell/group or `bash -c`/`sh
 * -c`/`eval` string that does so) the refinement is disabled for the whole
 * command: a relative operand no longer reliably resolves against the workdir,
 * so the `rm` stays an always-ask. Defaults to `command` when omitted.
 */
export function rmAllOperandsInsideWorkdir(
  command: string,
  workdir: string | undefined,
  deps: RmWorkdirDeps = {},
  fullCommand: string = command,
): boolean {
  if (!workdir) return false;
  // D1b — any directory-changing construct anywhere in the command disables the
  // inside-workdir refinement: relative operands can no longer be trusted
  // against the workdir, and (keeping it simple) absolute operands lose it too.
  if (commandChangesDirectory(fullCommand)) return false;
  const m = REC_FORCE_RM.exec(command.trim());
  if (!m) return false;
  const flagRun = m[2] ?? "";
  const tail = m[3] ?? "";
  if (!hasRecursiveAndForce(flagRun)) return false;

  // Operands are the tail tokens that are not flags. A `--` ends options.
  const tokens = tail.split(/\s+/).filter(Boolean);
  const operands: string[] = [];
  let endOpts = false;
  for (const t of tokens) {
    if (!endOpts && t === "--") {
      endOpts = true;
      continue;
    }
    if (!endOpts && t.startsWith("-")) continue; // a trailing flag
    operands.push(t);
  }
  if (operands.length === 0) return false;

  const root = workdir.replace(/\/+$/, "");
  const rootSegs = normalizeRelative(root);

  for (const op of operands) {
    if (!isLiteralOperand(op)) return false;

    // Build the absolute, lexically-normalized path of the operand.
    let absSegs: string[];
    if (op.startsWith("/")) {
      absSegs = normalizeRelative(op);
      // An absolute operand must start with the workdir prefix.
      if (!startsWithPrefix(absSegs, rootSegs)) return false;
    } else {
      absSegs = normalizeRelative(root + "/" + op);
    }

    // Any residual `..` means the path climbed above the filesystem root.
    if (absSegs.includes("..")) return false;

    // Must be strictly INSIDE the workdir (a sub-path), never equal to it.
    if (!startsWithPrefix(absSegs, rootSegs) || absSegs.length <= rootSegs.length) {
      return false;
    }

    // `.git` / `.voidrift` operand (at the workdir top) stays always-ask.
    const rel = absSegs.slice(rootSegs.length);
    if (isProtectedOperand(rel)) return false;

    // Symlink guard: resolve the existing prefix with realpath; if it points
    // outside the workdir, the operand does not qualify (D1.4).
    if (deps.realpath) {
      const resolved = resolveExistingPrefix("/" + absSegs.join("/"), deps.realpath);
      const resolvedSegs = normalizeRelative(resolved);
      const realRootSegs = normalizeRelative(resolveExistingPrefix(root, deps.realpath));
      if (!startsWithPrefix(resolvedSegs, realRootSegs) || resolvedSegs.length <= realRootSegs.length) {
        // Equal-length is only a problem for a sub-path requirement; a resolved
        // path that lands AT the real workdir (operand was a link to the root)
        // also fails the strict-inside rule.
        return false;
      }
    }
  }
  return true;
}

/** True when `segs` begins with every element of `prefix`. */
function startsWithPrefix(segs: string[], prefix: string[]): boolean {
  if (segs.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (segs[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * Resolve the longest EXISTING prefix of an absolute path with `realpath`,
 * appending the non-existing tail unchanged. This follows a symlink in the
 * existing prefix (a link pointing outside the workdir is thereby caught) while
 * tolerating the final component not existing yet. Falls back to the input on
 * any realpath error.
 */
function resolveExistingPrefix(absPath: string, realpath: (p: string) => string): string {
  const segs = absPath.split("/").filter((s) => s !== "");
  for (let i = segs.length; i >= 1; i--) {
    const candidate = "/" + segs.slice(0, i).join("/");
    try {
      const real = realpath(candidate);
      const tail = segs.slice(i);
      return tail.length > 0 ? real.replace(/\/+$/, "") + "/" + tail.join("/") : real;
    } catch {
      // keep shrinking
    }
  }
  return absPath;
}
