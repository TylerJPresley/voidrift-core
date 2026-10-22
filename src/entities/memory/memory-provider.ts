/**
 * The memory provider port (core-blueprint.md §6.8, §1 rule 6).
 *
 * One external memory provider at a time AUGMENTS built-in memory; it never
 * replaces it. The built-in store always runs; the provider is additive. A
 * provider registers through `register.memoryProvider`.
 *
 * Everything handed to a provider is secret-scrubbed first (§6.8, §10.10): the
 * memory capability routes every payload through the shared secret detector
 * (`use-cases/secret-mask.ts`) before it leaves the process, so the slice-6
 * detector automatically protects this path. A provider failure is logged as a
 * warning and never crashes the session.
 *
 * The §10 observability `TurnRecord`/`SessionSummary` are a clean seam here: the
 * provider receives the structural turn/session shapes the memory capability can
 * supply in slice 4, which the slice-6 record widens without changing this port.
 */
import type { StructuredTool } from "@langchain/core/tools";
import type { MemoryEntry } from "./memory-entry.js";

/** A provider-contributed memory item injected into the Void layer (§6.8). */
export interface MemoryItem {
  id: string;
  content: string;
}

/** The per-turn context handed to `inject` (secret-scrubbed, §6.8). */
export interface TurnContext {
  sessionId: string;
  userInput: string;
  turn: number;
}

/** A completed turn record handed to `syncTurn` (secret-scrubbed, §6.8). The
 * slice-6 §10 record widens this; the port is unchanged. */
export interface TurnRecord {
  sessionId: string;
  turn: number;
  userInput: string;
  assistantText: string;
  toolsUsed: string[];
}

/** A session summary handed to `extract` at session end (secret-scrubbed, §6.8). */
export interface SessionSummary {
  sessionId: string;
  name: string;
  summary: string;
  lastActiveAt: string;
}

/**
 * The provider contract (§6.8). Every method receives already-scrubbed input.
 * `tools()` pass through the one decision point like any other tool (§9).
 */
export interface MemoryProvider {
  inject(context: TurnContext): Promise<MemoryItem[]>;
  prefetch(userInput: string): Promise<MemoryItem[]>;
  syncTurn(turn: TurnRecord): Promise<void>;
  extract(session: SessionSummary): Promise<void>;
  mirrorWrite(entry: MemoryEntry): Promise<void>;
  tools(): StructuredTool[];
}
