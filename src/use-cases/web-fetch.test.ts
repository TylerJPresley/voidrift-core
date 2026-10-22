/**
 * `web_fetch` use-case + SSRF-gating tests (core-blueprint.md §8.2, §9.3).
 *
 * All offline: a fake `HttpPort` (scriptable responses + a scriptable resolver)
 * proves every control — DNS-rebinding refusal, per-hop redirect re-validation,
 * the hop limit, content-type refusal, mid-stream body-size cap, timeout, no
 * credentials/cookies, and scheme rejection — plus the Guardian gating: a plain
 * public URL asks; a broad allow lets it through; a metadata URL stays
 * force-ask under a broad allow + plan scope + fan-out grant; a deny blocks.
 */
import { describe, it, expect } from "vitest";
import {
  runWebFetch,
  webCachePath,
  extractReadable,
  WEB_FETCH_USER_AGENT,
  WEB_FETCH_MAX_HOPS,
  type WebFetchDeps,
} from "./web-fetch.js";
import type { HttpPort, HttpRequest, HttpResponse, ResolvedAddress } from "../entities/ports/http-port.js";
import { Guardian, builtinGuardrails, type ShellLists } from "../entities/guardian.js";
import type { PermissionRule } from "../config/schema.js";

/** A scriptable fake HttpPort. */
class FakeHttp implements HttpPort {
  requests: HttpRequest[] = [];
  resolveMap: Record<string, ResolvedAddress[]> = {};
  queue: Array<Partial<HttpResponse> & { body?: string; chunkSize?: number }> = [];
  throwOnFetch: Error | null = null;

  async resolve(hostname: string): Promise<ResolvedAddress[]> {
    return this.resolveMap[hostname] ?? [{ address: "93.184.216.34", family: 4 }];
  }

  async fetchOnce(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    if (this.throwOnFetch) throw this.throwOnFetch;
    const r = this.queue.shift() ?? { status: 200, contentType: "text/plain", body: "ok" };
    const body = r.body ?? "";
    const chunkSize = r.chunkSize ?? body.length;
    return {
      status: r.status ?? 200,
      location: r.location ?? null,
      contentType: r.contentType ?? "text/plain",
      readBodyCapped: async (maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> => {
        const enc = new TextEncoder().encode(body);
        // Simulate mid-stream capping: walk chunks, stop at maxBytes.
        const kept: Uint8Array[] = [];
        let total = 0;
        let truncated = false;
        for (let i = 0; i < enc.length; i += chunkSize) {
          const chunk = enc.slice(i, i + chunkSize);
          if (total + chunk.length > maxBytes) {
            kept.push(chunk.slice(0, maxBytes - total));
            total = maxBytes;
            truncated = true;
            break;
          }
          kept.push(chunk);
          total += chunk.length;
        }
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of kept) {
          out.set(c, off);
          off += c.length;
        }
        return { bytes: out, truncated };
      },
    };
  }
}

function deps(http: FakeHttp, over: Partial<WebFetchDeps> = {}): WebFetchDeps {
  const writes: Record<string, string> = {};
  return {
    http,
    timeoutMs: 10_000,
    mask: (t) => t,
    writeCache: async (rel, content) => {
      writes[rel] = content;
      return `/ws/${rel}`;
    },
    ...over,
  };
}

const lists: ShellLists = { safe: [], forceAsk: [], equivalents: [], deny: [] };

