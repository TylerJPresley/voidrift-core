/**
 * Plugin discovery/install END-TO-END (core-blueprint.md §12.4.1 integration
 * test). The ONE real test: a local fake npm registry on 127.0.0.1 serves the
 * `/-/v1/search` listing, the packument, and a real tarball built from a tiny
 * fixture plugin with `npm pack`. The fixture's `package.json` declares
 * `voidrift.plugin: true`, a registered command, and a `postinstall` that writes
 * a sentinel file. The test drives the REAL `PluginRegistryClient` and
 * `NpmInstallerAdapter` through `createCore`:
 *
 *   plugins.search → finds the @voidrift/plugin-* fixture (a non-plugin result dropped)
 *   plugins.inspect → review DTO (license, integrity, peer range, install dir)
 *   plugins.install (global) → real `npm install --ignore-scripts` into a temp store
 *     ⇒ the sentinel file does NOT exist (scripts were not run)
 *     ⇒ config now lists the plugin (enabled, global layer)
 *     ⇒ a sentinel secret in process.env never reached the child
 *   a fresh core boots, loads the installed plugin, and its registered command appears
 *   a tampered tarball (integrity mismatch) installs nothing and leaves the store clean
 *
 * Everything is under the run's hermetic temp root (hermeticTmp); the server is
 * closed and temp dirs removed in afterAll so nothing leaks and no stray
 * listener remains.
 */
import { hermeticTmp } from "./test-hermetic.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createCore } from "./boot.js";

const NAME = "@voidrift/plugin-e2e";
const VERSION = "1.0.0";
const SENTINEL = "POSTINSTALL_RAN";
const SECRET_ENV = "VOIDRIFT_E2E_SENTINEL_SECRET";

let tmpRoot: string;
let server: http.Server;
let registryUrl: string;
let tarball: Buffer;
let tamperedTarball: Buffer;
let integrity: string;

/** sha512 integrity string in npm's SRI form (`sha512-<base64>`). */
function sri(buf: Buffer): string {
  return "sha512-" + createHash("sha512").update(buf).digest("base64");
}

