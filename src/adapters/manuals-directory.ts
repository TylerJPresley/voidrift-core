/**
 * Manuals directory adapter (core-blueprint.md §12.8).
 *
 * Reads `*.md` files from the workspace (`.voidrift/docs/<name>.md`)
 * and global (`~/.config/voidrift/docs/<name>.md`) source directories
 * through the `FileSystemPort` (§1 rule 3).
 * It only reads the frontmatter + body text; parsing and validation are the
 * entity's job (§12.8) — a malformed manual is skipped by the caller.
 */
import path from "node:path";
import type { FileSystemPort } from "../entities/ports/host.js";
import { parseManual, ManualValidationError } from "../entities/manuals/manual.js";
import type { Manual } from "../entities/manuals/manual.js";

export interface ManualDirRoots {
  /** The workspace manuals dir, e.g. `.voidrift/docs`. */
  workspace: string;
  /**
   * The global manuals dir. When a dedicated `globalFs` is supplied, this is
   * RELATIVE to it (e.g. `"docs"` → `~/.config/voidrift/docs`); otherwise it
   * is resolved through the single `fs` port.
   */
  global: string;
}

/** The result of loading one source: valid manuals and the names skipped. */
export interface ManualLoadResult {
  manuals: Manual[];
  skipped: { name: string; reason: string }[];
}

export class ManualsDirectory {
  /**
   * @param fs       the PROJECT/workspace-rooted `FileSystemPort` (§8.2).
   * @param roots    the two cascade source locations.
   * @param globalFs a dedicated GLOBAL-rooted `FileSystemPort` (e.g.
   *   `FilesystemAdapter(voidriftConfigDir())`). The global manuals dir sits
   *   OUTSIDE the workspace, which the workspace-confined `fs` can never reach,
   *   so — exactly like the agents/skills global directory (§3.1) — the global
   *   source is read and written through this dedicated port, `roots.global`
   *   addressed relative to it. Optional so existing single-fs tests keep working.
   */
  constructor(
    private readonly fs: FileSystemPort,
    private readonly roots: ManualDirRoots,
    private readonly globalFs?: FileSystemPort,
  ) {}

  private rootFor(source: Exclude<Manual["source"], "builtin">): string {
    return source === "project" ? this.roots.workspace : this.roots.global;
  }

  private prefixFor(source: Exclude<Manual["source"], "builtin">): string {
    return source === "project" ? "project" : "user";
  }

  /** The `FileSystemPort` for a scope: the dedicated global port when present
   * (the global dir is outside the workspace), else the single `fs`. */
  private portFor(source: Exclude<Manual["source"], "builtin">): FileSystemPort {
    return source === "global" && this.globalFs ? this.globalFs : this.fs;
  }

  /** Load and validate every `*.md` under a source dir (§12.8). */
  async load(source: Exclude<Manual["source"], "builtin">): Promise<ManualLoadResult> {
    const root = this.rootFor(source);
    const port = this.portFor(source);
    const prefix = this.prefixFor(source);
    const pattern = path.join(root, "*.md");
    const matches = await port.glob(pattern).catch(() => [] as string[]);
    const manuals: Manual[] = [];
    const skipped: { name: string; reason: string }[] = [];

    for (const rel of matches) {
      const filename = path.basename(rel);
      const nameWithoutExt = filename.replace(/\.md$/, "");
      const id = `${prefix}/${nameWithoutExt}`;

      try {
        const raw = await port.readFile(rel);
        const manual = parseManual(raw, id, source);
        manuals.push(manual);
      } catch (e) {
        const reason = e instanceof ManualValidationError ? e.message : String(e);
        skipped.push({ name: nameWithoutExt, reason });
      }
    }

    return { manuals, skipped };
  }
}
