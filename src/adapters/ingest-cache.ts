/**
 * The ingest digest cache adapter (core-blueprint.md §8.7, §9.4, §10.12).
 *
 * Stores one digest per key at `<workspaceRoot>/.voidrift/cache/ingest/<key>.json`,
 * owner-only (dir 0700, files 0600), written atomically with the unique-temp +
 * rename pattern used elsewhere. Each file carries an integrity `hash` INSIDE it
 * (sha256 over the canonical digest JSON); a file whose hash does not verify —
 * tampered or planted — is a MISS and is DELETED on read (§10.12 blob re-hash
 * stance). Total size is bounded by `limits.ingest.cacheMaxBytes`; when a `put`
 * would exceed the cap the OLDEST entries are evicted first (by mtime) and one
 * `LIMIT_HIT` for `ingest.cacheMaxBytes` fires.
 *
 * The cache dir is a PROTECTED control path for file-WRITE tools (§9.4,
 * `protected-paths.ts`: a non-`{session,index,staging}` cache subtree is DENY
 * for model writes), so only the core writes it. Reads NEVER follow a symlink
 * out of the cache dir: a key file that is a symlink is refused and deleted.
 *
 * I/O is direct `node:fs` with explicit modes (raw, not the text FileSystemPort),
 * matching the rollback snapshot store (§10.12).
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  existsSync,
  statSync,
  lstatSync,
  chmodSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import type { IngestCache, IngestCacheStats } from "../entities/ports/ingest-cache.js";
import { digestSchema, digestKey, type Digest } from "../entities/ingest-digest.js";
import { limitDefault } from "../entities/limits.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const KEY_RE = /^[0-9a-f]{64}$/;
const HMAC_RE = /^[0-9a-f]{64}$/;

/**
 * The HMAC envelope version. A file at a different version (or missing the
 * `hmac` field — the OLD self-hash-only format) is untrusted: a MISS, deleted,
 * and counted as a dropped foreign entry for the doctor (§10.12).
 */
const ENVELOPE_VERSION = 2 as const;

/**
 * A per-install HMAC signer (the SAME key `rollback.key` uses — reuse the
 * rollback loader, never a second key file, §10.12). `sign`/`verify` bind the
 * message to this install, the fixed `INGEST_BINDING` id (the ingest cache is
 * legitimately cross-SESSION, so it binds to the install + workspace, not a
 * session), and the workspace realpath. A null signer (a pure test, or a host
 * with no global dir) falls back to the self-hash-only format for that process.
 */
export interface IngestCacheSigner {
  sign(payload: unknown, id: string, workspaceRoot: string): string;
  verify(payload: unknown, id: string, workspaceRoot: string, hmac: unknown): boolean;
}

/** The binding id the ingest HMAC uses in place of a session id (the cache is
 * cross-session by design; §8.7). */
export const INGEST_BINDING = "ingest-cache";

/** Default byte cap (§8.7, §13.11 ING6): registry `ingest.cacheMaxBytes`. The
 * runtime passes the effective cascaded value via deps. */
const CACHE_MAX_BYTES_DEFAULT = limitDefault("ingest.cacheMaxBytes");

/** The on-disk envelope: the digest, a self-hash over its canonical JSON, and
 * (when a signer is wired) a per-install `hmac` that authenticates the entry to
 * THIS install + workspace. A missing/invalid hash OR a missing/invalid hmac
 * means the file is untrusted (ignored + deleted + counted). */
interface CacheFile {
  version?: number;
  hash: string;
  hmac?: string;
  digest: Digest;
}

/** Canonical JSON for hashing (stable key order via the schema's known shape;
 * JSON.stringify of the parsed digest is deterministic for our flat shape). */
function integrityHash(digest: Digest): string {
  return createHash("sha256").update(JSON.stringify(digest), "utf8").digest("hex");
}

/** The authenticated message bound by the HMAC (§10.12): the envelope version,
 * the content-addressed key, the workspace root, and every field a reader
 * trusts — source, contentHash, purpose, params, and the digest body. The
 * signer adds the install key + workspace realpath binding. */
function hmacPayload(workspaceRoot: string, key: string, digest: Digest): Record<string, unknown> {
  return {
    version: ENVELOPE_VERSION,
    key,
    workspaceRoot,
    source: digest.source,
    contentHash: digest.contentHash,
    purpose: digest.purpose,
    params: digest.params,
    digest,
  };
}

