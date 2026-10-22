/**
 * Skills directory adapter (core-blueprint.md §12.1).
 *
 * Reads `SKILL.md` files from the workspace (`.voidrift/skills/<name>/SKILL.md`)
 * and global (`~/.config/voidrift/skills/<name>/SKILL.md`) source directories
 * through the `FileSystemPort` (§1 rule 3), and writes scaffolds and overrides.
 * It only reads the frontmatter + body text; parsing and validation are the
 * entity's job (§12.1) — a malformed skill is skipped by the caller.
 */
import path from "node:path";
import type { FileSystemPort } from "../entities/ports/host.js";
import { parseSkill, scaffoldSkill, type Skill, type SkillSource, SkillValidationError } from "../entities/skills/skill.js";

export interface SkillDirRoots {
  /** The workspace skills dir, e.g. `.voidrift/skills`. */
  workspace: string;
  /**
   * The global skills dir. When a dedicated `globalFs` is supplied, this is
   * RELATIVE to it (e.g. `"skills"` → `~/.config/voidrift/skills`); otherwise it
   * is resolved through the single `fs` port.
   */
  global: string;
}

/** The result of loading one source: valid skills and the names skipped. */
export interface SkillLoadResult {
  skills: Skill[];
  skipped: { name: string; reason: string }[];
}

export class SkillsDirectory {
  /**
   * @param fs       the PROJECT/workspace-rooted `FileSystemPort` (§8.2).
   * @param roots    the two cascade source locations.
   * @param globalFs a dedicated GLOBAL-rooted `FileSystemPort` (e.g.
   *   `FilesystemAdapter(voidriftConfigDir())`). The global skills dir sits
   *   OUTSIDE the workspace, which the workspace-confined `fs` can never reach,
   *   so — exactly like the agents directory (§3.1) — the global source is read
   *   and written through this dedicated port, `roots.global` addressed relative
   *   to it. Optional so existing single-fs tests keep working.
   */
  constructor(
    private readonly fs: FileSystemPort,
    private readonly roots: SkillDirRoots,
    private readonly globalFs?: FileSystemPort,
  ) {}

  private rootFor(source: Exclude<SkillSource, "builtin">): string {
    return source === "project" ? this.roots.workspace : this.roots.global;
  }

  /** The `FileSystemPort` for a scope: the dedicated global port when present
   * (the global dir is outside the workspace), else the single `fs`. */
  private portFor(source: Exclude<SkillSource, "builtin">): FileSystemPort {
    return source === "global" && this.globalFs ? this.globalFs : this.fs;
  }

  /** Load and validate every `SKILL.md` under a source dir (§12.1). */
  async load(source: Exclude<SkillSource, "builtin">): Promise<SkillLoadResult> {
    const root = this.rootFor(source);
    const port = this.portFor(source);
    const pattern = path.join(root, "*", "SKILL.md");
    const matches = await port.glob(pattern).catch(() => [] as string[]);
    const skills: Skill[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const rel of matches) {
      const dirName = path.basename(path.dirname(rel));
      try {
        const raw = await port.readFile(rel);
        skills.push(parseSkill(raw, dirName, source));
      } catch (e) {
        const reason = e instanceof SkillValidationError ? e.message : String(e);
        skipped.push({ name: dirName, reason });
      }
    }
    return { skills, skipped };
  }

  /** The absolute-ish path of a skill's SKILL.md under a scope (§12.1). */
  skillFile(name: string, scope: Exclude<SkillSource, "builtin">): string {
    return path.join(this.rootFor(scope), name, "SKILL.md");
  }

  async exists(name: string, scope: Exclude<SkillSource, "builtin">): Promise<boolean> {
    return this.portFor(scope).exists(this.skillFile(name, scope));
  }

  /** Scaffold a new SKILL.md under a scope (§12.1 create). */
  async scaffold(name: string, scope: Exclude<SkillSource, "builtin">, description?: string): Promise<void> {
    await this.portFor(scope).writeFile(this.skillFile(name, scope), scaffoldSkill(name, description));
  }

  /** Write SKILL.md content verbatim (override/create-from-candidate, §12.1, §6.7). */
  async write(name: string, scope: Exclude<SkillSource, "builtin">, content: string): Promise<void> {
    await this.portFor(scope).writeFile(this.skillFile(name, scope), content);
  }

  /**
   * Atomically write an approved skill's WHOLE directory (§6.7, §12.1): SKILL.md
   * plus every validated asset land together or not at all. The files are
   * written into a temp staging directory inside the SAME parent, then the
   * staging directory is renamed onto the final name in one step (a same-parent
   * rename is atomic on the real filesystem). On ANY failure the staging
   * directory is removed, so a mid-write failure NEVER leaves a partial skill
   * directory. Assets are written verbatim; this never executes them.
   */
  async writeSkill(
    name: string,
    scope: Exclude<SkillSource, "builtin">,
    skillMd: string,
    assets: { path: string; content: string }[] = [],
  ): Promise<void> {
    const root = this.rootFor(scope);
    const port = this.portFor(scope);
    const final = path.join(root, name);
    const staging = path.join(root, `.${name}.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    try {
      await port.writeFile(path.join(staging, "SKILL.md"), skillMd);
      for (const asset of assets) {
        await port.writeFile(path.join(staging, asset.path), asset.content);
      }
      await port.rename(staging, final);
    } catch (e) {
      // Leave nothing partial: drop the staging directory, swallowing a cleanup
      // error so the original failure is the one that surfaces.
      await port.removeDir(staging).catch(() => undefined);
      throw e;
    }
  }

  /**
   * Write one asset file under a skill directory (§6.7, §12.1). `assetPath` is a
   * caller-VALIDATED relative path under `scripts/`/`references/`/`assets/`; this
   * method writes its text verbatim and never makes it executable or runs it.
   */
  async writeAsset(
    name: string,
    scope: Exclude<SkillSource, "builtin">,
    assetPath: string,
    content: string,
  ): Promise<void> {
    const dest = path.join(this.rootFor(scope), name, assetPath);
    await this.portFor(scope).writeFile(dest, content);
  }

  async read(name: string, scope: Exclude<SkillSource, "builtin">): Promise<string | null> {
    const port = this.portFor(scope);
    const file = this.skillFile(name, scope);
    if (!(await port.exists(file))) return null;
    return port.readFile(file);
  }

  /** Remove a skill's SKILL.md from a scope (§12.1 delete). Returns true if it existed. */
  async remove(name: string, scope: Exclude<SkillSource, "builtin">): Promise<boolean> {
    const port = this.portFor(scope);
    const file = this.skillFile(name, scope);
    const existed = await port.exists(file);
    await port.remove(file);
    return existed;
  }
}
