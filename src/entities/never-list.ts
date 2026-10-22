/**
 * The NEVER LIST (core-blueprint.md §9.3, §13.5, §13.10; owner D1).
 *
 * Commands denied in EVERY mode and posture — regardless of allow rules, an
 * `unlisted: allow` agent, a session approval, a plan scope, or a fan-out grant.
 * There is NO prompt: a never-list hit is `deny`, always. It lives HERE IN CODE
 * (not in the config file), because its regexes carry security weight and must
 * not be weakened by a layer edit; the only opt-out is the config `unlock` array
 * (honored from the global/managed layer only, §13.10), which lists category ids
 * to LIFT — a lifted category falls back to the always-ask class it belongs to
 * (dangerous shell or the SSRF metadata force-ask), so a lifted command still
 * prompts on every call.
 *
 * Each category composes the shared anchored fragments (`shell-fragments.ts`)
 * so a wrapper (`sudo`, `env FOO=1`, `timeout 5`), quoting/escapes, and an
 * absolute binary path (`/sbin/mkfs.ext4`) cannot bypass it — the SAME
 * normalization and per-segment / substitution / pipeline-sink checking the
 * force-ask list gets, because the never list is evaluated through the same
 * `classifyCommand` segment walk.
 */
import { CMD, RM_BIN, PRE } from "./shell-fragments.js";
import { windowScan, anchoredRegex } from "./shell-scan.js";

/** A never-list category: a stable id used by `unlock`, a one-line plain-English
 * description surfaced by `config.neverList()` (for `/access` and `doctor`), and
 * the anchored regex patterns a normalized command segment is tested against. */
export interface NeverCategory {
  id: string;
  description: string;
  patterns: string[];
}

// ── wipe-disk ────────────────────────────────────────────────────────────────
// Raw block-device / filesystem destruction. `dd` is NEVER only when its `of=`
// target is a device (`/dev/*`); `dd` writing a regular file stays allowed.
const WIPE_DISK: string[] = [
  // dd / cat / shred writing to a block device via `of=` or a `>`/`>>` redirect.
  `${CMD}dd(?: \\S+)* of=/dev/\\S+(?: .*)?`,
  `${CMD}(?:shred|blkdiscard)(?: \\S+)* /dev/\\S+(?: .*)?`,
  // A redirect (`>`/`>>`) onto a block device: `cat img > /dev/sda`, `… >/dev/sdb`.
  `.* ?>>? ?/dev/(?:sd|nvme|mapper|vd|hd|loop|dm-)\\S*(?: .*)?`,
  // Filesystem creation / wipe tools.
  `${CMD}(?:mkfs(?:\\.\\S+)?|mke2fs|wipefs)(?: .*)?`,
  // Partition editors writing a device (fdisk/parted/sfdisk/sgdisk on /dev/*).
  `${CMD}(?:parted|fdisk|sfdisk|sgdisk)(?: \\S+)* /dev/\\S+(?: .*)?`,
];

// ── delete-system-dirs ─────────────────────────────────────────────────────
// A recursive delete of a filesystem root / home / system directory, or any
// `rm` carrying `--no-preserve-root`. A system-dir target the classifier must
// catch bare, with a trailing glob/dot, or as a `/lib*` variant.
const SYS_DIR =
  "(?:" +
  "/" + // bare root
  "|/\\*|/\\.?" + // `/*`, `/.`
  "|~(?:/\\*)?|\\$HOME(?:/\\*)?" + // home
  "|/(?:home|root|etc|usr|bin|sbin|lib[^/\\s]*|boot|var|opt|dev|proc|sys)(?:/\\*|/)?" + // system dirs
  ")";
const DELETE_SYSTEM_DIRS: string[] = [
  // `rm` with ANY `--no-preserve-root` is never-list regardless of target.
  `${RM_BIN}(?: \\S+)* --no-preserve-root(?: .*)?`,
  // Recursive `rm` (short `-r`/`-R` combined or long `--recursive`, with or
  // without `-f`) whose target is a system dir / root / home.
  `${RM_BIN}(?: \\S+)* (?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?: \\S+)* ${SYS_DIR}(?: .*)?`,
  // `rm -fr` / `-rf` combined flag then a system-dir target.
  `${RM_BIN}(?: \\S+)* -[a-zA-Z]*[rR][a-zA-Z]*(?: \\S+)* ${SYS_DIR}(?: .*)?`,
];

