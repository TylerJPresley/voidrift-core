/**
 * Manual registry (core-blueprint.md §12.8).
 *
 * Stores registered manuals by id, enforcing append-only constraints:
 * a duplicate id is rejected. The registry never resolves nor cascades;
 * it is a simple append-only store that lists all registered manuals
 * without shadowing.
 */
import type { Manual } from "./manual.js";

export interface ManualIndexLine {
  id: string;
  summary: string;
  type: Manual["frontmatter"]["type"];
  /** Moment to read this doc (from frontmatter). */
  readWhen: string;
  /** True if the doc is contributed (id does not start with core/ or cli/). */
  contributed: boolean;
}

export class ManualRegistry {
  private readonly manuals = new Map<string, Manual>();

  /**
   * Register a manual by id. Rejects duplicate ids (append-only, no shadowing).
   * Throws an error if the id is already registered.
   */
  register(manual: Manual): void {
    if (this.manuals.has(manual.id)) {
      throw new Error(`manual id "${manual.id}" already registered (append-only, no shadowing)`);
    }
    this.manuals.set(manual.id, manual);
  }

  /**
   * Remove a manual by id (used during re-indexing to clear filesystem layers).
   */
  remove(id: string): void {
    this.manuals.delete(id);
  }

  /**
   * Get a manual by id, or undefined if not found.
   */
  get(id: string): Manual | undefined {
    return this.manuals.get(id);
  }

  /**
   * List all registered manuals.
   */
  list(): Manual[] {
    return Array.from(this.manuals.values());
  }

  /**
   * Get the index manifest for TOC generation: id + summary + readWhen + contributed.
   */
  indexLines(): ManualIndexLine[] {
    return Array.from(this.manuals.values()).map((m) => ({
      id: m.id,
      summary: m.frontmatter.summary,
      type: m.frontmatter.type,
      readWhen: m.frontmatter.readWhen,
      contributed: !m.id.startsWith("core/") && !m.id.startsWith("cli/"),
    }));
  }

  /**
   * Get the count of registered manuals.
   */
  count(): number {
    return this.manuals.size;
  }
}
