/**
 * Host-level live-directory scanner and sweep (core-blueprint.md §13.9.1).
 *
 * Exercises `scanLiveLeftovers` (the startup gate's detector) and
 * `sweepConfigHome` against the hermetic global config dir (the per-package
 * setup redirects `XDG_CONFIG_HOME` at a temp dir) and a fresh temp workspace,
 * so nothing touches the real `~/.config/voidrift`.
 */
import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { scanLiveLeftovers, sweepConfigHome, voidriftConfigDir } from "./boot.js";

describe("scanLiveLeftovers + sweepConfigHome (§13.9.1)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
    // Clean the global live dirs this test wrote under the hermetic config dir.
    const g = voidriftConfigDir();
    for (const p of ["agents", "skills", "prompts", "backups", "config.json.bak-xyz"]) {
      await fs.rm(path.join(g, p), { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("a leftover inside a global agents/<name>/ dir is detected; a clean tree is not", async () => {
    const g = voidriftConfigDir();
    expect(g.startsWith(os.tmpdir())).toBe(true);
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "vr-scan-ws-"));
    dirs.push(ws);

    // Clean: nothing offending.
    expect(await scanLiveLeftovers(ws)).toEqual([]);

    // A `.bak` beside a canonical file in a live dir → detected.
    const reviewer = path.join(g, "agents", "reviewer");
    await fs.mkdir(reviewer, { recursive: true });
    await fs.writeFile(path.join(reviewer, "agent.json"), "{}");
    await fs.writeFile(path.join(reviewer, "agent.json.bak"), "old");
    const found = await scanLiveLeftovers(ws);
    expect(found).toContain(path.join(reviewer, "agent.json.bak"));
  });

  it("a project .voidrift/skills leftover and a `~` editor file are detected", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "vr-scan-pws-"));
    dirs.push(ws);
    const skillDir = path.join(ws, ".voidrift", "skills", "mine");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "x");
    await fs.writeFile(path.join(skillDir, "SKILL.md~"), "x");
    const found = await scanLiveLeftovers(ws);
    expect(found).toContain(path.join(skillDir, "SKILL.md~"));
  });

  it("a config-ROOT leftover never counts as a startup blocker", async () => {
    const g = voidriftConfigDir();
    await fs.mkdir(g, { recursive: true });
    await fs.writeFile(path.join(g, "config.json.bak-xyz"), "old");
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "vr-scan-root-"));
    dirs.push(ws);
    expect(await scanLiveLeftovers(ws)).toEqual([]);
  });

  it("sweepConfigHome moves a global live-dir leftover and a config-root leftover, then the scan is clean", async () => {
    const g = voidriftConfigDir();
    const reviewer = path.join(g, "agents", "reviewer");
    await fs.mkdir(reviewer, { recursive: true });
    await fs.writeFile(path.join(reviewer, "agent.json"), "{}");
    await fs.writeFile(path.join(reviewer, "agent.json.orig"), "old");
    await fs.writeFile(path.join(g, "config.json.bak-xyz"), "root");
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "vr-sweep-ws-"));
    dirs.push(ws);

    const r = await sweepConfigHome();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.moved).toEqual(
      expect.arrayContaining([path.join(reviewer, "agent.json.orig"), path.join(g, "config.json.bak-xyz")]),
    );
    // Canonical file untouched; leftovers gone.
    expect(existsSync(path.join(reviewer, "agent.json"))).toBe(true);
    expect(existsSync(path.join(reviewer, "agent.json.orig"))).toBe(false);
    expect(existsSync(path.join(g, "config.json.bak-xyz"))).toBe(false);
    // The startup scan is now clean.
    expect(await scanLiveLeftovers(ws)).toEqual([]);
  });
});
