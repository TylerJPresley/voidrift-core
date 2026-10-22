import { hermeticTmp } from "../../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import {
  InMemorySessionRepository,
  FilesystemSessionRepository,
} from "./session-repository.js";
import type { PersistedSession } from "../../entities/ports/session-repository.js";
import { InMemoryConfigStore } from "./in-memory-config-store.js";

function sampleSession(id: string, lastActiveAt: string): PersistedSession {
  return {
    metadata: {
      id,
      name: id,
      summary: "idle",
      workspace: "/ws",
      startedAt: lastActiveAt,
      lastActiveAt,
      turnCount: 1,
      sizeBytes: 10,
      namePinned: false,
    },
    documents: [{ path: "a.txt", hash: "h", stale: true, turnAdded: 1, trust: "live", lines: 1 }],
    pending: [],
    sessionRules: [],
    approvalMode: "interactive",
    lastStatus: "completed",
  };
}

describe("InMemorySessionRepository (§5.1)", () => {
  it("saves, loads a clone, lists newest-first, and removes", async () => {
    const repo = new InMemorySessionRepository();
    await repo.save(sampleSession("aaaa", "2024-01-01T00:00:00Z"));
    await repo.save(sampleSession("bbbb", "2024-02-01T00:00:00Z"));
    const loaded = await repo.load("aaaa");
    expect(loaded?.metadata.id).toBe("aaaa");
    expect(await repo.load("missing")).toBeNull();
    const list = await repo.list();
    expect(list.map((m) => m.id)).toEqual(["bbbb", "aaaa"]);
    await repo.remove("aaaa");
    expect(await repo.load("aaaa")).toBeNull();
  });
});

