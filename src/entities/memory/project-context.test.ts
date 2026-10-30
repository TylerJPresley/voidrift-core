/**
 * Project-context assembly (core-blueprint.md §6.6, §4.2.1 tier 1) — ordering
 * most-specific-last, nested-over-root priority, workspace-over-global, the
 * whole-head rule, and the window-fit fan-out when the merge cannot fit.
 */
import { describe, it, expect } from "vitest";
import {
  orderProjectFiles,
  mergeFull,
  assembleProjectHead,
  PROJECT_OVERFLOW_MARKER,
  type ProjectFile,
} from "./project-context.js";

describe("§6.6 — project file ordering", () => {
  it("orders global before workspace, shallower before deeper (most-specific-last)", () => {
    const files: ProjectFile[] = [
      { path: "pkg/sub/AGENTS.md", content: "c", depth: 2, scope: "workspace" },
      { path: "AGENTS.md", content: "a", depth: 0, scope: "workspace" },
      { path: "~/.config/voidrift/AGENTS.md", content: "g", depth: 0, scope: "global" },
    ];
    expect(orderProjectFiles(files).map((f) => f.path)).toEqual([
      "~/.config/voidrift/AGENTS.md",
      "AGENTS.md",
      "pkg/sub/AGENTS.md",
    ]);
  });
});

describe("§6.6 — merge most-specific-last", () => {
  it("a nested file overrides a root one by appearing last", () => {
    const files: ProjectFile[] = [
      { path: "AGENTS.md", content: "root rule", depth: 0, scope: "workspace" },
      { path: "pkg/AGENTS.md", content: "nested rule", depth: 1, scope: "workspace" },
    ];
    const ctx = assembleProjectHead(files, 8000);
    expect(ctx.full.indexOf("nested rule")).toBeGreaterThan(ctx.full.indexOf("root rule"));
    expect(ctx.overflow).toBe(false);
  });

  it("a workspace file overrides a global one by appearing last", () => {
    const files: ProjectFile[] = [
      { path: "~/g/AGENTS.md", content: "global rule", depth: 0, scope: "global" },
      { path: "AGENTS.md", content: "workspace rule", depth: 0, scope: "workspace" },
    ];
    const ctx = assembleProjectHead(files, 8000);
    expect(ctx.full.indexOf("workspace rule")).toBeGreaterThan(ctx.full.indexOf("global rule"));
  });

  it("mergeFull keeps every file whole, most-specific-last", () => {
    const files: ProjectFile[] = [
      { path: "AGENTS.md", content: "root", depth: 0, scope: "workspace" },
      { path: "pkg/AGENTS.md", content: "nested", depth: 1, scope: "workspace" },
    ];
    const full = mergeFull(files);
    expect(full).toContain("root");
    expect(full).toContain("nested");
    expect(full.indexOf("nested")).toBeGreaterThan(full.indexOf("root"));
  });
});

describe("§6.6/§4.2.1 — AGENTS.md rides the head WHOLE (tier 1)", () => {
  it("a 50k-char AGENTS.md rides the head WHOLE when it fits the window — no digest", () => {
    const big = "x".repeat(50_000);
    const files: ProjectFile[] = [{ path: "AGENTS.md", content: big, depth: 0, scope: "workspace" }];
    // A window-fit budget comfortably larger than the file (e.g. 128k chars).
    const ctx = assembleProjectHead(files, 128_000);
    expect(ctx.overflow).toBe(false);
    // The head carries the whole content verbatim — never a digest, never cut.
    expect(ctx.head).toContain(big);
    expect(ctx.head).not.toContain(PROJECT_OVERFLOW_MARKER);
  });

  it("the whole content rides the head even for a modest file (no structural reduction)", () => {
    const body =
      "# AGENTS.md\n\nFirst orientation paragraph.\n\n" +
      "## Build and verify\nRun the gate.\n\n" +
      "## Conventions\nWhich file governs: this file.\n\n" +
      "Body line BODYMARKER that still rides the head whole.";
    const files: ProjectFile[] = [{ path: "AGENTS.md", content: body, depth: 0, scope: "workspace" }];
    const ctx = assembleProjectHead(files, 10_000);
    expect(ctx.overflow).toBe(false);
    expect(ctx.head).toContain("BODYMARKER");
    expect(ctx.head).toBe(ctx.full);
  });
});

describe("§6.6/§4.8/§8.7 — window-fit fan-out only when the merge cannot fit", () => {
  it("keeps the WHOLE content and carries a marked head when the merge cannot fit the window", () => {
    const files: ProjectFile[] = [
      { path: "AGENTS.md", content: "x".repeat(500), depth: 0, scope: "workspace" },
    ];
    const ctx = assembleProjectHead(files, 100);
    expect(ctx.overflow).toBe(true);
    // The full text still carries every char — nothing is dropped.
    expect(ctx.full).toContain("x".repeat(500));
    // The HEAD is reduced and names the fit-fraction key.
    expect(ctx.head).toContain(PROJECT_OVERFLOW_MARKER);
    expect(ctx.head).toContain("limits.ingest.fitFraction");
    expect(ctx.head.length).toBeLessThanOrEqual(100 + PROJECT_OVERFLOW_MARKER.length + 4);
  });

  it("uses the cached ingest digest in the head when one exists (§8.7)", () => {
    const files: ProjectFile[] = [
      { path: "AGENTS.md", content: "x".repeat(500), depth: 0, scope: "workspace" },
    ];
    const ctx = assembleProjectHead(files, 100, "lines 1-9: the cached digest body");
    expect(ctx.overflow).toBe(true);
    expect(ctx.head).toContain("the cached digest body");
    expect(ctx.head).toContain(PROJECT_OVERFLOW_MARKER);
    // The marked head of raw content is NOT used when a digest is available.
    expect(ctx.head).not.toContain("x".repeat(100));
  });
});
