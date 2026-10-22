/**
 * Warden policy-engine unit tests (core-blueprint.md §9.6).
 *
 * Clause → test map:
 *  - modes recognized + status reports version/hash/source → "status"
 *  - deterministic rule blocks via the shared glob matcher, recording
 *    version+hash+rule → "deterministic block"
 *  - enforcing blocks a violating action, permissive logs+allows the SAME action
 *    → "enforcing vs permissive"
 *  - a judge verdict decides an outcome (pass→allow, fail→block) → "judge verdict"
 *  - an unreachable judge FAILS when enforcing, logs-allow when permissive
 *    → "unreachable judge"
 *  - no-policy enforcing fails closed → "fail-closed"
 *  - decisions audit populated → asserted across the above
 *  - policy cached with version/hash → "loadPolicy hash"
 *
 * Deterministic and offline: an in-memory JudgePort stands in for the MCP Judge.
 */
import { describe, it, expect } from "vitest";
import {
  Warden,
  loadPolicy,
  type JudgePort,
  type JudgeVerdict,
  type WardenEvents,
} from "./warden.js";

interface RecordingEvents {
  events: WardenEvents;
  loaded: unknown[];
  violation: unknown[];
  blocked: unknown[];
}

function recordingEvents(): RecordingEvents {
  const loaded: unknown[] = [];
  const violation: unknown[] = [];
  const blocked: unknown[] = [];
  const events: WardenEvents = {
    loaded: (p) => void loaded.push(p),
    violation: (p) => void violation.push(p),
    blocked: (p) => void blocked.push(p),
  };
  return { events, loaded, violation, blocked };
}

const passJudge: JudgePort = {
  check: async (): Promise<JudgeVerdict> => ({ type: "check", pass: true, probability: 0.99 }),
};
const failJudge: JudgePort = {
  check: async (): Promise<JudgeVerdict> => ({ type: "check", pass: false, probability: 0.1 }),
};
const unreachableJudge: JudgePort = {
  check: async (): Promise<JudgeVerdict> => {
    throw new Error("unreachable");
  },
};

