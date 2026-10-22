/**
 * Ingest cache adapter tests (core-blueprint.md §8.7, §9.4, §10.12):
 * put/get round trip, tamper detected + removed, eviction bounded with
 * LIMIT_HIT, permissions 0600/0700, symlink escape refused, protected-path
 * classification, and the in-memory impl.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, readdirSync, statSync, writeFileSync, symlinkSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { FilesystemIngestCache, InMemoryIngestCache, type IngestCacheSigner } from "./ingest-cache.js";
import { makeDigest, digestKey, type DigestInput } from "../entities/ingest-digest.js";
import { contentHash } from "../entities/hash.js";
import { classifyControlPath } from "../entities/protected-paths.js";
import { RollbackIntegrity } from "./rollback-integrity.js";

let ws: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "vr-ingest-cache-"));
});
afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

const cacheDir = () => path.join(ws, ".voidrift", "cache", "ingest");

const mkDigest = (content: string, purpose = "p"): ReturnType<typeof makeDigest> => {
  const input: DigestInput = {
    source: "src/x.ts",
    contentHash: contentHash(content),
    purpose,
    params: { chunkTargetTokens: 3000, digestTokens: 800, chunkerId: "generic" },
    ranges: [{ startLine: 1, endLine: 10, summary: "a range" }],
    overall: "overall",
  };
  return makeDigest(input);
};

describe("FilesystemIngestCache put/get (§8.7)", () => {
  it("put then get returns the same digest; a miss is null", () => {
    const cache = new FilesystemIngestCache({ workspaceRoot: ws });
    const d = mkDigest("hello");
    const key = digestKey(d.contentHash, d.purpose, d.params);
    expect(cache.get(key)).toBeNull();
    cache.put(d);
    expect(cache.get(key)).toEqual(d);
    expect(cache.stats().entries).toBe(1);
  });

  it("writes dir 0700 and file 0600", () => {
    const cache = new FilesystemIngestCache({ workspaceRoot: ws });
    const d = mkDigest("hello");
    cache.put(d);
    const dirMode = statSync(cacheDir()).mode & 0o777;
    const files = readdirSync(cacheDir());
    const fileMode = statSync(path.join(cacheDir(), files[0]!)).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });
});

describe("integrity (§10.12)", () => {
  it("a tampered file is ignored AND removed", () => {
    const cache = new FilesystemIngestCache({ workspaceRoot: ws });
    const d = mkDigest("hello");
    const key = digestKey(d.contentHash, d.purpose, d.params);
    cache.put(d);
    const file = path.join(cacheDir(), `${key}.json`);
    // Tamper: edit the digest body but leave the stale hash.
    const obj = JSON.parse(readFileSync(file, "utf8"));
    obj.digest.overall = "INJECTED";
    writeFileSync(file, JSON.stringify(obj));
    expect(cache.get(key)).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it("a planted file under a mismatched key name is ignored AND removed", () => {
    const cache = new FilesystemIngestCache({ workspaceRoot: ws });
    const d = mkDigest("hello");
    cache.put(d);
    // Copy the valid file under a DIFFERENT (but well-formed) key name.
    const realKey = digestKey(d.contentHash, d.purpose, d.params);
    const realFile = path.join(cacheDir(), `${realKey}.json`);
    const foreignKey = "f".repeat(64);
    const foreignFile = path.join(cacheDir(), `${foreignKey}.json`);
    writeFileSync(foreignFile, readFileSync(realFile, "utf8"));
    expect(cache.get(foreignKey)).toBeNull();
    expect(existsSync(foreignFile)).toBe(false);
  });
});

describe("eviction (§8.7, §13.11)", () => {
  it("bounds total size oldest-first and fires one LIMIT_HIT on eviction", () => {
    const hits: { key: string; value: number }[] = [];
    // A tiny cap so the second put evicts the first. The stored envelope now
    // carries a `version` field (no signer here → no `hmac`), so size from that.
    const one = mkDigest("aaaa", "p1");
    const oneBytes = Buffer.byteLength(JSON.stringify({ version: 2, hash: "x".repeat(64), digest: one }), "utf8");
    const cache = new FilesystemIngestCache({
      workspaceRoot: ws,
      maxBytes: oneBytes + 10,
      onLimitHit: (i) => hits.push(i),
    });
    const k1 = digestKey(one.contentHash, one.purpose, one.params);
    cache.put(one);
    expect(hits).toHaveLength(0);
    const two = mkDigest("bbbb", "p2");
    cache.put(two);
    // The oldest (k1) is gone; the cap held.
    expect(cache.get(k1)).toBeNull();
    expect(cache.stats().bytes).toBeLessThanOrEqual(oneBytes + 10);
    expect(hits.some((h) => h.key === "ingest.cacheMaxBytes")).toBe(true);
  });
});

describe("symlink escape (§9.4)", () => {
  it("refuses and removes a key file that is a symlink out of the cache dir", () => {
    const cache = new FilesystemIngestCache({ workspaceRoot: ws });
    // Ensure the dir exists.
    cache.put(mkDigest("seed"));
    const secret = path.join(ws, "secret.json");
    writeFileSync(secret, JSON.stringify({ hash: "x", digest: {} }));
    const key = "a".repeat(64);
    const link = path.join(cacheDir(), `${key}.json`);
    symlinkSync(secret, link);
    expect(cache.get(key)).toBeNull();
    expect(existsSync(link)).toBe(false);
  });
});

describe("protected-path classification (§9.4)", () => {
  it("classifies .voidrift/cache/ingest as DENY for model file writes", () => {
    const ctx = { workspaceRoot: ws, globalConfigDir: path.join(ws, "cfg"), home: ws };
    expect(classifyControlPath(path.join(ws, ".voidrift/cache/ingest/abc.json"), ctx)).toBe("deny");
    expect(classifyControlPath(".voidrift/cache/ingest/abc.json", { ...ctx, workspaceRoot: undefined })).toBe("deny");
  });
});

describe("HMAC authentication (§10.12, HIGH — poisoning)", () => {
  let cfgA: string;
  let cfgB: string;
  beforeEach(async () => {
    cfgA = await fs.mkdtemp(path.join(os.tmpdir(), "vr-ing-keyA-"));
    cfgB = await fs.mkdtemp(path.join(os.tmpdir(), "vr-ing-keyB-"));
  });
  afterEach(async () => {
    await fs.rm(cfgA, { recursive: true, force: true });
    await fs.rm(cfgB, { recursive: true, force: true });
  });

  const signer = (cfg: string): IngestCacheSigner => new RollbackIntegrity(cfg);

  it("a valid signed entry hits", () => {
    const cache = new FilesystemIngestCache({ workspaceRoot: ws, signer: signer(cfgA) });
    const d = mkDigest("hello");
    const key = digestKey(d.contentHash, d.purpose, d.params);
    cache.put(d);
    expect(cache.get(key)).toEqual(d);
    expect(cache.droppedForeign()).toBe(0);
  });

  it("a forged entry with a correct self-hash but NO hmac is ignored and removed", () => {
    const cache = new FilesystemIngestCache({ workspaceRoot: ws, signer: signer(cfgA) });
    const d = mkDigest("hello");
    const key = digestKey(d.contentHash, d.purpose, d.params);
    // Plant the OLD self-hash-only format (what a cloned repo could ship): a
    // correct self-hash, no hmac. The JSON lands at the right key filename.
    const selfHash = createHash("sha256").update(JSON.stringify(d), "utf8").digest("hex");
    const file = path.join(cacheDir(), `${key}.json`);
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(file, JSON.stringify({ hash: selfHash, digest: d }));
    expect(cache.get(key)).toBeNull();
    expect(existsSync(file)).toBe(false);
    expect(cache.droppedForeign()).toBe(1);
  });

  it("an entry signed by ANOTHER install fails (different key)", () => {
    const writer = new FilesystemIngestCache({ workspaceRoot: ws, signer: signer(cfgA) });
    const d = mkDigest("hello");
    const key = digestKey(d.contentHash, d.purpose, d.params);
    writer.put(d);
    const reader = new FilesystemIngestCache({ workspaceRoot: ws, signer: signer(cfgB) });
    expect(reader.get(key)).toBeNull();
    expect(reader.droppedForeign()).toBe(1);
  });

  it("an entry signed for ANOTHER workspace fails (workspace binding)", async () => {
    const otherWs = await fs.mkdtemp(path.join(os.tmpdir(), "vr-ing-ws2-"));
    try {
      const writer = new FilesystemIngestCache({ workspaceRoot: otherWs, signer: signer(cfgA) });
      const d = mkDigest("hello");
      const key = digestKey(d.contentHash, d.purpose, d.params);
      writer.put(d);
      const src = path.join(otherWs, ".voidrift", "cache", "ingest", `${key}.json`);
      mkdirSync(cacheDir(), { recursive: true });
      const dst = path.join(cacheDir(), `${key}.json`);
      writeFileSync(dst, readFileSync(src, "utf8"));
      const reader = new FilesystemIngestCache({ workspaceRoot: ws, signer: signer(cfgA) });
      expect(reader.get(key)).toBeNull();
      expect(reader.droppedForeign()).toBe(1);
    } finally {
      await fs.rm(otherWs, { recursive: true, force: true });
    }
  });
});

describe("InMemoryIngestCache", () => {
  it("round-trips and evicts oldest-first with LIMIT_HIT", () => {
    const hits: { key: string }[] = [];
    const one = mkDigest("aaaa", "p1");
    const size = Buffer.byteLength(JSON.stringify(one), "utf8");
    const cache = new InMemoryIngestCache({ maxBytes: size + 5, onLimitHit: (i) => hits.push(i) });
    const k1 = digestKey(one.contentHash, one.purpose, one.params);
    cache.put(one);
    expect(cache.get(k1)).toEqual(one);
    cache.put(mkDigest("bbbb", "p2"));
    expect(cache.get(k1)).toBeNull();
    expect(hits.some((h) => h.key === "ingest.cacheMaxBytes")).toBe(true);
  });
});
