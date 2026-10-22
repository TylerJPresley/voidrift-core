/**
 * Project-context assembly (core-blueprint.md §6.6) — ordering most-specific-last,
 * nested-over-root priority, workspace-over-global, and the project-bound stop.
 */
import { describe, it, expect } from "vitest";
import {
  orderProjectFiles,
  mergeProjectContext,
  deriveDigest,
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
    const ctx = mergeProjectContext(files, 8000);
    expect(ctx.full.indexOf("nested rule")).toBeGreaterThan(ctx.full.indexOf("root rule"));
    expect(ctx.truncated).toBe(false);
  });

  it("a workspace file overrides a global one by appearing last", () => {
    const files: ProjectFile[] = [
      { path: "~/g/AGENTS.md", content: "global rule", depth: 0, scope: "global" },
      { path: "AGENTS.md", content: "workspace rule", depth: 0, scope: "workspace" },
    ];
    const ctx = mergeProjectContext(files, 8000);
    expect(ctx.full.indexOf("workspace rule")).toBeGreaterThan(ctx.full.indexOf("global rule"));
  });

  it("keeps the WHOLE content when it exceeds the head budget — never cut (§4.8/§8.7)", () => {
    const files: ProjectFile[] = [
      { path: "AGENTS.md", content: "x".repeat(500), depth: 0, scope: "workspace" },
    ];
    const ctx = mergeProjectContext(files, 100);
    expect(ctx.overflow).toBe(true);
    expect(ctx.truncated).toBe(true);
    // The full text still carries every char — nothing is dropped.
    expect(ctx.full).toContain("x".repeat(500));
    // The HEAD is reduced and names the fit-fraction key.
    expect(ctx.digest).toContain(PROJECT_OVERFLOW_MARKER);
    expect(ctx.digest).toContain("limits.ingest.fitFraction");
    expect(ctx.digest.length).toBeLessThanOrEqual(100 + PROJECT_OVERFLOW_MARKER.length + 4);
  });

  it("loads WHOLE when within the head budget", () => {
    const files: ProjectFile[] = [
      { path: "AGENTS.md", content: "short rule", depth: 0, scope: "workspace" },
    ];
    const ctx = mergeProjectContext(files, 10_000);
    expect(ctx.overflow).toBe(false);
    expect(ctx.truncated).toBe(false);
    expect(ctx.digest).toBe(ctx.full);
    expect(ctx.digest).not.toContain(PROJECT_OVERFLOW_MARKER);
  });

  it("uses the cached ingest digest in the head when one exists (§8.7)", () => {
    const files: ProjectFile[] = [
      { path: "AGENTS.md", content: "x".repeat(500), depth: 0, scope: "workspace" },
    ];
    const ctx = assembleProjectHead(files, 100, "lines 1-9: the cached digest body");
    expect(ctx.overflow).toBe(true);
    expect(ctx.digest).toContain("the cached digest body");
    expect(ctx.digest).toContain(PROJECT_OVERFLOW_MARKER);
    // The marked head of raw content is NOT used when a digest is available.
    expect(ctx.digest).not.toContain("x".repeat(100));
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

describe("§4.2.1 — digest derivation", () => {
  it("takes the leading non-empty lines up to maxChars", () => {
    const digest = deriveDigest("# AGENTS.md\n\nline one\nline two", 20);
    expect(digest.length).toBeLessThanOrEqual(20);
    expect(digest).toContain("# AGENTS.md");
  });
});
