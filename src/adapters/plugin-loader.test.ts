import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { PluginLoader } from "./plugin-loader.js";

/** Write a fixture package dir with a package.json and an index.js. */
async function writePkg(
  root: string,
  rel: string,
  pkg: Record<string, unknown>,
  index = "export function register(){}",
): Promise<string> {
  const dir = path.join(root, rel);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  await fs.writeFile(path.join(dir, "index.js"), index);
  return dir;
}

describe("PluginLoader (§12.4)", () => {
  let ws: string;
  let global: string;

  beforeEach(async () => {
    ws = hermeticTmp("loader");
    global = hermeticTmp("global");
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(global, { recursive: true, force: true });
  });

  it("resolves a path entry against the workspace root and reads PluginMeta", async () => {
    await writePkg(ws, "plug", {
      name: "my-plugin",
      version: "1.0.0",
      license: "MIT",
      voidrift: { plugin: true, description: "D" },
    });
    const loader = new PluginLoader(ws, global);
    const resolved = loader.resolve({ id: "my-plugin", path: "plug" });
    expect(resolved).not.toBeNull();
    expect(resolved!.meta).toMatchObject({ id: "my-plugin", description: "D", license: "MIT" });
  });

  it("resolves a package entry via Node resolution from node_modules", async () => {
    await writePkg(ws, "node_modules/pkg-plugin", { name: "pkg-plugin", version: "1.0.0", license: "MIT", voidrift: { plugin: true } });
    const loader = new PluginLoader(ws, global);
    const resolved = loader.resolve({ id: "pkg-plugin" });
    expect(resolved).not.toBeNull();
    expect(resolved!.meta.id).toBe("pkg-plugin");
  });

  it("resolves the GLOBAL store before the project store so a project copy cannot shadow (§12.4.1 M1)", async () => {
    const name = "@voidrift/plugin-dup";
    // Same id in both stores, DIFFERENT versions so we can tell which resolved.
    await writePkg(global, path.join("plugins", "node_modules", "@voidrift", "plugin-dup"), {
      name,
      version: "9.9.9",
      license: "MIT",
      voidrift: { plugin: true },
    });
    await writePkg(ws, path.join(".voidrift", "plugins", "node_modules", "@voidrift", "plugin-dup"), {
      name,
      version: "0.0.1",
      license: "MIT",
      voidrift: { plugin: true },
    });
    const loader = new PluginLoader(ws, global);
    const resolved = loader.resolve({ id: name });
    expect(resolved).not.toBeNull();
    expect(resolved!.meta.version).toBe("9.9.9"); // the global store won
  });

  it("still resolves a package present only in the project store", async () => {
    const name = "@voidrift/plugin-only-project";
    await writePkg(ws, path.join(".voidrift", "plugins", "node_modules", "@voidrift", "plugin-only-project"), {
      name,
      version: "1.2.3",
      license: "MIT",
      voidrift: { plugin: true },
    });
    const loader = new PluginLoader(ws, global);
    const resolved = loader.resolve({ id: name });
    expect(resolved).not.toBeNull();
    expect(resolved!.meta.version).toBe("1.2.3");
  });

  it("licenseScan passes a permissive tree and rejects a GPL dependency", async () => {
    const dir = await writePkg(ws, "node_modules/mit-plugin", {
      name: "mit-plugin",
      version: "1.0.0",
      license: "MIT",
      voidrift: { plugin: true },
      dependencies: { "gpl-dep": "1.0.0" },
    });
    // The dependency installed under the plugin's own node_modules.
    await writePkg(dir, "node_modules/gpl-dep", { name: "gpl-dep", version: "1.0.0", license: "GPL-3.0" });
    const loader = new PluginLoader(ws, global);
    const resolved = loader.resolve({ id: "mit-plugin" })!;
    const scan = loader.licenseScan(resolved);
    expect(scan.ok).toBe(false);
    expect(scan.offender).toMatchObject({ pkg: "gpl-dep", license: "GPL-3.0" });
  });

  it("licenseScan passes when the plugin and its deps are permissive", async () => {
    const dir = await writePkg(ws, "node_modules/clean-plugin", {
      name: "clean-plugin",
      version: "1.0.0",
      license: "Apache-2.0",
      voidrift: { plugin: true },
      dependencies: { "mit-dep": "1.0.0" },
    });
    await writePkg(dir, "node_modules/mit-dep", { name: "mit-dep", version: "1.0.0", license: "MIT" });
    const loader = new PluginLoader(ws, global);
    const scan = loader.licenseScan(loader.resolve({ id: "clean-plugin" })!);
    expect(scan.ok).toBe(true);
  });

  it("scanCandidates finds voidrift.plugin packages including @-scoped, never loads", async () => {
    await writePkg(ws, "node_modules/plain-plugin", { name: "plain-plugin", version: "1.0.0", voidrift: { plugin: true } });
    await writePkg(ws, "node_modules/@scope/scoped-plugin", { name: "@scope/scoped-plugin", version: "1.0.0", voidrift: { plugin: true } });
    await writePkg(ws, "node_modules/not-a-plugin", { name: "not-a-plugin", version: "1.0.0" });
    const loader = new PluginLoader(ws, global);
    const ids = loader.scanCandidates().map((c) => c.manifest.name).sort();
    expect(ids).toEqual(["@scope/scoped-plugin", "plain-plugin"]);
  });

  it("importRegister returns the register export", async () => {
    await writePkg(ws, "plug", { name: "ip", version: "1.0.0", license: "MIT", main: "index.js", voidrift: { plugin: true } }, "export function register(c){ c.marked = true; }");
    const loader = new PluginLoader(ws, global);
    const resolved = loader.resolve({ id: "ip", path: "plug" })!;
    const register = await loader.importRegister(resolved);
    const probe = {};
    await register(probe);
    expect((probe as { marked?: boolean }).marked).toBe(true);
  });

  it("returns null for an unresolvable package or path entry", () => {
    const loader = new PluginLoader(ws, global);
    expect(loader.resolve({ id: "nonexistent-pkg" })).toBeNull();
    expect(loader.resolve({ id: "x", path: "does/not/exist" })).toBeNull();
  });

  it("importRegister throws when the module has no register export", async () => {
    await writePkg(ws, "noreg", { name: "noreg", version: "1.0.0", license: "MIT", main: "index.js", voidrift: { plugin: true } }, "export const nope = 1;");
    const loader = new PluginLoader(ws, global);
    const resolved = loader.resolve({ id: "noreg", path: "noreg" })!;
    await expect(loader.importRegister(resolved)).rejects.toThrow(/does not export register/);
  });

  it("licenseScan rejects a plugin whose own license is missing", async () => {
    await writePkg(ws, "nolic", { name: "nolic", version: "1.0.0", main: "index.js", voidrift: { plugin: true } }, "export function register(){}");
    const loader = new PluginLoader(ws, global);
    const scan = loader.licenseScan(loader.resolve({ id: "nolic", path: "nolic" })!);
    expect(scan.ok).toBe(false);
  });

  it("licenseScan walks the transitive tree and catches a copyleft dep nested in the subtree", async () => {
    // plugin → mit-dep → agpl-dep, all nested inside the plugin's own node_modules.
    const dir = await writePkg(ws, "node_modules/t-plugin", {
      name: "t-plugin",
      version: "1.0.0",
      license: "MIT",
      voidrift: { plugin: true },
      dependencies: { "mit-dep": "1.0.0" },
    });
    const mitDir = await writePkg(dir, "node_modules/mit-dep", {
      name: "mit-dep",
      version: "1.0.0",
      license: "MIT",
      dependencies: { "agpl-dep": "1.0.0" },
    });
    await writePkg(mitDir, "node_modules/agpl-dep", { name: "agpl-dep", version: "1.0.0", license: "AGPL-3.0" });
    const loader = new PluginLoader(ws, global);
    const scan = loader.licenseScan(loader.resolve({ id: "t-plugin" })!);
    expect(scan.ok).toBe(false);
    expect(scan.offender).toMatchObject({ pkg: "agpl-dep", license: "AGPL-3.0" });
  });

  it("licenseScan fails closed when a declared dependency is unresolved in the subtree", async () => {
    await writePkg(ws, "node_modules/u-plugin", {
      name: "u-plugin",
      version: "1.0.0",
      license: "MIT",
      voidrift: { plugin: true },
      dependencies: { "missing-dep": "1.0.0" },
    });
    const loader = new PluginLoader(ws, global);
    const scan = loader.licenseScan(loader.resolve({ id: "u-plugin" })!);
    expect(scan.ok).toBe(false);
    expect(scan.offender).toMatchObject({ pkg: "missing-dep", license: "UNRESOLVED" });
  });

  it("licenseScan resolves a dependency HOISTED to the workspace root (standard node resolution, FX-A)", async () => {
    // The dep is absent from the plugin's own node_modules but present (MIT) at
    // the workspace root — the normal npm/monorepo hoisted layout. Standard node
    // resolution walks up and scans the hoisted copy rather than failing closed.
    await writePkg(ws, "node_modules/h-plugin", {
      name: "h-plugin",
      version: "1.0.0",
      license: "MIT",
      voidrift: { plugin: true },
      dependencies: { "hoisted-dep": "1.0.0" },
    });
    await writePkg(ws, "node_modules/hoisted-dep", { name: "hoisted-dep", version: "2.0.0", license: "MIT" });
    const loader = new PluginLoader(ws, global);
    const scan = loader.licenseScan(loader.resolve({ id: "h-plugin" })!);
    expect(scan.ok).toBe(true);
  });

  it("licenseScan resolves a dependency hoisted TWO levels up and still catches a copyleft there (FX-A)", async () => {
    // plugin nested under node_modules/@scope/deep-plugin; its dep is hoisted two
    // ancestors up at the workspace-root node_modules with a GPL license.
    await writePkg(ws, "node_modules/@scope/deep-plugin", {
      name: "@scope/deep-plugin",
      version: "1.0.0",
      license: "MIT",
      voidrift: { plugin: true },
      dependencies: { "far-dep": "1.0.0" },
    });
    await writePkg(ws, "node_modules/far-dep", { name: "far-dep", version: "3.0.0", license: "GPL-3.0" });
    const loader = new PluginLoader(ws, global);
    const scan = loader.licenseScan(loader.resolve({ id: "@scope/deep-plugin" })!);
    expect(scan.ok).toBe(false);
    expect(scan.offender).toMatchObject({ pkg: "far-dep", license: "GPL-3.0" });
  });

  it("licenseScan still fails closed when a declared dependency is absent from EVERY ancestor (FX-A)", async () => {
    await writePkg(ws, "node_modules/m-plugin", {
      name: "m-plugin",
      version: "1.0.0",
      license: "MIT",
      voidrift: { plugin: true },
      dependencies: { "truly-missing": "1.0.0" },
    });
    const loader = new PluginLoader(ws, global);
    const scan = loader.licenseScan(loader.resolve({ id: "m-plugin" })!);
    expect(scan.ok).toBe(false);
    expect(scan.offender).toMatchObject({ pkg: "truly-missing", license: "UNRESOLVED" });
  });

  it("resolves a package by name even when its exports map omits ./package.json (FX-A)", async () => {
    // A real plugin's package.json exposes only `.` in exports, so resolving
    // `<name>/package.json` throws ERR_PACKAGE_PATH_NOT_EXPORTED. The loader must
    // resolve via the entry point and walk up to the matching package.json.
    await writePkg(
      ws,
      "node_modules/exports-only-plugin",
      {
        name: "exports-only-plugin",
        version: "1.0.0",
        license: "MIT",
        type: "module",
        main: "./index.js",
        exports: { ".": { import: "./index.js" } },
        voidrift: { plugin: true },
      },
      "export function register(){}",
    );
    const loader = new PluginLoader(ws, global);
    const resolved = loader.resolve({ id: "exports-only-plugin" });
    expect(resolved).not.toBeNull();
    expect(resolved!.meta.id).toBe("exports-only-plugin");
  });

  describe("readInstalledIntegrity (§12.4.1)", () => {
    const stores: string[] = [];
    afterEach(async () => {
      while (stores.length) await fs.rm(stores.pop()!, { recursive: true, force: true });
    });
    /** Lay out a store: <store>/node_modules/<name>/package.json plus a lockfile. */
    async function store(lockfile: "root" | "node_modules" | "none", integrity?: string): Promise<string> {
      const storeDir = hermeticTmp("store");
      stores.push(storeDir);
      const name = "@scope/plugin-y";
      const pkgDir = path.join(storeDir, "node_modules", ...name.split("/"));
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(path.join(pkgDir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
      const lock = JSON.stringify({ packages: { [`node_modules/${name}`]: integrity ? { integrity } : {} } });
      if (lockfile === "root") await fs.writeFile(path.join(storeDir, "package-lock.json"), lock);
      if (lockfile === "node_modules") await fs.writeFile(path.join(storeDir, "node_modules", ".package-lock.json"), lock);
      return pkgDir;
    }

    it("reads the integrity npm records in the store package-lock.json", async () => {
      const pkgDir = await store("root", "sha512-abc");
      const loader = new PluginLoader(ws, global);
      expect(loader.readInstalledIntegrity(pkgDir)).toBe("sha512-abc");
    });

    it("falls back to node_modules/.package-lock.json when the root lockfile is absent", async () => {
      const pkgDir = await store("node_modules", "sha512-def");
      const loader = new PluginLoader(ws, global);
      expect(loader.readInstalledIntegrity(pkgDir)).toBe("sha512-def");
    });

    it("returns null when no lockfile records an integrity (caller fails closed)", async () => {
      const pkgDir = await store("none");
      const loader = new PluginLoader(ws, global);
      expect(loader.readInstalledIntegrity(pkgDir)).toBeNull();
    });
  });
});
