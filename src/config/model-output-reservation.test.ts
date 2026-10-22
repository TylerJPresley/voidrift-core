/**
 * §11.2 — a model entry's output reservation must fit inside its window: a
 * `maxOutputTokens` >= `contextLimit` leaves no room for the prompt, so every
 * request is refused before sending. The config schema rejects it naming both
 * values; `doctor` reports it as FAIL with the fix (config-doctor.test covers
 * the doctor side). Offline, deterministic — no model, no network.
 */
import { describe, it, expect } from "vitest";
import { ConfigSchema } from "./schema.js";

function cfgWith(entry: Record<string, unknown>): unknown {
  return { models: { m: { model: "x", ...entry } }, modelSelected: "m" };
}

describe("§11.2 — maxOutputTokens must be less than contextLimit", () => {
  it("rejects maxOutputTokens === contextLimit and names both values", () => {
    const res = ConfigSchema.safeParse(cfgWith({ contextLimit: 8192, maxOutputTokens: 8192 }));
    expect(res.success).toBe(false);
    if (!res.success) {
      const msg = res.error.issues.map((i) => i.message).join(" ");
      expect(msg).toContain("8192"); // both values are 8192 here
      expect(msg).toMatch(/maxOutputTokens/);
      expect(msg).toMatch(/contextLimit/);
    }
  });

  it("rejects maxOutputTokens > contextLimit naming both values", () => {
    const res = ConfigSchema.safeParse(cfgWith({ contextLimit: 4096, maxOutputTokens: 9000 }));
    expect(res.success).toBe(false);
    if (!res.success) {
      const msg = res.error.issues.map((i) => i.message).join(" ");
      expect(msg).toContain("9000");
      expect(msg).toContain("4096");
    }
  });

  it("accepts maxOutputTokens < contextLimit", () => {
    const res = ConfigSchema.safeParse(cfgWith({ contextLimit: 8192, maxOutputTokens: 2048 }));
    expect(res.success).toBe(true);
  });

  it("accepts an entry that sets neither / only one of the two", () => {
    expect(ConfigSchema.safeParse(cfgWith({})).success).toBe(true);
    expect(ConfigSchema.safeParse(cfgWith({ contextLimit: 8192 })).success).toBe(true);
    expect(ConfigSchema.safeParse(cfgWith({ maxOutputTokens: 2048 })).success).toBe(true);
  });
});
