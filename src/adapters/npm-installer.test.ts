import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scrubEnv, createNpmrcDir, NpmInstallerAdapter } from "./npm-installer.js";

const REVIEWED_REGISTRY = "https://registry.npmjs.org/";

/** A private per-call npmrc dir, as the installer makes before scrubbing. */
function withNpmrcDir(): { dir: string; cleanup: () => void } {
  const dir = createNpmrcDir(os.tmpdir());
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe("npm-installer scrubEnv (§12.4.1)", () => {
  let npmrc: { dir: string; cleanup: () => void };
  beforeEach(() => (npmrc = withNpmrcDir()));
  afterEach(() => npmrc.cleanup());

  it("drops every inherited secret/token and forwards only what npm needs", () => {
    const source: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/u",
      LANG: "en_US.UTF-8",
      NODE_OPTIONS: "--max-old-space-size=512",
      // secrets — must NOT be forwarded
      VOIDRIFT_SENTINEL_SECRET: "do-not-leak",
      GITHUB_TOKEN: "ghp_xxx",
      NPM_TOKEN: "npm_xxx",
      AWS_SECRET_ACCESS_KEY: "aws",
      MY_API_KEY: "k",
      OPENAI_API_KEY: "sk-xxx",
      DATABASE_PASSWORD: "pw",
    };
    const scrubbed = scrubEnv(source, REVIEWED_REGISTRY, npmrc.dir);
    // Forwarded essentials:
    expect(scrubbed["PATH"]).toBe("/usr/bin");
    expect(scrubbed["HOME"]).toBe("/home/u");
    expect(scrubbed["LANG"]).toBe("en_US.UTF-8");
    expect(scrubbed["NODE_OPTIONS"]).toBe("--max-old-space-size=512");
    // Non-interactive hardening:
    expect(scrubbed["npm_config_audit"]).toBe("false");
    expect(scrubbed["npm_config_fund"]).toBe("false");
    // Every secret dropped:
    for (const leak of [
      "VOIDRIFT_SENTINEL_SECRET",
      "GITHUB_TOKEN",
      "NPM_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "MY_API_KEY",
      "OPENAI_API_KEY",
      "DATABASE_PASSWORD",
    ]) {
      expect(scrubbed[leak]).toBeUndefined();
    }
    // Default-drop: an unknown variable is never forwarded.
    expect(scrubEnv({ SOMETHING_NEW: "x" }, REVIEWED_REGISTRY, npmrc.dir)["SOMETHING_NEW"]).toBeUndefined();
  });

  it("M1: drops auth/registry-bearing npm_config_* keys that could retarget the scoped fetch or leak a token", () => {
    const source: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      // a scoped registry override + env-form scoped auth token (the attack)
      "npm_config_@voidrift:registry": "https://evil.example",
      "npm_config_//evil.example/:_authToken": "secret-token",
      "npm_config_//registry.npmjs.org/:_authToken": "npmjs-token",
      npm_config_registry: "https://evil.example",
      npm_config__auth: "base64creds",
      npm_config__authToken: "tok",
      npm_config_username: "u",
      npm_config__password: "p",
      npm_config_token: "t",
      // benign npm config still forwarded
      npm_config_cache: "/tmp/npm-cache",
    };
    const scrubbed = scrubEnv(source, REVIEWED_REGISTRY, npmrc.dir);
    for (const key of Object.keys(scrubbed)) {
      const low = key.toLowerCase();
      expect(low).not.toContain(":_authtoken");
      expect(low).not.toContain("_auth");
      expect(low).not.toContain("_password");
      expect(low).not.toContain("username");
      expect(low).not.toContain("token");
      // no scoped/global registry override survives except the one we set
      if (low.includes("registry")) expect(key).toBe("npm_config_registry");
      // no raw //host/ auth entries
      expect(key).not.toContain("//");
    }
    // the benign config is kept
    expect(scrubbed["npm_config_cache"]).toBe("/tmp/npm-cache");
    // registry is pinned explicitly to the reviewed one, overriding any inherited value
    expect(scrubbed["npm_config_registry"]).toBe(REVIEWED_REGISTRY);
  });

  it("M2: pins userconfig/globalconfig to distinct empty files inside the private dir", () => {
    const scrubbed = scrubEnv({ PATH: "/usr/bin", HOME: "/home/u" }, REVIEWED_REGISTRY, npmrc.dir);
    const userConf = scrubbed["npm_config_userconfig"]!;
    const globalConf = scrubbed["npm_config_globalconfig"]!;
    expect(userConf).toBeDefined();
    expect(globalConf).toBeDefined();
    expect(userConf).not.toBe(globalConf);
    // Both live inside the private per-install dir, not at a predictable path.
    expect(path.dirname(userConf)).toBe(npmrc.dir);
    expect(path.dirname(globalConf)).toBe(npmrc.dir);
    // The files exist, are empty, and are mode 0600.
    for (const p of [userConf, globalConf]) {
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.readFileSync(p, "utf8")).toBe("");
      expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    }
  });
});

