/**
 * Durable staging adapter tests (core-blueprint.md §7.4).
 *
 * Proves the real temp-and-rename adapter over a temp workspace: a staged write
 * is durable with a manifest recording BOTH the disk base hash and the staged
 * content hash; a read checks staging first then disk; apply runs the two
 * re-hash checks (integrity + conflict) and writes through a destination-dir
 * temp-and-rename; a simulated crash mid-write leaves no half-written file; a
 * dead-owner folder is pruned on boot. Offline/deterministic — local fs only.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { FilesystemStagingAdapter } from "./staging.js";
import { contentHash } from "../entities/hash.js";

describe("FilesystemStagingAdapter — durable staging without git (§7.4)", () => {
  let root: string;
  let staging: FilesystemStagingAdapter;

  beforeEach(async () => {
    root = hermeticTmp("staging");
    staging = new FilesystemStagingAdapter(root);
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("a staged write persists a blob + manifest recording base and staged-content hashes", async () => {
    // Given a file already on disk (the base).
    fs.writeFileSync(path.join(root, "a.txt"), "base-content");
    await staging.createArea("run1");
    // When a write is staged.
    await staging.stageWrite("run1", "a.txt", "staged-content");
    // Then the manifest records BOTH hashes from the ONE hash utility.
    const manifest = (await staging.manifest("run1"))!;
    const entry = manifest.files.find((f) => f.path === "a.txt")!;
    expect(entry.baseHash).toBe(contentHash("base-content"));
    expect(entry.stagedHash).toBe(contentHash("staged-content"));
    // And the staged blob lives durably in the staging folder, not on disk.
    const blobPath = path.join(root, ".voidrift/cache/staging/run1", entry.blob);
    expect(fs.readFileSync(blobPath, "utf8")).toBe("staged-content");
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("base-content");
  });

  it("read checks staging first, then disk", async () => {
    fs.writeFileSync(path.join(root, "b.txt"), "disk-only");
    fs.writeFileSync(path.join(root, "c.txt"), "disk-c");
    await staging.createArea("run2");
    await staging.stageWrite("run2", "c.txt", "staged-c");
    // A staged path returns the staged content; an unstaged path falls to disk.
    expect(await staging.read("run2", "c.txt")).toBe("staged-c");
    expect(await staging.read("run2", "b.txt")).toBe("disk-only");
    expect(await staging.read("run2", "missing.txt")).toBeNull();
  });

  it("apply writes staged content over the target through a destination temp-and-rename and discards on clean apply", async () => {
    fs.writeFileSync(path.join(root, "d.txt"), "old");
    await staging.createArea("run3");
    await staging.stageWrite("run3", "d.txt", "new");
    const result = await staging.apply("run3");
    expect(result.applied).toEqual(["d.txt"]);
    expect(result.blocked).toHaveLength(0);
    expect(fs.readFileSync(path.join(root, "d.txt"), "utf8")).toBe("new");
    // A clean apply discards the staging folder.
    expect(fs.existsSync(path.join(root, ".voidrift/cache/staging/run3"))).toBe(false);
  });

  it("a changed base hash reports a CONFLICT and does not apply", async () => {
    fs.writeFileSync(path.join(root, "e.txt"), "original");
    await staging.createArea("run4");
    await staging.stageWrite("run4", "e.txt", "staged");
    // The disk changes AFTER staging — the base no longer matches.
    fs.writeFileSync(path.join(root, "e.txt"), "changed-elsewhere");
    const result = await staging.apply("run4");
    expect(result.applied).toHaveLength(0);
    expect(result.blocked[0]).toMatchObject({ ok: false, reason: "conflict", path: "e.txt" });
    // Not applied: the user's changed file is untouched, folder preserved for re-dispatch.
    expect(fs.readFileSync(path.join(root, "e.txt"), "utf8")).toBe("changed-elsewhere");
    expect(fs.existsSync(path.join(root, ".voidrift/cache/staging/run4"))).toBe(true);
  });

  it("a staged blob that disagrees with its manifest hash is reported UNRELIABLE and not applied", async () => {
    fs.writeFileSync(path.join(root, "f.txt"), "base");
    await staging.createArea("run5");
    await staging.stageWrite("run5", "f.txt", "good");
    // Corrupt the staged blob on disk so its re-hash disagrees with the manifest.
    const entry = (await staging.manifest("run5"))!.files[0]!;
    fs.writeFileSync(path.join(root, ".voidrift/cache/staging/run5", entry.blob), "tampered");
    const result = await staging.apply("run5");
    expect(result.applied).toHaveLength(0);
    expect(result.blocked[0]).toMatchObject({ ok: false, reason: "unreliable", path: "f.txt" });
    expect(fs.readFileSync(path.join(root, "f.txt"), "utf8")).toBe("base");
  });

  it("temp-and-rename atomicity — a crash mid-write leaves no half-written target (only temp, discarded)", async () => {
    // A staged write never writes the TARGET directly: it writes a temp then
    // renames. If the process crashed between write and rename, the target is
    // untouched and only a .tmp remains. Assert the target is never partially
    // written: after staging, the disk target is unchanged (write goes to blob).
    fs.writeFileSync(path.join(root, "g.txt"), "safe");
    await staging.createArea("run6");
    await staging.stageWrite("run6", "g.txt", "pending");
    // The target on disk is still the safe base — the staged write never touched it.
    expect(fs.readFileSync(path.join(root, "g.txt"), "utf8")).toBe("safe");
    // No stray temp files remain in the staging folder after a completed stage.
    const files = fs.readdirSync(path.join(root, ".voidrift/cache/staging/run6"));
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    // And the manifest agrees with the blob (never a half-written disagreement).
    const entry = (await staging.manifest("run6"))!.files[0]!;
    const blob = fs.readFileSync(path.join(root, ".voidrift/cache/staging/run6", entry.blob), "utf8");
    expect(contentHash(blob)).toBe(entry.stagedHash);
  });

  it("listRuns finds unfinished staging folders for recovery and discard removes one", async () => {
    await staging.createArea("run7");
    await staging.stageWrite("run7", "h.txt", "x");
    expect(await staging.listRuns()).toContain("run7");
    await staging.discard("run7");
    expect(await staging.listRuns()).not.toContain("run7");
  });

  it("a dead-owner staging folder older than the TTL is pruned on boot; a live/fresh one is kept", async () => {
    // A dead-owner, stale folder (pid unlikely to exist, timestamp well past TTL).
    await staging.createArea("dead");
    const deadManifest = path.join(root, ".voidrift/cache/staging/dead/manifest.json");
    fs.writeFileSync(
      deadManifest,
      JSON.stringify({ run: "dead", pid: 2 ** 30, timestamp: new Date(Date.now() - 1000 * 60_000).toISOString(), files: [] }),
    );
    // A live-owner folder (this process) must be kept.
    await staging.createArea("live");
    const pruned = await staging.bootCleanup(120);
    expect(pruned).toContain("dead");
    expect(pruned).not.toContain("live");
    expect(await staging.listRuns()).toContain("live");
    expect(await staging.listRuns()).not.toContain("dead");
  });

  // Workspace containment (§8.2, §15.1#8) — the no-repo mirror of the worktree
  // backend's "Path traversal not allowed" (substrate/worktree-backend-confinement).
  describe("workspace containment — a staged write never escapes the root", () => {
    let outside: string;
    beforeEach(async () => {
      outside = hermeticTmp("staging-out");
    });
    afterEach(async () => {
      await fsp.rm(outside, { recursive: true, force: true });
    });

    it("refuses a `../` traversal at stage time (hard error, nothing persisted)", async () => {
      await staging.createArea("esc1");
      await expect(staging.stageWrite("esc1", "../escape.txt", "evil")).rejects.toThrow(/Path traversal not allowed/);
      // Nothing was written outside the root and the manifest carries no entry.
      expect(fs.existsSync(path.join(root, "..", "escape.txt"))).toBe(false);
      expect((await staging.manifest("esc1"))!.files).toHaveLength(0);
    });

    it("refuses an ABSOLUTE path at stage time (hard error)", async () => {
      await staging.createArea("esc2");
      const abs = path.join(outside, "evil.txt");
      await expect(staging.stageWrite("esc2", abs, "evil")).rejects.toThrow(/Path traversal not allowed/);
      expect(fs.existsSync(abs)).toBe(false);
      expect((await staging.manifest("esc2"))!.files).toHaveLength(0);
    });

    it("a legitimate nested in-tree path still stages and applies (no false positive)", async () => {
      await staging.createArea("esc3");
      await staging.stageWrite("esc3", "sub/dir/f.txt", "nested");
      const result = await staging.apply("esc3");
      expect(result.applied).toEqual(["sub/dir/f.txt"]);
      expect(result.blocked).toHaveLength(0);
      expect(fs.readFileSync(path.join(root, "sub/dir/f.txt"), "utf8")).toBe("nested");
    });

    it("a manifest entry resolving OUTSIDE the root is refused at apply (reported, not written)", async () => {
      // Stage a legit file, then corrupt the manifest to carry an out-of-tree path.
      await staging.createArea("esc4");
      await staging.stageWrite("esc4", "ok.txt", "payload");
      const mp = path.join(root, ".voidrift/cache/staging/esc4/manifest.json");
      const manifest = JSON.parse(fs.readFileSync(mp, "utf8"));
      const escapeTarget = path.join(outside, "pwned.txt");
      manifest.files[0].path = escapeTarget; // absolute, outside the root
      fs.writeFileSync(mp, JSON.stringify(manifest));
      const result = await staging.apply("esc4");
      expect(result.applied).toHaveLength(0);
      expect(result.blocked[0]).toMatchObject({ ok: false, reason: "escape", path: escapeTarget });
      // The file is NOT written outside the workspace; folder kept for the report.
      expect(fs.existsSync(escapeTarget)).toBe(false);
      expect(fs.existsSync(path.join(root, ".voidrift/cache/staging/esc4"))).toBe(true);
    });

    it("a staged write whose path crosses a boundary via a symlink is refused", async () => {
      // A symlink inside the root that points outside it — a write through it
      // would land outside the workspace, so it must be refused.
      fs.symlinkSync(outside, path.join(root, "link"));
      await staging.createArea("esc5");
      await expect(staging.stageWrite("esc5", "link/evil.txt", "evil")).rejects.toThrow(/Path traversal not allowed/);
      expect(fs.existsSync(path.join(outside, "evil.txt"))).toBe(false);
      expect((await staging.manifest("esc5"))!.files).toHaveLength(0);
    });
  });

  describe("removeForSession (§5.8)", () => {
    let outside: string;
    beforeEach(async () => {
      outside = hermeticTmp("staging-out");
    });
    afterEach(async () => {
      await fsp.rm(outside, { recursive: true, force: true });
    });

    it("records the owning sessionId on createArea and removes only that session's folders, reclaiming bytes", async () => {
      // Given two folders owned by S1 and one by S2 (ownership recorded).
      await staging.createArea("r1", "s1aaaaaa");
      await staging.createArea("r2", "s1aaaaaa");
      await staging.createArea("r3", "s2bbbbbb");
      await staging.stageWrite("r1", "a.txt", "x".repeat(200));
      expect((await staging.manifest("r1"))!.sessionId).toBe("s1aaaaaa");

      // When S1 is deleted.
      const res = await staging.removeForSession("s1aaaaaa");

      // Then only S1's folders are gone; S2's survives; bytes reclaimed.
      expect(res.removedRuns.sort()).toEqual(["r1", "r2"]);
      expect(res.reclaimedBytes).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(root, ".voidrift/cache/staging/r1"))).toBe(false);
      expect(fs.existsSync(path.join(root, ".voidrift/cache/staging/r2"))).toBe(false);
      expect(fs.existsSync(path.join(root, ".voidrift/cache/staging/r3"))).toBe(true);
    });

    it("never removes a folder it cannot prove belongs to the session (no/other sessionId)", async () => {
      await staging.createArea("orphan"); // no sessionId
      await staging.createArea("other", "s9999999");
      const res = await staging.removeForSession("s1aaaaaa");
      expect(res.removedRuns).toEqual([]);
      expect(res.reclaimedBytes).toBe(0);
      expect(fs.existsSync(path.join(root, ".voidrift/cache/staging/orphan"))).toBe(true);
      expect(fs.existsSync(path.join(root, ".voidrift/cache/staging/other"))).toBe(true);
    });

    it("a symlink inside the folder is unlinked, never followed — the outside target survives", async () => {
      await staging.createArea("r1", "s1aaaaaa");
      const sentinel = path.join(outside, "sentinel.txt");
      fs.writeFileSync(sentinel, "do-not-delete");
      // A symlink INSIDE the staging folder pointing at the outside sentinel.
      fs.symlinkSync(sentinel, path.join(root, ".voidrift/cache/staging/r1", "evil-link"));

      await staging.removeForSession("s1aaaaaa");

      // The folder (and its symlink) are gone; the sentinel's target survives.
      expect(fs.existsSync(path.join(root, ".voidrift/cache/staging/r1"))).toBe(false);
      expect(fs.existsSync(sentinel)).toBe(true);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("do-not-delete");
    });
  });
});
