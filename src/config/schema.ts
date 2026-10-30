/**
 * The config schema — a single Zod object every layer validates against
 * (core-blueprint.md §13.2, §13.9). Unknown top-level keys are rejected so a
 * typo fails loudly; model entries, `modelKwargs`, and `apps.<appName>` are
 * declared passthrough pockets that preserve unknown keys (§13.2, §11.3).
 *
 * This is the single source of truth for config shape, defaults, and bounds.
 */
import { z } from "zod";
import path from "node:path";
import { validateRegistryUrl } from "../entities/plugins/plugin-registry.js";
import { classifyHost } from "../entities/url-classifier.js";
import { GIT_PRE, RM_BIN, ESC, SYS_PATH, ROOT_TARGET, CMD, PRE } from "../entities/shell-fragments.js";
import { NETWORK_TOOLS, validateCidr } from "../entities/exact-allow.js";
import { LimitsSchema } from "./limits-schema.js";

/**
 * Generate a case-insensitive regex source for a literal string.
 * Each ASCII letter becomes a two-char class [xX]; regex metacharacters are
 * escaped. Used to build the git config key force-ask pattern without inline
 * flag groups which fail on Node 22 and earlier (Node 24+ supports them).
 * No global flag is applied; the surrounding pattern is deliberately case-sensitive
 * on non-target elements (e.g. leading `git` or `core.`).
 *
 * Examples:
 *   ciSource('core.sshcommand') → '[cC][oO][rR][eE]\\.[sS][sS][hH][cC][oO][mM][mM][aA][nN][dD]'
 *   ciSource('protocol.ext.allow') → '[pP][rR]…\\.[eE][xX][tT]\\.[aA]…'
 */
export function ciSource(literal: string): string {
  const REGEX_ESCAPES = new Set(".$^+*[](){}|\\".split(""));
  return literal
    .split("")
    .map((c) =>
      c.match(/[a-z]/i) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : REGEX_ESCAPES.has(c) ? `\\${c}` : c,
    )
    .join("");
}

/** A model endpoint entry; unknown keys pass through to the client (§11.2, §11.3). */
export const ModelConfigEntrySchema = z
  .object({
    model: z.string(),
    protocol: z.string().default("openai"),
    baseUrl: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    contextLimit: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    maxConcurrency: z.number().int().positive().optional(),
    vision: z.boolean().optional(),
    // Per-model price for cost attribution (§10.7). Opt-in: when either is set
    // the observability model span gains a derived `cost`; absent → usage only.
    costPer1kInput: z.number().nonnegative().optional(),
    costPer1kOutput: z.number().nonnegative().optional(),
    modelKwargs: z.record(z.string(), z.unknown()).optional(),
    // Per-endpoint overrides for the context sizing percentages (§4.8); a small
    // local window and a large hosted one tune independently.
    contextActiveBudgetPct: z.number().int().positive().optional(),
    contextCompactionPct: z.number().int().positive().optional(),
    contextSafetyNetPct: z.number().int().positive().optional(),
    contextHeadWarnPct: z.number().int().positive().optional(),
    contextNoticePcts: z.array(z.number().int().positive()).optional(),
  })
  .loose() // preserve unknown tuning keys (§11.3)
  .superRefine((r, ctx) => {
    // §11.2 — a model entry's output reservation must fit inside its window: a
    // `maxOutputTokens` >= `contextLimit` leaves no room for the prompt, so every
    // request is refused before sending. Reject the config naming both values so
    // the user fixes it instead of hitting a silent CONTEXT_OVERFLOW each turn.
    if (
      r.maxOutputTokens !== undefined &&
      r.contextLimit !== undefined &&
      r.maxOutputTokens >= r.contextLimit
    ) {
      ctx.addIssue({
        code: "custom",
        message: `maxOutputTokens (${r.maxOutputTokens}) must be less than contextLimit (${r.contextLimit}); the output reservation must leave room for the prompt`,
        path: ["maxOutputTokens"],
      });
    }
  });

export type ModelConfigEntry = z.infer<typeof ModelConfigEntrySchema>;

/** A Guardian rule persisted under `permissions` (§9.2). An optional `exact`
 * and `cidr` make a rule able to LIFT a force-ask class (owner D2a): `exact:
 * true` turns `pattern` into a LITERAL string matched by equality against the
 * call's match value (no glob), and `cidr` is an IP range for the network tools.
 * Both are validated STRICTLY: `cidr` is only valid on an `allow` rule naming a
 * network tool (`web_fetch`/`web_search`), and the range itself must be a sane
 * CIDR (no `0.0.0.0/0`/`::/0`, no prefix shorter than /8 v4 or /16 v6). */
export const PermissionRuleSchema = z
  .object({
    tool: z.string(),
    pattern: z.string().optional(),
    decision: z.enum(["allow", "ask", "deny"]),
    priority: z.number().int(),
    source: z.enum(["session", "workspace", "user", "default", "managed"]),
    // owner D2a — an exact (literal, no-glob) allow that may lift a force-ask.
    exact: z.boolean().optional(),
    // owner D2a — a CIDR range for the network tools only; validated below.
    cidr: z.string().optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.cidr !== undefined) {
      if (r.decision !== "allow") {
        ctx.addIssue({ code: "custom", message: "cidr is only valid on an allow rule", path: ["cidr"] });
      }
      if (!NETWORK_TOOLS.has(r.tool)) {
        ctx.addIssue({
          code: "custom",
          message: `cidr is only valid for a network tool (${[...NETWORK_TOOLS].join(", ")})`,
          path: ["cidr"],
        });
      }
      const v = validateCidr(r.cidr);
      if ("error" in v) {
        ctx.addIssue({ code: "custom", message: v.error, path: ["cidr"] });
      }
    }
    if (r.exact === true && r.pattern === undefined) {
      ctx.addIssue({ code: "custom", message: "exact: true requires a pattern", path: ["pattern"] });
    }
  });

