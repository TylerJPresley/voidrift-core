/**
 * WRITE-SHAPED shell target extraction (core-blueprint.md §8.4, §9.4; owner S1).
 *
 * `controlPathWriteTargets` returns every path a command segment would WRITE,
 * so `guardian.evaluate` can classify each through the ONE `classifyControlPath`
 * and block or force-ask a write onto a VoidRift control file (config, agent
 * prompt, git hook, …) that a safe-looking command (`echo x > .voidrift/config.json`)
 * would otherwise slip past the shell classifier.
 *
 * It reuses the ONE shared splitter (`splitShellSegments`) and tokenizer so a
 * compound command, an interpreter wrapper, and a command substitution are all
 * covered — each inner command is scanned too. Only WRITE shapes are inspected
 * (reads like `cat`/`grep`/`ls`/`git diff` yield nothing):
 *   - redirections `>`, `>>`, `>|`, `&>`, `N>`, `N>>` — the target word.
 *   - `tee`, `cp`, `mv`, `install`, `ln`, `rm`, `unlink`, `truncate` — the
 *     operands (for `cp`/`mv`/`install`/`ln` the destination is the last; we
 *     return ALL non-flag operands, conservative).
 *   - `sed -i`/`--in-place`, `perl -i` — the file operands.
 *   - `dd of=<path>` — the `of=` target.
 *   - `chmod`/`chown`/`chattr` — the path operands.
 *   - `git config <key> <value>` writing a hook/fsmonitor/sshCommand/pager/
 *     editor/alias/filter/diff key — the key maps to a control effect; we return
 *     a synthetic `.git/config` target so it classifies `ask`.
 *   - ARCHIVE/SYNC/VCS EXTRACTION (S5 re-audit): a command that materialises
 *     files into a DESTINATION directory or file is a write onto whatever it
 *     names, even though the payload is opaque. Covered forms:
 *       - `tar -x … -C <dir>` / `--directory=<dir>` (extraction destination; a
 *         combined short flag like `-xzf`/`-xvf` counts as `-x`).
 *       - `unzip … -d <dir>` (extraction destination).
 *       - `rsync <src…> <dest>` / `scp <src…> <dest>` / `sftp … <dest>` — the
 *         DESTINATION is the LAST operand.
 *       - `git checkout [<ref>] -- <paths…>` / `git checkout <ref> -- <paths…>`
 *         and `git restore [--source=…] [--staged] [--worktree] <paths…>` — each
 *         named path is overwritten from the index/tree.
 *       - `git reset --hard <path…>` / `git clean -f <path…>` — a NAMED path
 *         operand is overwritten/removed (a no-path form is left to the existing
 *         always-ask git families; we do NOT inspect the working tree).
 *       - `patch -d <dir>` / `git apply --directory=<dir>` — the directory the
 *         hunk paths are rooted at.
 *       - `curl -o <file>` / `--output <file>` and `wget -O <file>` /
 *         `--output-document=<file>` — the download target.
 *       - `dd of=<file>`, `install -t <dir>`, `cp -t <dir>` / `mv -t <dir>`
 *         (target-directory flag), `ln -s`/`ln -sf <target> <link>` (the LINK,
 *         the last operand).
 *     `=`-attached long options (`--directory=x`, `--output=x`), combined short
 *     flags, and a flag whose value is the NEXT token are all handled. `sudo`/
 *     `env`/an absolute binary path is unwrapped first.
 *
 * STATIC only: a target that is a glob, a variable, or a substitution we cannot
 * resolve is returned verbatim and simply fails `classifyControlPath` (→ null),
 * so the ordinary classification applies (accepted limitation). `python -c`/
 * `node -e` payloads are NOT inspected (accepted).
 */
import { splitShellSegments, extractInterpreterCommands } from "./shell-segments.js";

/** The commands whose non-flag operands are write targets. */
const WRITE_CMDS = new Set([
  "tee",
  "cp",
  "mv",
  "install",
  "ln",
  "rm",
  "unlink",
  "truncate",
  "chmod",
  "chown",
  "chattr",
]);

/** Extract every write-shaped target path from a command (all segments, inner
 * commands, and substitutions). Returns verbatim path words (de-quoted). */
export function controlPathWriteTargets(command: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string | undefined | null): void => {
    if (!p) return;
    const v = p.trim();
    if (v === "" || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };

  const segments = new Set<string>(splitShellSegments(command).segments);
  // Interpreter-wrapped inner commands (`bash -c "echo x > f"`) are scanned too.
  const innerCommands: string[] = [];
  for (const inner of extractInterpreterCommands(command)) {
    innerCommands.push(inner);
    for (const s of splitShellSegments(inner).segments) segments.add(s);
  }

  // Redirections are scanned on the WHOLE command (and each inner command), not
  // per-segment: `>|` contains a `|` the segment splitter treats as a pipe
  // boundary, so a split would lose `>| target`. A redirect operator is
  // unambiguous enough to scan globally.
  collectRedirectTargets(command, add);
  for (const inner of innerCommands) collectRedirectTargets(inner, add);

  for (const seg of segments) {
    collectCommandTargets(seg, add);
  }
  return out;
}

