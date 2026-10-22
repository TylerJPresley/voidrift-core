/**
 * Host-level `config.access` (cli-blueprint.md §7.4): the exported
 * `accessReportConfigHome` usable WITHOUT a core — no model, no network, no
 * engine. The CLI's `voidrift access` binds to it directly (§2.1); the TUI's
 * `/access` uses the facade method bound to the same host path.
 *
 * Each test points `XDG_CONFIG_HOME` at its OWN private temp dir, like the
 * config-doctor host tests, and restores the environment before teardown.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { accessReportConfigHome, initConfigHome, voidriftConfigDir } from "./boot.js";

let prevXdg: string | undefined;
const scratches: string[] = [];

async function isolate(): Promise<{ configDir: string; workspace: string }> {
  prevXdg = process.env["XDG_CONFIG_HOME"];
  const xdg = await fs.mkdtemp(path.join(os.tmpdir(), "vr-access-host-"));
  scratches.push(xdg);
  process.env["XDG_CONFIG_HOME"] = xdg;
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "vr-access-ws-"));
  scratches.push(workspace);
  return { configDir: voidriftConfigDir(), workspace };
}

async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else out.set(path.relative(root, abs), await fs.readFile(abs, "utf8"));
    }
  }
  await walk(root);
  return out;
}

afterEach(async () => {
  if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = prevXdg;
  while (scratches.length) await fs.rm(scratches.pop()!, { recursive: true, force: true });
});

describe("host-level config.access (§7.4)", () => {
  it("a seeded install reports the agents and allow list, writing NOTHING", async () => {
    const { configDir, workspace } = await isolate();
    await initConfigHome({ scope: "global" });
    const before = await snapshot(configDir);
    const report = await accessReportConfigHome({ workspaceRoot: workspace });
    // The built-in `chat` is always present; the seeded research/vibe agents are
    // discovered from the seeded directories.
    const names = report.agents.topLevel.map((a) => a.name);
    expect(names).toContain("chat");
    expect(report.agents.topLevel.find((a) => a.name === "chat")!.source).toBe("builtin");
    // Default active agent is the first top-level by order (chat, order 10).
    expect(report.activeAgent).toBe("chat");
    // The seeded allow list frees the read-class tools and the git patterns.
    expect(report.allowList.tools.some((t) => t.tool === "read_file")).toBe(true);
    expect(report.allowList.commands.some((cmd) => (cmd.pattern ?? "").startsWith("git status"))).toBe(true);
    // READ-ONLY: the config tree is byte-for-byte unchanged.
    const after = await snapshot(configDir);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
    // No session/journal dir was created in the workspace.
    await expect(fs.access(path.join(workspace, ".voidrift", "sessions"))).rejects.toBeTruthy();
  });

  it("selects the named top-level agent when given", async () => {
    const { workspace } = await isolate();
    await initConfigHome({ scope: "global" });
    const report = await accessReportConfigHome({ agent: "research", workspaceRoot: workspace });
    // `research` is seeded unlisted: deny.
    expect(report.activeAgent).toBe("research");
    expect(report.unlistedBehaviour).toBe("are denied");
  });

  it("works with NO config at all (built-in chat only)", async () => {
    const { workspace } = await isolate();
    const report = await accessReportConfigHome({ workspaceRoot: workspace });
    expect(report.agents.topLevel.map((a) => a.name)).toEqual(["chat"]);
    expect(report.activeAgent).toBe("chat");
  });

  it("is NOT a model tool (absent from the built-in tool registry)", async () => {
    const { builtinToolDefinitions } = await import("./tools/builtin.js");
    const names = builtinToolDefinitions().map((d) => d.def.name);
    expect(names).not.toContain("access");
    expect(names).not.toContain("config_access");
  });
});
