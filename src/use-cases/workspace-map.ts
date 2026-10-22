/**
 * The workspace-map use-case (core-blueprint.md §8.2).
 *
 * Produces the structural index the `workspace_map` tool renders and the
 * `workspace.map` CoreAPI DTO returns: a directory tree with per-file line
 * counts and extracted symbols. The extracted-symbol index is cached per file,
 * keyed by the file's path AND its content hash, persisted under
 * `.voidrift/cache/index/`, so a file is re-parsed only when its content
 * changes and the cache survives a restart (§8.2). The content hash is the ONE
 * shared `contentHash` utility (`entities/hash.ts`) every capability uses, so a
 * cache key never diverges from a staleness check or an approval diff.
 *
 * Containment is the FileSystemPort's job: every read resolves through the same
 * adapter the file tools use, which rejects a `..` escape or a boundary-crossing
 * symlink with `PATH_ESCAPE` (§8.2) — there is no second containment check here.
 */
import type { FileSystemPort } from "../entities/ports/host.js";
import { contentHash } from "../entities/hash.js";
import { validateGlobPattern } from "../entities/glob-validate.js";
import { CoreErrorException, ErrorCode, coreError } from "../entities/errors.js";
import {
  buildTree,
  extractSymbols,
  lineCount,
  type WorkspaceMapDTO,
  type WorkspaceMapNode,
} from "../entities/workspace-map.js";

/** A cached per-file index entry (§8.2): the content hash plus what was parsed. */
interface IndexEntry {
  hash: string;
  lines: number;
  symbols: string[];
}

/** The on-disk cache shape under `.voidrift/cache/index/map.json`. */
type IndexCache = Record<string, IndexEntry>;

const CACHE_FILE = ".voidrift/cache/index/map.json";

export interface WorkspaceMapDeps {
  /** The workspace filesystem port (§8.2); its resolve enforces containment. */
  fileSystem: FileSystemPort;
  /** The default depth bound, `workspaceMapDepth` (§8.2), read live from config. */
  getDepth: () => number;
}

export class WorkspaceMap {
  constructor(private readonly deps: WorkspaceMapDeps) {}

  /**
   * Build the structural index DTO (§8.2). `path` normalizes to a
   * workspace-relative root (default the workspace root); `depth` defaults to
   * `workspaceMapDepth`. A path that escapes the workspace surfaces the
   * FileSystemPort's `PATH_ESCAPE` through the thrown `CoreErrorException`, which
   * the facade maps to a `Result` error.
   */
  async build(path?: string, depth?: number): Promise<WorkspaceMapDTO> {
    const root = normalizeRoot(path);
    const bound = depth && depth > 0 ? depth : this.deps.getDepth();
    const cache = await this.readCache();
    const next: IndexCache = {};

    // Glob every file; the FileSystemPort returns workspace-relative paths and
    // enforces containment on the queried root.
    const pattern = root === "" ? "**/*" : `${root}/**/*`;
    // S5 (GHSA-vfj7-8cjw-p6xm): the model-supplied `path` becomes part of this
    // glob; reject a pathological shape before it reaches the glob library.
    const bad = validateGlobPattern(pattern);
    if (bad !== null) {
      throw new CoreErrorException(
        coreError(ErrorCode.INVALID_INPUT, `glob pattern rejected: ${bad}`, { field: "path" }),
      );
    }
    const files = (await this.deps.fileSystem.glob(pattern)).filter((f) => !f.startsWith(".voidrift/"));

    const infos = new Map<string, { lines: number; symbols: string[] }>();
    for (const rel of files) {
      let content: string;
      try {
        content = await this.deps.fileSystem.readFile(rel);
      } catch {
        continue; // a directory match or an unreadable entry — skip, never crash
      }
      const hash = contentHash(content);
      const cached = cache[rel];
      const entry: IndexEntry =
        cached && cached.hash === hash
          ? cached
          : { hash, lines: lineCount(content), symbols: extractSymbols(rel, content) };
      next[rel] = entry;
      infos.set(rel, { lines: entry.lines, symbols: entry.symbols });
    }

    await this.writeCache(next);

    const tree: WorkspaceMapNode = buildTree(root, [...infos.keys()], bound, (p) => infos.get(p));
    return { root, depth: bound, tree };
  }

  private async readCache(): Promise<IndexCache> {
    try {
      if (!(await this.deps.fileSystem.exists(CACHE_FILE))) return {};
      return JSON.parse(await this.deps.fileSystem.readFile(CACHE_FILE)) as IndexCache;
    } catch {
      return {};
    }
  }

  private async writeCache(cache: IndexCache): Promise<void> {
    try {
      await this.deps.fileSystem.writeFile(CACHE_FILE, JSON.stringify(cache));
    } catch {
      // A cache write failure never fails the map — it just re-parses next time.
    }
  }
}

/** Normalize a queried root to a workspace-relative path ("" for the root). */
function normalizeRoot(path?: string): string {
  if (!path || path === "." || path === "/" || path.trim() === "") return "";
  return path.replace(/^\.?\/+/, "").replace(/\/+$/, "");
}
