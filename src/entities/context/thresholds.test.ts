/**
 * The threshold tracker (core-blueprint.md §4.8) — fires once on the way up and
 * re-arms on the way down (the sawtooth).
 */
import { describe, it, expect } from "vitest";
import { ThresholdTracker, type ThresholdDef } from "./thresholds.js";

const defs: ThresholdDef[] = [
  { level: "compaction", pct: 40 },
  { level: "safety_net", pct: 80 },
  { level: "notice", pct: 50 },
];

describe("ThresholdTracker (§4.8)", () => {
  it("fires a level once as occupancy rises through it", () => {
    const t = new ThresholdTracker();
    expect(t.update(10, defs)).toEqual([]);
    const fired = t.update(45, defs);
    expect(fired).toEqual([{ level: "compaction", percentage: 45 }]);
    // staying above does not re-fire
    expect(t.update(46, defs)).toEqual([]);
  });

  it("re-arms when occupancy drops below, then fires again (sawtooth)", () => {
    const t = new ThresholdTracker();
    t.update(45, defs); // compaction fired
    expect(t.update(30, defs)).toEqual([]); // drop below re-arms silently
    expect(t.update(45, defs)).toEqual([{ level: "compaction", percentage: 45 }]); // fires again
  });

  it("fires a notice band from contextNoticePcts", () => {
    const t = new ThresholdTracker();
    const fired = t.update(55, defs);
    expect(fired).toContainEqual({ level: "compaction", percentage: 55 });
    expect(fired).toContainEqual({ level: "notice", percentage: 55 });
  });
});