describe("FilesystemSessionRepository (§5.1, §5.2 crash-safe)", () => {
  let ws: string;
  beforeEach(async () => {
    ws = hermeticTmp("sessrepo");
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  const sessDir = (id: string) => path.join(ws, ".voidrift", "sessions", id);

  it("writes and reads the partition files and lists sessions", async () => {
    const repo = new FilesystemSessionRepository(ws);
    await repo.save(sampleSession("cccccccc", "2024-03-01T00:00:00Z"));
    const loaded = await repo.load("cccccccc");
    expect(loaded?.documents[0]?.path).toBe("a.txt");
    const list = await repo.list();
    expect(list.map((m) => m.id)).toEqual(["cccccccc"]);
    expect(await repo.load("absent01")).toBeNull();
    await repo.remove("cccccccc");
    expect(await repo.load("cccccccc")).toBeNull();
    expect(await repo.list()).toEqual([]);
  });

  it("writes files owner-only (mode 0o600) and metadata.json last", async () => {
    const repo = new FilesystemSessionRepository(ws);
    await repo.save(sampleSession("deadbeef", "2024-03-01T00:00:00Z"));
    const stat = await fs.stat(path.join(sessDir("deadbeef"), "metadata.json"));
    // Low 9 permission bits are owner-only (no group/other).
    expect(stat.mode & 0o077).toBe(0);
  });

  it("atomicity — a rename that throws mid-save leaves the PREVIOUS state intact and no temp litter", async () => {
    // Save a good state first with the real rename.
    const good = new FilesystemSessionRepository(ws);
    await good.save(sampleSession("abcd1234", "2024-01-01T00:00:00Z"));
    // Now a repo whose rename throws on the metadata write (the LAST file): the
    // previous consistent partition must still load, proving write-order safety.
    const realRename = fs.rename.bind(fs);
    const failing = new FilesystemSessionRepository(ws, async (from, to) => {
      if (to.endsWith("metadata.json")) throw new Error("boom");
      return realRename(from, to);
    });
    const next = sampleSession("abcd1234", "2024-05-05T00:00:00Z");
    next.metadata.name = "SHOULD-NOT-WIN";
    await expect(failing.save(next)).rejects.toThrow("boom");
    // Previous metadata still loads (the failed metadata write never landed).
    const loaded = await good.load("abcd1234");
    expect(loaded?.metadata.name).toBe("abcd1234");
    expect(loaded?.metadata.lastActiveAt).toBe("2024-01-01T00:00:00Z");
    // No .tmp litter remains in the partition.
    const files = await fs.readdir(sessDir("abcd1234"));
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("corrupt/truncated metadata.json — list skips it and load returns null (one corrupt session never breaks the list)", async () => {
    const repo = new FilesystemSessionRepository(ws);
    await repo.save(sampleSession("11111111", "2024-01-01T00:00:00Z"));
    await repo.save(sampleSession("22222222", "2024-02-01T00:00:00Z"));
    // Truncate one session's metadata.
    await fs.writeFile(path.join(sessDir("11111111"), "metadata.json"), "{ not json");
    const list = await repo.list();
    expect(list.map((m) => m.id)).toEqual(["22222222"]); // corrupt one skipped
    expect(await repo.load("11111111")).toBeNull(); // load returns null, no throw
  });

  it("wrong-shape (hand-edited) metadata.json — load returns null rather than crashing resume", async () => {
    const repo = new FilesystemSessionRepository(ws);
    await repo.save(sampleSession("33333333", "2024-01-01T00:00:00Z"));
    await fs.writeFile(path.join(sessDir("33333333"), "metadata.json"), JSON.stringify({ id: "33333333" }));
    expect(await repo.load("33333333")).toBeNull();
  });

  it("ignores an id inside the file — the directory name wins", async () => {
    const repo = new FilesystemSessionRepository(ws);
    await repo.save(sampleSession("44444444", "2024-01-01T00:00:00Z"));
    // Tamper the on-disk file to claim a different id.
    const metaPath = path.join(sessDir("44444444"), "metadata.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    meta.id = "ffffffff";
    await fs.writeFile(metaPath, JSON.stringify(meta));
    const loaded = await repo.load("44444444");
    expect(loaded?.metadata.id).toBe("44444444"); // dir name, not the in-file lie
  });

  it("masks secrets in session-state.json on disk (a pending bearer token never lands in plaintext)", async () => {
    const repo = new FilesystemSessionRepository(ws);
    const s = sampleSession("55555555", "2024-01-01T00:00:00Z");
    s.pending = [
      {
        id: "p1",
        tool: "fetch",
        args: { header: "Authorization: Bearer sk-liv" + "etoken1234567890abcd" },
        choices: ["approve", "reject"],
        mode: "out_of_band",
      },
    ];
    await repo.save(s);
    const raw = await fs.readFile(path.join(sessDir("55555555"), "session-state.json"), "utf8");
    expect(raw).not.toContain("sk-liv" + "etoken1234567890abcd");
    expect(raw).toContain("«redacted:");
  });

  describe("containment — a caller id must never escape .voidrift/sessions/", () => {
    const bad = ["../../x", "/etc/passwd", "", "a".repeat(64), "aa\0bb", "ABCDEF12", "zzz", "../sibling"];
    it("rejects a traversal/invalid id on load/save/remove with NO filesystem effect outside the sessions dir", async () => {
      const repo = new FilesystemSessionRepository(ws);
      // A sentinel file OUTSIDE the sessions dir that must be untouched.
      const sentinel = path.join(ws, "SENTINEL");
      await fs.writeFile(sentinel, "keep-me");
      for (const id of bad) {
        expect(await repo.load(id)).toBeNull();
        await repo.remove(id); // must be a no-op, never a recursive rm outside
        await repo.save(sampleSession(id, "2024-01-01T00:00:00Z")); // must not write
      }
      // Sentinel intact and the sessions dir never gained a stray partition.
      expect(await fs.readFile(sentinel, "utf8")).toBe("keep-me");
      const base = path.join(ws, ".voidrift", "sessions");
      const entries = await fs.readdir(base).catch(() => []);
      expect(entries).toEqual([]); // no illegal id ever created a directory
    });
  });

  // I1b §5.2 — the shutdown write race. Overlapping saves to ONE partition raced
  // on the temp-and-rename and surfaced as `ENOENT: rename … turns.json` on a
  // SIGTERM mid-write. These fail on the pre-fix (non-unique temp name, no
  // per-partition serialization) repository.
  describe("§5.2 — overlapping writes to one partition never race on rename", () => {
    /** A rename wrapper that yields the event loop before performing the rename,
     * so two concurrent saves are forced to interleave their temp-and-rename
     * sequences — the exact window the SIGTERM-mid-write race opened. */
    function slowRename(): (from: string, to: string) => Promise<void> {
      const real = fs.rename.bind(fs);
      return async (from, to) => {
        await new Promise((r) => setTimeout(r, 1));
        return real(from, to);
      };
    }

    it("two concurrent saves to the SAME id both resolve with no ENOENT, and turns.json is valid JSON", async () => {
      const repo = new FilesystemSessionRepository(ws, slowRename());
      const a = sampleSession("aabbccdd", "2024-01-01T00:00:00Z");
      a.turns = [{ id: 1 } as never];
      const b = sampleSession("aabbccdd", "2024-02-02T00:00:00Z");
      b.turns = [{ id: 2 } as never, { id: 3 } as never];
      // Fire both at once; neither may throw (the pre-fix code threw ENOENT when
      // one writer's rename consumed the other's identical temp path).
      await expect(Promise.all([repo.save(a), repo.save(b)])).resolves.toBeDefined();
      // turns.json is intact (valid JSON) and is ONE of the two states, never torn.
      const raw = await fs.readFile(path.join(sessDir("aabbccdd"), "turns.json"), "utf8");
      const parsed = JSON.parse(raw);
      expect([1, 2]).toContain(parsed.length);
      // No temp litter remains after both saves settle.
      const files = await fs.readdir(sessDir("aabbccdd"));
      expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    });

    it("many overlapping saves to one partition all succeed and the last write wins intact", async () => {
      const repo = new FilesystemSessionRepository(ws, slowRename());
      const saves: Promise<void>[] = [];
      for (let i = 0; i < 8; i += 1) {
        const s = sampleSession("12ab34cd", `2024-0${(i % 9) + 1}-01T00:00:00Z`);
        s.metadata.turnCount = i;
        s.turns = Array.from({ length: i + 1 }, (_, k) => ({ id: k }) as never);
        saves.push(repo.save(s));
      }
      await expect(Promise.all(saves)).resolves.toBeDefined();
      // The partition loads cleanly (every file is valid JSON, none torn).
      const loaded = await repo.load("12ab34cd");
      expect(loaded).not.toBeNull();
      expect(Array.isArray(loaded!.turns)).toBe(true);
    });

    it("drain() awaits an in-flight save so a shutdown leaves a complete file (SIGTERM mid-write safety)", async () => {
      let resolveRename: (() => void) | undefined;
      let markReached: () => void = () => undefined;
      const reached = new Promise<void>((r) => (markReached = r));
      let gated = false;
      const real = fs.rename.bind(fs);
      const gatedRename = async (from: string, to: string): Promise<void> => {
        // Park the FIRST rename on a gate to simulate a write caught in flight by
        // a SIGTERM; release it only when drain() is awaited.
        if (!gated) {
          gated = true;
          markReached();
          await new Promise<void>((r) => (resolveRename = r));
        }
        return real(from, to);
      };
      const repo = new FilesystemSessionRepository(ws, gatedRename);
      const s = sampleSession("99887766", "2024-01-01T00:00:00Z");
      s.turns = [{ id: 7 } as never];
      const saving = repo.save(s);
      // The save is parked mid-rename. Kick off drain and release the gate; drain
      // must not resolve until the in-flight write finishes.
      const drained = (async () => {
        // Wait until the save has actually reached the gate (load-independent),
        // then release it and drain.
        await reached;
        const draining = repo.drain();
        resolveRename?.();
        await draining;
      })();
      await Promise.all([saving, drained]);
      // The file is complete and valid after the drained shutdown — never torn.
      const raw = await fs.readFile(path.join(sessDir("99887766"), "turns.json"), "utf8").catch(() => null);
      expect(raw).not.toBeNull();
      expect(() => JSON.parse(raw!)).not.toThrow();
      expect(JSON.parse(raw!)).toHaveLength(1);
    });
  });
});

describe("InMemoryConfigStore (§13)", () => {
  it("reads seeded and layered docs, writes, rejects, and reports paths", async () => {
    const store = new InMemoryConfigStore({ modelSelected: "a" }, { project: { turnMaxConcurrency: 2 } });
    expect(await store.read("global")).toEqual({ modelSelected: "a" });
    expect(await store.read("project")).toEqual({ turnMaxConcurrency: 2 });
    expect(await store.read("managed")).toBeNull();
    await store.write("session", { modelSelected: "b" });
    expect(await store.read("session")).toEqual({ modelSelected: "b" });
    await store.reject("project", { bad: true });
    expect(store.rejectedDoc("project")).toEqual({ bad: true });
    expect(store.pathOf("global").exists).toBe(true);
    expect(store.pathOf("managed").exists).toBe(false);
  });
});
