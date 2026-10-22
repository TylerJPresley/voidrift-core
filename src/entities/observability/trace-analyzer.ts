/**
 * Trace analysis (core-blueprint.md §10.6).
 *
 * Pure, per-session counting of recurring failure shapes over the live record
 * stream: a repeated `tool_error:<name>` (a tool span closing `error`) and a
 * repeated `guardian_block:<tool>` (a denied permission decision). After
 * `turnSuggestionThreshold` repeats of one shape the analyzer SIGNALS once per
 * shape per session; the §6.7 suggestions flow consumes the signal — nothing is
 * created autonomously here.
 */
import type { ObsRecord } from "./obs-record.js";

/** A raised suggestion shape (the WARNING_EMITTED payload fields, §10.6). */
export interface TracePattern {
  pattern: string;
  count: number;
}

export class TraceAnalyzer {
  private readonly counts = new Map<string, number>();
  private readonly fired = new Set<string>();

  constructor(private readonly threshold: number) {}

  /**
   * Observe one record. Returns a `TracePattern` exactly once, the first time a
   * shape's repeat count reaches the threshold; `null` otherwise.
   */
  observe(record: ObsRecord): TracePattern | null {
    const shape = this.shapeOf(record);
    if (!shape) return null;
    const next = (this.counts.get(shape) ?? 0) + 1;
    this.counts.set(shape, next);
    if (next >= this.threshold && !this.fired.has(shape)) {
      this.fired.add(shape);
      return { pattern: shape, count: next };
    }
    return null;
  }

  /** The failure shape a record carries, or null when it is not a failure. */
  private shapeOf(record: ObsRecord): string | null {
    if (record.source === "tool" && record.status === "error") {
      return `tool_error:${record.name}`;
    }
    if (record.source === "guardian" && record.attributes["decision"] === "deny") {
      const tool = String(record.attributes["tool"] ?? record.name);
      return `guardian_block:${tool}`;
    }
    return null;
  }
}