export interface IngestCacheStoreDeps {
  /** The workspace root; digests live at `<root>/.voidrift/cache/ingest/`. */
  workspaceRoot: string;
  /** The effective cascaded byte cap (§13.11); defaults to the registry value. */
  maxBytes?: number;
  /** Emit ONE `LIMIT_HIT` for `ingest.cacheMaxBytes` when a `put` evicts to stay
   * within the cap (§13.11). Optional (absent in a pure store test). */
  onLimitHit?: (info: { key: string; value: number }) => void;
  /** The per-install HMAC signer (§10.12), the SAME `rollback.key` loader. When
   * present, every entry is authenticated on write and verified on read; a
   * planted/foreign/unsigned/old-format file is a MISS, deleted, and counted.
   * Absent (a pure test / no global dir) → the self-hash-only format for that
   * process (no cross-install protection, same as before). */
  signer?: IngestCacheSigner;
}

/** The filesystem ingest digest cache (§8.7). */
export class FilesystemIngestCache implements IngestCache {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly workspaceRoot: string;
  /** Count of entries dropped on read because they were planted/foreign/unsigned
   * or in the old self-hash-only format (surfaced to the doctor, §10.12). */
  private droppedForeignCount = 0;

  constructor(private readonly deps: IngestCacheStoreDeps) {
    this.dir = path.join(deps.workspaceRoot, ".voidrift", "cache", "ingest");
    this.maxBytes = deps.maxBytes ?? CACHE_MAX_BYTES_DEFAULT;
    this.workspaceRoot = deps.workspaceRoot;
  }

  /** How many entries this instance dropped as untrusted (doctor warning count). */
  droppedForeign(): number {
    return this.droppedForeignCount;
  }

  private fileFor(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  get(key: string): Digest | null {
    if (!KEY_RE.test(key)) return null;
    const file = this.fileFor(key);
    if (!existsSync(file)) return null;
    // Never follow a symlink out of the cache dir: a key file that is a symlink
    // is refused and removed (a planted link to an outside target).
    try {
      if (lstatSync(file).isSymbolicLink()) {
        this.remove(file);
        return null;
      }
    } catch {
      return null;
    }
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return null;
    }
    let parsed: CacheFile;
    try {
      const obj = JSON.parse(raw) as unknown;
      // Validate the digest shape; a different version / bad shape throws → miss.
      const candidate = obj as { version?: unknown; hash?: unknown; hmac?: unknown; digest?: unknown };
      const digest = digestSchema.parse(candidate.digest);
      parsed = {
        hash: String(candidate.hash ?? ""),
        digest,
        ...(typeof candidate.version === "number" ? { version: candidate.version } : {}),
        ...(typeof candidate.hmac === "string" ? { hmac: candidate.hmac } : {}),
      };
    } catch {
      // Unparseable or wrong-shape/version: treat as a planted file → delete.
      this.remove(file);
      return null;
    }
    // Integrity: the stored hash must match a re-hash of the digest. A tampered
    // file (digest edited, hash stale) is ignored AND deleted (§10.12).
    if (parsed.hash !== integrityHash(parsed.digest)) {
      this.remove(file);
      return null;
    }
    // A key mismatch (the filename does not match the digest's own key) is also
    // a planted/renamed file — the cache is content-addressed by its own fields.
    const own = digestKey(parsed.digest.contentHash, parsed.digest.purpose, parsed.digest.params);
    if (own !== key) {
      this.remove(file);
      return null;
    }
    // Authentication (§10.12, HIGH): when a signer is wired, the entry MUST carry
    // a valid per-install HMAC for THIS install + workspace. A self-hash alone is
    // forgeable by a cloned repo (it is a hash of public inputs), so a planted,
    // foreign (another install/workspace), unsigned, or old self-hash-only file
    // is a MISS — deleted and counted for the doctor (timing-safe compare lives
    // in the signer). Without a signer we keep the self-hash-only behaviour.
    if (this.deps.signer) {
      const ok =
        parsed.version === ENVELOPE_VERSION &&
        typeof parsed.hmac === "string" &&
        HMAC_RE.test(parsed.hmac) &&
        this.deps.signer.verify(hmacPayload(this.workspaceRoot, key, parsed.digest), INGEST_BINDING, this.workspaceRoot, parsed.hmac);
      if (!ok) {
        this.droppedForeignCount++;
        this.remove(file);
        return null;
      }
    }
    return parsed.digest;
  }

