/**
 * Exact-allow entity + schema validation tests (owner D2a). Covers CIDR
 * validation (accepts/rejects), CIDR containment (v4/v6/IPv4-mapped/boundary),
 * the exact match value per tool, the force-ask lift decision, and the strict
 * `PermissionRuleSchema` `exact`/`cidr` validation.
 */
import { describe, it, expect } from "vitest";
import {
  validateCidr,
  cidrContainsHost,
  exactMatchValue,
  forceAskLiftedByExact,
} from "./exact-allow.js";
import { PermissionRuleSchema, type PermissionRule } from "../config/schema.js";

describe("validateCidr (owner D2a.1b)", () => {
  it("accepts a sane IPv4 and IPv6 range", () => {
    expect("cidr" in validateCidr("10.0.0.0/8")).toBe(true);
    expect("cidr" in validateCidr("192.168.0.0/16")).toBe(true);
    expect("cidr" in validateCidr("fd00::/16")).toBe(true);
    expect("cidr" in validateCidr("fc00::/7".replace("/7", "/16"))).toBe(true);
  });

  it("rejects malformed, too-broad, and sub-minimum prefixes", () => {
    expect("error" in validateCidr("not-a-cidr")).toBe(true);
    expect("error" in validateCidr("10.0.0.0")).toBe(true); // no prefix
    expect("error" in validateCidr("0.0.0.0/0")).toBe(true);
    expect("error" in validateCidr("::/0")).toBe(true);
    expect("error" in validateCidr("10.0.0.0/4")).toBe(true); // < /8
    expect("error" in validateCidr("fd00::/8")).toBe(true); // < /16
    expect("error" in validateCidr("10.0.0.0/33")).toBe(true); // out of range
    expect("error" in validateCidr("10.1.2.3/8")).toBe(true); // host bits set
  });
});

describe("cidrContainsHost (owner D2a.1b)", () => {
  const v4 = validateCidr("10.0.0.0/8");
  const v6 = validateCidr("fd00::/16");
  it("v4 inside/outside", () => {
    expect("cidr" in v4).toBe(true);
    if ("cidr" in v4) {
      expect(cidrContainsHost(v4.cidr, "10.1.2.3")).toBe(true);
      expect(cidrContainsHost(v4.cidr, "10.255.255.255")).toBe(true); // boundary
      expect(cidrContainsHost(v4.cidr, "11.0.0.0")).toBe(false);
      expect(cidrContainsHost(v4.cidr, "example.com")).toBe(false); // a name never matches
    }
  });
  it("v6 inside/outside", () => {
    expect("cidr" in v6).toBe(true);
    if ("cidr" in v6) {
      expect(cidrContainsHost(v6.cidr, "fd00::1")).toBe(true);
      expect(cidrContainsHost(v6.cidr, "fe80::1")).toBe(false);
    }
  });
  it("IPv4-mapped IPv6 is contained by a v4 range", () => {
    if ("cidr" in v4) {
      expect(cidrContainsHost(v4.cidr, "::ffff:10.1.2.3")).toBe(true);
      expect(cidrContainsHost(v4.cidr, "::ffff:11.0.0.0")).toBe(false);
    }
  });
});

describe("exactMatchValue (owner D2a.1a)", () => {
  it("whole command for execute_command, trimmed", () => {
    expect(exactMatchValue("execute_command", { command: "  git push --force  " })).toBe("git push --force");
  });
  it("name@version for plugins_install", () => {
    expect(exactMatchValue("plugins_install", { name: "@voidrift/plugin-x@1.2.3" })).toBe("@voidrift/plugin-x@1.2.3");
  });
  it("lower-cased host for web_fetch, port ignored", () => {
    expect(exactMatchValue("web_fetch", { url: "http://127.0.0.1:8080/x" })).toBe("127.0.0.1");
    expect(exactMatchValue("web_fetch", { url: "http://LocalHost:9/x" })).toBe("localhost");
  });
  it("endpoint host for web_search", () => {
    expect(exactMatchValue("web_search", { webSearchEndpoint: "http://10.0.0.5:8888/search" })).toBe("10.0.0.5");
  });
});