describe("Warden policy engine (§9.6)", () => {
  it("loadPolicy records a version and content hash (cache/script principle)", () => {
    const p = loadPolicy({ version: "1.0", rules: [{ match: "**/*.env", effect: "block" }] });
    expect(p.version).toBe("1.0");
    expect(p.hash).toMatch(/^[0-9a-f]{16}$/);
    // Same content → same hash; different content → different hash.
    const same = loadPolicy({ version: "1.0", rules: [{ match: "**/*.env", effect: "block" }] });
    expect(same.hash).toBe(p.hash);
    const diff = loadPolicy({ version: "1.0", rules: [{ match: "**/*.key", effect: "block" }] });
    expect(diff.hash).not.toBe(p.hash);
  });

  it("status reports mode, version/hash, and source", () => {
    const w = new Warden({ mode: "enforcing", source: "dir:///policy" });
    expect(w.status()).toEqual({ mode: "enforcing", version: null, hash: null, source: "dir:///policy" });
    w.setPolicy(loadPolicy({ version: "2.1", rules: [] }));
    const s = w.status();
    expect(s.version).toBe("2.1");
    expect(s.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(s.source).toBe("dir:///policy");
  });

  it("off allows every call regardless of policy", async () => {
    const w = new Warden({ mode: "off", source: "x" });
    w.setPolicy(loadPolicy({ version: "1", rules: [{ match: "*", kind: "tool", effect: "block" }] }));
    expect((await w.evaluate({ tool: "write_file", args: {} })).effect).toBe("allow");
  });

  it("deterministic block: a path rule blocks via the shared glob matcher and records version+hash+rule", async () => {
    const ev = recordingEvents();
    const w = new Warden({ mode: "enforcing", source: "x" }, null, ev.events);
    w.setPolicy(loadPolicy({ version: "1.0", rules: [{ match: "**/*.env", kind: "path", effect: "block" }] }));
    const out = await w.evaluate({ tool: "write_file", args: { path: "config/secrets.env" } });
    expect(out.effect).toBe("block");
    expect(out.version).toBe("1.0");
    expect(out.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(out.rule).toBe("**/*.env");
    expect(ev.blocked).toHaveLength(1);
    const audit = w.decisions();
    expect(audit[0]).toMatchObject({ action: "write_file", effect: "blocked", rule: "**/*.env", version: "1.0" });
  });

  it("deterministic allow: a matching allow rule passes with version/hash", async () => {
    const w = new Warden({ mode: "enforcing", source: "x" });
    w.setPolicy(loadPolicy({ version: "1", rules: [{ match: "read_file", kind: "tool", effect: "allow" }] }));
    const out = await w.evaluate({ tool: "read_file", args: { path: "a.txt" } });
    expect(out.effect).toBe("allow");
    expect(out.rule).toBe("read_file");
  });

  it("no matching rule allows", async () => {
    const w = new Warden({ mode: "enforcing", source: "x" });
    w.setPolicy(loadPolicy({ version: "1", rules: [{ match: "**/*.env", kind: "path", effect: "block" }] }));
    expect((await w.evaluate({ tool: "write_file", args: { path: "a.txt" } })).effect).toBe("allow");
  });

  it("enforcing vs permissive: the SAME violating action blocks under enforcing, logs+allows under permissive", async () => {
    const rules = [{ match: "**/*.env", kind: "path" as const, effect: "block" as const }];
    const call = { tool: "write_file", args: { path: "dir/a.env" } };

    const evEnf = recordingEvents();
    const enf = new Warden({ mode: "enforcing", source: "x" }, null, evEnf.events);
    enf.setPolicy(loadPolicy({ version: "1", rules }));
    expect((await enf.evaluate(call)).effect).toBe("block");
    expect(evEnf.blocked).toHaveLength(1);
    expect(enf.decisions()[0]!.effect).toBe("blocked");

    const evPerm = recordingEvents();
    const perm = new Warden({ mode: "permissive", source: "x" }, null, evPerm.events);
    perm.setPolicy(loadPolicy({ version: "1", rules }));
    expect((await perm.evaluate(call)).effect).toBe("allow");
    expect(evPerm.violation).toHaveLength(1);
    expect(perm.decisions()[0]!.effect).toBe("violation");
  });

  it("judge verdict decides an outcome: pass→allow, fail→block", async () => {
    const rule = {
      match: "write_file",
      kind: "tool" as const,
      effect: "block" as const,
      judge: { criterionId: "gov", instructions: "meets governance" },
    };
    const pass = new Warden({ mode: "enforcing", source: "x" }, passJudge);
    pass.setPolicy(loadPolicy({ version: "1", rules: [rule] }));
    expect((await pass.evaluate({ tool: "write_file", args: { path: "main.tf" } })).effect).toBe("allow");

    const fail = new Warden({ mode: "enforcing", source: "x" }, failJudge);
    fail.setPolicy(loadPolicy({ version: "1", rules: [rule] }));
    const out = await fail.evaluate({ tool: "write_file", args: { path: "main.tf" } });
    expect(out.effect).toBe("block");
    expect(out.reason).toContain("judge verdict");
  });

  it("unreachable judge FAILS when enforcing and logs-allows when permissive", async () => {
    const rule = {
      match: "write_file",
      kind: "tool" as const,
      effect: "block" as const,
      judge: { criterionId: "gov", instructions: "meets governance" },
    };
    const enf = new Warden({ mode: "enforcing", source: "x" }, unreachableJudge);
    enf.setPolicy(loadPolicy({ version: "1", rules: [rule] }));
    const blocked = await enf.evaluate({ tool: "write_file", args: {} });
    expect(blocked.effect).toBe("block");
    expect(blocked.reason).toContain("judge unavailable");

    const perm = new Warden({ mode: "permissive", source: "x" }, unreachableJudge);
    perm.setPolicy(loadPolicy({ version: "1", rules: [rule] }));
    expect((await perm.evaluate({ tool: "write_file", args: {} })).effect).toBe("allow");
    expect(perm.decisions()[0]!.effect).toBe("violation");
  });

  it("fail-closed: enforcing with a configured source but no loaded policy denies every gated action", async () => {
    const w = new Warden({ mode: "enforcing", source: "dir:///policy" });
    // No setPolicy → nothing loaded.
    const out = await w.evaluate({ tool: "write_file", args: { path: "a.txt" } });
    expect(out.effect).toBe("block");
    expect(out.reason).toContain("fail-closed");
    expect(w.decisions()[0]!.rule).toBe("(no-policy)");
  });

  it("permissive with no loaded policy allows (fail-closed is enforcing-only)", async () => {
    const w = new Warden({ mode: "permissive", source: "dir:///policy" });
    expect((await w.evaluate({ tool: "write_file", args: {} })).effect).toBe("allow");
  });

  it("policies() and policyText() expose the loaded set and protected-context text", () => {
    const w = new Warden({ mode: "permissive", source: "x" });
    expect(w.policies()).toEqual({ rules: [], judgeConfigured: false });
    expect(w.policyText()).toBeNull();
    w.setPolicy(loadPolicy({ version: "1", rules: [{ match: "x", effect: "block" }], text: "No secrets." }));
    expect(w.policies().rules).toHaveLength(1);
    expect(w.policyText()).toBe("No secrets.");
  });

  it("setPolicy emits COMPLIANCE_LOADED with version/source/mode", () => {
    const ev = recordingEvents();
    const w = new Warden({ mode: "enforcing", source: "dir:///p" }, null, ev.events);
    w.setPolicy(loadPolicy({ version: "9", rules: [] }));
    expect(ev.loaded).toEqual([{ version: "9", source: "dir:///p", mode: "enforcing" }]);
  });

  it("configure replaces the mode and default match value resolves command then url", async () => {
    const w = new Warden({ mode: "off" });
    w.configure({ mode: "enforcing", source: "x" });
    // Default-kind rule matches a command arg.
    w.setPolicy(loadPolicy({ version: "1", rules: [{ match: "rm *", effect: "block" }] }));
    expect((await w.evaluate({ tool: "execute_command", args: { command: "rm -rf x" } })).effect).toBe("block");
    // Default-kind rule matches a url arg.
    const u = new Warden({ mode: "enforcing", source: "x" });
    u.setPolicy(loadPolicy({ version: "1", rules: [{ match: "https://evil*", effect: "block" }] }));
    expect((await u.evaluate({ tool: "fetch", args: { url: "https://evil.example" } })).effect).toBe("block");
  });

  it("a judge rule with no judge wired is treated like an unreachable judge", async () => {
    const w = new Warden({ mode: "enforcing", source: "x" }, null);
    w.setPolicy(
      loadPolicy({
        version: "1",
        rules: [{ match: "write_file", kind: "tool", effect: "block", judge: { criterionId: "g", instructions: "ok" } }],
      }),
    );
    const out = await w.evaluate({ tool: "write_file", args: {} });
    expect(out.effect).toBe("block");
    expect(out.reason).toContain("no judge configured");
  });

  it("setPolicy(null) clears the policy and emits nothing", () => {
    const ev = recordingEvents();
    const w = new Warden({ mode: "enforcing", source: "x" }, null, ev.events);
    w.setPolicy(null);
    expect(ev.loaded).toHaveLength(0);
    expect(w.status().version).toBeNull();
  });
});
