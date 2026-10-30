/**
 * §8.1/§14.6 — `toolCounts` computes honest TOOL_FINISHED counts from the FULL
 * result text, not the capped summary. These are the counts a TUI renders so a
 * big result is never undercounted (the "33 matches" bug for 50 files).
 */
import { describe, it, expect } from "vitest";
import { toolCounts } from "./tool-counts.js";

describe("§8.1/§14.6 toolCounts — counts from the FULL result", () => {
  it("an 80-line result (> 500 chars) reports lines=80 and truncated=true", () => {
    // Given — 80 non-empty lines whose total length exceeds the 500-char cap.
    const full = Array.from({ length: 80 }, (_, i) => `line ${i} padding padding`).join("\n");
    expect(full.length).toBeGreaterThan(500);
    // When
    const c = toolCounts("glob_files", full, 500);
    // Then — the count comes from the full text, and truncation is flagged.
    // MUTATION: counting the 500-char slice instead of the full text fails here.
    expect(c.lines).toBe(80);
    expect(c.truncated).toBe(true);
  });

  it("a small result reports its real line count and truncated=false", () => {
    const full = "a.ts\nb.ts\nc.ts";
    const c = toolCounts("glob_files", full, 500);
    expect(c.lines).toBe(3);
    expect(c.truncated).toBe(false);
  });

  it("ignores blank lines when counting", () => {
    const c = toolCounts("glob_files", "a\n\n\nb\n", 500);
    expect(c.lines).toBe(2);
  });

  it("workspace_map carries entries split by the trailing-slash rule", () => {
    // Given — 36 files and 14 dirs (dirs end in `/`), the real-result shape from
    // the bug (14 child dirs were missing from the CLI's summary count).
    const files = Array.from({ length: 36 }, (_, i) => `file${i}.ts`);
    const dirs = Array.from({ length: 14 }, (_, i) => `dir${i}/`);
    const full = [...dirs, ...files].join("\n");
    // When
    const c = toolCounts("workspace_map", full, 500);
    // Then — the true split, computed from the full text.
    // MUTATION: omitting the entries field (dropping it) fails this.
    expect(c.entries).toEqual({ files: 36, dirs: 14 });
  });

  it("a non-map tool carries no entries field", () => {
    const c = toolCounts("glob_files", "a\nb", 500);
    expect(c.entries).toBeUndefined();
  });
});
