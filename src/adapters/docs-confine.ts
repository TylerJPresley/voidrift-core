import path from "node:path";
import fs from "node:fs/promises";

/**
 * Resolve a docs directory path, ensuring it exists and is confined within a base directory.
 *
 * Returns the real path only if:
 * - The directory exists
 * - Its realpath is strictly inside the base directory's realpath
 * - It's not an absolute path
 * - It's not a symlink resolving outside the base
 *
 * Returns null if any check fails (rejecting path traversal, absolute paths, nonexistent dirs, etc.)
 */
export async function resolveInside(
  base: string,
  dir: string
): Promise<string | null> {
  // Reject absolute paths
  if (path.isAbsolute(dir)) {
    return null;
  }

  // Construct the candidate path
  const candidatePath = path.join(base, dir);

  try {
    // Check if path exists; realpath also resolves symlinks
    const realDocsPath = await fs.realpath(candidatePath);
    const realBasePath = await fs.realpath(base);

    // Use path.relative to check if the real docs path is inside the real base path
    const rel = path.relative(realBasePath, realDocsPath);

    // If relative path starts with '..' or is empty (same dir, allowed) or is '.', it's outside or invalid
    if (rel.startsWith("..")) {
      return null;
    }

    // If relative path is absolute, it means realDocsPath is on a different drive on Windows
    if (path.isAbsolute(rel)) {
      return null;
    }

    // Return the real docs path
    return realDocsPath;
  } catch {
    // Realpath fails if the path doesn't exist
    return null;
  }
}
