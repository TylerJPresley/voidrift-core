/**
 * The ONE shared shell segment splitter (core-blueprint.md §9.3; owner D2c).
 *
 * A compound command may run several commands separated by far more than the
 * `&&`/`||`/`;`/`|` the first cut handled: a NEWLINE (`\n`, `\r`), a single `&`
 * (background — but NOT `&&`, `>&`, `&>`, `2>&1`, `|&`, which are a redirect or
 * a pipe), `|&` (pipe stdout+stderr), and the group delimiters `(` `)` `{` `}`.
 * A line continuation (`\` immediately before a newline) JOINS the two physical
 * lines into one logical command (`sudo \<newline> reboot` is ONE command).
 *
 * The splitter is QUOTE- and HEREDOC-AWARE: a separator INSIDE single quotes,
 * double quotes, or a heredoc body is literal text, not a command boundary (a
 * quoted string later handed to `bash -c`/`eval`/`xargs` is still recursively
 * classified by the caller — that is unchanged). When the splitter CANNOT prove
 * a safe split — an unbalanced quote or an open heredoc — it FAILS CLOSED: it
 * returns the whole input as one segment PLUS every physical line as its own
 * segment, so the never list and the force-ask classifier still see each line.
 *
 * This is the single source of truth: `guardian.splitSegments`,
 * `guardian.pipelineSinks`, and `classifyNever` all route through it so the
 * never list, the force-ask classification, and `rm -rf` analysis split
 * identically (DRY, §1 rule 10). It returns trimmed, non-empty segments.
 */

/** The outcome of a split: the segments, and whether the lexer failed closed. */
export interface SplitResult {
  segments: string[];
  /** True when quoting/heredoc could not be resolved; the caller treats the
   * WHOLE command as one segment too (fail-closed, §9.3). */
  failedClosed: boolean;
}

/** The separators that end a command segment. `|&` and `&&`/`||` are matched
 * before the single-char forms so a two-char operator is never mis-split. */
type Sep = "\n" | ";" | "&&" | "||" | "|&" | "|" | "&" | "(" | ")" | "{" | "}";

/**
 * Join line-continuations (`\` at end of a physical line) so a continued
 * command is one logical line before any splitting. A backslash that is itself
 * escaped (`\\`) does NOT continue the line.
 */
function joinContinuations(command: string): string {
  let out = "";
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "\\") {
      const next = command[i + 1];
      if (next === "\n") {
        i++; // drop the backslash AND the newline → join
        continue;
      }
      if (next === "\r" && command[i + 2] === "\n") {
        i += 2;
        continue;
      }
      // A lone escaped char (incl. `\\`): keep both so quote/escape handling
      // downstream still sees it.
      out += ch;
      if (next !== undefined) {
        out += next;
        i++;
      }
      continue;
    }
    out += ch;
  }
  return out;
}

/** Detect an unbalanced single/double quote run over the whole command (a
 * backslash escapes the next char outside single quotes). Used for fail-closed. */
function hasUnbalancedQuote(command: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
  }
  return quote !== null;
}

/**
 * Detect an open (unterminated) heredoc: a `<<`/`<<-` with a delimiter word for
 * which no closing delimiter line appears. A balanced heredoc is fine (its body
 * is quoted text); an OPEN one means we cannot trust the rest, so fail closed.
 */
/** A heredoc opener (`<<WORD`, `<<-WORD`, `<<"WORD"`), but NOT a here-string
 * `<<<` (the `(?!<)` after `<<-?` rejects the third `<`). The delimiter word is
 * captured in group 1. Shared by the open-heredoc check and the body skipper. */
const HEREDOC_RE_SRC = '(?<!<)<<-?(?!<)\\s*["\']?([A-Za-z_][A-Za-z0-9_]*)["\']?';

function hasOpenHeredoc(command: string): boolean {
  const lines = command.split(/\r?\n/);
  const re = new RegExp(HEREDOC_RE_SRC);
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]!);
    if (!m) continue;
    const delim = m[1]!;
    let closed = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trim() === delim) {
        closed = true;
        break;
      }
    }
    if (!closed) return true;
  }
  return false;
}