// ── overwrite-system-files ───────────────────────────────────────────────────
// Redirect / tee / cp / mv / ln / install / sed -i writing ONTO a system path
// (`/etc`, `/boot`, `/usr`, `/bin`, `/sbin`, `/lib*`, `/dev/*`). User rc/startup
// files (`~/.bashrc`) are NOT included (owner D1.1) — system paths only, so a
// narrowed SYS_PATH that drops the home-dir rc branch is used here.
const SYS_FILE =
  "(?:/(?:etc|boot|usr|bin|sbin|lib[^/\\s]*)(?:/\\S*)?|/dev/\\S+)";
const OVERWRITE_SYSTEM_FILES: string[] = [
  `.* ?>>? ?${SYS_FILE}(?: .*)?`,
  `${CMD}(?:tee|truncate)(?: \\S+)* ${SYS_FILE}(?: .*)?`,
  `${CMD}(?:cp|mv|install)(?: \\S+)+ ${SYS_FILE}(?: .*)?`,
  `${CMD}ln(?: \\S+)* -[a-zA-Z]*s[a-zA-Z]*f?[a-zA-Z]*(?: \\S+)* ${SYS_FILE}(?: .*)?`,
  `${CMD}ln(?: \\S+)* -[a-zA-Z]*f[a-zA-Z]*s?[a-zA-Z]*(?: \\S+)* ${SYS_FILE}(?: .*)?`,
  `${CMD}sed(?: \\S+)* -[a-zA-Z]*i\\S*(?: \\S+)* ${SYS_FILE}(?: .*)?`,
];

// §9.3 — the standard-stream and terminal DEVICE files are NOT system files.
// A target that is EXACTLY one of these is not an `overwrite-system-files` hit
// (so `ls 2>/dev/null`, `cat x > /dev/null`, `echo hi > /dev/stderr` flow). The
// decision is PER TARGET TOKEN (not a lookahead on the first operand): a segment
// with ANY non-exempt system target (`tee /dev/null /dev/sda`,
// `cp a /dev/null /etc/x`) is STILL a hit. `/dev/null/x`, `/dev/null/../sda`,
// `/dev/nullx`, `/dev/fd/3/../x`, `/dev/fd/../sda`, `/dev/sda`, `/etc/hosts`
// stay matched. Quotes are already stripped by `normalizeShell`, so
// `> "/dev/null"` is seen as `> /dev/null`.

/** The exact standard-stream / terminal device targets exempt from the
 * `overwrite-system-files` category. `/dev/fd/<digits>` is handled below. */
const DEV_STREAM_EXACT: ReadonlySet<string> = new Set<string>([
  "/dev/null",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
]);

/** True when a bare target token is EXACTLY an exempt device stream (no longer
 * path, no `..`, no trailing segment): one of the five fixed names, or
 * `/dev/fd/<digits>` with digits only. */
function isExemptDevStream(token: string): boolean {
  if (DEV_STREAM_EXACT.has(token)) return true;
  return /^\/dev\/fd\/[0-9]+$/.test(token);
}

/** Matches a system-file TARGET the `overwrite-system-files` patterns key on:
 * the narrowed system paths plus any `/dev/*` target. Used to walk a matched
 * segment per target token for the device-stream carve-out. Global so every
 * occurrence in the segment is examined. */
const SYS_FILE_TARGET_RE =
  /(?:\/(?:etc|boot|usr|bin|sbin|lib[^/\s]*)(?:\/\S*)?|\/dev\/\S+)/g;

/** Strip a leading shell redirection operator from a token so the bare target
 * is examined: `2>/dev/null` → `/dev/null`, `&>>/dev/stderr` → `/dev/stderr`,
 * `>/dev/null` → `/dev/null`. A token with no redirection prefix is unchanged. */
function stripRedirectPrefix(token: string): string {
  return token.replace(/^(?:&?[0-9]*>{1,2}&?|[0-9]*<)+/, "");
}

/**
 * Decide the `overwrite-system-files` carve-out for a NORMALIZED segment the
 * category patterns matched: find every system-file target token in the
 * segment; the hit stands if ANY such token is NOT an exempt device stream, and
 * is lifted only when there is at least one system-file target and EVERY one is
 * an exempt device stream. Returns true when the segment is still a hit.
 */
