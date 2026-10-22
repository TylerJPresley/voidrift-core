/**
 * Filesystem MCP pin store adapter tests (core-blueprint.md §8.4).
 *
 * The adapter delegates to the ONE `writeFileAtomic` containment chokepoint
 * (temp-then-rename, mode 0600, dir 0700, workspace-contained — proven in
 * filesystem.test.ts); here we assert the round-trip, the requested mode, the
 * fixed path, and that a corrupt/absent file fails closed (no approvals).
 */
import { describe, it, expect } from "vitest";
import { InMemoryFileSystem } from "./in-memory-filesystem.js";
import { FilesystemMcpPinStore, MCP_PINS_PATH } from "./mcp-pin-store.js";

describe("§8.4 — FilesystemMcpPinStore", () => {
  it("round-trips a pin record at .voidrift/mcp-pins.json with mode 0600", async () => {
    const fs = new InMemoryFileSystem();
    const store = new FilesystemMcpPinStore(fs);
    const record = { servers: { acme: { tools: { lookup: { hash: "abc", status: "approved" as const } } } } };
    await store.save(record);
    expect(MCP_PINS_PATH).toBe(".voidrift/mcp-pins.json");
    expect(fs.modes.get(MCP_PINS_PATH)).toBe(0o600);
    const loaded = await store.load();
    expect(loaded).toEqual(record);
  });

  it("returns an empty record when the file is absent (fail-closed: no approvals)", async () => {
    const store = new FilesystemMcpPinStore(new InMemoryFileSystem());
    expect(await store.load()).toEqual({ servers: {} });
  });

  it("returns an empty record when the file is corrupt (never throws)", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile(MCP_PINS_PATH, "{ not json");
    const store = new FilesystemMcpPinStore(fs);
    expect(await store.load()).toEqual({ servers: {} });
  });

  it("treats a non-object document as empty (fail-closed)", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeFile(MCP_PINS_PATH, JSON.stringify([1, 2, 3]));
    const store = new FilesystemMcpPinStore(fs);
    expect(await store.load()).toEqual({ servers: {} });
  });
});
