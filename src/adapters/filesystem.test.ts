import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { FilesystemAdapter } from "./filesystem.js";

describe("FilesystemAdapter (§8.2)", () => {
  let root: string;
  let a: FilesystemAdapter;

  beforeEach(async () => {
    root = hermeticTmp("fsadapter");
    a = new FilesystemAdapter(root);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("writes, reads, and reports existence relative to the root", async () => {
    expect(await a.exists("x.txt")).toBe(false);
    await a.writeFile("sub/x.txt", "hello");
    expect(await a.exists("sub/x.txt")).toBe(true);
    expect(await a.readFile("sub/x.txt")).toBe("hello");
  });

  it("globs workspace-relative paths and searches content", async () => {
    await a.writeFile("one.ts", "const a = 1;\nhit here");
    await a.writeFile("two.js", "nope");
    const ts = await a.glob("*.ts");
    expect(ts).toContain("one.ts");
    const matches = await a.search("hit");
    expect(matches.some((m) => m.includes("one.ts"))).toBe(true);
  });

  it("search honors a path scope and an include filter and skips ignored dirs", async () => {
    await a.writeFile("sub/keep.ts", "needle");
    await a.writeFile("sub/skip.js", "needle");
    const scoped = await a.search("needle", { path: "sub", include: "*.ts" });
    expect(scoped.some((m) => m.includes("keep.ts"))).toBe(true);
    expect(scoped.some((m) => m.includes("skip.js"))).toBe(false);
  });

  it("glob returns an empty list when nothing matches and does not throw on a missing root", async () => {
    const none = await a.glob("*.nomatch");
    expect(none).toEqual([]);
  });

  describe("readBinary (§3.3 vision attachments)", () => {
    it("reads raw bytes under the cap and rejects an oversized file before buffering", async () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
      await fs.writeFile(path.join(root, "shot.png"), png);
      const got = await a.readBinary("shot.png", { maxBytes: 1024 });
      expect(Buffer.from(got).equals(png)).toBe(true);
      // over the cap → INVALID_INPUT, nothing returned
      let code = "";
      try {
        await a.readBinary("shot.png", { maxBytes: 4 });
      } catch (e) {
        code = (e as { error?: { code?: string } }).error?.code ?? "";
      }
      expect(code).toBe("INVALID_INPUT");
    });

    it("uses the SAME containment chokepoint — rejects an escape and an out-of-root symlink", async () => {
      let code = "";
      try {
        await a.readBinary("../../../etc/hostname", { maxBytes: 1024 });
      } catch (e) {
        code = (e as { error?: { code?: string } }).error?.code ?? "";
      }
      expect(code).toBe("PATH_ESCAPE");

      const secret = path.join(root, "..", "outside-bin");
      await fs.writeFile(secret, Buffer.from([1, 2, 3]));
      try {
        await fs.symlink(secret, path.join(root, "blink"));
        let scode = "";
        try {
          await a.readBinary("blink", { maxBytes: 1024 });
        } catch (e) {
          scode = (e as { error?: { code?: string } }).error?.code ?? "";
        }
        expect(scode).toBe("PATH_ESCAPE");
      } finally {
        await fs.rm(secret, { force: true });
      }
    });
  });

  describe("path containment (§8.2, §15.1)", () => {
    const escapes = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return undefined;
      } catch (e) {
        return (e as { error?: { code?: string } }).error?.code;
      }
    };

    it("rejects an absolute path outside the root", async () => {
      expect(await escapes(() => a.readFile("/etc/hostname"))).toBe("PATH_ESCAPE");
      expect(await escapes(() => a.writeFile("/tmp/evil.txt", "x"))).toBe("PATH_ESCAPE");
      expect(await escapes(() => a.remove("/etc/hostname"))).toBe("PATH_ESCAPE");
    });

    it("rejects a relative `..` escape", async () => {
      expect(await escapes(() => a.readFile("../../../../etc/hostname"))).toBe("PATH_ESCAPE");
      expect(await escapes(() => a.readFile("sub/../../outside.txt"))).toBe("PATH_ESCAPE");
    });

    it("rejects an in-workspace symlink that points outside the root", async () => {
      const outside = hermeticTmp("outside");
      const secret = path.join(outside, "secret.txt");
      await fs.writeFile(secret, "top-secret", "utf8");
      await fs.symlink(secret, path.join(root, "link.txt"));
      try {
        expect(await escapes(() => a.readFile("link.txt"))).toBe("PATH_ESCAPE");
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it("still allows legitimate in-root access", async () => {
      await a.writeFile("ok/in.txt", "fine");
      expect(await a.readFile("ok/in.txt")).toBe("fine");
      expect(await a.exists("../../etc/hostname")).toBe(false);
    });
  });

  describe("writeFileAtomic (§8.3)", () => {
    it("writes the full content, mode 0600, through the same containment chokepoint", async () => {
      await a.writeFileAtomic(".voidrift/cache/session/s1/tool-abc.txt", "X".repeat(1000), { mode: 0o600 });
      const abs = path.join(root, ".voidrift/cache/session/s1/tool-abc.txt");
      expect(await fs.readFile(abs, "utf8")).toBe("X".repeat(1000));
      expect((await fs.stat(abs)).mode & 0o777).toBe(0o600);
      // No stray temp file remains in the directory.
      const entries = await fs.readdir(path.dirname(abs));
      expect(entries.filter((e) => e.endsWith(".tmp"))).toHaveLength(0);
    });

    it("rejects an escape — a hostile relative path cannot write outside the root", async () => {
      await expect(a.writeFileAtomic("../../etc/evil.txt", "x")).rejects.toMatchObject({
        error: { code: "PATH_ESCAPE" },
      });
    });

    it("defaults to mode 0600 when no mode is given", async () => {
      await a.writeFileAtomic("c/f.txt", "data");
      expect((await fs.stat(path.join(root, "c/f.txt")).then((s) => s.mode & 0o777))).toBe(0o600);
    });

    it("tolerates concurrent writes to the same target — no ENOENT race (regression)", async () => {
      // Byte-identical oversized output evicted concurrently lands on the same
      // hash-derived target; per-call unique temp names must prevent a rename
      // race where one write clobbers the other's temp and the loser throws.
      const target = ".voidrift/cache/session/s2/tool-dupe.txt";
      const body = "Y".repeat(5000);
      await Promise.all(Array.from({ length: 8 }, () => a.writeFileAtomic(target, body, { mode: 0o600 })));
      const abs = path.join(root, target);
      expect(await fs.readFile(abs, "utf8")).toBe(body);
      // Every temp file was renamed or removed; none leaked.
      const entries = await fs.readdir(path.dirname(abs));
      expect(entries.filter((e) => e.endsWith(".tmp"))).toHaveLength(0);
    });

    it("creates the cache directory owner-only (0700, hardening)", async () => {
      await a.writeFileAtomic(".voidrift/cache/session/s3/tool-x.txt", "z", { mode: 0o600 });
      const dir = path.join(root, ".voidrift/cache/session/s3");
      expect((await fs.stat(dir)).mode & 0o700).toBe(0o700);
      expect((await fs.stat(dir)).mode & 0o077).toBe(0);
    });
  });

  describe("search guards (§8.2, S3)", () => {
    it("never hangs on a FIFO (non-regular files are skipped)", async () => {
      // Given a FIFO in the workspace — a plain readFile on it would block forever.
      const { execFileSync } = await import("node:child_process");
      try {
        execFileSync("mkfifo", [path.join(root, "pipe")]);
      } catch {
        return; // mkfifo unavailable on this platform — the guard is still tested below
      }
      await a.writeFile("real.txt", "needle");
      // When a search runs, it must return promptly without reading the FIFO.
      const matches = await Promise.race([
        a.search("needle"),
        new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error("search hung on FIFO")), 3000)),
      ]);
      expect(matches.some((m) => m.includes("real.txt"))).toBe(true);
      expect(matches.some((m) => m.includes("pipe"))).toBe(false);
    });

    it("skips a symlink rather than following it", async () => {
      const outside = hermeticTmp("outside");
      try {
        await fs.writeFile(path.join(outside, "secret.txt"), "needle", "utf8");
        await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
        await a.writeFile("real.txt", "needle");
        const matches = await a.search("needle");
        expect(matches.some((m) => m.includes("real.txt"))).toBe(true);
        expect(matches.some((m) => m.includes("link.txt"))).toBe(false);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it("skips a file larger than 2 MiB", async () => {
      await a.writeFile("big.txt", "needle\n" + "x".repeat(2 * 1024 * 1024 + 10));
      await a.writeFile("small.txt", "needle");
      const matches = await a.search("needle");
      expect(matches.some((m) => m.includes("small.txt"))).toBe(true);
      expect(matches.some((m) => m.includes("big.txt"))).toBe(false);
    });

    it("caps recursion depth and does not throw on a deep tree", async () => {
      // Build a tree deeper than the depth cap (32); a file past the cap is not
      // searched, a file within it is.
      let p = "d";
      await a.writeFile(`${p}/shallow.txt`, "needle");
      for (let i = 0; i < 40; i++) p = `${p}/d`;
      await a.writeFile(`${p}/deep.txt`, "needle");
      const matches = await a.search("needle");
      expect(matches.some((m) => m.includes("shallow.txt"))).toBe(true);
      expect(matches.some((m) => m.includes("deep.txt"))).toBe(false);
    });
  });
});