/** Strip a leading/trailing run of group-delimiter tokens (`(` `)` `{` `}`) and
 * surrounding whitespace from a segment so `(sudo reboot)` and `{ sudo reboot`
 * classify as `sudo reboot`. A function head like `:(){` has no SEPARATOR before
 * its `(`, so it is one segment and is NOT stripped internally. */
function stripGroupDelimiters(seg: string): string {
  let s = seg.trim();
  let prev: string;
  do {
    prev = s;
    s = s.replace(/^[({\s]+/, "").replace(/[)}\s]+$/, "").trim();
  } while (s !== prev);
  return s;
}

/** The physical lines of a command as trimmed, non-empty segments (used by the
 * fail-closed path and to scan every line regardless of a safe split). */
function physicalLines(command: string): string[] {
  return command
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Split a command into segments on every command boundary, quote/heredoc aware
 * and fail-closed. Group delimiters `(` `)` `{` `}` are treated as boundaries
 * AND stripped from the resulting segments. A heredoc BODY is skipped (it is not
 * command text). Line continuations are joined first.
 */
export function splitShellSegments(command: string): SplitResult {
  // Fail closed on anything we cannot lex safely: hand back the whole command
  // as one segment PLUS every physical line, so a dangerous line is still seen.
  if (hasUnbalancedQuote(command) || hasOpenHeredoc(command)) {
    const segs = new Set<string>([command.trim(), ...physicalLines(command)]);
    return { segments: [...segs].filter((s) => s.length > 0), failedClosed: true };
  }

  const joined = joinContinuations(command);
  const segments: string[] = [];
  let cur = "";
  const lines = joined.split(/\r?\n/);

  const flush = () => {
    const s = stripGroupDelimiters(cur);
    if (s.length > 0) segments.push(s);
    cur = "";
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    // A heredoc on this line: everything up to `<<WORD` is command text; its
    // body lines (until the delimiter) are skipped as data.
    const hd = new RegExp(HEREDOC_RE_SRC).exec(line);
    for (let i = 0; i < line.length; i++) {
      const sep = separatorAt(line, i);
      if (sep === null) {
        cur += line[i]!;
        // Skip over a quoted run verbatim so separators inside quotes are text.
        const ch = line[i]!;
        if (ch === "'" || ch === '"') {
          const close = findClose(line, i, ch);
          cur += line.slice(i + 1, close + 1);
          i = close;
        } else if (ch === "\\" && i + 1 < line.length) {
          cur += line[i + 1]!;
          i++;
        }
        continue;
      }
      flush();
      i += sep.length - 1; // consume the multi-char operator
    }
    // End of a physical line is a command boundary (a newline separates).
    flush();
    // If this line opened a heredoc, skip its body lines up to the delimiter.
    if (hd) {
      const delim = hd[1]!;
      while (li + 1 < lines.length && lines[li + 1]!.trim() !== delim) li++;
      if (li + 1 < lines.length) li++; // consume the delimiter line
    }
  }
  flush();
  return { segments, failedClosed: false };
}

/**
 * The pipeline-SINK stages of a command (owner D2c, moved from guardian): every
 * pipeline stage that reads the stdout of a preceding stage (any `|`/`|&` stage
 * after the first) WITHIN a statement. Statements are the same boundaries as
 * `splitShellSegments` EXCEPT `|`/`|&`, which here stay pipe boundaries instead
 * of segment boundaries. Quote/heredoc aware and fail-closed the same way, so a
 * `curl … | sh` sink after a newline (`echo a\ncurl x | sh`) is still found.
 */
export function pipelineSinks(command: string): string[] {
  if (hasUnbalancedQuote(command) || hasOpenHeredoc(command)) {
    // Fail closed: scan each physical line for a pipe sink.
    const out: string[] = [];
    for (const line of physicalLines(command)) out.push(...sinksOfStatementLess(line));
    return out;
  }
  const joined = joinContinuations(command);
  const out: string[] = [];
  // First split into STATEMENTS (everything but pipes), then pipe-split each.
  for (const statement of splitStatements(joined)) {
    out.push(...sinksOfStatementLess(statement));
  }
  return out;
}

/** Split into statements on the segment boundaries EXCEPT `|`/`|&` (those are
 * pipes, not statement ends). Quote-aware; groups are statement boundaries. */
function splitStatements(command: string): string[] {
  const statements: string[] = [];
  // Array accumulation (join at flush) keeps a long statement linear; a
  // char-by-char `+=` was O(n²) on a 30 KB word (fail-OPEN cost, owner D2d).
  let cur: string[] = [];
  const lines = command.split(/\r?\n/);
  const flush = () => {
    const s = stripGroupDelimiters(cur.join(""));
    if (s.length > 0) statements.push(s);
    cur = [];
  };
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const sep = separatorAt(line, i);
      if (sep === null || sep === "|" || sep === "|&") {
        if (sep === "|" || sep === "|&") {
          // keep the pipe inside the statement (pipe-split happens later)
          cur.push(line.slice(i, i + sep.length));
          i += sep.length - 1;
          continue;
        }
        const ch = line[i]!;
        if (ch === "'" || ch === '"') {
          const close = findClose(line, i, ch);
          cur.push(line.slice(i, close + 1));
          i = close;
        } else if (ch === "\\" && i + 1 < line.length) {
          cur.push(line[i]! + line[i + 1]!);
          i++;
        } else {
          cur.push(ch);
        }
        continue;
      }
      flush();
      i += sep.length - 1;
    }
    flush();
  }
  flush();
  return statements;
}