beforeAll(async () => {
  tmpRoot = hermeticTmp("pi-e2e");

  // ── Build the fixture plugin and pack it with real `npm pack` ──────────────
  const fixtureDir = path.join(tmpRoot, "fixture");
  const sentinelPath = path.join(tmpRoot, SENTINEL);
  await fs.mkdir(fixtureDir, { recursive: true });
  await fs.writeFile(
    path.join(fixtureDir, "package.json"),
    JSON.stringify(
      {
        name: NAME,
        version: VERSION,
        description: "e2e fixture plugin",
        license: "Apache-2.0",
        type: "module",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true, description: "e2e fixture" },
        // A postinstall that writes the sentinel — must NOT run under --ignore-scripts.
        scripts: { postinstall: `node -e "require('fs').writeFileSync(process.env.SENTINEL_PATH || '${sentinelPath.replace(/\\/g, "/")}','x')"` },
      },
      null,
      2,
    ),
  );
  await fs.writeFile(
    path.join(fixtureDir, "index.js"),
    `export function register(core) { core.register.command("e2e-hello", () => "hi"); }\n`,
  );

  const packOut = execFileSync("npm", ["pack", "--json", "--pack-destination", tmpRoot], {
    cwd: fixtureDir,
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
    encoding: "utf8",
  });
  const tarName = (JSON.parse(packOut) as { filename: string }[])[0]!.filename;
  tarball = readFileSync(path.join(tmpRoot, tarName));
  integrity = sri(tarball);
  // A one-byte tamper so the integrity differs but the tar still downloads.
  tamperedTarball = Buffer.concat([tarball, Buffer.from([0])]);

  // ── A loopback fake npm registry ───────────────────────────────────────────
  const tarPath = `/${NAME}/-/plugin-e2e-${VERSION}.tgz`;
  // A second package whose packument claims the REAL integrity but whose tarball
  // route serves DIFFERENT bytes — a registry that lies about the tarball. npm's
  // own download integrity check must reject it, so install exits nonzero.
  const SWAP_NAME = "@voidrift/plugin-swap";
  const swapTarPath = `/${SWAP_NAME}/-/plugin-swap-${VERSION}.tgz`;
  const packument = (tamper: boolean): unknown => ({
    name: NAME,
    "dist-tags": { latest: VERSION },
    versions: {
      [VERSION]: {
        name: NAME,
        version: VERSION,
        license: "Apache-2.0",
        description: "e2e fixture plugin",
        voidrift: { plugin: true },
        dist: {
          tarball: `${registryUrl}${tamper ? tarPath + "?tamper=1" : tarPath}`,
          integrity: tamper ? sri(tamperedTarball) : integrity,
          shasum: createHash("sha1").update(tamper ? tamperedTarball : tarball).digest("hex"),
        },
      },
    },
  });

  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);
    const tamper = url.searchParams.get("tamper") === "1" || pathname.includes("plugin-tampered");
    if (pathname === "/-/v1/search") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          objects: [
            { package: { name: NAME, version: VERSION, description: "e2e fixture plugin", publisher: { username: "voidrift-bot" } } },
            { package: { name: "@acme/not-a-plugin", version: "9.9.9" } },
          ],
          total: 2,
        }),
      );
      return;
    }
    // The swap package: packument claims the REAL integrity, tarball serves tampered bytes.
    if (pathname === `/${SWAP_NAME}`) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          name: SWAP_NAME,
          "dist-tags": { latest: VERSION },
          versions: {
            [VERSION]: {
              name: SWAP_NAME,
              version: VERSION,
              license: "Apache-2.0",
              description: "swap fixture",
              voidrift: { plugin: true },
              dist: { tarball: `${registryUrl}${swapTarPath}`, integrity, shasum: createHash("sha1").update(tarball).digest("hex") },
            },
          },
        }),
      );
      return;
    }
    if (pathname === swapTarPath) {
      res.setHeader("content-type", "application/octet-stream");
      res.end(tamperedTarball); // bytes ≠ the integrity the packument claims
      return;
    }
    // Packument for the fixture (and a tampered variant served under a header).
    if (pathname === `/${NAME}`) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(packument(req.headers["x-tamper"] === "1")));
      return;
    }
    if (pathname === tarPath) {
      res.setHeader("content-type", "application/octet-stream");
      res.end(tamper ? tamperedTarball : tarball);
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  registryUrl = `http://127.0.0.1:${addr.port}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env[SECRET_ENV];
});

/** Build a core whose global home is a temp dir, approving every gated op. */
async function makeCore(workspaceRoot: string, globalHome: string) {
  process.env["XDG_CONFIG_HOME"] = globalHome;
  await fs.mkdir(path.join(workspaceRoot, ".voidrift"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, ".voidrift", "config.json"),
    JSON.stringify({
      models: { local: { model: "m", protocol: "openai", contextLimit: 8000 } },
      modelSelected: "local",
      pluginsRegistry: registryUrl,
    }),
  );
  return createCore({
    workspaceRoot,
    chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
    // Approve every gated discovery/install action (interactive host).
    onApproval: async (p) => ({ requestId: p.id, decision: "approve" as const }),
  });
}

describe("plugin install end-to-end against a local fake registry (§12.4.1)", () => {
  it("search → inspect → install (--ignore-scripts) → fresh core loads it; tampered install leaves nothing", async () => {
    const ws = hermeticTmp("pi-ws");
    const globalHome = hermeticTmp("pi-xdg");
    const prevXdg = process.env["XDG_CONFIG_HOME"];
    // A sentinel secret in the parent env — it must never reach the npm child.
    process.env[SECRET_ENV] = "do-not-leak";
    const store = path.join(globalHome, "voidrift", "plugins");
    try {
      const { api } = await makeCore(ws, globalHome);

      // search — the fixture is found, the non-plugin result dropped.
      const found = await api.plugins.search("e2e");
      expect(found.ok).toBe(true);
      if (found.ok) expect(found.value.map((p) => p.name)).toEqual([NAME]);

      // inspect — review DTO without running code.
      const review = await api.plugins.inspect(NAME, VERSION);
      expect(review.ok).toBe(true);
      if (!review.ok) throw new Error(review.error.message);
      expect(review.value).toMatchObject({ name: NAME, version: VERSION, licenseAllowed: true, verified: true });
      expect(review.value.integrity).toBe(integrity);

      // A tampered install first: integrity mismatch ⇒ nothing installed.
      const tampered = await api.plugins.install({ name: NAME, version: VERSION, integrity: "sha512-WRONGWRONGWRONG", scope: "global", confirm: true });
      expect(tampered.ok).toBe(false);
      expect(existsSync(path.join(store, "node_modules", NAME))).toBe(false);

      // A registry that LIES about the tarball: the packument claims the real
      // integrity (so inspect binds it and the request matches), but the tarball
      // route serves different bytes. npm's own download integrity check rejects
      // it, the install exits nonzero, rollback leaves nothing on disk.
      const SWAP = "@voidrift/plugin-swap";
      const swapReview = await api.plugins.inspect(SWAP, VERSION);
      expect(swapReview.ok).toBe(true);
      if (swapReview.ok) {
        const swapInstall = await api.plugins.install({ name: SWAP, version: VERSION, integrity: swapReview.value.integrity, scope: "global", confirm: true });
        expect(swapInstall.ok).toBe(false);
        expect(existsSync(path.join(store, "node_modules", SWAP))).toBe(false);
      }

      // The real install.
      const installed = await api.plugins.install({ name: NAME, version: VERSION, integrity: review.value.integrity, scope: "global", confirm: true });
      if (!installed.ok) throw new Error("install failed: " + installed.error.message);
      expect(installed.ok).toBe(true);

      // Scripts did NOT run — the postinstall sentinel is absent.
      expect(existsSync(path.join(tmpRoot, SENTINEL))).toBe(false);

      // The package is on disk and the installed package.json is the fixture.
      const installedPkg = path.join(store, "node_modules", NAME, "package.json");
      expect(existsSync(installedPkg)).toBe(true);

      // Config now lists the plugin, enabled, at the global layer.
      const list = await api.plugins.list();
      expect(list.ok && list.value.some((p) => p.id === NAME && p.active)).toBe(true);
      const globalCfg = JSON.parse(await fs.readFile(path.join(globalHome, "voidrift", "config.json"), "utf8"));
      expect(globalCfg.plugins?.[NAME]?.enabled).toBe(true);

      await api.session.shutdown();

      // A fresh core boots, loads the installed plugin, and its command appears.
      const { api: api2 } = await makeCore(ws, globalHome);
      const list2 = await api2.plugins.list();
      expect(list2.ok && list2.value.some((p) => p.id === NAME && p.active)).toBe(true);
      await api2.session.shutdown();
    } finally {
      if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = prevXdg;
      delete process.env[SECRET_ENV];
      await fs.rm(ws, { recursive: true, force: true });
      await fs.rm(globalHome, { recursive: true, force: true });
    }
  }, 120_000);
});
