/**
 * URL classification table — the SSRF force-ask adversary (core-blueprint.md
 * §8.2, §9.3 last paragraph, §15.1 invariant 5).
 *
 * `classifyUrl` normalizes the host with the WHATWG parser FIRST and classifies
 * the PARSED host, so userinfo tricks, percent-encoding, IDN, bracketed IPv6,
 * and obfuscated IPv4 (decimal/hex/octal/short) cannot smuggle a private target
 * past the gate. Every private/loopback/link-local/metadata/unspecified/CGNAT/
 * v4-mapped form MUST be `force-ask`; public hosts `allow`; bad schemes `reject`.
 */
import { describe, it, expect } from "vitest";
import { classifyUrl, classifyHost } from "./url-classifier.js";

const FORCE_ASK: string[] = [
  // loopback
  "http://127.0.0.1/",
  "http://127.0.0.1:8080/x",
  "https://localhost/",
  "http://localhost:3000/admin",
  "http://sub.localhost/",
  "http://127.1/", // short form → 127.0.0.1
  "http://127.0.0.1./", // trailing dot
  "http://2130706433/", // decimal
  "http://0x7f000001/", // hex
  "http://0177.0.0.1/", // octal first octet
  "http://[::1]/", // IPv6 loopback
  "http://[::ffff:127.0.0.1]/", // IPv4-mapped loopback
  // private
  "http://10.0.0.5/",
  "http://10.255.255.255/",
  "http://172.16.0.1/",
  "http://172.31.255.1/",
  "http://192.168.1.1/",
  "http://[fc00::1]/",
  "http://[fd12:3456::1]/",
  "http://[::ffff:10.0.0.5]/", // v4-mapped private
  // link-local + cloud metadata
  "http://169.254.0.1/",
  "http://169.254.169.254/latest/meta-data/", // AWS/GCP metadata
  "http://[fe80::1]/",
  // unspecified
  "http://0.0.0.0/",
  "http://[::]/",
  // CGNAT
  "http://100.64.0.1/",
  "http://100.127.255.255/",
  // userinfo trick: the real host is the loopback, not evil.com
  "http://evil.com@127.0.0.1/",
  "http://user:pass@10.0.0.1/",
  // this-network 0.0.0.0/8
  "http://0.1.2.3/",
];

const PUBLIC: string[] = [
  "https://example.com/",
  "http://example.com/path?q=1",
  "https://api.github.com/repos",
  "https://1.1.1.1/",
  "https://8.8.8.8/",
  "http://93.184.216.34/", // example.com public IP
  "https://[2606:4700:4700::1111]/", // Cloudflare public IPv6
  "https://subdomain.example.co.uk/a/b",
  "http://100.63.255.255/", // just below CGNAT range → public
  "http://172.32.0.1/", // just above 172.16/12 → public
];

const REJECT: string[] = [
  "file:///etc/passwd",
  "ftp://example.com/f",
  "gopher://127.0.0.1/",
  "data:text/html,<script>alert(1)</script>",
  "javascript:alert(1)",
  "not a url",
];

describe("classifyUrl SSRF table (§8.2, §9.3)", () => {
  it.each(FORCE_ASK)("force-ask: %s", (url) => {
    expect(classifyUrl(url).verdict).toBe("force-ask");
  });

  it.each(PUBLIC)("public → allow: %s", (url) => {
    expect(classifyUrl(url).verdict).toBe("allow");
  });

  it.each(REJECT)("bad scheme / unparseable → reject: %s", (url) => {
    expect(classifyUrl(url).verdict).toBe("reject");
  });

  it("classifyHost catches a bare resolved private address (DNS re-check seam)", () => {
    expect(classifyHost("10.0.0.5").verdict).toBe("force-ask");
    expect(classifyHost("169.254.169.254").verdict).toBe("force-ask");
    expect(classifyHost("93.184.216.34").verdict).toBe("allow");
  });

  it("the metadata address carries a link-local reason", () => {
    expect(classifyUrl("http://169.254.169.254/").reason).toBe("link-local");
  });
});
