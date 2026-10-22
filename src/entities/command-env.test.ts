/**
 * buildCommandEnv tests (core-blueprint.md §8.2 "The environment is explicit
 * state too"): the allowlist is exact, `LC_*` passes by prefix, unset names are
 * omitted, and NO secret-bearing host variable is copied.
 */
import { describe, it, expect } from "vitest";
import { buildCommandEnv } from "./command-env.js";

describe("buildCommandEnv — allowlist (§8.2)", () => {
  it("copies the allowlisted names with the host value when set", () => {
    const host = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/home/alice",
      USER: "alice",
      LOGNAME: "alice",
      SHELL: "/bin/bash",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      TMPDIR: "/tmp",
      TZ: "UTC",
    };
    expect(buildCommandEnv(host)).toEqual(host);
  });

  it("passes LC_* names by prefix (exact, case-sensitive)", () => {
    const env = buildCommandEnv({
      LC_ALL: "C",
      LC_CTYPE: "en_US.UTF-8",
      LANG: "en_US.UTF-8",
    });
    expect(env["LC_ALL"]).toBe("C");
    expect(env["LC_CTYPE"]).toBe("en_US.UTF-8");
    expect(env["LANG"]).toBe("en_US.UTF-8");
  });

  it("does NOT treat a lowercase lc_ or an embedded LC_ as an LC_* name", () => {
    const env = buildCommandEnv({ lc_all: "C", MYLC_X: "y", PATH: "/bin" });
    expect(env["lc_all"]).toBeUndefined();
    expect(env["MYLC_X"]).toBeUndefined();
    expect(env["PATH"]).toBe("/bin");
  });

  it("omits an unset allowlisted name (never sets it to empty string)", () => {
    const env = buildCommandEnv({ PATH: "/bin" });
    expect(env["PATH"]).toBe("/bin");
    expect("HOME" in env).toBe(false);
    expect("TZ" in env).toBe(false);
  });

  it("copies NO secret-bearing host variable", () => {
    const env = buildCommandEnv({
      PATH: "/bin",
      OPENAI_API_KEY: "sk-secret",
      AWS_SECRET_ACCESS_KEY: "abcd",
      AWS_ACCESS_KEY_ID: "AKIA...",
      GITHUB_TOKEN: "ghp_xxx",
      NODE_OPTIONS: "--inspect",
      LD_PRELOAD: "/evil.so",
    });
    expect(env["PATH"]).toBe("/bin");
    expect("OPENAI_API_KEY" in env).toBe(false);
    expect("AWS_SECRET_ACCESS_KEY" in env).toBe(false);
    expect("AWS_ACCESS_KEY_ID" in env).toBe(false);
    expect("GITHUB_TOKEN" in env).toBe(false);
    expect("NODE_OPTIONS" in env).toBe(false);
    expect("LD_PRELOAD" in env).toBe(false);
  });

  it("is pure: returns a fresh object and does not mutate the host", () => {
    const host = { PATH: "/bin" };
    const a = buildCommandEnv(host);
    const b = buildCommandEnv(host);
    expect(a).not.toBe(b);
    expect(a).not.toBe(host);
    a["PATH"] = "/mutated";
    expect(host["PATH"]).toBe("/bin");
  });
});