describe("npm-installer private npmrc dir (M2 hardening)", () => {
  let fakeTmp: string;
  beforeEach(() => (fakeTmp = hermeticTmp("npmrc-faketmp")));
  afterEach(() => fs.rmSync(fakeTmp, { recursive: true, force: true }));

  it("createNpmrcDir makes an unpredictable 0700 dir under the injected tmp root", () => {
    const dir = createNpmrcDir(fakeTmp);
    expect(path.dirname(dir)).toBe(fakeTmp);
    expect(path.basename(dir)).toMatch(/^voidrift-npmrc-/);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("never reads a pre-planted hostile npmrc at the OLD predictable names", () => {
    // Pre-plant hostile files at the old predictable paths in the fake tmp root.
    const hostile = "registry=https://evil.example\n//evil.example/:_authToken=stolen\n";
    for (const name of ["voidrift-empty.npmrc", "voidrift-empty-user.npmrc", "voidrift-empty-global.npmrc"]) {
      fs.writeFileSync(path.join(fakeTmp, name), hostile);
    }
    const dir = createNpmrcDir(fakeTmp);
    const scrubbed = scrubEnv({ PATH: "/usr/bin" }, REVIEWED_REGISTRY, dir);
    // The npmrc files npm is pointed at are the fresh empty ones in the private
    // dir — never the pre-planted hostile files.
    for (const key of ["npm_config_userconfig", "npm_config_globalconfig"]) {
      const p = scrubbed[key]!;
      expect(path.dirname(p)).toBe(dir);
      expect(fs.readFileSync(p, "utf8")).toBe("");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("removes the private dir after a SUCCESSFUL install and leaves no voidrift-empty* file in the tmp root", async () => {
    // A fake `npm` on PATH that exits 0 — proves cleanup on success without the real registry.
    const { installer, binDir, restorePath } = fakeNpm(fakeTmp, 0);
    try {
      const installDir = path.join(fakeTmp, "store");
      const res = await installer.install({
        name: "@voidrift/plugin-x",
        version: "1.0.0",
        installDir,
        registry: REVIEWED_REGISTRY,
        timeoutMs: 10_000,
        maxBytes: 10_000_000,
      });
      expect(res.ok).toBe(true);
      assertNoNpmrcLeftovers(fakeTmp);
    } finally {
      restorePath();
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("removes the private dir after a FAILING install and leaves no voidrift-empty* file in the tmp root", async () => {
    const { installer, binDir, restorePath } = fakeNpm(fakeTmp, 1);
    try {
      const installDir = path.join(fakeTmp, "store");
      const res = await installer.install({
        name: "@voidrift/plugin-x",
        version: "1.0.0",
        installDir,
        registry: REVIEWED_REGISTRY,
        timeoutMs: 10_000,
        maxBytes: 10_000_000,
      });
      expect(res.ok).toBe(false);
      assertNoNpmrcLeftovers(fakeTmp);
    } finally {
      restorePath();
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});

/** No private npmrc dir and no stale predictable file survives in `root`. */
function assertNoNpmrcLeftovers(root: string): void {
  const leftovers = fs
    .readdirSync(root)
    .filter((n) => n.startsWith("voidrift-npmrc-") || n.startsWith("voidrift-empty"));
  expect(leftovers).toEqual([]);
}

/** A fake `npm` executable on a throwaway PATH that exits with `code`, so the
 * install flow runs end-to-end (dir create + cleanup) with no real registry. */
function fakeNpm(
  tmpRoot: string,
  code: number,
): { installer: NpmInstallerAdapter; binDir: string; restorePath: () => void } {
  const binDir = fs.mkdtempSync(path.join(tmpRoot, "fakebin-"));
  const npmPath = path.join(binDir, "npm");
  fs.writeFileSync(npmPath, `#!/bin/sh\nexit ${code}\n`, { mode: 0o755 });
  const prevPath = process.env["PATH"];
  process.env["PATH"] = `${binDir}:${prevPath ?? ""}`;
  return {
    installer: new NpmInstallerAdapter(tmpRoot),
    binDir,
    restorePath: () => {
      if (prevPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = prevPath;
    },
  };
}
