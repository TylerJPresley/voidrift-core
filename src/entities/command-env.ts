/**
 * The command-environment allowlist (core-blueprint.md §8.2 "The environment is
 * explicit state too").
 *
 * A model-run command (`execute_command`, every `wait` `check`, and a worker's
 * command) must NOT inherit the host's full environment: a host-held credential
 * (`OPENAI_API_KEY`, `AWS_*`, `GITHUB_TOKEN`, …) would otherwise be visible to a
 * command the model composed. This one pure function copies ONLY a fixed
 * allowlist of benign, behaviour-shaping variables from the host environment —
 * so a version-managed `node` or `~/.local/bin` tool is still found via the
 * host `PATH`, while no secret reaches the child. The allowlist is fixed in code
 * and has NO configuration key (§8.2).
 *
 * Git runs (the hardened runner, `adapters/git-harden.ts`) build their OWN env
 * and are untouched; MCP stdio transport resolves its own `env` and is untouched.
 */

/** The exact variable names copied from the host when defined (case-sensitive).
 * `LC_*` is handled by prefix below (not listed here). */
const ALLOWED_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "TZ",
];

/** A variable name carried through because it begins with `LC_` (locale
 * categories such as `LC_ALL`, `LC_CTYPE`). Exact, case-sensitive prefix. */
function isLcName(name: string): boolean {
  return name.startsWith("LC_");
}

/**
 * Build the child environment for a model-run command from the host environment:
 * the allowlisted names and any `LC_*` name, each with the host's value when it
 * is defined (an unset variable is omitted, never set to an empty string). No
 * other variable — in particular no secret-bearing one — is copied. PURE: it
 * reads only its `host` argument and allocates a fresh object.
 */
export function buildCommandEnv(host: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ALLOWED_NAMES) {
    const value = host[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(host)) {
    if (value !== undefined && isLcName(name)) env[name] = value;
  }
  return env;
}
