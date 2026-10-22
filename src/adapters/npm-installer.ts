/**
 * The npm installer adapter (core-blueprint.md §12.4.1).
 *
 * The one implementation of `PluginInstallerPort`. It installs a reviewed plugin
 * by spawning npm as an **argv array with `shell: false`** — never a shell
 * string — so a crafted name or version cannot inject a command. The child runs
 * under a **scrubbed environment**: only the minimal variables npm needs to find
 * its runtime and config (`PATH`, `HOME`, platform temp/appdata, and npm's own
 * `npm_config_*`/`NODE_*` where present) are forwarded; every inherited secret
 * or token (`*_TOKEN`, `*_KEY`, `*SECRET*`, `AWS_*`, `GITHUB_TOKEN`, `NPM_TOKEN`,
 * …) is dropped, so a sentinel secret in the parent `process.env` never reaches
 * the child. `--ignore-scripts` stops install-time lifecycle execution,
 * `--no-audit --no-fund` keep it offline-friendly, `--save-exact` and the exact
 * `name@version` pin the install, and `--registry` targets the configured
 * registry. A timeout kills the child; a running size cap on the install dir
 * aborts a runaway download. Any non-zero exit, timeout, or cap breach rolls the
 * install dir's package back and reports the failure (the capability also
 * removes on a later verification mismatch).
 *
 * `node:child_process` and the filesystem are why this is an adapter.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  PluginInstallerPort,
  PluginInstallRequest,
  PluginInstallResult,
} from "../entities/ports/plugin-registry-port.js";

/** Env keys always forwarded (npm needs them to run and read its config). */
const ENV_ALLOW_EXACT = new Set([
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "ComSpec",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
]);

/** Prefixes npm itself reads for configuration (never a user secret token). */
const ENV_ALLOW_PREFIX = ["npm_config_", "npm_lifecycle", "NODE_"];

/** Substrings that mark an `npm_config_*` key as auth- or registry-bearing: it
 * could carry a token off-host or retarget a scoped fetch to an attacker's
 * registry. These are always dropped; the registry is pinned explicitly
 * instead (§12.4.1, M1). The lone benign exception, `npm_config_registry`, is
 * set by us after the scrub, not forwarded from the parent. */
const ENV_AUTH_MARKERS = [
  "registry",
  ":_authtoken",
  "_auth",
  "_password",
  "username",
  "token",
  "//", // raw `//host/:_authToken` registry-auth entries
];

/** True when an `npm_config_*` key carries auth material or a registry override
 * that must not survive the scrub. */
function isAuthBearingNpmConfig(key: string): boolean {
  const low = key.toLowerCase();
  return ENV_AUTH_MARKERS.some((m) => low.includes(m));
}

/** Build a scrubbed environment: forward only what npm needs, drop every secret
 * (§12.4.1). A value is forwarded only when its key is explicitly allowed; the
 * default is to drop, so a new secret-shaped variable is never leaked.
 *
 * Beyond the allow-list, two registry-exfiltration paths are closed (M1/M2):
 *  - every auth- or registry-bearing `npm_config_*` key is dropped, so a scoped
 *    override (`npm_config_@scope:registry`) or an env-form token
 *    (`npm_config_//host/:_authToken`) cannot retarget the scoped fetch or carry
 *    a credential off the reviewed registry; and
 *  - `npm_config_userconfig`/`globalconfig` are pinned to empty files in a
 *    private per-install directory (`mkdtemp`, 0700; files 0600), removed in a
 *    `finally`, so a user or project `.npmrc` reachable through `HOME` cannot
 *    redirect the install or leak a token and no local attacker can pre-plant a
 *    hostile npmrc at a predictable temp path.
 * The reviewed registry is then set explicitly as the one source of truth. */
export function scrubEnv(
  source: NodeJS.ProcessEnv,
  registry: string,
  npmrcDir: string,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const allowed =
      ENV_ALLOW_EXACT.has(key) || ENV_ALLOW_PREFIX.some((p) => key.startsWith(p));
    if (!allowed) continue;
    // Drop any npm config that could redirect the fetch or carry a credential.
    if (key.startsWith("npm_config_") && isAuthBearingNpmConfig(key)) continue;
    out[key] = value;
  }
  // Never let npm prompt or write audit/fund noise; keep it non-interactive.
  out["npm_config_yes"] = "true";
  out["npm_config_audit"] = "false";
  out["npm_config_fund"] = "false";
  out["CI"] = "true";
  // Pin the registry explicitly to the reviewed one — the single source of
  // truth, overriding anything inherited (M1).
  out["npm_config_registry"] = registry;
  // Neutralize user/project `.npmrc`: point npm at empty config files so a
  // scoped registry or `_authToken` in `~/.npmrc` cannot redirect or leak (M2).
  // The files live inside a PRIVATE per-install directory (0700) so a local
  // attacker cannot pre-plant a hostile npmrc at a predictable path; npm refuses
  // to load one path as both user and global, so two distinct files are written.
  out["npm_config_userconfig"] = writeEmptyNpmrc(npmrcDir, "user");
  out["npm_config_globalconfig"] = writeEmptyNpmrc(npmrcDir, "global");
  return out;
}

