/**
 * Suggestion dedup + DTO mapping (core-blueprint.md §6.7).
 */
import { describe, it, expect } from "vitest";
import { isDuplicate, toSuggestionDTO, validateSkillAssets, SKILL_ASSET_LIMITS, buildSequenceEvidence, SEQUENCE_EVIDENCE_MAX_ARGS_PER_STEP, type Suggestion, type SequenceSignal } from "./suggestion.js";

describe("§6.7 — candidate dedup", () => {
  it("drops a candidate whose normalized body matches an existing memory body", () => {
    expect(isDuplicate({ body: "Use  PNPM" }, ["use pnpm"], [])).toBe(true);
  });

  it("drops a candidate whose body matches a pending suggestion body", () => {
    expect(isDuplicate({ body: "Never force push" }, [], ["never FORCE push"])).toBe(true);
  });

  it("keeps a genuinely new candidate", () => {
    expect(isDuplicate({ body: "brand new lesson" }, ["something else"], ["another"])).toBe(false);
  });
});

describe("§6.7 — suggestion DTO", () => {
  it("maps the entity to a DTO without leaking internal fields", () => {
    const s: Suggestion = {
      id: "sug-1",
      kind: "memory-note",
      title: "T",
      body: "B",
      keywords: ["k"],
      memoryType: "note",
      memoryScope: "workspace",
      status: "pending",
      sourceSessionId: "s1",
      createdAt: "t",
    };
    const dto = toSuggestionDTO(s);
    expect(dto).toEqual({
      id: "sug-1",
      kind: "memory-note",
      title: "T",
      body: "B",
      status: "pending",
      sourceSessionId: "s1",
      createdAt: "t",
    });
    expect("keywords" in dto).toBe(false);
  });
});

describe("§6.7 — skill asset validation", () => {
  it("accepts undefined, empty, and valid paths under the three dirs", () => {
    expect(validateSkillAssets(undefined)).toBeNull();
    expect(validateSkillAssets([])).toBeNull();
    expect(
      validateSkillAssets([
        { path: "scripts/run.sh", content: "#!/bin/sh\necho hi\n" },
        { path: "references/notes.md", content: "notes" },
        { path: "assets/template.txt", content: "t" },
      ]),
    ).toBeNull();
  });

  it("rejects absolute, traversal, backslash, NUL, and out-of-dir paths", () => {
    expect(validateSkillAssets([{ path: "/etc/passwd", content: "x" }])).toMatch(/absolute/);
    expect(validateSkillAssets([{ path: "scripts/../../x", content: "x" }])).toMatch(/\.\./);
    expect(validateSkillAssets([{ path: "scripts\\x", content: "x" }])).toMatch(/backslash/);
    expect(validateSkillAssets([{ path: "scripts/a\0b", content: "x" }])).toMatch(/NUL/);
    expect(validateSkillAssets([{ path: "bin/run.sh", content: "x" }])).toMatch(/not under/);
  });

  it("rejects duplicate and case-colliding paths", () => {
    expect(
      validateSkillAssets([
        { path: "scripts/Run.sh", content: "x" },
        { path: "scripts/run.sh", content: "y" },
      ]),
    ).toMatch(/duplicate or case-colliding/);
  });

  it("rejects non-text content (a NUL byte)", () => {
    expect(validateSkillAssets([{ path: "assets/x", content: "a\0b" }])).toMatch(/non-text/);
  });

  it("enforces the file-count, per-file, and total caps", () => {
    const many = Array.from({ length: SKILL_ASSET_LIMITS.maxFiles + 1 }, (_, i) => ({
      path: `scripts/s${i}`,
      content: "x",
    }));
    expect(validateSkillAssets(many)).toMatch(/too many/);
    expect(
      validateSkillAssets([{ path: "scripts/big", content: "x".repeat(SKILL_ASSET_LIMITS.maxBytesPerFile + 1) }]),
    ).toMatch(/per-file limit/);
    const big = "x".repeat(SKILL_ASSET_LIMITS.maxBytesPerFile);
    const total = Array.from({ length: 5 }, (_, i) => ({ path: `scripts/s${i}`, content: big }));
    expect(validateSkillAssets(total)).toMatch(/over the .* limit/);
  });
});

describe("§10.6 — buildSequenceEvidence: up to 3 redacted arg summaries per step", () => {
  const signal: SequenceSignal = {
    pattern: "read_file({path:string}) → write_file({path:string})",
    steps: ["read_file({path:string})", "write_file({path:string})"],
    count: 3,
    split: { within: 3, across: 0 },
    outcome: "success",
    sessionIds: ["s1", "s2", "s3"],
  };

  it("groups up to three distinct arg summaries per step by tool name", () => {
    const spans = [
      { source: "tool", name: "read_file", status: "ok", argSummary: '{"path":"a"}' },
      { source: "tool", name: "read_file", status: "ok", argSummary: '{"path":"b"}' },
      { source: "tool", name: "read_file", status: "ok", argSummary: '{"path":"c"}' },
      { source: "tool", name: "read_file", status: "ok", argSummary: '{"path":"d"}' }, // 4th, dropped
      { source: "tool", name: "write_file", status: "ok", argSummary: '{"path":"x"}' },
    ];
    const ev = buildSequenceEvidence(signal, spans, 100_000);
    expect(ev.stepArgExamples).toHaveLength(2);
    expect(ev.stepArgExamples[0]).toEqual(['{"path":"a"}', '{"path":"b"}', '{"path":"c"}']);
    expect(ev.stepArgExamples[0]!.length).toBeLessThanOrEqual(SEQUENCE_EVIDENCE_MAX_ARGS_PER_STEP);
    expect(ev.stepArgExamples[1]).toEqual(['{"path":"x"}']);
  });

  it("de-duplicates identical arg summaries within a step", () => {
    const spans = [
      { source: "tool", name: "read_file", status: "ok", argSummary: '{"path":"a"}' },
      { source: "tool", name: "read_file", status: "ok", argSummary: '{"path":"a"}' },
    ];
    const ev = buildSequenceEvidence(signal, spans, 100_000);
    expect(ev.stepArgExamples[0]).toEqual(['{"path":"a"}']);
  });

  it("shrinks to fit the budget: drops example spans first, then per-step args", () => {
    const spans = Array.from({ length: 6 }, (_, i) => ({
      source: "tool",
      name: i % 2 === 0 ? "read_file" : "write_file",
      status: "ok",
      argSummary: `{"path":"${i}"}`,
    }));
    const tiny = buildSequenceEvidence(signal, spans, 220);
    expect(JSON.stringify(tiny).length).toBeLessThanOrEqual(220);
  });
});