/** The sink stages of a single statement: pipe-split on `|`/`|&` (quote aware),
 * returning every stage after the first. */
function sinksOfStatementLess(statement: string): string[] {
  const stages: string[] = [];
  let cur = "";
  for (let i = 0; i < statement.length; i++) {
    const ch = statement[i]!;
    if (ch === "'" || ch === '"') {
      const close = findClose(statement, i, ch);
      cur += statement.slice(i, close + 1);
      i = close;
      continue;
    }
    if (ch === "\\" && i + 1 < statement.length) {
      cur += ch + statement[i + 1]!;
      i++;
      continue;
    }
    if (ch === "|") {
      // `||` is not a pipe (it is a statement sep handled by splitStatements);
      // treat only a single `|` or `|&` as a pipe boundary here.
      if (statement[i + 1] === "|") {
        cur += "||";
        i++;
        continue;
      }
      stages.push(stripGroupDelimiters(cur));
      cur = "";
      if (statement[i + 1] === "&") i++; // `|&`
      continue;
    }
    cur += ch;
  }
  stages.push(stripGroupDelimiters(cur));
  const out: string[] = [];
  for (let s = 1; s < stages.length; s++) {
    if (stages[s]!.length > 0) out.push(stages[s]!);
  }
  return out;
}

/** The closing index of a quote run starting at `open` (the quote char at
 * `line[open]`), or the line end when unterminated (the whole-command check
 * already caught a true imbalance). Inside double quotes a backslash escapes. */
function findClose(line: string, open: number, q: '"' | "'"): number {
  for (let i = open + 1; i < line.length; i++) {
    if (q === '"' && line[i] === "\\") {
      i++;
      continue;
    }
    if (line[i] === q) return i;
  }
  return line.length - 1;
}

/**
 * The separator operator at `line[i]`, or null. Two-char operators (`&&`, `||`,
 * `|&`) are recognized first. A single `&` is a separator ONLY when it is not
 * part of `&&`, a `>&`/`&>` redirect, or a `2>&1`/`1>&2` fd-dup; those stay with
 * the segment. A `|` that is not `||` or `|&` is a pipe separator.
 */
/** The previous non-whitespace char before index `i`, or undefined at start. */
function prevNonSpace(line: string, i: number): string | undefined {
  for (let j = i - 1; j >= 0; j--) if (!/\s/.test(line[j]!)) return line[j]!;
  return undefined;
}

