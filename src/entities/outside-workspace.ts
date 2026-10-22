/**
 * The `outside-workspace` shell force-ask family (core-blueprint.md §4.4, §8.2,
 * §9.3; owner).
 *
 * The working directory is explicit state rooted at the workspace: every
 * `execute_command` (and every `wait` `check`, §8.2) runs with its cwd set to
 * the workspace root (a worker's worktree root for a worker), and relative paths
 * in the file tools resolve against that same root. A shell command that leaves
 * that root — by **changing directory to** a path outside it (`cd`/`pushd`/
 * `chdir`, or a `-C`/`--chdir`/`--directory` wrapper flag whose target resolves
 * outside), or by **naming an absolute path outside** it as an operand — is a
 * FORCE-ASK (`outside-workspace`), so the agent never silently reads or writes
 * outside the workspace through the shell. This mirrors the file tools, which
 * already reject a path resolving outside the workspace (§8.2); together they
 * make the workspace the agent's directory of record.
 *
 * It is **classification over the command text, not an OS sandbox** (§9.3): an
 * opaque interpreter payload (`python -c …`) is itself force-asked by the
 * ordinary dangerous-shell families, and a path that cannot be resolved
 * statically falls back to the ordinary classification rather than tripping this
 * rule. `~`/`$HOME`/`$XDG_CONFIG_HOME` prefixes resolve statically.
 *
 * Pure path/lex logic reusing the shared shell lexer. No fs import; the harness
 * injects the workspace root (never `process.cwd()`).
 */

/** A lexed token: a plain `word` (quotes collapsed) or a shell `op` separator. */
type Lexed = { kind: "word"; value: string } | { kind: "op"; value: string };

/** Lex a command into words and operator separators, honoring single/double
 * quotes (a quoted run is ONE word) and backslash escapes. A trimmed copy of the
 * lexer in `rm-workdir.ts`; kept local so the two families stay independent. */
function lex(command: string): Lexed[] {
  const out: Lexed[] = [];
  let cur = "";
  let has = false;
  const flush = (): void => {
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

/** Split a POSIX path into segments, resolving `.`/`..` lexically; a `..` that
 * climbs above the root is kept as a marker so an escaping path is detected. */
function normalizeSegs(p: string): string[] {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
    } else {
      out.push(seg);
    }
  }
  return out;
}

/** Is `child` strictly inside or equal to `root` (both absolute, normalized)? */
function isInsideRoot(childSegs: string[], rootSegs: string[]): boolean {
  if (childSegs.includes("..")) return false; // climbed above /
  if (childSegs.length < rootSegs.length) return false;
  for (let i = 0; i < rootSegs.length; i++) {
    if (childSegs[i] !== rootSegs[i]) return false;
  }
  return true;
}

/** Statement separators that start a fresh command word. */
const SEPARATORS = new Set(["&&", "||", ";", "|", "(", "{", "&"]);

/** `cd`/`pushd`/`chdir` move the shell cwd; their operand is the target. */
const DIR_CHANGE_COMMANDS = new Set(["cd", "pushd", "chdir"]);

/** A chdir wrapper flag: `-C DIR`, `--chdir=DIR`, `--directory DIR`. */
const CHDIR_FLAG = /^(-C|--chdir|--directory)(=(.*))?$/;

/** A `NAME=value` env-assignment prefix (does not consume the command slot). */
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;

/** A statically-resolvable path (an argument or a cd target) we can test against
 * the workspace root. A path carrying a variable/command substitution, a glob,
 * or a `~`-prefix we cannot expand is NOT resolvable → returns null (fall back
 * to the ordinary classification). A `~`/`$HOME` we CAN resolve is handled by
 * the caller via `home`. */
