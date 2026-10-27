/**
 * Plugin files accessor (core-blueprint.md §12.5).
 *
 * A CONTAINED accessor on the scoped CoreAPI allowing a plugin to read/write/
 * list/remove its own working files at `<workspace>/.voidrift/plugins/<name>/`.
 * Traversal, absolute paths, and symlink escapes are REFUSED. `registry.json`
 * is never reachable. Writes are atomic (temp + rename) and secret-masked;
 * writes/removes are journaled like other harness mutations.
 */
import fs from "node:fs";
import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import type { JournalRecorder } from "./journal-recorder.js";
import { maskValue } from "./secret-mask.js";

/** A file/dir entry from list(). */
export interface PluginFileEntry {
  name: string;
  kind: "file" | "dir" | "symlink";
  bytes: number;
  mtimeMs: number;
}

/** Error type for path containment violations (typed, value-free as per spec). */
export class PluginFileAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginFileAccessError";
  }
}

export interface PluginFilesAccessorDeps {
  /** The plugin's scoped folder: `<workspace>/.voidrift/plugins/<pluginId>/` */
  pluginFolder: string;
  /** The mutation journal recorder (§10.11). Optional; if absent, writes are not journaled. */
  journal?: JournalRecorder;
  /** Getter for current session ID for journaling (evaluated at write/remove time). */
  getSessionId?: () => string | undefined;
  /** Getter for current turn number for journaling (evaluated at write/remove time). */
  getTurn?: () => number | undefined;
}

/**
 * The implementation behind `core.workspace.pluginFiles` on the ScopedCoreApi.
 * One per plugin; constructed when the plugin loads and passed to `register()`.
 */
export class PluginFilesAccessor {
  private readonly realPluginRoot: string;

  constructor(private readonly deps: PluginFilesAccessorDeps) {
    // Resolve the plugin folder's real path by walking up to the nearest existing ancestor,
    // then appending the remaining relative path. This handles cases where the plugin folder
    // doesn't exist yet but is inside a symlink tree.
    let current = nodePath.resolve(deps.pluginFolder);
    let suffix = "";
    while (!fs.existsSync(current) && current !== nodePath.dirname(current)) {
      suffix = nodePath.sep + nodePath.basename(current) + suffix;
      current = nodePath.dirname(current);
    }
    const real = fs.existsSync(current) ? fs.realpathSync(current) : current;
    this.realPluginRoot = suffix ? nodePath.join(real, suffix) : real;
  }

  /**
   * Refuse a path if it attempts traversal, is absolute, escapes via symlink,
   * or is `registry.json`. Returns the absolute resolved path if valid.
   * 
   * Security: walks up to the nearest EXISTING ancestor, realpaths it, re-attaches
   * the non-existent tail, and verifies the result is inside realPluginRoot.
   * This catches symlinks that hide in dirname components of new files.
   * For dangling symlinks, reads the symlink target and checks if it points outside.
   */
  private validatePath(relPath: string): string {
    if (typeof relPath !== "string") {
      throw new PluginFileAccessError(`refuses path: not a string`);
    }

    // Normalize: forward slashes, no leading ./
    const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");

    // Refuse empty, .. at any level, or absolute
    if (norm === "" || norm.startsWith("../") || norm === ".." || nodePath.isAbsolute(norm)) {
      throw new PluginFileAccessError(`refuses path: traversal or absolute`);
    }

    // Refuse registry.json at any level
    if (norm === "registry.json" || norm.split("/").includes("registry.json")) {
      throw new PluginFileAccessError(`refuses path: registry.json is a protected control location`);
    }

    // Resolve under the plugin folder (defense in depth)
    const abs = nodePath.resolve(this.deps.pluginFolder, relPath);

    // Find the deepest EXISTING ancestor of abs (using lstatSync to handle dangling symlinks)
    let current = abs;
    let suffix = "";
    while (current !== nodePath.dirname(current)) {
      try {
        fs.lstatSync(current); // lstatSync works on dangling symlinks
        break;
      } catch {
        suffix = nodePath.sep + nodePath.basename(current) + suffix;
        current = nodePath.dirname(current);
      }
    }

    // Check all path components from root down to abs for symlinks pointing outside
    // This catches both existing and dangling symlinks that escape the plugin root
    let checkPath = this.realPluginRoot;
    const pathParts = nodePath.relative(this.realPluginRoot, abs).split(nodePath.sep).filter(p => p);
    
    for (const part of pathParts) {
      checkPath = nodePath.join(checkPath, part);
      try {
        // Use lstatSync to handle dangling symlinks
        const stat = fs.lstatSync(checkPath);
        if (stat.isSymbolicLink()) {
          // Found a symlink; resolve where it points
          const target = nodePath.resolve(fs.readlinkSync(checkPath));
          if (
            target !== this.realPluginRoot &&
            !target.startsWith(this.realPluginRoot + nodePath.sep)
          ) {
            throw new PluginFileAccessError(`refuses path: symlink escape`);
          }
        }
      } catch (err) {
        if (err instanceof PluginFileAccessError) throw err;
        // lstatSync throws ENOENT if path doesn't exist; continue to check others
      }
    }

    // Realpath the existing ancestor
    const realAncestor = fs.existsSync(current)
      ? nodePath.resolve(fs.realpathSync(current))
      : current;

    // Re-attach the non-existent tail
    const resolved = suffix ? nodePath.join(realAncestor, suffix) : realAncestor;

    // Require resolved path to be inside realPluginRoot (with path separator check)
    if (
      resolved !== this.realPluginRoot &&
      !resolved.startsWith(this.realPluginRoot + nodePath.sep)
    ) {
      throw new PluginFileAccessError(`refuses path: symlink escape`);
    }

    // For existing targets, also realpath them to double-check
    if (fs.existsSync(abs)) {
      try {
        const realTarget = nodePath.resolve(fs.realpathSync(abs));
        if (
          realTarget !== this.realPluginRoot &&
          !realTarget.startsWith(this.realPluginRoot + nodePath.sep)
        ) {
          throw new PluginFileAccessError(`refuses path: symlink escape`);
        }
      } catch (err) {
        if (err instanceof PluginFileAccessError) throw err;
        // If realpathSync fails, propagate it
        throw err;
      }
    }

    return abs;
  }