/** The next non-whitespace char after index `i`, or undefined at the end. */
function nextNonSpace(line: string, i: number): string | undefined {
  for (let j = i + 1; j < line.length; j++) if (!/\s/.test(line[j]!)) return line[j]!;
  return undefined;
}

function separatorAt(line: string, i: number): Sep | null {
  const ch = line[i]!;
  const next = line[i + 1];
  const prev = line[i - 1];
  if (ch === ";") return ";";
  if (ch === "(" || ch === ")" || ch === "{" || ch === "}") {
    // Group delimiters only — never the `()` of a function definition
    // (`name(){ … }`, `:(){ … }`), where the head must survive intact so the
    // fork-bomb patterns match. A `(` opens a subshell only when it begins a
    // word (preceded by start, whitespace, or another separator); a `)` closes
    // one only when it ends a word (followed by end, whitespace, or a separator).
    const wordBoundaryBefore = prev === undefined || /\s/.test(prev) || ";&|({".includes(prev);
    const wordBoundaryAfter = next === undefined || /\s/.test(next) || ";&|)}".includes(next);
    // Non-whitespace neighbours (skipping spaces) to recognize a function
    // definition `name () { … }` / `:() {` whose `()`/`{` must NOT be split so
    // the fork-bomb head survives.
    const prevNW = prevNonSpace(line, i);
    const nextNW = nextNonSpace(line, i);
    if (ch === "(") {
      // `()` of a function definition (next non-space is `)`) is not a subshell.
      if (nextNW === ")") return null;
      return wordBoundaryBefore ? "(" : null;
    }
    if (ch === ")") {
      // The closing paren of a function-definition `()` (prev non-space `(`) is
      // not a subshell close.
      if (prevNW === "(") return null;
      return wordBoundaryAfter ? ")" : null;
    }
    // `{`/`}` are group delimiters only when space-delimited as a word on BOTH
    // sides AND not the function-body brace (prev non-space is `)`), so `${..}`,
    // `:() {`, and `name(){` are NOT split — the fork-bomb head survives. A
    // standalone `{ cmd; }` group still splits.
    if (ch === "{" && (prev === "$" || prevNW === ")")) return null;
    if (wordBoundaryBefore && wordBoundaryAfter) return ch === "{" ? "{" : "}";
    return null;
  }
  if (ch === "&") {
    if (next === "&") return "&&";
    if (next === ">" ) return null; // `&>` redirect
    if (prev === ">") return null; // `>&` redirect / `2>&1`
    return "&";
  }
  if (ch === "|") {
    if (next === "|") return "||";
    if (next === "&") return "|&";
    return "|";
  }
  return null;
}

/** Interpreter/dispatcher command words whose argument is itself a command
 * LINE that must be classified recursively: `bash -c '…'`, `sh -c "…"`,
 * `eval "…"`, `xargs …`, and `ssh host "…"` (owner D2c). A dangerous command
 * smuggled as such an argument must not escape the never list / force-ask. */
const INTERPRETER_CMDS: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "eval",
  "xargs",
  "ssh",
]);

/** A cheap substring pre-filter (owner D2d): true when any interpreter command
 * name occurs anywhere in the statement. `sh` is covered by the other names'
 * suffixes AND stands alone, so the union is tested directly. Used to skip the
 * per-char tokenization of a statement that cannot contain an interpreter
 * wrapper (a long non-command word), keeping classification linear. */
const INTERPRETER_NAME_RE = /bash|zsh|dash|ksh|eval|xargs|ssh|sh/;

/**
 * Extract the nested command LINE(s) carried by an interpreter/dispatcher
 * wrapper (owner D2c): the argument of `bash -c`/`sh -c`/`eval`/`xargs`/`ssh
 * host`, with surrounding quotes removed, so the SAME classifier runs against
 * it. Returns every such inner command found at the top level of `command`.
 * Quote-aware so the argument is taken whole; recursion is handled by the
 * caller feeding the result back through `splitShellSegments`.
 */