  put(digest: Digest): void {
    // Re-validate at the boundary so a malformed digest never reaches disk.
    const d = digestSchema.parse(digest);
    const key = digestKey(d.contentHash, d.purpose, d.params);
    mkdirSync(this.dir, { recursive: true, mode: DIR_MODE });
    try {
      chmodSync(this.dir, DIR_MODE);
    } catch {
      /* best-effort on platforms without mode support */
    }
    const file = this.fileFor(key);
    const payload: CacheFile = { version: ENVELOPE_VERSION, hash: integrityHash(d), digest: d };
    if (this.deps.signer) {
      payload.hmac = this.deps.signer.sign(hmacPayload(this.workspaceRoot, key, d), INGEST_BINDING, this.workspaceRoot);
    }
    const body = JSON.stringify(payload);
    const tmp = `${file}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, body, { mode: FILE_MODE });
    try {
      chmodSync(tmp, FILE_MODE);
    } catch {
      /* best-effort */
    }
    renameSync(tmp, file);
    this.evictToCap();
  }

  stats(): IngestCacheStats {
    const files = this.listFiles();
    let bytes = 0;
    for (const f of files) {
      try {
        bytes += statSync(path.join(this.dir, f)).size;
      } catch {
        /* a file racing away during stat is simply not counted */
      }
    }
    return { entries: files.length, bytes };
  }

  /** The `<key>.json` files currently in the cache dir. */
  private listFiles(): string[] {
    if (!existsSync(this.dir)) return [];
    try {
      return readdirSync(this.dir).filter((f) => f.endsWith(".json") && KEY_RE.test(f.slice(0, -5)));
    } catch {
      return [];
    }
  }

  /** Evict oldest-first (by mtime) until total size ≤ the cap; fire one
   * LIMIT_HIT if anything was evicted (§13.11). */
  private evictToCap(): void {
    let entries = this.listFiles().map((f) => {
      const full = path.join(this.dir, f);
      try {
        const st = statSync(full);
        return { full, size: st.size, mtime: st.mtimeMs };
      } catch {
        return { full, size: 0, mtime: 0 };
      }
    });
    let total = entries.reduce((n, e) => n + e.size, 0);
    if (total <= this.maxBytes) return;
    // Oldest first.
    entries = entries.sort((a, b) => a.mtime - b.mtime);
    let evicted = false;
    for (const e of entries) {
      if (total <= this.maxBytes) break;
      this.remove(e.full);
      total -= e.size;
      evicted = true;
    }
    if (evicted) {
      this.deps.onLimitHit?.({ key: "ingest.cacheMaxBytes", value: this.maxBytes });
    }
  }

  private remove(file: string): void {
    try {
      rmSync(file, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * An in-memory `IngestCache` for tests (and a pure runtime where no disk is
 * wanted). Same key/eviction semantics as the fs adapter; integrity is implicit
 * (nothing external can tamper with the map). Size is the JSON byte length.
 */
export class InMemoryIngestCache implements IngestCache {
  private readonly map = new Map<string, { digest: Digest; size: number; seq: number }>();
  private seq = 0;
  private readonly maxBytes: number;

  constructor(private readonly deps: { maxBytes?: number; onLimitHit?: (info: { key: string; value: number }) => void } = {}) {
    this.maxBytes = deps.maxBytes ?? CACHE_MAX_BYTES_DEFAULT;
  }

  get(key: string): Digest | null {
    if (!KEY_RE.test(key)) return null;
    return this.map.get(key)?.digest ?? null;
  }

  put(digest: Digest): void {
    const d = digestSchema.parse(digest);
    const key = digestKey(d.contentHash, d.purpose, d.params);
    const size = Buffer.byteLength(JSON.stringify(d), "utf8");
    this.map.set(key, { digest: d, size, seq: this.seq++ });
    this.evictToCap();
  }

  stats(): IngestCacheStats {
    let bytes = 0;
    for (const v of this.map.values()) bytes += v.size;
    return { entries: this.map.size, bytes };
  }

  private evictToCap(): void {
    let total = 0;
    for (const v of this.map.values()) total += v.size;
    if (total <= this.maxBytes) return;
    const ordered = [...this.map.entries()].sort((a, b) => a[1].seq - b[1].seq);
    let evicted = false;
    for (const [k, v] of ordered) {
      if (total <= this.maxBytes) break;
      this.map.delete(k);
      total -= v.size;
      evicted = true;
    }
    if (evicted) this.deps.onLimitHit?.({ key: "ingest.cacheMaxBytes", value: this.maxBytes });
  }
}