export type PermissionRule = z.infer<typeof PermissionRuleSchema>;

/** The default anchored safe-command list (§9.3). */
export const DEFAULT_SHELL_SAFE: string[] = [
  "git status( .*)?",
  "git log( .*)?",
  "git branch( .*)?",
  "git diff( .*)?",
  "ls( .*)?",
  "pwd",
  "echo( [^><`$]*)?",
  "npm test( .*)?",
  "npm run test( .*)?",
  "npx vitest( .*)?",
  "node --version",
];

/**
 * The default force-ask list (§9.3). Each entry is a regex the classifier
 * anchors at both ends against each normalized command segment, so a pattern
 * must describe the WHOLE segment. The literal-prefix defaults these replace
 * (`rm -rf.*`, `sudo.*`, `git push --force.*`, …) were evadable by flag
 * reordering, short-flag combining, binary pathing, and global git options:
 * `git push origin main --force`, `rm -fr /`, `/bin/rm -rf /`, and
 * `env sudo ls` all slipped through. These defaults are semantically complete
 * for the destructive-command families the blueprint names (§9.3): git
 * force/history-destroying pushes, `git reset --hard`, `git clean -f`, `rm`
 * recursive+force, privilege escalation, and dangerous wrappers — while
 * ordinary `git push`, `git reset --soft`, `git clean -n`, `rm file`,
 * `rm -r build/`, `echo sudo`, and `ls sudoers` stay unmatched.
 *
 * Fragments (each a non-capturing group, so they compose inside an anchored
 * pattern):
 *   ENVP     — a leading run of `NAME=value ` environment-variable assignments
 *              (`FOO=1 git …`, `A=b sudo …`), which the shell applies before
 *              the command word.
 *   PRE      — ENVP plus an optional run of benign wrappers
 *              (`env`/`command`/`exec`/`nohup`/`time`/`nice`/`xargs`), with
 *              assignments allowed to interleave; shared by git/rm/esc so an
 *              assignment or wrapper prefix cannot hide the command word
 *              (`env git push --force`, `FOO=1 command rm -rf /`).
 *   GIT_PRE  — PRE, then `git` (with an optional absolute/relative path to the
 *              binary, `/usr/bin/git`), plus any run of global options between
 *              it and the subcommand (`-c k=v`, `-C <path>`, `--no-pager`,
 *              `--git-dir=…`).
 *   RM_BIN   — PRE, then `rm` with an optional absolute/relative path.
 *   ESC      — PRE, then a privilege-escalation command word (`sudo`, `doas`,
 *              `pkexec`, `su`) — with an optional path to the binary.
 */
// The fragments are the single source of truth in `entities/shell-fragments.ts`
// (§1 rule 10 / DRY) so the code-level NEVER LIST composes the EXACT same
// wrapper/env/binary-path handling as these force-ask defaults.