export function extractInterpreterCommands(command: string): string[] {
  const out: string[] = [];
  // Tokenize into words/quoted-words at the top level (no separator parsing
  // needed — we only look at the leading interpreter word and its string arg).
  for (const statement of splitStatements(joinContinuations(command))) {
    // Cheap pre-filter (owner D2d): an interpreter wrapper's command word must
    // appear literally in the statement, so if NONE of the interpreter names is
    // a substring we skip the per-char tokenization entirely. A 30 KB word with
    // no interpreter name (e.g. a long run of backslashes) thus costs an O(n)
    // scan instead of a full tokenize — closing a fail-OPEN cost while never
    // dropping a real wrapper (the name is always present when one is).
    if (!INTERPRETER_NAME_RE.test(statement)) continue;
    const words = tokenizeWords(statement);
    if (words.length === 0) continue;
    // Skip a leading env assignment / known benign wrapper to reach the real
    // command word (mirrors PRE handling, kept minimal here).
    let k = 0;
    while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(words[k]!.raw)) k++;
    const head = words[k];
    if (!head) continue;
    const base = head.value.replace(/.*\//, "");
    if (!INTERPRETER_CMDS.has(base)) continue;
    if (base === "ssh") {
      // `ssh [opts] host "cmd"` — the LAST quoted word is the remote command.
      const quoted = words.slice(k + 1).filter((w) => w.quoted);
      if (quoted.length > 0) out.push(quoted[quoted.length - 1]!.value);
      continue;
    }
    if (base === "xargs") {
      // `xargs <cmd> [args]` — the command xargs runs is the rest of the words.
      const rest = words.slice(k + 1).filter((w) => !w.value.startsWith("-"));
      if (rest.length > 0) out.push(rest.map((w) => w.value).join(" "));
      continue;
    }
    // bash/sh/eval: the argument after `-c` (bash/sh) or the first string arg
    // (eval) is a command line.
    const rest = words.slice(k + 1);
    const cIdx = rest.findIndex((w) => w.value === "-c");
    const argWord = cIdx >= 0 ? rest[cIdx + 1] : rest.find((w) => !w.value.startsWith("-"));
    if (argWord) out.push(argWord.value);
  }
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** A tokenized word with its unquoted value and whether it was quoted. */
interface Word {
  value: string;
  raw: string;
  quoted: boolean;
}

/** Split a single statement into whitespace-delimited words, honoring single/
 * double quotes (a quoted run is one word; inner text kept verbatim). */
function tokenizeWords(statement: string): Word[] {
  const words: Word[] = [];
  // Accumulate word pieces in arrays and join once at flush: a char-by-char
  // `+=` is O(n²) on a very long word (a 30 KB single word stalled the gate — a
  // fail-OPEN cost, owner D2d); array push + join is linear.
  let cur: string[] = [];
  let raw: string[] = [];
  let quoted = false;
  let has = false;
  const flush = () => {
    if (has) words.push({ value: cur.join(""), raw: raw.join(""), quoted });
    cur = [];
    raw = [];
    quoted = false;
    has = false;
  };
  for (let i = 0; i < statement.length; i++) {
    const ch = statement[i]!;
    if (ch === "'" || ch === '"') {
      const close = findClose(statement, i, ch);
      // Inner text between the quotes (close is the index of the closing quote,
      // or the last index when unterminated).
      const innerEnd = statement[close] === ch ? close : close + 1;
      cur.push(statement.slice(i + 1, innerEnd));
      raw.push(statement.slice(i, close + 1));
      quoted = true;
      has = true;
      i = close;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (ch === "\\" && i + 1 < statement.length) {
      cur.push(statement[i + 1]!);
      raw.push(ch + statement[i + 1]!);
      has = true;
      i++;
      continue;
    }
    // Append a whole RUN of plain characters (no quote, whitespace, or escape)
    // in one slice rather than per-char, keeping a long word linear.
    let j = i;
    while (j < statement.length) {
      const c = statement[j]!;
      if (c === "'" || c === '"' || c === "\\" || /\s/.test(c)) break;
      j++;
    }
    cur.push(statement.slice(i, j));
    raw.push(statement.slice(i, j));
    has = true;
    i = j - 1;
  }
  flush();
  return words;
}
