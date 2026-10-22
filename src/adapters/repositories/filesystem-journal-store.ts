/**
 * The filesystem mutation journal store (core-blueprint.md §10.11).
 *
 * Per session, under the existing session storage root (`<stateDir>`):
 *   <stateDir>/journal/<sessionId>/entries.jsonl   append-only, one JSON/line
 *   <stateDir>/journal/<sessionId>/blobs/<sha>     content-addressed, write-once
 *
 * Durability & permissions: directories are created mode 0700, files 0600. An
 * entry append is fsync'd (the data AND the directory) so a crash never loses an
 * acknowledged entry or leaves a torn line — the FAIL-CLOSED contract (§10.11)
 * depends on `append` only resolving once the entry is durable. A blob is
 * written atomically (temp + rename) and only once (content-addressed), so a
 * concurrent duplicate write is harmless.
 *
 * RAW storage (unmasked), the same accepted stance as `checkpoint.db`: a revert
 * must restore the real bytes, including any secret. This store is a PROTECTED
 * CONTROL LOCATION (§9.4) that the file and shell tools can neither read nor
 * write; that guard lives in the Guardian, not here.
 *
 * I/O is done directly against `node:fs` (not the text `FileSystemPort`) because
 * raw Buffer blobs, explicit 0600/0700 modes, and fsync are durability concerns
 * an adapter owns — the same reason the checkpointer and `fs-purge` do.
 */
import {
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
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
import path from "node:path";
import type { JournalStore } from "../../entities/ports/journal-store.js";
import {
  type JournalEntry,
  blobHash,
  isBlobSha,
  planBlobRetention,
  JOURNAL_LIMITS,
} from "../../entities/journal.js";
import { isValidSessionId } from "./session-repository.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface FilesystemJournalStoreDeps {
  /** The session storage root — `<workspaceRoot>/.voidrift` (same as the
   * checkpoint db). The journal lives at `<stateDir>/journal/<sessionId>/`. */
  stateDir: string;
  /** Read an effective limit (§13.11); used for `journal.maxBlobBytes` (JRNL3)
   * and `journal.maxEntries` (JRNL5). Optional: absent → the entity defaults. */
  getLimit?: (key: string) => number;
}

export class FilesystemJournalStore implements JournalStore {
  constructor(private readonly deps: FilesystemJournalStoreDeps) {}

