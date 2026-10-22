/**
 * In-memory `MemoryStore` (core-blueprint.md §6.1, §15.3).
 *
 * The test default — a unit test NEVER touches the real filesystem (§1 rule 7,
 * §15.3). Namespaces are joined to a stable string key; values are deep-cloned
 * on the way in and out so later mutations never leak across the seam.
 */
import type { MemoryStore, StoredItem } from "../../entities/ports/memory-store.js";

function nsKey(namespace: string[]): string {
  return namespace.join("\u0000");
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly data = new Map<string, Map<string, Record<string, unknown>>>();

  private bucket(namespace: string[]): Map<string, Record<string, unknown>> {
    const key = nsKey(namespace);
    let b = this.data.get(key);
    if (!b) {
      b = new Map();
      this.data.set(key, b);
    }
    return b;
  }

  async put(namespace: string[], key: string, value: Record<string, unknown>): Promise<void> {
    this.bucket(namespace).set(key, structuredClone(value));
  }

  async get(namespace: string[], key: string): Promise<StoredItem | null> {
    const v = this.data.get(nsKey(namespace))?.get(key);
    return v ? { namespace: [...namespace], key, value: structuredClone(v) } : null;
  }

  async delete(namespace: string[], key: string): Promise<void> {
    this.data.get(nsKey(namespace))?.delete(key);
  }

  async search(namespace: string[], query: string, limit?: number): Promise<StoredItem[]> {
    const q = query.toLowerCase();
    const items = await this.list(namespace);
    const matched = items.filter((it) => JSON.stringify(it.value).toLowerCase().includes(q));
    return limit !== undefined ? matched.slice(0, limit) : matched;
  }

  async list(namespace: string[]): Promise<StoredItem[]> {
    const b = this.data.get(nsKey(namespace));
    if (!b) return [];
    return [...b.entries()].map(([key, value]) => ({ namespace: [...namespace], key, value: structuredClone(value) }));
  }
}
