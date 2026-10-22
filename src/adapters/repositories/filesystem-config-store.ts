/**
 * Filesystem config-store adapter (core-blueprint.md §13.1).
 *
 * Reads and writes each layer's JSON file: global at
 * `~/.config/voidrift/config.json`, project at `.voidrift/config.json`, session
 * at the session directory. The managed layer is a seam in slice 1 (§13.5): its
 * path resolves but is never read. Tests use the in-memory store instead.
 *
 * The SESSION layer has a backing file ONLY when a `sessionDir` is given
 * (hosts/tests that pass one). With no `sessionDir` the session layer is purely
 * in-memory: it never resolves to the project's `config.json`, so the project
 * document is read exactly once (as `project`) and a `set(..., "session")`
 * never writes into the project file. `read("session")` returns what was last
 * written in memory (initially null); `write`/`reject` for it are in-memory
 * only and create no file.
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import type { ConfigStore } from "../../entities/ports/config-store.js";
import { ConfigReadError } from "../../entities/ports/config-store.js";
import type { ConfigLayer } from "../../config/schema.js";

/** The `pathOf("session")` label when the session layer has no backing file. */
const SESSION_MEMORY_PATH = "(session overrides)";

export class FilesystemConfigStore implements ConfigStore {
  /** In-memory session document when no `sessionDir` backs the session layer. */
  private sessionDoc: Record<string, unknown> | null = null;

  constructor(
    private readonly workspaceRoot: string,
    private readonly sessionDir?: string,
    private readonly globalDir = path.join(os.homedir(), ".config", "voidrift"),
  ) {}

  /** True when the session layer lives in memory (no backing file). */
  private get sessionInMemory(): boolean {
    return this.sessionDir === undefined;
  }

  private file(layer: ConfigLayer): string {
    switch (layer) {
      case "global":
        return path.join(this.globalDir, "config.json");
      case "project":
        return path.join(this.workspaceRoot, ".voidrift", "config.json");
      case "session":
        // Only reached when a `sessionDir` is configured; the in-memory case is
        // handled by the callers before `file` is used.
        return path.join(this.sessionDir ?? path.join(this.workspaceRoot, ".voidrift"), "config.json");
      case "managed":
        return path.join(this.workspaceRoot, ".voidrift", "managed.json");
    }
  }

  async read(layer: ConfigLayer): Promise<Record<string, unknown> | null> {
    if (layer === "managed") return null; // managed layer is a seam (§13.5)
    if (layer === "session" && this.sessionInMemory) return this.sessionDoc;
    // §13.2–§13.3 — an ABSENT file (ENOENT) is `null`; a file that EXISTS but
    // cannot be loaded is a rejection, never silently absent. Read first so a
    // read failure (EACCES, EISDIR, …) surfaces as `ConfigReadError` with no raw
    // bytes; then parse, surfacing a syntax error as `ConfigReadError` carrying
    // the exact bytes so the caller can preserve them in the `.rejected` copy.
    const f = this.file(layer);
    let raw: string;
    try {
      raw = await fs.readFile(f, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      const reason = (e as NodeJS.ErrnoException)?.code
        ? `cannot read config file (${(e as NodeJS.ErrnoException).code})`
        : "cannot read config file";
      throw new ConfigReadError(layer, reason);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ConfigReadError(layer, "file is not valid JSON", raw);
    }
    // §13.2–§13.3 — the JSON must parse to a plain object (a config document is
    // a map of keys). A root that is `null`, an array, a number, a string, or a
    // boolean is a REJECTED layer, not absent and not reformatted: carry the
    // exact bytes so rejectRaw preserves them, and the notice tells the user the
    // file's top level must be an object.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigReadError(layer, "config root is not an object", raw);
    }
    return parsed as Record<string, unknown>;
  }