  /**
   * List files and directories in the plugin folder, optionally filtering by
   * subpath. Returns metadata (name, kind, bytes, mtimeMs) without contents.
   * Symlinks are reported as their own kind, not followed.
   * Throws PluginFileAccessError if subpath escapes or contains symlink attacks.
   */
  async list(subpath?: string): Promise<PluginFileEntry[]> {
    try {
      let scanPath = this.deps.pluginFolder;
      if (subpath) {
        scanPath = this.validatePath(subpath);
      }

      // Ensure it exists (use lstatSync to not follow symlinks)
      const stat = fs.lstatSync(scanPath);
      if (!stat.isDirectory()) {
        return [];
      }

      const entries: PluginFileEntry[] = [];
      const recur = (dir: string, prefix: string): void => {
        try {
          const files = fs.readdirSync(dir);
          for (const file of files) {
            const full = nodePath.join(dir, file);
            // Use lstatSync to get symlink info without following them
            const stat = fs.lstatSync(full);
            // Paths are stored relative to the plugin folder
            const relName = prefix ? `${prefix}/${file}` : file;
            
            // Determine kind: symlink, dir, or file
            let kind: "file" | "dir" | "symlink";
            if (stat.isSymbolicLink()) {
              kind = "symlink";
            } else if (stat.isDirectory()) {
              kind = "dir";
            } else {
              kind = "file";
            }
            
            entries.push({
              name: relName,
              kind,
              bytes: stat.size,
              mtimeMs: stat.mtimeMs,
            });
            
            // Only recurse into directories, never through symlinks
            if (stat.isDirectory()) {
              recur(full, relName);
            }
          }
        } catch {
          // Silently skip on read errors
        }
      };
      recur(scanPath, subpath ? "" : "");
      return entries.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      // Validation errors (symlink escapes) must propagate
      if (err instanceof PluginFileAccessError) throw err;
      return [];
    }
  }

