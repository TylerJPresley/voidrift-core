/**
 * Body-byte-cap limits conformance for `web_fetch` and `web_search`
 * (core-blueprint.md §13.11, gap 1 of the 2026-10-29 tools-limits audit).
 *
 * `tools.webFetchBodyMaxBytes` and `tools.webSearchBodyMaxBytes` are `safety`
 * DoS bounds declared `deny`. When the response body is longer than the cap the
 * `HttpPort.readBodyCapped` port already returns `{ truncated: true }`; the two
 * call sites previously dropped that flag and used the clipped body silently.
 *
 * Conformance (§13.11 action paragraphs):
 *   - deny (the declared default): the call fails at the bound with the one-line
 *     notice via the tool's normal error result, and the PARTIAL body is not
 *     used; exactly ONE `LIMIT_HIT` with `action: "deny"` names the key.
 *   - warn (if a layer overrides the action): continue with the clipped body + a
 *     marker, exactly ONE `LIMIT_HIT` with `action: "warn"` names the key.
 *
 * Offline, over the same `HttpPort` seam the sibling web tests use.
 */
import { describe, it, expect } from "vitest";
import { runWebFetch, type WebFetchDeps } from "./web-fetch.js";
import { runWebSearch, type WebSearchDeps } from "./web-search.js";
import type { HttpPort, HttpRequest, HttpResponse, ResolvedAddress } from "../entities/ports/http-port.js";
import type { WebSearchConfig } from "../config/schema.js";
import { EventBus } from "../entities/event-bus.js";
import { resolveLimits } from "../entities/limits-resolve.js";
import { LimitsCapability } from "./limits-capability.js";

/** A minimal scriptable fake HttpPort (mirrors web-fetch-limits-deny.test.ts). */
class FakeHttp implements HttpPort {
  requests: HttpRequest[] = [];
  resolveMap: Record<string, ResolvedAddress[]> = {};
  queue: Array<Partial<HttpResponse> & { body?: string }> = [];

  async resolve(hostname: string): Promise<ResolvedAddress[]> {
    return this.resolveMap[hostname] ?? [{ address: "93.184.216.34", family: 4 }];
  }

  async fetchOnce(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    const r = this.queue.shift() ?? { status: 200, contentType: "text/plain", body: "ok" };
    const body = r.body ?? "";
    return {
      status: r.status ?? 200,
      location: r.location ?? null,
      contentType: r.contentType ?? "text/plain",
      readBodyCapped: async (maxBytes: number) => {
        const enc = new TextEncoder().encode(body);
        const out = enc.slice(0, Math.min(enc.length, maxBytes));
        return { bytes: out, truncated: enc.length > maxBytes };
      },
    };
  }
}

function fetchDeps(http: FakeHttp, over: Partial<WebFetchDeps> = {}): WebFetchDeps {
  return {
    http,
    timeoutMs: 10_000,
    mask: (t) => t,
    writeCache: async (rel: string) => `/ws/${rel}`,
    ...over,
  };
}

function searchDeps(http: FakeHttp, over: Partial<WebSearchDeps> = {}): WebSearchDeps {
  const config: WebSearchConfig = { provider: "duckduckgo" } as WebSearchConfig;
  return { http, timeoutMs: 10_000, config, ...over };
}

/** Build a LimitsCapability + a LIMIT_HIT collector over a fresh bus. */
function withLimits(limitsCfg: Record<string, unknown>): {
  limits: LimitsCapability;
  hits: Array<{ key: string; action: string; value: number }>;
} {
  const bus = new EventBus();
  const hits: Array<{ key: string; action: string; value: number }> = [];
  bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string; action: string; value: number }));
  const limits = new LimitsCapability(resolveLimits([{ layer: "project", limits: limitsCfg }]), bus);
  return { limits, hits };
}

/** One DDG result row ~`len` bytes of snippet, as an HTML results page. */
function ddgHtml(snippet: string): string {
  return (
    `<div class="result__body">` +
    `<a class="result__a" href="https://example.org/a">Title A</a>` +
    `<div class="result__snippet">${snippet}</div>` +
    `</div>`
  );
}

