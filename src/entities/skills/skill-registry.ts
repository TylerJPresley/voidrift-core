/**
 * Skill registry entity (core-blueprint.md §12.1).
 *
 * Holds the resolved index and the loaded set. Resolution cascades the three
 * sources workspace > global > builtin by name, scopes by the optional
 * `config.skills` allowlist (empty = all), surfaces name + description only in
 * the index (progressive disclosure), and renders loaded bodies into the Void
 * layer. Re-indexing drops loaded names that no longer resolve. Pure logic: the
 * directory adapter supplies the parsed skills from disk.
 */
import type { Skill, SkillIndexLine, SkillSource } from "./skill.js";
import { renderLoadedBody } from "./skill.js";

const SOURCE_RANK: Record<SkillSource, number> = { builtin: 0, global: 1, project: 2 };

/** The raw candidate skills gathered from all three sources before cascade. */
export interface SkillCandidates {
  builtin: Skill[];
  global: Skill[];
  project: Skill[];
}

export class SkillRegistry {
  /** The resolved skills by name, after cascade and allowlist. */
  private index = new Map<string, Skill>();
  /** The names the model has loaded this session (§12.1). */
  private readonly loaded = new Set<string>();

  /**
   * Re-index from the gathered candidates (§12.1). Workspace overrides global
   * overrides builtin by name; the allowlist (empty = all) scopes the result
   * uniformly across all three sources. Loaded names no longer resolved are
   * dropped. Returns the names dropped from the loaded set.
   */
  reindex(candidates: SkillCandidates, allowlist: string[]): string[] {
    const resolved = new Map<string, Skill>();
    const consider = (skill: Skill): void => {
      const existing = resolved.get(skill.name);
      if (!existing || SOURCE_RANK[skill.source] >= SOURCE_RANK[existing.source]) {
        resolved.set(skill.name, skill);
      }
    };
    for (const s of candidates.builtin) consider(s);
    for (const s of candidates.global) consider(s);
    for (const s of candidates.project) consider(s);

    if (allowlist.length > 0) {
      const allow = new Set(allowlist);
      for (const name of [...resolved.keys()]) {
        if (!allow.has(name)) resolved.delete(name);
      }
    }

    this.index = resolved;

    const dropped: string[] = [];
    for (const name of [...this.loaded]) {
      if (!resolved.has(name)) {
        this.loaded.delete(name);
        dropped.push(name);
      }
    }
    return dropped;
  }

  /** Every resolved skill, name-sorted (§12.1). */
  list(): Skill[] {
    return [...this.index.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Skill | null {
    return this.index.get(name) ?? null;
  }

  has(name: string): boolean {
    return this.index.has(name);
  }

  /** The index manifest lines for the Void layer (§4.6): name + description only. */
  indexLines(): SkillIndexLine[] {
    return this.list().map((s) => ({ name: s.name, description: s.description }));
  }

  /**
   * Add a name to the loaded set (§12.1). Idempotent; an unknown name is ignored
   * (no-op). Returns true when the name was newly loaded and resolves — the
   * signal to emit `SKILL_LOADED`.
   */
  load(name: string): boolean {
    if (!this.index.has(name)) return false;
    if (this.loaded.has(name)) return false;
    this.loaded.add(name);
    return true;
  }

  loadedNames(): string[] {
    return [...this.loaded].filter((n) => this.index.has(n)).sort();
  }

  /** Drop names folded by compaction (§4.9) from the loaded set. */
  unload(name: string): void {
    this.loaded.delete(name);
  }

  /** The rendered loaded bodies for the Void layer (§12.1): `### <name>` + body. */
  loadedBodies(): string[] {
    return this.loadedNames()
      .map((n) => this.index.get(n))
      .filter((s): s is Skill => s !== undefined)
      .map(renderLoadedBody);
  }
}
