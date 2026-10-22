/**
 * Filesystem adapter (core-blueprint.md §8.2, §1 rule 3).
 *
 * Resolves every path against the workspace root and the only place `node:fs`
 * is touched for workspace file tools. Tests inject an in-memory implementation
 * of `FileSystemPort` instead (§1 rule 7).
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FileSystemPort } from "../entities/ports/host.js";
import { CoreErrorException, ErrorCode, coreError } from "../entities/errors.js";

/** True when `abs` lies inside `root` (root itself counts). */
function inside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export class FilesystemAdapter implements FileSystemPort {
  constructor(private readonly root: string) {}

  /**
   * Resolve `p` to a canonical absolute path contained in the workspace root
   * (§8.2, §15.1). The sole chokepoint for workspace file access: it rejects
   * absolute paths and `..` escapes, and resolves symlinks on the deepest
   * existing ancestor so an in-workspace symlink cannot point outside the root.
   * Throws a `PATH_ESCAPE` `CoreErrorException`, which the facade maps to a
   * `Result` error.
   */
  private async resolve(p: string): Promise<string> {
    const abs = path.resolve(this.root, p);
    if (!inside(this.root, abs)) throw this.escape(p);
    // Resolve symlinks on the deepest existing ancestor; the leaf may not exist
    // yet (writeFile), so walk up until a path that can be realpath'd is found.
    let probe = abs;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        const tail = path.relative(probe, abs);
        const canonical = tail === "" ? real : path.join(real, tail);
        if (!inside(this.root, canonical)) throw this.escape(p);
        return canonical;
      } catch (e) {
        if (e instanceof CoreErrorException) throw e;
        const parent = path.dirname(probe);
        if (parent === probe) return abs; // reached filesystem root without a hit
        probe = parent;
      }
    }
  }

  private escape(p: string): CoreErrorException {
    return new CoreErrorException(
      coreError(ErrorCode.PATH_ESCAPE, `path escapes the workspace root: ${p}`, { field: "path" }),
    );
  }

  async readFile(p: string): Promise<string> {
    return fs.readFile(await this.resolve(p), "utf8");
  }

  /**
   * Read raw bytes through the SAME containment chokepoint as `readFile` (§3.3):
   * absolute-escape and symlink-escape are rejected by `resolve`. `maxBytes`
   * caps the read — the size is checked with `stat` BEFORE a byte is buffered,
   * so an oversized file rejects with `INVALID_INPUT` and never loads.
   */
  async readBinary(p: string, opts: { maxBytes: number }): Promise<Uint8Array> {
    const abs = await this.resolve(p);
    const st = await fs.stat(abs);
    if (!st.isFile()) {
      throw new CoreErrorException(
        coreError(ErrorCode.INVALID_INPUT, `not a regular file: ${p}`, { field: "path" }),
      );
    }
    if (st.size > opts.maxBytes) {
      throw new CoreErrorException(
        coreError(ErrorCode.INVALID_INPUT, `file exceeds the ${opts.maxBytes}-byte cap: ${p}`, {
          field: "path",
        }),
      );
    }
    const buf = await fs.readFile(abs);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async writeFile(p: string, content: string): Promise<void> {
    const abs = await this.resolve(p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }

  /**
   * Durable, private write (§8.3): the target is resolved through the one
   * containment chokepoint (`resolve`, symlink-safe), the body is written to a
   * temp file in the SAME directory, then `rename`d over the target — atomic, so
   * a reader never sees a half-written cache file — with an explicit mode
   * (0600 for the evicted large-result cache so its plaintext is owner-only).
   */
  async writeFileAtomic(p: string, content: string, opts?: { mode?: number }): Promise<void> {
    const abs = await this.resolve(p);
    const dir = path.dirname(abs);
    const mode = opts?.mode ?? 0o600;
    // Create the containing dir owner-only (0700): the evicted large-result
    // cache holds owner-only plaintext (0600 files), so its directory must not
    // be world-traversable either (defense-in-depth, §10.10).
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // Temp name is unique per call: pid + time collide for byte-identical
    // oversized output evicted concurrently (hash-named target), so a random
    // suffix is required or one rename races the other to ENOENT.
    const tmp = path.join(
      dir,
      `.${path.basename(abs)}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`,
    );
    await fs.writeFile(tmp, content, { encoding: "utf8", mode });
    try {
      await fs.rename(tmp, abs);
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
    // `writeFile` honors `mode` only on create; ensure the final target's mode
    // when it pre-existed (rename preserves the temp file's mode, so this is a
    // belt-and-braces no-op in the common case).
    await fs.chmod(abs, mode).catch(() => undefined);
  }

  async exists(p: string): Promise<boolean> {
    try {
      await fs.access(await this.resolve(p));
      return true;
    } catch {
      return false;
    }
  }

  async remove(p: string): Promise<void> {
    await fs.rm(await this.resolve(p), { force: true });
  }

  async removeDir(p: string): Promise<void> {
    await fs.rm(await this.resolve(p), { recursive: true, force: true });
  }

  async rename(from: string, to: string): Promise<void> {
    const src = await this.resolve(from);
    const dst = await this.resolve(to);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    // Replace an existing target so a re-approval re-publishes cleanly.
    await fs.rm(dst, { recursive: true, force: true });
    await fs.rename(src, dst);
  }

  async glob(pattern: string): Promise<string[]> {
    // A minimal glob over the workspace: match basenames and simple segment
    // globs. Rich glob is slice-later; this covers the walking-skeleton need.
    const results: string[] = [];
    const re = new RegExp(
      "^" +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*\//g, "\u0002")
          .replace(/\*\*/g, "\u0001")
          .replace(/\*/g, "[^/]*")
          .replace(/\u0001/g, ".*")
          .replace(/\u0002/g, "(?:.*/)?") +
        "$",
    );
    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        const abs = path.join(dir, e.name);
        const rel = path.relative(this.root, abs);
        if (e.isDirectory()) await walk(abs);
        else if (re.test(rel) || re.test(e.name)) results.push(rel);
      }
    };
    await walk(this.root).catch(() => undefined);
    return results;
  }

  async search(pattern: string, opts?: { path?: string; include?: string }): Promise<string[]> {
    const re = new RegExp(pattern);
    const base = opts?.path ? await this.resolve(opts.path) : this.root;
    const out: string[] = [];
    // Guards (security-audit S3): a `search` must never hang on a FIFO/device,
    // follow a symlink, or slurp a huge file. Skip anything that is not a plain
    // regular file, cap each read at 2 MiB, and bound recursion at depth 32.
    const MAX_FILE_BYTES = 2 * 1024 * 1024;
    const MAX_DEPTH = 32;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        const abs = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue; // never follow a symlink (loop/escape)
        if (e.isDirectory()) {
          await walk(abs, depth + 1);
          continue;
        }
        if (!e.isFile()) continue; // skip FIFO, device, socket — reading blocks
        if (opts?.include && !e.name.endsWith(opts.include.replace("*", ""))) continue;
        // `lstat` already-known via dirent; stat the regular file for its size
        // and skip anything over the cap before reading a byte.
        let size: number;
        try {
          size = (await fs.stat(abs)).size;
        } catch {
          continue;
        }
        if (size > MAX_FILE_BYTES) continue;
        const text = await fs.readFile(abs, "utf8").catch(() => "");
        text.split("\n").forEach((line, i) => {
          if (re.test(line)) out.push(`${path.relative(this.root, abs)}:${i + 1}:${line}`);
        });
      }
    };
    await walk(base, 0).catch(() => undefined);
    return out;
  }
}
