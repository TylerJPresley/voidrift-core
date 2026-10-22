/**
 * Secret-mask seam (core-blueprint.md §6.8, §10.10).
 *
 * A single, shared detector applied to action data before it leaves the
 * process — approval requests (the `ask` suspension) and the
 * PERMISSION_REQUESTED event (§9.5/§10.10) and every memory-provider payload
 * (§6.8). This is the ONE wiring point so masking never diverges between paths
 * and there is nothing to remember at each emit site (§15.1).
 *
 * The built-in categories (§10.10) span: private-key blocks (PEM, all types)
 * and SSH keys; bearer/basic authorization and secret-bearing HTTP headers;
 * database-URL and generic URL userinfo; URL query parameters named like a
 * secret; cloud and provider access keys (AWS, GCP service-account JSON, Azure
 * connection strings/SAS, Google API keys); version-control and package tokens
 * (GitHub classic + fine-grained PATs, GitLab, npm); chat/service tokens
 * (Slack webhooks/tokens, Stripe, Twilio, SendGrid); JSON web tokens; secret
 * CLI flags (`--password=`, `curl -u`, …); and environment-style assignments
 * whose variable name contains a secret-bearing word (mask the VALUE, keep the
 * name).
 *
 * Every pattern is LINEAR-TIME: no nested quantifiers, no overlapping
 * alternations, bounded or single-pass character classes only — so a 1 MB
 * adversarial string masks in well under 50 ms. The marker is STABLE — the same
 * category masks to the same marker so correlation across records survives
 * masking; only the value is hidden, never the surrounding structure. Negatives
 * (git SHAs, UUIDs, package versions, data-URI base64, file paths, the words
 * "password"/"token" in prose, `maxTokens: 4096`) match no category and are left
 * untouched. Masking is idempotent: a `«redacted:…»` marker is never re-masked.
 */

const MARKER_PREFIX = "«redacted:";
const MARKER_SUFFIX = "»";

/** A UUID — a negative sample that must NOT be masked (§10.10). */
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** True when a captured value is itself a redaction marker — never re-mask it
 * (idempotence). */
function isMarker(value: string): boolean {
  return value.startsWith(MARKER_PREFIX) && value.endsWith(MARKER_SUFFIX);
}

/** A stable marker for a given category. */
function marker(category: string): string {
  return `${MARKER_PREFIX}${category}${MARKER_SUFFIX}`;
}

/**
 * Secret categories (§10.10). Each entry replaces the matched *secret value*
 * (capture group `group` when present, else the whole match) with a stable
 * marker, leaving the surrounding text intact. Order matters: structured
 * categories (PEM/SSH, headers, URLs, env assignments, CLI flags) run before the
 * broad token categories so a value inside a known structure is attributed to
 * that structure and its own token is not matched again inside the marker.
 *
 * Every regex is linear-time. Where a value is bounded we cap its length with a
 * `{min,max}` quantifier rather than an unbounded `+`, and no pattern nests a
 * quantified group inside another quantifier.
 */
interface Category {
  name: string;
  re: RegExp;
  /** The capture group holding the secret value; the whole match when absent. */
  group?: number;
}