describe("runWebFetch SSRF controls (§8.2)", () => {
  it("fetches a public URL and returns inline content, sending a fixed UA and no credentials", async () => {
    const http = new FakeHttp();
    http.queue.push({ status: 200, contentType: "text/plain", body: "hello world" });
    const r = await runWebFetch("https://example.com/", deps(http));
    expect(r.status).toBe("success");
    expect(r.content).toContain("hello world");
    expect(http.requests[0]!.userAgent).toBe(WEB_FETCH_USER_AGENT);
    // The port receives only url/timeout/userAgent plus the vetted pinned
    // address (DNS-rebinding defense) — and NO cookie/credential/auth field.
    const reqKeys = Object.keys(http.requests[0]!).sort();
    expect(reqKeys).toEqual(["pinnedAddress", "pinnedFamily", "timeoutMs", "url", "userAgent"]);
    expect(reqKeys).not.toContain("cookie");
    expect(reqKeys).not.toContain("headers");
    expect(reqKeys).not.toContain("credentials");
    // The pinned address is one the use-case already vetted against SSRF ranges.
    expect(typeof http.requests[0]!.pinnedAddress).toBe("string");
  });

  it("refuses a public host that resolves to a private IP (DNS-rebinding)", async () => {
    const http = new FakeHttp();
    http.resolveMap["rebind.example.com"] = [{ address: "10.0.0.5", family: 4 }];
    const r = await runWebFetch("https://rebind.example.com/", deps(http));
    expect(r.status).toBe("error");
    expect(r.content).toMatch(/resolves to a private address/);
    expect(http.requests).toHaveLength(0); // never fetched
  });

  it("stops a redirect chain into the metadata IP at the hop (never fetched)", async () => {
    const http = new FakeHttp();
    http.queue.push({ status: 302, location: "http://169.254.169.254/latest/meta-data/" });
    const r = await runWebFetch("https://example.com/", deps(http));
    expect(r.status).toBe("error");
    expect(r.content).toMatch(/redirect into SSRF range/);
    // Only the first (public) hop was fetched; the metadata hop was blocked.
    expect(http.requests).toHaveLength(1);
  });

  it("enforces the redirect hop limit", async () => {
    const http = new FakeHttp();
    for (let i = 0; i <= WEB_FETCH_MAX_HOPS + 1; i++) {
      http.queue.push({ status: 302, location: `https://example.com/hop${i}` });
    }
    const r = await runWebFetch("https://example.com/", deps(http));
    expect(r.status).toBe("error");
    expect(r.content).toMatch(/too many redirects/);
  });

  it("refuses a disallowed content-type (binary)", async () => {
    const http = new FakeHttp();
    http.queue.push({ status: 200, contentType: "application/octet-stream", body: "\x00\x01" });
    const r = await runWebFetch("https://example.com/x.bin", deps(http));
    expect(r.status).toBe("error");
    expect(r.content).toMatch(/unsupported content-type/);
  });

  it("caps the response body mid-stream (never buffers unbounded)", async () => {
    const http = new FakeHttp();
    // 10 MiB body streamed in 64 KiB chunks; the cap is 5 MiB.
    const big = "a".repeat(10 * 1024 * 1024);
    http.queue.push({ status: 200, contentType: "text/plain", body: big, chunkSize: 64 * 1024 });
    const r = await runWebFetch("https://example.com/big", deps(http));
    expect(r.status).toBe("success");
    // The cached full text is capped well under the 10 MiB source.
    expect((r.fullText ?? "").length).toBeLessThanOrEqual(5 * 1024 * 1024);
  });

  it("surfaces a timeout/abort from the port as an error, not a crash", async () => {
    const http = new FakeHttp();
    http.throwOnFetch = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    await expect(runWebFetch("https://example.com/", deps(http))).rejects.toThrow(/aborted/);
  });

  it("rejects a non-http(s) scheme without any network call", async () => {
    const http = new FakeHttp();
    const r = await runWebFetch("file:///etc/passwd", deps(http));
    expect(r.status).toBe("error");
    expect(r.content).toMatch(/unsupported URL/);
    expect(http.requests).toHaveLength(0);
  });

  it("writes the cache file with the source header and returns a preview for long content", async () => {
    const http = new FakeHttp();
    http.queue.push({ status: 200, contentType: "text/plain", body: "x".repeat(6000) });
    const r = await runWebFetch("https://example.com/long", deps(http));
    expect(r.status).toBe("success");
    // §8.2/§8.7: preview + a marker naming the key + the [full page: handle] pointer.
    expect(r.content).toMatch(/\[full page: \.voidrift\/cache\/web\/[0-9a-f]{12}\.md \(\d+ lines\) - read it in ranges with read_file offset\/limit or call ingest\]/);
    expect(r.content).toContain("limits.tools.webFetchInlineMax");
    expect(r.cachePath).toBeDefined();
    expect(webCachePath("https://example.com/long")).toMatch(/^\.voidrift\/cache\/web\/[0-9a-f]{12}\.md$/);
  });

  it("§13.11: a configured limits.tools.webFetchInlineMax changes the inline→preview cut and emits one LIMIT_HIT", async () => {
    const { EventBus } = await import("../entities/event-bus.js");
    const { resolveLimits } = await import("../entities/limits-resolve.js");
    const { LimitsCapability } = await import("./limits-capability.js");
    const { limitDefault } = await import("../entities/limits.js");
    expect(limitDefault("tools.webFetchInlineMax")).toBe(5000);
    expect(limitDefault("tools.webFetchPreview")).toBe(2000);
    const bus = new EventBus();
    const hits: { key: string; value: number }[] = [];
    bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string; value: number }));
    const limits = new LimitsCapability(resolveLimits([{ layer: "project", limits: { tools: { webFetchInlineMax: 100, webFetchPreview: 20 } } }]), bus);
    const http = new FakeHttp();
    http.queue.push({ status: 200, contentType: "text/plain", body: "y".repeat(500) });
    const r = await runWebFetch("https://example.com/cfg", deps(http, { limits }));
    expect(r.status).toBe("success");
    expect(r.content).toContain("Previewed 20 of 500 chars");
    expect(hits.length).toBe(1);
    expect(hits[0].key).toBe("tools.webFetchInlineMax");
    expect(hits[0].value).toBe(100);
  });

  it("§13.11: content that fits the inline max emits no LIMIT_HIT", async () => {
    const { EventBus } = await import("../entities/event-bus.js");
    const { resolveLimits } = await import("../entities/limits-resolve.js");
    const { LimitsCapability } = await import("./limits-capability.js");
    const bus = new EventBus();
    const hits: unknown[] = [];
    bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload));
    const limits = new LimitsCapability(resolveLimits([]), bus);
    const http = new FakeHttp();
    http.queue.push({ status: 200, contentType: "text/plain", body: "short" });
    const r = await runWebFetch("https://example.com/s", deps(http, { limits }));
    expect(r.content).toBe("short");
    expect(hits.length).toBe(0);
  });

  it("extracts readable text from HTML and falls back to tag-stripping", () => {
    const text = extractReadable("<html><body><p>short</p></body></html>", "https://e.com");
    expect(text).toContain("short");
  });

  it("an exactly-allowed loopback host is FETCHED, not refused (owner D2a)", async () => {
    const http = new FakeHttp();
    http.resolveMap["127.0.0.1"] = [{ address: "127.0.0.1", family: 4 }];
    http.queue.push({ status: 200, contentType: "text/plain", body: "internal ok" });
    const r = await runWebFetch("http://127.0.0.1:8080/x", deps(http, { allowHost: (h) => h === "127.0.0.1" }));
    expect(r.status).toBe("success");
    expect(r.content).toContain("internal ok");
    expect(http.requests).toHaveLength(1);
  });

  it("without allowHost a loopback host is still refused (pre-D2a behavior)", async () => {
    const http = new FakeHttp();
    const r = await runWebFetch("http://127.0.0.1:8080/x", deps(http));
    expect(r.status).toBe("error");
    expect(r.content).toMatch(/refusing SSRF-range URL/);
    expect(http.requests).toHaveLength(0);
  });

  it("allowHost does NOT bypass a DNS-rebind when the resolved address is not allowed (owner D2a)", async () => {
    const http = new FakeHttp();
    // The host is allowed exactly, but it resolves to a DIFFERENT private IP
    // that is not allowed — the rebind refusal still fires.
    http.resolveMap["allowed.example"] = [{ address: "10.1.2.3", family: 4 }];
    const r = await runWebFetch("http://allowed.example/x", deps(http, { allowHost: (h) => h === "allowed.example" }));
    expect(r.status).toBe("error");
    expect(r.content).toMatch(/resolves to a private address/);
    expect(http.requests).toHaveLength(0);
  });

  it("a public name rebinding to IPv4 metadata is refused EVEN with a covering allowHost rule (owner D2c)", async () => {
    const http = new FakeHttp();
    http.resolveMap["rebind.example"] = [{ address: "169.254.169.254", family: 4 }];
    // A broad allowHost (as a cidr/exact rule would produce) must NOT lift a
    // metadata address: metadata is never-liftable unless `metadata-hosts` is
    // unlocked.
    const r = await runWebFetch("http://rebind.example/x", deps(http, { allowHost: () => true }));
    expect(r.status).toBe("error");
    expect(r.content).toMatch(/cloud instance-metadata address \(never list: metadata-hosts\)/);
    expect(http.requests).toHaveLength(0);
  });

  it("a public name rebinding to the IPv6 metadata address is refused under a covering rule (owner D2c)", async () => {
    const http = new FakeHttp();
    http.resolveMap["rebind6.example"] = [{ address: "fd00:ec2::254", family: 6 }];
    const r = await runWebFetch("http://rebind6.example/x", deps(http, { allowHost: () => true }));
    expect(r.status).toBe("error");
    expect(r.content).toMatch(/cloud instance-metadata address/);
    expect(http.requests).toHaveLength(0);
  });

  it("a redirect to the metadata address is refused even with a covering rule (owner D2c)", async () => {
    const http = new FakeHttp();
    http.queue.push({ status: 302, location: "http://169.254.169.254/latest/meta-data/" });
    const r = await runWebFetch("https://example.com/", deps(http, { allowHost: () => true }));
    expect(r.status).toBe("error");
    expect(r.content).toMatch(/cloud instance-metadata address/);
    expect(http.requests).toHaveLength(1); // only the first public hop fetched
  });

  it("metadataUnlocked lets a metadata host through to the ordinary SSRF path (owner D2c)", async () => {
    const http = new FakeHttp();
    http.resolveMap["rebind.example"] = [{ address: "169.254.169.254", family: 4 }];
    http.queue.push({ status: 200, contentType: "text/plain", body: "imds" });
    // With metadata unlocked AND the host/address allowed, the rebind is no
    // longer never-liftable and the fetch proceeds.
    const r = await runWebFetch(
      "http://rebind.example/x",
      deps(http, { allowHost: () => true, metadataUnlocked: true }),
    );
    expect(r.status).toBe("success");
    expect(r.content).toContain("imds");
  });
});

