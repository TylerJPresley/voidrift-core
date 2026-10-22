/**
 * Prompts directory adapter (core-blueprint.md §12.2).
 *
 * Reads and writes the plain-markdown prompt override files through the
 * `FileSystemPort` (§1 rule 3): workspace `.voidrift/prompts/<key>.md` and global
 * `~/.config/voidrift/prompts/<key>.md`. The whole file is the content — no
 * frontmatter. The registry entity owns the cascade; this is pure I/O.
 */
import path from "node:path";
import type { FileSystemPort } from "../entities/ports/host.js";
import type { PromptOverrides } from "../entities/prompts/prompt-registry.js";

export interface PromptDirRoots {
  workspace: string;
  global: string;
}

export class PromptsDirectory {
  constructor(
    private readonly fs: FileSystemPort,
    private readonly roots: PromptDirRoots,
  ) {}

  file(key: string, scope: "workspace" | "global"): string {
    const root = scope === "workspace" ? this.roots.workspace : this.roots.global;
    return path.join(root, `${key}.md`);
  }

  /** Read both override levels for a key; absent levels are omitted (§12.2). */
  async readOverrides(key: string): Promise<PromptOverrides> {
    const out: PromptOverrides = {};
    const ws = this.file(key, "workspace");
    if (await this.fs.exists(ws)) out.workspace = await this.fs.readFile(ws);
    const gl = this.file(key, "global");
    if (await this.fs.exists(gl)) out.global = await this.fs.readFile(gl);
    return out;
  }

  /** Write an override file seeded with the resolved content (§12.2 override). */
  async write(key: string, scope: "workspace" | "global", content: string): Promise<void> {
    await this.fs.writeFile(this.file(key, scope), content);
  }

  /** Remove both override levels for a key (§12.2 resetOverride). */
  async remove(key: string): Promise<void> {
    for (const scope of ["workspace", "global"] as const) {
      await this.fs.remove(this.file(key, scope));
    }
  }
}
