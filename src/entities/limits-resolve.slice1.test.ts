import { describe, it, expect } from "vitest";
import { resolveLimits } from "./limits-resolve.js";
import { LIMITS } from "./limits.js";

describe("resolveLimits: action cascading (SLICE 1)", () => {
  it("bare number keeps default action from registry", () => {
    const spec = LIMITS.find((l) => l.key === "context.estimateMarginTokens")!;
    expect(spec.action).toBe("warn");

    const result = resolveLimits([
      {
        layer: "global",
        limits: { context: { estimateMarginTokens: 3000 } },
      },
    ]);

    const resolved = result.values.get("context.estimateMarginTokens")!;
    expect(resolved.value).toBe(3000);
    expect(resolved.action).toBe("warn");
  });

  it("object form value is used", () => {
    const result = resolveLimits([
      {
        layer: "global",
        limits: { context: { estimateMarginTokens: { value: 3000, action: "warn" } } },
      },
    ]);

    const resolved = result.values.get("context.estimateMarginTokens")!;
    expect(resolved.value).toBe(3000);
  });

  it("object form action overrides the registry action", () => {
    // Find a limit with warn action (default)
    const spec = LIMITS.find((l) => l.key === "context.estimateMarginTokens")!;
    expect(spec.action).toBe("warn");

    const result = resolveLimits([
      {
        layer: "global",
        limits: { context: { estimateMarginTokens: { value: 3000, action: "deny" } } },
      },
    ]);

    const resolved = result.values.get("context.estimateMarginTokens")!;
    expect(resolved.value).toBe(3000);
    expect(resolved.action).toBe("deny");
  });

  it("project action beats global action (action cascades like value)", () => {
    const result = resolveLimits([
      {
        layer: "global",
        limits: { context: { estimateMarginTokens: { value: 2000, action: "warn" } } },
      },
      {
        layer: "project",
        limits: { context: { estimateMarginTokens: { value: 2500, action: "deny" } } },
      },
    ]);

    const resolved = result.values.get("context.estimateMarginTokens")!;
    expect(resolved.value).toBe(2500);
    expect(resolved.action).toBe("deny");
    expect(resolved.source).toBe("project");
  });

  it("bare number keeps registry action (no layer sets action explicitly)", () => {
    const result = resolveLimits([
      {
        layer: "global",
        limits: { context: { estimateMarginTokens: 2000 } },
      },
      {
        layer: "project",
        limits: { context: { estimateMarginTokens: 2500 } },
      },
    ]);

    const resolved = result.values.get("context.estimateMarginTokens")!;
    expect(resolved.value).toBe(2500);
    expect(resolved.source).toBe("project");
    expect(resolved.action).toBe("warn"); // registry default
  });

  it("project object-form raise of safety key VALUE is ignored with warning but ACTION still applies", () => {
    // Use tools.imageMaxBytes which is a known safety limit
    const spec = LIMITS.find((l) => l.key === "tools.imageMaxBytes")!;
    const specDefault = spec.default;

    const result = resolveLimits([
      {
        layer: "global",
        limits: { tools: { imageMaxBytes: specDefault } },
      },
      {
        layer: "project",
        limits: {
          tools: {
            imageMaxBytes: {
              value: specDefault + 1000, // RAISE it (should be ignored)
              action: "deny", // but set action to deny
            },
          },
        },
      },
    ]);

    const resolved = result.values.get("tools.imageMaxBytes")!;
    // Value stays at global (raise was ignored)
    expect(resolved.value).toBe(specDefault);
    expect(resolved.source).toBe("global");
    // But action from project DOES apply (not bound by class rule)
    expect(resolved.action).toBe("deny");
    // Check that warning was recorded for the value
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]!.key).toBe("tools.imageMaxBytes");
  });

  it("session layer action overrides project action (narrowest layer wins)", () => {
    const result = resolveLimits([
      {
        layer: "global",
        limits: { context: { estimateMarginTokens: { value: 2000, action: "warn" } } },
      },
      {
        layer: "project",
        limits: { context: { estimateMarginTokens: { value: 2500, action: "deny" } } },
      },
      {
        layer: "session",
        limits: { context: { estimateMarginTokens: { value: 2300, action: "warn" } } },
      },
    ]);

    const resolved = result.values.get("context.estimateMarginTokens")!;
    expect(resolved.value).toBe(2300);
    expect(resolved.action).toBe("warn");
    expect(resolved.source).toBe("session");
  });

  it("action from registry default when no layer sets it", () => {
    const spec = LIMITS.find((l) => l.key === "context.defaultOutputReservation")!;
    const result = resolveLimits([]);

    const resolved = result.values.get("context.defaultOutputReservation")!;
    expect(resolved.value).toBe(spec.default);
    expect(resolved.action).toBe(spec.action);
    expect(resolved.source).toBe("default");
  });
});