function overwriteSystemFilesStillHits(value: string): boolean {
  let sawSysTarget = false;
  for (const raw of value.split(" ")) {
    const bare = stripRedirectPrefix(raw);
    SYS_FILE_TARGET_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SYS_FILE_TARGET_RE.exec(bare)) !== null) {
      const target = m[0];
      sawSysTarget = true;
      if (!isExemptDevStream(target)) return true; // a non-exempt system target → still a hit
    }
  }
  // Every matched system target (if any) was an exempt device stream → not a hit.
  // If the regex found no bare target (a `/dev/*` fused to a redirect form the
  // token split did not separate), fail CLOSED: treat as a hit.
  return !sawSysTarget;
}

// ── fork-bomb ────────────────────────────────────────────────────────────────
// A leading benign wrapper run (`nohup`, `sudo`, `env FOO=1`, `timeout 5`) is
// absorbed by PRE so a wrapped fork bomb is still matched (owner D2c).
const FORK_BOMB: string[] = [
  `${PRE}: *\\(\\) *\\{.*`,
  `${PRE}(\\w+) *\\(\\) *\\{ *\\1\\b.*`,
];

// ── kill-all-processes ───────────────────────────────────────────────────────
// Signal every process: `kill -9 -1` / `kill -1 -1`, `killall5`, and a
// match-all `pkill` (`pkill -u root`, `pkill .`-style). A targeted kill of a
// real PID or a named `killall node` (always-ask, not never) is NOT matched.
const KILL_ALL: string[] = [
  `${CMD}kill(?: -(?:9|KILL|s KILL|SIGKILL|1|HUP))? -1(?: .*)?`,
  `${CMD}kill -(?:9|KILL|SIGKILL|1|HUP) -1(?: .*)?`,
  `${CMD}killall5(?: .*)?`,
  // pkill matching every process of a user (`-u root`) or a match-all pattern.
  `${CMD}pkill(?: \\S+)* -u root(?: .*)?`,
  `${CMD}pkill(?: \\S+)* (?:-[a-zA-Z]* )?\\.(?: .*)?`,
];

// ── power-state ──────────────────────────────────────────────────────────────
const POWER_STATE: string[] = [
  `${CMD}(?:shutdown|reboot|halt|poweroff)(?: .*)?`,
  `${CMD}init [06](?: .*)?`,
  `${CMD}systemctl(?: \\S+)* (?:poweroff|reboot|halt|kexec)(?: .*)?`,
];

// ── flush-firewall ───────────────────────────────────────────────────────────
// `iptables -F`/`--flush`, `ip6tables -F`, `nft flush ruleset`, `ufw reset`.
// `firewall-cmd --panic-on` is NOT included (owner D1.1).
const FLUSH_FIREWALL: string[] = [
  `${CMD}iptables(?: \\S+)* (?:-F|--flush)(?: .*)?`,
  `${CMD}ip6tables(?: \\S+)* (?:-F|--flush)(?: .*)?`,
  `${CMD}nft(?: \\S+)* flush ruleset(?: .*)?`,
  `${CMD}ufw reset(?: .*)?`,
];

/** The never-list categories, in a stable order. Each id is the `unlock` key.
 * `metadata-hosts` is NOT here — it is a URL/host category (not a shell command)
 * handled by `isMetadataHost` and the SSRF gate, but it IS an `unlock` id. */
export const NEVER_CATEGORIES: NeverCategory[] = [
  { id: "wipe-disk", description: "wipe a disk or filesystem (mkfs, wipefs, dd/shred to a block device, blkdiscard, fdisk/parted writes)", patterns: WIPE_DISK },
  { id: "delete-system-dirs", description: "recursively delete a filesystem root, home, or system directory (or use --no-preserve-root)", patterns: DELETE_SYSTEM_DIRS },
  { id: "overwrite-system-files", description: "overwrite files under system paths (/etc, /boot, /usr, /bin, /sbin, /lib*, /dev)", patterns: OVERWRITE_SYSTEM_FILES },
  { id: "fork-bomb", description: "run a fork bomb that exhausts system processes", patterns: FORK_BOMB },
  { id: "kill-all-processes", description: "kill every process (kill -1, killall5, match-all pkill)", patterns: KILL_ALL },
  { id: "power-state", description: "change the machine power state (shutdown, reboot, halt, poweroff, init 0/6)", patterns: POWER_STATE },
  { id: "flush-firewall", description: "flush or disable the firewall (iptables -F, nft flush ruleset, ufw reset)", patterns: FLUSH_FIREWALL },
];

