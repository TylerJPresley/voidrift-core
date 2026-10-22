/**
 * Regression: `createCore()` with NO injected stores must write only inside the
 * hermetic temp dir, never the user's real `~/.config/voidrift` (Part A of the
 * test-isolation defect). The per-package `test-hermetic.ts` setup has already
 * redirected `XDG_CONFIG_HOME`/`HOME` at a fresh `os.tmpdir()` directory for
 * this run; this test proves the default production wiring honors that redirect
 * — the global seed, logs, and credentials all resolve under the temp dir — so
 * the suite can never touch the real config directory.
 */
import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import { createCore, voidriftConfigDir } from "./boot.js";
import { createMemoryCheckpointer } from "./adapters/checkpointer.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";

describe("createCore default stores stay inside the hermetic temp dir (Part A)", () => {
  const workspaces: string[] = [];

  afterEach(async () => {
    for (const w of workspaces.splice(0)) await fs.rm(w, { recursive: true, force: true });
  });

  it("resolves the global dir under os.tmpdir and seeds the config there, not the real home", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "vr-partA-ws-"));
    workspaces.push(ws);

    // The hermetic setup points XDG_CONFIG_HOME at os.tmpdir(); the ONE resolver
    // must agree, so every global-scope root is under the temp dir.
    const globalDir = voidriftConfigDir();
    expect(globalDir.startsWith(os.tmpdir())).toBe(true);

    const { api } = await createCore({
      workspaceRoot: ws,
      sessionRepository: new InMemorySessionRepository(),
      checkpointer: createMemoryCheckpointer(),
      // No configStore / fileSystem injected: the real FilesystemConfigStore,
      // FilesystemMemoryStore, and global NDJSON error-log store run.
      chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
    });

    // §13.8 first-run seed landed under the temp global dir, not the real home.
    const seeded = JSON.parse(
      await fs.readFile(path.join(globalDir, "config.json"), "utf8"),
    ) as { modelSelected: string };
    expect(seeded.modelSelected).toBe("local");

    await api.session.shutdown();
  });
});