export const DEFAULT_SHELL_FORCE_ASK: string[] = [
  // git push carrying a history/branch-destroying flag ANYWHERE after `push`:
  // --force / -f (incl. combined short flags like -fu), --force-with-lease[=…],
  // --mirror, --delete / -d, or a `+refspec` force-push (`origin +main`).
  `${GIT_PRE} push(?: \\S+)* (?:--force\\b|--force-with-lease(?:=\\S+)?|--mirror|--delete\\b|-[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*d[a-zA-Z]*|\\+\\S+)(?: .*)?`,
  // git reset --hard, with any global options and any trailing ref/paths.
  `${GIT_PRE} reset(?: \\S+)* --hard(?: .*)?`,
  // git clean with -f/--force in any position or combined (-fd, -xdf, -df, -fx).
  `${GIT_PRE} clean(?: \\S+)*(?: (?:--force|-[a-zA-Z]*f[a-zA-Z]*))(?: .*)?`,
  // rm recursive AND force in either order / any spelling, combined or split,
  // mixing short and long flags freely: -rf, -fr, -Rf, -rvf, -r -f, -f -r,
  // --recursive --force, --force --recursive, -r --force, --force -r, etc.
  // REC/FRC each match one recursive/force flag token (short-combined or long).
  `${RM_BIN}(?: \\S+)* (?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?: \\S+)* (?:-[a-zA-Z]*f[a-zA-Z]*|--force)(?: .*)?`,
  `${RM_BIN}(?: \\S+)* (?:-[a-zA-Z]*f[a-zA-Z]*|--force)(?: \\S+)* (?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?: .*)?`,
  // Combined single short flag carrying both r and f (-rf, -fr, -Rvf).
  `${RM_BIN}(?: \\S+)* -[a-zA-Z]*(?:(?:[rR][a-zA-Z]*f)|(?:f[a-zA-Z]*[rR]))[a-zA-Z]*(?: .*)?`,
  // rm -r (recursive, without -f) on a catastrophic target: a filesystem root
  // or home, bare or with a trailing glob/dot, and the `/home` tree. Covers
  // `/`, `/*`, `/.`, `/ -- `-style, `~`, `~/*`, `$HOME`, `$HOME/*`, `/home`,
  // and a bare `*`. Plain `rm -r build/` is NOT force-asked (not catastrophic).
  `${RM_BIN}(?: -[a-zA-Z]*(?:[rR]|-recursive)[a-zA-Z]*)+(?: \\S+)* (?:--? )?(?:/[*.]?|~(?:/\\*)?|\\$HOME(?:/\\*)?|/home|\\*)(?: .*)?`,
  // Privilege escalation as the command word or behind a benign wrapper.
  `${ESC}(?: .*)?`,
  // Shell/eval wrappers carrying a dangerous inner command: force-ask the
  // wrapper outright. `sh -c`, `bash -c`, `eval` can smuggle any of the above
  // past segment splitting, so the wrapper itself is treated as dangerous.
  `(?:(?:\\S*/)?(?:ba|z|k|da)?sh) -c (?:.*)`,
  `eval(?: .*)?`,
  // Pipe into an interpreter: `curl … | sh`, `wget -qO- … | bash`,
  // `… | python`, `| perl`, `| node`, `| ruby`, `| zsh -s`, `| sudo sh`,
  // `| xargs sh -c`. The classifier marks every pipeline SINK (a stage reading
  // a preceding stage's stdout) with `\u0000pipe-sink\u0000 ` and tests this
  // pattern against those sinks only, so a true pipeline sink into an
  // interpreter force-asks while a STANDALONE interpreter invocation does NOT:
  // `python -c 'x'`, `python app.py`, bare `node`/`sh` on their own, and a
  // benign sink (`curl x | jq .`, `… | grep foo`) all stay non-dangerous. The
  // sink interpreter reads/executes code driven by the pipe — bare, with stdin
  // flags (`-s`, a lone `-`), an inline program flag (`-c`/`-e`), a module flag
  // (`-m`), an optional `--` end-of-options, and ANY trailing args after them
  // (`| sh -s --`, `| bash -s -- arg`, `| perl -e …`, `| node -e …`,
  // `| ruby -e …`, `| python -m …`, `| xargs sh -c …`). Because the match is
  // gated on the sink marker, a STANDALONE `python -c 'x'` (no preceding pipe)
  // is NOT matched here and stays `unknown` → plain ask, not auto-approved.
  // `xargs`/`sudo` may front the interpreter (`| xargs sh -c`, `| sudo sh`).
  `\\x00pipe-sink\\x00 ${PRE}(?:(?:\\S*/)?(?:(?:ba|z|k|da)?sh|python3?|perl|node|ruby))(?: (?:--|-s|-|-c|-e|-m))*(?: .*)?`,

  // ── Raw-device and filesystem destruction (§9.3) ──────────────────────────
  // `dd` with an `of=` target that is a block/char device or any `/dev/*` path,
  // with `if=`/`bs=`/flags before or after the `of=` operand in any order
  // (`dd if=/dev/zero of=/dev/sda bs=1M`, `dd of=/dev/nvme0n1`). A `dd` writing
  // a regular file (`dd if=a of=b`) is NOT matched.
  `${CMD}dd(?: \\S+)* of=/dev/\\S+(?: .*)?`,
  // Filesystem creation / wipe tools, incl. an absolute path (`/sbin/mkfs.ext4`)
  // and any trailing device/args.
  `${CMD}(?:mkfs(?:\\.\\S+)?|mke2fs|wipefs)(?: .*)?`,
  // Secure-erase / discard against a device target (`/dev/*`).
  `${CMD}(?:shred|blkdiscard)(?: \\S+)* /dev/\\S+(?: .*)?`,
  // Partition editors in a writing invocation: `fdisk`/`sgdisk` on a device, and
  // `parted`/`sfdisk` (which write non-interactively) on a device.
  `${CMD}(?:parted|fdisk|sfdisk|sgdisk)(?: \\S+)* /dev/\\S+(?: .*)?`,
  // LUKS format / erase destroy a volume's keyslots.
  `${CMD}cryptsetup(?: \\S+)* (?:luksFormat|luksErase)(?: .*)?`,

  // ── Writes onto system paths (§9.3) ───────────────────────────────────────
  // A redirection (`>`/`>>`) onto a system path, with or without a space after
  // the operator and anywhere in the segment (`echo x > /etc/passwd`,
  // `cmd >>/etc/hosts`). The segment contains the redirection token followed by
  // the system path.
  `.* ?>>? ?${SYS_PATH}(?: .*)?`,
  // `tee`/`truncate` writing a system path (`cat f | sudo tee /etc/hosts` — the
  // `tee` segment of the pipeline is classified on its own).
  `${CMD}(?:tee|truncate)(?: \\S+)* ${SYS_PATH}(?: .*)?`,
  // `cp`/`mv` whose LAST operand (the destination) is a system path
  // (`cp evil ~/.ssh/authorized_keys`, `mv x /etc/hosts`). Any number of source
  // operands precede the system-path destination.
  `${CMD}(?:cp|mv)(?: \\S+)+ ${SYS_PATH}(?: .*)?`,
  // `ln -sf` (force symlink) whose target is a system path.
  `${CMD}ln(?: \\S+)* -[a-zA-Z]*s[a-zA-Z]*f?[a-zA-Z]*(?: \\S+)* ${SYS_PATH}(?: .*)?`,
  `${CMD}ln(?: \\S+)* -[a-zA-Z]*f[a-zA-Z]*s?[a-zA-Z]*(?: \\S+)* ${SYS_PATH}(?: .*)?`,
  // `sed -i` (in-place edit) of a system path (`sed -i s/a/b/ /etc/fstab`,
  // `sed -i.bak s/a/b/ /etc/hosts`); a `sed -i` of a workspace file is NOT
  // matched. The in-place flag may carry a backup suffix (`-i.bak`).
  `${CMD}sed(?: \\S+)* -[a-zA-Z]*i\\S*(?: \\S+)* ${SYS_PATH}(?: .*)?`,

  // ── Recursive ownership / mode change on a root target (§9.3) ──────────────
  // `chmod`/`chown`/`chgrp` with `-R`/`--recursive` against `/`, `/*`, `~`,
  // `$HOME`, or `$HOME/*` (`chmod -R 777 /`, `chown -R me /`). A recursive
  // change on a workspace path is NOT matched.
  `${CMD}(?:chmod|chown|chgrp)(?: \\S+)* (?:-[a-zA-Z]*[R][a-zA-Z]*|--recursive)(?: \\S+)* ${ROOT_TARGET}(?: .*)?`,
  `${CMD}(?:chmod|chown|chgrp)(?: (?:-[a-zA-Z]*[R][a-zA-Z]*|--recursive))?(?: \\S+)* ${ROOT_TARGET} (?:-[a-zA-Z]*[R][a-zA-Z]*|--recursive)(?: .*)?`,

  // ── Fork bombs (§9.3) ─────────────────────────────────────────────────────
  // The classic `:(){ :|:& };:` and spacing variants. normalizeShell collapses
  // whitespace, so the canonical form is matched; the function body's `|`/`;`
  // survive because splitSegments leaves this one-token-looking segment intact
  // only partially — so the bomb is matched on its distinctive head `:(){`.
  `: *\\(\\) *\\{.*`,
  // A named fork bomb: `bomb(){ bomb|bomb& };bomb`. The segment splitter cuts it at `|`, so the head
  // `name(){ name` — a function whose body immediately calls itself — is what survives to be matched.
  `(\\w+) *\\(\\) *\\{ *\\1\\b.*`,

  // ── Mass process kill (§9.3) ──────────────────────────────────────────────
  // `kill -9 -1` / `kill -KILL -1` (signal every process) and `killall5`. A
  // targeted `kill 1234` or `kill -9 1234` (a real PID) is NOT matched.
  `${CMD}kill(?: -(?:9|KILL|s KILL|SIGKILL))? -1(?: .*)?`,
  `${CMD}kill -(?:9|KILL|SIGKILL) -1(?: .*)?`,
  `${CMD}killall5(?: .*)?`,
  // `killall <name>` and bare `killall` are always-ask (owner D1.4): killing
  // every process of a name is destructive enough to prompt, but is NOT the
  // never-list `killall5` (kill EVERY process). `killall5` is caught above and
  // additionally by the never list; this adds the by-name/bare form.
  `${CMD}killall(?: .*)?`,

  // ── Power state (§9.3) ────────────────────────────────────────────────────
  `${CMD}(?:shutdown|reboot|halt|poweroff)(?: .*)?`,
  `${CMD}init [06](?: .*)?`,
  `${CMD}systemctl(?: \\S+)* (?:poweroff|reboot|halt)(?: .*)?`,

  // ── Firewall flush (§9.3) ─────────────────────────────────────────────────
  `${CMD}iptables(?: \\S+)* -F(?: .*)?`,
  `${CMD}(?:ip6tables)(?: \\S+)* -F(?: .*)?`,
  `${CMD}nft(?: \\S+)* flush(?: .*)?`,
  `${CMD}ufw (?:disable|reset)(?: .*)?`,

  // ── Infrastructure and data destruction (§9.3) ────────────────────────────
  // Terraform destroy, and `apply` carrying `-destroy` (`terraform apply
  // -destroy -auto-approve`). `terraform plan`/`apply` without `-destroy` are
  // NOT matched.
  `${CMD}terraform(?: \\S+)* destroy(?: .*)?`,
  `${CMD}terraform(?: \\S+)* apply(?: \\S+)* -destroy(?: .*)?`,
  // kubectl delete of a namespace (`kubectl delete ns prod`,
  // `kubectl delete namespace prod`) or `--all`. `kubectl get ns` is NOT.
  `${CMD}kubectl(?: \\S+)* delete(?: \\S+)* (?:ns|namespace)(?: .*)?`,
  `${CMD}kubectl(?: \\S+)* delete(?: \\S+)* --all(?: .*)?`,
  // helm uninstall.
  `${CMD}helm(?: \\S+)* (?:uninstall|delete)(?: .*)?`,
  // docker destructive: system prune -a, volume rm, rm -f (all containers).
  `${CMD}docker(?: \\S+)* system prune(?: \\S+)* -[a-zA-Z]*a[a-zA-Z]*(?: .*)?`,
  `${CMD}docker(?: \\S+)* volume rm(?: .*)?`,
  `${CMD}docker(?: \\S+)* rm(?: \\S+)* -[a-zA-Z]*f[a-zA-Z]*(?: .*)?`,
  // Cloud CLIs: AWS delete/terminate/remove, gcloud delete, az delete, anywhere
  // after the binary (`aws ec2 terminate-instances …`, `gcloud … delete`).
  `${CMD}aws .*(?:delete|terminate|remove).*`,
  // `aws s3 rm` (object delete) and `aws s3 rb` (bucket remove) — the `rm`/`rb`
  // subcommands do not carry a delete/terminate/remove word, so they are listed
  // explicitly (owner D1.4). `aws s3 cp`/`ls`/`sync` are NOT matched.
  `${CMD}aws(?: \\S+)* s3 (?:rm|rb)(?: .*)?`,
  `${CMD}gcloud .*delete.*`,
  `${CMD}az .*delete.*`,
  // SQL DROP / TRUNCATE run through a client (`psql -c 'DROP TABLE x'`,
  // `mysql -e "TRUNCATE t"`, `sqlite3 db 'DROP TABLE x'`). A `SELECT` is NOT
  // matched. Case-insensitive SQL keyword (SQL is case-insensitive).
  `${CMD}(?:psql|mysql|sqlite3)(?: .*)?(?:[dD][rR][oO][pP] +(?:[dD][aA][tT][aA][bB][aA][sS][eE]|[tT][aA][bB][lL][eE]|[sS][cC][hH][eE][mM][aA])|[tT][rR][uU][nN][cC][aA][tT][eE])(?: .*)?`,
  // redis-cli FLUSHALL / FLUSHDB.
  `${CMD}redis-cli(?: .*)?(?:FLUSHALL|FLUSHDB)(?: .*)?`,
  // mongo dropDatabase (`mongo … dropDatabase`, `mongosh --eval 'db.dropDatabase()'`).
  `${CMD}(?:mongo|mongosh).*dropDatabase.*`,

  // ── Git history destruction (§9.3) ────────────────────────────────────────
  `${GIT_PRE} filter-branch(?: .*)?`,
  `${GIT_PRE} filter-repo(?: .*)?`,
  `${GIT_PRE} reflog expire(?: \\S+)* --expire=now(?: .*)?`,
  `${GIT_PRE} gc(?: \\S+)* --prune=now(?: .*)?`,
  `${GIT_PRE} update-ref -d(?: .*)?`,

  // ── Option-smuggling through trusted binaries (owner S1 / audit MEDIUM) ────
  // A plain `git`/`ssh`/`tar`/`rsync` invocation is ordinarily safe, but a
  // handful of OPTIONS turn one into arbitrary code execution (a config key that
  // runs a command, a remote-exec option, a filter program). Each of these is a
  // force-ask regardless of the safe list so it can never auto-approve under an
  // `unlisted: allow` agent; an EXACT allow (whole command) is the only lift.
  //
  // `git -c <dangerous key>=…` anywhere before/around the subcommand: a
  // config key that runs a command or changes transport (`core.sshCommand`,
  // `core.fsmonitor`, `core.hooksPath`, `core.pager`, `core.editor`,
  // `protocol.ext.allow`). `-c` may appear with other global options.
  `${PRE}(?:\\S*/)?git(?: \\S+)* -c (?:${ciSource("core.sshCommand")}|${ciSource("core.fsmonitor")}|${ciSource("core.hooksPath")}|${ciSource("core.pager")}|${ciSource("core.editor")}|${ciSource("protocol.ext.allow")})=\\S*(?: .*)?`,
  // `git clone|fetch|pull|push|ls-remote` carrying `--upload-pack=`/
  // `--receive-pack=`/`--exec=` (run a program on the remote/local side).
  `${GIT_PRE} (?:clone|fetch|pull|push|ls-remote)(?: \\S+)* (?:--upload-pack=|--receive-pack=|--exec=)\\S*(?: .*)?`,
  // `ssh`/`scp`/`sftp` with `-o ProxyCommand=`/`-o LocalCommand=`/
  // `-o PermitLocalCommand` (run a command on connect). `-o` and value may be
  // one token (`-oProxyCommand=…`) or two (`-o ProxyCommand=…`).
  `${CMD}(?:ssh|scp|sftp)(?: \\S+)* -o ?(?:ProxyCommand|LocalCommand|PermitLocalCommand)\\S*(?: .*)?`,
  // `rsync` with `-e <cmd>`/`--rsh=<cmd>` (the remote shell command).
  `${CMD}rsync(?: \\S+)* (?:-e |--rsh=)\\S*(?: .*)?`,
  // `tar` with a command-running option: `--to-command`, `--checkpoint-action`,
  // `--use-compress-program`, or the short `-I` (compress program).
  `${CMD}tar(?: \\S+)* (?:--to-command|--checkpoint-action|--use-compress-program)(?:=\\S*)?(?: .*)?`,
  `${CMD}tar(?: \\S+)* -I\\b(?: .*)?`,
  // `crontab` (any) — installs scheduled commands.
  `${CMD}crontab(?: .*)?`,
  // `at`/`batch` — one-shot scheduled command execution.
  `${CMD}(?:at|batch)(?: .*)?`,
  // `systemd-run` and `systemctl [--user] enable` — persist a unit/command.
  `${CMD}systemd-run(?: .*)?`,
  `${CMD}systemctl(?: \\S+)* enable(?: .*)?`,
  // `chattr` (immutable/append bits), `mount`/`umount`, `setcap` (file caps).
  `${CMD}chattr(?: .*)?`,
  `${CMD}(?:mount|umount)(?: .*)?`,
  `${CMD}setcap(?: .*)?`,
  // `visudo`, `passwd`, and user-account mutation (`usermod`/`useradd`/`userdel`).
  `${CMD}visudo(?: .*)?`,
  `${CMD}passwd(?: .*)?`,
  `${CMD}(?:usermod|useradd|userdel)(?: .*)?`,
];

