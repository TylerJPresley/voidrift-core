/**
 * Run cache adapter tests (core-blueprint.md §7.2 pass-by-reference, §8.7, §9.4):
 * store/handle round trip readable with node fs, 0600/0700 modes, unique
 * content-addressed ids (no traversal), per-entry truncation, oldest-first
 * eviction bounded with LIMIT_HIT, symlink-safe, protected-path classification
 * (write DENY, dir readable), clearSession, and the in-memory impl.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, statSync, readFileSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FilesystemRunCache, InMemoryRunCache } from "./run-cache.js";
import { classifyControlPath } from "../entities/protected-paths.js";

let ws: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "vr-run-cache-"));
});
afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

const sessionDir = (sid: string) => path.join(ws, ".voidrift", "cache", "run", sid);

describe("FilesystemRunCache store/handle (§7.2)", () => {
  it("stores whole text and returns a workspace-relative handle readable from disk", () => {
    const cache = new FilesystemRunCache({ workspaceRoot: ws, sessionId: "s1" });
    const text = "line1\nline2\nline3";
    const { handle, bytes, lines } = cache.store("batch-result", text);
    expect(handle).toBe(`.voidrift/cache/run/s1/${path.basename(handle)}`);
    expect(bytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(lines).toBe(3);
    // read_file reads any workspace-relative path; the blob is on disk whole.
    expect(readFileSync(path.join(ws, handle), "utf8")).toBe(text);
  });

  it("writes dir 0700 and file 0600 (owner-only)", () => {
    const cache = new FilesystemRunCache({ workspaceRoot: ws, sessionId: "s1" });
    const { handle } = cache.store("brief", "x");
    expect(statSync(sessionDir("s1")).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(ws, handle)).mode & 0o777).toBe(0o600);
  });

  it("gives each store a unique content-addressed id with no path separators", () => {
    const cache = new FilesystemRunCache({ workspaceRoot: ws, sessionId: "s1" });
    const a = cache.store("brief", "same");
    const b = cache.store("brief", "same");
    expect(a.handle).not.toBe(b.handle); // counter makes repeats unique
    for (const h of [a.handle, b.handle]) {
      const id = path.basename(h, ".txt");
      expect(id).toMatch(/^[a-z-]+-[0-9a-f]{8}-\d+$/); // slug only, no / or ..
      expect(id.includes("/")).toBe(false);
      expect(id.includes("..")).toBe(false);
    }
  });

  it("resolves the active session per store via a sessionId resolver", () => {
    let sid = "sA";
    const cache = new FilesystemRunCache({ workspaceRoot: ws, sessionId: () => sid });
    const a = cache.store("brief", "a");
    sid = "sB";
    const b = cache.store("brief", "b");
    expect(a.handle).toContain("/run/sA/");
    expect(b.handle).toContain("/run/sB/");
  });

  it("truncates a blob over run.entryMaxBytes to the cap before storing", () => {
    const cache = new FilesystemRunCache({ workspaceRoot: ws, sessionId: "s1", entryMaxBytes: 10 });
    const { handle, bytes } = cache.store("brief", "y".repeat(100));
    expect(bytes).toBe(10);
    expect(readFileSync(path.join(ws, handle), "utf8").length).toBe(10);
  });

  it("bounds total size oldest-first and fires one LIMIT_HIT on eviction", () => {
    const hits: { key: string; value: number }[] = [];
    const cache = new FilesystemRunCache({ workspaceRoot: ws, sessionId: "s1", maxBytes: 15, onLimitHit: (i) => hits.push(i) });
    const a = cache.store("brief", "aaaaaaaa"); // 8 bytes
    expect(hits).toHaveLength(0);
    cache.store("brief", "bbbbbbbb"); // 8 bytes → total 16 > 15 → evict oldest (a)
    expect(existsSync(path.join(ws, a.handle))).toBe(false);
    expect(hits.some((h) => h.key === "run.cacheMaxBytes")).toBe(true);
  });

  it("clearSession removes exactly that session's subtree", () => {
    const cache = new FilesystemRunCache({ workspaceRoot: ws, sessionId: "s1" });
    cache.store("brief", "x");
    const other = new FilesystemRunCache({ workspaceRoot: ws, sessionId: "s2" });
    other.store("brief", "y");
    cache.clearSession("s1");
    expect(existsSync(sessionDir("s1"))).toBe(false);
    expect(existsSync(sessionDir("s2"))).toBe(true);
  });

  it("never follows a symlinked blob out of the cache dir on eviction listing", () => {
    const cache = new FilesystemRunCache({ workspaceRoot: ws, sessionId: "s1", maxBytes: 1 });
    cache.store("brief", "seed"); // creates the dir
    const secret = path.join(ws, "secret.txt");
    writeFileSync(secret, "SECRET");
    // A symlink inside the session dir pointing outside must not be followed to
    // delete the target; eviction removes the link entry, not the secret.
    const link = path.join(sessionDir("s1"), "evil-aaaaaaaa-9.txt");
    try {
      symlinkSync(secret, link);
    } catch {
      return; // platforms without symlink support: skip
    }
    cache.store("brief", "z".repeat(100)); // forces eviction pass
    expect(existsSync(secret)).toBe(true); // the real target is untouched
  });
});

describe("protected-path classification (§9.4)", () => {
  it("classifies .voidrift/cache/run as DENY for model file writes but the dir is readable", () => {
    const ctx = { workspaceRoot: ws, globalConfigDir: path.join(ws, "cfg"), home: ws };
    // Writes by model tools stay DENIED (run is not a writable cache subtree).
    expect(classifyControlPath(path.join(ws, ".voidrift/cache/run/s1/x.txt"), ctx)).toBe("deny");
    expect(classifyControlPath(".voidrift/cache/run/s1/x.txt", { globalConfigDir: path.join(ws, "cfg"), home: ws })).toBe("deny");
    // read_file has no control-path check: a store round-trips (covered above by
    // reading the handle off disk). The DENY here is the WRITE gate only.
  });
});

describe("InMemoryRunCache", () => {
  it("round-trips, truncates to the entry cap, and evicts oldest-first with LIMIT_HIT", () => {
    const hits: { key: string }[] = [];
    const cache = new InMemoryRunCache({ sessionId: "s1", maxBytes: 15, entryMaxBytes: 10, onLimitHit: (i) => hits.push(i) });
    const a = cache.store("brief", "aaaaaaaa");
    expect(cache.read(a.handle)).toBe("aaaaaaaa");
    const big = cache.store("brief", "z".repeat(100));
    expect(big.bytes).toBe(10);
    // a (8) is evicted because total exceeded 15 after the second store.
    expect(cache.read(a.handle)).toBeNull();
    expect(hits.some((h) => h.key === "run.cacheMaxBytes")).toBe(true);
  });
});