describe("forceAskLiftedByExact (owner D2a.2)", () => {
  const exactShell: PermissionRule = {
    tool: "execute_command",
    pattern: "git push --force",
    exact: true,
    decision: "allow",
    priority: 0,
    source: "workspace",
  };
  it("an exact rule lifts the matching shell force-ask", () => {
    const call = { tool: "execute_command", args: { command: "git push --force" } };
    expect(forceAskLiftedByExact(call, [exactShell], "shell")).toBe(true);
  });
  it("whitespace is trimmed only — an appended command no longer matches (D2a.3)", () => {
    expect(forceAskLiftedByExact({ tool: "execute_command", args: { command: "  git push --force  " } }, [exactShell], "shell")).toBe(true);
    expect(forceAskLiftedByExact({ tool: "execute_command", args: { command: "git push --force; rm -rf x" } }, [exactShell], "shell")).toBe(false);
  });
  it("an exact `*` in the pattern is LITERAL, not a glob", () => {
    const starRule: PermissionRule = { tool: "execute_command", pattern: "git push *", exact: true, decision: "allow", priority: 0, source: "workspace" };
    expect(forceAskLiftedByExact({ tool: "execute_command", args: { command: "git push *" } }, [starRule], "shell")).toBe(true);
    expect(forceAskLiftedByExact({ tool: "execute_command", args: { command: "git push --force" } }, [starRule], "shell")).toBe(false);
  });
  it("a non-exact wildcard rule NEVER lifts", () => {
    const glob: PermissionRule = { tool: "*", decision: "allow", priority: 500, source: "user" };
    const glob2: PermissionRule = { tool: "execute_command", pattern: "git push*", decision: "allow", priority: 500, source: "user" };
    const call = { tool: "execute_command", args: { command: "git push --force" } };
    expect(forceAskLiftedByExact(call, [glob], "shell")).toBe(false);
    expect(forceAskLiftedByExact(call, [glob2], "shell")).toBe(false);
  });
  it("a cidr rule lifts a matching ssrf host; outside does not", () => {
    const cidr: PermissionRule = { tool: "web_fetch", cidr: "10.0.0.0/8", decision: "allow", priority: 0, source: "workspace" };
    expect(forceAskLiftedByExact({ tool: "web_fetch", args: { url: "http://10.1.2.3/" } }, [cidr], "ssrf")).toBe(true);
    expect(forceAskLiftedByExact({ tool: "web_fetch", args: { url: "http://192.168.0.1/" } }, [cidr], "ssrf")).toBe(false);
  });
  it("an exact host rule lifts a matching ssrf host", () => {
    const host: PermissionRule = { tool: "web_fetch", pattern: "127.0.0.1", exact: true, decision: "allow", priority: 0, source: "workspace" };
    expect(forceAskLiftedByExact({ tool: "web_fetch", args: { url: "http://127.0.0.1:9/x" } }, [host], "ssrf")).toBe(true);
    expect(forceAskLiftedByExact({ tool: "web_fetch", args: { url: "http://127.0.0.2:9/x" } }, [host], "ssrf")).toBe(false);
  });
  it("an exact name@version lifts plugin-install", () => {
    const pv: PermissionRule = { tool: "plugins_install", pattern: "@v/p@1.0.0", exact: true, decision: "allow", priority: 0, source: "workspace" };
    expect(forceAskLiftedByExact({ tool: "plugins_install", args: { name: "@v/p@1.0.0" } }, [pv], "plugin-install")).toBe(true);
    expect(forceAskLiftedByExact({ tool: "plugins_install", args: { name: "@v/p@2.0.0" } }, [pv], "plugin-install")).toBe(false);
  });
});

describe("PermissionRuleSchema exact/cidr validation (owner D2a.1)", () => {
  it("accepts an exact allow rule", () => {
    const r = PermissionRuleSchema.safeParse({ tool: "execute_command", pattern: "git push --force", exact: true, decision: "allow", priority: 0, source: "workspace" });
    expect(r.success).toBe(true);
  });
  it("accepts a cidr rule on a network tool / allow", () => {
    const r = PermissionRuleSchema.safeParse({ tool: "web_fetch", cidr: "10.0.0.0/8", decision: "allow", priority: 0, source: "workspace" });
    expect(r.success).toBe(true);
  });
  it("rejects cidr on a non-allow rule", () => {
    const r = PermissionRuleSchema.safeParse({ tool: "web_fetch", cidr: "10.0.0.0/8", decision: "deny", priority: 0, source: "workspace" });
    expect(r.success).toBe(false);
  });
  it("rejects cidr on a non-network tool", () => {
    const r = PermissionRuleSchema.safeParse({ tool: "execute_command", cidr: "10.0.0.0/8", decision: "allow", priority: 0, source: "workspace" });
    expect(r.success).toBe(false);
  });
  it("rejects a malformed/too-broad cidr", () => {
    expect(PermissionRuleSchema.safeParse({ tool: "web_fetch", cidr: "0.0.0.0/0", decision: "allow", priority: 0, source: "workspace" }).success).toBe(false);
    expect(PermissionRuleSchema.safeParse({ tool: "web_fetch", cidr: "nope", decision: "allow", priority: 0, source: "workspace" }).success).toBe(false);
  });
  it("rejects exact:true with no pattern", () => {
    const r = PermissionRuleSchema.safeParse({ tool: "execute_command", exact: true, decision: "allow", priority: 0, source: "workspace" });
    expect(r.success).toBe(false);
  });
  it("rejects an unknown field (still strict)", () => {
    const r = PermissionRuleSchema.safeParse({ tool: "x", decision: "allow", priority: 0, source: "workspace", bogus: 1 });
    expect(r.success).toBe(false);
  });
});