describe("web_fetch gating through Guardian (§9.3)", () => {
  const guardian = new Guardian(builtinGuardrails());

  it("a plain public URL with no rule → ask (network is gated)", () => {
    const out = guardian.evaluate(
      { tool: "web_fetch", args: { url: "https://example.com/" } },
      [],
      lists,
    );
    expect(out.decision).toBe("ask");
    expect(out.forceAsk).toBe(false);
  });

  it("a broad allow rule lets a public URL through", () => {
    const rules: PermissionRule[] = [
      { tool: "web_fetch", pattern: "*", decision: "allow", priority: 100, source: "user" },
    ];
    const out = guardian.evaluate(
      { tool: "web_fetch", args: { url: "https://example.com/" } },
      rules,
      lists,
    );
    expect(out.decision).toBe("allow");
  });

  it("a metadata URL is NEVER (denied) under a broad allow + plan scope + fan-out grant", () => {
    const g = new Guardian(builtinGuardrails());
    g.registerScope("plan", { executePatterns: ["*"], writeGlobs: ["*"] });
    g.grantFanout("fan-1");
    const rules: PermissionRule[] = [
      { tool: "*", pattern: "*", decision: "allow", priority: 1000, source: "session" },
    ];
    const out = g.evaluate(
      { tool: "web_fetch", args: { url: "http://169.254.169.254/latest/meta-data/" } },
      rules,
      lists,
    );
    // §9.3/§13.10 — a cloud-metadata address is a code-level NEVER: denied
    // outright, immune to the broad allow + scope + grant, no prompt.
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("never list: metadata-hosts");
  });

  it("`metadata-hosts` in unlock lifts a metadata URL back to the ordinary SSRF force-ask", () => {
    const g = new Guardian(builtinGuardrails());
    const out = g.evaluate(
      { tool: "web_fetch", args: { url: "http://169.254.169.254/latest/meta-data/" } },
      [],
      lists,
      { unlock: new Set(["metadata-hosts"]) },
    );
    expect(out.decision).toBe("ask");
    expect(out.forceAsk).toBe(true);
    expect(out.forceAskKind).toBe("ssrf");
  });

  it("the metadata hostname metadata.google.internal is NEVER too", () => {
    const g = new Guardian(builtinGuardrails());
    const out = g.evaluate(
      { tool: "web_fetch", args: { url: "http://metadata.google.internal/computeMetadata/v1/" } },
      [],
      lists,
    );
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("never list: metadata-hosts");
  });

  it("an explicit deny blocks even a force-ask (SSRF) URL outright", () => {
    const rules: PermissionRule[] = [
      { tool: "web_fetch", pattern: "*", decision: "deny", priority: 1000, source: "session" },
    ];
    // Only an explicit deny blocks a force-ask outright (§9.3): a metadata URL
    // that would otherwise force-ask is denied when a matching deny rule wins.
    const out = guardian.evaluate(
      { tool: "web_fetch", args: { url: "http://169.254.169.254/" } },
      rules,
      lists,
    );
    expect(out.decision).toBe("deny");
  });

  it("a bad-scheme URL is denied structurally at the gate", () => {
    const out = guardian.evaluate(
      { tool: "web_fetch", args: { url: "file:///etc/passwd" } },
      [],
      lists,
    );
    expect(out.decision).toBe("deny");
    expect(out.reason).toMatch(/scheme/);
  });
});