  private sessionDir(sessionId: string): string {
    // §10.11 / LOW-1 — reject an illegal session id BEFORE any `path.join`, so a
    // `../…` or absolute value can never build a traversal path.
    if (!isValidSessionId(sessionId)) {
      throw new Error("invalid session id for journal store");
    }
    return path.join(this.deps.stateDir, "journal", sessionId);
  }
  private entriesPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "entries.jsonl");
  }
  private blobsDir(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "blobs");
  }

  /** Refuse a SYMLINKED journal or blobs directory (§10.11): a symlink could
   * redirect raw writes/reads out of the protected store. `lstat` (not `stat`)
   * so a link itself is detected, not its target. */
  private refuseSymlinkedDir(dir: string): void {
    if (existsSync(dir)) {
      const st = lstatSync(dir);
      if (st.isSymbolicLink()) {
        throw new Error("journal directory is a symlink; refusing");
      }
    }
  }

  /** Create the session's journal tree with restrictive modes (idempotent). */
  private ensureDirs(sessionId: string): void {
    const journalDir = path.join(this.deps.stateDir, "journal");
    // Refuse a symlinked journal/session/blobs dir on open (LOW-1).
    this.refuseSymlinkedDir(journalDir);
    this.refuseSymlinkedDir(this.sessionDir(sessionId));
    this.refuseSymlinkedDir(this.blobsDir(sessionId));
    mkdirSync(this.blobsDir(sessionId), { recursive: true, mode: DIR_MODE });
    // mkdirSync's `mode` applies only to created dirs; set it explicitly on the
    // journal subtree in case an umask loosened it on creation.
    for (const d of [journalDir, this.sessionDir(sessionId), this.blobsDir(sessionId)]) {
      try {
        if (existsSync(d)) chmodSync(d, DIR_MODE);
      } catch {
        /* best-effort tightening */
      }
    }
  }

  async putBlob(sessionId: string, content: Buffer): Promise<string> {
    const sha = blobHash(content);
    // §10.11 / LOW-1 — the sha we build is always valid; assert it before join.
    if (!isBlobSha(sha)) throw new Error("computed blob sha is not valid hex");
    this.ensureDirs(sessionId);
    const dest = path.join(this.blobsDir(sessionId), sha);
    if (existsSync(dest)) return sha; // write-once (content-addressed)
    // Atomic temp + rename so a concurrent duplicate never yields a torn blob.
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, content, { mode: FILE_MODE });
    renameSync(tmp, dest);
    return sha;
  }

  async getBlob(sessionId: string, sha: string): Promise<Buffer | null> {
    // §10.11 / LOW-1 — reject a sha that is not EXACTLY 64 lowercase hex chars
    // (so `../../etc/passwd`, uppercase, short hex, or a NUL can never build a
    // path) BEFORE any `path.join`.
    if (!isBlobSha(sha)) throw new Error("invalid blob sha");
    const p = path.join(this.blobsDir(sessionId), sha);
    if (!existsSync(p)) return null;
    const bytes = readFileSync(p);
    // Verify integrity on read: the content MUST hash to its name. A mismatch is
    // a tampered or corrupt blob — return an error, never the bytes.
    if (blobHash(bytes) !== sha) throw new Error("blob content does not match its sha (tampered or corrupt)");
    return bytes;
  }

  async append(sessionId: string, entry: JournalEntry): Promise<void> {
    this.ensureDirs(sessionId);
    const line = JSON.stringify(entry) + "\n";
    const file = this.entriesPath(sessionId);
    // Open for append, write, fsync the data, then fsync the directory so the
    // dirent for a newly created entries.jsonl is durable too. Only resolve once
    // durable — the FAIL-CLOSED ordering depends on it.
    const fd = openSync(file, "a", FILE_MODE);
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      const dfd = openSync(this.sessionDir(sessionId), "r");
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      /* directory fsync is best-effort on platforms that disallow it */
    }
  }

  private readEntries(sessionId: string): JournalEntry[] {
    const file = this.entriesPath(sessionId);
    if (!existsSync(file)) return [];
    const body = readFileSync(file, "utf8");
    const out: JournalEntry[] = [];
    for (const l of body.split("\n")) {
      if (l.trim() === "") continue;
      try {
        out.push(JSON.parse(l) as JournalEntry);
      } catch {
        /* a torn trailing line is skipped (fail-closed append makes this rare) */
      }
    }
    return out;
  }

  async nextSeq(sessionId: string): Promise<number> {
    const entries = this.readEntries(sessionId);
    let max = 0;
    for (const e of entries) if (e.seq > max) max = e.seq;
    return max + 1;
  }

  async list(sessionId: string, opts?: { limit?: number; afterSeq?: number }): Promise<JournalEntry[]> {
    let entries = this.readEntries(sessionId).sort((a, b) => a.seq - b.seq);
    if (opts?.afterSeq !== undefined) entries = entries.filter((e) => e.seq > opts.afterSeq!);
    if (opts?.limit !== undefined) entries = entries.slice(0, opts.limit);
    return entries;
  }

  async enforceRetention(
    sessionId: string,
    pinnedShas?: ReadonlySet<string>,
  ): Promise<{ evictedShas: string[]; blobsEvictedSeqs: number[] }> {
    const dir = this.blobsDir(sessionId);
    if (!existsSync(dir)) return { evictedShas: [], blobsEvictedSeqs: [] };
    const entries = this.readEntries(sessionId);
    const refs = new Map<string, Set<number>>();
    for (const e of entries) {
      for (const sha of [e.blobs?.before, e.blobs?.after]) {
        if (!sha) continue;
        if (!refs.has(sha)) refs.set(sha, new Set());
        refs.get(sha)!.add(e.seq);
      }
    }
    // Blobs in filesystem mtime order (oldest first) so eviction drops the
    // oldest first, as §10.11 requires. §10.11 / LOW-1 — only names that are a
    // valid 64-hex sha are considered (a tmp file or a stray name is skipped),
    // so eviction never builds a path from an unvalidated name.
    const names = readdirSync(dir).filter((n) => isBlobSha(n));
    const blobs = names
      .map((sha) => {
        const p = path.join(dir, sha);
        const st = statSync(p);
        return { sha, bytes: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime)
      .map(({ sha, bytes }) => ({ sha, bytes }));
    const plan = planBlobRetention(
      { blobs, refs, ...(pinnedShas ? { pinned: pinnedShas } : {}) },
      this.deps.getLimit?.("journal.maxBlobBytes") ?? JOURNAL_LIMITS.maxBlobBytes,
    );
    for (const sha of plan.evictShas) {
      if (!isBlobSha(sha)) continue;
      try {
        rmSync(path.join(dir, sha), { force: true });
      } catch {
        /* best-effort */
      }
    }
    // §13.11 (JRNL5) — the entry-count cap is sourced from the registry; today's
    // behaviour is a no-op on entries (never deleted for the count cap, §10.11).
    void (this.deps.getLimit?.("journal.maxEntries") ?? JOURNAL_LIMITS.maxEntries);
    return { evictedShas: plan.evictShas, blobsEvictedSeqs: [...plan.evictedEntrySeqs] };
  }
}