/** Collect redirection targets (`>`, `>>`, `>|`, `&>`, `N>`, `N>>`) in a
 * segment: the word following the operator. */
function collectRedirectTargets(seg: string, add: (p: string) => void): void {
  // Match a redirect operator then the target word. Handles optional fd number
  // (`2>`), `>>`, `>|`, and `&>`/`&>>`. Quotes around the target are stripped.
  const re = /(?:^|\s)(?:&|\d*)(?:>>|>\||>)\s*("[^"]*"|'[^']*'|\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg)) !== null) {
    add(dequote(m[1]!));
  }
}

/** Collect command-operand write targets (`cp`/`mv`/`rm`/`tee`/…, `sed -i`,
 * `perl -i`, `dd of=`, `git config` control keys). */
function collectCommandTargets(seg: string, add: (p: string) => void): void {
  const words = tokenize(seg);
  if (words.length === 0) return;
  // Skip a leading run of env assignments and benign wrappers to reach the
  // command word.
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || isWrapper(words[i]!))) i++;
  const cmd = base(words[i] ?? "");
  const rest = words.slice(i + 1);

  if (WRITE_CMDS.has(cmd)) {
    for (const w of rest) if (!w.startsWith("-")) add(dequote(w));
    return;
  }
  if (cmd === "sed" && rest.some((w) => w === "-i" || w.startsWith("-i") || w === "--in-place")) {
    for (const w of rest) if (!w.startsWith("-")) add(dequote(w));
    return;
  }
  if (cmd === "perl" && rest.some((w) => w === "-i" || w.startsWith("-i"))) {
    for (const w of rest) if (!w.startsWith("-")) add(dequote(w));
    return;
  }
  if (cmd === "dd") {
    for (const w of rest) {
      const of = /^of=(.+)$/.exec(w);
      if (of) add(dequote(of[1]!));
    }
    return;
  }
  if (cmd === "git") {
    collectGitConfigTarget(rest, add);
    collectGitExtractionTargets(rest, add);
    return;
  }
  if (cmd === "tar") {
    // Extraction only (`-x`, including combined `-xzf`/`-xvf`). The destination
    // is the value of `-C`/`--directory`.
    if (!hasExtractShort(rest, "x") && !rest.some((w) => w === "--extract")) return;
    collectFlagValues(rest, ["-C"], ["--directory"], add);
    return;
  }
  if (cmd === "unzip") {
    collectFlagValues(rest, ["-d"], [], add);
    return;
  }
  if (cmd === "rsync" || cmd === "scp" || cmd === "sftp") {
    // Destination is the LAST non-flag operand (and not a flag value).
    const last = lastOperand(rest);
    if (last !== null) add(dequote(last));
    return;
  }
  if (cmd === "patch") {
    collectFlagValues(rest, ["-d"], ["--directory"], add);
    return;
  }
  if (cmd === "curl") {
    collectFlagValues(rest, ["-o"], ["--output"], add);
    return;
  }
  if (cmd === "wget") {
    collectFlagValues(rest, ["-O"], ["--output-document"], add);
    return;
  }
}

/** True when a `tar`/… flag cluster contains the short extract flag `c` (e.g.
 * `-x`, `-xzf`, `x`). Only leading-run single-dash (or bare) clusters count. */
function hasExtractShort(rest: string[], letter: string): boolean {
  for (const w of rest) {
    if (w.startsWith("--")) continue;
    if (w.startsWith("-") && !w.startsWith("--")) {
      if (w.slice(1).includes(letter)) return true;
      continue;
    }
    // `tar xzf a.tgz` — a bare flag cluster with no dash (GNU/BSD allow it).
    if (/^[a-zA-Z]+$/.test(w) && w.includes(letter) && rest.indexOf(w) === 0) return true;
  }
  return false;
}

/** Collect values of short flags (`-C x` / `-Cx`) and long flags (`--directory x`
 * / `--directory=x`). `shorts` are `-C` forms; `longs` are `--directory` forms
 * (without the `=`). */
function collectFlagValues(
  rest: string[],
  shorts: string[],
  longs: string[],
  add: (p: string) => void,
): void {
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]!;
    for (const s of shorts) {
      if (w === s) {
        const v = rest[i + 1];
        if (v !== undefined && !v.startsWith("-")) add(dequote(v));
      } else if (w.startsWith(s) && w.length > s.length && !w.startsWith("--")) {
        add(dequote(w.slice(s.length)));
      }
    }
    for (const l of longs) {
      if (w === l) {
        const v = rest[i + 1];
        if (v !== undefined && !v.startsWith("-")) add(dequote(v));
      } else {
        const eq = new RegExp(`^${escapeRe(l)}=(.+)$`).exec(w);
        if (eq) add(dequote(eq[1]!));
      }
    }
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The last operand that is not a flag and not the value of a preceding flag.
 * Conservative: treats a token after a bare `-x` short flag as that flag's value
 * only for the known target-directory/output flags handled elsewhere; here we
 * simply return the last non-`-` token. */
