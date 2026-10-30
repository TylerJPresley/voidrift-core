/**
 * The threshold tracker and the ContextBreakdown DTO (core-blueprint.md §4.8).
 *
 * `CONTEXT_THRESHOLD_CROSSED` fires once per level as working-budget occupancy
 * rises through it and re-arms when occupancy drops back below it — compaction
 * makes the percentage a sawtooth in a long chat — so a level never fires twice
 * without first clearing. Levels: compaction | safety_net | overflow | head |
 * notice. The `head` level is sized differently (fixed context vs the WINDOW,
 * §4.2.1) but re-arms the same way and carries the largest head `components`.
 */
import type { HeadComponent } from "./head.js";

export type ThresholdLevel = "compaction" | "safety_net" | "overflow" | "head" | "notice";

/** A level with its trigger percentage. */
export interface ThresholdDef {
  level: ThresholdLevel;
  pct: number;
}

/** A crossing to emit. `components` is present only on a `head` crossing (§14.6). */
export interface Crossing {
  level: ThresholdLevel;
  percentage: number;
  components?: HeadComponent[];
}

/**
 * Tracks which levels are currently "armed as crossed" so each fires once on the
 * way up and re-arms on the way down (the sawtooth, §4.8). Stateful but pure —
 * the middleware owns one per session and feeds it the rounded occupancy.
 */
export class ThresholdTracker {
  private readonly crossed = new Set<string>();

  /**
   * Update with the new occupancy percentage and the active level definitions.
   * Returns the crossings to emit this update. A level armed as crossed that is
   * now below its trigger re-arms silently (no event); a level now at/above its
   * trigger that was not crossed fires once.
   */
  update(percentage: number, defs: ThresholdDef[]): Crossing[] {
    const fired: Crossing[] = [];
    for (const d of defs) {
      const key = `${d.level}:${d.pct}`;
      const isAbove = percentage >= d.pct;
      const wasCrossed = this.crossed.has(key);
      if (isAbove && !wasCrossed) {
        this.crossed.add(key);
        fired.push({ level: d.level, percentage });
      } else if (!isAbove && wasCrossed) {
        this.crossed.delete(key); // re-arm
      }
    }
    return fired;
  }

  /**
   * The head-size warning (§4.2.1): fired when the fixed context (head tokens +
   * bound tool-schema tokens) passes `headWarnPct` of the WINDOW. It is a
   * SEPARATE axis from working-budget occupancy — a different percentage against
   * a different base — but re-arms the same way: it fires ONCE when the fixed
   * context rises through the threshold and re-arms when it drops back below, so
   * a `head` crossing never fires twice without first clearing. The `components`
   * (largest head items with their sizes) ride the crossing; the head cuts
   * nothing (§4.8, §14.6). Returns the single crossing to emit, or `null`.
   */
  updateHead(headPct: number, warnPct: number, components: HeadComponent[]): Crossing | null {
    const key = "head";
    const isAbove = headPct >= warnPct;
    const wasCrossed = this.crossed.has(key);
    if (isAbove && !wasCrossed) {
      this.crossed.add(key);
      return { level: "head", percentage: headPct, components };
    }
    if (!isAbove && wasCrossed) {
      this.crossed.delete(key); // re-arm
    }
    return null;
  }
}

/**
 * The full context breakdown `models.context()` returns (§4.8, §11.9) — a DTO,
 * no LangChain type crosses the facade.
 */
export interface ContextBreakdown {
  window: number;
  workingBudget: number;
  headTokens: number;
  head: { inline: number; digest: number; manifest: number };
  agentTokens: number;
  voidTokens: number;
  riftTokens: number;
  toolSchemaTokens: number;
  usedTokens: number;
  occupancyPct: number;
}
