/**
 * GitSnapshotStore tests (core-blueprint.md §10.12) — REAL temp git repos.
 *
 * Verifies whole-tree snapshots, restore, exec-bit, binary, untracked/ignored
 * files, unborn HEAD, identity-less repos, a hostile repo config that must NOT
 * execute, shell-made changes restored, conflict detection, ref lifecycle, and
 * that the user's index/HEAD/branches/stash are byte-identical before/after.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, statSync, utimesSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitSnapshotStore } from "./git-snapshot-store.js";
import type { Move, MovePath } from "../entities/rollback.js";

const SID = "0011aabb";
let ws: string;
let store: GitSnapshotStore;

function git(args: string[], cwd = ws): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  }).toString();
}

async function initRepo(opts?: { identity?: boolean; commit?: boolean }): Promise<void> {
  git(["init", "-q", "-b", "main"]);
  if (opts?.identity !== false) {
    git(["config", "user.name", "Test User"]);
    git(["config", "user.email", "test@example.com"]);
  }
  if (opts?.commit) {
    writeFileSync(path.join(ws, "seed.txt"), "seed");
    git(["add", "seed.txt"]);
    git(["commit", "-q", "-m", "seed"]);
  }
}

function write(rel: string, content: string | Buffer, mode?: number): void {
  const abs = path.join(ws, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  if (mode !== undefined) chmodSync(abs, mode);
}

/** Capture one move: begin, let `mutate` change files, commit. */
async function capture(id: number, mutate: () => void): Promise<Move | null> {
  await store.beginTurn({ sessionId: SID, moveId: id, turn: id });
  mutate();
  const draft = await store.commitTurn({ sessionId: SID, moveId: id, turn: id });
  if (!draft) return null;
  return {
    id,
    sessionId: SID,
    turn: id,
    time: new Date().toISOString(),
    summary: `move ${id}`,
    conversation: { beforeCheckpointId: null, afterCheckpointId: `cp-${id}` },
    files: { method: draft.method, paths: draft.paths, notUndoable: draft.notUndoable ?? [] },
  };
}

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "vr-git-"));
  store = new GitSnapshotStore({ root: ws });
});
afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

