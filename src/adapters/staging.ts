/**
 * The durable staging adapter (core-blueprint.md §7.4).
 *
 * VoidRift-built because deepagents has no read-through staging backend (D5).
 * With no git repo there is no file safety net, so a writer stages here instead
 * of touching disk; reads check staging first, then disk. Staging is durable:
 * every staged write is persisted to `.voidrift/cache/staging/{run}/` with a
 * manifest recording, per file, the disk BASE hash (conflict detection) and the
 * staged CONTENT hash (integrity) — both from the ONE hash utility (§8.2).
 *
 * The staged blob and the manifest are each written through TEMP-AND-RENAME:
 * content is written to a temporary file in the SAME directory and atomically
 * renamed into place, so a crash mid-write never leaves a half-written staged
 * file or a manifest that disagrees with it. Apply runs in a per-run critical
 * section with the two re-hash checks and a destination-dir temp-and-rename,
 * closing the check-then-write race (§7.4).
 *
 * It touches disk only through `node:fs` (the filesystem boundary) and
 * implements `StagingPort`. Dead-owner + TTL prune mirrors the VCS worktree
 * boot cleanup (§7.3 step 5), reusing the same pid/TTL rule.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { purgeDir } from "./fs-purge.js";
import {
  checkApply,
  maskManifest,
  newManifest,
  resolveWithinRoot,
  stageEntry,
  upsertEntry,
  type StagingManifest,
} from "../entities/staging-manifest.js";
import type { ApplyCheck } from "../entities/staging-manifest.js";
import type { StagingApplyResult, StagingArea, StagingPort } from "../entities/ports/staging-port.js";

const STAGING_DIR = ".voidrift/cache/staging";
const MANIFEST_FILE = "manifest.json";

export class FilesystemStagingAdapter implements StagingPort {
  constructor(private readonly root: string) {}

  private areaPath(run: string): string {
    return path.join(this.root, STAGING_DIR, run);
  }

  private manifestPath(run: string): string {
    return path.join(this.areaPath(run), MANIFEST_FILE);
  }

  /**
   * Resolve a workspace-relative target to a canonical absolute path contained
   * within the staging root, or null when it escapes — the no-repo mirror of the
   * §8.2 file-tool containment (`LocalShellBackend` "Path traversal not allowed").
   * Two layers, same source of truth: lexical (`resolveWithinRoot` — absolute or
   * `../` escape) then symlink (realpath the deepest existing ancestor, so a
   * boundary-crossing symlink whose real path leaves the root is also refused).
   */
  private containedAbs(targetPath: string): string | null {
    const abs = resolveWithinRoot(this.root, targetPath);
    if (abs === null) return null;
    const rootReal = this.realRoot();
    // Walk up to the nearest existing ancestor and realpath it; a symlink in the
    // chain that points outside the root makes the real path escape — refuse it.
    let probe = abs;
    while (!existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    try {
      const real = realpathSync(probe);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null;
    } catch {
      return null;
    }
    return abs;
  }

  private realRoot(): string {
    try {
      return realpathSync(this.root);
    } catch {
      return path.resolve(this.root);
    }
  }

  /** Atomic write: temp file in the SAME directory, then rename over the target. */
  private atomicWrite(target: string, content: string): void {
    const dir = path.dirname(target);
    mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, target);
  }

  private readManifestSync(run: string): StagingManifest | null {
    const mp = this.manifestPath(run);
    if (!existsSync(mp)) return null;
    try {
      return JSON.parse(readFileSync(mp, "utf8")) as StagingManifest;
    } catch {
      return null;
    }
  }

  private writeManifest(run: string, manifest: StagingManifest): void {
    // The manifest is masked for durable write (§7.4, §10.10) and written
    // temp-and-rename so it never disagrees with the blobs it indexes.
    this.atomicWrite(this.manifestPath(run), JSON.stringify(maskManifest(manifest), null, 2));
  }

  /** The disk content of a CONTAINED target, or empty string when absent/escaping. */
  private diskContent(targetPath: string): string {
    const abs = this.containedAbs(targetPath);
    if (abs === null) return "";
    return existsSync(abs) ? readFileSync(abs, "utf8") : "";
  }

  async createArea(run: string, sessionId?: string): Promise<StagingArea> {
    const area = this.areaPath(run);
    mkdirSync(area, { recursive: true });
    if (!existsSync(this.manifestPath(run))) {
      this.writeManifest(run, newManifest(run, process.pid, sessionId));
    }
    return { run, path: area };
  }

  async stageWrite(run: string, targetPath: string, content: string): Promise<void> {
    // Stage-time containment (§8.2, §15.1#8): a target that is absolute, escapes
    // via `../`, or crosses the boundary through a symlink is REFUSED hard here —
    // never persisted — so the manifest can never carry an out-of-tree target.
    if (this.containedAbs(targetPath) === null) {
      throw new Error(`Path traversal not allowed: ${targetPath} escapes the workspace root`);
    }
    const manifest = this.readManifestSync(run) ?? newManifest(run);
    // A stable blob name per target so a re-stage of the same path overwrites it.
    const blob = encodeURIComponent(targetPath);
    const base = this.diskContent(targetPath);
    // Write the staged blob first, temp-and-rename; then the manifest that indexes
    // it. If a crash lands between the two, the blob exists but is unreferenced
    // (ignored), never the reverse — the manifest never points at a missing blob.
    this.atomicWrite(path.join(this.areaPath(run), blob), content);
    const next = upsertEntry(manifest, stageEntry(targetPath, base, content, blob));
    this.writeManifest(run, next);
  }

  async read(run: string, targetPath: string): Promise<string | null> {
    // Read-through: staging first, then disk (§7.4). A target that escapes the
    // root is refused (§8.2) — never read from outside the workspace.
    if (this.containedAbs(targetPath) === null) return null;
    const manifest = this.readManifestSync(run);
    const entry = manifest?.files.find((f) => f.path === targetPath);
    if (entry) {
      const blobPath = path.join(this.areaPath(run), entry.blob);
      if (existsSync(blobPath)) return readFileSync(blobPath, "utf8");
    }
    const abs = this.containedAbs(targetPath)!;
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  }

  async manifest(run: string): Promise<StagingManifest | null> {
    return this.readManifestSync(run);
  }

  async apply(run: string): Promise<StagingApplyResult> {
    const manifest = this.readManifestSync(run);
    const applied: string[] = [];
    const blocked: ApplyCheck[] = [];
    if (!manifest) return { applied, blocked };

    // Per-run critical section: sequential, one file at a time (§7.4).
    for (const entry of manifest.files) {
      // Apply-time containment (§8.2, §15.1#8): re-resolve against the root and
      // HARD-BLOCK any entry that is absolute or escapes — even a crafted/corrupted
      // manifest cannot write outside the workspace. Reported, never written.
      const dest = this.containedAbs(entry.path);
      if (dest === null) {
        blocked.push({ ok: false, reason: "escape", path: entry.path });
        continue;
      }
      const blobPath = path.join(this.areaPath(run), entry.blob);
      const stagedNow = existsSync(blobPath) ? readFileSync(blobPath, "utf8") : "";
      const diskNow = this.diskContent(entry.path);
      // Two re-hash checks, in order: integrity (unreliable) then conflict.
      const check = checkApply(entry, stagedNow, diskNow);
      if (!check.ok) {
        blocked.push(check);
        continue;
      }
      // Write new content to a temp file in the DESTINATION dir and atomic-rename
      // over the target — closing the check-then-write race (§7.4).
      this.atomicWrite(dest, stagedNow);
      applied.push(entry.path);
    }
    // A fully clean apply discards the folder; a partial apply (any block) keeps
    // it so the orchestrator can re-dispatch against current files (§7.4).
    if (blocked.length === 0) await this.discard(run);
    return { applied, blocked };
  }

  async discard(run: string): Promise<void> {
    const area = this.areaPath(run);
    if (existsSync(area)) rmSync(area, { recursive: true, force: true });
  }

  async listRuns(): Promise<string[]> {
    const dir = path.join(this.root, STAGING_DIR);
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir).filter((run) => existsSync(this.manifestPath(run)));
    } catch {
      return [];
    }
  }

  async bootCleanup(ttlMinutes: number): Promise<string[]> {
    const pruned: string[] = [];
    for (const run of await this.listRuns()) {
      const manifest = this.readManifestSync(run);
      if (!manifest) continue;
      const ageMinutes = (Date.now() - new Date(manifest.timestamp).getTime()) / 60_000;
      if (!this.isDeadPid(manifest.pid)) continue; // owner still alive — leave it
      if (ageMinutes <= ttlMinutes) continue; // not stale enough yet
      await this.discard(run);
      pruned.push(run);
    }
    return pruned;
  }

  /** True when the process that owned a staging folder is gone (§7.3 step 5 rule). */
  private isDeadPid(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }

  async removeForSession(sessionId: string): Promise<{ reclaimedBytes: number; removedRuns: string[] }> {
    // §5.8 — remove ONLY the staging folders this session owns. Ownership is
    // proven from the manifest's recorded `sessionId`; a folder with no/other
    // session id is left untouched, so a session delete can never reach another
    // session's (or an orphan's) staging. The run id is a staging folder name
    // under the fixed staging root, so the path can never escape.
    let reclaimedBytes = 0;
    const removedRuns: string[] = [];
    for (const run of await this.listRuns()) {
      const manifest = this.readManifestSync(run);
      if (!manifest || manifest.sessionId !== sessionId) continue;
      reclaimedBytes += purgeDir(this.areaPath(run));
      removedRuns.push(run);
    }
    return { reclaimedBytes, removedRuns };
  }
}
