/**
 * Panel declaration standard — schema validation (core-blueprint.md §12.6,
 * panels-blueprint §2, §3). The core owns the ONE shape and validates every
 * declaration: a well-formed one round-trips through JSON unchanged; each
 * invalid case is rejected with a typed failure naming the offending field; a
 * function-bearing declaration is rejected. `source` names a registered DATASET
 * (a lowercase slug, §12.7) — a dotted op path is REJECTED.
 */
import { describe, it, expect } from "vitest";
import { validatePanelDeclaration, type PanelDeclaration } from "./panel-schema.js";

const valid: PanelDeclaration = {
  title: "Memory",
  description: "Stored memory and suggestions",
  columns: [
    { key: "kind", label: "Kind", width: 12, format: "text" },
    { key: "title", label: "Title" },
  ],
  source: ["memory", "memory-suggestions"],
  pages: [
    { key: "stored", label: "Stored", source: "memory" },
    {
      key: "suggestions",
      label: "Suggestions",
      source: "memory-suggestions",
      actions: {
        a: { label: "approve", op: "memory.suggestions.approve", confirm: true },
        r: { label: "reject", op: "memory.suggestions.reject", confirm: "Reject this suggestion?" },
      },
    },
  ],
  detail: { title: "Entry" },
  actions: {
    d: { label: "delete", op: "memory.delete" },
  },
};

describe("§12.6 panel declaration schema", () => {
  it("accepts a well-formed declaration and round-trips it through JSON unchanged", () => {
    const result = validatePanelDeclaration(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(valid);
      expect(JSON.parse(JSON.stringify(result.value))).toEqual(valid);
    }
  });

  it("accepts a single-slug source", () => {
    const result = validatePanelDeclaration({ title: "Sessions", columns: [{ key: "id", label: "Id" }], source: "sessions" });
    expect(result.ok).toBe(true);
  });

  it("accepts a declaration that omits columns (defaults from the dataset fields, §12.6)", () => {
    const result = validatePanelDeclaration({ title: "Tools", source: "tools" });
    expect(result.ok).toBe(true);
  });

  it("accepts a bare §12.6 declaration that omits every new member (backward compat)", () => {
    const result = validatePanelDeclaration({ title: "Agents", columns: [{ key: "name", label: "Name" }], source: "agents" });
    expect(result.ok).toBe(true);
  });

  const cases: { name: string; decl: unknown; field: string }[] = [
    { name: "empty title", decl: { ...valid, title: "" }, field: "title" },
    { name: "empty columns", decl: { title: "X", columns: [], source: "a" }, field: "columns" },
    { name: "duplicate column key", decl: { title: "X", columns: [{ key: "n", label: "A" }, { key: "n", label: "B" }], source: "a" }, field: "columns" },
    { name: "non-positive width", decl: { title: "X", columns: [{ key: "n", label: "N", width: 0 }], source: "a" }, field: "columns" },
    { name: "unknown column format", decl: { title: "X", columns: [{ key: "n", label: "N", format: "nope" }], source: "a" }, field: "columns" },
    { name: "dotted source (an op path) is rejected", decl: { title: "X", columns: [{ key: "n", label: "N" }], source: "session.list" }, field: "source" },
    { name: "non-slug source", decl: { title: "X", columns: [{ key: "n", label: "N" }], source: "Bad Name" }, field: "source" },
    { name: "empty description", decl: { ...valid, description: "" }, field: "description" },
    { name: "duplicate page key", decl: { title: "X", source: "a", pages: [{ key: "p", label: "P" }, { key: "p", label: "Q" }] }, field: "pages" },
    { name: "multi-character hotkey", decl: { title: "X", source: "a", actions: { ab: { label: "x", op: "a.b" } } }, field: "actions" },
    { name: "non-dotted action op", decl: { title: "X", source: "a", actions: { a: { label: "x", op: "bad op" } } }, field: "actions" },
    { name: "confirm of a non-string non-true value", decl: { title: "X", source: "a", actions: { a: { label: "x", op: "a.b", confirm: 1 } } }, field: "actions" },
    { name: "unknown member", decl: { ...valid, extra: 1 }, field: "panel" },
  ];

  for (const c of cases) {
    it(`rejects ${c.name} with a typed error naming the field`, () => {
      const result = validatePanelDeclaration(c.decl);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.field).toBe(c.field);
    });
  }

  it("rejects a function-bearing declaration (non-serializable member, JSON round-trip)", () => {
    const decl = { ...valid, actions: { a: { label: "delete", op: "memory.delete", handler: () => undefined } } };
    const result = validatePanelDeclaration(decl);
    expect(result.ok).toBe(false);
  });

  it("rejects a function supplied at the top level (JSON round-trip equality guard)", () => {
    const decl = { title: "X", columns: [{ key: "n", label: "N" }], source: "a", getItems: () => [] };
    const result = validatePanelDeclaration(decl);
    expect(result.ok).toBe(false);
  });
});
