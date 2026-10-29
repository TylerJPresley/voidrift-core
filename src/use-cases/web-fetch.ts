/**
 * The `web_fetch` use-case (core-blueprint.md §8.2, §9.3, §1 rule 15, §4.5).
 *
 * Fetches a URL, extracts readable content, caches it, and returns an inline
 * preview or a cache-path handle. All SSRF controls live here over the
 * `HttpPort` seam so the whole flow is tested offline:
 *   - scheme allow-list (http/https only) via `classifyUrl` (bad scheme → error);
 *   - PARSED-host classification (loopback/private/link-local/metadata/… →
 *     force-ask handled at the gate, §9.3; this use-case runs only AFTER the
 *     gate has allowed the call, so it defensively re-checks and refuses too);
 *   - DNS re-check: resolve the host and re-classify every address, so a public
 *     name resolving to a private IP (DNS-rebinding) is refused;
 *   - per-hop redirect re-validation: redirects are followed manually with a hop
 *     limit, each `Location` re-classified AND re-resolved before it is followed;
 *   - content-type allow-list (text/html, text/plain, application/json);
 *   - response-body size cap enforced mid-stream;
 *   - request timeout; no cookies/credentials; a fixed non-secret User-Agent.
 *
 * Readability extraction uses `@mozilla/readability` over a `linkedom` DOM, with
 * a regex tag-stripper fallback when extraction yields < 200 chars or parsing
 * fails (§8.2). The result is masked by the ONE secret detector (§10.10) and
 * written to `.voidrift/cache/web/<md5-12>.md`; the registry marks it `cached`
 * (§4.5). This is a pure orchestration module — the port does the I/O.
 */
import { createHash } from "node:crypto";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { classifyUrl, classifyHost } from "../entities/url-classifier.js";
import { isMetadataHost, METADATA_HOSTS_ID } from "../entities/never-list.js";
import { stripUnsafeCharsKeepWhitespace } from "../entities/untrusted-text.js";
import type { HttpPort } from "../entities/ports/http-port.js";
import { limitDefault } from "../entities/limits.js";
import { limitMarker, type LimitsPort } from "../entities/ports/limits-port.js";

/** The fixed, non-secret User-Agent `web_fetch` sends (§8.2). */
export const WEB_FETCH_USER_AGENT = "VoidRift-web_fetch/1";

/** True when the URL's host is exactly allowed (owner D2a) — the parsed host
 * fed to the injected `allowHost` predicate. Unparseable or no predicate → false
 * (refuse, the conservative default). */
