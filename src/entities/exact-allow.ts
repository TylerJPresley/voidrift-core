/**
 * Exact allow rules that LIFT an always-ask (force-ask) class (core-blueprint.md
 * §9.3; owner D2a). TODAY a force-ask class can never be satisfied by an allow
 * rule. This entity adds the ONE narrow exception: a force-ask is lifted ONLY by
 * an allow rule that is EXACT.
 *
 * Two shapes, both optional on `PermissionRule` (§13.2):
 *   - `exact: true` + `pattern`: `pattern` is a LITERAL string with NO glob
 *     interpretation (a `*` in it is just a character), matched by STRING
 *     EQUALITY against the call's match value after trimming SURROUNDING
 *     whitespace only (no case folding, no other normalization). The match value
 *     is tool-specific: the whole command string for `execute_command`,
 *     `<package>@<version>` for `plugins_install`, and the URL HOST (exact
 *     hostname or IP literal, lower-cased by the URL parser, port ignored) for
 *     `web_fetch`/`web_search`.
 *   - `cidr`: a CIDR range (IPv4 or IPv6) for the network tools only — a call's
 *     IP-literal host (or a resolved private address, where exposed) must fall
 *     inside the range.
 *
 * COMPOUND COMMANDS (owner D2a.3): an exact shell rule equals the WHOLE command
 * string, so appending anything (`; rm -rf x`, `&& curl …`) changes the match
 * value and no longer matches. The never list is still evaluated first on every
 * segment (that happens in `guardian.evaluate` before any lift), so a lifted
 * command is still blocked if any segment is on the never list.
 *
 * A non-exact rule (any glob, any wildcard tool glob, `tool: '*'`) NEVER lifts a
 * force-ask. Cloud-metadata addresses are a code-level NEVER and are denied
 * before any lift is consulted. A deny rule anywhere still wins (checked in
 * `guardian.evaluate` ahead of the lift).
 */
import { parseIpv4, parseIpv6, normalizeHost } from "./url-classifier.js";
import type { PermissionRule } from "../config/schema.js";

/** The network tools a `cidr` rule may name (owner D2a.1b). */
export const NETWORK_TOOLS: ReadonlySet<string> = new Set(["web_fetch", "web_search"]);

/** The minimum prefix length a CIDR rule may carry (owner D2a.1b): a range
 * broader than /8 (IPv4) or /16 (IPv6) is rejected so a rule cannot lift a huge
 * swath of the address space. `0.0.0.0/0` and `::/0` are rejected outright. */
const MIN_PREFIX_V4 = 8;
const MIN_PREFIX_V6 = 16;

/** A parsed, validated CIDR range. */
export interface ParsedCidr {
  version: 4 | 6;
  /** The network address as bytes (4 for v4, 16 for v6). */
  bytes: number[];
  prefix: number;
}

/**
 * Validate and parse a CIDR string STRICTLY (owner D2a.1b). Returns the parsed
 * range or an error string naming the problem. Rejects: a malformed string, a
 * missing/out-of-range prefix, host bits set outside the prefix, `0.0.0.0/0`,
 * `::/0`, and a prefix shorter than /8 (IPv4) or /16 (IPv6).
 */
export function validateCidr(raw: string): { cidr: ParsedCidr } | { error: string } {
  if (typeof raw !== "string" || raw.trim() !== raw || raw === "") {
    return { error: "cidr must be a non-empty string with no surrounding whitespace" };
  }
  const slash = raw.lastIndexOf("/");
  if (slash < 0) return { error: "cidr must be in address/prefix form" };
  const addrPart = raw.slice(0, slash);
  const prefixPart = raw.slice(slash + 1);
  if (!/^[0-9]+$/.test(prefixPart)) return { error: "cidr prefix must be a number" };
  const prefix = Number(prefixPart);

  // IPv4 first (no colon), else IPv6.
  if (!addrPart.includes(":")) {
    const addr = parseIpv4(normalizeHost(addrPart));
    if (addr === null) return { error: `cidr address "${addrPart}" is not a valid IPv4 literal` };
    if (prefix < 0 || prefix > 32) return { error: "cidr IPv4 prefix must be 0–32" };
    if (prefix === 0) return { error: "cidr 0.0.0.0/0 is too broad" };
    if (prefix < MIN_PREFIX_V4) return { error: `cidr IPv4 prefix must be at least /${MIN_PREFIX_V4}` };
    const bytes = [(addr >>> 24) & 0xff, (addr >>> 16) & 0xff, (addr >>> 8) & 0xff, addr & 0xff];
    if (hasHostBits(bytes, prefix)) return { error: "cidr has host bits set below the prefix" };
    return { cidr: { version: 4, bytes, prefix } };
  }

  const groups = parseIpv6(normalizeHost(addrPart));
  if (groups === null) return { error: `cidr address "${addrPart}" is not a valid IPv6 literal` };
  if (prefix < 0 || prefix > 128) return { error: "cidr IPv6 prefix must be 0–128" };
  if (prefix === 0) return { error: "cidr ::/0 is too broad" };
  if (prefix < MIN_PREFIX_V6) return { error: `cidr IPv6 prefix must be at least /${MIN_PREFIX_V6}` };
  const bytes: number[] = [];
  for (const g of groups) {
    bytes.push((g >>> 8) & 0xff, g & 0xff);
  }
  if (hasHostBits(bytes, prefix)) return { error: "cidr has host bits set below the prefix" };
  return { cidr: { version: 6, bytes, prefix } };
}