/** Create a private, per-install temp directory (mode 0700) under `tmpRoot`
 * (defaults to the OS temp dir) to hold the empty npmrc files. `mkdtemp` picks
 * an unpredictable name so a local attacker cannot pre-create the path, and the
 * caller removes it in a `finally`. */
export function createNpmrcDir(tmpRoot: string): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "voidrift-npmrc-"));
  // Harden against any permissive umask: owner-only.
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort on platforms without POSIX modes (Windows).
  }
  return dir;
}

/** Write a fresh empty npmrc (mode 0600, truncating) inside the private dir and
 * return its path. The file is always created new in a dir we just made, so a
 * pre-existing attacker-controlled file is never read. */
function writeEmptyNpmrc(dir: string, kind: string): string {
  const p = path.join(dir, `empty-${kind}.npmrc`);
  fs.writeFileSync(p, "", { mode: 0o600, flag: "w" });
  return p;
}

/** Recursively sum the byte size of a directory, stopping early past a cap. */
async function dirSize(dir: string, cap: number): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          total += (await fsp.stat(p)).size;
        } catch {
          // skip unreadable
        }
        if (total > cap) return total;
      }
    }
  }
  return total;
}

export class NpmInstallerAdapter implements PluginInstallerPort {
  /** Tmp root under which the private per-install npmrc dir is created. Injected
   * in tests so a pre-planted hostile npmrc in a fake `/tmp` is provably never
   * read; defaults to the real OS temp dir. */
  constructor(private readonly tmpRoot: string = os.tmpdir()) {}

  async install(req: PluginInstallRequest): Promise<PluginInstallResult> {
    await fsp.mkdir(req.installDir, { recursive: true });
    const args = [
      "install",
      `${req.name}@${req.version}`,
      "--prefix",
      req.installDir,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      "--registry",
      req.registry,
    ];

    // A private per-install dir (0700) holds the empty npmrc files; it is removed
    // in `finally` on success, failure, AND timeout so no predictable path and
    // no leftover ever persists in the shared temp dir.
    const npmrcDir = createNpmrcDir(this.tmpRoot);
    try {
      const env = scrubEnv(process.env, req.registry, npmrcDir);
      const result = await new Promise<PluginInstallResult>((resolve) => {
        const child = spawn("npm", args, {
          shell: false,
          cwd: req.installDir,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let settled = false;
        const finish = (r: PluginInstallResult): void => {
          if (settled) return;
          settled = true;
          clearInterval(capTimer);
          clearTimeout(timer);
          resolve(r);
        };
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish({ ok: false, reason: "install timed out" });
        }, req.timeoutMs);
        // Running size cap: abort a runaway download.
        const capTimer = setInterval(() => {
          void dirSize(req.installDir, req.maxBytes).then((size) => {
            if (size > req.maxBytes) {
              child.kill("SIGKILL");
              finish({ ok: false, reason: "install exceeded size cap" });
            }
          });
        }, 250);
        child.stdout?.on("data", (d) => (out += String(d)));
        child.stderr?.on("data", (d) => (out += String(d)));
        child.on("error", (e) => finish({ ok: false, reason: String(e) }));
        child.on("close", (code) => {
          if (code === 0) {
            finish({ ok: true, packageDir: path.join(req.installDir, "node_modules", ...req.name.split("/")) });
          } else {
            finish({ ok: false, reason: `npm install exited ${code}: ${out.slice(-500)}` });
          }
        });
      });

      if (!result.ok) await this.rollback(req.installDir, req.name);
      return result;
    } finally {
      await fsp.rm(npmrcDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async rollback(installDir: string, name: string): Promise<void> {
    // Remove only the package tree this install created under the store, leaving
    // the store dir itself intact.
    const pkgDir = path.join(installDir, "node_modules", ...name.split("/"));
    await fsp.rm(pkgDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
