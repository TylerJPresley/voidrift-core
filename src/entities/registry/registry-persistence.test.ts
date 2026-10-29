import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  NodeRegistryPersistence,
  InMemoryRegistryPersistence,
  pluginShortName,
  isRegistryFile,
} from "./registry-persistence.js";
import { getLimitSpec } from "../limits.js";

const REGISTRY_FILE_MAX_BYTES = getLimitSpec("plugins.registryFileMaxBytes")?.default ?? 1024 * 1024;

/** A hermetic temp workspace for each test. */
function tmp(): { workspace: string; cleanup: () => void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vr-reg-"));
  const workspace = base;
  return { workspace, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

describe("NodeRegistryPersistence (§12.5, STAGE 1)", () => {
  let env: ReturnType<typeof tmp>;
  beforeEach(() => (env = tmp()));
  afterEach(() => env.cleanup());

  it("writes one file per plugin at <workspace>/.voidrift/plugins/<name>/registry.json, inside the workspace", () => {
    const warn: string[] = [];
    const p = new NodeRegistryPersistence(env.workspace, (m) => warn.push(m));
    p.save("@voidrift/plugin-routines", { "routine:daily": { id: "daily", prompt: "x" } });

    const dir = path.join(env.workspace, ".voidrift", "plugins", "routines");
    const file = path.join(dir, "registry.json");
    // Given — the file is where §12.5 says, INSIDE the workspace at the project level.
    expect(fs.existsSync(file)).toBe(true);
    expect(file.includes(env.workspace)).toBe(true);
    // And — a versioned envelope round-trips.
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(isRegistryFile(parsed)).toBe(true);
    expect(parsed).toEqual({ version: 1, entries: { "routine:daily": { id: "daily", prompt: "x" } } });
    expect(warn).toEqual([]);
  });

  it("dirs are 0700 and files are 0600", () => {
    const p = new NodeRegistryPersistence(env.workspace);
    p.save("pluginA", { k: 1 });
    const dir = path.join(env.workspace, ".voidrift", "plugins", "plugina");
    const file = path.join(dir, "registry.json");
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("load returns {} for an absent file (empty start)", () => {
    const p = new NodeRegistryPersistence(env.workspace);
    expect(p.load("missing")).toEqual({});
  });

  it("remove deletes the plugin's registry.json file (disable)", () => {
    const p = new NodeRegistryPersistence(env.workspace);
    p.save("gone", { k: 1 });
    const file = path.join(env.workspace, ".voidrift", "plugins", "gone", "registry.json");
    expect(fs.existsSync(file)).toBe(true);
    p.remove("gone");
    expect(fs.existsSync(file)).toBe(false);
    // Idempotent: removing again does not throw.
    expect(() => p.remove("gone")).not.toThrow();
  });

  it("a malformed (non-JSON) file is set aside as registry.json.rejected with one warning and an empty start", () => {
    const warn: string[] = [];
    const p = new NodeRegistryPersistence(env.workspace, (m) => warn.push(m));
    const dir = path.join(env.workspace, ".voidrift", "plugins", "bad");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "registry.json");
    fs.writeFileSync(file, "{ not json");
    expect(p.load("bad")).toEqual({});
    expect(fs.existsSync(`${file}.rejected`)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(warn).toHaveLength(1);
  });

  it("a wrong-version or non-object-entries file is rejected without crash", () => {
    const warn: string[] = [];
    const p = new NodeRegistryPersistence(env.workspace, (m) => warn.push(m));
    // Create the necessary directory structure and files
    fs.mkdirSync(path.join(env.workspace, ".voidrift", "plugins", "v2"), { recursive: true });
    fs.mkdirSync(path.join(env.workspace, ".voidrift", "plugins", "arr"), { recursive: true });
    fs.writeFileSync(path.join(env.workspace, ".voidrift", "plugins", "v2", "registry.json"), JSON.stringify({ version: 2, entries: {} }));
    fs.writeFileSync(path.join(env.workspace, ".voidrift", "plugins", "arr", "registry.json"), JSON.stringify({ version: 1, entries: [] }));
    
    expect(p.load("v2")).toEqual({});
    expect(p.load("arr")).toEqual({});
    expect(fs.existsSync(path.join(env.workspace, ".voidrift", "plugins", "v2", "registry.json.rejected"))).toBe(true);
    expect(fs.existsSync(path.join(env.workspace, ".voidrift", "plugins", "arr", "registry.json.rejected"))).toBe(true);
    expect(warn).toHaveLength(2);
  });

  it("a file over the 1 MiB cap with action warn loads and emits LIMIT_HIT", () => {
    const warns: string[] = [];
    const limits: any[] = [];
    const p = new NodeRegistryPersistence(env.workspace, (m) => warns.push(m), {
      getLimit: () => REGISTRY_FILE_MAX_BYTES,
      getLimitAction: () => "warn",
      onLimitHit: (key, detail) => limits.push({ key, detail }),
    });
    const dir = path.join(env.workspace, ".voidrift", "plugins", "huge");
    fs.mkdirSync(dir, { recursive: true });
    const huge = { version: 1, entries: { big: "x".repeat(REGISTRY_FILE_MAX_BYTES + 10) } };
    const file = path.join(dir, "registry.json");
    fs.writeFileSync(file, JSON.stringify(huge));
    const loaded = p.load("huge");
    expect(loaded).toEqual({ big: "x".repeat(REGISTRY_FILE_MAX_BYTES + 10) });
    expect(fs.existsSync(`${file}.rejected`)).toBe(false);
    expect(limits).toHaveLength(1);
    expect(limits[0].key).toBe("plugins.registryFileMaxBytes");
    expect(limits[0].detail.action).toBe("warn");
  });

  it("a file over the 1 MiB cap with action deny is set aside, plugin starts empty", () => {
    const warns: string[] = [];
    const p = new NodeRegistryPersistence(env.workspace, (m) => warns.push(m), {
      getLimit: () => REGISTRY_FILE_MAX_BYTES,
      getLimitAction: () => "deny",
    });
    const dir = path.join(env.workspace, ".voidrift", "plugins", "huge");
    fs.mkdirSync(dir, { recursive: true });
    const huge = { version: 1, entries: { big: "x".repeat(REGISTRY_FILE_MAX_BYTES + 10) } };
    const file = path.join(dir, "registry.json");
    fs.writeFileSync(file, JSON.stringify(huge));
    expect(p.load("huge")).toEqual({});
    expect(fs.existsSync(`${file}.rejected`)).toBe(true);
    expect(warns).toHaveLength(1);
  });

  it("two processes writing at once end consistent — last-writer-wins per file, no corruption (documented)", () => {
    // Two adapters over the SAME workspace stand in for two processes. Each
    // writes the whole envelope atomically (temp + rename), so the file is
    // never half-written; the last rename wins.
    const a = new NodeRegistryPersistence(env.workspace);
    const b = new NodeRegistryPersistence(env.workspace);
    a.save("p", { k: "from-a" });
    b.save("p", { k: "from-b" });
    const file = path.join(env.workspace, ".voidrift", "plugins", "p", "registry.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(isRegistryFile(parsed)).toBe(true); // never corrupt
    expect(parsed.entries.k).toBe("from-b"); // last writer wins
  });
});

describe("pluginShortName", () => {
  it("keeps safe chars, replaces others with hyphens, collapses repeats", () => {
    expect(pluginShortName("@voidrift/plugin-plan")).toBe("plan");
    expect(pluginShortName("@voidrift/plugin-routines")).toBe("routines");
    expect(pluginShortName("a.b-c_0")).toBe("a-b-c-0");
    expect(pluginShortName("///")).toBe("");
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
