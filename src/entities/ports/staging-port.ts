/**
 * The durable staging port (core-blueprint.md §7.4).
 *
 * With no git repo, workers stage through a read-through, durable staging layer
 * the core provides instead of touching disk. The subagents use-case depends on
 * this port; the filesystem staging adapter implements it with temp-and-rename
 * durability under `.voidrift/cache/staging/{run}/`. Durability (temp-and-rename
 * atomicity) is why this is an adapter and not a pure entity.
 */
import type { ApplyCheck, StagingManifest } from "../staging-manifest.js";

/** A created staging folder for a run (§7.4). */
export interface StagingArea {
  run: string;
  /** The absolute `.voidrift/cache/staging/{run}` path. */
  path: string;
}

/** The result of applying one staged folder's changes sequentially (§7.4). */
export interface StagingApplyResult {
  /** Target paths written to the user's tree. */
  applied: string[];
  /** Per-file checks that did NOT apply (unreliable or conflict), reported to the orchestrator. */
  blocked: ApplyCheck[];
}

export interface StagingPort {
  /**
   * Create the staging folder for a run and write its initial (empty) manifest
   * through temp-and-rename (§7.4). The returned path roots this run's staging.
   * `sessionId` (§5.8) is recorded in the manifest so `session.delete` can prove
   * which session owns a run folder before removing it.
   */
  createArea(run: string, sessionId?: string): Promise<StagingArea>;

  /**
   * Stage a write (§7.4): read the current disk base, record base + staged-content
   * hashes in the manifest, write the staged content to a blob and the updated
   * manifest — each through temp-and-rename so a crash never leaves a half-written
   * staged file or a manifest that disagrees with it.
   */
  stageWrite(run: string, targetPath: string, content: string): Promise<void>;

  /**
   * Read-through read (§7.4): the staged content when the path is staged in this
   * run, else the disk content, else null when neither exists.
   */
  read(run: string, targetPath: string): Promise<string | null>;

  /** Load a run's manifest, or null when the folder/manifest is absent (§7.4). */
  manifest(run: string): Promise<StagingManifest | null>;

  /**
   * Apply a run's staged changes SEQUENTIALLY inside a per-run critical section
   * (§7.4). For each file: re-hash the staged blob against the manifest's staged
   * hash (disagreement = unreliable, not applied); re-verify the disk hash against
   * the base hash (changed base = conflict, not applied); then write new content
   * to a temp file in the DESTINATION dir and atomic-rename over the target. On a
   * fully clean apply the staging folder is discarded.
   */
  apply(run: string): Promise<StagingApplyResult>;

  /** Discard a run's staging folder without applying (recovery discard, §7.4). */
  discard(run: string): Promise<void>;

  /** List staging run ids present on disk — used by recovery on resume/boot (§7.4). */
  listRuns(): Promise<string[]>;

  /**
   * Prune staging folders whose owning pid is dead AND older than `ttlMinutes`,
   * mirroring the worktree boot cleanup (§7.3 step 5 / §7.4). Returns pruned runs.
   */
  bootCleanup(ttlMinutes: number): Promise<string[]>;

  /**
   * Remove every staging folder OWNED BY `sessionId` (§5.8) and report the bytes
   * reclaimed and the run ids removed. Ownership is proven from each manifest's
   * recorded `sessionId`; a folder with no/other session id is left untouched, so
   * a session delete can never remove another session's (or an orphan's) staging.
   */
  removeForSession(sessionId: string): Promise<{ reclaimedBytes: number; removedRuns: string[] }>;
}