describe("web_fetch body cap (tools.webFetchBodyMaxBytes) §13.11", () => {
  it("deny (default): an over-cap body is refused with the normal error result and exactly one LIMIT_HIT (action deny) naming the key; the partial body is not used", async () => {
    const { limits, hits } = withLimits({ tools: { webFetchBodyMaxBytes: 50 } });
    const http = new FakeHttp();
    http.queue.push({ status: 200, contentType: "text/plain", body: "B".repeat(5000) });
    const r = await runWebFetch("https://example.com/big", fetchDeps(http, { limits }));

    expect(r.status).toBe("error");
    expect(r.content).toContain("limits.tools.webFetchBodyMaxBytes");
    // The partial body is not delivered as content.
    expect(r.content).not.toContain("B".repeat(51));
    expect(r.cachePath).toBeUndefined();
    expect(hits.length).toBe(1);
    expect(hits[0]!.key).toBe("tools.webFetchBodyMaxBytes");
    expect(hits[0]!.action).toBe("deny");
  });

  it("warn (override): an over-cap body continues with the clipped body + marker and exactly one LIMIT_HIT (action warn) naming the key", async () => {
    const { limits, hits } = withLimits({ tools: { webFetchBodyMaxBytes: { value: 50, action: "warn" } } });
    const http = new FakeHttp();
    http.queue.push({ status: 200, contentType: "text/plain", body: "C".repeat(5000) });
    const r = await runWebFetch("https://example.com/big", fetchDeps(http, { limits }));

    expect(r.status).toBe("success");
    expect(r.content).toContain("limits.tools.webFetchBodyMaxBytes");
    expect(hits.filter((h) => h.key === "tools.webFetchBodyMaxBytes").length).toBe(1);
    const bodyHit = hits.find((h) => h.key === "tools.webFetchBodyMaxBytes")!;
    expect(bodyHit.action).toBe("warn");
  });

  it("under the cap: no body hit, normal success", async () => {
    const { limits, hits } = withLimits({ tools: { webFetchBodyMaxBytes: 5000 } });
    const http = new FakeHttp();
    http.queue.push({ status: 200, contentType: "text/plain", body: "small" });
    const r = await runWebFetch("https://example.com/small", fetchDeps(http, { limits }));
    expect(r.status).toBe("success");
    expect(hits.filter((h) => h.key === "tools.webFetchBodyMaxBytes").length).toBe(0);
  });
});

describe("web_search body cap (tools.webSearchBodyMaxBytes) §13.11", () => {
  it("deny (default): an over-cap provider body yields empty results + fallback warning and exactly one LIMIT_HIT (action deny) naming the key", async () => {
    const { limits, hits } = withLimits({ tools: { webSearchBodyMaxBytes: 20 } });
    const http = new FakeHttp();
    http.queue.push({ status: 200, contentType: "text/html", body: ddgHtml("D".repeat(500)) });
    const r = await runWebSearch("q", searchDeps(http, { limits }));

    expect(r.results.length).toBe(0);
    expect(r.warning).toBe(true);
    expect(hits.filter((h) => h.key === "tools.webSearchBodyMaxBytes").length).toBe(1);
    expect(hits.find((h) => h.key === "tools.webSearchBodyMaxBytes")!.action).toBe("deny");
  });

  it("warn (override): an over-cap provider body continues with the clipped body and exactly one LIMIT_HIT (action warn) naming the key", async () => {
    const { limits, hits } = withLimits({ tools: { webSearchBodyMaxBytes: { value: 20, action: "warn" } } });
    const http = new FakeHttp();
    // A full, parseable result that fits within 20 bytes would be impossible, so
    // the clipped body simply yields 0 rows but does NOT throw and emits warn.
    http.queue.push({ status: 200, contentType: "text/html", body: ddgHtml("E".repeat(500)) });
    const r = await runWebSearch("q", searchDeps(http, { limits }));

    // A search never fails the turn (§8.2): warn continues, no throw.
    expect(Array.isArray(r.results)).toBe(true);
    expect(hits.filter((h) => h.key === "tools.webSearchBodyMaxBytes").length).toBe(1);
    expect(hits.find((h) => h.key === "tools.webSearchBodyMaxBytes")!.action).toBe("warn");
  });

  it("under the cap: no body hit, results returned", async () => {
    const { limits, hits } = withLimits({ tools: { webSearchBodyMaxBytes: 5000 } });
    const http = new FakeHttp();
    http.queue.push({ status: 200, contentType: "text/html", body: ddgHtml("short snippet") });
    const r = await runWebSearch("q", searchDeps(http, { limits }));
    expect(r.results.length).toBe(1);
    expect(hits.filter((h) => h.key === "tools.webSearchBodyMaxBytes").length).toBe(0);
  });
});
