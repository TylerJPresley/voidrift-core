import { describe, it, expect } from "vitest";
import { Plugins, type PluginGate } from "./plugins.js";
import type { PluginLoader } from "../adapters/plugin-loader.js";
import type { PackageManifest } from "../entities/plugins/plugin-meta.js";
import type {
  PluginRegistryPort,
  RegistryFetchResult,
  PluginInstallerPort,
  PluginInstallRequest,
  PluginInstallResult,
} from "../entities/ports/plugin-registry-port.js";
import { RegistryStore } from "../entities/registry/registry-store.js";
import { EventBus } from "../entities/event-bus.js";
import type { PluginEntry } from "../config/schema.js";
import { fakeCoreServices } from "../test-support/fake-core-services.js";

const okGate: PluginGate = async () => ({ decision: "allow" });

function noopServices() {
  return fakeCoreServices({
    registerScope: (p, i) => `${p}:${i}`,
  });
}

/** A loader fake that resolves installed entries from an in-memory table and
 * reports installed manifest/integrity for post-install verification. */
function fakeLoader(installed: Record<string, { manifest: PackageManifest; integrity: string | null }> = {}): PluginLoader {
  return {
    resolve: (e: { id: string }) =>
      installed[e.id]
        ? {
            entryKey: e.id,
            realPath: `/store/node_modules/${e.id}`,
            manifest: installed[e.id]!.manifest,
            meta: { id: e.id, name: e.id, version: installed[e.id]!.manifest.version ?? "0.0.0", description: "", active: true },
          }
        : null,
    licenseScan: () => ({ ok: true }),
    importRegister: async () => () => {},
    scanCandidates: () => [],
    readInstalledManifest: (dir: string) => {
      const id = dir.split("/node_modules/")[1]!;
      return installed[id]?.manifest ?? null;
    },
    readInstalledIntegrity: (dir: string) => {
      const id = dir.split("/node_modules/")[1]!;
      return installed[id]?.integrity ?? null;
    },
  } as unknown as PluginLoader;
}

function fakeRegistry(responder: (url: string) => RegistryFetchResult): PluginRegistryPort {
  return { get: async (url) => responder(url) };
}

function okJson(body: unknown): RegistryFetchResult {
  return { status: 200, body: JSON.stringify(body), tooLarge: false, errored: false };
}

function fakeInstaller(behavior?: Partial<PluginInstallerPort> & { rolledBack?: string[] }): PluginInstallerPort {
  const rolled: string[] = behavior?.rolledBack ?? [];
  return {
    install: behavior?.install ?? (async (req: PluginInstallRequest): Promise<PluginInstallResult> => ({
      ok: true,
      packageDir: `/store/node_modules/${req.name}`,
    })),
    rollback: behavior?.rollback ?? (async (_dir, name) => void rolled.push(name)),
  };
}

const PACKUMENT = {
  name: "@voidrift/plugin-x",
  "dist-tags": { latest: "1.0.0" },
  versions: {
    "1.0.0": {
      name: "@voidrift/plugin-x",
      version: "1.0.0",
      license: "Apache-2.0",
      dist: { integrity: "sha512-good" },
      voidrift: { plugin: true },
    },
  },
};

function make(opts: {
  registry?: PluginRegistryPort;
  installer?: PluginInstallerPort;
  loader?: PluginLoader;
  gate?: PluginGate;
  registryUrl?: string;
  entries?: Record<string, PluginEntry>;
}) {
  const bus = new EventBus();
  const events: { type: string; payload: unknown }[] = [];
  bus.subscribe("*", (e) => events.push({ type: e.type, payload: e.payload }));
  let current = { ...(opts.entries ?? {}) };
  const plugins = new Plugins({
    bus,
    loader: opts.loader ?? fakeLoader(),
    services: noopServices(),
    registryStore: new RegistryStore(),
    getPlugins: () => current,
    setPlugins: async (next) => {
      current = next;
      return { ok: true as const, value: next };
    },
    discovery: {
      registryClient: opts.registry ?? fakeRegistry(() => okJson({ objects: [] })),
      installer: opts.installer ?? fakeInstaller(),
      getRegistryUrl: () => opts.registryUrl ?? "https://registry.npmjs.org",
      hostCoreVersion: "1.0.0",
      installDirFor: () => "/store",
      gate: opts.gate ?? okGate,
      networkTimeoutMs: 1000,
      searchMaxBytes: 1_000_000,
      installTimeoutMs: 1000,
      installMaxBytes: 1_000_000,
    },
  });
  return { plugins, events, getCurrent: () => current };
}

