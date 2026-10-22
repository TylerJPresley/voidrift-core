/**
 * Filesystem and shell ports (core-blueprint.md §1 rule 1, §8.2).
 *
 * Entities and tools reach the host only through these ports; the concrete
 * adapters live in `adapters/` and are wired in `boot.ts`. Tests inject
 * in-memory implementations (§1 rule 7).
 */

export interface FileSystemPort {
  /** Read a file's text; rejects when it does not exist. */
  readFile(path: string): Promise<string>;
  /**
   * Read a file's raw bytes (§3.3 vision attachments). Containment and symlink
   * rules are IDENTICAL to `readFile` (resolved through the one workspace-root
   * chokepoint). `maxBytes` caps the read: a file larger than the cap rejects
   * BEFORE any bytes are buffered, so an oversized image never loads into
   * memory.
   */
  readBinary(path: string, opts: { maxBytes: number }): Promise<Uint8Array>;
  /** Write a file, creating parent directories. */
  writeFile(path: string, content: string): Promise<void>;
  /**
   * Durable, private write (§8.3): temp file in the SAME directory then rename
   * over the target (atomic, symlink-safe), with an explicit file mode. Used for
   * the evicted large-result cache, whose plaintext must not be world-readable
   * and must never be seen half-written.
   */
  writeFileAtomic(path: string, content: string, opts?: { mode?: number }): Promise<void>;
  /** True when the path exists. */
  exists(path: string): Promise<boolean>;
  /** Remove a file; a no-op when it does not exist. */
  remove(path: string): Promise<void>;
  /**
   * Remove a directory and everything under it; a no-op when it does not exist
   * (§12.1). Used to clean up a half-written staging directory so a failed
   * skill write leaves nothing partial.
   */
  removeDir(path: string): Promise<void>;
  /**
   * Rename/move `from` onto `to` (§12.1). On the real filesystem a rename
   * within the same parent is atomic, so a staging directory can be published
   * under its final name in one step. `to` is replaced if it already exists.
   */
  rename(from: string, to: string): Promise<void>;
  /** Glob workspace-relative paths matching a pattern (capped by the caller). */
  glob(pattern: string): Promise<string[]>;
  /** Regex content search across the workspace. Returns matching `path:line:text`. */
  search(pattern: string, opts?: { path?: string; include?: string }): Promise<string[]>;
}

export interface ShellResult {
  exitCode: number;
  output: string;
}

export interface ShellPort {
  /** Run a command rooted at `cwd` with a timeout; captures combined output. */
  execute(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<ShellResult>;
}
