/**
 * ManagedLayer resolver unit tests (core-blueprint.md §13.5).
 *
 * Clause → test map:
 *  - unmanaged → status none, gate open → "unmanaged"
 *  - valid source → status ok, document installed, MANAGED_LAYER_STATUS emitted,
 *    gate open → "valid"
 *  - unreadable source → status unavailable, gate closed, event emitted
 *    → "unavailable"
 *  - invalid JSON / schema → status invalid, gate closed → "invalid"
 *  - recovery: unavailable → ok re-opens the gate and re-emits → "recovery"
 */
import { describe, it, expect } from "vitest";
import { ManagedLayer, type ManagedStatus } from "./managed-layer.js";
import type { FileSystemPort } from "../entities/ports/host.js";

function fsWith(files: Record<string, string>): FileSystemPort {
  return {
    readFile: async (p) => {
      if (p in files) return files[p]!;
      throw new Error(`ENOENT: ${p}`);
    },
    readBinary: async () => new Uint8Array(),
    writeFile: async () => undefined,
    writeFileAtomic: async () => undefined,
    exists: async (p) => p in files,
    remove: async () => undefined,
    removeDir: async () => undefined,
    rename: async () => undefined,
    glob: async () => [],
    search: async () => [],
  };
}

function harness(source: string | undefined, files: Record<string, string>) {
  const emitted: ManagedStatus[] = [];
  const installed: (Record<string, unknown> | null)[] = [];
  const ml = new ManagedLayer({
    ...(source ? { source } : {}),
    fs: fsWith(files),
    installManagedDoc: async (doc) => void installed.push(doc),
    emitStatus: (p) => void emitted.push(p),
  });
  return { ml, emitted, installed };
}

describe("ManagedLayer (§13.5)", () => {
  it("unmanaged: status none and the gate is open; no event", async () => {
    const { ml, emitted } = harness(undefined, {});
    const s = await ml.resolve();
    expect(s.status).toBe("none");
    expect(ml.gate()).toBeNull();
    expect(emitted).toHaveLength(0);
  });

  it("valid: status ok, document installed, event emitted, gate open", async () => {
    const doc = JSON.stringify({ compliance: { mode: "enforcing" } });
    const { ml, emitted, installed } = harness("/etc/voidrift/managed.json", { "/etc/voidrift/managed.json": doc });
    const s = await ml.resolve();
    expect(s.status).toBe("ok");
    expect(ml.gate()).toBeNull();
    expect(installed[0]).toMatchObject({ compliance: { mode: "enforcing" } });
    expect(emitted).toEqual([{ status: "ok", source: "/etc/voidrift/managed.json" }]);
  });

  it("unavailable: an unreadable source fails closed with a reason and emits", async () => {
    const { ml, emitted } = harness("/etc/voidrift/managed.json", {});
    const s = await ml.resolve();
    expect(s.status).toBe("unavailable");
    expect(ml.gate()?.reason).toContain("unreadable");
    expect(emitted[0]!.status).toBe("unavailable");
  });

  it("invalid: non-JSON or schema-invalid source fails closed as invalid", async () => {
    const bad = harness("/m.json", { "/m.json": "not json {" });
    expect((await bad.ml.resolve()).status).toBe("invalid");
    expect(bad.ml.gate()).not.toBeNull();

    const badSchema = harness("/m.json", { "/m.json": JSON.stringify({ compliance: { mode: "nonsense" } }) });
    const s = await badSchema.ml.resolve();
    expect(s.status).toBe("invalid");
    expect(s.reason).toContain("invalid");
  });

  it("recovery: unavailable → ok re-opens the gate and re-emits", async () => {
    // First resolve with a missing file, then make it available and re-resolve.
    const files: Record<string, string> = {};
    const emitted: ManagedStatus[] = [];
    const ml = new ManagedLayer({
      source: "/m.json",
      fs: fsWith(files),
      installManagedDoc: async () => undefined,
      emitStatus: (p) => void emitted.push(p),
    });
    expect((await ml.resolve()).status).toBe("unavailable");
    expect(ml.gate()).not.toBeNull();
    files["/m.json"] = JSON.stringify({ compliance: { mode: "enforcing" } });
    expect((await ml.resolve()).status).toBe("ok");
    expect(ml.gate()).toBeNull();
    expect(emitted.map((e) => e.status)).toEqual(["unavailable", "ok"]);
  });
});
