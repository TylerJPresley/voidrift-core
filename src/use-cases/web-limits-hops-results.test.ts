/**
 * Hop-cap and result-cap limits conformance (core-blueprint.md §13.11, gaps 4
 * and 5 of the 2026-10-29 tools-limits audit).
 *
 *   - `tools.webFetchMaxHops` (safety/deny): refusing at the redirect-hop bound
 *     must emit exactly ONE `LIMIT_HIT` and use the notice as the refusal
 *     message. A configured `warn` does NOT follow further hops — a download-class
 *     hop cap is documented unsafe to relax (§13.11); it still refuses, but the
 *     emitted hit carries the resolved action.
 *   - `tools.webSearchMaxResults` (tunable/warn): dropping extra results emits
 *     exactly ONE `LIMIT_HIT` and keeps the run going.
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
  return { http, timeoutMs: 10_000, mask: (t) => t, writeCache: async (rel: string) => `/ws/${rel}`, ...over };
}

function searchDeps(http: FakeHttp, over: Partial<WebSearchDeps> = {}): WebSearchDeps {
  const config: WebSearchConfig = { provider: "duckduckgo" } as WebSearchConfig;
  return { http, timeoutMs: 10_000, config, ...over };
}

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

/** A DDG HTML page with `n` result rows. */
function ddgRows(n: number): string {
  let html = "";
  for (let i = 0; i < n; i++) {
    html +=
      `<div class="result__body">` +
      `<a class="result__a" href="https://example.org/${i}">Title ${i}</a>` +
      `<div class="result__snippet">snippet ${i}</div>` +
      `</div>`;
  }
  return html;
}

describe("web_fetch hop cap (tools.webFetchMaxHops) §13.11", () => {
  it("deny (default): too many redirects refuses with the notice and exactly one LIMIT_HIT (action deny) naming the key", async () => {
    const { limits, hits } = withLimits({ tools: { webFetchMaxHops: 1 } });
    const http = new FakeHttp();
    // hop 0 and hop 1 both redirect → exceeds a 1-hop cap.
    http.queue.push({ status: 302, location: "https://example.com/2" });
    http.queue.push({ status: 302, location: "https://example.com/3" });
    const r = await runWebFetch("https://example.com/1", fetchDeps(http, { limits }));

    expect(r.status).toBe("error");
    expect(r.content).toContain("limits.tools.webFetchMaxHops");
    expect(hits.length).toBe(1);
    expect(hits[0]!.key).toBe("tools.webFetchMaxHops");
    expect(hits[0]!.action).toBe("deny");
  });

  it("warn (override): the hop cap still refuses (download-class, unsafe to relax) but the hit carries action warn", async () => {
    const { limits, hits } = withLimits({ tools: { webFetchMaxHops: { value: 1, action: "warn" } } });
    const http = new FakeHttp();
    http.queue.push({ status: 302, location: "https://example.com/2" });
    http.queue.push({ status: 302, location: "https://example.com/3" });
    const r = await runWebFetch("https://example.com/1", fetchDeps(http, { limits }));

    expect(r.status).toBe("error");
    expect(r.content).toContain("limits.tools.webFetchMaxHops");
    expect(hits.length).toBe(1);
    expect(hits[0]!.key).toBe("tools.webFetchMaxHops");
    expect(hits[0]!.action).toBe("warn");
  });
});

describe("web_search result cap (tools.webSearchMaxResults) §13.11", () => {
  it("warn: dropping extra results emits exactly one LIMIT_HIT (action warn) and keeps the run going", async () => {
    const { limits, hits } = withLimits({ tools: { webSearchMaxResults: 2 } });
    const http = new FakeHttp();
    http.queue.push({ status: 200, contentType: "text/html", body: ddgRows(5) });
    const r = await runWebSearch("q", searchDeps(http, { limits }));

    expect(r.results.length).toBe(2);
    expect(hits.filter((h) => h.key === "tools.webSearchMaxResults").length).toBe(1);
    expect(hits.find((h) => h.key === "tools.webSearchMaxResults")!.action).toBe("warn");
  });

  it("under the cap: no result hit", async () => {
    const { limits, hits } = withLimits({ tools: { webSearchMaxResults: 8 } });
    const http = new FakeHttp();
    http.queue.push({ status: 200, contentType: "text/html", body: ddgRows(3) });
    const r = await runWebSearch("q", searchDeps(http, { limits }));
    expect(r.results.length).toBe(3);
    expect(hits.filter((h) => h.key === "tools.webSearchMaxResults").length).toBe(0);
  });
});
