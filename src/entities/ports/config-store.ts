/**
 * The config-layer store port (core-blueprint.md §1 rule 6, §13).
 *
 * Reads and writes each layer's raw document. The filesystem adapter is the
 * default; tests inject an in-memory implementation (§1 rule 7). The cascade
 * logic lives in the capability and never touches `node:fs` directly.
 */
import type { ConfigLayer } from "../../config/schema.js";

/**
 * Thrown by a store's `read` when a layer file EXISTS but cannot be loaded as a
 * config document — the JSON does not parse, or the file cannot be read
 * (EACCES, EISDIR, …). Distinguished from an ABSENT layer (`read` returns
 * `null`) so the capability sets a broken file aside as `.rejected` and recovers
 * to the last-known-good/defaults instead of silently treating it as absent
 * (§13.2–§13.3). `raw` holds the original bytes when they were readable (so the
 * exact content is preserved in the `.rejected` sibling); it is absent when the
 * read itself failed. `reason` is a short, value-free description.
 */
export class ConfigReadError extends Error {
  constructor(
    readonly layer: ConfigLayer,
    readonly reason: string,
    readonly raw?: string,
  ) {
    super(reason);
    this.name = "ConfigReadError";
  }
}

export interface ConfigStore {
  /**
   * Read a layer's raw document. Returns `null` ONLY when the layer file is
   * absent (ENOENT). An existing file that does not parse as JSON, or that
   * cannot be read, throws `ConfigReadError` (never `null`) so the caller can
   * reject it rather than mistake it for absent (§13.2–§13.3).
   */
  read(layer: ConfigLayer): Promise<Record<string, unknown> | null>;
  /** Write a layer's raw document. */
  write(layer: ConfigLayer, doc: Record<string, unknown>): Promise<void>;
  /** Set aside an invalid document as a `.rejected` sibling for inspection (§13.3). */
  reject(layer: ConfigLayer, doc: Record<string, unknown>): Promise<void>;
  /**
   * Set aside the EXACT original bytes of an unparseable layer file as a
   * `.rejected` sibling, byte-for-byte (§13.3). Used when the file could not be
   * parsed into a document, so the user's hand-edited content is recoverable.
   */
  rejectRaw(layer: ConfigLayer, raw: string): Promise<void>;
  /** The absolute path for a layer and whether it exists (§13.4 `paths`). */
  pathOf(layer: ConfigLayer): { path: string; exists: boolean };
}