/** True when any bit below `prefix` is set in `bytes` (a non-canonical network). */
function hasHostBits(bytes: number[], prefix: number): boolean {
  for (let i = 0; i < bytes.length; i++) {
    const bitsBefore = i * 8;
    if (bitsBefore >= prefix) {
      if (bytes[i] !== 0) return true;
      continue;
    }
    const bitsInByte = Math.min(8, prefix - bitsBefore);
    if (bitsInByte >= 8) continue;
    const hostMask = 0xff >> bitsInByte; // low (8 - bitsInByte) bits
    if ((bytes[i]! & hostMask) !== 0) return true;
  }
  return false;
}

/** Parse a host string to its address bytes, or null when it is not an IP
 * literal. IPv4-mapped IPv6 (`::ffff:1.2.3.4`) parses as IPv6 bytes; a v4 rule
 * also matches its embedded v4 (handled in `cidrContainsHost`). */
function hostToBytes(host: string): { version: 4 | 6; bytes: number[] } | null {
  const h = normalizeHost(host);
  const v4 = parseIpv4(h);
  if (v4 !== null) return { version: 4, bytes: [(v4 >>> 24) & 0xff, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff] };
  const v6 = parseIpv6(h);
  if (v6 !== null) {
    const bytes: number[] = [];
    for (const g of v6) bytes.push((g >>> 8) & 0xff, g & 0xff);
    return { version: 6, bytes };
  }
  return null;
}

/** True when `prefix` bits of `a` and `b` (same length byte arrays) are equal. */
function prefixEqual(a: number[], b: number[], prefix: number): boolean {
  let bits = prefix;
  for (let i = 0; i < a.length && bits > 0; i++) {
    if (bits >= 8) {
      if (a[i] !== b[i]) return false;
      bits -= 8;
    } else {
      const mask = (0xff << (8 - bits)) & 0xff;
      if ((a[i]! & mask) !== (b[i]! & mask)) return false;
      bits = 0;
    }
  }
  return true;
}

/** True when the IP-literal `host` falls inside the CIDR range. A v4 host is
 * also tested against a v4 range mapped into an IPv4-mapped IPv6 range and vice
 * versa, so `::ffff:a.b.c.d` and `a.b.c.d` compare consistently. A non-IP host
 * (a name) never matches a CIDR. */
export function cidrContainsHost(cidr: ParsedCidr, host: string): boolean {
  const parsed = hostToBytes(host);
  if (!parsed) return false;
  // Normalize both sides to the CIDR's version, mapping IPv4-mapped IPv6.
  const hostBytes = toVersion(parsed, cidr.version);
  if (!hostBytes) return false;
  return prefixEqual(cidr.bytes, hostBytes, cidr.prefix);
}

/** Coerce an address to the target IP version, unwrapping an IPv4-mapped IPv6
 * host to IPv4 (and refusing a cross-version compare otherwise). */
function toVersion(parsed: { version: 4 | 6; bytes: number[] }, target: 4 | 6): number[] | null {
  if (parsed.version === target) return parsed.bytes;
  if (target === 4 && parsed.version === 6) {
    // IPv4-mapped ::ffff:a.b.c.d → the last 4 bytes, when the first 10 are 0 and
    // bytes 10–11 are 0xff.
    const b = parsed.bytes;
    const mappedPrefixZero = b.slice(0, 10).every((x) => x === 0);
    if (mappedPrefixZero && b[10] === 0xff && b[11] === 0xff) return b.slice(12);
    return null;
  }
  if (target === 6 && parsed.version === 4) {
    // Map an IPv4 into ::ffff:a.b.c.d so a v6 range can contain it.
    return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...parsed.bytes];
  }
  return null;
}

/**
 * The match value an EXACT rule tests for a call, by tool (owner D2a.1a):
 *   - `execute_command`: the whole command string (trimmed).
 *   - `plugins_install`: `<package>@<version>` (the install gate supplies `name`
 *     already shaped as `name@version`).
 *   - `web_fetch`/`web_search`: the URL HOST, lower-cased, port ignored.
 * Returns null when there is no meaningful exact value for the tool/args.
 */
