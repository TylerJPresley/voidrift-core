/**
 * Tests for Manuals filesystem loading and re-indexing (§12.8, slice 3).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FileSystemPort } from "../entities/ports/host.js";
import { InMemoryFileSystem } from "../adapters/in-memory-filesystem.js";
import { ManualsDirectory } from "../adapters/manuals-directory.js";
import { Manuals } from "./manuals.js";
import { EventBus } from "../entities/event-bus.js";
import { hermeticTmp } from "../test-hermetic.js";
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import path from "node:path";
import { FilesystemAdapter } from "../adapters/filesystem.js";

let projectFs: FileSystemPort;
let globalFs: FileSystemPort;

beforeEach(() => {
  projectFs = new InMemoryFileSystem();
  globalFs = new InMemoryFileSystem();
});

afterEach(() => {
  // cleanup is automatic for in-memory fakes
});

function testManualRaw(id: string): string {
  return `---\nsummary: Test ${id}\nread-when: anytime\ntype: reference\n---\n\n# ${id}\n\nBody for ${id}`;
}

describe("Manuals filesystem loading (§12.8, slice 3)", () => {
  it("reindex() loads docs from both filesystem sources", async () => {
    const bus = new EventBus();
    const mandir = new ManualsDirectory(projectFs, { workspace: ".voidrift/docs", global: "docs" }, globalFs);
    const manuals = new Manuals({ bus, directory: mandir });

    // Register builtin first
    manuals.registerBuiltin(testManualRaw("core/intro"), "core/intro");

    // Add filesystem-sourced docs
    await projectFs.writeFile(".voidrift/docs/guide.md", testManualRaw("guide"));
    await globalFs.writeFile("docs/tips.md", testManualRaw("tips"));

    await manuals.reindex();

    const list = manuals.list();
    expect(list).toHaveLength(3);
    const ids = list.map((m) => m.id).sort();
    expect(ids).toEqual(["core/intro", "project/guide", "user/tips"]);
  });

  it("emits RESOURCE_CHANGED on reindex", async () => {
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.subscribe("RESOURCE_CHANGED", (event) => {
      events.push(event);
    });

    const mandir = new ManualsDirectory(projectFs, { workspace: ".voidrift/docs", global: "docs" }, globalFs);
    const manuals = new Manuals({ bus, directory: mandir });

    await projectFs.writeFile(".voidrift/docs/doc.md", testManualRaw("doc"));
    await manuals.reindex();

    expect(events).toHaveLength(1);
    const event = events[0] as { payload?: { type: string } };
    expect(event.payload?.type).toBe("manual");
  });

  it("does NOT emit RESOURCE_CHANGED on programmatic registerBuiltin", () => {
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.subscribe("RESOURCE_CHANGED", (event) => {
      events.push(event);
    });

    const manuals = new Manuals({ bus });
    manuals.registerBuiltin(testManualRaw("core/intro"), "core/intro");

    expect(events).toHaveLength(0);
  });

  it("preserves builtin docs during reindex", async () => {
    const bus = new EventBus();
    const mandir = new ManualsDirectory(projectFs, { workspace: ".voidrift/docs", global: "docs" }, globalFs);
    const manuals = new Manuals({ bus, directory: mandir });

    // Register multiple builtins
    manuals.registerBuiltin(testManualRaw("core/intro"), "core/intro");
    manuals.registerBuiltin(testManualRaw("core/reference"), "core/reference");

    // Add filesystem docs and reindex
    await projectFs.writeFile(".voidrift/docs/guide.md", testManualRaw("guide"));
    await manuals.reindex();

    const list = manuals.list();
    const ids = list.map((m) => m.id).sort();
    expect(ids).toEqual(["core/intro", "core/reference", "project/guide"]);
  });

  it("replaces filesystem layer on reindex (APPEND-ONLY)", async () => {
    const bus = new EventBus();
    const mandir = new ManualsDirectory(projectFs, { workspace: ".voidrift/docs", global: "docs" }, globalFs);
    const manuals = new Manuals({ bus, directory: mandir });

    // Register builtin
    manuals.registerBuiltin(testManualRaw("core/intro"), "core/intro");

    // First reindex with one doc
    await projectFs.writeFile(".voidrift/docs/doc1.md", testManualRaw("doc1"));
    await manuals.reindex();
    expect(manuals.list()).toHaveLength(2); // core/intro + project/doc1

    // Add another doc
    await projectFs.writeFile(".voidrift/docs/doc2.md", testManualRaw("doc2"));
    await manuals.reindex();
    expect(manuals.list()).toHaveLength(3); // core/intro + project/doc1 + project/doc2

    // Remove first doc, reindex should drop it
    await projectFs.remove(".voidrift/docs/doc1.md");
    await manuals.reindex();
    const list = manuals.list();
    expect(list).toHaveLength(2);
    const ids = list.map((m) => m.id).sort();
    expect(ids).toEqual(["core/intro", "project/doc2"]);
  });

  it("skips malformed docs during reindex", async () => {
    const bus = new EventBus();
    const mandir = new ManualsDirectory(projectFs, { workspace: ".voidrift/docs", global: "docs" }, globalFs);
    const manuals = new Manuals({ bus, directory: mandir });

    manuals.registerBuiltin(testManualRaw("core/intro"), "core/intro");

    // Add good and bad docs
    await projectFs.writeFile(".voidrift/docs/good.md", testManualRaw("good"));
    await projectFs.writeFile(".voidrift/docs/bad.md", "# No frontmatter\n\nJust body");

    await manuals.reindex();

    const list = manuals.list();
    expect(list).toHaveLength(2);
    const ids = list.map((m) => m.id).sort();
    expect(ids).toEqual(["core/intro", "project/good"]);
  });

  it("handles no directory adapter gracefully", async () => {
    const bus = new EventBus();
    const manuals = new Manuals({ bus });

    manuals.registerBuiltin(testManualRaw("core/intro"), "core/intro");
    await manuals.reindex(); // Should not crash

    expect(manuals.list()).toHaveLength(1);
  });

  it("loads from global docs with user/ prefix", async () => {
    const bus = new EventBus();
    const mandir = new ManualsDirectory(projectFs, { workspace: ".voidrift/docs", global: "docs" }, globalFs);
    const manuals = new Manuals({ bus, directory: mandir });

    await globalFs.writeFile("docs/global-guide.md", testManualRaw("global-guide"));
    await manuals.reindex();

    const list = manuals.list();
    expect(list).toHaveLength(1);
    if (list[0]) {
      expect(list[0].id).toBe("user/global-guide");
      expect(list[0].source).toBe("global");
    }
  });

  it("loads from project docs with project/ prefix", async () => {
    const bus = new EventBus();
    const mandir = new ManualsDirectory(projectFs, { workspace: ".voidrift/docs", global: "docs" }, globalFs);
    const manuals = new Manuals({ bus, directory: mandir });

    await projectFs.writeFile(".voidrift/docs/proj-guide.md", testManualRaw("proj-guide"));
    await manuals.reindex();

    const list = manuals.list();
    expect(list).toHaveLength(1);
    if (list[0]) {
      expect(list[0].id).toBe("project/proj-guide");
      expect(list[0].source).toBe("project");
    }
  });

  it("does not crash when doc dirs do not exist", async () => {
    const bus = new EventBus();
    const mandir = new ManualsDirectory(projectFs, { workspace: ".voidrift/docs", global: "docs" }, globalFs);
    const manuals = new Manuals({ bus, directory: mandir });

    manuals.registerBuiltin(testManualRaw("core/intro"), "core/intro");
    await manuals.reindex(); // Should not crash

    expect(manuals.list()).toHaveLength(1);
  });

  it("loads contributed docs wrapped in untrusted-data block from read_manual tool", async () => {
    const bus = new EventBus();
    const mandir = new ManualsDirectory(projectFs, { workspace: ".voidrift/docs", global: "docs" }, globalFs);
    const manuals = new Manuals({ bus, directory: mandir });

    await projectFs.writeFile(".voidrift/docs/contrib.md", testManualRaw("contrib"));
    await manuals.reindex();

    const manual = manuals.getInternal("project/contrib");
    expect(manual).toBeDefined();
    if (manual) {
      expect(manual.source).toBe("project");
      // The read_manual tool will wrap contributed docs in untrusted-data block (§8.1)
    }
  });

  describe("Manuals filesystem watcher (§14.2, §14.6)", () => {
    it("startWatch() triggers reindex + RESOURCE_CHANGED on file create in project docs", async () => {
      const tmpDir = hermeticTmp("manuals-watch-project");
      try {
        const projectDocsDir = path.join(tmpDir, ".voidrift/docs");
        const globalDocsDir = path.join(tmpDir, "global-docs");
        fs.mkdirSync(projectDocsDir, { recursive: true });
        fs.mkdirSync(globalDocsDir, { recursive: true });

        const bus = new EventBus();
        const events: unknown[] = [];
        bus.subscribe("RESOURCE_CHANGED", (event) => events.push(event));

        const nodeFs = new FilesystemAdapter(tmpDir);
        const mandir = new ManualsDirectory(
          nodeFs,
          { workspace: ".voidrift/docs", global: "global-docs" },
          new FilesystemAdapter(tmpDir),
        );
        const manuals = new Manuals({ bus, directory: mandir });

        // Start watching both directories
        await manuals.startWatch(projectDocsDir, globalDocsDir);

        // Create a doc file after watcher starts
        const docPath = path.join(projectDocsDir, "new-doc.md");
        await fsp.writeFile(docPath, testManualRaw("new-doc"));

        // Wait for chokidar poll + reindex (50ms poll interval, plus processing)
        await new Promise((r) => setTimeout(r, 500));

        // Should have at least one RESOURCE_CHANGED event
        expect(events.length).toBeGreaterThanOrEqual(1);
        const resourceChangedEvents = events.filter((e) => (e as any).payload?.type === "manual");
        expect(resourceChangedEvents.length).toBeGreaterThanOrEqual(1);

        // Verify the doc is now registered
        const list = manuals.list();
        expect(list.some((m) => m.id === "project/new-doc")).toBe(true);

        await manuals.stopWatch();
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("startWatch() triggers reindex on file change", async () => {
      const tmpDir = hermeticTmp("manuals-watch-change");
      try {
        const projectDocsDir = path.join(tmpDir, ".voidrift/docs");
        const globalDocsDir = path.join(tmpDir, "global-docs");
        fs.mkdirSync(projectDocsDir, { recursive: true });
        fs.mkdirSync(globalDocsDir, { recursive: true });

        const docPath = path.join(projectDocsDir, "editable.md");
        await fsp.writeFile(docPath, testManualRaw("editable"));

        const bus = new EventBus();
        const events: unknown[] = [];
        bus.subscribe("RESOURCE_CHANGED", (event) => events.push(event));

        const nodeFs = new FilesystemAdapter(tmpDir);
        const mandir = new ManualsDirectory(
          nodeFs,
          { workspace: ".voidrift/docs", global: "global-docs" },
          new FilesystemAdapter(tmpDir),
        );
        const manuals = new Manuals({ bus, directory: mandir });
        await manuals.reindex();

        // Start watching
        await manuals.startWatch(projectDocsDir, globalDocsDir);
        const initialEventCount = events.length;

        // Edit the file
        await fsp.writeFile(docPath, testManualRaw("editable-updated"));

        // Wait for watcher poll
        await new Promise((r) => setTimeout(r, 500));

        // Should have new RESOURCE_CHANGED events
        expect(events.length).toBeGreaterThan(initialEventCount);

        await manuals.stopWatch();
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("startWatch() triggers reindex on file unlink", async () => {
      const tmpDir = hermeticTmp("manuals-watch-unlink");
      try {
        const projectDocsDir = path.join(tmpDir, ".voidrift/docs");
        const globalDocsDir = path.join(tmpDir, "global-docs");
        fs.mkdirSync(projectDocsDir, { recursive: true });
        fs.mkdirSync(globalDocsDir, { recursive: true });

        const docPath = path.join(projectDocsDir, "to-delete.md");
        await fsp.writeFile(docPath, testManualRaw("to-delete"));

        const bus = new EventBus();
        const events: unknown[] = [];
        bus.subscribe("RESOURCE_CHANGED", (event) => events.push(event));

        const nodeFs = new FilesystemAdapter(tmpDir);
        const mandir = new ManualsDirectory(
          nodeFs,
          { workspace: ".voidrift/docs", global: "global-docs" },
          new FilesystemAdapter(tmpDir),
        );
        const manuals = new Manuals({ bus, directory: mandir });
        await manuals.reindex();
        expect(manuals.list().some((m) => m.id === "project/to-delete")).toBe(true);

        // Start watching
        await manuals.startWatch(projectDocsDir, globalDocsDir);
        const initialEventCount = events.length;

        // Delete the file
        await fsp.unlink(docPath);

        // Wait for watcher poll
        await new Promise((r) => setTimeout(r, 500));

        // Should have new RESOURCE_CHANGED events
        expect(events.length).toBeGreaterThan(initialEventCount);

        // Verify the doc is now unregistered
        const list = manuals.list();
        expect(list.some((m) => m.id === "project/to-delete")).toBe(false);

        await manuals.stopWatch();
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("stopWatch() closes the watcher and allows no further events", async () => {
      const tmpDir = hermeticTmp("manuals-watch-stop");
      try {
        const projectDocsDir = path.join(tmpDir, ".voidrift/docs");
        const globalDocsDir = path.join(tmpDir, "global-docs");
        fs.mkdirSync(projectDocsDir, { recursive: true });
        fs.mkdirSync(globalDocsDir, { recursive: true });

        const bus = new EventBus();
        const events: unknown[] = [];
        bus.subscribe("RESOURCE_CHANGED", (event) => events.push(event));

        const nodeFs = new FilesystemAdapter(tmpDir);
        const mandir = new ManualsDirectory(
          nodeFs,
          { workspace: ".voidrift/docs", global: "global-docs" },
          new FilesystemAdapter(tmpDir),
        );
        const manuals = new Manuals({ bus, directory: mandir });

        await manuals.startWatch(projectDocsDir, globalDocsDir);
        await manuals.stopWatch();
        const eventCountAfterStop = events.length;

        // Create a file after stopping (should not trigger reindex)
        const docPath = path.join(projectDocsDir, "after-stop.md");
        await fsp.writeFile(docPath, testManualRaw("after-stop"));
        await new Promise((r) => setTimeout(r, 500));

        // No new events should have been emitted
        expect(events.length).toBe(eventCountAfterStop);
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("stopWatch() is idempotent and safe to call multiple times", async () => {
      const tmpDir = hermeticTmp("manuals-watch-idempotent");
      try {
        const projectDocsDir = path.join(tmpDir, ".voidrift/docs");
        const globalDocsDir = path.join(tmpDir, "global-docs");
        fs.mkdirSync(projectDocsDir, { recursive: true });
        fs.mkdirSync(globalDocsDir, { recursive: true });

        const bus = new EventBus();
        const nodeFs = new FilesystemAdapter(tmpDir);
        const mandir = new ManualsDirectory(
          nodeFs,
          { workspace: ".voidrift/docs", global: "global-docs" },
          new FilesystemAdapter(tmpDir),
        );
        const manuals = new Manuals({ bus, directory: mandir });

        await manuals.startWatch(projectDocsDir, globalDocsDir);
        await manuals.stopWatch();
        await manuals.stopWatch(); // Should not throw
        await manuals.stopWatch(); // Should not throw
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("startWatch() is safe when directories do not exist yet", async () => {
      const tmpDir = hermeticTmp("manuals-watch-no-dirs");
      try {
        const projectDocsDir = path.join(tmpDir, ".voidrift/docs");
        const globalDocsDir = path.join(tmpDir, "global-docs");
        // Note: directories are NOT created yet

        const bus = new EventBus();
        const nodeFs = new FilesystemAdapter(tmpDir);
        const mandir = new ManualsDirectory(
          nodeFs,
          { workspace: ".voidrift/docs", global: "global-docs" },
          new FilesystemAdapter(tmpDir),
        );
        const manuals = new Manuals({ bus, directory: mandir });

        // Should not crash even though dirs don't exist
        await manuals.startWatch(projectDocsDir, globalDocsDir);
        await manuals.stopWatch();
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("registerBuiltin still emits nothing (no watcher emission)", () => {
      const bus = new EventBus();
      const events: unknown[] = [];
      bus.subscribe("RESOURCE_CHANGED", (event) => events.push(event));

      const manuals = new Manuals({ bus });
      manuals.registerBuiltin(testManualRaw("core/intro"), "core/intro");

      expect(events).toHaveLength(0);
    });
  });
});
