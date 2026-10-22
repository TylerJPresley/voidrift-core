/**
 * The shared `web_fetch`/`web_search` tool builder (core-blueprint.md §8.2).
 *
 * `web_fetch` and `web_search` are READ tools (a public GET changes no state,
 * §3.1): they reach the network through the injected `HttpPort` seam, with the
 * SAME SSRF controls, DNS/redirect re-checks, timeout, and secret masking the
 * use-cases enforce. The decision point classifies the target URL (`web_fetch`)
 * or the CONFIGURED search endpoint (`web_search`, §13.9) at the ONE gate (§9.3),
 * so both the orchestrator's engine AND a dispatched worker bind these tools over
 * the SAME path by calling this ONE builder — nothing is copied (§15.1#4).
 *
 * The engine passes an `onCached` callback so a fetched document is registered in
 * its per-session document registry as trust `cached` (§4.5); a worker has no such
 * registry and omits it (the cache file is still written through the backend). The
 * `onSearchWarning` callback lets the caller emit `WARNING_EMITTED` on a search
 * fallback (§8.5).
 */
import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { LocalShellBackend } from "deepagents";
import type { HttpPort } from "../entities/ports/http-port.js";
import type { LimitsPort } from "../entities/ports/limits-port.js";
import type { WebSearchConfig } from "../config/schema.js";
import { runWebFetch } from "../use-cases/web-fetch.js";
import { runWebSearch, renderSearchResults, type ProviderHandler } from "../use-cases/web-search.js";
import { WEB_FETCH_SCHEMA, WEB_SEARCH_SCHEMA } from "./builtin.js";

/** The deps the shared web-tool builder reads (§8.2). */
export interface WebToolsDeps {
  /** The HTTP seam `web_fetch`/`web_search` reach the network through. */
  http: HttpPort;
  /** The backend the cache file is written through (rooted at the caller's tree). */
  backend: LocalShellBackend;
  /** The request timeout (ms) — `webFetchTimeoutMs` from config. */
  timeoutMs: number;
  /** The ONE secret detector (§10.10). */
  mask: (text: string) => string;
  /** The effective (cascaded) `web_search` config (§13.9). */
  resolveWebSearch: () => WebSearchConfig;
  /** owner D2a — the live exact/cidr host-allow predicate passed to the
   * `web_fetch` executor so an exactly-allowed private/loopback host is fetched
   * rather than refused (matching the Guardian lift). Omitted → none allowed. */
  allowHost?: (host: string) => boolean;
  /** owner D2c — true only when the global/managed `unlock` contains
   * `metadata-hosts`. Passed to the `web_fetch` executor so a metadata host is
   * never-liftable unless explicitly unlocked. Omitted → locked (the default). */
  metadataUnlocked?: boolean;
  /** Plugin-registered web-search providers merged over the built-ins (§8.5). */
  extraProviders?: () => Record<string, ProviderHandler>;
  /** Register a fetched document as trust `cached` (§4.5); omitted for a worker. */
  onCached?: (cachePath: string, fullText: string) => void;
  /** Emit a `{category:"fallback",source:"web"}` warning on a search fallback. */
  onSearchWarning?: () => void;
  /** §13.11 — the limits port; threaded into the web use-cases so their caps
   * come from the registry and emit `LIMIT_HIT`. Omitted → registry defaults. */
  limits?: LimitsPort;
  /** §8.7/§4.8 — the LIVE available token budget for the oversized-page fit test
   * (`ContextPipeline.availableBudget`). Omitted → the fit test is skipped. */
  availableTokens?: number;
  /** §8.7 — ingest oversized page text to a rendered digest (present only when
   * the calling agent holds the `ingest` tool). Omitted → preview + handle. */
  ingestPage?: (text: string, purpose: string) => Promise<string>;
  /** §7.2/§14.6 — report a `BY_REFERENCE` event when an oversized page is stored
   * by reference. Optional. */
  onByReference?: (info: { what: string; bytes: number; key: string }) => void;
}

/**
 * Build the `web_fetch` and `web_search` tools over the shared HttpPort path.
 * The caller filters to the names its agent's manifest lists; this returns both.
 */
export function buildWebTools(deps: WebToolsDeps): StructuredToolInterface[] {
  const { http, backend, timeoutMs, mask } = deps;
  const webFetch = tool(
    async ({ url }: { url: string }) => {
      const r = await runWebFetch(url, {
        http,
        timeoutMs,
        mask,
        ...(deps.limits ? { limits: deps.limits } : {}),
        ...(deps.allowHost ? { allowHost: deps.allowHost } : {}),
        ...(deps.metadataUnlocked !== undefined ? { metadataUnlocked: deps.metadataUnlocked } : {}),
        ...(deps.availableTokens !== undefined ? { availableTokens: deps.availableTokens } : {}),
        ...(deps.ingestPage ? { ingestPage: deps.ingestPage } : {}),
        ...(deps.onByReference ? { onByReference: deps.onByReference } : {}),
        writeCache: async (relPath, content) => {
          await backend.write(relPath, content);
          return relPath;
        },
      });
      if (r.status === "success" && r.cachePath && r.fullText !== undefined) {
        deps.onCached?.(r.cachePath, r.fullText);
      }
      return r.content;
    },
    { name: "web_fetch", description: "Fetch a URL, extract readable content, and cache it.", schema: WEB_FETCH_SCHEMA },
  ) as unknown as StructuredToolInterface;

  const webSearch = tool(
    async ({ query }: { query: string }) => {
      const r = await runWebSearch(query, {
        http,
        timeoutMs,
        config: deps.resolveWebSearch(),
        ...(deps.limits ? { limits: deps.limits } : {}),
        ...(deps.extraProviders ? { extraProviders: deps.extraProviders() } : {}),
      });
      if (r.warning) deps.onSearchWarning?.();
      return mask(renderSearchResults(query, r.results));
    },
    { name: "web_search", description: "Search the web and return up to 8 ranked results.", schema: WEB_SEARCH_SCHEMA },
  ) as unknown as StructuredToolInterface;

  return [webFetch, webSearch];
}
