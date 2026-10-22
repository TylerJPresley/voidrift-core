/**
 * The plugin registry HTTP adapter (core-blueprint.md §12.4.1).
 *
 * The one implementation of `PluginRegistryPort`, over Node's global `fetch`
 * (undici) — no new dependency. It does a single GET with an `AbortSignal`
 * timeout and reads the body through the stream reader, stopping once the byte
 * cap is reached so an oversized or endless response never buffers unbounded
 * (the use-case then degrades to the last cached page, §12.4.1). It NEVER
 * throws: a transport failure (offline, DNS, timeout) returns
 * `{ errored: true }`, a `429` returns its status for the use-case to degrade,
 * and an over-cap body returns `{ tooLarge: true }`. No cookies or credentials
 * are sent; only a fixed, non-secret User-Agent and an npm `Accept` header.
 * Redirects are followed manually and only within the originally requested
 * origin: a cross-origin hop is refused (`{ errored: true }`), so a malicious
 * registry cannot bounce the fetch to an attacker host (L1).
 */
import { fetch } from "undici";
import type { PluginRegistryPort, RegistryFetchResult } from "../entities/ports/plugin-registry-port.js";

const USER_AGENT = "voidrift-plugin-registry";
const ACCEPT = "application/vnd.npm.install-v1+json, application/json";

export class PluginRegistryClient implements PluginRegistryPort {
  async get(url: string, opts: { timeoutMs: number; maxBytes: number }): Promise<RegistryFetchResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const origin = new URL(url).origin;
      let current = url;
      let res: Awaited<ReturnType<typeof fetch>> | undefined;
      // Follow redirects manually (L1): a hop that leaves the originally
      // requested origin is refused, so a malicious registry cannot bounce the
      // fetch to an attacker host. Credentials are never sent regardless.
      for (let hops = 0; hops <= 5; hops++) {
        res = await fetch(current, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { "user-agent": USER_AGENT, accept: ACCEPT },
        });
        if (res.status < 300 || res.status >= 400) break;
        const location = res.headers.get("location");
        if (!location) break;
        const next = new URL(location, current);
        if (next.origin !== origin) {
          // Off-origin redirect — refuse rather than follow.
          return { status: 0, body: "", tooLarge: false, errored: true };
        }
        current = next.toString();
      }
      if (!res) return { status: 0, body: "", tooLarge: false, errored: true };
      const body = res.body;
      if (!body) return { status: res.status, body: "", tooLarge: false, errored: false };
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      let tooLarge = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          if (total + value.length > opts.maxBytes) {
            tooLarge = true;
            await reader.cancel().catch(() => undefined);
            break;
          }
          chunks.push(value);
          total += value.length;
        }
      } finally {
        reader.releaseLock?.();
      }
      if (tooLarge) return { status: res.status, body: "", tooLarge: true, errored: false };
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      return { status: res.status, body: new TextDecoder().decode(out), tooLarge: false, errored: false };
    } catch {
      // Offline, DNS failure, abort/timeout — degrade, never throw (§12.4.1).
      return { status: 0, body: "", tooLarge: false, errored: true };
    } finally {
      clearTimeout(timer);
    }
  }
}
