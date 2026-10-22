import { describe, it, expect } from "vitest";
import { isPermissiveLicense, isCopyleftLicense, isPluginManifest, toPluginMeta } from "./plugin-meta.js";

describe("plugin-meta license allowlist (§12.4)", () => {
  it("accepts permissive licenses", () => {
    for (const l of ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC", "0BSD", "mit"]) {
      expect(isPermissiveLicense(l)).toBe(true);
    }
  });

  it("rejects copyleft and unknown/missing licenses", () => {
    for (const l of ["GPL-3.0", "AGPL-3.0", "LGPL-2.1", "SSPL-1.0", undefined, ""]) {
      expect(isPermissiveLicense(l)).toBe(false);
    }
    expect(isCopyleftLicense("GPL-3.0")).toBe(true);
    expect(isCopyleftLicense("LGPL-2.1-only")).toBe(true);
    expect(isCopyleftLicense("MIT")).toBe(false);
  });

  it("handles SPDX OR (any passes) and AND (all pass)", () => {
    expect(isPermissiveLicense("(MIT OR GPL-3.0)")).toBe(true);
    expect(isPermissiveLicense("(GPL-3.0 OR AGPL-3.0)")).toBe(false);
    expect(isPermissiveLicense("MIT AND Apache-2.0")).toBe(true);
    expect(isPermissiveLicense("MIT AND GPL-3.0")).toBe(false);
  });

  it("detects the plugin flag and builds meta", () => {
    expect(isPluginManifest({ voidrift: { plugin: true } })).toBe(true);
    expect(isPluginManifest({ voidrift: { plugin: false } })).toBe(false);
    expect(isPluginManifest({})).toBe(false);
    const meta = toPluginMeta(
      { name: "@scope/plug", version: "1.2.3", voidrift: { plugin: true, description: "D" }, license: "MIT", author: { name: "Me" } },
      true,
    );
    expect(meta).toMatchObject({ id: "@scope/plug", name: "@scope/plug", version: "1.2.3", description: "D", license: "MIT", author: "Me", active: true });
  });

  it("tolerates a voidrift.kind field alongside the plugin flag (taxonomy)", () => {
    // Given manifests carrying the machine-readable kind (blueprint §3)
    expect(isPluginManifest({ voidrift: { kind: "plugin", plugin: true } })).toBe(true);
    expect(isPluginManifest({ voidrift: { kind: "library" } })).toBe(false);
    expect(isPluginManifest({ voidrift: { kind: "mcp-server" } })).toBe(false);
    // Then meta still derives from the plugin flag/description, ignoring kind.
    const meta = toPluginMeta(
      { name: "@scope/plug", voidrift: { kind: "plugin", plugin: true, description: "D" }, license: "MIT" },
      true,
    );
    expect(meta.description).toBe("D");
    expect(meta.active).toBe(true);
  });
});
