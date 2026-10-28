/**
 * Node filesystem adapter for `config.init` (core-blueprint.md §13.9.1).
 *
 * The `InitFs` port over `node:fs`, operating on ABSOLUTE paths with private
 * modes: directories `0700` and files `0600` (§13.9.1). Writes are atomic
 * (temp-then-rename in the same directory), the same durability the evicted
 * large-result cache uses (§8.3). This is the ONLY place `config.init` touches
 * `node:fs`; tests inject an in-memory or temp-dir implementation (§1 rule 7).
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { InitFs } from "../entities/ports/init-fs.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export class NodeInitFs implements InitFs {
  async readFile(absPath: string): Promise<string | null> {
    try {
      return await fs.readFile(absPath, "utf8");
    } catch {
      return null;
    }
  }

  async exists(absPath: string): Promise<boolean> {
    return existsSync(absPath);
  }

  async mkdirp(absPath: string): Promise<void> {
    await fs.mkdir(absPath, { recursive: true, mode: DIR_MODE });
  }

  async writeFile(absPath: string, content: string): Promise<void> {
    const dir = path.dirname(absPath);
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
    const tmp = path.join(
      dir,
      `.${path.basename(absPath)}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`,
    );
    await fs.writeFile(tmp, content, { encoding: "utf8", mode: FILE_MODE });
    try {
      await fs.rename(tmp, absPath);
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
    await fs.chmod(absPath, FILE_MODE).catch(() => undefined);
  }

  async rename(from: string, to: string): Promise<void> {
    await fs.rename(from, to);
  }

  async copyFile(fromAbs: string, toAbs: string): Promise<void> {
    const content = await fs.readFile(fromAbs, "utf8");
    await this.writeFile(toAbs, content);
  }

  async listDir(absPath: string): Promise<{ name: string; isDir: boolean }[]> {
    try {
      const entries = await fs.readdir(absPath, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    } catch {
      return [];
    }
  }

  async isSymlink(absPath: string): Promise<boolean> {
    try {
      const stats = await fs.lstat(absPath);
      return stats.isSymbolicLink();
    } catch {
      return false;
    }
  }

  async remove(absPath: string): Promise<void> {
    await fs.rm(absPath, { recursive: true, force: true });
  }
}
