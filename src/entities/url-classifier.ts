/**
 * URL classification for the `web_fetch` SSRF force-ask (core-blueprint.md §8.2,
 * §9.3 last paragraph, §15.1#5).
 *
 * A pure entity — no I/O, no DNS, no network. It answers one question: does a
 * URL (or a bare host/IP resolved at fetch time) point into a private, loopback,
 * link-local, metadata, unspecified, CGNAT, or IPv4-mapped range that must be
 * force-asked regardless of policy rules, a plan scope, or a fan-out grant
 * (§9.3)? Only an explicit deny blocks it outright; the force-ask itself is
 * never auto-skippable.
 *
 * The host is normalized with the WHATWG `URL` parser FIRST and the PARSED host
 * is classified — never the raw string — so userinfo tricks
 * (`http://evil.com@127.0.0.1/`), percent-encoding, IDN, and bracketed IPv6 are
 * resolved before classification. Obfuscated IPv4 forms an attacker uses
 * (decimal `2130706433`, hex `0x7f000001`, octal `0177.0.0.1`, short `127.1`)
 * are decoded here too, because the WHATWG parser itself canonicalizes most of
 * them and this entity decodes the remainder.
 *
 * The adapter calls `classifyHost` again on every DNS-resolved address and on
 * every redirect hop, so a public name that resolves to a private IP
 * (DNS-rebinding) and a redirect that crosses the boundary are both caught.
 */

/** The verdict for a URL or host. */
export interface UrlClassification {
  /** `force-ask` → immune to grants/allow/plan-scope (§9.3); `reject` →
   * structurally refused (a bad scheme); `allow` → an ordinary public URL that
   * still passes the gate's normal rules. */
  verdict: "allow" | "force-ask" | "reject";
  /** A short machine reason for the verdict (e.g. `loopback`, `scheme`). */
  reason: string;
}

/** The only schemes `web_fetch` will fetch (§8.2). Everything else is rejected
 * structurally — never executed — before any network or classification runs. */
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** Classify a full URL string: scheme first, then the parsed host (§8.2, §9.3). */
export function classifyUrl(raw: string): UrlClassification {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { verdict: "reject", reason: "unparseable-url" };
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return { verdict: "reject", reason: `scheme:${url.protocol.replace(":", "")}` };
  }
  // Classify the PARSED host — the WHATWG parser has already stripped userinfo,
  // decoded percent-encoding, applied IDN/punycode, and unwrapped IPv6 brackets.
  return classifyHost(url.hostname);
}

/**
 * Classify a bare host or IP (the parsed `URL.hostname`, a DNS-resolved address,
 * or a redirect target). Returns `force-ask` for any non-public range; `allow`
 * for an ordinary public name/address.
 */
export function classifyHost(hostname: string): UrlClassification {
  const host = normalizeHost(hostname);

  // Loopback / metadata by name.
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { verdict: "force-ask", reason: "loopback-name" };
  }

  const ipv4 = parseIpv4(host);
  if (ipv4 !== null) return classifyIpv4(ipv4);

  const ipv6 = parseIpv6(host);
  if (ipv6 !== null) return classifyIpv6(ipv6, host);

  // A resolvable public name: ordinary. (DNS resolution re-checks the address
  // at fetch time; this is the name-shaped host that is not an IP literal.)
  return { verdict: "allow", reason: "public" };
}

/** Lowercase, drop a trailing dot, and unwrap IPv6 brackets (`[::1]` → `::1`). */
export function normalizeHost(hostname: string): string {
  let h = hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/**
 * Parse an IPv4 host — dotted-quad plus the obfuscated forms the WHATWG parser
 * does not already canonicalize in every environment: decimal (`2130706433`),
 * hex (`0x7f000001`), octal (`0177.0.0.1`), and short (`127.1`). Returns the
 * 32-bit address as a number, or null when the host is not an IPv4 literal.
 */
export function parseIpv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length === 0 || parts.length > 4) return null;

  // Each part may be decimal, 0x-hex, or 0-octal. The last part absorbs the
  // remaining bytes (so `127.1` → 127.0.0.1, `2130706433` → one 32-bit part).
  const nums: number[] = [];
  for (const p of parts) {
    const n = parseIntPart(p);
    if (n === null) return null;
    nums.push(n);
  }

  const n = nums.length;
  // Validate each leading part is a single byte; the final part fills the rest.
  for (let i = 0; i < n - 1; i++) {
    if (nums[i]! > 0xff) return null;
  }
  const maxLast = Math.pow(256, 4 - n);
  if (nums[n - 1]! >= maxLast * 256 || nums[n - 1]! < 0) return null;

  let addr = 0;
  for (let i = 0; i < n - 1; i++) addr += nums[i]! * Math.pow(256, 3 - i);
  addr += nums[n - 1]!;
  if (addr < 0 || addr > 0xffffffff) return null;
  return addr >>> 0;
}