/** The default command-to-tool equivalents (§9.3). */
export const DEFAULT_SHELL_EQUIVALENTS: string[] = ["cat( .*)?", "grep( .*)?", "find( .*)?"];

/**
 * The structured web-search provider entry `webSearch` (§8.2, §8.5, §13.9):
 * `{ provider, endpoint?, apiKeyEnv?, extra? }`, shaped like a model entry.
 * `provider` is a built-in name (`duckduckgo`, `searxng`, `brave`, `tavily`) or
 * a plugin-registered id; `endpoint` names a self-hosted instance (required for
 * `searxng`); `apiKeyEnv` names the environment variable holding a keyed
 * provider's key — never the secret itself; `extra` is a pass-through string map
 * of provider-specific options the core forwards untouched.
 *
 * Validation (§13.9): `endpoint` must be `https`, except that `http` is allowed
 * when the host is a loopback or private-network literal (a self-hosted instance
 * on the user's own network); credentials embedded in the URL
 * (`https://user:pass@…`) are rejected. The object is `strict`: the three former
 * flat keys (`webSearchProvider`, `webSearchApiKeyEnv`, `webSearchGoogleCx`) are
 * removed and now rejected. A `webSearch` block (including its `endpoint`) may
 * be set in any layer; a private/loopback/link-local/metadata endpoint is
 * force-asked on every `web_search` call at the one gate (§9.3), not gated by
 * layer here.
 */