function hostAllowed(rawUrl: string, deps: WebFetchDeps): boolean {
  if (!deps.allowHost) return false;
  try {
    return deps.allowHost(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

/** True when a host is a cloud-metadata address that must NEVER be fetched —
 * mirroring Guardian's `metadataNever` (owner D2c). A metadata host is
 * never-liftable by an exact/cidr `allowHost` rule: only the global/managed
 * `unlock` of `metadata-hosts` (threaded as `deps.metadataUnlocked`) drops it to
 * the ordinary SSRF path. Applied to the pre-resolution host, every resolved
 * address, and every redirect hop so a DNS-rebind or a redirect to a metadata
 * IP is refused even under a covering `cidr`/exact rule. */
function metadataBlocked(host: string, deps: WebFetchDeps): boolean {
  if (deps.metadataUnlocked) return false;
  return isMetadataHost(host);
}

/** The metadata category id surfaced if a fetch is refused for it. */
const METADATA_REFUSAL = `cloud instance-metadata address (never list: ${METADATA_HOSTS_ID})`;

/** Content types `web_fetch` will extract; anything else is refused (§8.2). */
const ALLOWED_CONTENT_TYPES = new Set(["text/html", "text/plain", "application/json"]);

/** The inline-preview and body-size numbers (§8.2, §13.11). `webFetchInlineMax`
 * (TOOL10) and the body cap (TOOL13) now live in the limits registry; the
 * preview and min-extract remain local defaults read via the registry too. */
export const WEB_FETCH_MIN_EXTRACT = limitDefault("tools.webFetchMinExtract");
/** The redirect hop limit (§8.2 manual redirect handling). */
export const WEB_FETCH_MAX_HOPS = limitDefault("tools.webFetchMaxHops");

/** The outcome the use-case returns: the model-facing text and the cache path. */
export interface WebFetchResult {
  status: "success" | "error";
  /** The model-facing text — inline content, or a preview + cache-path note. */
  content: string;
  /** The absolute cache path written, when a cache was written. */
  cachePath?: string;
  /** The final URL after redirects, for the document registry (`cached`). */
  finalUrl?: string;
  /** The full extracted text (unmasked length cap applied), for the cache file. */
  fullText?: string;
}

/** The deps the use-case reads (Clean Architecture: I/O behind ports). */
export interface WebFetchDeps {
  http: HttpPort;
  timeoutMs: number;
  /** Persist the cache file; returns its absolute path. Masking is applied to
   * the content BEFORE this is called. */
  writeCache: (relPath: string, content: string) => Promise<string>;
  /** The ONE secret detector (§10.10) over the extracted text. */
  mask: (text: string) => string;
  /** owner D2a — a host (or resolved IP literal) allowed by an EXACT host rule
   * or a matching `cidr` rule lifts the SSRF force-ask, so the defensive
   * re-check here must NOT refuse it. Consults the live config permissions.
   * Omitted → no host is exactly allowed (the pre-D2a behavior: refuse all
   * force-ask hosts). A metadata address is denied before this is consulted. */
  allowHost?: (host: string) => boolean;
  /** owner D2c — true only when the global/managed `unlock` contains
   * `metadata-hosts`. When false (the default), a cloud-metadata host is
   * never-liftable here: neither `allowHost` nor a covering `cidr`/exact rule
   * can let it through, closing the DNS-rebind/redirect metadata hole. */
  metadataUnlocked?: boolean;
  /** §13.11 — the limits port. When present, the inline/preview/body caps come
   * from the registry (`tools.webFetchInlineMax`, `tools.webFetchPreview`,
   * `tools.webFetchBodyMaxBytes`) and the inline→preview cut emits one
   * `LIMIT_HIT`. Absent → the registry defaults (byte-identical to the old
   * constants). */
  limits?: LimitsPort;
  /** §8.7/§4.8 — the LIVE available token budget (`ContextPipeline.availableBudget`)
   * for the fit test. Present only on the engine path; a worker omits it.
   * Absent → the fit test is skipped (never ingest; preview + handle instead). */
  availableTokens?: number;
  /** §8.7 — ingest ALREADY-READ page text to a rendered line-anchored digest.
   * Present only when the calling agent holds the `ingest` tool (the engine wires
   * `Ingest.runText`). When an oversized page does NOT fit `ingest.fitFraction`
   * of `availableTokens`, this is called and its digest is returned instead of a
   * preview. Absent → preview + handle. */
  ingestPage?: (text: string, purpose: string) => Promise<string>;
  /** The model's stated need for the page, used as the ingest `purpose`. The
   * `web_fetch` schema is `{ url }` only, so this defaults to the URL when the
   * caller has nothing better. */
  purpose?: string;
  /** §7.2/§14.6 — report one `BY_REFERENCE` event when an oversized page is
   * stored by reference (preview + handle). Optional. Never any content. */
  onByReference?: (info: { what: string; bytes: number; key: string }) => void;
}

/** The cache file path for a url: `.voidrift/cache/web/<first 12 hex of md5>.md`. */
export function webCachePath(url: string): string {
  const hex = createHash("md5").update(url, "utf8").digest("hex").slice(0, 12);
  return `.voidrift/cache/web/${hex}.md`;
}

/** Reduce HTML to readable text (Readability over linkedom, regex fallback).
 * `minExtract` is the live `tools.webFetchMinExtract` cap when threaded, else the
 * registry default (byte-identical to the former module constant). */
export function extractReadable(html: string, url: string, minExtract: number = WEB_FETCH_MIN_EXTRACT): string {
  let extracted = "";
  try {
    const { document } = parseHTML(html);
    const parsed = new Readability(
      document as unknown as ConstructorParameters<typeof Readability>[0],
    ).parse();
    extracted = (parsed?.textContent ?? "").trim();
  } catch {
    extracted = "";
  }
  if (extracted.length < minExtract) {
    extracted = stripTags(html);
  }
  void url;
  return extracted;
}

/** The regex tag-stripper fallback (§8.2). */
function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Run a `web_fetch`. The caller passes an already-gate-approved URL; this
 * defensively re-classifies, re-checks DNS, and re-validates every redirect
 * hop, so the SSRF boundary holds even if a caller bypasses the gate.
 */
export async function runWebFetch(url: string, deps: WebFetchDeps): Promise<WebFetchResult> {
  const first = classifyUrl(url);
  if (first.verdict === "reject") {
    return { status: "error", content: `Error: unsupported URL (${first.reason})` };
  }
  if (first.verdict === "force-ask" && !hostAllowed(url, deps)) {
    // Defensive: the gate force-asks these; reaching here means approval was
    // granted or the gate was bypassed. Refuse rather than fetch silently —
    // unless an EXACT host / cidr rule allows it (owner D2a), matching the lift.
    return { status: "error", content: `Error: refusing SSRF-range URL (${first.reason})` };
  }

  let current = url;
  let response: Awaited<ReturnType<HttpPort["fetchOnce"]>> | null = null;
  let finalUrl = url;

  // §13.11 — the live redirect-hop cap (`tools.webFetchMaxHops`), else default.
  const maxHops = deps.limits?.get("tools.webFetchMaxHops") ?? limitDefault("tools.webFetchMaxHops");

  for (let hop = 0; hop <= maxHops; hop++) {
    // Re-classify the current target (the initial URL, then each Location).
    const cls = classifyUrl(current);
    if (cls.verdict === "reject") {
      return { status: "error", content: `Error: redirect to unsupported URL (${cls.reason})` };
    }
    if (cls.verdict === "force-ask" && !hostAllowed(current, deps)) {
      return { status: "error", content: `Error: redirect into SSRF range (${cls.reason}) blocked` };
    }

    // DNS re-check: resolve the host and re-classify every address so a public
    // name that resolves to a private IP (DNS-rebinding) is refused. The first
    // vetted address is PINNED on connect, so the adapter cannot re-resolve to a
    // different (private) IP after this check (TOCTOU close, §8.2).
    const host = new URL(current).hostname;
    // owner D2c — a cloud-metadata host (by name or literal IP) is NEVER-liftable:
    // checked on the pre-resolution host of EVERY hop before `allowHost` is ever
    // consulted, so a project cidr/exact rule cannot fetch it.
    if (metadataBlocked(host, deps)) {
      return { status: "error", content: `Error: refusing ${METADATA_REFUSAL}` };
    }
    const addrs = await deps.http.resolve(host);
    if (addrs.length === 0) {
      return { status: "error", content: `Error: ${host} did not resolve` };
    }
    for (const a of addrs) {
      // owner D2c — a resolved metadata address (DNS rebind to 169.254.169.254 /
      // fd00:ec2::254) is refused BEFORE the allowHost lift, closing the rebind
      // hole where a public name maps to a metadata IP under a covering rule.
      if (metadataBlocked(a.address, deps)) {
        return { status: "error", content: `Error: ${host} resolves to a ${METADATA_REFUSAL} (${a.address}) — refused` };
      }
      const ac = classifyHost(a.address);
      // owner D2a — an exactly-allowed host whose resolved address is also
      // exactly allowed (by host or cidr) is NOT refused; otherwise a private
      // resolved address is a DNS-rebind refusal as before.
      if (ac.verdict === "force-ask" && !(deps.allowHost?.(host) && deps.allowHost(a.address))) {
        return { status: "error", content: `Error: ${host} resolves to a ${ac.reason} address (${a.address}) — refused` };
      }
    }
    const pin = addrs[0]!;

    response = await deps.http.fetchOnce({
      url: current,
      timeoutMs: deps.timeoutMs,
      userAgent: WEB_FETCH_USER_AGENT,
      pinnedAddress: pin.address,
      pinnedFamily: pin.family,
    });
    finalUrl = current;

    if (response.status >= 300 && response.status < 400) {
      if (hop === maxHops) {
        // §13.11 — `tools.webFetchMaxHops` is a `safety`/`deny` SSRF bound. Emit
        // EXACTLY ONE `LIMIT_HIT` and use its notice as the refusal message. We
        // consult the RESOLVED action for the event, but a configured `warn` does
        // NOT follow further hops: for a download-class hop cap `warn` is
        // documented unsafe (§13.11 action paragraph — relaxing an SSRF hop bound
        // re-opens the redirect-chase surface), so we keep refusing and only
        // record the resolved action on the hit.
        const hopAction = deps.limits?.action("tools.webFetchMaxHops") ?? "deny";
        void hopAction; // resolved action rides on the emitted hit, not the decision
        const hit = deps.limits?.hit("tools.webFetchMaxHops", maxHops, { what: `web_fetch exceeded the redirect-hop cap (> ${maxHops})` });
        const notice = hit?.notice ?? `too many redirects (> ${maxHops}) (limits.tools.webFetchMaxHops = ${maxHops})`;
        return { status: "error", content: `Error: ${notice}` };
      }
      if (!response.location) {
        return { status: "error", content: `Error: ${response.status} redirect with no Location` };
      }
      current = new URL(response.location, current).toString();
      continue;
    }
    break;
  }

  if (!response) return { status: "error", content: "Error: no response" };
  if (response.status < 200 || response.status >= 300) {
    return { status: "error", content: `Error: HTTP ${response.status}` };
  }

  const ct = response.contentType;
  if (!ct || !ALLOWED_CONTENT_TYPES.has(ct)) {
    return { status: "error", content: `Error: unsupported content-type (${ct ?? "none"})` };
  }

  // §13.11 — effective caps come from the limits registry via the port (TOOL10
  // inline, TOOL11 preview, TOOL13 body), else the registry defaults.
  const bodyMax = deps.limits?.get("tools.webFetchBodyMaxBytes") ?? limitDefault("tools.webFetchBodyMaxBytes");
  const inlineMax = deps.limits?.get("tools.webFetchInlineMax") ?? limitDefault("tools.webFetchInlineMax");
  const previewMax = deps.limits?.get("tools.webFetchPreview") ?? limitDefault("tools.webFetchPreview");

  // §13.11 — `tools.webFetchBodyMaxBytes` is a `safety`/`deny` DoS bound. The
  // port signals when it clipped the body mid-stream (`truncated`); do NOT drop
  // that flag. When the limits port is wired, honor the RESOLVED action: deny
  // (the declared default) refuses at the bound — the partial body is not used
  // and the tool returns its normal error-result shape with the one-line notice;
  // warn (if a layer overrides it) continues with the clipped body plus a marker.
  // Either path emits EXACTLY ONE `LIMIT_HIT` naming the key. With no port there
  // is no action to resolve and no event sink, so the legacy cap-and-continue
  // holds (the body is already bounded mid-stream).
  const { bytes, truncated } = await response.readBodyCapped(bodyMax);
  let bodyMarker = "";
  if (truncated && deps.limits) {
    const bodyAction = deps.limits.action("tools.webFetchBodyMaxBytes");
    const hit = deps.limits.hit("tools.webFetchBodyMaxBytes", bodyMax, { what: "web_fetch response body over the byte cap" });
    if (bodyAction === "deny") {
      const notice = hit?.notice ?? `web_fetch response body over the byte cap (limits.tools.webFetchBodyMaxBytes = ${bodyMax})`;
      return { status: "error", content: `Error: ${notice}` };
    }
    // warn: continue with the clipped body; the marker below names the key.
    bodyMarker = `\n\n${limitMarker("tools.webFetchBodyMaxBytes", bodyMax)}`;
  }
  const raw = new TextDecoder("utf-8").decode(bytes);
  const minExtract = deps.limits?.get("tools.webFetchMinExtract") ?? limitDefault("tools.webFetchMinExtract");
  const text = ct === "text/html" ? extractReadable(raw, finalUrl, minExtract) : raw.trim();
  const masked = deps.mask(stripUnsafeCharsKeepWhitespace(text)) + bodyMarker;

  const cacheRel = webCachePath(url);
  const cacheBody = `<!-- source: ${url} -->\n${masked}`;
  const cachePath = await deps.writeCache(cacheRel, cacheBody);

  let content: string;
  if (masked.length <= inlineMax) {
    content = masked;
  } else {
    // §13.11 — the page is over the inline threshold. The effective ACTION of the
    // governing bound decides what happens. `tools.webFetchInlineMax` and
    // `tools.webFetchPreview` are `warn` by default (the run continues, the full
    // text stays readable through the by-reference handle), but a layer may set
    // either to `deny`, which REFUSES at the bound. When the inline cap denies,
    // or (when the inline cap only warns) the preview cap denies, nothing is
    // delivered inline and the tool returns its normal error-result shape with the
    // one-line notice and EXACTLY ONE `LIMIT_HIT` whose `action` is `deny`.
    const inlineDenies = (deps.limits?.action("tools.webFetchInlineMax") ?? "warn") === "deny";
    const previewDenies = (deps.limits?.action("tools.webFetchPreview") ?? "warn") === "deny";
    if (inlineDenies || previewDenies) {
      const denyKey = inlineDenies ? "tools.webFetchInlineMax" : "tools.webFetchPreview";
      const hit = deps.limits?.hit(denyKey, masked.length, { what: "web_fetch page over the inline cap" });
      const notice = hit?.notice ?? `web_fetch page over the inline cap (${denyKey})`;
      return { status: "error", content: `Error: ${notice}` };
    }

    // §8.2/§8.7 — warn path. The FULL text is already cached on disk at `cacheRel`
    // (readable with `read_file`), so that path IS the handle — nothing is
    // duplicated. Emit one LIMIT_HIT + one BY_REFERENCE.
    const lines = masked === "" ? 0 : masked.split("\n").length;
    const bytes = Buffer.byteLength(masked, "utf8");
    deps.limits?.hit("tools.webFetchInlineMax", masked.length, { what: "web_fetch page over inline cap" });
    deps.onByReference?.({ what: "web_fetch page", bytes, key: "tools.webFetchInlineMax" });

    // §8.7 — if the caller can ingest AND the page does not fit the available
    // budget (`ingest.fitFraction` of `availableTokens`), return the page's
    // line-anchored DIGEST rather than a preview. The fit test uses the same
    // 4-chars/token estimate the Ingest use-case does.
    const fitFraction = deps.limits?.get("ingest.fitFraction") ?? limitDefault("ingest.fitFraction");
    const estTokens = Math.ceil(masked.length / 4);
    const fits = deps.availableTokens !== undefined && estTokens <= fitFraction * deps.availableTokens;
    if (deps.ingestPage && deps.availableTokens !== undefined && !fits) {
      const purpose = deps.purpose && deps.purpose.trim() !== "" ? deps.purpose : finalUrl;
      content = await deps.ingestPage(masked, purpose);
    } else {
      // Otherwise a bounded preview plus the handle to the full cached copy — a
      // ranged `read_file` (offset/limit) returns the rest, or `ingest` it.
      content =
        `${masked.slice(0, previewMax)}…\n\n` +
        `[Previewed ${previewMax} of ${masked.length} chars. ${limitMarker("tools.webFetchInlineMax", masked.length)}]\n` +
        `[full page: ${cacheRel} (${lines} lines) - read it in ranges with read_file offset/limit or call ingest]`;
    }
  }

  return { status: "success", content, cachePath, finalUrl, fullText: masked };
}
