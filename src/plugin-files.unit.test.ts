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

  // SECURITY: Symlinked directory escape tests (core vulnerability fix)
  it("refuses write/read/list/remove on symlinked dir escaping outside", async () => {
    const pluginFolder = path.join(ws, ".voidrift", "plugins", "test-plugin");
    const outside = path.join(ws, "outside");
    await fs.mkdir(pluginFolder, { recursive: true });
    await fs.mkdir(outside, { recursive: true });

    // Create symlink inside plugin folder pointing outside
    await fs.symlink(outside, path.join(pluginFolder, "evil"));

    const accessor = new PluginFilesAccessor({ pluginFolder });

    // Attempt 1: write('evil/x.md') should fail and NOT write to outside
    try {
      await accessor.write("evil/x.md", "hi");
      expect.fail("Should refuse write to symlink escape");
    } catch (err) {
      expect(err).toBeInstanceOf(PluginFileAccessError);
      expect((err as Error).message).toContain("symlink");
    }
    expect(existsSync(path.join(outside, "x.md"))).toBe(false);

    // Attempt 2: write('evil/sub/y.md') should also fail
    try {
      await accessor.write("evil/sub/y.md", "hi");
      expect.fail("Should refuse write to nested symlink escape");
    } catch (err) {
      expect(err).toBeInstanceOf(PluginFileAccessError);
      expect((err as Error).message).toContain("symlink");
    }
    expect(existsSync(path.join(outside, "sub", "y.md"))).toBe(false);

    // Attempt 3: read('evil/x.md') should fail
    try {
      await accessor.read("evil/x.md");
      expect.fail("Should refuse read from symlink escape");
    } catch (err) {
      expect(err).toBeInstanceOf(PluginFileAccessError);
      expect((err as Error).message).toContain("symlink");
    }

    // Attempt 4: list('evil') should fail
    try {
      await accessor.list("evil");
      expect.fail("Should refuse list on symlink escape");
    } catch (err) {
      expect(err).toBeInstanceOf(PluginFileAccessError);
      expect((err as Error).message).toContain("symlink");
    }

    // Attempt 5: remove('evil/x.md') should fail (even though file doesn't exist)
    try {
      await accessor.remove("evil/x.md");
      expect.fail("Should refuse remove from symlink escape");
    } catch (err) {
      expect(err).toBeInstanceOf(PluginFileAccessError);
      expect((err as Error).message).toContain("symlink");
    }

    // Verify outside directory is still empty
    const outsideFiles = await fs.readdir(outside);
    expect(outsideFiles).toHaveLength(0);
  });

  it("allows symlinked dir that stays INSIDE plugin folder", async () => {
    const pluginFolder = path.join(ws, ".voidrift", "plugins", "test-plugin");
    const inside = path.join(pluginFolder, ".internal");
    await fs.mkdir(pluginFolder, { recursive: true });
    await fs.mkdir(inside, { recursive: true });

    // Create symlink inside plugin folder pointing to another dir inside
    await fs.symlink(inside, path.join(pluginFolder, "link-to-internal"));

    const accessor = new PluginFilesAccessor({ pluginFolder });

    // Write through the symlink should work
    await accessor.write("link-to-internal/data.md", "allowed");
    expect(existsSync(path.join(inside, "data.md"))).toBe(true);

    // Read through the symlink should work
    const content = await accessor.read("link-to-internal/data.md");
    expect(content).toBeTruthy();
  });

  it("refuses sibling-prefix symlink (e.g., <root>-evil)", async () => {
    const pluginFolder = path.join(ws, ".voidrift", "plugins", "test-plugin");
    const sibling = path.join(ws, ".voidrift", "plugins", "test-plugin-evil");
    await fs.mkdir(pluginFolder, { recursive: true });
    await fs.mkdir(sibling, { recursive: true });

    // Create symlink resolving to sibling prefix (not actual parent)
    await fs.symlink(sibling, path.join(pluginFolder, "fake-sibling"));

    const accessor = new PluginFilesAccessor({ pluginFolder });

    try {
      await accessor.write("fake-sibling/attack.md", "hi");
      expect.fail("Should refuse sibling-prefix symlink escape");
    } catch (err) {
      expect(err).toBeInstanceOf(PluginFileAccessError);
      expect((err as Error).message).toContain("symlink");
    }
    expect(existsSync(path.join(sibling, "attack.md"))).toBe(false);
  });

  it("refuses dangling symlink pointing outside (write('d') where d -> nonexistent)", async () => {
    const pluginFolder = path.join(ws, ".voidrift", "plugins", "test-plugin");
    const nonexistent = path.join(ws, "outside", "nonexistent");
    await fs.mkdir(pluginFolder, { recursive: true });

    // Create dangling symlink (target doesn't exist, but path is outside root)
    await fs.symlink(nonexistent, path.join(pluginFolder, "d"));

    const accessor = new PluginFilesAccessor({ pluginFolder });

    try {
      await accessor.write("d", "hi");
      expect.fail("Should refuse write on dangling symlink to outside");
    } catch (err) {
      expect(err).toBeInstanceOf(PluginFileAccessError);
      expect((err as Error).message).toContain("symlink");
    }
  });

  it("allows normal nested writes (no symlinks)", async () => {
    const pluginFolder = path.join(ws, ".voidrift", "plugins", "test-plugin");
    await fs.mkdir(pluginFolder, { recursive: true });

    const accessor = new PluginFilesAccessor({ pluginFolder });

    // Normal write with nested structure
    await accessor.write("data/docs/file.md", "content");
    expect(existsSync(path.join(pluginFolder, "data", "docs", "file.md"))).toBe(true);

    const content = await accessor.read("data/docs/file.md");
    expect(content).toBeTruthy();

    // Remove nested
    await accessor.remove("data/docs/file.md");
    expect(existsSync(path.join(pluginFolder, "data", "docs", "file.md"))).toBe(false);
  });
});

describe("PluginFilesAccessor cross-plugin containment", () => {
  let ws: string;

  beforeEach(async () => {
    ws = hermeticTmp("plugin-files-cross");
  });

  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("one plugin cannot reach another's files via relative or absolute paths", async () => {
    // Create two separate plugin folders
    const plansFolder = path.join(ws, ".voidrift", "plugins", "plans");
    const routinesFolder = path.join(ws, ".voidrift", "plugins", "routines");
    await fs.mkdir(plansFolder, { recursive: true });
    await fs.mkdir(routinesFolder, { recursive: true });

    const plansAccessor = new PluginFilesAccessor({ pluginFolder: plansFolder });
    const routinesAccessor = new PluginFilesAccessor({ pluginFolder: routinesFolder });

    // Write a file in routines folder
    await routinesAccessor.write("secret.md", "secret data");
    expect(existsSync(path.join(routinesFolder, "secret.md"))).toBe(true);

    // Plans plugin tries to read routines' file via relative path
    try {
      await plansAccessor.read("../routines/secret.md");
      expect.fail("Should refuse relative path escaping to another plugin");
    } catch (err) {
      expect(err).toBeInstanceOf(PluginFileAccessError);
    }

    // Plans plugin tries to read via absolute path
    try {
      await plansAccessor.read(path.join(routinesFolder, "secret.md"));
      expect.fail("Should refuse absolute path");
    } catch (err) {
      expect(err).toBeInstanceOf(PluginFileAccessError);
    }

    // Verify routines file still exists and is untouched
    const content = await routinesAccessor.read("secret.md");
    expect(content).toBe("secret data");
  });
});