export function validateWebSearchEndpoint(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "endpoint is not a valid URL";
  }
  if (url.username !== "" || url.password !== "") {
    return "endpoint must not embed credentials (user:pass@)";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:") {
    // http is allowed only to a loopback or private-network literal host.
    const cls = classifyHost(url.hostname);
    if (cls.verdict === "force-ask") return null; // a private/loopback/link-local literal
    return "endpoint must be https (http allowed only for a loopback or private-network host)";
  }
  return "endpoint must be an http(s) URL";
}

/** The per-entry bounds for `worktreeInclude` (§7.3). */
export const WORKTREE_INCLUDE_MAX_ENTRIES = 64;
export const WORKTREE_INCLUDE_MAX_LENGTH = 512;

/**
 * Validate one `worktreeInclude` entry (§7.3). Each entry is a path RELATIVE to
 * the repo root naming a file or directory the harness copies into every new
 * worktree at creation (no globs, no negation). Returns an error string, or null
 * when valid. The rules (owner-settled): non-empty; no NUL; not absolute; no
 * `..` segment; no backslash; ≤ 512 characters; and nothing that is, contains,
 * or lies inside `.git` (the copy would corrupt the worktree's own git state).
 * A `*`/`?`/`[` is allowed as a LITERAL filename character — globs are NOT
 * expanded, so an entry naming such a file copies it literally.
 */
