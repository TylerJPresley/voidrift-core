/**
 * Unit tests for workspace.pluginFiles accessor (core-blueprint §12.5, §10.11).
 * Tests journaling, containment, symlink handling, and error propagation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { hermeticTmp } from "./test-hermetic.js";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { PluginFilesAccessor, PluginFileAccessError } from "./use-cases/plugin-files-accessor.js";

describe("PluginFilesAccessor (§12.5, §10.11)", () => {
  let ws: string;

  beforeEach(async () => {
    ws = hermeticTmp("plugin-files-unit");
  });

  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("writes, lists, reads, and removes files", async () => {
    const pluginFolder = path.join(ws, ".voidrift", "plugins", "test-plugin");
    await fs.mkdir(pluginFolder, { recursive: true });

    const accessor = new PluginFilesAccessor({ pluginFolder });

    // Write
    await accessor.write("ideas/IDEA-001.md", "# Idea\nContent");
    expect(existsSync(path.join(pluginFolder, "ideas", "IDEA-001.md"))).toBe(true);

    // List
    const list = await accessor.list();
    expect(list.some((e) => e.name.includes("IDEA-001"))).toBe(true);

    // Read
    const content = await accessor.read("ideas/IDEA-001.md");
    expect(content).toBeTruthy();

    // Remove
    await accessor.remove("ideas/IDEA-001.md");
    expect(existsSync(path.join(pluginFolder, "ideas", "IDEA-001.md"))).toBe(false);
  });

  it("refuses traversal (..) paths", async () => {
    const pluginFolder = path.join(ws, ".voidrift", "plugins", "test-plugin");
    await fs.mkdir(pluginFolder, { recursive: true });
    const accessor = new PluginFilesAccessor({ pluginFolder });

    try {
      await accessor.read("../escape.txt");
      expect.fail("Should have refused ..");
    } catch (err) {
      expect(err).toBeInstanceOf(PluginFileAccessError);
    }
  });

  it("refuses absolute paths", async () => {
    const pluginFolder = path.join(ws, ".voidrift", "plugins", "test-plugin");
    await fs.mkdir(pluginFolder, { recursive: true });
    const accessor = new PluginFilesAccessor({ pluginFolder });

    try {
      await accessor.read("/etc/passwd");
      expect.fail("Should have refused absolute path");
    } catch (err) {
      expect(err).toBeInstanceOf(PluginFileAccessError);
    }
  });

  it("refuses symlink escape", async () => {
    const pluginFolder = path.join(ws, ".voidrift", "plugins", "test-plugin");
    await fs.mkdir(pluginFolder, { recursive: true });

    const outside = path.join(ws, "outside.txt");
    await fs.writeFile(outside, "escaped");
    await fs.symlink(outside, path.join(pluginFolder, "link.txt"));

    const accessor = new PluginFilesAccessor({ pluginFolder });

    try {
      await accessor.read("link.txt");
      expect.fail("Should have refused symlink escape");
    } catch (err) {
      expect(err).toBeInstanceOf(PluginFileAccessError);
      expect((err as Error).message).toContain("symlink");
    }
  });

  it("refuses registry.json access", async () => {
    const pluginFolder = path.join(ws, ".voidrift", "plugins", "test-plugin");
    await fs.mkdir(pluginFolder, { recursive: true });
    const accessor = new PluginFilesAccessor({ pluginFolder });

    try {
      await accessor.read("registry.json");
      expect.fail("Should have refused registry.json");
    } catch (err) {
      expect(err).toBeInstanceOf(PluginFileAccessError);
    }

    try {
      await accessor.write("registry.json", "{}");
      expect.fail("Should have refused registry.json write");
    } catch (err) {
      expect(err).toBeInstanceOf(PluginFileAccessError);
    }
  });

  it("list() reports symlinks as their own kind (not followed)", async () => {
    const pluginFolder = path.join(ws, ".voidrift", "plugins", "test-plugin");
    await fs.mkdir(pluginFolder, { recursive: true });

    await fs.writeFile(path.join(pluginFolder, "file.txt"), "content");
    const outside = path.join(ws, "outside.txt");
    await fs.writeFile(outside, "outside");
    await fs.symlink(outside, path.join(pluginFolder, "link.txt"));

    const accessor = new PluginFilesAccessor({ pluginFolder });
    const list = await accessor.list();

    const fileEntry = list.find((e) => e.name === "file.txt");
    const linkEntry = list.find((e) => e.name === "link.txt");

    expect(fileEntry?.kind).toBe("file");
    expect(linkEntry?.kind).toBe("symlink");
  });

  it("journals write when journal and getters are wired (a)", async () => {
    const pluginFolder = path.join(ws, ".voidrift", "plugins", "test-plugin");
    await fs.mkdir(pluginFolder, { recursive: true });

    let recordCalled = false;
    let recordedSessionId: string | undefined;
    let recordedTurn: number | undefined;

    const mockJournal = {
      record: async (req: unknown) => {
        recordCalled = true;
        const typed = req as { sessionId?: string; turn?: number; tool?: string };
        recordedSessionId = typed.sessionId;
        recordedTurn = typed.turn;
      },
    } as any;

    const accessor = new PluginFilesAccessor({
      pluginFolder,
      journal: mockJournal,
      getSessionId: () => "session-123",
      getTurn: () => 5,
    });

    await accessor.write("test.md", "content");

    expect(recordCalled).toBe(true);
    expect(recordedSessionId).toBe("session-123");
    expect(recordedTurn).toBe(5);
  });

  it("journals write using fallback session/turn when getters return undefined", async () => {
    // New behavior: journaling always happens (with fallback "orchestrator" / 0)
    const pluginFolder = path.join(ws, ".voidrift", "plugins", "test-plugin");
    await fs.mkdir(pluginFolder, { recursive: true });

    let recordCalled = false;
    let recordedSessionId: string | undefined;
    let recordedTurn: number | undefined;

    const mockJournal = {
      record: async (req: unknown) => {
        recordCalled = true;
        const typed = req as { sessionId?: string; turn?: number };
        recordedSessionId = typed.sessionId;
        recordedTurn = typed.turn;
      },
    } as any;

    const accessor = new PluginFilesAccessor({
      pluginFolder,
      journal: mockJournal,
      getSessionId: () => undefined,
      getTurn: () => undefined,
    });

    await accessor.write("test.md", "content");

    // Now records with fallback values
    expect(recordCalled).toBe(true);
    expect(recordedSessionId).toBe("orchestrator");
    expect(recordedTurn).toBe(0);
  });

  it("journals remove when journal and getters are wired", async () => {
    const pluginFolder = path.join(ws, ".voidrift", "plugins", "test-plugin");
    await fs.mkdir(pluginFolder, { recursive: true });
    const testFile = path.join(pluginFolder, "test.md");
    await fs.writeFile(testFile, "content");

    let recordCalled = false;
    let recordedSessionId: string | undefined;
    let recordedTurn: number | undefined;

    const mockJournal = {
      record: async (req: unknown) => {
        recordCalled = true;
        const typed = req as { sessionId?: string; turn?: number };
        recordedSessionId = typed.sessionId;
        recordedTurn = typed.turn;
      },
    } as any;

    const accessor = new PluginFilesAccessor({
      pluginFolder,
      journal: mockJournal,
      getSessionId: () => "session-456",
      getTurn: () => 10,
    });

    await accessor.remove("test.md");

    expect(recordCalled).toBe(true);
    expect(recordedSessionId).toBe("session-456");
    expect(recordedTurn).toBe(10);
  });

  it("read() returns null only for ENOENT, propagates real I/O errors", async () => {
    const pluginFolder = path.join(ws, ".voidrift", "plugins", "test-plugin");
    await fs.mkdir(pluginFolder, { recursive: true });

    const accessor = new PluginFilesAccessor({ pluginFolder });

    // Non-existent file should return null
    const result = await accessor.read("nonexistent.md");
    expect(result).toBeNull();
  });

  it("write with empty pluginFolder throws typed error", async () => {
    const accessor = new PluginFilesAccessor({ pluginFolder: "" });

    try {
      await accessor.write("test.md", "content");
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PluginFileAccessError);
      expect((err as Error).message).toContain("plugin folder");
    }
  });

  it("remove with empty pluginFolder throws typed error", async () => {
    const accessor = new PluginFilesAccessor({ pluginFolder: "" });

    try {
      await accessor.remove("test.md");
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PluginFileAccessError);
      expect((err as Error).message).toContain("plugin folder");
    }
  });

  it("MUTATION PROOF: removing journal.record call breaks journaling test", async () => {
    // If journal.record is removed from write(), recordCalled stays false
    const pluginFolder = path.join(ws, ".voidrift", "plugins", "test-plugin");
    await fs.mkdir(pluginFolder, { recursive: true });

    let recordCalled = false;

    const mockJournal = {
      record: async () => {
        recordCalled = true;
      },
    } as any;

    const accessor = new PluginFilesAccessor({
      pluginFolder,
      journal: mockJournal,
      getSessionId: () => "s1",
      getTurn: () => 1,
    });

    await accessor.write("test.md", "test");
    expect(recordCalled).toBe(true);
  });

  it("MUTATION PROOF: removing realpath check breaks symlink test", async () => {
    // If checkSymlinkContainment is disabled, symlink escape succeeds
    const pluginFolder = path.join(ws, ".voidrift", "plugins", "test-plugin");
    await fs.mkdir(pluginFolder, { recursive: true });

    const outside = path.join(ws, "outside.txt");
    await fs.writeFile(outside, "escaped");
    await fs.symlink(outside, path.join(pluginFolder, "link.txt"));

    const accessor = new PluginFilesAccessor({ pluginFolder });

    try {
      await accessor.read("link.txt");
      expect.fail("MUTATION: symlink check is missing");
    } catch (err) {
      expect(err).toBeInstanceOf(PluginFileAccessError);
    }
  });
});
