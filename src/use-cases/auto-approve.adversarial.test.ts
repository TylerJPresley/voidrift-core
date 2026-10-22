/**
 * auto_approve — adversarial: nobody but the host at construction can enable
 * it (core-blueprint.md §2.5, §9.5, §13.5).
 *
 * Proves a hostile model, plugin, project config, session default, send
 * request, or environment variable CANNOT turn the mode on, and that the
 * managed layer can forbid it so `createCore` fails with a typed CoreError.
 */
import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../config/schema.js";
import { ManagedLayer } from "../use-cases/managed-layer.js";
import type { FileSystemPort } from "../entities/ports/host.js";

/** A FileSystemPort stub that returns a fixed managed document. */
function fsReturning(doc: string): FileSystemPort {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { readFile: async () => doc } as any;
}

describe("auto_approve — not representable in config at any layer (§2.5)", () => {
  it("the strict ConfigSchema REJECTS a stray `autoApprove` key", () => {
    const r = ConfigSchema.safeParse({ autoApprove: true });
    expect(r.success).toBe(false);
  });

  it("the strict ConfigSchema REJECTS a stray `autoApproveAllowed` key (managed-only, not normal config)", () => {
    const r = ConfigSchema.safeParse({ autoApproveAllowed: false });
    expect(r.success).toBe(false);
  });

  it("REJECTS `autoApprove` nested inside a model entry pass-through pocket is still a top-level strict failure when at root", () => {
    // A model entry is a loose pocket, but a top-level `autoApprove` is rejected.
    const r = ConfigSchema.safeParse({
      models: { local: { model: "x", autoApprove: true } }, // loose pocket: allowed on the entry
      autoApprove: true, // top level: rejected
    });
    expect(r.success).toBe(false);
  });

  it("there is NO ApprovalMode value `auto_approve` representable as a session/request mode", () => {
    // The session/request approval mode union is interactive|policy_only|out_of_band.
    // A config document that tried to carry it anywhere is a strict failure above;
    // the mode is a CoreOptions boolean only, never a string mode on the wire.
    const r = ConfigSchema.safeParse({ approvalMode: "auto_approve" });
    expect(r.success).toBe(false);
  });
});

describe("auto_approve — the managed layer owns autoApproveAllowed (§13.5)", () => {
  const noop = (): void => {};

  it("managed `autoApproveAllowed: false` is captured and stripped (schema still validates)", async () => {
    const ml = new ManagedLayer({
      source: "/managed.json",
      fs: fsReturning(JSON.stringify({ autoApproveAllowed: false, compliance: { mode: "enforcing" } })),
      installManagedDoc: async () => {},
      emitStatus: noop,
    });
    const status = await ml.resolve();
    expect(status.status).toBe("ok"); // the stray key did NOT fail validation
    expect(ml.autoApproveAllowed()).toBe(false);
  });

  it("managed `autoApproveAllowed: true` leaves the mode available", async () => {
    const ml = new ManagedLayer({
      source: "/managed.json",
      fs: fsReturning(JSON.stringify({ autoApproveAllowed: true })),
      installManagedDoc: async () => {},
      emitStatus: noop,
    });
    await ml.resolve();
    expect(ml.autoApproveAllowed()).toBe(true);
  });

  it("an unmanaged deployment permits the mode (default true)", async () => {
    const ml = new ManagedLayer({ fs: fsReturning("{}"), installManagedDoc: async () => {}, emitStatus: noop });
    await ml.resolve();
    expect(ml.autoApproveAllowed()).toBe(true);
  });

  it("the installed managed doc never carries autoApproveAllowed (it is stripped before install)", async () => {
    let installed: Record<string, unknown> | null = null;
    const ml = new ManagedLayer({
      source: "/m.json",
      fs: fsReturning(JSON.stringify({ autoApproveAllowed: false, logLevel: "verbose" })),
      installManagedDoc: async (doc) => {
        installed = doc;
      },
      emitStatus: noop,
    });
    await ml.resolve();
    expect(installed).not.toBeNull();
    expect(installed!).not.toHaveProperty("autoApproveAllowed");
    expect(installed!["logLevel"]).toBe("verbose");
  });
});