function lastOperand(rest: string[]): string | null {
  for (let i = rest.length - 1; i >= 0; i--) {
    const w = rest[i]!;
    if (!w.startsWith("-")) return w;
  }
  return null;
}

/**
 * Git working-tree-overwriting forms (S5): `checkout`/`restore`/`reset
 * --hard`/`clean -f` that NAME a path operand overwrite that path from the
 * index/tree. A no-path form (`git checkout .`, `git reset --hard`, `git stash
 * pop`) is left to the existing always-ask git families — we return nothing for
 * it (we do NOT inspect the working tree).
 */
function collectGitExtractionTargets(rest: string[], add: (p: string) => void): void {
  const sub = rest.find((w) => !w.startsWith("-"));
  if (!sub) return;
  const subIdx = rest.indexOf(sub);
  const after = rest.slice(subIdx + 1);

  if (sub === "checkout") {
    // `git checkout [<ref>] -- <paths…>` — paths are everything after `--`.
    const sep = after.indexOf("--");
    if (sep >= 0) {
      for (const p of after.slice(sep + 1)) if (!p.startsWith("-")) add(dequote(p));
    }
    return;
  }
  if (sub === "restore") {
    // `git restore [--source=…] [--staged] [--worktree] [--] <paths…>` — every
    // non-flag operand (and anything after `--`) is a restored path.
    const sep = after.indexOf("--");
    const operands = sep >= 0 ? after.slice(sep + 1) : after.filter((w) => !w.startsWith("-"));
    for (const p of operands) if (!p.startsWith("-")) add(dequote(p));
    return;
  }
  if (sub === "reset") {
    // `git reset --hard [--] <paths…>` — a named path operand is overwritten.
    if (!after.some((w) => w === "--hard")) return;
    const sep = after.indexOf("--");
    const operands = sep >= 0 ? after.slice(sep + 1) : after.filter((w) => !w.startsWith("-"));
    for (const p of operands) if (!p.startsWith("-")) add(dequote(p));
    return;
  }
  if (sub === "clean") {
    // `git clean -f [--] <paths…>` — a named path operand is removed.
    if (!after.some((w) => /^-[a-zA-Z]*f/.test(w) || w === "--force")) return;
    const sep = after.indexOf("--");
    const operands = sep >= 0 ? after.slice(sep + 1) : after.filter((w) => !w.startsWith("-"));
    for (const p of operands) if (!p.startsWith("-")) add(dequote(p));
    return;
  }
  if (sub === "apply") {
    // `git apply --directory=<dir>` — the dir hunk paths are rooted at.
    collectFlagValues(after, [], ["--directory"], add);
    return;
  }
}

/** `git config <key> <value>` writing a control key → a synthetic `.git/config`
 * target so it classifies `ask`. Only a WRITE (a key + value, not `--get`/
 * `--list`) that targets one of the dangerous keys. */
function collectGitConfigTarget(rest: string[], add: (p: string) => void): void {
  const sub = rest.find((w) => !w.startsWith("-"));
  if (sub !== "config") return;
  const idx = rest.indexOf("config");
  const after = rest.slice(idx + 1).filter((w) => !w.startsWith("-"));
  const key = after[0];
  const value = after[1];
  if (!key || value === undefined) return; // a read (`git config --get x`) has no value
  const k = key.toLowerCase();
  const DANGER =
    /^(core\.hookspath|core\.fsmonitor|core\.sshcommand|core\.pager|core\.editor|alias\.|filter\.|diff\.)/;
  if (DANGER.test(k)) add(".git/config");
}

/** Whitespace tokenize, honoring single/double quotes (kept with quotes so the
 * de-quote step can strip them). */
function tokenize(seg: string): string[] {
  const words: string[] = [];
  let cur = "";
  let q: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i]!;
    if (q) {
      cur += ch;
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) words.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) words.push(cur);
  return words;
}

function dequote(w: string): string {
  const s = w.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function base(w: string): string {
  return dequote(w).replace(/.*\//, "").toLowerCase();
}

const WRAPPERS = new Set([
  "env",
  "command",
  "builtin",
  "exec",
  "nohup",
  "setsid",
  "time",
  "nice",
  "ionice",
  "chrt",
  "taskset",
  "stdbuf",
  "timeout",
  "sudo",
  "doas",
  "pkexec",
]);

function isWrapper(w: string): boolean {
  const b = base(w);
  if (WRAPPERS.has(b)) return true;
  // A wrapper's own numeric/flag args (`timeout 5`, `nice -n 10`) are skipped so
  // the command word is reached; a bare number or short flag is treated as a
  // wrapper arg here.
  return /^-/.test(w) || /^\d+$/.test(w);
}
