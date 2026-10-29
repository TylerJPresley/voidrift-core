/**
 * The run cache adapter (core-blueprint.md §7.2 pass-by-reference, §8.7, §9.4).
 *
 * Stores text blobs the harness must keep whole instead of clipping them, under
 * `<workspaceRoot>/.voidrift/cache/run/<sessionId>/<id>.txt`, owner-only (dir
 * 0700, files 0600), written atomically with the unique-temp + rename pattern
 * used elsewhere. The id is `<kind>-<contentHash8>-<counter>` — a content hash
 * plus a monotonic counter so two different texts never collide and the id can
 * never carry a path separator or traversal segment (it is a bounded slug; the
 * filename is `<id>.txt`).
 *
 * The run-cache dir is a PROTECTED control path for file-WRITE tools (§9.4,
 * `protected-paths.ts`: `run` is NOT a writable cache subtree, so a model write
 * onto it is DENY), so only the core writes it. But a stored blob is READABLE by
 * the model's `read_file` (it reads any workspace-relative path through the
 * backend), so the handle round-trips. Reads inside this adapter never follow a
 * symlink out of the cache dir.
 *
 * Total size (across all sessions under the run dir) is bounded by
 * `limits.run.cacheMaxBytes` with oldest-first eviction; an eviction fires one
 * `LIMIT_HIT`. A single blob over `limits.run.entryMaxBytes` is truncated to the
 * cap before storage. Secret masking is the CALLER's job (it stores the already
 * stripped/masked worker text); this adapter is a pure byte store.
 *
 * I/O is direct `node:fs` with explicit modes (raw, not the text FileSystemPort),
 * matching the ingest/rollback stores (§10.12).
 */
