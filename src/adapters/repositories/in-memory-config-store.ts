/**
 * In-memory config store (core-blueprint.md §1 rule 7, §13).
 *
 * Holds each layer's raw document in memory. The default when no filesystem
 * store is injected, keeping slice-1 construction offline and deterministic; it
 * is seeded with the first-run default (§13.8). Tests inject layered documents.
 */
import type { ConfigStore } from "../../entities/ports/config-store.js";
import type { ConfigLayer } from "../../config/schema.js";

export class InMemoryConfigStore implements ConfigStore {
  private readonly layers: Partial<Record<ConfigLayer, Record<string, unknown>>> = {};
  private readonly rejected: Partial<Record<ConfigLayer, Record<string, unknown>>> = {};
  private readonly rejectedRaw: Partial<Record<ConfigLayer, string>> = {};

  constructor(seedGlobal?: Record<string, unknown>, layers?: Partial<Record<ConfigLayer, Record<string, unknown>>>) {
    if (seedGlobal) this.layers.global = seedGlobal;
    if (layers) Object.assign(this.layers, layers);
  }

  async read(layer: ConfigLayer): Promise<Record<string, unknown> | null> {
    return this.layers[layer] ?? null;
  }

  async write(layer: ConfigLayer, doc: Record<string, unknown>): Promise<void> {
    this.layers[layer] = doc;
  }

  async reject(layer: ConfigLayer, doc: Record<string, unknown>): Promise<void> {
    this.rejected[layer] = doc;
  }

  async rejectRaw(layer: ConfigLayer, raw: string): Promise<void> {
    this.rejectedRaw[layer] = raw;
  }

  /** Test helper: the last rejected document for a layer (§13.3). */
  rejectedDoc(layer: ConfigLayer): Record<string, unknown> | undefined {
    return this.rejected[layer];
  }

  /** Test helper: the last rejected RAW bytes for a layer (§13.3). */
  rejectedRawDoc(layer: ConfigLayer): string | undefined {
    return this.rejectedRaw[layer];
  }

  pathOf(layer: ConfigLayer): { path: string; exists: boolean } {
    return { path: `memory://${layer}`, exists: this.layers[layer] !== undefined };
  }
}
