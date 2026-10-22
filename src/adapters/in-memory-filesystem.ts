/**
 * An in-memory `FileSystemPort` for tests (§1 rule 7, §15.3). A unit test never
 * touches the real filesystem; this fake backs the memory store, suggestions
 * directory, AGENTS.md discovery, and the session-cache materialization.
 */
import type { FileSystemPort } from "../entities/ports/host.js";

export class InMemoryFileSystem implements FileSystemPort {
  readonly files = new Map<string, string>();
  /** Raw bytes for `readBinary` (§3.3 vision tests), keyed by normalized path. */
  readonly binaries = new Map<string, Uint8Array>();
  /** The mode an atomic write requested, keyed by normalized path (§8.3 tests). */
  readonly modes = new Map<string, number>();

  private norm(p: string): string {
    return p.replace(/\\/g, "/").replace(/^\.\//, "");
  }

  async readFile(path: string): Promise<string> {
    const v = this.files.get(this.norm(path));
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  }

  async readBinary(path: string, opts: { maxBytes: number }): Promise<Uint8Array> {
    const v = this.binaries.get(this.norm(path));
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    if (v.byteLength > opts.maxBytes) throw new Error(`file exceeds the ${opts.maxBytes}-byte cap: ${path}`);
    return v;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(this.norm(path), content);
  }

  async writeFileAtomic(path: string, content: string, opts?: { mode?: number }): Promise<void> {
    this.files.set(this.norm(path), content);
    this.modes.set(this.norm(path), opts?.mode ?? 0o600);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(this.norm(path));
  }

  async remove(path: string): Promise<void> {
    this.files.delete(this.norm(path));
  }

  async removeDir(path: string): Promise<void> {
    const prefix = this.norm(path).replace(/\/+$/, "") + "/";
    for (const key of [...this.files.keys()]) {
      if (key === this.norm(path) || key.startsWith(prefix)) this.files.delete(key);
    }
    for (const key of [...this.binaries.keys()]) {
      if (key === this.norm(path) || key.startsWith(prefix)) this.binaries.delete(key);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const fromDir = this.norm(from).replace(/\/+$/, "");
    const toDir = this.norm(to).replace(/\/+$/, "");
    const prefix = fromDir + "/";
    // Replace an existing target subtree first.
    await this.removeDir(toDir);
    const remap = (map: Map<string, string> | Map<string, Uint8Array>) => {
      for (const key of [...map.keys()]) {
        let next: string | undefined;
        if (key === fromDir) next = toDir;
        else if (key.startsWith(prefix)) next = toDir + "/" + key.slice(prefix.length);
        if (next !== undefined) {
          (map as Map<string, unknown>).set(next, (map as Map<string, unknown>).get(key));
          map.delete(key);
        }
      }
    };
    remap(this.files);
    remap(this.binaries);
  }

  async glob(pattern: string): Promise<string[]> {
    const p = this.norm(pattern);
    // `**/` matches zero or more leading path segments (so `**/AGENTS.md` hits a
    // root file too); a bare `**` matches any run; `*` matches within a segment.
    // Escape regex specials first (note: `*` is NOT escaped), then expand globs.
    const re = new RegExp(
      "^" +
        p
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*\//g, "\u0002")
          .replace(/\*\*/g, "\u0001")
          .replace(/\*/g, "[^/]*")
          .replace(/\u0001/g, ".*")
          .replace(/\u0002/g, "(?:.*/)?") +
        "$",
    );
    return [...this.files.keys()].filter((k) => re.test(k) || re.test(k.split("/").pop() ?? ""));
  }

  async search(pattern: string, opts?: { path?: string; include?: string }): Promise<string[]> {
    const re = new RegExp(pattern);
    const out: string[] = [];
    for (const [path, text] of this.files) {
      if (opts?.path && !path.startsWith(this.norm(opts.path))) continue;
      text.split("\n").forEach((line, i) => {
        if (re.test(line)) out.push(`${path}:${i + 1}:${line}`);
      });
    }
    return out;
  }
}
