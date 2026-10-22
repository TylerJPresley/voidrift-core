import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  NodeRegistryPersistence,
  InMemoryRegistryPersistence,
  workspaceKey,
  fileSafePluginId,
  isRegistryFile,
  REGISTRY_FILE_MAX_BYTES,
} from "./registry-persistence.js";

/** A hermetic temp global-config dir + workspace path for each test. */
function tmp(): { globalDir: string; workspace: string; cleanup: () => void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vr-reg-"));
  const globalDir = path.join(base, "config");
  const workspace = path.join(base, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  return { globalDir, workspace, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

describe("NodeRegistryPersistence (§12.5)", () => {
  let env: ReturnType<typeof tmp>;
  beforeEach(() => (env = tmp()));
  afterEach(() => env.cleanup());

  it("writes one file per plugin at <global>/registry/<16-hex>/<safe id>.json, outside the workspace", () => {
    const warn: string[] = [];
    const p = new NodeRegistryPersistence(env.globalDir, env.workspace, (m) => warn.push(m));
    p.save("@voidrift/plugin-routines", { "routine:daily": { id: "daily", prompt: "x" } });

    const key = workspaceKey(fs.realpathSync.native(env.workspace));
    const dir = path.join(env.globalDir, "registry", key);
    const file = path.join(dir, `${fileSafePluginId("@voidrift/plugin-routines")}.json`);
    // Given — the file is where §12.5 says, under the GLOBAL dir not the workspace.
    expect(fs.existsSync(file)).toBe(true);
    expect(file.startsWith(env.globalDir)).toBe(true);
    expect(file.includes(env.workspace)).toBe(false);
    // And — a versioned envelope round-trips.
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(isRegistryFile(parsed)).toBe(true);
    expect(parsed).toEqual({ version: 1, entries: { "routine:daily": { id: "daily", prompt: "x" } } });
    expect(warn).toEqual([]);
  });

  it("dirs are 0700 and files are 0600", () => {
    const p = new NodeRegistryPersistence(env.globalDir, env.workspace);
    p.save("pluginA", { k: 1 });
    const dir = p.directory();
    const file = path.join(dir, "pluginA.json");
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("load returns {} for an absent file (empty start)", () => {
    const p = new NodeRegistryPersistence(env.globalDir, env.workspace);
    expect(p.load("missing")).toEqual({});
  });

  it("remove deletes the plugin's file wholesale (disable)", () => {
    const p = new NodeRegistryPersistence(env.globalDir, env.workspace);
    p.save("gone", { k: 1 });
    const file = path.join(p.directory(), "gone.json");
    expect(fs.existsSync(file)).toBe(true);
    p.remove("gone");
    expect(fs.existsSync(file)).toBe(false);
    // Idempotent: removing again does not throw.
    expect(() => p.remove("gone")).not.toThrow();
  });

  it("a malformed (non-JSON) file is set aside as .rejected with one warning and an empty start", () => {
    const warn: string[] = [];
    const p = new NodeRegistryPersistence(env.globalDir, env.workspace, (m) => warn.push(m));
    const dir = p.directory();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, "{ not json");
    expect(p.load("bad")).toEqual({});
    expect(fs.existsSync(`${file}.rejected`)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(warn).toHaveLength(1);
  });

  it("a wrong-version or non-object-entries file is rejected without crash", () => {
    const warn: string[] = [];
    const p = new NodeRegistryPersistence(env.globalDir, env.workspace, (m) => warn.push(m));
    const dir = p.directory();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "v2.json"), JSON.stringify({ version: 2, entries: {} }));
    fs.writeFileSync(path.join(dir, "arr.json"), JSON.stringify({ version: 1, entries: [] }));
    expect(p.load("v2")).toEqual({});
    expect(p.load("arr")).toEqual({});
    expect(fs.existsSync(path.join(dir, "v2.json.rejected"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "arr.json.rejected"))).toBe(true);
    expect(warn).toHaveLength(2);
  });

  it("a file over the 1 MiB cap is set aside, plugin starts empty", () => {
    const warn: string[] = [];
    const p = new NodeRegistryPersistence(env.globalDir, env.workspace, (m) => warn.push(m));
    const dir = p.directory();
    fs.mkdirSync(dir, { recursive: true });
    const huge = { version: 1, entries: { big: "x".repeat(REGISTRY_FILE_MAX_BYTES + 10) } };
    const file = path.join(dir, "huge.json");
    fs.writeFileSync(file, JSON.stringify(huge));
    expect(p.load("huge")).toEqual({});
    expect(fs.existsSync(`${file}.rejected`)).toBe(true);
    expect(warn).toHaveLength(1);
  });

  it("two processes writing at once end consistent — last-writer-wins per file, no corruption (documented)", () => {
    // Two adapters over the SAME global dir + workspace stand in for two
    // processes. Each writes the whole envelope atomically (temp + rename), so
    // the file is never half-written; the last rename wins.
    const a = new NodeRegistryPersistence(env.globalDir, env.workspace);
    const b = new NodeRegistryPersistence(env.globalDir, env.workspace);
    a.save("p", { k: "from-a" });
    b.save("p", { k: "from-b" });
    const file = path.join(a.directory(), "p.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(isRegistryFile(parsed)).toBe(true); // never corrupt
    expect(parsed.entries.k).toBe("from-b"); // last writer wins
  });
});

describe("fileSafePluginId", () => {
  it("keeps safe chars, replaces the rest, and never returns empty", () => {
    expect(fileSafePluginId("@voidrift/plugin-plan")).toBe("_voidrift_plugin-plan");
    expect(fileSafePluginId("a.b-c_0")).toBe("a.b-c_0");
    expect(fileSafePluginId("///")).toBe("___");
    expect(fileSafePluginId("")).toBe("_");
  });
});

describe("InMemoryRegistryPersistence", () => {
  it("round-trips entries and isolates the stored copy", () => {
    const p = new InMemoryRegistryPersistence();
    const entries = { a: { n: 1 } };
    p.save("x", entries);
    const loaded = p.load("x") as typeof entries;
    expect(loaded).toEqual(entries);
    // Mutating the loaded copy does not affect the store (deep clone).
    loaded.a.n = 2;
    expect((p.load("x") as typeof entries).a.n).toBe(1);
  });
});
