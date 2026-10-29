/**
 * `web_fetch` limits DENY conformance (core-blueprint.md §13.11).
 *
 * The warn behaviour (inline/preview consolidated into one LIMIT_HIT, content
 * stays readable via the by-reference handle) is covered in `web-fetch.test.ts`.
 * This file covers the DENY action: when a layer sets `tools.webFetchInlineMax`
 * or `tools.webFetchPreview` to `action: "deny"`, a body larger than the inline
 * cap is REFUSED at the bound — the tool returns its normal error-result shape
 * with the one-line notice, NOTHING is delivered inline and nothing is presented
 * as delivered, and EXACTLY ONE `LIMIT_HIT` with `action: "deny"` is recorded.
 *
 * `tools.webFetch*` are download-class: the existing cascade (safety-ceiling for
 * the body/hop caps) is untouched here — these two keys are `tunable`, so a
 * project `{ value, action: "deny" }` override is honored by `resolveLimits`.
 *
 * Offline, over the same `HttpPort` seam the sibling tests use.
 */
import { describe, it, expect } from "vitest";
import { runWebFetch, type WebFetchDeps } from "./web-fetch.js";
import type { HttpPort, HttpRequest, HttpResponse, ResolvedAddress } from "../entities/ports/http-port.js";
import { EventBus } from "../entities/event-bus.js";
import { resolveLimits } from "../entities/limits-resolve.js";
import { LimitsCapability } from "./limits-capability.js";

/** A minimal scriptable fake HttpPort (mirrors web-fetch.test.ts). */
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

function deps(http: FakeHttp, over: Partial<WebFetchDeps> = {}): WebFetchDeps {
  return {
    http,
    timeoutMs: 10_000,
    mask: (t) => t,
    writeCache: async (rel: string) => `/ws/${rel}`,
    ...over,
  };
}

/** Build a LimitsCapability + a LIMIT_HIT collector over a fresh bus. */
function withLimits(
  limitsCfg: Record<string, unknown>,
): { limits: LimitsCapability; hits: Array<{ key: string; action: string; value: number }> } {
  const bus = new EventBus();
  const hits: Array<{ key: string; action: string; value: number }> = [];
  bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string; action: string; value: number }));
  const limits = new LimitsCapability(resolveLimits([{ layer: "project", limits: limitsCfg }]), bus);
  return { limits, hits };
}

describe("web_fetch limits DENY conformance (§13.11)", () => {
  it("webFetchInlineMax deny: an oversized body is refused with an error result and exactly one LIMIT_HIT (action deny)", async () => {
    const { limits, hits } = withLimits({
      tools: { webFetchInlineMax: { value: 100, action: "deny" } },
    });
    const http = new FakeHttp();
    http.queue.push({ status: 200, contentType: "text/plain", body: "y".repeat(500) });
    const r = await runWebFetch("https://example.com/deny", deps(http, { limits }));

    // The tool's normal error-result shape, with the one-line notice.
    expect(r.status).toBe("error");
    expect(r.content).toContain("limits.tools.webFetchInlineMax");
    // Nothing delivered inline and nothing presented as delivered.
    expect(r.content).not.toContain("y".repeat(101));
    expect(r.content).not.toContain("Previewed");
    expect(r.content).not.toContain("[full page:");
    // Exactly one LIMIT_HIT, naming the key, action deny.
    expect(hits.length).toBe(1);
    expect(hits[0]!.key).toBe("tools.webFetchInlineMax");
    expect(hits[0]!.action).toBe("deny");
  });

  it("webFetchPreview deny: an oversized body is refused with an error result and exactly one LIMIT_HIT (action deny) naming the preview key", async () => {
    // inlineMax stays warn (default action); the PREVIEW bound denies.
    const { limits, hits } = withLimits({
      tools: { webFetchInlineMax: 100, webFetchPreview: { value: 20, action: "deny" } },
    });
    const http = new FakeHttp();
    http.queue.push({ status: 200, contentType: "text/plain", body: "z".repeat(500) });
    const r = await runWebFetch("https://example.com/deny-preview", deps(http, { limits }));

    expect(r.status).toBe("error");
    expect(r.content).toContain("limits.tools.webFetchPreview");
    expect(r.content).not.toContain("z".repeat(21));
    expect(r.content).not.toContain("Previewed");
    expect(r.content).not.toContain("[full page:");
    expect(hits.length).toBe(1);
    expect(hits[0]!.key).toBe("tools.webFetchPreview");
    expect(hits[0]!.action).toBe("deny");
  });

  it("default (no override) is unchanged: an oversized body still previews, one warn LIMIT_HIT, handle readable", async () => {
    const { limits, hits } = withLimits({});
    const http = new FakeHttp();
    const writes: Record<string, string> = {};
    http.queue.push({ status: 200, contentType: "text/plain", body: "x".repeat(6000) });
    const r = await runWebFetch(
      "https://example.com/default",
      deps(http, {
        limits,
        writeCache: async (rel, content) => {
          writes[rel] = content;
          return rel;
        },
      }),
    );
    expect(r.status).toBe("success");
    expect(r.content).toContain("Previewed");
    expect(r.content).toMatch(/\[full page: \.voidrift\/cache\/web\/[0-9a-f]{12}\.md/);
    expect(hits.length).toBe(1);
    expect(hits[0]!.key).toBe("tools.webFetchInlineMax");
    expect(hits[0]!.action).toBe("warn");
    // The full text is readable via the handle (cache file).
    const handle = r.content.match(/\[full page: (\S+) /)![1]!;
    expect(writes[handle]!.length).toBeGreaterThan(6000);
  });

  it("deny with content AT/UNDER the inline cap delivers inline and records no hit", async () => {
    const { limits, hits } = withLimits({
      tools: { webFetchInlineMax: { value: 100, action: "deny" } },
    });
    const http = new FakeHttp();
    http.queue.push({ status: 200, contentType: "text/plain", body: "short body" });
    const r = await runWebFetch("https://example.com/ok", deps(http, { limits }));
    expect(r.status).toBe("success");
    expect(r.content).toBe("short body");
    expect(hits.length).toBe(0);
  });
});
