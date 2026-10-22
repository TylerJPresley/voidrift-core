/**
 * The init filesystem port (core-blueprint.md §1 rule 6, §13.9).
 *
 * `config.init` (§13.9.1) materializes the GLOBAL installation under
 * `~/.config/voidrift/` and a PROJECT skeleton under `<dir>/.voidrift/`. Both
 * live at ABSOLUTE paths the workspace-confined `FileSystemPort` (§8.2) cannot
 * address — the global dir is outside the workspace, and a project `dir` may be
 * any directory — so init reads and writes through this dedicated port instead,
 * which operates on absolute paths with private modes (0700 dirs, 0600 files).
 * The node adapter is the default; a test injects an in-memory or temp-dir
 * implementation (§1 rule 7).
 */

export interface InitFs {
  /** Read a file as UTF-8, or null when it does not exist / is unreadable. */
  readFile(absPath: string): Promise<string | null>;
  /** True when a path exists (file or directory). */
  exists(absPath: string): Promise<boolean>;
  /** Create a directory (recursive) with mode 0700. */
  mkdirp(absPath: string): Promise<void>;
  /** Atomically write a file 0600, creating parent dirs 0700 (§8.3 convention). */
  writeFile(absPath: string, content: string): Promise<void>;
  /** Rename/move a file (used to set a broken file aside as `.rejected`). */
  rename(from: string, to: string): Promise<void>;
  /** Copy a seed template file from the package into the installation (0600). */
  copyFile(fromAbs: string, toAbs: string): Promise<void>;
  /** List the immediate entries of a directory as `{ name, isDir }`, or `[]`
   * when the directory is absent/unreadable. Used by the live-directory sweep
   * and the backup-set retention pruner (§13.9.1). */
  listDir(absPath: string): Promise<{ name: string; isDir: boolean }[]>;
  /** Remove a file or an entire directory tree (recursive), tolerating absence.
   * Used by backup-set retention (prune the oldest set) (§13.9.1). */
  remove(absPath: string): Promise<void>;
}