describe("GitSnapshotStore (§10.12)", () => {
  it("records one move for a modified file and restores it on undo", async () => {
    await initRepo({ commit: true });
    write("a.txt", "v1");
    git(["add", "a.txt"]);
    git(["commit", "-q", "-m", "add a"]);
    const move = await capture(1, () => write("a.txt", "v2"));
    expect(move).not.toBeNull();
    const ap = move!.files.paths.find((p) => p.path === "a.txt");
    expect(ap).toMatchObject({ kind: "modified", restorable: true });
    const r = await store.restore(move!, "undo", { overwrite: new Set() });
    expect(r.conflicts).toEqual([]);
    expect(r.restored).toContain("a.txt");
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("v1");
  });

  it("captures a same-size tracked modification made within the index's timestamp tick (racily-clean regression)", async () => {
    await initRepo({ commit: true });
    write("racy.txt", "AAAA");
    git(["add", "racy.txt"]);
    git(["commit", "-q", "-m", "racy"]);
    const abs = path.join(ws, "racy.txt");
    const idxPath = path.join(ws, ".git", "index");

    // Repeat: each iteration rewrites the file with DIFFERENT content of the SAME
    // length, then forces the racy-clean condition deterministically — the file's
    // mtime is set equal to the real index file's mtime (an entry whose mtime is
    // NOT strictly older than the index is "racy"). On the unfixed code the temp
    // index copy carried a fresh (now) mtime, so the entry looked clean and the
    // modification was dropped from the AFTER snapshot. The fix restores the
    // original index mtime on the copy (and force-refreshes), so it is re-hashed.
    for (let i = 0; i < 25; i++) {
      const next = String.fromCharCode(66 + (i % 20)).repeat(4); // same length (4), new content
      const move = await capture(1 + i, () => {
        writeFileSync(abs, next);
        const idxMtime = statSync(idxPath).mtime;
        utimesSync(abs, idxMtime, idxMtime); // file mtime == index mtime → racy
      });
      expect(move, `iteration ${i}`).not.toBeNull();
      expect(move!.files.paths.map((p) => p.path), `iteration ${i}`).toContain("racy.txt");
      // Commit the new content so the next iteration's index entry matches disk,
      // reproducing the "same second as the index entry" condition each time.
      git(["add", "racy.txt"]);
      git(["commit", "-q", "-m", `racy ${i}`]);
    }
  });

  it("restores a same-size tracked modification missed by the racy-clean path", async () => {
    await initRepo({ commit: true });
    write("same.txt", "1234");
    git(["add", "same.txt"]);
    git(["commit", "-q", "-m", "same"]);
    const abs = path.join(ws, "same.txt");
    const idxPath = path.join(ws, ".git", "index");
    const move = await capture(1, () => {
      writeFileSync(abs, "5678"); // same length, new content
      const idxMtime = statSync(idxPath).mtime;
      utimesSync(abs, idxMtime, idxMtime); // force racy-clean condition
    });
    expect(move).not.toBeNull();
    expect(move!.files.paths.map((p) => p.path)).toContain("same.txt");
    const r = await store.restore(move!, "undo", { overwrite: new Set() });
    expect(r.restored).toContain("same.txt");
    expect(readFileSync(abs, "utf8")).toBe("1234");
  });

  it("captures created, deleted, untracked files; leaves ignored untouched", async () => {
    await initRepo({ commit: true });
    writeFileSync(path.join(ws, ".gitignore"), "ignored.txt\n");
    git(["add", ".gitignore"]);
    git(["commit", "-q", "-m", "ignore"]);
    write("tracked.txt", "t1");
    git(["add", "tracked.txt"]);
    git(["commit", "-q", "-m", "tracked"]);

    const move = await capture(1, () => {
      write("created.txt", "new"); // untracked created
      write("tracked.txt", "t2"); // modified
      writeFileSync(path.join(ws, "ignored.txt"), "should not snapshot");
    });
    const paths = move!.files.paths.map((p) => p.path);
    expect(paths).toContain("created.txt");
    expect(paths).toContain("tracked.txt");
    expect(paths).not.toContain("ignored.txt"); // ignored files are not covered
  });

  it("preserves the exec bit on restore", async () => {
    await initRepo({ commit: true });
    write("script.sh", "#!/bin/sh\necho v1\n", 0o755);
    git(["add", "script.sh"]);
    git(["commit", "-q", "-m", "script"]);
    const move = await capture(1, () => write("script.sh", "#!/bin/sh\necho v2\n", 0o755));
    const sp = move!.files.paths.find((p) => p.path === "script.sh");
    expect(sp?.mode).toBe(0o755);
    // Change it, then undo.
    write("script.sh", "#!/bin/sh\necho v2\n", 0o644); // ensure current === after for undo
    await store.restore(move!, "undo", { overwrite: new Set() });
    expect(statSync(path.join(ws, "script.sh")).mode & 0o111).not.toBe(0); // exec bit restored
  });

  it("handles a binary file", async () => {
    await initRepo({ commit: true });
    const bin1 = Buffer.from([0, 1, 2, 3, 0, 255]);
    write("b.bin", bin1);
    git(["add", "b.bin"]);
    git(["commit", "-q", "-m", "bin"]);
    const bin2 = Buffer.from([9, 8, 7, 0, 6]);
    const move = await capture(1, () => write("b.bin", bin2));
    await store.restore(move!, "undo", { overwrite: new Set() });
    expect(readFileSync(path.join(ws, "b.bin")).equals(bin1)).toBe(true);
  });

  it("works with an UNBORN HEAD (no commits yet)", async () => {
    await initRepo({ commit: false });
    const move = await capture(1, () => write("first.txt", "hello"));
    expect(move).not.toBeNull();
    expect(move!.files.paths.find((p) => p.path === "first.txt")?.kind).toBe("created");
    await store.restore(move!, "undo", { overwrite: new Set() });
    expect(existsSync(path.join(ws, "first.txt"))).toBe(false); // created → removed on undo
  });

  it("works on a repo with NO user identity (fixed identity injected)", async () => {
    await initRepo({ identity: false, commit: false });
    const move = await capture(1, () => write("x.txt", "content"));
    expect(move).not.toBeNull();
    expect(move!.files.paths.map((p) => p.path)).toContain("x.txt");
  });

  it("restores a change made by a SHELL command inside the tree", async () => {
    await initRepo({ commit: true });
    write("shellme.txt", "v1");
    git(["add", "shellme.txt"]);
    git(["commit", "-q", "-m", "s"]);
    // The "write" here simulates a shell command editing the file mid-turn; the
    // whole-tree snapshot captures it even without a noteWrite.
    const move = await capture(1, () => writeFileSync(path.join(ws, "shellme.txt"), "v2-by-shell"));
    expect(move!.files.paths.map((p) => p.path)).toContain("shellme.txt");
    await store.restore(move!, "undo", { overwrite: new Set() });
    expect(readFileSync(path.join(ws, "shellme.txt"), "utf8")).toBe("v1");
  });

  it("detects a conflict when the user edits after the move and leaves everything untouched", async () => {
    await initRepo({ commit: true });
    write("c.txt", "v1");
    git(["add", "c.txt"]);
    git(["commit", "-q", "-m", "c"]);
    const move = await capture(1, () => write("c.txt", "v2"));
    // User edits to v3 → undo expects v2 → conflict.
    write("c.txt", "v3");
    const r = await store.restore(move!, "undo", { overwrite: new Set() });
    expect(r.conflicts).toContain("c.txt");
    expect(r.restored).toEqual([]);
    expect(readFileSync(path.join(ws, "c.txt"), "utf8")).toBe("v3");
    // Overwrite confirmed → restores.
    const r2 = await store.restore(move!, "undo", { overwrite: new Set(["c.txt"]) });
    expect(r2.restored).toContain("c.txt");
    expect(readFileSync(path.join(ws, "c.txt"), "utf8")).toBe("v1");
  });

  it("a hostile repo config (core.fsmonitor/filter) does NOT execute", async () => {
    await initRepo({ commit: true });
    const sentinel = path.join(ws, "PWNED");
    // A fsmonitor / filter driver that would create a sentinel file if run.
    git(["config", "core.fsmonitor", `sh -c 'touch ${sentinel}'`]);
    git(["config", "filter.evil.clean", `sh -c 'touch ${sentinel}'`]);
    git(["config", "filter.evil.smudge", `sh -c 'touch ${sentinel}'`]);
    writeFileSync(path.join(ws, ".gitattributes"), "*.txt filter=evil\n");
    const move = await capture(1, () => write("a.txt", "v2"));
    expect(move).not.toBeNull();
    expect(existsSync(sentinel)).toBe(false); // the hostile driver never ran
  });

  it("no-op turn (identical tree) records no move and leaves no refs", async () => {
    await initRepo({ commit: true });
    const move = await capture(1, () => {
      /* change nothing */
    });
    expect(move).toBeNull();
    const refs = git(["for-each-ref", "refs/voidrift/"]).trim();
    expect(refs).toBe("");
  });

  it("creates before/after refs and deletes them on drop", async () => {
    await initRepo({ commit: true });
    const move = await capture(1, () => write("a.txt", "v2"));
    expect(move).not.toBeNull();
    const refsBefore = git(["for-each-ref", "--format=%(refname)", "refs/voidrift/"]).trim();
    expect(refsBefore).toContain(`refs/voidrift/${SID}/1/before`);
    expect(refsBefore).toContain(`refs/voidrift/${SID}/1/after`);
    await store.drop([1]);
    const refsAfter = git(["for-each-ref", "refs/voidrift/"]).trim();
    expect(refsAfter).toBe("");
  });

  it("leaves the user's index, HEAD, and branches byte-identical", async () => {
    await initRepo({ commit: true });
    write("a.txt", "v1");
    git(["add", "a.txt"]); // stage something so the index is non-trivial
    const headBefore = git(["rev-parse", "HEAD"]).trim();
    const indexBefore = readFileSync(path.join(ws, ".git", "index"));
    const branchesBefore = git(["branch", "--format=%(refname)"]).trim();

    await capture(1, () => write("a.txt", "v2"));

    // The INDEX is byte-identical — the snapshot used a temp GIT_INDEX_FILE and
    // never touched the user's staged content. HEAD and branches are unchanged,
    // and no stash was created. (The working-tree porcelain status legitimately
    // changes because the test itself edited a.txt to v2 — not the snapshot.)
    expect(git(["rev-parse", "HEAD"]).trim()).toBe(headBefore);
    expect(readFileSync(path.join(ws, ".git", "index")).equals(indexBefore)).toBe(true);
    expect(git(["branch", "--format=%(refname)"]).trim()).toBe(branchesBefore);
    expect(git(["stash", "list"]).trim()).toBe("");
  });

  it("reports a symlink in the diff as skipped (not restored)", async () => {
    await initRepo({ commit: true });
    const move = await capture(1, () => {
      // Create a symlink; git records it as mode 120000.
      symlinkSync("seed.txt", path.join(ws, "link"));
    });
    const lp = move!.files.paths.find((p: MovePath) => p.path === "link");
    expect(lp).toMatchObject({ restorable: false, reason: "symlink" });
  });

  it("persists and loads the timeline under the cache dir", async () => {
    await initRepo({ commit: true });
    await store.persistTimeline(SID, { version: 2, moves: [], pointer: 0 });
    const t = await store.loadTimeline(SID);
    expect(t).toEqual({ version: 2, moves: [], pointer: 0 });
  });

  // ── `.voidrift` state is never captured (bug fix) ──────────────────────────

  /** List every path in a snapshot ref's tree (empty when the ref is gone). */
  function lsTree(id: number, which: "before" | "after"): string[] {
    const ref = `refs/voidrift/${SID}/${id}/${which}`;
    try {
      return git(["ls-tree", "-r", "--name-only", ref])
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "");
    } catch {
      return []; // ref absent (e.g. a no-op before ref was deleted)
    }
  }

  it("excludes .voidrift from capture: a chat-only turn that only churns .voidrift records no move", async () => {
    await initRepo({ commit: true });
    // A large checkpoint db under .voidrift that changes between before/after —
    // the ONLY change this turn. With the exclude, trees are identical → no move.
    write(".voidrift/checkpoint.db", "x".repeat(200_000));
    const move = await capture(1, () => {
      write(".voidrift/checkpoint.db", "y".repeat(200_000));
      write(".voidrift/cache/snapshots/blob", "journal-raw-content");
    });
    expect(move).toBeNull(); // no-op: method none, zero paths
    // And the (now-deleted) before/after trees never held a .voidrift entry.
    expect(lsTree(1, "after").some((p) => p.startsWith(".voidrift"))).toBe(false);
  });

  it("captures a normal-file edit exactly, with no .voidrift entry in the tree", async () => {
    await initRepo({ commit: true });
    write(".voidrift/checkpoint.db", "db0");
    const move = await capture(1, () => {
      write("app.js", "console.log(1)");
      write(".voidrift/checkpoint.db", "db1"); // churns every turn — must be ignored
    });
    expect(move).not.toBeNull();
    expect(move!.files.paths.map((p) => p.path)).toEqual(["app.js"]);
    const tree = lsTree(1, "after");
    expect(tree).toContain("app.js");
    expect(tree.some((p) => p.startsWith(".voidrift"))).toBe(false);
  });

  it("drops a TRACKED .voidrift/config.json from the snapshot tree and never restores it", async () => {
    await initRepo();
    // Track .voidrift/config.json BEFORE any snapshot, then change it + a file.
    write(".voidrift/config.json", "v1");
    git(["add", ".voidrift/config.json"]);
    git(["commit", "-q", "-m", "track control file"]);
    const move = await capture(1, () => {
      write(".voidrift/config.json", "v2"); // tracked control file changes
      write("src.ts", "export const a = 1");
    });
    expect(move).not.toBeNull();
    expect(move!.files.paths.map((p) => p.path)).toEqual(["src.ts"]);
    expect(lsTree(1, "after").some((p) => p.startsWith(".voidrift"))).toBe(false);
    // Undo restores only src.ts; the tracked control file is untouched on disk.
    write("src.ts", "export const a = 1"); // current === after
    const r = await store.restore(move!, "undo", { overwrite: new Set() });
    expect(r.restored).toContain("src.ts");
    expect(r.restored.some((p) => p.startsWith(".voidrift"))).toBe(false);
    expect(readFileSync(path.join(ws, ".voidrift/config.json"), "utf8")).toBe("v2");
  });

  it("excludes .voidrift on an unborn HEAD (no commits)", async () => {
    await initRepo(); // no initial commit → unborn HEAD
    write(".voidrift/checkpoint.db", "db0");
    const move = await capture(1, () => {
      write("first.txt", "hello");
      write(".voidrift/checkpoint.db", "db1");
    });
    expect(move).not.toBeNull();
    expect(move!.files.paths.map((p) => p.path)).toEqual(["first.txt"]);
    expect(lsTree(1, "after").some((p) => p.startsWith(".voidrift"))).toBe(false);
  });
});