/** Parse one IPv4 part as decimal, hex (`0x…`), or octal (`0…`). */
function parseIntPart(p: string): number | null {
  if (p === "") return null;
  let value: number;
  if (/^0[xX][0-9a-fA-F]+$/.test(p)) value = parseInt(p.slice(2), 16);
  else if (/^0[0-7]+$/.test(p)) value = parseInt(p.slice(1), 8);
  else if (/^0$/.test(p)) value = 0;
  else if (/^[1-9][0-9]*$/.test(p)) value = parseInt(p, 10);
  else return null;
  return Number.isFinite(value) ? value : null;
}

/** Classify a 32-bit IPv4 address against the non-public ranges (§8.2, §9.3). */
function classifyIpv4(addr: number): UrlClassification {
  const a = (addr >>> 24) & 0xff;
  const b = (addr >>> 16) & 0xff;

  if (addr === 0) return { verdict: "force-ask", reason: "unspecified" };
  if (a === 0) return { verdict: "force-ask", reason: "this-network" };
  if (a === 127) return { verdict: "force-ask", reason: "loopback" };
  if (a === 10) return { verdict: "force-ask", reason: "private" };
  if (a === 172 && b >= 16 && b <= 31) return { verdict: "force-ask", reason: "private" };
  if (a === 192 && b === 168) return { verdict: "force-ask", reason: "private" };
  // Link-local, incl. the cloud metadata address 169.254.169.254.
  if (a === 169 && b === 254) return { verdict: "force-ask", reason: "link-local" };
  // Carrier-grade NAT 100.64.0.0/10.
  if (a === 100 && b >= 64 && b <= 127) return { verdict: "force-ask", reason: "cgnat" };
  return { verdict: "allow", reason: "public" };
}

/**
 * Parse an IPv6 literal into its eight 16-bit groups, handling `::` elision and
 * an embedded IPv4 tail (`::ffff:127.0.0.1`). Returns null when not IPv6.
 */
export function parseIpv6(host: string): number[] | null {
  if (!host.includes(":")) return null;
  let s = host;
  // An embedded IPv4 tail: expand it to two hex groups.
  const v4Tail = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Tail) {
    const v4 = parseIpv4(v4Tail[1]!);
    if (v4 === null) return null;
    const hi = (v4 >>> 16) & 0xffff;
    const lo = v4 & 0xffff;
    s = s.slice(0, v4Tail.index) + hi.toString(16) + ":" + lo.toString(16);
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };

  const head = parseGroups(halves[0]!);
  if (head === null) return null;
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const tail = parseGroups(halves[1]!);
  if (tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/** Classify an eight-group IPv6 address against the non-public ranges. */
function classifyIpv6(groups: number[], host: string): UrlClassification {
  // Unspecified ::
  if (groups.every((g) => g === 0)) return { verdict: "force-ask", reason: "unspecified" };
  // Loopback ::1
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
    return { verdict: "force-ask", reason: "loopback" };
  }
  // IPv4-mapped ::ffff:a.b.c.d — classify the embedded IPv4.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const v4 = ((groups[6]! << 16) | groups[7]!) >>> 0;
    const inner = classifyIpv4(v4);
    return inner.verdict === "allow"
      ? inner
      : { verdict: "force-ask", reason: `v4-mapped-${inner.reason}` };
  }
  // Unique-local fc00::/7 (first byte 0xfc or 0xfd).
  const firstByte = (groups[0]! >>> 8) & 0xff;
  if (firstByte === 0xfc || firstByte === 0xfd) return { verdict: "force-ask", reason: "private" };
  // Link-local fe80::/10.
  if ((groups[0]! & 0xffc0) === 0xfe80) return { verdict: "force-ask", reason: "link-local" };
  void host;
  return { verdict: "allow", reason: "public" };
}