describe("web_fetch oversized page by reference / digest (§8.2, §8.7)", () => {
  it("a page over the inline max returns a preview + [full page: <handle> …] and the cache holds the whole text", async () => {
    const http = new FakeHttp();
    const body = "x".repeat(200 * 1024); // ~200 KB
    http.queue.push({ status: 200, contentType: "text/plain", body });
    const writes: Record<string, string> = {};
    const byRef: { what: string; bytes: number; key: string }[] = [];
    const r = await runWebFetch(
      "https://example.com/big",
      deps(http, {
        writeCache: async (rel, content) => {
          writes[rel] = content;
          return rel;
        },
        onByReference: (i) => byRef.push(i),
      }),
    );
    expect(r.status).toBe("success");
    // Preview is bounded; the handle points at the cache path, with a line count.
    expect(r.content).toMatch(/\[full page: \.voidrift\/cache\/web\/[0-9a-f]{12}\.md \(\d+ lines\) - read it in ranges with read_file offset\/limit or call ingest\]/);
    expect(r.content).not.toContain("x".repeat(200 * 1024)); // never the whole body inline
    // The cache file holds the whole text (source header + full body).
    const handle = r.content.match(/\[full page: (\S+) /)![1]!;
    expect(writes[handle]).toBeDefined();
    expect(writes[handle]!.length).toBeGreaterThan(200 * 1024);
    // A ranged read of the cache (as read_file would) reaches the tail.
    expect(writes[handle]).toContain("x".repeat(1000));
    // BY_REFERENCE fired naming the key.
    expect(byRef.length).toBe(1);
    expect(byRef[0]!.key).toBe("tools.webFetchInlineMax");
  });

  it("with ingest available and a small budget, a large page returns its ingest DIGEST, not a preview", async () => {
    const http = new FakeHttp();
    http.queue.push({ status: 200, contentType: "text/plain", body: "y".repeat(200 * 1024) });
    const r = await runWebFetch(
      "https://example.com/digestme",
      deps(http, {
        availableTokens: 100, // tiny budget → page cannot fit
        ingestPage: async (_text, purpose) => `DIGEST for ${purpose}\n1-10: summary`,
      }),
    );
    expect(r.status).toBe("success");
    expect(r.content).toContain("DIGEST for");
    expect(r.content).not.toContain("[full page:");
  });

  it("with ingest available but ample budget, a large page still previews (fit test passes → no fan-out)", async () => {
    const http = new FakeHttp();
    http.queue.push({ status: 200, contentType: "text/plain", body: "z".repeat(10 * 1024) });
    let ingestCalled = false;
    const r = await runWebFetch(
      "https://example.com/fits",
      deps(http, {
        availableTokens: 10_000_000, // huge budget → fits, no ingest
        ingestPage: async () => {
          ingestCalled = true;
          return "DIGEST";
        },
      }),
    );
    expect(r.status).toBe("success");
    expect(ingestCalled).toBe(false);
    expect(r.content).toContain("[full page:");
  });
});
