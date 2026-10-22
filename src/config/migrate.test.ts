/**
 * Tests for the versioned config-key migration (core-blueprint.md §13.1).
 *
 * A retired key name is mapped to its current name IN MEMORY on every load, so
 * a config written for an older VoidRift keeps working; a conflict (both the old
 * and the new key present) resolves in favour of the NEW key with a warning; an
 * unknown NON-retired key is left untouched (so the schema still rejects it).
 */
import { describe, it, expect } from "vitest";
import { migrateRetiredKeys, RETIRED_KEYS } from "./migrate.js";

describe("migrateRetiredKeys (§13.1)", () => {
  it("maps modelPrimary → modelSelected", () => {
    const { doc, migrations } = migrateRetiredKeys({ modelPrimary: "local" });
    expect(doc).toEqual({ modelSelected: "local" });
    expect(migrations).toEqual([{ from: "modelPrimary", to: "modelSelected", conflict: false }]);
  });

  it("maps modelBackground → modelUtility", () => {
    const { doc, migrations } = migrateRetiredKeys({ modelBackground: "util" });
    expect(doc).toEqual({ modelUtility: "util" });
    expect(migrations).toEqual([{ from: "modelBackground", to: "modelUtility", conflict: false }]);
  });

  it("maps every retired loader key in the table", () => {
    // The table is fixed in code; assert the full retired set is covered.
    expect(Object.keys(RETIRED_KEYS).sort()).toEqual(
      ["modelBackground", "modelPrimary", "modelTierFlash", "modelTierUtility"].sort(),
    );
  });

  it("resolves a conflict in favour of the NEW key and flags it", () => {
    // Both the retired and the current key are present: keep the new value,
    // drop the retired one, and report the conflict.
    const { doc, migrations } = migrateRetiredKeys({ modelPrimary: "old", modelSelected: "new" });
    expect(doc).toEqual({ modelSelected: "new" });
    expect(migrations).toEqual([{ from: "modelPrimary", to: "modelSelected", conflict: true }]);
  });

  it("leaves an unknown NON-retired key untouched (schema still rejects it)", () => {
    const { doc, migrations } = migrateRetiredKeys({ turnRecurisonLimit: 5 });
    expect(doc).toEqual({ turnRecurisonLimit: 5 });
    expect(migrations).toEqual([]);
  });

  it("is a no-op for a document with no retired key", () => {
    const input = { modelSelected: "local", models: {} };
    const { doc, migrations } = migrateRetiredKeys(input);
    expect(doc).toEqual(input);
    expect(doc).not.toBe(input); // a fresh object, never mutated in place
    expect(migrations).toEqual([]);
  });

  it("migrates several retired keys in one pass", () => {
    const { doc, migrations } = migrateRetiredKeys({
      modelTierFlash: "flash",
      modelTierUtility: "util",
    });
    expect(doc).toEqual({ modelSelected: "flash", modelUtility: "util" });
    expect(migrations.map((m) => m.from).sort()).toEqual(["modelTierFlash", "modelTierUtility"]);
  });
});
