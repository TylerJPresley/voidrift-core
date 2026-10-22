/**
 * The HTTP port (core-blueprint.md §8.2, §8.5).
 *
 * `web_fetch` reaches the network only through this seam, so the SSRF controls
 * (DNS re-check, per-hop redirect re-validation, size/timeout/content-type
 * limits) are driven by the pure use-case and tested OFFLINE with a fake port
 * and a fake resolver. The real adapter uses Node's global `fetch` (undici) and
 * `dns.lookup` — no new dependency. Redirects are handled MANUALLY by the
 * use-case (the port fetches a single hop with redirects disabled), so every
 * `Location` is re-classified before it is followed (§8.2).
 */

/** A resolved DNS answer: the addresses a hostname maps to right now (§8.2). */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** One single-hop HTTP response (redirects NOT followed by the adapter). */
export interface HttpResponse {
  status: number;
  /** The `Location` header when the status is a redirect (3xx), else null. */
  location: string | null;
  /** The `Content-Type` header, lowercased, sans parameters, or null. */
  contentType: string | null;
  /**
   * Stream the body as byte chunks until `maxBytes` is reached, then stop
   * reading (the limit is enforced MID-STREAM, never by buffering unbounded).
   * Returns the collected bytes (≤ maxBytes) and whether the body was truncated.
   */
  readBodyCapped(maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }>;
}

/** The one-hop fetch request the use-case issues (§8.2). */
export interface HttpRequest {
  url: string;
  timeoutMs: number;
  /** The fixed, non-secret User-Agent (§8.2); no cookies/credentials are sent. */
  userAgent: string;
  /**
   * The HTTP method. Defaults to `GET` when absent, so `web_fetch` and the GET
   * search providers (`duckduckgo`, `searxng`, `brave`) are unchanged; `tavily`
   * issues a `POST` with a JSON body (§8.5). The adapter still disables
   * redirects, sends the pinned address, and bounds the request by the timeout.
   */
  method?: "GET" | "POST";
  /**
   * Extra request headers the search providers need (§8.5): `brave` sends
   * `X-Subscription-Token`, `tavily` sends `Authorization: Bearer …`. The value
   * is a resolved secret read from `process.env[apiKeyEnv]` — never persisted,
   * logged, or placed in the model context (§10.10). Absent for `web_fetch`.
   */
  headers?: Record<string, string>;
  /** A request body (for `POST`); a JSON string for `tavily` (§8.5). */
  body?: string;
  /** The `Content-Type` for the body (e.g. `application/json`). */
  contentType?: string;
  /**
   * The address the use-case already resolved AND vetted against the SSRF
   * ranges. The adapter MUST connect to THIS address rather than re-resolving
   * the hostname, closing the DNS-rebinding TOCTOU (a rebinding host that
   * answers a public IP to `resolve()` and a private IP on connect, §8.2). The
   * hostname is still used for the TLS SNI / `Host` header; only the connected
   * IP is pinned. When absent (public hosts a test does not pin), the adapter
   * falls back to normal resolution.
   */
  pinnedAddress?: string;
  /** The address family of `pinnedAddress` (4 or 6). */
  pinnedFamily?: 4 | 6;
}

export interface HttpPort {
  /** Resolve a hostname to its current addresses, so the use-case can re-check
   * each against the SSRF ranges (DNS-rebinding defense, §8.2). */
  resolve(hostname: string): Promise<ResolvedAddress[]>;
  /** Fetch a SINGLE hop with redirects disabled, no cookies, a fixed UA, and a
   * timeout. The use-case follows redirects itself, re-classifying each. */
  fetchOnce(req: HttpRequest): Promise<HttpResponse>;
}