describe("GitSnapshotStore SNAP2 capture timeout (§13.11)", () => {
  it("uses the configured captureTimeoutMs on capture git calls", async () => {
    const seen: (number | undefined)[] = [];
    const spyRunner = async (_args: string[], opts: { timeoutMs?: number }) => {
      seen.push(opts.timeoutMs);
      // Return a benign empty-output success so the capture proceeds/degrades
      // without needing a real repo; we only assert the threaded timeout.
      return { stdout: "", stdoutBuf: Buffer.alloc(0), stderr: "", code: 0 };
    };
    const custom = new GitSnapshotStore({ root: ws, runner: spyRunner, captureTimeoutMs: 1234 });
    await custom.beginTurn({ sessionId: SID, moveId: 1, turn: 1 });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((t) => t === 1234)).toBe(true);
  });

  it("the default captureTimeoutMs equals the registry rollback.gitCaptureTimeoutMs (20 s)", async () => {
    const { limitDefault } = await import("../entities/limits.js");
    const seen: (number | undefined)[] = [];
    const spyRunner = async (_args: string[], opts: { timeoutMs?: number }) => {
      seen.push(opts.timeoutMs);
      return { stdout: "", stdoutBuf: Buffer.alloc(0), stderr: "", code: 0 };
    };
    const dflt = new GitSnapshotStore({ root: ws, runner: spyRunner });
    await dflt.beginTurn({ sessionId: SID, moveId: 1, turn: 1 });
    expect(limitDefault("rollback.gitCaptureTimeoutMs")).toBe(20_000);
    expect(seen.some((t) => t === 20_000)).toBe(true);
  });
});
