/**
 * Process marker helpers for POSIX-portable test execution.
 *
 * Tests that verify process lifecycle (cancellation, cleanup) need to identify
 * and track processes by argv[0]. Bash's `exec -a <marker>` is not POSIX (dash
 * on Ubuntu does not support it). Instead, create a symlink with the marker name
 * pointing to the real binary, and run it by that path. This is portable across
 * any POSIX sh and gives argv[0] the symlink path for identification.
 */

import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Resolve a binary name (e.g. "sleep", "sh") to its full path via PATH lookup,
 * without relying on a hardcoded path like /bin/sleep.
 */
export function findBinaryInPath(binaryName: string): string {
  try {
    // Use Node's child_process to find the binary the same way the shell does.
    // `which` is not available on all systems, so we use execSync with a shell
    // to invoke `command -v`, the POSIX portable binary lookup.
    const result = execSync(`command -v ${binaryName}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (!result) {
      throw new Error(`Binary not found: ${binaryName}`);
    }
    return result;
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to locate binary '${binaryName}': ${err}`);
  }
}

/**
 * Create a process marker by symlinking a binary under a unique marker name.
 * Returns the path to the symlink that should be executed to set argv[0].
 *
 * Example:
 *   const marker = "vrmark_test_123";
 *   const markerPath = await createProcessMarker("/tmp/ws", marker, "sleep");
 *   // Now run: markerPath + " 30" will execute sleep with argv[0] = markerPath
 */
export async function createProcessMarker(
  workspaceDir: string,
  marker: string,
  binaryName: string,
): Promise<string> {
  const binaryPath = findBinaryInPath(binaryName);
  const markerPath = path.join(workspaceDir, marker);

  // Create a symlink from marker -> binary.
  // If it already exists (should not happen in a hermetic test), remove it first.
  try {
    await fs.rm(markerPath, { force: true });
  } catch {
    // Ignore errors; we'll fail on symlink creation if there is a real problem.
  }

  await fs.symlink(binaryPath, markerPath);
  return markerPath;
}
