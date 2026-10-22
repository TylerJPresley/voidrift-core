/**
 * Session repositories (core-blueprint.md §5.1).
 *
 * The in-memory implementation is the test default (§1 rule 7) and the headless
 * ephemeral default; the filesystem implementation writes the session partition
 * under `.voidrift/sessions/{id}/` (§5.1). Both implement `SessionRepository`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { SessionRepository, PersistedSession } from "../../entities/ports/session-repository.js";
import type { SessionMetadata } from "../../entities/session.js";
import { maskValue } from "../../use-cases/secret-mask.js";

/** Session file mode — owner read/write only, never world-readable (§5.2). */
const SESSION_FILE_MODE = 0o600;
/** Session dir mode — owner-only. */
const SESSION_DIR_MODE = 0o700;

/**
 * The shape of a workspace session id (§5): the 8-character handle the
 * generator produces (`randomBytes(4).toString("hex")` — eight lowercase hex
 * digits). Validated at the repository boundary so a caller-supplied id
 * (`--resume <id>`, a web request, an API call) can NEVER traverse out of
 * `.voidrift/sessions/`: `remove(id)` does a recursive `fs.rm`, so an
 * unvalidated `../../x` or an absolute path here would be a destructive
 * traversal. An id that is not this shape is rejected before any path is built.
 */
const SESSION_ID = /^[0-9a-f]{8}$/;

/** Whether a caller-supplied id is a legal session handle (§5 containment). */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID.test(id);
}

/**
 * Minimal structural check that a parsed `metadata.json` is a `SessionMetadata`
 * (there is no Zod schema for the session shapes — these are plain entity
 * interfaces). A hand-edited or truncated file that parses as JSON but is the
 * wrong shape must not crash resume (§5.1): the required string/number fields
 * must be present and of the right type, else the partition is treated as
 * corrupt (load → null, list → skip).
 */
function isSessionMetadata(v: unknown): v is SessionMetadata {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m["id"] === "string" &&
    typeof m["name"] === "string" &&
    typeof m["summary"] === "string" &&
    typeof m["workspace"] === "string" &&
    typeof m["startedAt"] === "string" &&
    typeof m["lastActiveAt"] === "string" &&
    typeof m["turnCount"] === "number" &&
    typeof m["sizeBytes"] === "number" &&
    typeof m["namePinned"] === "boolean"
  );
}

/** In-memory session store, shared across CoreAPI instances in one process when
 * the same instance is injected — the way two "processes" share durable state
 * in a test is to share this instance (mirrors the SQLite file). */
export class InMemorySessionRepository implements SessionRepository {
  private readonly store = new Map<string, PersistedSession>();

  async save(state: PersistedSession): Promise<void> {
    // Deep-clone so later in-memory mutations don't leak into the mirror.
    this.store.set(state.metadata.id, structuredClone(state));
  }

  async load(id: string): Promise<PersistedSession | null> {
    const s = this.store.get(id);
    return s ? structuredClone(s) : null;
  }

  async list(): Promise<SessionMetadata[]> {
    return [...this.store.values()]
      .map((s) => s.metadata)
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  async remove(id: string): Promise<void> {
    this.store.delete(id);
  }
}

/**
 * Filesystem session store writing the partition under `.voidrift/sessions/{id}/`
 * (§5.1), crash-safe per §5.2.
 *
 * CRASH-SAFETY. Every file is written through TEMP-AND-RENAME (the same discipline
 * the staging adapter uses, §7.4): content goes to a `.tmp` sibling in the SAME
 * directory, then is atomically renamed over the target, so a crash mid-write can
 * never leave a half-written file. WRITE ORDER: the state files (`turns.json`,
 * `documents.json`, `session-state.json`) are written FIRST and `metadata.json`
 * LAST. `metadata.json` is the file `list()`/`load()` key on — it is the
 * existence anchor — so writing it last gives the invariant that whenever a
 * reader sees metadata, the state it refers to is already fully on disk; a crash
 * between the state writes and the metadata write leaves the PREVIOUS metadata
 * (and thus the previous consistent partition) intact, never a metadata that
 * disagrees with the rest.
 *
 * CONTAINMENT. Every id is validated at the boundary (`isValidSessionId`) before
 * any path is built, so a caller id like `../../x`, an absolute path, empty,
 * overlong, or one carrying a NUL can never escape `.voidrift/sessions/` — a
 * destructive concern because `remove()` does a recursive `fs.rm`.
 *
 * SECRETS. Pending approvals and session rules are masked through the ONE shared
 * detector (`maskValue`, §10.10) before `session-state.json` is written, so a
 * pending approval whose args carry a bearer token never lands in plaintext on
 * disk — consistent with every other durable egress (the staging manifest, logs).
 */
export class FilesystemSessionRepository implements SessionRepository {
  /** `rename` is injectable so a test can fail a write mid-save and assert the
   * previous state still loads intact (atomicity). Defaults to `fs.rename`. */
  constructor(
    private readonly workspaceRoot: string,
    private readonly rename: (from: string, to: string) => Promise<void> = fs.rename,
  ) {}

  /** Per-partition write serialization (§5.2). A session is mirrored on every
   * mutation AND asynchronously by off-turn work (passive naming, shutdown), so
   * two `save()`s to the SAME partition can overlap. Without serialization their
   * temp-and-rename sequences interleave: one writer's rename consumes or removes
   * the other's temp file, which surfaced as `ENOENT: rename … turns.json` on a
   * SIGTERM mid-write. Each partition's saves are chained so they apply in order,
   * and `drain()` awaits the tails on shutdown. */
  private readonly saveChains = new Map<string, Promise<void>>();
  /** A process-unique counter folded into every temp name so two saves in the
   * same millisecond never collide on the temp path (the root cause of the
   * rename race alongside the missing serialization). */
  private tmpSeq = 0;

