/**
 * Shared anchored-regex fragments for shell classification (core-blueprint.md
 * §9.3). The force-ask defaults (`config/schema.ts`) and the code-level NEVER
 * LIST (`entities/never-list.ts`) both compose these so a wrapper prefix
 * (`sudo`, `env FOO=1`, `timeout 5`, …), a quoted/escaped command word, and an
 * absolute path to the binary (`/bin/rm`) cannot bypass EITHER classifier. One
 * source of truth (§1 rule 10 / DRY): the fragments lived privately in
 * `schema.ts`; they are hoisted here so the never list reuses the exact,
 * battle-tested wrapper/env/path handling rather than re-deriving it.
 *
 * Each fragment is a non-capturing group so it composes inside an anchored
 * pattern the classifier wraps as `^(?:…)$` against a normalized segment.
 */

/** A leading run of `NAME=value ` environment-variable assignments
 * (`FOO=1 git …`), which the shell applies before the command word. */
export const ENVP = "(?:[A-Za-z_][A-Za-z0-9_]*=\\S* )*";

/**
 * The wrapper command words that run another command: scheduling/priority
 * wrappers (`nice`, `ionice`, `chrt`, `taskset`), lifecycle wrappers (`nohup`,
 * `setsid`, `timeout`), I/O/buffering wrappers (`stdbuf`), builtins/dispatchers
 * (`env`, `command`, `builtin`, `exec`, `time`), privilege-escalation
 * (`sudo`, `doas`), and `xargs`. Each may carry its OWN options and arguments
 * before the real command word, so a wrapper prefix cannot hide what it runs.
 */
export const WRAPPER_WORD =
  "(?:(?:\\S*/)?(?:env|command|builtin|exec|nohup|setsid|time|nice|ionice|chrt|taskset|stdbuf|timeout|sudo|doas|xargs))";

/** A wrapper word's own options/arguments: flag tokens, bare numeric/mask
 * values a flag or the wrapper takes, and short alpha-flag operands. It never
 * consumes an ordinary command word, so the classifier still reaches the
 * command the wrapper runs. */
export const WRAPPER_ARGS = "(?: (?:-\\S+(?: [^\\s-]\\S*)?|0[xX][0-9a-fA-F]+|\\d+))*";

/** A benign wrapper run, with env-var assignments allowed to interleave
 * (`env git …`, `timeout 5 command rm …`). */
export const PRE = ENVP + "(?:" + WRAPPER_WORD + WRAPPER_ARGS + " " + ENVP + ")*";

/** PRE then `git` (with an optional path to the binary) and any run of global
 * options between it and the subcommand. */
export const GIT_PRE =
  PRE + "(?:\\S*/)?git(?: (?:-c \\S+|-C \\S+|--no-pager|--git-dir=\\S+|--work-tree=\\S+|--[a-z-]+(?:=\\S+)?))*";

/** PRE then `rm` with an optional absolute/relative path. */
export const RM_BIN = PRE + "(?:\\S*/)?rm";

/** PRE then a privilege-escalation command word, with an optional binary path. */
export const ESC = PRE + "(?:(?:\\S*/)?(?:sudo|doas|pkexec|su))";

/** A system path that must never be written through a redirection, `tee`,
 * `truncate`, `cp`, `mv`, `ln -sf`, or `sed -i` (§9.3 "writes onto system
 * paths"). A user rc-file (`~/.bashrc`) under the home dir is NOT a system path
 * for the NEVER list (the pinned D1 decision excludes it); the force-ask list
 * keeps its own wider SYS_PATH. */
export const SYS_PATH =
  "(?:/(?:etc|boot|usr|bin|sbin|lib[^/\\s]*|proc|sys)(?:/\\S*)?" +
  "|/dev/(?:sd|nvme|mapper)\\S*" +
  "|(?:~|\\$HOME)/(?:\\.ssh|\\.gnupg)(?:/\\S*)?" +
  "|(?:~|\\$HOME)/\\.(?:bashrc|zshrc|profile|bash_profile|zprofile|bash_logout|zshenv|zlogin)\\b)";

/** A root/home target for a recursive ownership/mode change (§9.3). */
export const ROOT_TARGET = "(?:/\\*?|~(?:/\\*)?|\\$HOME(?:/\\*)?)";

/** A generic wrapped command word: the shared PRE run plus an optional path to a
 * binary (`/sbin/mkfs.ext4`). */
export const CMD = PRE + "(?:\\S*/)?";
