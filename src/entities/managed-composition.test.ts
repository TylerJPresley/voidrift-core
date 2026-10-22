/**
 * Managed-composition unit tests (core-blueprint.md §13.5).
 *
 * Clause → test map:
 *  - a managed deny cannot be loosened by a lower layer → "permission deny floor"
 *  - a managed enforcing mode cannot be dropped → "compliance.mode floor"
 *  - tightening is allowed → "tightening is legal"
 *  - no managed layer → no violations → "unmanaged"
 */
import { describe, it, expect } from "vitest";
import { validateManagedComposition, applyManagedFloor } from "./managed-composition.js";

describe("managed composition (§13.5)", () => {
  it("unmanaged: no managed layer yields no violations", () => {
    expect(validateManagedComposition(undefined, { compliance: { mode: "off" } })).toEqual([]);
  });

  it("compliance.mode floor: a lower layer cannot weaken managed enforcing", () => {
    const managed = { compliance: { mode: "enforcing" } };
    expect(validateManagedComposition(managed, { compliance: { mode: "permissive" } })).toHaveLength(1);
    expect(validateManagedComposition(managed, { compliance: { mode: "off" } })).toHaveLength(1);
    // equal or stricter is legal (enforcing is already strictest)
    expect(validateManagedComposition(managed, { compliance: { mode: "enforcing" } })).toEqual([]);
  });

  it("compliance.mode: a lower layer may tighten a managed permissive to enforcing", () => {
    const managed = { compliance: { mode: "permissive" } };
    expect(validateManagedComposition(managed, { compliance: { mode: "enforcing" } })).toEqual([]);
    expect(validateManagedComposition(managed, { compliance: { mode: "off" } })).toHaveLength(1);
  });

  it("permission deny floor: a managed deny cannot be loosened to allow/ask", () => {    const managed = {
      permissions: { r1: { tool: "execute_command", pattern: "rm *", decision: "deny", priority: 0, source: "managed" } },
    };
    const loosenAllow = {
      permissions: { r1: { tool: "execute_command", pattern: "rm *", decision: "allow", priority: 200, source: "workspace" } },
    };
    const loosenAsk = {
      permissions: { r1: { tool: "execute_command", pattern: "rm *", decision: "ask", priority: 200, source: "workspace" } },
    };
    expect(validateManagedComposition(managed, loosenAllow)).toHaveLength(1);
    expect(validateManagedComposition(managed, loosenAsk)).toHaveLength(1);
  });

  it("permission deny floor: a differently-keyed lower rule for the same tool+pattern cannot outrank a managed deny", () => {
    // The managed deny is keyed `r1`; the lower layer tries to slip past the
    // same-key guard by authoring a higher-priority allow under a DIFFERENT key
    // (`r2`) for the SAME (tool, pattern). Guardian resolves by tool+pattern and
    // highest priority wins, so this would loosen the floor — a validation error.
    const managed = {
      permissions: { r1: { tool: "execute_command", pattern: "rm *", decision: "deny", priority: 0, source: "managed" } },
    };
    const diffKeyAllow = {
      permissions: { r2: { tool: "execute_command", pattern: "rm *", decision: "allow", priority: 200, source: "workspace" } },
    };
    expect(validateManagedComposition(managed, diffKeyAllow)).toHaveLength(1);

    // ask with a higher priority also outranks the managed deny → violation.
    const diffKeyAsk = {
      permissions: { r3: { tool: "execute_command", pattern: "rm *", decision: "ask", priority: 300, source: "session" } },
    };
    expect(validateManagedComposition(managed, diffKeyAsk)).toHaveLength(1);
  });

  it("applyManagedFloor: a managed deny is re-asserted above any lower priority so it wins in Guardian", () => {
    const managed = {
      permissions: { r1: { tool: "execute_command", pattern: "rm *", decision: "deny", priority: 0, source: "managed" } },
    };
    // A predating merged document carries a differently-keyed workspace allow.
    const merged = {
      permissions: {
        r2: { tool: "execute_command", pattern: "rm *", decision: "allow", priority: 200, source: "workspace" },
      },
    };
    const out = applyManagedFloor(managed, merged) as {
      permissions: Record<string, { decision: string; priority: number }>;
    };
    // The managed deny is present and outranks the lower allow.
    const r1 = out.permissions["r1"]!;
    const r2 = out.permissions["r2"]!;
    expect(r1.decision).toBe("deny");
    expect(r1.priority).toBeGreaterThan(r2.priority);
  });

  it("applyManagedFloor: a non-deny managed rule is re-asserted when a same-key lower rule loosened it, kept when tighter", () => {
    const managed = {
      permissions: { r1: { tool: "write_file", pattern: "*.ts", decision: "ask", priority: 0, source: "managed" } },
    };
    // Lower rule loosened ask→allow for the same key → managed ask re-asserted.
    const loosened = applyManagedFloor(managed, {
      permissions: { r1: { tool: "write_file", pattern: "*.ts", decision: "allow", priority: 200, source: "workspace" } },
    }) as { permissions: Record<string, { decision: string }> };
    expect(loosened.permissions["r1"]!.decision).toBe("ask");

    // Lower rule tightened ask→deny for the same key → the tighter rule stays.
    const tightened = applyManagedFloor(managed, {
      permissions: { r1: { tool: "write_file", pattern: "*.ts", decision: "deny", priority: 200, source: "workspace" } },
    }) as { permissions: Record<string, { decision: string }> };
    expect(tightened.permissions["r1"]!.decision).toBe("deny");

    // A non-deny managed rule missing from the merged doc is added back.
    const added = applyManagedFloor(managed, { permissions: {} }) as {
      permissions: Record<string, { decision: string }>;
    };
    expect(added.permissions["r1"]!.decision).toBe("ask");
  });

  it("deny floor: two lower rules share a managed deny's (tool,pattern) — both flagged", () => {
    const managed = {
      permissions: { r1: { tool: "execute_command", pattern: "rm *", decision: "deny", priority: 0, source: "managed" } },
    };
    const twoLoosen = {
      permissions: {
        a: { tool: "execute_command", pattern: "rm *", decision: "allow", priority: 200, source: "workspace" },
        b: { tool: "execute_command", pattern: "rm *", decision: "ask", priority: 300, source: "session" },
      },
    };
    expect(validateManagedComposition(managed, twoLoosen)).toHaveLength(2);
  });

  it("permission deny floor: an unrelated or equally-strict lower rule is legal", () => {
    const managed = {
      permissions: { r1: { tool: "execute_command", decision: "deny", priority: 0, source: "managed" } },
    };
    // same key, same decision — legal
    expect(
      validateManagedComposition(managed, {
        permissions: { r1: { tool: "execute_command", decision: "deny", priority: 200, source: "workspace" } },
      }),
    ).toEqual([]);
    // different key — legal
    expect(
      validateManagedComposition(managed, {
        permissions: { r2: { tool: "write_file", decision: "allow", priority: 200, source: "workspace" } },
      }),
    ).toEqual([]);
  });
});

describe("MCP server trust is removed (decision C1.3): no floor, no re-floor", () => {
  it("a lower layer setting mcp.<server>.trust is NOT a managed-composition violation anymore", () => {
    // `trust` is no longer a permission input — `readOnlyHint` is display-only
    // and an MCP tool is always gated — so there is no trust floor to violate.
    const managed = { mcp: { acme: { trust: false } } };
    expect(validateManagedComposition(managed, { mcp: { acme: { trust: true } } })).toEqual([]);
  });

  it("applyManagedFloor does NOT re-floor an mcp trust value (it is ignored, not enforced)", () => {
    const managed = { mcp: { acme: { trust: false } } };
    const merged = { mcp: { acme: { trust: true, command: "x" } } };
    const out = applyManagedFloor(managed, merged) as { mcp: { acme: { trust?: boolean; command: string } } };
    // The merged doc passes through untouched for mcp — trust is not enforced.
    expect(out.mcp.acme.command).toBe("x");
    expect(out.mcp.acme.trust).toBe(true);
  });
});
