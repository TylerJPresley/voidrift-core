/**
 * `FetchHttpAdapter` tests (core-blueprint.md §8.2) against a bounded loopback
 * HTTP server — the ONE place the real undici fetch + dns path runs. Offline:
 * the server binds 127.0.0.1 on an ephemeral port and is closed in afterAll, so
 * nothing leaks and nothing reaches the network.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { FetchHttpAdapter } from "./http-fetch.js";

describe("FetchHttpAdapter (§8.2)", () => {
  let server: http.Server;
  let base: string;
  const seen: { url: string | undefined; ua: string | undefined; cookie: string | undefined }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ url: req.url, ua: req.headers["user-agent"], cookie: req.headers["cookie"] });
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/final" });
        res.end();
        return;
      }
      if (req.url === "/final") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("final body");
        return;
      }
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("z".repeat(1_000_000));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<p>hello</p>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("resolves a hostname to addresses", async () => {
    const addrs = await new FetchHttpAdapter().resolve("localhost");
    expect(addrs.length).toBeGreaterThan(0);
    expect([4, 6]).toContain(addrs[0]!.family);
  });

  it("fetchOnce does NOT follow redirects and exposes Location", async () => {
    const res = await new FetchHttpAdapter().fetchOnce({ url: `${base}/redirect`, timeoutMs: 5000, userAgent: "UA/1" });
    expect(res.status).toBe(302);
    expect(res.location).toBe("/final");
  });

  it("sends the fixed UA and no cookie, and lowercases/strips the content-type", async () => {
    seen.length = 0;
    const res = await new FetchHttpAdapter().fetchOnce({ url: `${base}/final`, timeoutMs: 5000, userAgent: "VoidRift-web_fetch/1" });
    expect(res.status).toBe(200);
    expect(res.contentType).toBe("text/plain");
    const { bytes } = await res.readBodyCapped(1024);
    expect(new TextDecoder().decode(bytes)).toBe("final body");
    expect(seen[0]!.ua).toBe("VoidRift-web_fetch/1");
    expect(seen[0]!.cookie).toBeUndefined();
  });

  it("caps the body mid-stream and reports truncation", async () => {
    const res = await new FetchHttpAdapter().fetchOnce({ url: `${base}/big`, timeoutMs: 5000, userAgent: "UA/1" });
    const { bytes, truncated } = await res.readBodyCapped(2048);
    expect(bytes.length).toBe(2048);
    expect(truncated).toBe(true);
  });

  it("aborts on timeout", async () => {
    const slow = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("late");
      }, 2000);
    });
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(slow.address() as AddressInfo).port}/`;
    await expect(
      new FetchHttpAdapter().fetchOnce({ url, timeoutMs: 50, userAgent: "UA/1" }),
    ).rejects.toThrow();
    await new Promise<void>((r) => slow.close(() => r()));
  });

  // DNS-rebinding defense over the REAL undici connect path (§8.2): the URL
  // hostname does NOT resolve (`.invalid` is reserved and always NXDOMAIN), so a
  // plain fetch would fail with ENOTFOUND. With the vetted IP pinned, undici
  // connects to 127.0.0.1 regardless of the hostname — proving the pin controls
  // the actual socket destination, not the OS resolver. A rebinding host that
  // answered a different IP on connect therefore cannot be reached.
  it("pins the connection to the vetted IP, bypassing hostname resolution", async () => {
    const port = (server.address() as AddressInfo).port;
    const res = await new FetchHttpAdapter().fetchOnce({
      url: `http://pin-target.invalid:${port}/final`,
      timeoutMs: 5000,
      userAgent: "UA/pin",
      pinnedAddress: "127.0.0.1",
      pinnedFamily: 4,
    });
    expect(res.status).toBe(200);
    const { bytes } = await res.readBodyCapped(1024);
    expect(new TextDecoder().decode(bytes)).toBe("final body");
  });

  // Without a pin, the same non-resolving hostname fails — confirming the test
  // above succeeds BECAUSE of the pin, not by accident.
  it("without a pin, a non-resolving hostname fails to connect", async () => {
    const port = (server.address() as AddressInfo).port;
    await expect(
      new FetchHttpAdapter().fetchOnce({
        url: `http://pin-target.invalid:${port}/final`,
        timeoutMs: 5000,
        userAgent: "UA/nopin",
      }),
    ).rejects.toThrow();
  });
});