function isResolvablePath(tok: string): boolean {
  if (tok.length === 0) return false;
  if (/[$`]/.test(tok)) return false;
  if (/[*?[\]{}]/.test(tok)) return false;
  return true;
}

export interface OutsideWorkspaceDeps {
  /** The home directory, so a `~`/`$HOME`-prefixed path resolves statically.
   * When a home is given and the path begins with `~`, it is expanded; the
   * resulting absolute path is tested against the root like any other. Absent →
   * a `~`-prefixed path is not resolvable and falls back. */
  home?: string;
}

/** Expand a leading `~` / `~/` against `home`; return null when it cannot. */
function expandHome(tok: string, home: string | undefined): string | null {
  if (!tok.startsWith("~")) return tok;
  if (!home) return null;
  if (tok === "~") return home;
  if (tok.startsWith("~/")) return home.replace(/\/+$/, "") + "/" + tok.slice(2);
  // `~user` — cannot resolve statically.
  return null;
}

/**
 * True when `command` changes directory to, or names an absolute path outside,
 * the workspace `root`. Pure and statement-aware over the lexed command:
 *
 *   - A `cd`/`pushd`/`chdir` (or a `-C`/`--chdir`/`--directory` wrapper flag)
 *     whose target resolves OUTSIDE the root → outside-workspace.
 *   - An ABSOLUTE path operand (an argument, never the command word) that
 *     resolves outside the root → outside-workspace. The leading command WORD is
 *     excluded (so `/bin/ls` as the program is fine) — only arguments and cd
 *     targets are tested, a conservative rule (§9.3).
 *
 * `/dev/null`, `/tmp/...`, `/etc/passwd`, `/usr/share/...` as ARGUMENTS are
 * outside the workspace and ask. A relative path, or a path that cannot be
 * resolved statically (variable/glob/`~user`), is NOT flagged here (fall back to
 * the ordinary classification). A cd with no absolute/resolvable target (e.g.
 * `cd sub`) stays inside and does not trip the rule (its target resolves against
 * the root).
 */
export function commandLeavesWorkspace(
  command: string,
  root: string,
  deps: OutsideWorkspaceDeps = {},
): boolean {
  const rootSegs = normalizeSegs(root);
  const toks = lex(command);

  /** Test an absolute (or home-expanded) path token against the root. */
  const absOutside = (tok: string): boolean => {
    const expanded = expandHome(tok, deps.home);
    if (expanded === null) return false; // ~user etc. — not resolvable
    if (!expanded.startsWith("/")) return false; // relative → resolves inside
    if (!isResolvablePath(tok)) return false;
    return !isInsideRoot(normalizeSegs(expanded), rootSegs);
  };

  let atCommandStart = true;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind === "op") {
      if (SEPARATORS.has(t.value)) atCommandStart = true;
      continue;
    }
    // A chdir wrapper flag anywhere in a statement: `env -C /etc cmd`.
    const chdir = CHDIR_FLAG.exec(t.value);
    if (chdir) {
      // `--chdir=DIR` carries the target inline; `-C DIR` takes the next word.
      let target = chdir[3];
      if (target === undefined) {
        const next = toks[i + 1];
        if (next && next.kind === "word") target = next.value;
      }
      if (target !== undefined && target.startsWith("/") && absOutside(target)) return true;
      continue;
    }
    if (atCommandStart) {
      // A leading env assignment does not consume the command slot.
      if (ENV_ASSIGN.test(t.value)) continue;
      // The command WORD itself is excluded (a program path such as /bin/ls is
      // fine); only arguments and cd targets are tested (§9.3 conservative rule).
      if (DIR_CHANGE_COMMANDS.has(t.value)) {
        // The next word is the cd target; a `cd` with no operand goes HOME, not
        // outside the workspace, so it does not trip the rule.
        const next = toks[i + 1];
        if (next && next.kind === "word") {
          const tok = next.value;
          // An absolute, or home-resolvable, target outside the root asks. A
          // bare relative target (`cd sub`) resolves inside and is fine.
          if ((tok.startsWith("/") || tok.startsWith("~")) && absOutside(tok)) return true;
        }
      }
      atCommandStart = false;
      continue;
    }
    // An argument: an absolute path outside the root asks.
    if (t.value.startsWith("/") || t.value.startsWith("~")) {
      if (absOutside(t.value)) return true;
    }
  }
  return false;
}
