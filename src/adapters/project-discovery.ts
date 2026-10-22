/**
 * AGENTS.md discovery (core-blueprint.md §6.6).
 *
 * Walks from the workspace root for `AGENTS.md` files and reads a global one, so
 * the project-context merge (§6.6) can order them most-specific-last. The only
 * place `AGENTS.md` discovery touches the host — through `FileSystemPort` (§1
 * rule 3). A nested file nearer a referenced path is deeper and wins on the
 * merge; a workspace file overrides a global one.
 *
 * The file is untrusted input: it is read as content only, never executed (§6.6,
 * §1 rule 15). Discovery returns the raw text; the merge applies the bound.
 */
import type { FileSystemPort } from "../entities/ports/host.js";
import type { ProjectFile } from "../entities/memory/project-context.js";

export interface ProjectDiscoveryRoots {
  workspace: string;
  /** The global instructions file path, e.g. `~/.config/voidrift/AGENTS.md`. */
  global?: string;
}

/**
 * Discover every `AGENTS.md` under the workspace plus the optional global one.
 * Depth is the number of path segments between the file and the workspace root,
 * so a nested file sorts after a root one in the merge (§6.6).
 */
export async function discoverProjectFiles(
  fs: FileSystemPort,
  roots: ProjectDiscoveryRoots,
): Promise<ProjectFile[]> {
  const files: ProjectFile[] = [];

  if (roots.global) {
    if (await fs.exists(roots.global)) {
      const content = await fs.readFile(roots.global).catch(() => "");
      if (content.trim() !== "") {
        files.push({ path: roots.global, content, depth: 0, scope: "global" });
      }
    }
  }

  const matches = await fs.glob("**/AGENTS.md").catch(() => [] as string[]);
  for (const rel of matches) {
    // Never double-count the global file as a workspace match (it may share the
    // FS namespace in a test, and in production lives outside the workspace).
    if (roots.global && rel === roots.global) continue;
    // Exclude VoidRift's own state dir and the usual non-source dirs (§6.6). The
    // `**/AGENTS.md` glob walks the WHOLE workspace, so without this it also
    // finds the session-cache copies VoidRift itself writes under
    // `.voidrift/cache/session/<id>/AGENTS.md` (engine §4.1) and merges them
    // back into the next session's project context — a snowball that grows
    // `ctx.full` every session and misses the digest cache forever (§8.7). The
    // `glob` port has no ignore argument, and an in-memory fake does not prune
    // directories, so the filter lives here where every adapter is covered.
    if (isExcluded(rel.replace(/\\/g, "/"))) continue;
    const content = await fs.readFile(rel).catch(() => "");
    if (content.trim() === "") continue;
    const normalized = rel.replace(/\\/g, "/");
    const depth = normalized.split("/").length - 1; // root AGENTS.md => depth 0
    files.push({ path: rel, content, depth, scope: "workspace" });
  }

  return files;
}

/**
 * Directory names never walked for project instructions: VoidRift's own state
 * (`.voidrift/`, which holds the session-cache copies that would otherwise
 * snowball) and the usual non-source trees. Project-specific reference dirs
 * (`_old`, `_bak`) are deliberately NOT hardcoded here — a `.gitignore`-style
 * respect is not implemented, so a nested `AGENTS.md` inside such a dir is
 * still merged.
 */
const EXCLUDED_DIRS = new Set([".voidrift", "node_modules", ".git"]);

/** True when any path segment (except the final basename) is an excluded dir. */
function isExcluded(normalized: string): boolean {
  const segments = normalized.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    if (EXCLUDED_DIRS.has(segments[i]!)) return true;
  }
  return false;
}