export function validateWorktreeIncludeEntry(raw: string): string | null {
  if (typeof raw !== "string") return "entry must be a string";
  if (raw === "") return "entry must not be empty";
  if (raw.includes("\u0000")) return "entry must not contain a NUL byte";
  if (raw.length > WORKTREE_INCLUDE_MAX_LENGTH) return `entry must be at most ${WORKTREE_INCLUDE_MAX_LENGTH} characters`;
  if (raw.includes("\\")) return "entry must not contain a backslash (use forward slashes)";
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return "entry must be a relative path, not absolute";
  const segments = raw.split("/");
  if (segments.includes("..")) return 'entry must not contain a ".." segment';
  // Refuse anything that IS, CONTAINS, or LIES INSIDE `.git` at any level.
  if (segments.some((s) => s === ".git")) return 'entry must not be, contain, or lie inside ".git"';
  // Refuse an entry that normalizes to the repo root itself (".", "./", "./.",
  // "a/..", or anything empty after normalization): it would copy the whole repo
  // over itself. `..` is already rejected above, so this catches "."-only paths.
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized === "./" || normalized === "" || normalized === "/") {
    return "worktreeInclude entries must name a file or directory below the repository root";
  }
  return null;
}

export const WebSearchSchema = z
  .object({
    provider: z.string().default("duckduckgo"),
    endpoint: z
      .string()
      .refine((v) => validateWebSearchEndpoint(v) === null, {
        message: "invalid webSearch.endpoint (https required except a loopback/private host; no URL credentials)",
      })
      .optional(),
    apiKeyEnv: z.string().optional(),
    extra: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type WebSearchConfig = z.infer<typeof WebSearchSchema>;

/** Validate a plugin `options` value: a plain JSON object (no functions, no
 * cycles), serializable. The byte-size cap is enforced at plugin load time
 * (§12.4) using the layered `limits.plugins.optionsMaxBytes` action: warn
 * (accept + emit LIMIT_HIT) or deny (refuse with a typed error). Secrets belong
 * in it only as env-var NAMES — the plugin resolves them from `process.env` at
 * use time (§12.4). */
const PluginOptionsSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, ctx) => {
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "plugin options must be a plain JSON object (no functions or cycles)" });
      return;
    }
    if (serialized === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "plugin options must be a plain JSON object" });
      return;
    }
    // Byte-size validation moved to runtime (plugin-loader call site) where we can
    // honor the layered limit action (warn → accept + emit LIMIT_HIT, deny → refuse).
  });

/** A plugin entry in `config.plugins` (§12.4): a package or path, enablement.
 * `path` names an explicit path entry; absent means a package entry resolved by
 * Node module resolution. `enabled` gates loading — a listed-but-disabled entry
 * never loads. `options` is a plain-JSON object handed verbatim to the plugin's
 * `register(core, options)` (§12.4); exporters read `options.config`, retrieval
 * reads `options.config`/backends. */
export const PluginEntrySchema = z.object({
  enabled: z.boolean().default(true),
  path: z.string().optional(),
  options: PluginOptionsSchema.optional(),
});

export type PluginEntry = z.infer<typeof PluginEntrySchema>;

/** The compliance (Warden) config block (§9.6). */
export const ComplianceSchema = z
  .object({
    mode: z.enum(["off", "permissive", "enforcing"]).default("off"),
    source: z.string().optional(),
  })
  .loose();

/** The full config schema. Only slice-1 and essential keys are enumerated; the
 * remainder take schema defaults. Top level is closed except declared pockets. */
