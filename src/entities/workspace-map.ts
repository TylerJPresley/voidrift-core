/**
 * Workspace-map entities (core-blueprint.md §8.2).
 *
 * Pure structure and symbol extraction for the `workspace_map` tool and the
 * `workspace.map` CoreAPI DTO: a directory tree with per-file line counts and
 * extracted top symbols. No I/O and no LangChain type here (§1 rule 4) — the
 * use-case supplies file contents and owns the content-hash cache (§8.2).
 */

/** A node in the workspace map tree (§8.2). A directory lists children; a file
 * carries its line count and extracted top symbols. */
export interface WorkspaceMapNode {
  /** Workspace-relative path (POSIX separators); "" for the queried root. */
  path: string;
  kind: "dir" | "file";
  /** Line count for a file; absent for a directory. */
  lines?: number;
  /** Extracted top symbols for a file (§8.2); absent for a directory. */
  symbols?: string[];
  /** Child nodes for a directory, name-sorted (dirs before files). */
  children?: WorkspaceMapNode[];
}

/** The DTO `workspace.map` returns across the facade (§2, §8.2). */
export interface WorkspaceMapDTO {
  /** The queried root, workspace-relative ("" for the workspace root). */
  root: string;
  /** The depth bound applied (§8.2 `workspaceMapDepth`). */
  depth: number;
  tree: WorkspaceMapNode;
}

/**
 * Extract the top structural symbols from a file's content (§8.2): exported
 * functions, classes, interfaces, types, and markdown headings. Deliberately
 * lightweight and language-agnostic over a line scan — the same outline the
 * `read_file` `concise` format surfaces — not a full parse. Deterministic and
 * order-preserving so a cache entry is stable for a given content hash.
 */
export function extractSymbols(path: string, content: string): string[] {
  const symbols: string[] = [];
  const isMarkdown = /\.(md|markdown)$/i.test(path);
  const lines = content.split("\n");
  for (const line of lines) {
    if (isMarkdown) {
      const h = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (h) symbols.push(`${h[1]} ${h[2]}`);
      continue;
    }
    const m =
      /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(function|class|interface|type|const|enum)\s+([A-Za-z_$][\w$]*)/.exec(
        line,
      );
    if (m) symbols.push(`${m[1]} ${m[2]}`);
  }
  return symbols;
}

/** The line count of a file's content (§8.2 per-file annotation). */
export function lineCount(content: string): number {
  if (content === "") return 0;
  return content.split("\n").length;
}

/**
 * Build a tree from workspace-relative file paths, bounded to `depth` directory
 * levels below `root` (§8.2). `root` is "" for the workspace root. Entries
 * deeper than the bound are elided. `fileInfo` supplies each in-bound file's
 * line count and symbols. Directories sort before files, each name-sorted, so
 * the tree is deterministic.
 */
export function buildTree(
  root: string,
  relPaths: string[],
  depth: number,
  fileInfo: (path: string) => { lines: number; symbols: string[] } | undefined,
): WorkspaceMapNode {
  const prefix = root === "" ? "" : root.replace(/\/+$/, "") + "/";
  const rootNode: WorkspaceMapNode = { path: root, kind: "dir", children: [] };
  // Directory nodes by their relative path, so children attach to the right one.
  const dirs = new Map<string, WorkspaceMapNode>();
  dirs.set(root, rootNode);

  const ensureDir = (dirPath: string, levelFromRoot: number): WorkspaceMapNode | null => {
    if (levelFromRoot > depth) return null;
    const existing = dirs.get(dirPath);
    if (existing) return existing;
    const parentPath = dirPath.includes("/") ? dirPath.slice(0, dirPath.lastIndexOf("/")) : root;
    const parent = ensureDir(parentPath, levelFromRoot - 1);
    if (!parent) return null;
    const node: WorkspaceMapNode = { path: dirPath, kind: "dir", children: [] };
    dirs.set(dirPath, node);
    parent.children!.push(node);
    return node;
  };

  for (const rel of relPaths) {
    if (prefix !== "" && !rel.startsWith(prefix) && rel !== root) continue;
    const under = prefix === "" ? rel : rel.slice(prefix.length);
    if (under === "") continue;
    const segments = under.split("/");
    const fileLevel = segments.length; // dirs between root and the file
    if (fileLevel > depth) continue; // beyond the depth bound
    const dirPath = segments.length > 1 ? prefix + segments.slice(0, -1).join("/") : root;
    const parent = ensureDir(dirPath, segments.length - 1);
    if (!parent) continue;
    const info = fileInfo(rel);
    parent.children!.push({
      path: rel,
      kind: "file",
      lines: info?.lines ?? 0,
      symbols: info?.symbols ?? [],
    });
  }

  sortNode(rootNode);
  return rootNode;
}

function sortNode(node: WorkspaceMapNode): void {
  if (!node.children) return;
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  for (const c of node.children) sortNode(c);
}
