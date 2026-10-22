/**
 * Hardened git invocation — unit tests (security-audit S2).
 *
 * The argv/env builders and the value-free repo-config scanner, tested in
 * isolation (no git process). The integration proof — that a MALICIOUS repo's
 * config/attributes never execute while VCS operations still succeed — lives in
 * `vcs.hardening.test.ts` against a real temp git repo.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { hardenedGitArgs, hardenedGitEnv, scanRepoConfig, type GitConfigScan } from "./git-harden.js";

const EMPTY: GitConfigScan = { classes: [], filterNames: [], files: [] };

describe("hardenedGitArgs", () => {
  it("prepends the fixed neutralising -c overrides before the caller's args", () => {
    const argv = hardenedGitArgs(["status", "--porcelain"], EMPTY, true);
    const joined = argv.join(" ");
    for (const kv of [
      "core.fsmonitor=false",
      "core.hooksPath=",
      "core.sshCommand=",
      "core.pager=cat",
      "core.editor=true",
      "diff.external=",
      "protocol.ext.allow=never",
      "protocol.file.allow=user",
      "credential.helper=",
      "gpg.program=false",
      "commit.gpgsign=false",
      "merge.verifySignatures=false",
    ]) {
      expect(joined).toContain(`-c ${kv}`);
    }
    // The caller's verb and args survive, in order, after the overrides.
    expect(argv.slice(-2)).toEqual(["status", "--porcelain"]);
  });

  it("adds --no-ext-diff --no-textconv right after a diff-shaped verb only", () => {
    const diff = hardenedGitArgs(["diff", "HEAD", "--", "a.txt"], EMPTY, true);
    const i = diff.indexOf("diff");
    expect(diff[i + 1]).toBe("--no-ext-diff");
    expect(diff[i + 2]).toBe("--no-textconv");
    expect(diff.slice(i + 3)).toEqual(["HEAD", "--", "a.txt"]);
    // A non-diff verb gets no such flags.
    const status = hardenedGitArgs(["status"], EMPTY, true);
    expect(status).not.toContain("--no-ext-diff");
  });

  it("injects a neutral identity ONLY when none resolves", () => {
    const withId = hardenedGitArgs(["merge", "x"], EMPTY, true).join(" ");
    expect(withId).not.toContain("user.name=VoidRift");
    const noId = hardenedGitArgs(["merge", "x"], EMPTY, false).join(" ");
    expect(noId).toContain("-c user.name=VoidRift");
    expect(noId).toContain("-c user.email=voidrift@localhost");
  });

  it("clears each scanned filter driver by name", () => {
    const scan: GitConfigScan = { classes: ["filter"], filterNames: ["lfs", "secret"], files: [] };
    const argv = hardenedGitArgs(["checkout", "."], scan, true).join(" ");
    for (const n of ["lfs", "secret"]) {
      expect(argv).toContain(`-c filter.${n}.clean=`);
      expect(argv).toContain(`-c filter.${n}.smudge=`);
      expect(argv).toContain(`-c filter.${n}.process=`);
      expect(argv).toContain(`-c filter.${n}.required=false`);
    }
  });
});

describe("hardenedGitEnv", () => {
  it("sets the neutralising GIT_* vars and unsets every program-hook var", () => {
    const base: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      GIT_EXTERNAL_DIFF: "/evil",
      GIT_ASKPASS: "/evil",
      GIT_SSH_COMMAND: "/evil",
      GIT_PROXY_COMMAND: "/evil",
    };
    const env = hardenedGitEnv(base);
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_PAGER).toBe("cat");
    expect(env.GIT_EDITOR).toBe("true");
    expect(env.GIT_ATTR_NOSYSTEM).toBe("1");
    expect(env.PATH).toBe("/usr/bin"); // base preserved
    expect(env.GIT_EXTERNAL_DIFF).toBeUndefined();
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
    expect(env.GIT_PROXY_COMMAND).toBeUndefined();
    // GIT_CONFIG_GLOBAL is deliberately NOT cleared (merge needs the identity).
    expect("GIT_CONFIG_GLOBAL" in env).toBe(false);
  });
});

describe("scanRepoConfig", () => {
  it("finds every executable-capable key class and the filter names, value-free", async () => {
    const dir = hermeticTmp("scan");
    try {
      fs.mkdirSync(path.join(dir, ".git"));
      fs.writeFileSync(
        path.join(dir, ".git", "config"),
        [
          "[core]",
          "\tfsmonitor = /tmp/evil.sh",
          "\tsshCommand = /tmp/evil.sh",
          "\thooksPath = /tmp/hooks",
          "\tpager = /tmp/evil.sh",
          "\teditor = /tmp/evil.sh",
          '[diff "d"]',
          "\ttextconv = /tmp/evil.sh",
          "[diff]",
          "\texternal = /tmp/evil.sh",
          '[filter "lfs"]',
          "\tsmudge = /tmp/evil.sh",
          "\tclean = /tmp/evil.sh",
          "[credential]",
          "\thelper = /tmp/evil.sh",
          "[gpg]",
          "\tprogram = /tmp/evil.sh",
          "; a comment with core.fsmonitor should be ignored",
        ].join("\n"),
      );
      const scan = scanRepoConfig(dir);
      expect(scan.classes).toEqual(
        expect.arrayContaining([
          "core.fsmonitor",
          "core.sshCommand",
          "core.hooksPath",
          "core.pager",
          "core.editor",
          "diff.external",
          "diff.textconv",
          "filter",
          "credential",
          "gpg",
        ]),
      );
      expect(scan.filterNames).toContain("lfs");
      expect(scan.files.some((f) => f.endsWith(path.join(".git", "config")))).toBe(true);
      // Value-free: no config VALUE leaks into the scan result.
      expect(JSON.stringify(scan)).not.toContain("evil.sh");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns empty for a clean repo and for a missing config", async () => {
    const dir = hermeticTmp("scan");
    try {
      expect(scanRepoConfig(dir)).toEqual({ classes: [], filterNames: [], files: [] });
      fs.mkdirSync(path.join(dir, ".git"));
      fs.writeFileSync(path.join(dir, ".git", "config"), "[core]\n\tbare = false\n\trepositoryformatversion = 0\n");
      const scan = scanRepoConfig(dir);
      expect(scan.classes).toEqual([]);
      expect(scan.filterNames).toEqual([]);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