  private base(): string {
    return path.join(this.workspaceRoot, ".voidrift", "sessions");
  }

  private dir(id: string): string {
    return path.join(this.base(), id);
  }

  /** Chain `op` after the prior save to this partition, so concurrent saves to
   * one session serialize (§5.2). The tail is dropped once it is the last link
   * so the map does not grow without bound across sessions. */
  private serialize(id: string, op: () => Promise<void>): Promise<void> {
    const prior = this.saveChains.get(id) ?? Promise.resolve();
    const next = prior.then(op, op);
    this.saveChains.set(id, next);
    void next.catch(() => undefined).finally(() => {
      if (this.saveChains.get(id) === next) this.saveChains.delete(id);
    });
    return next;
  }

  /** Atomic write: a UNIQUE temp file in the SAME dir then rename over the target
   * (§5.2). The temp name folds in the pid, a process-unique counter and a random
   * suffix so two overlapping writers (a turn mirror + passive naming/shutdown)
   * can never pick the same temp path — the collision that let one writer's
   * rename consume or `rm` another's temp and throw `ENOENT`. A rename onto a dir
   * that vanished under us (a concurrent session delete) is reported as the write
   * failing cleanly, never a torn target: the target is either the old file or
   * the fully-renamed new one. */
  private async atomicWrite(dir: string, name: string, content: string): Promise<void> {
    const target = path.join(dir, name);
    this.tmpSeq = (this.tmpSeq + 1) >>> 0;
    const unique = `${process.pid}.${Date.now()}.${this.tmpSeq}.${randomBytes(4).toString("hex")}`;
    const tmp = path.join(dir, `.${name}.${unique}.tmp`);
    await fs.writeFile(tmp, content, { mode: SESSION_FILE_MODE });
    try {
      await this.rename(tmp, target);
    } catch (e) {
      // A failed rename must not leave temp litter behind. The directory may have
      // vanished (a concurrent `remove()`); `force` makes the cleanup a no-op in
      // that case rather than a second throw that masks the real cause.
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  async save(state: PersistedSession): Promise<void> {
    const id = state.metadata.id;
    if (!isValidSessionId(id)) return; // never build a path from an illegal id
    // Serialize per partition so two overlapping saves (a turn mirror and an
    // off-turn naming/shutdown mirror) never interleave their temp-and-rename
    // sequences and race on the rename (§5.2).
    return this.serialize(id, async () => {
      const dir = this.dir(id);
      await fs.mkdir(dir, { recursive: true, mode: SESSION_DIR_MODE });
      // State files FIRST (see class doc for the write-order invariant).
      await this.atomicWrite(dir, "turns.json", JSON.stringify(state.turns ?? [], null, 2));
      await this.atomicWrite(dir, "documents.json", JSON.stringify(state.documents, null, 2));
      await this.atomicWrite(
        dir,
        "session-state.json",
        JSON.stringify(
          maskValue({
            pending: state.pending,
            sessionRules: state.sessionRules,
            approvalMode: state.approvalMode,
            lastStatus: state.lastStatus,
          }),
          null,
          2,
        ),
      );
      // metadata.json LAST — the existence/consistency anchor.
      await this.atomicWrite(dir, "metadata.json", JSON.stringify(state.metadata, null, 2));
    });
  }

  /** Await every accepted-but-unfinished save across all partitions so a clean
   * shutdown drains the mirror before exit (§5.2). A save never schedules another
   * save from within itself, so draining the current tails and re-checking until
   * the map empties reaches a fixed point; bounded (64 passes) so a pathological
   * producer cannot hang shutdown. */
  async drain(): Promise<void> {
    for (let i = 0; i < 64 && this.saveChains.size > 0; i += 1) {
      await Promise.allSettled([...this.saveChains.values()]);
    }
  }

  async load(id: string): Promise<PersistedSession | null> {
    if (!isValidSessionId(id)) return null;
    const dir = this.dir(id);
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(dir, "metadata.json"), "utf8")) as unknown;
      if (!isSessionMetadata(metadata)) return null;
      // Never trust an id inside the file over the directory name (§5.1).
      metadata.id = id;
      const documents = JSON.parse(await fs.readFile(path.join(dir, "documents.json"), "utf8"));
      const extra = JSON.parse(await fs.readFile(path.join(dir, "session-state.json"), "utf8"));
      const turns = await fs
        .readFile(path.join(dir, "turns.json"), "utf8")
        .then((t) => JSON.parse(t))
        .catch(() => []);
      return { metadata, documents, turns, ...extra } as PersistedSession;
    } catch {
      // A corrupt/truncated/absent partition yields null, never a throw (§5.1).
      return null;
    }
  }

  async list(): Promise<SessionMetadata[]> {
    let ids: string[] = [];
    try {
      ids = (await fs.readdir(this.base(), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter(isValidSessionId);
    } catch {
      return [];
    }
    const metas: SessionMetadata[] = [];
    for (const id of ids) {
      // One corrupt session never breaks the list (§5.1): load returns null.
      const loaded = await this.load(id);
      if (loaded) metas.push(loaded.metadata);
    }
    return metas.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  async remove(id: string): Promise<void> {
    // An unvalidated id here would be a destructive traversal (recursive rm) —
    // refuse anything that is not a legal handle before building a path (§5).
    if (!isValidSessionId(id)) return;
    await fs.rm(this.dir(id), { recursive: true, force: true });
  }
}
