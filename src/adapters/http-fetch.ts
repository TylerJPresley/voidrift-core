/**
 * The HTTP adapter (core-blueprint.md §8.2) — the one implementation of
 * `HttpPort`, over Node's global `fetch` (undici) and `dns.lookup`. No new
 * dependency: `undici` already ships with Node and is resolved from the tree.
 * Durability/liveness I/O is why this is an adapter, not an entity.
 *
 * `fetchOnce` disables redirects (`redirect: "manual"`) so the use-case follows
 * and re-classifies each hop itself; sends no cookies and only a fixed,
 * non-secret User-Agent; and bounds the request with an `AbortSignal` timeout.
 * The body is read through the stream reader and stops once the byte cap is
 * reached, so a huge or endless body never buffers unbounded.
 *
 * DNS-rebinding defense (§8.2): when the use-case supplies `pinnedAddress` — the
 * IP it already resolved AND vetted against the SSRF ranges — the fetch is
 * pinned to that exact address via an undici `Agent` whose `connect.lookup`
 * returns the vetted IP. undici therefore connects to the vetted address
 * instead of re-resolving the hostname, so a host that answers a public IP to
 * `resolve()` and a private IP on connect cannot reach the private IP. The
 * hostname is still used for TLS SNI and the `Host` header; only the connected
 * IP is pinned.
 */
import { lookup } from "node:dns/promises";
import { fetch, Agent } from "undici";
import type { HttpPort, HttpRequest, HttpResponse, ResolvedAddress } from "../entities/ports/http-port.js";

export class FetchHttpAdapter implements HttpPort {
  async resolve(hostname: string): Promise<ResolvedAddress[]> {
    const results = await lookup(hostname, { all: true });
    return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
  }

  async fetchOnce(req: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);

    // Pin the connection to the already-vetted IP (DNS-rebinding defense). The
    // custom lookup short-circuits undici's own resolution, so it connects only
    // to the address the use-case classified as safe.
    let dispatcher: Agent | undefined;
    if (req.pinnedAddress) {
      const pinned = req.pinnedAddress;
      const family = req.pinnedFamily ?? 4;
      dispatcher = new Agent({
        connect: {
          // undici's connect uses a `dns.lookup`-shaped callback. When the
          // caller asks for `all`, it expects an array of `{ address, family }`;
          // otherwise a single `(address, family)` pair. Honour both so the
          // vetted IP is always what undici connects to.
          lookup: (
            _hostname: string,
            options: { all?: boolean | undefined },
            cb: (
              err: NodeJS.ErrnoException | null,
              address: string | { address: string; family: number }[],
              family?: number,
            ) => void,
          ): void => {
            if (options && options.all) {
              cb(null, [{ address: pinned, family }]);
            } else {
              cb(null, pinned, family);
            }
          },
        },
      });
    }

    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      const headers: Record<string, string> = {
        "user-agent": req.userAgent,
        accept: "text/html,text/plain,application/json",
        ...(req.headers ?? {}),
      };
      if (req.contentType) headers["content-type"] = req.contentType;
      res = await fetch(req.url, {
        method: req.method ?? "GET",
        redirect: "manual",
        signal: controller.signal,
        headers,
        ...(req.body !== undefined ? { body: req.body } : {}),
        ...(dispatcher ? { dispatcher } : {}),
      });
    } catch (err) {
      clearTimeout(timer);
      // The request failed before a response; the dispatcher is safe to close.
      await dispatcher?.close().catch(() => undefined);
      throw err;
    }
    clearTimeout(timer);

    const rawType = res.headers.get("content-type");
    const contentType = rawType ? rawType.split(";")[0]!.trim().toLowerCase() : null;
    const location = res.headers.get("location");

    // Close the dispatcher once the response is fully handled: after the body is
    // read, or now if there is no body to stream (a redirect/empty response).
    // Closing earlier would abort the in-flight body stream.
    const body = res.body;
    const closeDispatcher = async (): Promise<void> => {
      await dispatcher?.close().catch(() => undefined);
    };
    if (!body) await closeDispatcher();

    return {
      status: res.status,
      location,
      contentType,
      readBodyCapped: async (maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> => {
        if (!body) return { bytes: new Uint8Array(0), truncated: false };
        const reader = body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        let truncated = false;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            if (total + value.length > maxBytes) {
              chunks.push(value.slice(0, maxBytes - total));
              total = maxBytes;
              truncated = true;
              await reader.cancel().catch(() => undefined);
              break;
            }
            chunks.push(value);
            total += value.length;
          }
        } finally {
          reader.releaseLock?.();
          await closeDispatcher();
        }
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          out.set(c, off);
          off += c.length;
        }
        return { bytes: out, truncated };
      },
    };
  }
}