/** The `metadata-hosts` never-list id (SSRF, URL-based; §9.3). Cloud-metadata
 * addresses are NEVER (denied) unless this id is in `unlock`, in which case they
 * fall back to the ordinary SSRF force-ask. */
export const METADATA_HOSTS_ID = "metadata-hosts";
export const METADATA_HOSTS_DESCRIPTION =
  "reach a cloud instance-metadata address (169.254.169.254, fd00:ec2::254, metadata.google.internal)";

/** Every valid never-list id, for the `unlock` unknown-id validation warning. */
export const NEVER_LIST_IDS: ReadonlySet<string> = new Set<string>([
  ...NEVER_CATEGORIES.map((c) => c.id),
  METADATA_HOSTS_ID,
]);

/** Cloud instance-metadata hostnames that are NEVER unless `metadata-hosts` is
 * unlocked (§9.3). An IPv4 literal (169.254.169.254) and IPv6 (fd00:ec2::254)
 * are detected numerically in the URL classifier; this covers the by-NAME forms
 * every major cloud publishes. Compared case-insensitively on the parsed host. */
const METADATA_HOST_NAMES: ReadonlySet<string> = new Set<string>([
  "metadata.google.internal",
  "metadata",
  "metadata.goog",
]);

/** True when a parsed host is a cloud-metadata address by NAME or by the two
 * literal IPs the cloud uses. The URL classifier already flags 169.254.169.254
 * (link-local) and fd00:ec2::254 (private) as force-ask; this narrows the
 * specific metadata endpoints to the stricter NEVER treatment (§9.3). */
export function isMetadataHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (METADATA_HOST_NAMES.has(h)) return true;
  if (h === "169.254.169.254") return true;
  // Normalize common IPv6 spellings of fd00:ec2::254 (AWS IMDS over IPv6).
  if (h === "fd00:ec2::254") return true;
  return false;
}

/** A never-list classification result against a single normalized segment. */
export interface NeverHit {
  id: string;
  description: string;
}

function anchored(pattern: string, value: string): boolean {
  const re = anchoredRegex(pattern);
  if (re === null) return false;
  // Scan in bounded overlapping windows so a long segment stays linear-cost
  // (owner D2d); a segment within one window is tested byte-for-byte.
  return windowScan(value, (w) => re.test(w));
}

/**
 * Classify one NORMALIZED command segment against the never list, honoring
 * `unlock`: a category whose id is in `unlocked` is skipped (it falls back to
 * the force-ask list). Returns the first matching category, or null. The caller
 * (`classifyCommand`) feeds every top-level segment, substitution, and pipeline
 * sink through here, so wrappers/substitutions cannot bypass it.
 */
export function classifyNeverSegment(value: string, unlocked: ReadonlySet<string>): NeverHit | null {
  for (const cat of NEVER_CATEGORIES) {
    if (unlocked.has(cat.id)) continue;
    if (cat.patterns.some((p) => anchored(p, value))) {
      // §9.3 — the `overwrite-system-files` category exempts the standard-stream
      // and terminal device targets, decided PER TARGET TOKEN. A matched segment
      // whose every system-file target is an exempt device stream is not a hit;
      // any non-exempt system target still is.
      if (cat.id === "overwrite-system-files" && !overwriteSystemFilesStillHits(value)) {
        continue;
      }
      return { id: cat.id, description: cat.description };
    }
  }
  return null;
}

/** The Guardian's deny sentence for a never-list hit (owner D1.3). */
export function neverListDenyReason(hit: NeverHit): string {
  return `blocked: ${hit.description} (never list: ${hit.id}; add "${hit.id}" to "unlock" in your global config to lift)`;
}

/** The host-readable never-list view surfaced on the facade (`config.neverList()`),
 * for the later `/access` and `doctor` (owner D1.2). Includes `metadata-hosts`. */
export function neverListView(
  unlock: readonly string[],
): Array<{ id: string; description: string; unlocked: boolean }> {
  const unlocked = new Set(unlock);
  const rows = NEVER_CATEGORIES.map((c) => ({
    id: c.id,
    description: c.description,
    unlocked: unlocked.has(c.id),
  }));
  rows.push({
    id: METADATA_HOSTS_ID,
    description: METADATA_HOSTS_DESCRIPTION,
    unlocked: unlocked.has(METADATA_HOSTS_ID),
  });
  return rows;
}
