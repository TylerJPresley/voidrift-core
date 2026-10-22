/**
 * §3.1/§7.5 integration — a dispatched builtin `implementer` is carried through
 * the reviewer gate end to end, with the four default agents registered at boot
 * (no manual `register.agent`). A fake model satisfies the worker and returns
 * PASS for the reviewer; a real temp git repo gives the write-class implementer
 * its worktree, and the fan-out grant auto-approves the merge (§7.5/§9.5).
 */
import { hermeticTmp } from "./test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createCore } from "./boot.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
import { createMemoryCheckpointer } from "./adapters/checkpointer.js";
import type { FanoutResult } from "./use-cases/subagents.js";
import { seedAgentsInto } from "./test-support/seed-agents.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function makeRepo(): Promise<string> {
  const dir = hermeticTmp("s1");
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "checkout", "-q", "-B", "main");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".voidrift/\n");
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

/** A model that satisfies the worker and returns PASS for the reviewer. */
function passModel() {
  return new FakeListChatModel({ responses: ["PASS: step complete"] });
}

describe("§3.1/§7.5 — default implementer dispatched then reviewer-gated end to end", () => {
  let root: string;
  const cores: { session: { shutdown: () => Promise<void> } }[] = [];

  beforeEach(async () => {
    root = await makeRepo();
    cores.length = 0;
  });

  afterEach(async () => {
    for (const c of cores) await c.session.shutdown().catch(() => undefined);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("dispatches the seeded implementer (from the project folder), passes the reviewer gate, and merges", async () => {
    // Seed the project `.voidrift/agents/` with the default agents (what
    // config.init will do in A2); the runtime reads it at boot.
    seedAgentsInto(path.join(root, ".voidrift", "agents"));
    const ready = await createCore({
      workspaceRoot: root,
      configStore: new InMemoryConfigStore({
        models: { local: { model: "m", protocol: "openai", contextLimit: 32_000 } },
        modelSelected: "local",
      }),
      sessionRepository: new InMemorySessionRepository(),
      checkpointer: createMemoryCheckpointer(),
      chatModelFactory: () => passModel(),
    });
    cores.push(ready.api);
    const { api } = ready;

    // The implementer is a write-class agent seeded into the project folder.
    const list = await api.agents.list();
    expect(list.ok && list.value.some((a) => a.name === "implementer" && a.class === "write")).toBe(true);

    const transitions: string[] = [];
    api.events.subscribe("WORKER_STATUS_CHANGED", (e) => transitions.push((e.payload as { status: string }).status));

    const res = await api.subagents.dispatch([{ agent: "implementer", task: "carry out step 1" }]);
    expect(res.ok).toBe(true);
    const fanout = (res as { value: FanoutResult }).value;
    expect(fanout.workers).toHaveLength(1);
    // The worker ran in its own worktree, passed the reviewer gate, and merged.
    expect(fanout.workers[0]!.status).toBe("merged");
    expect(fanout.workers[0]!.worktree).toContain(path.join(".voidrift", "worktrees"));
    expect(transitions).toEqual(expect.arrayContaining(["running", "needs_review", "reviewed", "merged"]));
  });
});
