/**
 * Project-context assembly (core-blueprint.md §6.6) — ordering most-specific-last,
 * nested-over-root priority, workspace-over-global, and the project-bound stop.
 */
import { describe, it, expect } from "vitest";
import {
  orderProjectFiles,
  mergeProjectContext,
  deriveDigest,
  projectDigest,
  mergeFull,
  assembleProjectHead,
  PROJECT_OVERFLOW_MARKER,
  type ProjectFile,
} from "./project-context.js";
import fs from "node:fs";

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
    expect(ctx.overflow).toBe(false);
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

  it("rides a REAL structural digest (not the whole body) when within the head budget (§4.2.1 tier 2)", () => {
    const body =
      "# AGENTS.md\n\nFirst orientation paragraph for the project.\n\n" +
      "## Build and verify\nRun the gate.\n\n" +
      "## Conventions\nWhich file governs: this file for cross-repo rules.\n\n" +
      "Long body marker LONGBODYMARKER that must NOT ride the head.";
    const files: ProjectFile[] = [
      { path: "AGENTS.md", content: body, depth: 0, scope: "workspace" },
    ];
    const ctx = mergeProjectContext(files, 10_000);
    expect(ctx.overflow).toBe(false);
    // The head is a reduced digest (truncated flag = head is a digest), and the
    // full body is kept whole for the pointer.
    expect(ctx.truncated).toBe(true);
    expect(ctx.full).toContain("LONGBODYMARKER");
    // The digest carries every heading plus each section's first line…
    expect(ctx.digest).toContain("# AGENTS.md");
    expect(ctx.digest).toContain("## Build and verify");
    expect(ctx.digest).toContain("Run the gate.");
    expect(ctx.digest).toContain("## Conventions");
    // …but NOT a later body line (not a section's first line), and it is smaller
    // than the whole file.
    expect(ctx.digest).not.toContain("LONGBODYMARKER");
    expect(ctx.digest.length).toBeLessThan(ctx.full.length);
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

describe("§4.2.1 — projectDigest (generic structural head digest)", () => {
  // A GENERIC project file with wording unrelated to this project: proves no key
  // line or heading text is hard-coded.
  const body =
    "Lead paragraph describing the WIDGET project in plain words.\n\n" +
    "# Widget Toolkit\nThe toolkit assembles widgets from parts.\n\n" +
    "## Getting started\nInstall with npm and run the demo.\n\n" +
    "## Architecture\nWidgets flow through a pipeline of stages.\n\n" +
    "### Stages\nDEEPBODY stage detail that is relocated behind the pointer.\n" +
    "A second line of the stages section that must not ride the head.";

  it("inlines every heading in document order (the shape of the file)", () => {
    const d = projectDigest(body, 5000);
    const order = ["# Widget Toolkit", "## Getting started", "## Architecture", "### Stages"];
    let last = -1;
    for (const h of order) {
      const at = d.indexOf(h);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
  });

  it("follows each heading with the first non-empty line of its section", () => {
    const d = projectDigest(body, 5000);
    expect(d).toContain("The toolkit assembles widgets from parts.");
    expect(d).toContain("Install with npm and run the demo.");
    expect(d).toContain("Widgets flow through a pipeline of stages.");
    expect(d).toContain("DEEPBODY stage detail");
  });

  it("inlines the lead paragraph before the first heading", () => {
    const d = projectDigest(body, 5000);
    expect(d).toContain("Lead paragraph describing the WIDGET project");
  });

  it("excludes section lines past the first (relocated behind the pointer)", () => {
    const d = projectDigest(body, 5000);
    expect(d).not.toContain("A second line of the stages section");
  });

  it("trims a long section first line to the derived per-section share with an ellipsis", () => {
    const long = "y".repeat(400);
    // One heading section → share = floor(maxChars / 1). Pick a maxChars small
    // enough that 400 "y" is cut, large enough the heading still fits.
    const d = projectDigest(`# H\n${long}`, 200);
    expect(d).toContain("# H");
    expect(d).toContain("…");
    // The whole digest is bounded by maxChars, so the long run is cut.
    expect(d.length).toBeLessThanOrEqual(200);
    expect(d).not.toContain("y".repeat(400));
  });

  it("over budget: keeps all headings first, drops first-lines then the lead", () => {
    // A tight budget big enough for the heading map but not the first-lines.
    const headingMap = ["# Widget Toolkit", "## Getting started", "## Architecture", "### Stages"].join("\n\n");
    const d = projectDigest(body, headingMap.length + 2);
    for (const h of ["# Widget Toolkit", "## Getting started", "## Architecture", "### Stages"]) {
      expect(d).toContain(h);
    }
    // No first-line or lead fit, so none of their text rides the head.
    expect(d).not.toContain("The toolkit assembles");
    expect(d).not.toContain("Lead paragraph describing");
    expect(d.length).toBeLessThanOrEqual(headingMap.length + 2);
  });

  it("stays within the char cap", () => {
    const d = projectDigest(body, 120);
    expect(d.length).toBeLessThanOrEqual(120);
  });

  it("falls back to the leading-lines digest when there are no headings", () => {
    const flat = "just one plain line of rules with no headings at all";
    const d = projectDigest(flat, 100);
    expect(d).toContain("just one plain line");
  });

  // Hard-wrapped Markdown (as real AGENTS.md files are): the OLD behaviour took
  // the first non-empty LINE, yielding a sentence fragment ("…Start the"). The
  // digest now joins the paragraph's wrapped lines and cuts at the first
  // sentence end.
  const wrapped =
    "This folder is the entry point for AI work on VoidRift and the local\n" +
    "development environment. Start the assistant here. It is a private git repo.\n\n" +
    "# Build and verify\n" +
    "Run the gate across every repo, which guards the graph, builds in\n" +
    "dependency order and runs the tests. A second sentence that follows.\n\n" +
    "## Repositories\n" +
    "- Each voidrift folder is its own git repository and the real home of\n" +
    "  one package, listed in repos.json and ignored by this repo.\n" +
    "- The second list item that must not ride the head.";

  it("takes the FIRST SENTENCE of a section's first paragraph, not the first wrapped line", () => {
    const d = projectDigest(wrapped, 5000);
    // Joined across the wrap, cut at the first ". " — no fragment, no second sentence.
    expect(d).toContain("Run the gate across every repo, which guards the graph, builds in dependency order and runs the tests.");
    expect(d).not.toContain("A second sentence that follows.");
    // The OLD fragment (first wrapped line only) must NOT appear.
    expect(d).not.toContain("Run the gate across every repo, which guards the graph, builds in\n");
  });

  it("reduces the lead paragraph to its FIRST sentence, joined across wraps", () => {
    const d = projectDigest(wrapped, 5000);
    expect(d).toContain(
      "This folder is the entry point for AI work on VoidRift and the local development environment.",
    );
    // The second sentence of the lead is dropped (lead is an ordinary first section).
    expect(d).not.toContain("Start the assistant here.");
    // The OLD fragment ("…and the local" line break then "development") is gone.
    expect(d).not.toContain("the local\ndevelopment");
  });

  it("a list-item section uses its first list item (joined across wraps) as the snippet", () => {
    const d = projectDigest(wrapped, 5000);
    expect(d).toContain("## Repositories");
    expect(d).toContain("Each voidrift folder is its own git repository and the real home of one package, listed in repos.json and ignored by this repo.");
    expect(d).not.toContain("The second list item that must not ride the head.");
  });

  it("caps a long first sentence at the derived per-section share with an ellipsis", () => {
    const long = "Z".repeat(400) + ". Next sentence.";
    const d = projectDigest(`# H\n${long}`, 200);
    expect(d).toContain("# H");
    expect(d).toContain("…");
    expect(d.length).toBeLessThanOrEqual(200);
    expect(d).not.toContain("Z".repeat(400));
  });

  it("caps the lead paragraph at the derived per-section share with an ellipsis", () => {
    const longLead = "W".repeat(500) + ". Second sentence of the lead.\n\n# H\nbody.";
    const d = projectDigest(longLead, 200);
    expect(d).toContain("…");
    expect(d.length).toBeLessThanOrEqual(200);
    expect(d).not.toContain("W".repeat(500));
  });

  it("derives the per-section share from the ONE budget: a file with FEWER sections gets a LONGER sentence", () => {
    // Same long first sentence, same budget — only the number of sections
    // differs. The derived share = floor(budget / sectionCount), so fewer
    // sections → more room → a longer kept sentence. No hidden sentence cap.
    const sentence = "W".repeat(900) + ". tail.";
    const budget = 600;
    const few = projectDigest(`# One\n${sentence}`, budget);
    const many = projectDigest(
      `# One\n${sentence}\n\n# Two\nbody two.\n\n# Three\nbody three.\n\n# Four\nbody four.`,
      budget,
    );
    const lineOf = (d: string): string => d.split("\n").find((l) => l.startsWith("W")) ?? "";
    expect(lineOf(few).length).toBeGreaterThan(lineOf(many).length);
    // Both stay within the one budget.
    expect(few.length).toBeLessThanOrEqual(budget);
    expect(many.length).toBeLessThanOrEqual(budget);
  });

  it("carries no hidden numeric constant — only 0/1/2 appear as literals in projectDigest", () => {
    // The sentence allowance is DERIVED, not a constant. Guard: inside the
    // projectDigest function the only numeric literals are 0, 1, 2 (index and
    // separator math) — no min/max/length cap smuggled back in. Pre-existing
    // token-estimate math (chars/4) and the heading-level regex ({1,6}) live in
    // other functions and are out of scope.
    const src = fs.readFileSync(new URL("./project-context.ts", import.meta.url), "utf8");
    const start = src.indexOf("export function projectDigest");
    expect(start).toBeGreaterThan(-1);
    // The function ends at the next top-level `export function` after it.
    const rest = src.slice(start + 1);
    const nextExport = rest.indexOf("\nexport function");
    const bodySrc = nextExport === -1 ? rest : rest.slice(0, nextExport);
    const code = bodySrc
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ")
      // Strip regex literals: a Markdown-syntax bound like {1,6} is protocol, not
      // a content cap. (Simple heuristic: /.../ not preceded by an identifier.)
      .replace(/(^|[=(,\s])\/(?:[^/\n\\]|\\.)+\/[a-z]*/g, "$1 ");
    const literals = code.match(/(?<![A-Za-z0-9_.])\d+(?:\.\d+)?/g) ?? [];
    const offending = literals.filter((n) => !["0", "1", "2"].includes(n));
    expect(offending).toEqual([]);
  });
});