export function exactMatchValue(tool: string, args: Record<string, unknown>): string | null {
  if (tool === "execute_command" || tool === "wait") {
    const c = args["command"];
    return typeof c === "string" ? c.trim() : null;
  }
  if (tool === "write_file" || tool === "edit_file") {
    // owner S1 — a control-file force-ask on a file tool is lifted by an exact
    // rule whose value is the NORMALIZED path (backslash-folded, `.`/`..`
    // collapsed, leading `./` stripped) so the saved rule and later calls match
    // regardless of harmless spelling differences.
    const p = args["path"];
    return typeof p === "string" ? normalizePathValue(p) : null;
  }
  if (tool === "plugins_install") {
    const n = args["name"];
    return typeof n === "string" ? n.trim() : null;
  }
  if (tool === "web_fetch") {
    const u = args["url"];
    return typeof u === "string" ? urlHost(u) : null;
  }
  if (tool === "web_search") {
    const e = args["webSearchEndpoint"];
    return typeof e === "string" && e !== "" ? urlHost(e) : null;
  }
  return null;
}

/** Normalize a file-tool path to a canonical relative string for exact match:
 * fold backslashes, collapse `.`/`..` segments, strip a leading `./`. A trailing
 * slash is removed. Keeps an absolute leading `/`. */
function normalizePathValue(raw: string): string {
  const abs = raw.replace(/\\/g, "/").trim().startsWith("/");
  const segs: string[] = [];
  for (const seg of raw.replace(/\\/g, "/").trim().split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      segs.pop();
      continue;
    }
    segs.push(seg);
  }
  return (abs ? "/" : "") + segs.join("/");
}

/** The lower-cased host of a URL (port ignored), or null when unparseable. */
function urlHost(raw: string): string | null {
  try {
    return normalizeHost(new URL(raw).hostname);
  } catch {
    return null;
  }
}

/**
 * Is a force-ask LIFTED by an EXACT allow rule (owner D2a.2)? Returns true when
 * at least one allow rule in `rules` is an exact or cidr rule that matches this
 * call for its force-ask kind. The caller (`guardian.evaluate`) has already:
 *   - evaluated and cleared the NEVER list (metadata, never-list categories),
 *   - confirmed no deny rule matches (deny wins).
 * So this function only decides whether an exact allow turns the force-ask into
 * an ordinary allow. `forceAskKind` picks the eligible tools:
 *   - `shell`         → an exact `execute_command` rule, whole command equal.
 *   - `plugin-install`→ an exact `plugins_install` rule, `name@version` equal.
 *   - `ssrf`          → an exact host rule OR a matching `cidr` rule on a
 *                        network tool.
 * A non-exact/non-cidr allow (any glob, `tool: '*'`) NEVER lifts.
 */
export function forceAskLiftedByExact(
  call: { tool: string; args: Record<string, unknown> },
  rules: readonly PermissionRule[],
  forceAskKind: "shell" | "ssrf" | "plugin-install" | "control-file" | "outside-workspace",
): boolean {
  return exactLiftRule(call, rules, forceAskKind) !== null;
}

/**
 * The exact/cidr allow RULE that lifts this force-ask, or null (owner D2c). Same
 * logic as `forceAskLiftedByExact` but returns the rule so the decision point
 * can name WHY no prompt appeared (`allowed by exact rule …`). No secret value
 * is carried — the caller derives a non-secret id (source + tool + pattern).
 */
export function exactLiftRule(
  call: { tool: string; args: Record<string, unknown> },
  rules: readonly PermissionRule[],
  forceAskKind: "shell" | "ssrf" | "plugin-install" | "control-file" | "outside-workspace",
): PermissionRule | null {
  const value = exactMatchValue(call.tool, call.args);
  for (const r of rules) {
    if (r.decision !== "allow") continue;
    if (forceAskKind === "ssrf") {
      if (r.cidr !== undefined && NETWORK_TOOLS.has(r.tool) && r.tool === call.tool) {
        const validated = validateCidr(r.cidr);
        if ("cidr" in validated && value !== null && cidrContainsHost(validated.cidr, value)) {
          return r;
        }
      }
    }
    if (r.exact === true && r.pattern !== undefined && r.tool === call.tool) {
      if (value !== null && r.pattern.trim() === value) return r;
    }
  }
  return null;
}

/**
 * Is a HOST (an IP literal or the parsed hostname) allowed by an EXACT host rule
 * or a matching `cidr` rule on a network tool (owner D2a)? Used by the
 * `web_fetch` executor's defensive SSRF re-check so an exactly-allowed loopback/
 * private host (and each of its resolved private addresses) is FETCHED rather
 * than refused — matching the Guardian lift. A non-exact/non-cidr allow never
 * counts, and a metadata address is denied earlier so it never reaches here.
 */
export function hostAllowedByExact(host: string, rules: readonly PermissionRule[]): boolean {
  const h = normalizeHost(host);
  for (const r of rules) {
    if (r.decision !== "allow" || !NETWORK_TOOLS.has(r.tool)) continue;
    if (r.cidr !== undefined) {
      const v = validateCidr(r.cidr);
      if ("cidr" in v && cidrContainsHost(v.cidr, h)) return true;
    }
    if (r.exact === true && r.pattern !== undefined && r.pattern.trim() === h) return true;
  }
  return false;
}
