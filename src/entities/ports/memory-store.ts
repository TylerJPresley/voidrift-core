/**
 * The durable store port (core-blueprint.md §6.1, §1 rule 6).
 *
 * Every persisting capability that holds long-term state writes through this one
 * port — an adapter over LangGraph `BaseStore`. The default adapter is backed by
 * the session filesystem and SQLite; a hosted deployment swaps in another
 * `BaseStore` implementation behind the same seam without touching the memory
 * capability above it. Tests inject an in-memory implementation (§15.3) — never
 * the real filesystem in a unit test.
 *
 * No LangGraph `BaseStore` type crosses the facade; the store is construction-time
 * injection only, like the checkpointer (§6.8, §2.1).
 */

/** A stored item keyed within a namespace (§6.1). */
export interface StoredItem {
  namespace: string[];
  key: string;
  value: Record<string, unknown>;
}

/**
 * The durable store port. Namespaces are ordered path segments
 * (e.g. `["memory", "workspace"]`); a key is unique within its namespace.
 */
export interface MemoryStore {
  put(namespace: string[], key: string, value: Record<string, unknown>): Promise<void>;
  get(namespace: string[], key: string): Promise<StoredItem | null>;
  delete(namespace: string[], key: string): Promise<void>;
  /** Substring search over the namespace's serialized values (§6.1). */
  search(namespace: string[], query: string, limit?: number): Promise<StoredItem[]>;
  list(namespace: string[]): Promise<StoredItem[]>;
}
