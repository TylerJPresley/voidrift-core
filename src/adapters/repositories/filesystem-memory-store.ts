/**
 * Filesystem-backed `MemoryStore` (core-blueprint.md §6.1, §6.2).
 *
 * The default durable adapter. Memory entries are markdown files with YAML
 * frontmatter under a scope directory — workspace `.voidrift/memory/` and global
 * `~/.config/voidrift/memory/` (§6.2) — so an entry is editable by hand and the
 * registry re-indexes from disk on an external edit. The namespace's last
 * segment is the scope; the key is the entry id and names the `<id>.md` file.
 *
 * This adapter reaches the host only through `FileSystemPort` (§1 rule 3). A
 * hosted deployment swaps a different `BaseStore` behind the §6.1 seam without
 * touching the capability. The value stored is `{ markdown }` — the serialized
 * entry — so the store never needs to know the entry schema.
 */
import path from "node:path";
import type { MemoryStore, StoredItem } from "../../entities/ports/memory-store.js";
import type { FileSystemPort } from "../../entities/ports/host.js";

/** Resolve a namespace to a directory under the workspace or home root. */
export interface MemoryRoots {
  /** Workspace scope dir, e.g. `<workspace>/.voidrift/memory`. */
  workspace: string;
  /** Global scope dir, e.g. `~/.config/voidrift/memory`. */
  global: string;
}

export class FilesystemMemoryStore implements MemoryStore {
  constructor(
    private readonly fs: FileSystemPort,
    private readonly roots: MemoryRoots,
  ) {}

  /** The directory a namespace resolves to; the last segment is the scope. */
  private dir(namespace: string[]): string {
    const scope = namespace[namespace.length - 1];
    return scope === "global" ? this.roots.global : this.roots.workspace;
  }

  private file(namespace: string[], key: string): string {
    return path.join(this.dir(namespace), `${key}.md`);
  }

  async put(namespace: string[], key: string, value: Record<string, unknown>): Promise<void> {
    const markdown = String(value["markdown"] ?? "");
    await this.fs.writeFile(this.file(namespace, key), markdown);
  }

  async get(namespace: string[], key: string): Promise<StoredItem | null> {
    const file = this.file(namespace, key);
    if (!(await this.fs.exists(file))) return null;
    const markdown = await this.fs.readFile(file);
    // An emptied file is a tombstone (delete, below) — treat it as absent so a
    // deleted entry reads back null and the registry drops it on reindex (§6.2).
    if (markdown.trim() === "") return null;
    return { namespace: [...namespace], key, value: { markdown } };
  }

  async delete(namespace: string[], key: string): Promise<void> {
    const file = this.file(namespace, key);
    if (await this.fs.exists(file)) {
      // FileSystemPort has no delete; write the file empty then rely on the
      // registry to drop a non-parsing entry. A real delete lands when the port
      // grows one; the capability also drops it from the in-memory index.
      await this.fs.writeFile(file, "");
    }
  }

  async list(namespace: string[]): Promise<StoredItem[]> {
    const dir = this.dir(namespace);
    const matches = await this.fs.glob(path.join(dir, "*.md")).catch(() => [] as string[]);
    const items: StoredItem[] = [];
    for (const rel of matches) {
      const markdown = await this.fs.readFile(rel).catch(() => "");
      if (markdown.trim() === "") continue;
      const key = path.basename(rel).replace(/\.md$/, "");
      items.push({ namespace: [...namespace], key, value: { markdown } });
    }
    return items;
  }

  async search(namespace: string[], query: string, limit?: number): Promise<StoredItem[]> {
    const q = query.toLowerCase();
    const items = await this.list(namespace);
    const matched = items.filter((it) => String(it.value["markdown"]).toLowerCase().includes(q));
    return limit !== undefined ? matched.slice(0, limit) : matched;
  }
}
