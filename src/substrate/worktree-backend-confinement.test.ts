/**
 * Substrate tripwire — core-blueprint.md §1 assumption 3.
 *
 * A backend rooted at a worktree confines a worker's file and shell operations
 * to that worktree (§7.3).
 *
 * Pins the EXACT installed deepagents `LocalShellBackend`. The worktree
 * lifecycle itself is VoidRift's; this proves only the substrate guarantee the
 * blueprint relies on — that `LocalShellBackend({ rootDir })` roots both FS and
 * shell at `rootDir` and refuses path traversal out of it.
 *
 * Offline/deterministic: real temp dirs under os.tmpdir(), cleaned up; no
 * network, no model.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalShellBackend } from "deepagents";
import path from "node:path";
import fs from "node:fs/promises";

describe("substrate §1.3 — a worktree-rooted backend confines file and shell operations", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = hermeticTmp("substrate-root");
    outside = hermeticTmp("substrate-out");
    await fs.writeFile(path.join(outside, "secret.txt"), "SECRET-OUTSIDE-THE-ROOT");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("file writes land inside the root, and shell commands run rooted at the root", async () => {
    // Given a backend rooted at the worktree directory.
    const backend = await LocalShellBackend.create({ rootDir: root, virtualMode: true });
    try {
      // When the worker writes a file through a virtual path.
      await backend.write("/inside.txt", "hello-inside");

      // Then it lands on disk under the root, not elsewhere.
      expect(await fs.readdir(root)).toContain("inside.txt");

      // When the worker runs a shell command.
      const result = await backend.execute("pwd && echo shell-wrote > shellout.txt");

      // Then the shell's working directory is the root and its writes land there.
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(root);
      expect(await fs.readdir(root)).toContain("shellout.txt");
    } finally {
      await backend.close();
    }
  });

  it("path traversal out of the root is refused", async () => {
    // Given a backend rooted at the worktree directory and a secret file
    //   sitting outside the root.
    const backend = await LocalShellBackend.create({ rootDir: root, virtualMode: true });
    try {
      // When a read attempts to escape the root with `..`.
      const escape = await backend.read(`/../${path.basename(outside)}/secret.txt`);

      // Then the backend refuses the traversal rather than returning the secret.
      const serialized = JSON.stringify(escape);
      expect(serialized).toContain("Path traversal not allowed");
      expect(serialized).not.toContain("SECRET-OUTSIDE-THE-ROOT");
    } finally {
      await backend.close();
    }
  });
});
