/**
 * Host-level `config.init` (core-blueprint.md §13.9.1): the exported
 * `initConfigHome`, `previewInitReset`, `initResetNames`, and `isFirstRun`
 * usable WITHOUT a core — no model, no network, no engine. The CLI's
 * `voidrift init` binds to these directly (CLI §2.1).
 *
 * Each test points `XDG_CONFIG_HOME` at its OWN private temp dir so it never
 * reads or writes the shared hermetic config dir, and restores the environment
 * before teardown so the hermetic `afterAll` still sees the redirect. A test
 * NEVER asserts anything about the ambient HOME/XDG.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initConfigHome, previewInitReset, initResetNames, isFirstRun, voidriftConfigDir } from "./boot.js";
import { ConfigSchema } from "./config/schema.js";

let prevXdg: string | undefined;
const scratches: string[] = [];

async function isolate(): Promise<string> {
  prevXdg = process.env["XDG_CONFIG_HOME"];
  const xdg = await fs.mkdtemp(path.join(os.tmpdir(), "vr-init-host-"));
  scratches.push(xdg);
  process.env["XDG_CONFIG_HOME"] = xdg;
  return voidriftConfigDir();
}

afterEach(async () => {
  if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = prevXdg;
  while (scratches.length) await fs.rm(scratches.pop()!, { recursive: true, force: true });
});

describe("host-level config.init (§13.9.1)", () => {
  it("isFirstRun is true before seeding, false after", async () => {
    const dir = await isolate();
    expect(isFirstRun()).toBe(true);
    const r = await initConfigHome({ scope: "global" });
    expect(r.ok).toBe(true);
    expect(existsSync(path.join(dir, "config.json"))).toBe(true);
    expect(isFirstRun()).toBe(false);
  });

  it("initConfigHome global creates the base and is idempotent", async () => {
    await isolate();
    const first = await initConfigHome({ scope: "global" });
    expect(first.ok && first.value.created.length).toBeGreaterThan(0);
    const second = await initConfigHome({ scope: "global" });
    expect(second.ok && second.value.created).toEqual([]);
    expect(second.ok && second.value.repaired).toEqual([]);
    expect(second.ok && second.value.leftAlone.length).toBeGreaterThan(0);
  });

  it("initConfigHome project creates <dir>/.voidrift/ and leaves the global dir alone", async () => {
    const globalDir = await isolate();
    const proj = await fs.mkdtemp(path.join(os.tmpdir(), "vr-init-proj-"));
    scratches.push(proj);
    const r = await initConfigHome({ scope: "project", dir: proj });
    expect(r.ok && r.value.created).toEqual(["config.json"]);
    expect(existsSync(path.join(proj, ".voidrift", "config.json"))).toBe(true);
    expect(existsSync(path.join(proj, ".voidrift", "agents"))).toBe(true);
    expect(existsSync(globalDir)).toBe(false);
  });

  it("initResetNames lists config plus the seven seeded agents and the seeded skills", () => {
    expect(initResetNames().sort()).toEqual(
      ["config", "implementer", "planner", "research", "researcher", "reviewer", "summarizer", "systems-thinking", "vibe"].sort(),
    );
  });

  it("previewInitReset returns current + default content for a seeded agent", async () => {
    await isolate();
    await initConfigHome({ scope: "global" });
    const r = await previewInitReset("researcher");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((f) => f.rel).sort()).toEqual([
      "agents/researcher/agent.json",
      "agents/researcher/prompt.md",
    ]);
    for (const f of r.value) {
      expect(typeof f.def).toBe("string");
      expect(f.current).not.toBeNull();
    }
  });

  it("previewInitReset config returns the default config.json document", async () => {
    await isolate();
    await initConfigHome({ scope: "global" });
    const r = await previewInitReset("config");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(1);
    expect(r.value[0]!.rel).toBe("config.json");
    expect(ConfigSchema.safeParse(JSON.parse(r.value[0]!.def)).success).toBe(true);
  });

  it("previewInitReset of an unknown name is INVALID_INPUT", async () => {
    await isolate();
    const r = await previewInitReset("nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
  });
});