describe("Plugins discovery/install (§12.4.1)", () => {
  describe("search", () => {
    it("drops non-@voidrift/plugin-* results from the default listing", async () => {
      const env = make({
        registry: fakeRegistry(() =>
          okJson({
            objects: [
              { package: { name: "@voidrift/plugin-x", version: "1.0.0" } },
              { package: { name: "@acme/other", version: "2.0.0" } },
            ],
          }),
        ),
      });
      const r = await env.plugins.search("x");
      expect(r.ok && r.value.map((p) => p.name)).toEqual(["@voidrift/plugin-x"]);
    });

    it("degrades to the last cached page on 429, oversized, offline, and malformed", async () => {
      let mode: "ok" | "429" | "big" | "offline" | "bad" = "ok";
      const env = make({
        registry: fakeRegistry(() => {
          if (mode === "ok") return okJson({ objects: [{ package: { name: "@voidrift/plugin-x", version: "1.0.0" } }] });
          if (mode === "429") return { status: 429, body: "", tooLarge: false, errored: false };
          if (mode === "big") return { status: 200, body: "", tooLarge: true, errored: false };
          if (mode === "offline") return { status: 0, body: "", tooLarge: false, errored: true };
          return { status: 200, body: "{not json", tooLarge: false, errored: false };
        }),
      });
      const first = await env.plugins.search("x");
      expect(first.ok && first.value).toHaveLength(1);
      for (const m of ["429", "big", "offline", "bad"] as const) {
        mode = m;
        const r = await env.plugins.search("x");
        expect(r.ok && r.value).toHaveLength(1); // cached page
      }
      expect(env.events.filter((e) => e.type === "WARNING_EMITTED")).toHaveLength(4);
    });

    it("refuses when the registry URL is not https/loopback", async () => {
      const env = make({ registryUrl: "http://registry.npmjs.org" });
      const r = await env.plugins.search("x");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.field).toBe("pluginsRegistry");
    });

    it("refuses when the gate denies", async () => {
      const env = make({ gate: async () => ({ decision: "deny", reason: "blocked by compliance: x" }) });
      const r = await env.plugins.search("x");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("PERMISSION_DENIED");
    });
  });

  describe("inspect", () => {
    it("returns the review DTO without running code", async () => {
      const env = make({ registry: fakeRegistry(() => okJson(PACKUMENT)) });
      const r = await env.plugins.inspect("@voidrift/plugin-x");
      expect(r.ok && r.value).toMatchObject({ name: "@voidrift/plugin-x", version: "1.0.0", integrity: "sha512-good", licenseAllowed: true, verified: true });
    });
    it("marks a non-@voidrift name verified:false", async () => {
      const env = make({
        registry: fakeRegistry(() =>
          okJson({ name: "@acme/x", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { name: "@acme/x", version: "1.0.0", license: "MIT", dist: { integrity: "sha512-a" } } } }),
        ),
      });
      const r = await env.plugins.inspect("@acme/x");
      expect(r.ok && r.value.verified).toBe(false);
    });
    it("rejects malformed packument and 404", async () => {
      const bad = make({ registry: fakeRegistry(() => ({ status: 200, body: "{bad", tooLarge: false, errored: false })) });
      expect((await bad.plugins.inspect("@voidrift/plugin-x")).ok).toBe(false);
      const missing = make({ registry: fakeRegistry(() => ({ status: 404, body: "", tooLarge: false, errored: false })) });
      const r = await missing.plugins.inspect("@voidrift/plugin-x");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
    });
  });

  describe("install refusals (each leaves the store untouched)", () => {
    const reg = () => fakeRegistry(() => okJson(PACKUMENT));

    it("refuses a version range", async () => {
      const env = make({ registry: reg() });
      const r = await env.plugins.install({ name: "@voidrift/plugin-x", version: "^1.0.0", integrity: "sha512-good", scope: "global", confirm: true });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.field).toBe("version");
      expect(env.events.some((e) => e.type === "PLUGIN_INSTALL_FAILED")).toBe(true);
    });

    it("refuses a missing confirm", async () => {
      const env = make({ registry: reg() });
      // @ts-expect-error — exercising the runtime guard for a missing confirm
      const r = await env.plugins.install({ name: "@voidrift/plugin-x", version: "1.0.0", integrity: "sha512-good", scope: "global" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("PERMISSION_DENIED");
    });

    it("refuses an integrity mismatch", async () => {
      const env = make({ registry: reg() });
      const r = await env.plugins.install({ name: "@voidrift/plugin-x", version: "1.0.0", integrity: "sha512-WRONG", scope: "global", confirm: true });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.field).toBe("integrity");
    });

    it("refuses a copyleft license", async () => {
      const env = make({
        registry: fakeRegistry(() =>
          okJson({ name: "@voidrift/plugin-g", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { name: "@voidrift/plugin-g", version: "1.0.0", license: "GPL-3.0", dist: { integrity: "sha512-g" }, voidrift: { plugin: true } } } }),
        ),
      });
      const r = await env.plugins.install({ name: "@voidrift/plugin-g", version: "1.0.0", integrity: "sha512-g", scope: "global", confirm: true });
      expect(r.ok).toBe(false);
    });

    it("refuses a reserved-namespace name", async () => {
      const env = make({ registry: reg() });
      const r = await env.plugins.install({ name: "core", version: "1.0.0", integrity: "sha512-good", scope: "global", confirm: true });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.field).toBe("name");
    });

    it("refuses when the gate does not allow (out-of-band ask)", async () => {
      const env = make({ registry: reg(), gate: async (op) => (op === "plugins_install" ? { decision: "ask", reason: "waiting_for_approval" } : { decision: "allow" }) });
      const r = await env.plugins.install({ name: "@voidrift/plugin-x", version: "1.0.0", integrity: "sha512-good", scope: "global", confirm: true });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("PERMISSION_DENIED");
    });
  });

  describe("install input validation (BEFORE any spawn, §12.4.1 hardening)", () => {
    // A spy installer: it records whether install() was ever reached.
    function spyInstaller(): PluginInstallerPort & { called: () => boolean } {
      let hit = false;
      return {
        install: async (req: PluginInstallRequest) => {
          hit = true;
          return { ok: true, packageDir: `/store/node_modules/${req.name}` };
        },
        rollback: async () => {},
        called: () => hit,
      };
    }

    for (const bad of ["-g", "-x", "--registry=evil", "@voidrift/plugin bad", "@voidrift/plugin\nx", "@voidrift/plugin\tx", "foo\x00bar"]) {
      it(`refuses a flag-like/whitespace/control package name (${JSON.stringify(bad)}) before spawn`, async () => {
        const installer = spyInstaller();
        const env = make({ registry: fakeRegistry(() => okJson(PACKUMENT)), installer });
        const r = await env.plugins.install({ name: bad, version: "1.0.0", integrity: "sha512-good", scope: "global", confirm: true });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe("INVALID_INPUT");
          expect(r.error.field).toBe("name");
        }
        expect(installer.called()).toBe(false); // never spawned
        expect(env.events.some((e) => e.type === "PLUGIN_INSTALL_FAILED")).toBe(true);
      });
    }

    for (const bad of ["-1.0.0", "1.0.0 ", "1.0.0\n", "1.0.0\x1b"]) {
      it(`refuses a flag-like/whitespace/control version (${JSON.stringify(bad)}) before spawn`, async () => {
        const installer = spyInstaller();
        const env = make({ registry: fakeRegistry(() => okJson(PACKUMENT)), installer });
        const r = await env.plugins.install({ name: "@voidrift/plugin-x", version: bad, integrity: "sha512-good", scope: "global", confirm: true });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
        expect(installer.called()).toBe(false);
      });
    }
  });

  describe("install fails CLOSED when npm records no integrity (§12.4.1 hardening)", () => {
    it("rolls back and refuses when the installed integrity is missing (null)", async () => {
      const rolled: string[] = [];
      const env = make({
        registry: fakeRegistry(() => okJson(PACKUMENT)),
        // integrity: null → the loader could not read a recorded integrity.
        loader: fakeLoader({ "@voidrift/plugin-x": { manifest: { name: "@voidrift/plugin-x", version: "1.0.0", license: "Apache-2.0", voidrift: { plugin: true } }, integrity: null } }),
        installer: fakeInstaller({ rolledBack: rolled, rollback: async (_d, n) => void rolled.push(n) }),
      });
      const r = await env.plugins.install({ name: "@voidrift/plugin-x", version: "1.0.0", integrity: "sha512-good", scope: "global", confirm: true });
      expect(r.ok).toBe(false);
      expect(rolled).toContain("@voidrift/plugin-x");
      expect(env.events.some((e) => e.type === "PLUGIN_INSTALLED")).toBe(false);
    });
  });

  describe("install verification + rollback", () => {
    it("rolls back and emits PLUGIN_INSTALL_FAILED when the installed tarball integrity differs", async () => {
      const rolled: string[] = [];
      const env = make({
        registry: fakeRegistry(() => okJson(PACKUMENT)),
        loader: fakeLoader({ "@voidrift/plugin-x": { manifest: { name: "@voidrift/plugin-x", version: "1.0.0", license: "Apache-2.0", voidrift: { plugin: true } }, integrity: "sha512-TAMPERED" } }),
        installer: fakeInstaller({ rolledBack: rolled, rollback: async (_d, n) => void rolled.push(n) }),
      });
      const r = await env.plugins.install({ name: "@voidrift/plugin-x", version: "1.0.0", integrity: "sha512-good", scope: "global", confirm: true });
      expect(r.ok).toBe(false);
      expect(rolled).toContain("@voidrift/plugin-x");
      expect(env.events.some((e) => e.type === "PLUGIN_INSTALL_FAILED")).toBe(true);
      expect(env.events.some((e) => e.type === "PLUGIN_INSTALLED")).toBe(false);
    });

    it("installs, enables, and emits PLUGIN_INSTALLED on a clean verified install", async () => {
      const env = make({
        registry: fakeRegistry(() => okJson(PACKUMENT)),
        loader: fakeLoader({ "@voidrift/plugin-x": { manifest: { name: "@voidrift/plugin-x", version: "1.0.0", license: "Apache-2.0", voidrift: { plugin: true } }, integrity: "sha512-good" } }),
      });
      const r = await env.plugins.install({ name: "@voidrift/plugin-x", version: "1.0.0", integrity: "sha512-good", scope: "global", confirm: true });
      expect(r.ok).toBe(true);
      expect(env.getCurrent()["@voidrift/plugin-x"]).toMatchObject({ enabled: true });
      expect(env.events.some((e) => e.type === "PLUGIN_INSTALLED")).toBe(true);
      expect(env.events.some((e) => e.type === "RESOURCE_CHANGED" && (e.payload as { type?: string }).type === "plugin")).toBe(true);
    });
  });
});