export const ConfigSchema = z
  .object({
    models: z.record(z.string(), ModelConfigEntrySchema).default({}),
    modelSelected: z.string().optional(),
    // The internal/utility model (summaries, session naming, background calls);
    // the current name of the retired `modelBackground`/`modelTierUtility` keys
    // the versioned migration maps to (§13.1, config/migrate.ts). Optional and
    // unset falls back to `modelSelected` at the call site.
    modelUtility: z.string().optional(),

    networkModelTimeout: z.number().int().positive().default(120_000),
    networkModelMaxRetries: z.number().int().nonnegative().default(3),

    // §3.6 — an explicit override of the LangGraph recursion ceiling. UNSET it
    // is DERIVED from `turnMaxToolRounds` with a margin (2*rounds+5) by the
    // engine; set, it wins. Optional (no default) so the engine can tell an
    // explicit override from the derived ceiling. `0` → a large finite ceiling,
    // never passed as 0 (§3.6).
    turnRecursionLimit: z.number().int().nonnegative().optional(),
    turnMaxConcurrency: z.number().int().positive().default(2),
    // Per-worker super-step budget, bound as each dispatched worker's LangGraph
    // recursionLimit (§7.2, §3.6). Distinct from the orchestrator's
    // turnRecursionLimit so budgets are set per tier, never assumed to inherit.
    subagentRecursionLimit: z.number().int().positive().default(25),
    // Age (minutes) past which a dead-owner worktree is pruned on boot (§7.2,
    // §7.3). Prefixed `vcs` because pruning runs in the VCS adapter.
    vcsWorktreeTtlMinutes: z.number().int().positive().default(120),
    // §3.6 — the ENFORCED user-facing per-turn ceiling on model→tools rounds.
    // The engine counts rounds and derives LangGraph's recursionLimit from this
    // (2*rounds+5) when `turnRecursionLimit` is unset; reaching it ends the turn
    // `limit_reached` with a result always carried (§3.3).
    turnMaxToolRounds: z.number().int().positive().default(15),
    turnShutdownGraceMs: z.number().int().nonnegative().default(5_000),
    turnLoopMaxConsecutiveErrors: z.number().int().positive().default(3),
    turnLoopMaxIdenticalCalls: z.number().int().positive().default(4),
    turnLoopFingerprintRepeats: z.number().int().positive().default(3),
    turnLoopFingerprintWindow: z.number().int().positive().default(20),

    housekeepingIdleDays: z.number().int().positive().default(30),
    resumeOnStart: z.union([z.literal(1), z.literal(0)]).optional(),

    workspaceMaxReadLines: z.number().int().positive().default(2000),
    workspaceMapDepth: z.number().int().positive().default(5),
    shellCommandTimeoutMs: z.number().int().positive().default(30_000),
    shellMaxBufferBytes: z.number().int().positive().default(1_048_576),
    toolWaitMaxSeconds: z.number().int().positive().default(300),
    // `web_fetch` request timeout (§8.2, §8.6).
    webFetchTimeoutMs: z.number().int().positive().default(10_000),
    // The structured web-search provider selection (§8.2, §8.5, §13.9). The
    // default is the free, keyless `duckduckgo` so search works out of the box.
    webSearch: WebSearchSchema.default({ provider: "duckduckgo" }),

    contextToolResultPct: z.number().int().min(1).max(100).default(10),
    toolsTrimHeadLines: z.number().int().nonnegative().default(30),
    toolsTrimTailLines: z.number().int().nonnegative().default(20),

    // The mutation journal content-capture level (§10.11, §13.10). A scalar that
    // overrides by layer (project replaces global). `off` records metadata only;
    // `action` captures before/after content of every write in order; `turn`
    // captures the net change per target at each turn boundary. Default `action`
    // for local text files, falling back to `turn` for binary or over-cap
    // targets (that fallback is in code, not config, see JOURNAL_LIMITS).
    mutationLogLevel: z.enum(["off", "turn", "action"]).default("action"),

    // Rollback: how many of the most recent MOVES are tracked (§10.12, §13.10).
    // An integer 0–500, a scalar that overrides by layer (project replaces
    // global), seeded VISIBLY in the first-run config. Older moves beyond the
    // count — and their git refs or cache entries — are pruned oldest first. `0`
    // disables snapshots and rollback entirely. Applies to BOTH methods.
    snapshotCount: z.number().int().min(0).max(500).default(50),

    // Context sizing by percentages (§4.8). The three working-budget triggers,
    // the head WARNING threshold (a share of the window — not a cap, §4.2.1),
    // and extra notice bands. All cascade global → project → session and take a
    // per-endpoint override (§4.8).
    contextActiveBudgetPct: z.number().int().positive().default(20),
    contextCompactionPct: z.number().int().positive().default(40),
    contextSafetyNetPct: z.number().int().positive().default(80),
    contextHeadWarnPct: z.number().int().positive().default(20),
    contextNoticePcts: z.array(z.number().int().positive()).default([]),

    // Memory bounds and reflection (§6.3, §6.7). All cascade global → project →
    // session like every other key; a bounded write over the limit is rejected.
    memoryMaxEntryChars: z.number().int().positive().default(2200),
    memoryReflectionBatchSize: z.number().int().positive().default(3),

    // The single `limits` registry section (§13.11). Nested by area and
    // validated against `entities/limits.ts`; an unknown area/leaf is a
    // validation error naming it, and each leaf is bounded by its registry
    // [min, max]. The safety-lower-only cascade rule is applied by the config
    // capability, not here. Defaults to `{}` so adding the section changes
    // nothing.
    limits: LimitsSchema,

    mcpAutoConnect: z.boolean().default(true),

    permissions: z.record(z.string(), PermissionRuleSchema).default({}),
    // The never-list opt-out (§13.5, §13.10): an array of plain never-list names
    // (e.g. `power-state`) a global/managed layer may lift. ENFORCEMENT is a
    // later stage — this slice accepts and exposes the key only (seeded empty).
    unlock: z.array(z.string()).default([]),
    // The directories research findings are written under (§13.8). ENFORCEMENT
    // is a later stage — this slice accepts and exposes the key only.
    findingsDirectories: z.array(z.string()).default([".voidrift/research/"]),
    // The user-configurable set of untracked/ignored paths the harness copies
    // into each new worktree at creation (§7.3). Each entry is a repo-root-
    // relative file or directory (no globs, no negation); the layers UNION
    // (ARRAY_UNION_KEYS) so a project list extends the global one. Validated per
    // entry and bounded to at most 64 entries per layer; an invalid entry is a
    // validation error naming the key, like every other key.
    worktreeInclude: z
      .array(z.string())
      .max(WORKTREE_INCLUDE_MAX_ENTRIES, `worktreeInclude allows at most ${WORKTREE_INCLUDE_MAX_ENTRIES} entries per layer`)
      .superRefine((entries, ctx) => {
        entries.forEach((entry, i) => {
          const problem = validateWorktreeIncludeEntry(entry);
          if (problem) ctx.addIssue({ code: "custom", message: `worktreeInclude[${i}]: ${problem}`, path: [i] });
        });
      })
      .default([]),
    permissionsApprovalTimeoutMs: z.number().int().nonnegative().default(120_000),
    shellSafeCommands: z.array(z.string()).default(DEFAULT_SHELL_SAFE),
    shellForceAskPatterns: z.array(z.string()).default(DEFAULT_SHELL_FORCE_ASK),
    shellEquivalents: z.array(z.string()).default(DEFAULT_SHELL_EQUIVALENTS),
    shellDenyPatterns: z.array(z.string()).default([]),

    compliance: ComplianceSchema.default({ mode: "off" }),
    logLevel: z.enum(["info", "verbose", "debug"]).default("info"),
    // Observability storage + rotation (§10.3) and trace-analysis threshold
    // (§10.6). `logMaxAgeDays` is optional and unset by default — age-based
    // dropping is opt-in for deployments with time-based audit rules.
    logMaxSizeMB: z.number().int().positive().default(50),
    logMaxAgeDays: z.number().int().positive().optional(),
    turnSuggestionThreshold: z.number().int().positive().default(3),
    // The longest consecutive tool-call sequence the repeated-sequence detector
    // matches as one unit (§10.6). Advanced tier.
    sequenceMaxLen: z.number().int().positive().default(6),

    // Configured MCP servers (§8.4): name → server config. Validated against the
    // MCP config schema at save; the top-level record is a passthrough pocket so
    // adding/removing a server never fails the strict top level.
    mcp: z
      .record(
        z.string(),
        z
          .object({
            transport: z.enum(["stdio", "http", "http-sse"]).default("stdio"),
            command: z.string().optional(),
            args: z.array(z.string()).optional(),
            env: z.record(z.string(), z.string()).optional(),
            url: z.string().optional(),
            headers: z.record(z.string(), z.string()).optional(),
            auth: z.record(z.string(), z.unknown()).optional(),
          })
          .loose(),
      )
      .optional(),

    // Skills allowlist (§12.1): empty means every discovered skill is available;
    // a non-empty list scopes the index to the named skills across all sources.
    skills: z.array(z.string()).default([]),

    // The authoritative plugin load list (§12.4): id → entry. `enabled` gates
    // loading; `path` names an explicit path entry (absent = a package entry
    // resolved by Node module resolution). Only listed, enabled entries load.
    plugins: z.record(z.string(), PluginEntrySchema).default({}),

    // The npm registry the plugin discovery/install path uses (§12.4.1, §13.9).
    // The spec names this `plugins.registry`; a dotted scalar cannot live inside
    // the `plugins` record (which holds PluginEntry values), so it is the scalar
    // sibling `pluginsRegistry` — the same shape as `mcpAutoConnect` beside the
    // `mcp` record (§13.6). Must be https except a loopback address; the managed
    // layer may pin it (§13.5). Validated here so an invalid URL fails loudly.
    pluginsRegistry: z
      .string()
      .refine((v) => validateRegistryUrl(v) !== null, {
        message: "pluginsRegistry must be an https URL (http allowed only for loopback)",
      })
      .default("https://registry.npmjs.org"),

    apps: z.record(z.string(), z.unknown()).optional(), // passthrough pocket (§13.2)
  })
  .strict(); // unknown top-level keys are a validation error (§13.2)

