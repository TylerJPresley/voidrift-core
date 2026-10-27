import { describe, it, expect } from "vitest";
import { PluginEntrySchema } from "./schema.js";

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

  it("accepts oversized options at schema validation time (runtime check happens at plugin load)", () => {
    const big = "x".repeat(100 * 1024);
    const r = PluginEntrySchema.safeParse({ enabled: true, options: { blob: big } });
    expect(r.success).toBe(true); // Size check is now at plugin load time
  });

  it("rejects a non-object options value", () => {
    const r = PluginEntrySchema.safeParse({ enabled: true, options: "nope" });
    expect(r.success).toBe(false);
  });
});
