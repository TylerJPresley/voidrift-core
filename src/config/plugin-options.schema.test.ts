import { describe, it, expect } from "vitest";
import { PluginEntrySchema, PLUGIN_OPTIONS_MAX_BYTES } from "./schema.js";

describe("PluginEntrySchema options (§12.4)", () => {
  it("accepts a plain-JSON options object", () => {
    const r = PluginEntrySchema.safeParse({
      enabled: true,
      options: { config: { endpoint: "http://127.0.0.1:4318" }, deps: {} },
    });
    expect(r.success).toBe(true);
  });

  it("accepts an entry with no options", () => {
    const r = PluginEntrySchema.safeParse({ enabled: true });
    expect(r.success).toBe(true);
  });

  it("rejects options that exceed the 64 KiB cap", () => {
    const big = "x".repeat(PLUGIN_OPTIONS_MAX_BYTES + 1);
    const r = PluginEntrySchema.safeParse({ enabled: true, options: { blob: big } });
    expect(r.success).toBe(false);
  });

  it("rejects a non-object options value", () => {
    const r = PluginEntrySchema.safeParse({ enabled: true, options: "nope" });
    expect(r.success).toBe(false);
  });
});
