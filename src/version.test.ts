import { describe, it, expect } from "vitest";
import { coreVersion } from "./version.js";
import { mcpClientInfo } from "./adapters/mcp-connection.js";

describe("version system", () => {
  it("coreVersion() equals the version in package.json", () => {
    // The version should be read from package.json and cached.
    // For the test environment, this should match the package.json version.
    const version = coreVersion();
    expect(version).toBe("0.1.0");
    expect(version).not.toBe("0.0.0");
  });

  it("CORE_VERSION exported from index.ts equals coreVersion()", async () => {
    // Import the exported constant to verify it matches the function
    const { CORE_VERSION } = await import("./index.js");
    expect(CORE_VERSION).toBe(coreVersion());
    expect(CORE_VERSION).toBe("0.1.0");
  });

  it("mcpClientInfo(name) returns { name: 'voidrift:x', version: coreVersion() }", () => {
    const info = mcpClientInfo("test");
    expect(info).toEqual({
      name: "voidrift:test",
      version: coreVersion(),
    });
    expect(info.version).toBe("0.1.0");
  });
});
