import { hermeticTmp } from "../../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { FilesystemConfigStore } from "./filesystem-config-store.js";

describe("FilesystemConfigStore (§13.1)", () => {
  let ws: string;
  let home: string;
  beforeEach(async () => {
    ws = hermeticTmp("cfgstore-ws");
    home = hermeticTmp("cfgstore-home");
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  it("reads null for a missing layer, writes and reads a layer, and never reads managed", async () => {
    const store = new FilesystemConfigStore(ws, undefined, home);
    expect(await store.read("project")).toBeNull();
    await store.write("project", { turnMaxConcurrency: 2 });
    expect(await store.read("project")).toEqual({ turnMaxConcurrency: 2 });
    await store.write("global", { modelSelected: "a" });
    expect(await store.read("global")).toEqual({ modelSelected: "a" });
    // managed is a seam in slice 1 — never read.
    expect(await store.read("managed")).toBeNull();
  });

  it("rejects to a .rejected sibling and reports paths", async () => {
    const store = new FilesystemConfigStore(ws, undefined, home);
    await store.reject("project", { bad: true });
    const p = store.pathOf("project");
    expect(p.exists).toBe(false);
    await store.write("project", { turnMaxConcurrency: 1 });
    expect(store.pathOf("project").exists).toBe(true);
    const rejected = await fs.readFile(store.pathOf("project").path + ".rejected", "utf8");
    expect(JSON.parse(rejected)).toEqual({ bad: true });
  });

  it("throws ConfigReadError (not null) for an existing file that is not valid JSON, carrying the exact bytes", async () => {
    const store = new FilesystemConfigStore(ws, undefined, home);
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    const bytes = "{not json";
    await fs.writeFile(path.join(ws, ".voidrift", "config.json"), bytes);
    // An existing-but-unparseable file is a rejection, never 'absent'.
    await expect(store.read("project")).rejects.toMatchObject({
      name: "ConfigReadError",
      reason: "file is not valid JSON",
      raw: bytes,
    });
  });

  it("still returns null for a truly absent file (ENOENT)", async () => {
    const store = new FilesystemConfigStore(ws, undefined, home);
    expect(await store.read("project")).toBeNull();
  });

  it("rejectRaw preserves the exact original bytes in the .rejected sibling", async () => {
    const store = new FilesystemConfigStore(ws, undefined, home);
    const bytes = '{\n  "permissions": {},\n} // trailing comma + comment\n';
    await store.rejectRaw("project", bytes);
    const rejected = await fs.readFile(store.pathOf("project").path + ".rejected", "utf8");
    expect(rejected).toBe(bytes);
  });

  describe("non-object JSON root is a rejected layer, not absent (§13.2–§13.3)", () => {
    const cases: Array<[string, string]> = [
      ["null", "null"],
      ["array", "[]"],
      ["number", "5"],
      ["string", '"x"'],
      ["boolean", "true"],
    ];
    for (const [label, bytes] of cases) {
      it(`project: a root that is ${label} throws ConfigReadError carrying the exact bytes`, async () => {
        const store = new FilesystemConfigStore(ws, undefined, home);
        await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
        await fs.writeFile(path.join(ws, ".voidrift", "config.json"), bytes);
        await expect(store.read("project")).rejects.toMatchObject({
          name: "ConfigReadError",
          reason: "config root is not an object",
          raw: bytes,
        });
      });

      it(`global: a root that is ${label} throws ConfigReadError carrying the exact bytes`, async () => {
        const store = new FilesystemConfigStore(ws, undefined, home);
        await fs.mkdir(home, { recursive: true });
        await fs.writeFile(path.join(home, "config.json"), bytes);
        await expect(store.read("global")).rejects.toMatchObject({
          name: "ConfigReadError",
          reason: "config root is not an object",
          raw: bytes,
        });
      });
    }
  });

  it("reject() / rejectRaw() write the .rejected sibling 0600, chmod-ing a pre-existing wider mode", async () => {
    const store = new FilesystemConfigStore(ws, undefined, home);
    const rejectedPath = store.pathOf("project").path + ".rejected";

    await store.reject("project", { bad: true });
    expect((await fs.stat(rejectedPath)).mode & 0o777).toBe(0o600);

    // Pre-existing sibling with a wider mode is tightened back to 0600.
    await fs.chmod(rejectedPath, 0o644);
    await store.rejectRaw("project", "{raw");
    expect((await fs.stat(rejectedPath)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(rejectedPath, "utf8")).toBe("{raw");
  });

  describe("session layer with no sessionDir (in-memory; Slice C2d)", () => {
    it("reads/writes the session layer in memory, leaves the project file untouched, and creates no file", async () => {
      const store = new FilesystemConfigStore(ws, undefined, home);
      // Initially null (nothing written yet) — never the project document.
      expect(await store.read("session")).toBeNull();

      // A project document must NOT be visible through the session layer.
      await store.write("project", { turnMaxConcurrency: 2 });
      expect(await store.read("session")).toBeNull();

      // A session write stays in memory.
      await store.write("session", { turnMaxConcurrency: 9 });
      expect(await store.read("session")).toEqual({ turnMaxConcurrency: 9 });

      // It never touched the project file.
      expect(await store.read("project")).toEqual({ turnMaxConcurrency: 2 });

      // No session config.json file was ever created under .voidrift.
      const projectFile = path.join(ws, ".voidrift", "config.json");
      expect(JSON.parse(await fs.readFile(projectFile, "utf8"))).toEqual({ turnMaxConcurrency: 2 });
    });

    it("pathOf(session) is a clear non-file label, exists:false, and never equals the project path", async () => {
      const store = new FilesystemConfigStore(ws, undefined, home);
      const sp = store.pathOf("session");
      expect(sp.exists).toBe(false);
      expect(sp.path).toBe("(session overrides)");
      expect(sp.path).not.toContain(".voidrift");
      expect(sp.path).not.toBe(store.pathOf("project").path);
    });

    it("rejecting the in-memory session layer writes no .rejected file", async () => {
      const store = new FilesystemConfigStore(ws, undefined, home);
      await store.reject("session", { bad: true });
      // No .voidrift directory or session .rejected file is created by this.
      const dir = await fs.readdir(ws);
      expect(dir).toEqual([]);
    });
  });

  describe("session layer WITH a sessionDir (file-backed; unchanged)", () => {
    let sessionDir: string;
    beforeEach(async () => {
      sessionDir = hermeticTmp("cfgstore-sess");
    });
    afterEach(async () => {
      await fs.rm(sessionDir, { recursive: true, force: true });
    });

    it("reads and writes a session config.json under the given sessionDir", async () => {
      const store = new FilesystemConfigStore(ws, sessionDir, home);
      expect(await store.read("session")).toBeNull();
      await store.write("session", { turnMaxConcurrency: 7 });
      expect(await store.read("session")).toEqual({ turnMaxConcurrency: 7 });
      const sp = store.pathOf("session");
      expect(sp.exists).toBe(true);
      expect(sp.path).toBe(path.join(sessionDir, "config.json"));
      // The session file is distinct from the project file.
      expect(sp.path).not.toBe(store.pathOf("project").path);
    });

    it("rejects to a .rejected sibling under the sessionDir", async () => {
      const store = new FilesystemConfigStore(ws, sessionDir, home);
      await store.reject("session", { bad: true });
      const rejected = await fs.readFile(path.join(sessionDir, "config.json.rejected"), "utf8");
      expect(JSON.parse(rejected)).toEqual({ bad: true });
    });
  });

  describe("atomic write hardening (§9.2, Slice C3b)", () => {
    const projectFile = (root: string): string => path.join(root, ".voidrift", "config.json");

    it("writes the config file 0600 and the config dir 0700", async () => {
      const store = new FilesystemConfigStore(ws, undefined, home);
      await store.write("project", { turnMaxConcurrency: 1 });
      const fileMode = (await fs.stat(projectFile(ws))).mode & 0o777;
      const dirMode = (await fs.stat(path.join(ws, ".voidrift"))).mode & 0o777;
      expect(fileMode).toBe(0o600);
      expect(dirMode).toBe(0o700);
    });

    it("leaves NO temp file behind on a successful write", async () => {
      const store = new FilesystemConfigStore(ws, undefined, home);
      await store.write("project", { turnMaxConcurrency: 1 });
      const entries = await fs.readdir(path.join(ws, ".voidrift"));
      expect(entries).toEqual(["config.json"]);
      expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
    });

    it("a failing rename leaves the OLD file intact and no temp behind (atomicity)", async () => {
      // Given — a store with a committed project config.
      const store = new FilesystemConfigStore(ws, undefined, home);
      await store.write("project", { turnMaxConcurrency: 1 });
      const dir = path.join(ws, ".voidrift");

      // When — the rename over the target fails (simulated by stubbing rename).
      const realRename = fs.rename.bind(fs);
      const spy = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("boom"));
      await expect(store.write("project", { turnMaxConcurrency: 2 })).rejects.toThrow("boom");
      spy.mockRestore();
      void realRename;

      // Then — the old document is intact and no .tmp file was left behind.
      expect(await store.read("project")).toEqual({ turnMaxConcurrency: 1 });
      const entries = await fs.readdir(dir);
      expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
      expect(entries).toContain("config.json");
    });

    it("refuses to write THROUGH a symlinked config file", async () => {
      // Given — the config path is a symlink to a file outside .voidrift.
      const store = new FilesystemConfigStore(ws, undefined, home);
      const outside = path.join(ws, "elsewhere.json");
      await fs.writeFile(outside, JSON.stringify({ decoy: true }), "utf8");
      await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
      await fs.symlink(outside, projectFile(ws));

      // When / Then — the write is refused with a clear error…
      await expect(store.write("project", { turnMaxConcurrency: 9 })).rejects.toThrow(/symlink/i);
      // …and the symlink's destination was never written through.
      expect(JSON.parse(await fs.readFile(outside, "utf8"))).toEqual({ decoy: true });
    });

    it("ALLOWS writing through a symlinked config DIRECTORY and lands in the real target", async () => {
      // Given — `.voidrift` is a symlink to a real directory elsewhere (as a
      // dotfile manager would arrange). Writing through it is allowed: the file
      // itself is not a symlink, only the directory is.
      const store = new FilesystemConfigStore(ws, undefined, home);
      const outsideDir = path.join(ws, "outside-cfg");
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.symlink(outsideDir, path.join(ws, ".voidrift"));

      // When — the write succeeds…
      await store.write("project", { turnMaxConcurrency: 9 });

      // Then — the document landed in the REAL target directory (through the
      // link) and is readable back through the store.
      expect(JSON.parse(await fs.readFile(path.join(outsideDir, "config.json"), "utf8"))).toEqual({
        turnMaxConcurrency: 9,
      });
      expect(await store.read("project")).toEqual({ turnMaxConcurrency: 9 });
    });

    it("a symlinked WORKSPACE ROOT above the config dir is fine (only the config dir/file are checked)", async () => {
      // Given — a real target dir, reached through a symlinked workspace root.
      const realRoot = hermeticTmp("realroot");
      const linkRoot = path.join(ws, "linked-root");
      await fs.symlink(realRoot, linkRoot);
      const store = new FilesystemConfigStore(linkRoot, undefined, home);
      // When — writing through the symlinked ROOT succeeds (the config dir
      // itself is a real directory created under the link target).
      await store.write("project", { turnMaxConcurrency: 3 });
      // Then — the document landed.
      expect(await store.read("project")).toEqual({ turnMaxConcurrency: 3 });
      await fs.rm(realRoot, { recursive: true, force: true });
    });

    it("concurrent writes both complete and the file is never left partial", async () => {
      // Two concurrent writes to the same store; the store write is atomic, so
      // the file always holds one complete document (never a torn write).
      const store = new FilesystemConfigStore(ws, undefined, home);
      await Promise.all([
        store.write("project", { turnMaxConcurrency: 1 }),
        store.write("project", { turnMaxConcurrency: 2 }),
      ]);
      const parsed = await store.read("project");
      expect([{ turnMaxConcurrency: 1 }, { turnMaxConcurrency: 2 }]).toContainEqual(parsed);
    });
  });
});
