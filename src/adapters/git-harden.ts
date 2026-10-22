/**
 * Hardened git invocation (core-blueprint.md §7.3, security-audit S2).
 *
 * A cloned, untrusted repository can ship `.git/config` entries or
 * `.gitattributes` drivers that make git execute arbitrary programs with the
 * user's privileges — OUTSIDE VoidRift's permission gate — the moment a plain
 * `git diff`/`status`/`merge` runs: `core.fsmonitor`, `core.sshCommand`,
 * `core.pager`, `core.editor`, `diff.external`, `diff.<drv>.textconv`,
 * `filter.<name>.clean/smudge/process`, `credential.helper`, `core.hooksPath`,
 * and `gpg.program` all hand control to a repo-supplied command. (`alias.*` is
 * not executed by plumbing and is ignored.)
 *
 * EVERY git invocation in VoidRift routes through {@link hardenedGitArgs} +
 * {@link hardenedGitEnv}: a fixed set of neutralising `-c key=value` overrides
 * (which beat repo-local config), the right `GIT_*` environment, `--no-ext-diff
 * --no-textconv` on diff-shaped verbs, and — when the repo-local config defines
 * filter/textconv drivers — a per-driver neutralisation of each named filter.
 * `GIT_CONFIG_GLOBAL` is deliberately NOT cleared: a `merge` needs the user's
 * identity; when no identity resolves, a neutral VoidRift identity is injected
 * instead (see {@link hardenedGitArgs}).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** A repo-local config key class that can make git execute a program. */
export type GitExecKeyClass =
  | "core.fsmonitor"
  | "core.sshCommand"
  | "core.hooksPath"
  | "core.pager"
  | "core.editor"
  | "diff.external"
  | "diff.textconv"
  | "filter"
  | "credential"
  | "gpg";

/** The result of scanning a repo's local config for executable-capable keys. */
export interface GitConfigScan {
  /** The distinct executable-capable key classes found (for the warning + doctor). */
  classes: GitExecKeyClass[];
  /** The `[filter "<name>"]` driver names found, to be neutralised per-name. */
  filterNames: string[];
  /** The absolute config file(s) that were read (for value-free reporting). */
  files: string[];
}

/**
 * The fixed neutralising overrides prepended to EVERY git invocation. A `-c`
 * override wins over repo-local `.git/config`, so these disable every
 * program-executing config key regardless of what a cloned repo ships. Diff
 * drivers are additionally defused by `--no-ext-diff --no-textconv` on the
 * relevant verbs (see {@link hardenedGitArgs}); filter drivers are named and
 * cleared per-driver from the scan (they cannot be blanket-disabled by key).
 */
const BASE_CONFIG_OVERRIDES: readonly string[] = [
  "core.fsmonitor=false",
  // An empty hooksPath value makes git find no hooks (so a repo-supplied
  // core.hooksPath or a .git/hooks script never runs during our operations).
  "core.hooksPath=",
  "core.sshCommand=",
  "core.pager=cat",
  "core.editor=true",
  "diff.external=",
  "protocol.ext.allow=never",
  "protocol.file.allow=user",
  "credential.helper=",
  "gpg.program=false",
  "commit.gpgsign=false",
  "merge.verifySignatures=false",
];

/** The git verbs whose output honours diff/textconv drivers (defused with
 * `--no-ext-diff --no-textconv`). */
const DIFF_SHAPED_VERBS = new Set(["diff", "show", "log", "format-patch", "range-diff"]);

/**
 * Build the full, hardened argv for a git invocation.
 *
 * @param args         the caller's own git args (verb first), e.g. `["diff", "HEAD"]`.
 * @param scan         the repo-local config scan (filter names to clear per-driver).
 * @param hasIdentity  whether a `user.name`/`user.email` resolves; when false a
 *                     neutral VoidRift identity is injected so a `merge` still
 *                     works WITHOUT touching or clearing the user's global config.
 */