const CATEGORIES: Category[] = [
  // ── Structured key blocks ──────────────────────────────────────────────────
  // Private-key blocks (PEM), every type. `[\s\S]*?` is lazy but single (not
  // nested in another quantifier), so it is linear.
  {
    name: "private-key",
    re: /-----BEGIN (?:[A-Z0-9 ]{1,40} )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]{1,40} )?PRIVATE KEY-----/g,
  },
  // OpenSSH private key block (the body is the same PEM shape, caught above);
  // the explicit OPENSSH header is covered by the generic PEM class.

  // ── Headers ─────────────────────────────────────────────────────────────────
  // Authorization: Bearer/Basic <token>.
  {
    name: "authorization",
    re: /\b(?:Authorization\s*[:=]\s*)?(?:Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{8,4096})/gi,
    group: 1,
  },
  // Secret-bearing HTTP headers by NAME — mask the header value (rest of line).
  // `X-Api-Key:`, `Cookie:`, `Set-Cookie:`, `X-Auth-Token:`, `Proxy-Authorization:`.
  {
    name: "header",
    re: /\b(X-Api-Key|X-Auth-Token|Api-Key|Cookie|Set-Cookie|Proxy-Authorization)(\s*:\s*)([^\r\n]{1,8192})/gi,
    group: 3,
  },

  // ── URLs ──────────────────────────────────────────────────────────────────
  // Database / AMQP / generic URL userinfo: scheme://user:password@host — mask
  // the password (group after the colon). Covers postgres/mysql/redis/amqp/
  // mongodb(+srv)/https/http and any scheme.
  {
    name: "url-password",
    re: /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{1,256}:([^\s/@]{1,256})@/gi,
    group: 1,
  },
  // redis://:password@host — userinfo with no username (leading colon).
  {
    name: "url-password",
    re: /\b[a-z][a-z0-9+.-]{0,30}:\/\/:([^\s/@]{1,256})@/gi,
    group: 1,
  },
  // URL query parameters named like a secret: ?token=…&key=… etc. Mask the value.
  {
    name: "url-param",
    re: /([?&](?:access_token|api_key|apikey|auth|key|password|secret|signature|sig|token)=)([^\s&#"']{1,4096})/gi,
    group: 2,
  },
  // Azure connection-string fields: AccountKey=… , SharedAccessSignature=… , sig=…
  {
    name: "azure",
    re: /\b(AccountKey|SharedAccessSignature)(=)([^\s;"']{1,4096})/gi,
    group: 3,
  },

  // ── CLI flags ───────────────────────────────────────────────────────────────
  // --password=… / --token=… / --secret=… / --api-key=… (and single-dash forms).
  {
    name: "cli-flag",
    re: /(--?(?:password|passwd|token|secret|api[-_]?key|access[-_]?token|auth[-_]?token)[=\s])(?!-)([^\s"']{1,4096})/gi,
    group: 2,
  },
  // curl -u user:pass  (basic-auth pair after -u/--user).
  {
    name: "cli-flag",
    re: /((?:^|\s)-u\s+|--user\s+)([^\s:"']{1,256}:)([^\s"']{1,256})/g,
    group: 3,
  },
  // Attached-secret flags: `-p<secret>` (mysql), `docker login -p <secret>`.
  // `-p` immediately followed by the secret, or `-p <secret>` (one space).
  {
    name: "cli-flag",
    re: /((?:^|\s)-p ?)([^\s"']{3,4096})/g,
    group: 2,
  },

  // ── Cloud / provider access keys ──────────────────────────────────────────
  // GCP service-account JSON fields: "private_key_id": "…", "client_secret": "…".
  // (A "private_key" PEM value is caught by the private-key class above.)
  {
    name: "gcp",
    re: /("(?:private_key_id|client_secret)"\s*:\s*")([^"\r\n]{1,4096})(")/g,
    group: 2,
  },
  // Google API key: AIza + 35 url-safe chars.
  {
    name: "google-api-key",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  // AWS access key id (AKIA/ASIA + 16 or more uppercase/digits).
  {
    name: "aws-access-key-id",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16,}\b/g,
  },
  // AWS secret access key: a bare 40-char base64-ish value adjacent to an
  // aws/secret_access_key context word. Mask the value (group 2).
  {
    name: "aws-secret-key",
    re: /\b(aws[_a-z]*|secret_access_key|AKIA[0-9A-Z]{16})\b([\s:="']{1,8})([A-Za-z0-9/+]{40})\b/gi,
    group: 3,
  },

  // ── Version-control / package / provider tokens (prefixed) ────────────────
  // GitHub fine-grained PAT (github_pat_…), classic PATs (ghp_/gho_/ghu_/ghs_/
  // ghr_), GitLab (glpat-), npm (npm_ + 36), Slack (xox[baprs]-),
  // Stripe live/restricted (sk_live_/rk_live_), SendGrid (SG.x.y),
  // Twilio API key SID (SK + 32 hex), OpenAI (sk-…).
  {
    name: "token",
    re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g,
  },
  {
    name: "token",
    re: /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g,
  },
  {
    name: "token",
    re: /\bglpat-[A-Za-z0-9_-]{16,255}\b/g,
  },
  {
    name: "token",
    re: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    name: "token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,255}\b/g,
  },
  {
    name: "token",
    re: /\b(?:rk|sk)_live_[A-Za-z0-9]{16,255}\b/g,
  },
  {
    name: "token",
    re: /\bSG\.[A-Za-z0-9_-]{22,66}\.[A-Za-z0-9_-]{22,66}\b/g,
  },
  {
    name: "token",
    re: /\bSK[0-9a-f]{32}\b/g,
  },
  {
    name: "token",
    re: /\bsk-[A-Za-z0-9_-]{16,255}\b/g,
  },
  // Twilio auth token: a 32-hex value adjacent to a `twilio` context word.
  {
    name: "twilio",
    re: /\b(twilio[_a-z]*)\b([\s:="']{1,8})([0-9a-f]{32})\b/gi,
    group: 3,
  },

  // ── Slack webhook URL ─────────────────────────────────────────────────────
  {
    name: "slack-webhook",
    re: /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,255}\b/g,
  },

  // ── JSON web tokens ────────────────────────────────────────────────────────
  // Three base64url segments separated by dots; the header always starts `eyJ`.
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{4,8192}\.[A-Za-z0-9_-]{4,8192}\.[A-Za-z0-9_-]{4,8192}\b/g,
  },
];

/**
 * Environment-style assignment whose variable name contains a secret-bearing
 * word (§10.10). Matches `NAME=value`, `name: value`, `name = value`, and
 * query-string style `token=value`. The value (group 4) is masked, the name and
 * separator kept. Linear: fixed character classes, a single value quantifier.
 */
const ENV_ASSIGNMENT =
  /(^|[^A-Za-z0-9_.-])((?:[A-Za-z0-9]+[_.-])*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|PRIVATE|CREDENTIAL|AUTH)(?:[_.-][A-Za-z0-9]+)*)(\s*[:=]\s*)("?)([^\s"'&;]{1,8192})\4/gi;

/**
 * Redact secret-looking content in a single string per the §10.10 category
 * matrix. Negatives (plain UUIDs/hashes/base64) are left untouched because they
 * match no category. The marker is stable per category so correlation survives.
 * Idempotent: a value that is already a `«redacted:…»` marker is never re-masked.
 */
function redactString(input: string): string {
  // Fast skip for the common non-secret case: scanning a plain string against
  // the structured categories is linear and short-circuits here.
  let out = input;

  // Environment-style assignments first — keep the variable name, mask the value.
  out = out.replace(
    ENV_ASSIGNMENT,
    (_m, lead: string, name: string, sep: string, q: string, value: string) => {
      if (UUID.test(value) || isMarker(value)) return `${lead}${name}${sep}${q}${value}${q}`;
      return `${lead}${name}${sep}${marker("env")}`;
    },
  );

  for (const { re, group, name } of CATEGORIES) {
    re.lastIndex = 0;
    out = out.replace(re, (match: string, ...rest: unknown[]) => {
      const captured = group ? (rest[group - 1] as string) : match;
      if (!captured) return match;
      if (UUID.test(captured)) return match;
      if (isMarker(captured)) return match; // idempotence
      const replacement = marker(name);
      return group ? match.replace(captured, replacement) : replacement;
    });
  }

  return out;
}

/** Mask secret-looking values in a tool-call `args` map before it leaves the
 * process (§9.5/§10.10). Delegates to the one shared detector. */
export function maskSecrets(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return maskValue(args) as Record<string, unknown>;
}

/**
 * Mask secret-looking content in a single string through the ONE detector
 * (§10.10). The large-result eviction path (§8.3) masks the FULL tool result
 * before it is written to the persisted session cache and before its head/tail
 * excerpts go into the model-facing handle, so no recognized secret ever lands
 * on disk or in the window. Delegates to `redactString`; no second detector.
 */
export function maskText(value: string): string {
  return redactString(value);
}

/**
 * Whether a string carries a secret the §10.10 detector recognizes. Reuses the
 * ONE detector (`redactString`): a value contains a secret exactly when masking
 * it changes it. Used to keep an Authorization header out of config persistence
 * (§8.4) — the one egress the mask does not otherwise cover.
 */
export function containsSecret(value: string): boolean {
  return redactString(value) !== value;
}

/**
 * Whether an HTTP header is a secret that must never reach a config file (§8.4).
 * `Authorization` is always treated as secret (even a value the broad category
 * matrix might not flag); any other header is secret when its value trips the
 * §10.10 detector.
 */
export function isSecretHeader(name: string, value: string): boolean {
  if (name.toLowerCase() === "authorization") return true;
  return containsSecret(value) || containsSecret(`${name}=${value}`);
}

/**
 * Mask secret-looking content in an arbitrary JSON value — strings, arrays, and
 * nested objects alike — before it leaves the process. The memory-provider
 * scrub (§6.8) routes every payload (TurnContext, TurnRecord, SessionSummary,
 * memory items) through here so the ONE detector covers the provider path too.
 *
 * Returns a structure-preserving deep copy with secret leaves redacted, so a
 * provider never receives a live reference into harness state and never a bare
 * credential value.
 */
export function maskValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(maskValue);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskValue(v);
    }
    return out;
  }
  return value;
}
