/**
 * Memory store adapters (core-blueprint.md §6.1) — the in-memory test default
 * and the filesystem-backed default over an in-memory FileSystemPort.
 */
import { describe, it, expect } from "vitest";
import { InMemoryMemoryStore } from "./in-memory-memory-store.js";
import { FilesystemMemoryStore } from "./filesystem-memory-store.js";
import { InMemoryFileSystem } from "../in-memory-filesystem.js";
import type { MemoryStore } from "../../entities/ports/memory-store.js";

function suite(name: string, make: () => MemoryStore) {
  describe(name, () => {
    it("put/get/list/search/delete over a namespace", async () => {
      const store = make();
      const ns = ["memory", "workspace"];
      await store.put(ns, "a", { markdown: "---\nid: a\ntitle: A\ntype: note\nscope: workspace\nkeywords: []\n---\nalpha body" });
      await store.put(ns, "b", { markdown: "---\nid: b\ntitle: B\ntype: note\nscope: workspace\nkeywords: []\n---\nbeta body" });

      const got = await store.get(ns, "a");
      expect(String(got?.value["markdown"])).toContain("alpha body");

      const list = await store.list(ns);
      expect(list.map((i) => i.key).sort()).toEqual(["a", "b"]);

      const found = await store.search(ns, "beta");
      expect(found.map((i) => i.key)).toEqual(["b"]);

      await store.delete(ns, "a");
      expect(await store.get(ns, "a")).toBeNull();
    });

    it("returns null for an unknown key and an empty list for an empty namespace", async () => {
      const store = make();
      expect(await store.get(["memory", "global"], "nope")).toBeNull();
      expect(await store.list(["memory", "global"])).toEqual([]);
    });
  });
}

suite("§6.1 — InMemoryMemoryStore", () => new InMemoryMemoryStore());
suite("§6.1 — FilesystemMemoryStore", () =>
  new FilesystemMemoryStore(new InMemoryFileSystem(), { workspace: ".voidrift/memory", global: "/g/memory" }),
);

describe("§6.1 — FilesystemMemoryStore scope routing", () => {
  it("routes the global namespace to the global directory", async () => {
    const fs = new InMemoryFileSystem();
    const store = new FilesystemMemoryStore(fs, { workspace: ".voidrift/memory", global: "g/memory" });
    await store.put(["memory", "global"], "x", { markdown: "data" });
    expect(await fs.exists("g/memory/x.md")).toBe(true);
    expect(await fs.exists(".voidrift/memory/x.md")).toBe(false);
  });
});