export type Config = z.infer<typeof ConfigSchema>;

/** The session-overridable subset of config (§13.7). */
export const SESSION_OVERRIDABLE_KEYS = [
  "modelSelected",
  "permissions",
  "turnMaxConcurrency",
  "turnRecursionLimit",
  "subagentRecursionLimit",
  "contextActiveBudgetPct",
  "contextCompactionPct",
  "contextSafetyNetPct",
  "contextHeadWarnPct",
  "contextNoticePcts",
  "memoryMaxEntryChars",
  "memoryReflectionBatchSize",
] as const;

/**
 * The top-level array-valued config keys whose layers UNION (§13.1). When more
 * than one layer sets one of these, the resolved value is the deduped union of
 * every contributing layer in broad→narrow order (a broader layer's entries
 * first, then the narrower layer's new entries). `unlock` is deliberately
 * EXCLUDED: it is a safeguard opt-out honored only from the global/managed
 * layers (§13.5, §13.10), never unioned in from a project/session layer.
 * `contextNoticePcts` is also EXCLUDED: it is a tuning vector (a set of
 * thresholds), not a list of distinct entries, so the narrower layer REPLACES
 * it rather than appending to it. Every other top-level `z.array(...)` in
 * `ConfigSchema` that is a true list of entries is listed here. Records
 * (`permissions`, `plugins`, `mcp`, `models`) merge by key/id, and objects
 * (`webSearch`, `compliance`) merge per key; neither is an array and neither
 * belongs here.
 */
export const ARRAY_UNION_KEYS = [
  "findingsDirectories",
  "shellSafeCommands",
  "shellForceAskPatterns",
  "shellEquivalents",
  "shellDenyPatterns",
  "skills",
  "worktreeInclude",
] as const;

/** The config layers, broad → narrow (§13.1). */
export type ConfigLayer = "managed" | "global" | "project" | "session";