export function hardenedGitArgs(args: string[], scan: GitConfigScan, hasIdentity: boolean): string[] {
  const overrides: string[] = [];
  for (const kv of BASE_CONFIG_OVERRIDES) overrides.push("-c", kv);
  // Neutralise each repo-defined filter driver by name (clean/smudge/process)
  // and drop `required` so a missing filter never fails the operation.
  for (const name of scan.filterNames) {
    overrides.push("-c", `filter.${name}.clean=`);
    overrides.push("-c", `filter.${name}.smudge=`);
    overrides.push("-c", `filter.${name}.process=`);
    overrides.push("-c", `filter.${name}.required=false`);
  }
  // Identity-safe: only inject when the resolved identity is empty, never
  // overriding the user's own user.name/user.email when present.
  if (!hasIdentity) {
    overrides.push("-c", "user.name=VoidRift");
    overrides.push("-c", "user.email=voidrift@localhost");
  }
  // `--no-ext-diff --no-textconv` on diff-shaped verbs (belt-and-braces over the
  // `diff.external=` override; also defeats `.gitattributes` textconv drivers).
  const verb = args[0];
  const extra: string[] = [];
  if (verb !== undefined && DIFF_SHAPED_VERBS.has(verb)) {
    extra.push("--no-ext-diff", "--no-textconv");
  }
  if (extra.length > 0) {
    return [...overrides, args[0]!, ...extra, ...args.slice(1)];
  }
  return [...overrides, ...args];
}

/**
 * The hardened environment for a git child process. Merges over the caller's
 * environment (so PATH/HOME remain) and neutralises every `GIT_*` program hook.
 * `GIT_CONFIG_GLOBAL` is intentionally left alone (a merge needs the user's
 * identity; see {@link hardenedGitArgs}).
 */
export function hardenedGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.GIT_EDITOR = "true";
  env.GIT_ATTR_NOSYSTEM = "1";
  // Unset every program-hook env so an inherited value can't re-introduce one.
  delete env.GIT_EXTERNAL_DIFF;
  delete env.GIT_ASKPASS;
  delete env.GIT_SSH_COMMAND;
  delete env.GIT_SSH;
  delete env.GIT_PROXY_COMMAND;
  return env;
}

/** The repo-local config file paths for a working-tree root (common + worktree). */
function repoConfigFiles(root: string): string[] {
  // `.git` is a directory in a normal checkout and a FILE (`gitdir: …`) in a
  // linked worktree. We scan the plain `.git/config` when present; a gitdir
  // file points elsewhere and is resolved best-effort.
  const out: string[] = [];
  const dotGit = path.join(root, ".git");
  out.push(path.join(dotGit, "config"));
  // worktree-local config, if any (newer git stores it under the gitdir).
  out.push(path.join(dotGit, "config.worktree"));
  return out;
}

/** Sections whose presence means git may execute a program from this repo. */
const SECTION_RE = /^\s*\[\s*(filter|diff|core|credential|gpg)(?:\s+"([^"]*)")?\s*\]/i;

/**
 * Scan a repo's local config for executable-capable keys WITHOUT running git
 * (reading config via git would itself honour the config). Value-free: it
 * records which key classes and which filter driver names are present, and the
 * files it read — never a value. Best-effort: an unreadable file is skipped.
 */
export function scanRepoConfig(root: string): GitConfigScan {
  const classes = new Set<GitExecKeyClass>();
  const filterNames = new Set<string>();
  const files: string[] = [];
  for (const file of repoConfigFiles(root)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    files.push(file);
    let section: string | null = null;
    let sectionSub: string | null = null;
    for (const rawLine of text.split("\n")) {
      const line = rawLine.replace(/[#;].*$/, "").trim();
      if (line === "") continue;
      const sec = SECTION_RE.exec(rawLine);
      if (sec) {
        section = sec[1]!.toLowerCase();
        sectionSub = sec[2] ?? null;
        if (section === "filter" && sectionSub) filterNames.add(sectionSub);
        if (section === "credential") classes.add("credential");
        if (section === "gpg") classes.add("gpg");
        continue;
      }
      if (section === null) continue;
      const eq = line.indexOf("=");
      const key = (eq === -1 ? line : line.slice(0, eq)).trim().toLowerCase();
      if (section === "filter" && sectionSub) {
        if (key === "clean" || key === "smudge" || key === "process") classes.add("filter");
      } else if (section === "diff") {
        if (key === "external") classes.add("diff.external");
        if (key === "textconv") classes.add("diff.textconv");
      } else if (section === "core") {
        if (key === "fsmonitor") classes.add("core.fsmonitor");
        if (key === "sshcommand") classes.add("core.sshCommand");
        if (key === "hookspath") classes.add("core.hooksPath");
        if (key === "pager") classes.add("core.pager");
        if (key === "editor") classes.add("core.editor");
      } else if (section === "gpg") {
        classes.add("gpg");
      } else if (section === "credential") {
        classes.add("credential");
      }
    }
  }
  return { classes: [...classes], filterNames: [...filterNames], files };
}
