import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  validateResponseSchema,
  selectStrategy,
  buildToolStrategy,
  protocolSupportsProviderStrategy,
  validateStructuredValue,
  MAX_RESPONSE_SCHEMA_BYTES,
} from "./structured-output.js";

describe("validateResponseSchema — boundary validation and size cap", () => {
  it("accepts a Zod schema", () => {
    const r = validateResponseSchema(z.object({ name: z.string() }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.isZod).toBe(true);
  });

  it("accepts a JSON Schema object", () => {
    const r = validateResponseSchema({ type: "object", properties: { n: { type: "number" } } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.isZod).toBe(false);
  });

  it("rejects empty, non-object, and array schemas", () => {
    expect(validateResponseSchema(undefined).ok).toBe(false);
    expect(validateResponseSchema(null).ok).toBe(false);
    expect(validateResponseSchema("nope").ok).toBe(false);
    expect(validateResponseSchema([1, 2]).ok).toBe(false);
  });

  it("rejects a JSON Schema over the size cap", () => {
    const huge = { type: "object", description: "x".repeat(MAX_RESPONSE_SCHEMA_BYTES + 10) };
    const r = validateResponseSchema(huge);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("size cap");
  });

  it("honors an injected (lowered) cap from the limits port — tools.responseSchemaMaxBytes is a safety limit (project may only LOWER)", () => {
    const schema = { type: "object", description: "x".repeat(200) };
    // Default cap accepts it; a lowered cap (100 bytes) rejects the SAME schema.
    expect(validateResponseSchema(schema).ok).toBe(true);
    const r = validateResponseSchema(schema, 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("size cap");
  });
});

describe("selectStrategy — provider where supported, else tool", () => {
  const v = validateResponseSchema(z.object({ x: z.number() }));
  it("picks provider strategy for openai/google", () => {
    expect(protocolSupportsProviderStrategy("openai")).toBe(true);
    expect(protocolSupportsProviderStrategy("google")).toBe(true);
    if (v.ok) expect(selectStrategy(v.value, "openai").kind).toBe("provider");
  });
  it("defaults to tool strategy for an unknown/router protocol", () => {
    expect(protocolSupportsProviderStrategy("anthropic")).toBe(false);
    expect(protocolSupportsProviderStrategy("auto")).toBe(false);
    if (v.ok) {
      expect(selectStrategy(v.value, "anthropic").kind).toBe("tool");
      expect(selectStrategy(v.value, "auto").kind).toBe("tool");
    }
  });
  it("builds a tool-strategy responseFormat", () => {
    if (v.ok) expect(buildToolStrategy(v.value)).toBeDefined();
  });
});

describe("validateStructuredValue", () => {
  it("validates a Zod value and rejects a non-conforming one", () => {
    const v = validateResponseSchema(z.object({ n: z.number() }));
    if (!v.ok) throw new Error("schema invalid");
    expect(validateStructuredValue(v.value, { n: 5 })).toEqual({ ok: true, value: { n: 5 } });
    expect(validateStructuredValue(v.value, { n: "x" }).ok).toBe(false);
    expect(validateStructuredValue(v.value, undefined).ok).toBe(false);
  });
  it("accepts any present object for a JSON Schema (library enforced the shape)", () => {
    const v = validateResponseSchema({ type: "object" });
    if (!v.ok) throw new Error("schema invalid");
    expect(validateStructuredValue(v.value, { any: 1 })).toEqual({ ok: true, value: { any: 1 } });
    expect(validateStructuredValue(v.value, null).ok).toBe(false);
  });
});