  /**
   * Read a file as UTF-8 string, or null if it doesn't exist or is not a file.
   * Real I/O errors (EACCES, etc.) propagate; only ENOENT/not-a-file return null.
   */
  async read(path: string): Promise<string | null> {
    try {
      const abs = this.validatePath(path);
      const stat = fs.statSync(abs);
      if (!stat.isFile()) {
        return null;
      }
      return fs.readFileSync(abs, "utf8");
    } catch (err) {
      // Only swallow ENOENT (file not found) and not-a-file errors
      if (err instanceof Error) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        // Let real I/O errors (EACCES, EIO, etc.) propagate
        if ((err as NodeJS.ErrnoException).code && (err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }
      // Path does not exist or validation failed with a non-containment error
      if (err instanceof PluginFileAccessError) throw err;
      return null;
    }
  }

  /**
   * Write a file atomically (temp + rename), creating parent directories.
   * The body is secret-masked before storage. The write is journaled.
   * Throws on real I/O errors or missing workspaceRoot.
   */
  async write(path: string, body: string): Promise<void> {
    // Fail immediately if accessor was created with no plugin folder
    if (!this.deps.pluginFolder) {
      throw new PluginFileAccessError("cannot write: plugin folder not configured");
    }

    const abs = this.validatePath(path);
    const dir = nodePath.dirname(abs);

    // Security: check that we can safely create parent directories
    // Ensure no symlink in the directory chain leads outside the plugin root
    let checkDir = this.realPluginRoot;
    const dirParts = nodePath.relative(this.realPluginRoot, dir).split(nodePath.sep).filter(p => p);
    
    for (const part of dirParts) {
      checkDir = nodePath.join(checkDir, part);
      try {
        if (fs.existsSync(checkDir)) {
          const stat = fs.lstatSync(checkDir);
          if (stat.isSymbolicLink()) {
            const target = nodePath.resolve(fs.readlinkSync(checkDir));
            if (
              target !== this.realPluginRoot &&
              !target.startsWith(this.realPluginRoot + nodePath.sep)
            ) {
              throw new PluginFileAccessError(`refuses path: symlink escape`);
            }
          }
        }
      } catch (err) {
        if (err instanceof PluginFileAccessError) throw err;
        // Continue on other errors
      }
    }

    // Secret-mask the body before writing
    const masked = maskValue(body) as string;

    // Capture before-state for journaling (before the write)
    let beforeBuffer: Buffer | undefined;
    let beforeMissing = true;
    try {
      if (fs.existsSync(abs)) {
        const stat = fs.statSync(abs);
        if (stat.isFile()) {
          beforeBuffer = fs.readFileSync(abs);
          beforeMissing = false;
        }
      }
    } catch (err) {
      // Real I/O errors propagate; allow them to surface
      if (err instanceof Error && (err as NodeJS.ErrnoException).code && (err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }

    // Create parent directories
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    // Atomic write: temp file + rename
    const tmpPath = abs + `.tmp.${randomUUID()}`;
    try {
      fs.writeFileSync(tmpPath, masked, { mode: 0o600 });
      fs.renameSync(tmpPath, abs);
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup error
      }
      throw err; // Propagate write errors
    }

    // Journal the write if a recorder is present
    const sessionId = this.deps.getSessionId?.();
    const turn = this.deps.getTurn?.();
    if (this.deps.journal) {
      try {
        const recordRequest = {
          sessionId: sessionId ?? "orchestrator",
          turn: turn ?? 0,
          tool: "plugin_file_write",
          args: { path, body: masked },
          target: nodePath.relative(nodePath.dirname(this.deps.pluginFolder), abs),
          result: { status: "ok" as const, summary: "File written by plugin" },
          after: Buffer.from(masked),
          ...(beforeMissing ? { beforeMissing: true } : {}),
          ...(beforeBuffer ? { before: beforeBuffer } : {}),
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await this.deps.journal.record(recordRequest as any);
      } catch {
        // Silently ignore journal errors; the write already succeeded
      }
    }
  }

  /**
   * Remove a file or empty directory.
   * Throws on real I/O errors or missing workspaceRoot.
   */
  async remove(path: string): Promise<void> {
    // Fail immediately if accessor was created with no plugin folder
    if (!this.deps.pluginFolder) {
      throw new PluginFileAccessError("cannot remove: plugin folder not configured");
    }

    const abs = this.validatePath(path);
    const stat = fs.statSync(abs);

    // Capture before-state before deletion
    let beforeBuffer: Buffer | undefined;
    if (stat.isFile()) {
      beforeBuffer = fs.readFileSync(abs);
    }

    if (stat.isDirectory()) {
      // Only remove if empty
      const files = fs.readdirSync(abs);
      if (files.length === 0) {
        fs.rmdirSync(abs);
      } else {
        throw new PluginFileAccessError(`refuses remove: directory not empty`);
      }
    } else {
      fs.unlinkSync(abs);
    }

    // Journal the removal if a recorder is present
    const sessionId = this.deps.getSessionId?.();
    const turn = this.deps.getTurn?.();
    if (this.deps.journal) {
      try {
        const recordRequest = {
          sessionId: sessionId ?? "orchestrator",
          turn: turn ?? 0,
          tool: "plugin_file_remove",
          args: { path },
          target: nodePath.relative(nodePath.dirname(this.deps.pluginFolder), abs),
          result: { status: "ok" as const, summary: "File removed by plugin" },
          ...(beforeBuffer ? { before: beforeBuffer } : {}),
          ...(beforeBuffer === undefined ? { beforeMissing: true } : {}),
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await this.deps.journal.record(recordRequest as any);
      } catch {
        // Silently ignore journal errors; the removal already succeeded
      }
    }
  }
}
