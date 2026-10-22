import { describe, it, expect } from "vitest";
import { CORE_VERSION } from "./index.js";

describe("scaffold", () => {
  it("exposes a version marker", () => {
    // Given the SDK entry point
    // When the version marker is read
    // Then it is a semver string
    expect(CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