import {
  mkdirSync,
  readdirSync,
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
import type { RunCache, RunCacheHandle, RunCacheKind } from "../entities/ports/run-cache.js";
import { limitDefault } from "../entities/limits.js";
import { limitMarker } from "../entities/ports/limits-port.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Count lines the way `read_file` reports them (an empty string is 0 lines). */
function countLines(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

export interface RunCacheDeps {
  /** The workspace root; blobs live at `<root>/.voidrift/cache/run/<session>/`. */
  workspaceRoot: string;
  /** The owning session id (one subtree per session), or a resolver when the
   * owning session is resolved per-dispatch (the shared orchestrator Subagents). */
  sessionId: string | (() => string);
  /** The effective cascaded total byte cap (§13.11); defaults to the registry value. */
  maxBytes?: number;
  /** The effective cascaded per-blob byte cap (§13.11); defaults to the registry value. */
  entryMaxBytes?: number;
  /** Emit ONE `LIMIT_HIT` for a run-cache limit (`run.cacheMaxBytes` on an
   * oldest-first eviction, or `run.entryMaxBytes` when a single blob is
   * truncated to the per-entry cap, §13.11). `observed` is the pre-truncation
   * byte size when a blob was cut. Optional. */
  onLimitHit?: (info: { key: string; value: number; observed?: number }) => void;
}

/** The filesystem run cache (§7.2, §8.7). */
export class FilesystemRunCache implements RunCache {
  private readonly runRoot: string;
  private readonly maxBytes: number;
  private readonly entryMaxBytes: number;
  private counter = 0;

  constructor(private readonly deps: RunCacheDeps) {
    this.runRoot = path.join(deps.workspaceRoot, ".voidrift", "cache", "run");
    this.maxBytes = deps.maxBytes ?? limitDefault("run.cacheMaxBytes");
    this.entryMaxBytes = deps.entryMaxBytes ?? limitDefault("run.entryMaxBytes");
  }

  /** The current owning session's subtree. */
  private currentSessionDir(): string {
    const sid = typeof this.deps.sessionId === "function" ? this.deps.sessionId() : this.deps.sessionId;
    return path.join(this.runRoot, sid);
  }

  store(kind: RunCacheKind, text: string): RunCacheHandle {
    const sessionDir = this.currentSessionDir();
    // A degenerate over-cap blob is truncated to the per-entry cap FIRST (byte
    // bounded, on a char boundary). The returned bytes/lines reflect what was
    // stored.
    let stored = text;
    const originalBytes = Buffer.byteLength(stored, "utf8");
    if (originalBytes > this.entryMaxBytes) {
      // §13.11 — a single over-cap blob is truncated to the per-entry cap, but
      // NEVER silently: fire ONE LIMIT_HIT for `run.entryMaxBytes` and append a
      // visible marker naming the key so the receiver of the handle sees the cut.
      // Reserve room for the marker so the stored blob stays WITHIN the cap.
      const marker = `\n${limitMarker("run.entryMaxBytes", originalBytes)}`;
      const room = Math.max(0, this.entryMaxBytes - Buffer.byteLength(marker, "utf8"));
      stored = this.truncateToBytes(stored, room) + marker;
      this.deps.onLimitHit?.({ key: "run.entryMaxBytes", value: this.entryMaxBytes, observed: originalBytes });
    }
    const bytes = Buffer.byteLength(stored, "utf8");
    const hash8 = createHash("sha256").update(stored, "utf8").digest("hex").slice(0, 8);
    const id = `${kind}-${hash8}-${this.counter++}`;
    const fileName = `${id}.txt`;

    mkdirSync(sessionDir, { recursive: true, mode: DIR_MODE });
    this.chmodBestEffort(this.runRoot, DIR_MODE);
    this.chmodBestEffort(sessionDir, DIR_MODE);

    const file = path.join(sessionDir, fileName);
    const tmp = `${file}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, stored, { mode: FILE_MODE });
    this.chmodBestEffort(tmp, FILE_MODE);
    renameSync(tmp, file);

    this.evictToCap();

    const handle = path
      .relative(this.deps.workspaceRoot, file)
      .split(path.sep)
      .join("/");
    return { handle, bytes, lines: countLines(stored) };
  }

  clearSession(sessionId: string): void {
    const dir = path.join(this.runRoot, sessionId);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  private chmodBestEffort(p: string, mode: number): void {
    try {
      chmodSync(p, mode);
    } catch {
      /* platforms without mode support */
    }
  }

  /** Truncate `text` so its UTF-8 byte length ≤ `cap`, on a whole-char boundary. */
  private truncateToBytes(text: string, cap: number): string {
    // Fast path: byte length already ≤ cap handled by the caller. Shrink by
    // chars until the byte length fits (a char is ≥ 1 byte, so this terminates).
    let end = Math.min(text.length, cap);
    while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > cap) end--;
    return text.slice(0, end);
  }

  /** Every `*.txt` blob across every session under the run dir, with size/mtime. */
  private listBlobs(): { full: string; size: number; mtime: number }[] {
    if (!existsSync(this.runRoot)) return [];
    const out: { full: string; size: number; mtime: number }[] = [];
    let sessions: string[];
    try {
      sessions = readdirSync(this.runRoot);
    } catch {
      return out;
    }
    for (const s of sessions) {
      const sdir = path.join(this.runRoot, s);
      let files: string[];
      try {
        if (!statSync(sdir).isDirectory()) continue;
        files = readdirSync(sdir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".txt")) continue;
        const full = path.join(sdir, f);
        try {
          // lstat, never stat: a cache blob the core wrote is a regular file.
          // A symlink entry (planted) is listed by the link itself and skipped
          // for sizing so eviction never follows or counts a target outside the
          // cache dir (rmSync below removes only the link, never its target).
          const st = lstatSync(full);
          if (st.isSymbolicLink() || !st.isFile()) continue;
          out.push({ full, size: st.size, mtime: st.mtimeMs });
        } catch {
          /* raced away */
        }
      }
    }
    return out;
  }

  /** Evict oldest-first (by mtime) until total size ≤ the cap; fire one
   * LIMIT_HIT if anything was evicted (§13.11). */
  private evictToCap(): void {
    const blobs = this.listBlobs();
    let total = blobs.reduce((n, b) => n + b.size, 0);
    if (total <= this.maxBytes) return;
    blobs.sort((a, b) => a.mtime - b.mtime);
    let evicted = false;
    for (const b of blobs) {
      if (total <= this.maxBytes) break;
      try {
        rmSync(b.full, { force: true });
        total -= b.size;
        evicted = true;
      } catch {
        /* best-effort */
      }
    }
    if (evicted) this.deps.onLimitHit?.({ key: "run.cacheMaxBytes", value: this.maxBytes });
  }
}

/**
 * An in-memory `RunCache` for tests (and a pure runtime where no disk is wanted).
 * Same id/eviction/entry-cap semantics as the fs adapter; the handle is a
 * synthetic workspace-relative path so a test can assert its shape without disk.
 */
export class InMemoryRunCache implements RunCache {
  private readonly map = new Map<string, { text: string; size: number; seq: number }>();
  private seq = 0;
  private counter = 0;
  private readonly maxBytes: number;
  private readonly entryMaxBytes: number;

  constructor(
    private readonly deps: { sessionId: string; maxBytes?: number; entryMaxBytes?: number; onLimitHit?: (info: { key: string; value: number; observed?: number }) => void },
  ) {
    this.maxBytes = deps.maxBytes ?? limitDefault("run.cacheMaxBytes");
    this.entryMaxBytes = deps.entryMaxBytes ?? limitDefault("run.entryMaxBytes");
  }

  /** The stored text for a handle, or null (a test reads a blob back). */
  read(handle: string): string | null {
    return this.map.get(handle)?.text ?? null;
  }

  store(kind: RunCacheKind, text: string): RunCacheHandle {
    let stored = text;
    const originalBytes = Buffer.byteLength(stored, "utf8");
    if (originalBytes > this.entryMaxBytes) {
      // §13.11 — per-blob truncation is never silent: ONE LIMIT_HIT + marker,
      // with the marker reserved inside the cap so the blob stays within it.
      const marker = `\n${limitMarker("run.entryMaxBytes", originalBytes)}`;
      const room = Math.max(0, this.entryMaxBytes - Buffer.byteLength(marker, "utf8"));
      let end = Math.min(stored.length, room);
      while (end > 0 && Buffer.byteLength(stored.slice(0, end), "utf8") > room) end--;
      stored = stored.slice(0, end) + marker;
      this.deps.onLimitHit?.({ key: "run.entryMaxBytes", value: this.entryMaxBytes, observed: originalBytes });
    }
    const bytes = Buffer.byteLength(stored, "utf8");
    const hash8 = createHash("sha256").update(stored, "utf8").digest("hex").slice(0, 8);
    const id = `${kind}-${hash8}-${this.counter++}`;
    const handle = `.voidrift/cache/run/${this.deps.sessionId}/${id}.txt`;
    this.map.set(handle, { text: stored, size: bytes, seq: this.seq++ });
    this.evictToCap();
    return { handle, bytes, lines: countLines(stored) };
  }

  clearSession(_sessionId: string): void {
    this.map.clear();
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
    if (evicted) this.deps.onLimitHit?.({ key: "run.cacheMaxBytes", value: this.maxBytes });
  }
}
