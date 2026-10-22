/**
 * Dataset declaration standard — schema validation (core-blueprint.md §12.7).
 * `rows` is a ZERO-argument reader; a reader that declares a parameter is
 * rejected. The DATA members (`description`, `fields`) follow the bounded,
 * unique-key rules; a duplicate field key is rejected naming the field.
 */
import { describe, it, expect } from "vitest";
import { validateDatasetDeclaration } from "./dataset-schema.js";

describe("§12.7 dataset declaration schema", () => {
  it("accepts a well-formed declaration (sync rows)", () => {
    const result = validateDatasetDeclaration({
      description: "Registered models",
      fields: [
        { key: "name", label: "Name" },
        { key: "lastUsed", label: "Last used", format: "relative-time" },
      ],
      rows: () => [{ name: "test" }],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts an async rows reader and a declaration without fields", () => {
    const result = validateDatasetDeclaration({ description: "Sessions", rows: async () => [] });
    expect(result.ok).toBe(true);
  });

  it("rejects a rows reader that takes an argument (not zero-arg)", () => {
    const result = validateDatasetDeclaration({ description: "X", rows: (arg: unknown) => [arg] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe("rows");
  });

  it("rejects a missing rows reader", () => {
    const result = validateDatasetDeclaration({ description: "X" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe("rows");
  });

  it("rejects duplicate field keys naming the field", () => {
    const result = validateDatasetDeclaration({
      description: "X",
      fields: [{ key: "n", label: "A" }, { key: "n", label: "B" }],
      rows: () => [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe("fields");
  });

  it("rejects an empty description", () => {
    const result = validateDatasetDeclaration({ description: "", rows: () => [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe("description");
  });

  it("rejects an unknown field format", () => {
    const result = validateDatasetDeclaration({
      description: "X",
      fields: [{ key: "n", label: "N", format: "nope" }],
      rows: () => [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe("fields");
  });

  it("rejects an unknown DATA member (strict)", () => {
    const result = validateDatasetDeclaration({ description: "X", extra: 1, rows: () => [] });
    expect(result.ok).toBe(false);
  });
});