  async write(layer: ConfigLayer, doc: Record<string, unknown>): Promise<void> {
    if (layer === "session" && this.sessionInMemory) {
      this.sessionDoc = doc;
      return;
    }
    const f = this.file(layer);
    // §9.2 — a symlinked config DIRECTORY is ALLOWED: dotfile managers routinely
    // symlink `~/.config/voidrift` (and a project `.voidrift`) to a dotfiles
    // repo, and `voidrift init`, seeding, set() and persist must keep working
    // through it. The redirection risk we refuse is the config FILE itself being
    // a symlink (checked below) — writing through it would land the write at the
    // link's destination.
    const dir = path.dirname(f);
    // §13.1 / §9.2 — a config file may hold permission rules, so both the
    // `.voidrift` config dir and the file are owner-only (dir 0700, file 0600),
    // exactly like `voidrift init` seeds them. chmod after mkdir makes the
    // posture hold even when the dir pre-existed (session cache, etc.).
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700).catch(() => undefined);

    // §9.2 — never follow a symlinked config file. A symlink at the target lets
    // an attacker redirect the write through it; refuse rather than writing the
    // link's destination. `lstat` does NOT follow the link, so a symlink is seen
    // as a symlink (a regular file or ENOENT falls through to the atomic write).
    const existingLink = await fs.lstat(f).catch(() => null);
    if (existingLink?.isSymbolicLink()) {
      throw new Error(`refusing to write through a symlinked config file: ${f}`);
    }

    // §13.1 — a REAL atomic write: write the full document to a fresh temp file
    // in the SAME directory (so the rename is a same-filesystem atomic swap),
    // fsync it to durably flush the bytes, then rename it over the target. A
    // reader sees either the old file or the complete new one, never a partial
    // write. `wx` creates the temp exclusively (0600) so a stale/colliding name
    // never silently truncates another file; any failure removes the temp.
    const tmp = `${f}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const data = JSON.stringify(doc, null, 2);
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(tmp, "wx", 0o600);
      await handle.writeFile(data, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(tmp, f);
      // The rename preserves the temp's 0600 mode; re-assert it defensively in
      // case an existing target carried a looser mode a platform kept.
      await fs.chmod(f, 0o600).catch(() => undefined);
    } catch (e) {
      // Clean up on any failure so a failed rename leaves no temp behind and the
      // old file stays intact. Close first if the handle is still open.
      if (handle) await handle.close().catch(() => undefined);
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  async reject(layer: ConfigLayer, doc: Record<string, unknown>): Promise<void> {
    if (layer === "session" && this.sessionInMemory) {
      // No backing file: a rejected in-memory session document is simply dropped.
      return;
    }
    const f = this.file(layer) + ".rejected";
    await this.writeRejected(f, JSON.stringify(doc, null, 2));
  }

  async rejectRaw(layer: ConfigLayer, raw: string): Promise<void> {
    if (layer === "session" && this.sessionInMemory) {
      // No backing file: a rejected in-memory session document is simply dropped.
      return;
    }
    // Preserve the user's EXACT original bytes so a hand-edited file is
    // recoverable from the `.rejected` sibling (§13.3). No reformatting.
    const f = this.file(layer) + ".rejected";
    await this.writeRejected(f, raw);
  }

  /**
   * Write a `<file>.rejected` sibling owner-only (0600) — it may carry the
   * permission rules from a rejected config, so it is as sensitive as the live
   * file. A later rejection OVERWRITES the previous `.rejected` copy (only the
   * most recent rejected content is kept); the original live config file is
   * never deleted or altered by this. If a `.rejected` already exists with a
   * wider mode, chmod it back to 0600.
   */
  private async writeRejected(f: string, data: string): Promise<void> {
    await fs.mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
    await fs.writeFile(f, data, { encoding: "utf8", mode: 0o600 });
    // `writeFile`'s mode only applies on create; chmod makes 0600 hold when the
    // sibling pre-existed with a looser mode.
    await fs.chmod(f, 0o600).catch(() => undefined);
  }

  pathOf(layer: ConfigLayer): { path: string; exists: boolean } {
    if (layer === "session" && this.sessionInMemory) {
      // A clear, non-file label so no consumer mistakes it for a real path.
      return { path: SESSION_MEMORY_PATH, exists: false };
    }
    const f = this.file(layer);
    return { path: f, exists: existsSync(f) };
  }
}
