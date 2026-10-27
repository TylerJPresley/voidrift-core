import { describe, it, expect } from "vitest";
import { LimitsSchema } from "./limits-schema.js";

describe("LimitsSchema: action field validation (SLICE 1)", () => {
  it("accepts bare number", () => {
    const result = LimitsSchema.safeParse({
      context: { estimateMarginTokens: 3000 },
    });
    expect(result.success).toBe(true);
    if (result.success && result.data) {
      expect((result.data as any).context?.estimateMarginTokens).toBe(3000);
    }
  });

  it("accepts {value, action} object with action: warn", () => {
    const result = LimitsSchema.safeParse({
      context: { estimateMarginTokens: { value: 3000, action: "warn" } },
    });
    expect(result.success).toBe(true);
    if (result.success && result.data) {
      expect((result.data as any).context?.estimateMarginTokens).toEqual({
        value: 3000,
        action: "warn",
      });
    }
  });

  it("accepts {value, action} object with action: deny", () => {
    const result = LimitsSchema.safeParse({
      toolRounds: { recursionMargin: { value: 10, action: "deny" } },
    });
    expect(result.success).toBe(true);
    if (result.success && result.data) {
      expect((result.data as any).toolRounds?.recursionMargin).toEqual({
        value: 10,
        action: "deny",
      });
    }
  });

  it("rejects invalid action value", () => {
    const result = LimitsSchema.safeParse({
      context: { estimateMarginTokens: { value: 3000, action: "x" } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects object without action field", () => {
    const result = LimitsSchema.safeParse({
      context: { estimateMarginTokens: { value: 3000 } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown area", () => {
    const result = LimitsSchema.safeParse({
      unknown_area: { someKey: 1000 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown key in known area", () => {
    const result = LimitsSchema.safeParse({
      context: { unknownKey: 1000 },
    });
    expect(result.success).toBe(false);
  });

  it("enforces min/max bounds", () => {
    // context.estimateMarginTokens has min: 0, max: 100_000
    const resultTooLow = LimitsSchema.safeParse({
      context: { estimateMarginTokens: -1 },
    });
    expect(resultTooLow.success).toBe(false);

    const resultTooHigh = LimitsSchema.safeParse({
      context: { estimateMarginTokens: 200_000 },
    });
    expect(resultTooHigh.success).toBe(false);
  });

  it("allows empty limits object", () => {
    const result = LimitsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success && result.data) {
      expect(result.data).toEqual({});
    }
  });

  it("allows optional fields to be absent", () => {
    const result = LimitsSchema.safeParse({
      context: {},
    });
    expect(result.success).toBe(true);
  });
});
