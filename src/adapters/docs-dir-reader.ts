/**
 * Read shipped documentation from a directory.
 * Recursively scans for *.md files, skips dot-dirs and node_modules,
 * returns in deterministic sorted order.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { LimitsPort } from "../entities/ports/limits-port.js";
import { limitDefault } from "../entities/limits.js";

export interface DocFile {
  slug: string;
  raw: string;
}

/**
 * Read all *.md files recursively from a directory.
 * Skips dot-directories and node_modules.
 * Skips symlinked files that resolve outside the root directory.
 * Enforces docs.maxFiles and docs.maxFileBytes limits when limits port is available.
 * Returns docs in deterministic sorted order by slug.
 */
export async function readDocsDir(
  dir: string,
  limits?: LimitsPort,
  onSkipped?: (reason: string) => void,
): Promise<DocFile[]> {
  let maxFiles: number;
  let maxFileBytes: number;
  try {
    maxFiles = limits?.get("docs.maxFiles") ?? limitDefault("docs.maxFiles");
    maxFileBytes = limits?.get("docs.maxFileBytes") ?? limitDefault("docs.maxFileBytes");
  } catch {
    // Limit keys may not exist yet; use safe defaults
    maxFiles = 1000;
    maxFileBytes = 100 * 1024;
  }
  
  const docs: DocFile[] = [];
  let rootRealPath: string;
  let fileCap = maxFiles;
  let limitHit = false;
  
  try {
    rootRealPath = await fs.realpath(dir);
  } catch {
    // If realpath fails on the root, return empty list
    return [];
  }

  const walk = async (currentDir: string): Promise<void> => {
    if (limitHit) return;
    
    try {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (limitHit) break;
        
        // Skip dot-dirs and node_modules
        if (entry.name.startsWith(".") || entry.name === "node_modules") {
          continue;
        }

        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          // For files, check if they are symlinks pointing outside the root
          if (entry.isSymbolicLink()) {
            try {
              const realPath = await fs.realpath(fullPath);
              const rel = path.relative(rootRealPath, realPath);
              // Skip if the symlink resolves outside the root
              if (rel.startsWith("..")) {
                continue;
              }
            } catch {
              // If realpath fails, skip this file
              continue;
            }
          }
          
          // Check file size before reading
          try {
            const stat = await fs.stat(fullPath);
            if (stat.size > maxFileBytes) {
              onSkipped?.(`File ${entry.name} exceeds size limit (${stat.size} > ${maxFileBytes})`);
              continue;
            }
          } catch {
            // If stat fails, skip this file
            continue;
          }
          
          // Check if we've hit the file cap
          if (fileCap <= 0) {
            limitHit = true;
            onSkipped?.(`Maximum file count (${maxFiles}) reached`);
            break;
          }
          
          const slug = entry.name.slice(0, -3); // remove .md extension
          const raw = await fs.readFile(fullPath, "utf8");
          docs.push({ slug, raw });
          fileCap--;
        }
      }
    } catch {
      // silently skip unreadable directories
    }
  };

  await walk(dir);

  // Sort by slug for deterministic order
  docs.sort((a, b) => a.slug.localeCompare(b.slug));
  return docs;
}
