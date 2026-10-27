/**
 * `config.init` — seed and repair semantics (core-blueprint.md §13.9.1).
 *
 * Exercises the use-case through the REAL `NodeInitFs` against a fresh temp dir
 * (a scratch `globalDir`, NOT the hermetic config dir — these tests assert file
 * modes and content and must not depend on the ambient HOME/XDG state). The
 * seed templates are read from the package's own `seed/agents` via the same
 * module-relative resolver boot uses, so the templates are exercised as shipped.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import { statSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigInit, SEED_AGENTS, SEED_SKILLS } from "./config-init.js";
import { NodeInitFs } from "../adapters/init-fs.js";
import { ConfigSchema } from "../config/schema.js";
import { FilesystemAdapter } from "../adapters/filesystem.js";
import { SkillsDirectory } from "../adapters/skills-directory.js";
import { Skills } from "./skills.js";
import { EventBus } from "../entities/event-bus.js";
import { ToolRegistry } from "../entities/tool-registry.js";

/** The package seed/agents dir, resolved module-relative like boot's helper. */
const SEED_AGENTS_DIR = fileURLToPath(new URL("../../seed/agents/", import.meta.url));

/** Read the single backed-up copy of `rel` from the backup tree under
 * `<globalDir>/backups/<ts>/<rel>` (§13.9.1). Fails the test when there is not
 * exactly one backup set containing it. */
async function readBackup(globalDir: string, rel: string): Promise<string> {
  const backupsDir = path.join(globalDir, "backups");
  const sets = (await fs.readdir(backupsDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const hits: string[] = [];
  for (const s of sets) {
    const abs = path.join(backupsDir, s, rel);
    if (existsSync(abs)) hits.push(await fs.readFile(abs, "utf8"));
  }
  if (hits.length !== 1) throw new Error(`expected exactly one backup of ${rel}, found ${hits.length}`);
  return hits[0]!;
}

/** All default files a healthy global install has, relative to the root. */
function expectedGlobalTree(): string[] {
  const out = ["config.json"];
  for (const a of SEED_AGENTS) {
    out.push(path.posix.join("agents", a, "agent.json"), path.posix.join("agents", a, "prompt.md"));
  }
  for (const s of SEED_SKILLS) {
    out.push(path.posix.join("skills", s, "SKILL.md"));
  }
  return out.sort();
}

describe("config.init (§13.9.1)", () => {
  let scratch: string;
  let globalDir: string;
  let init: ConfigInit;

  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "vr-init-test-"));
    globalDir = path.join(scratch, "voidrift");
    init = new ConfigInit(new NodeInitFs(), globalDir, () => SEED_AGENTS_DIR);
  });
  afterEach(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it("empty → creates the exact tree with private modes (dirs 0700, files 0600)", async () => {
    const r = await init.run({ scope: "global" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.created).toEqual(expectedGlobalTree());
    expect(r.value.repaired).toEqual([]);
    expect(r.value.leftAlone).toEqual([]);
    // Files exist with 0600; directories 0700.
    for (const rel of expectedGlobalTree()) {
      const abs = path.join(globalDir, rel);
      expect(existsSync(abs), rel).toBe(true);
      expect(statSync(abs).mode & 0o777, `${rel} mode`).toBe(0o600);
    }
    for (const dir of [globalDir, path.join(globalDir, "agents"), path.join(globalDir, "agents", "research")]) {
      expect(statSync(dir).mode & 0o777, dir).toBe(0o700);
    }
  });

  it("second run is a no-op: leftAlone lists everything, tree unchanged", async () => {
    await init.run({ scope: "global" });
    const before = new Map<string, string>();
    for (const rel of expectedGlobalTree()) before.set(rel, await fs.readFile(path.join(globalDir, rel), "utf8"));
    const r = await init.run({ scope: "global" });
    expect(r.ok && r.value.leftAlone).toEqual(expectedGlobalTree());
    expect(r.ok && r.value.created).toEqual([]);
    expect(r.ok && r.value.repaired).toEqual([]);
    for (const [rel, content] of before) {
      expect(await fs.readFile(path.join(globalDir, rel), "utf8"), rel).toBe(content);
    }
  });

  it("a deleted default is recreated (only that one)", async () => {
    await init.run({ scope: "global" });
    const target = path.join(globalDir, "agents", "planner", "agent.json");
    await fs.rm(target);
    const r = await init.run({ scope: "global" });
    expect(r.ok && r.value.created).toEqual(["agents/planner/agent.json"]);
    expect(r.ok && r.value.repaired).toEqual([]);
    expect(existsSync(target)).toBe(true);
  });

  it("a corrupted config.json is preserved as .rejected (content equal) and replaced", async () => {
    await init.run({ scope: "global" });
    const cfg = path.join(globalDir, "config.json");
    const broken = "{ not valid json";
    await fs.writeFile(cfg, broken);
    const r = await init.run({ scope: "global" });
    expect(r.ok && r.value.repaired).toContain("config.json");
    expect(await fs.readFile(cfg + ".rejected", "utf8")).toBe(broken);
    // Replaced with a valid default.
    expect(ConfigSchema.safeParse(JSON.parse(await fs.readFile(cfg, "utf8"))).success).toBe(true);
  });

  it("a corrupted agent.json is moved to the backup tree and replaced (no sibling in the live dir)", async () => {
    await init.run({ scope: "global" });
    const agent = path.join(globalDir, "agents", "reviewer", "agent.json");
    const broken = '{"name":"reviewer","kind":"worker","tools":["task"]}'; // worker holding task → invalid? actually missing description → invalid
    await fs.writeFile(agent, broken);
    const r = await init.run({ scope: "global" });
    expect(r.ok && r.value.repaired).toContain("agents/reviewer/agent.json");
    // The broken content is in the backup tree, NOT beside the live file.
    expect(await readBackup(globalDir, "agents/reviewer/agent.json")).toBe(broken);
    expect(existsSync(agent + ".rejected")).toBe(false);
    expect(existsSync(agent + ".previous")).toBe(false);
    // The live dir holds only its canonical files.
    const live = (await fs.readdir(path.join(globalDir, "agents", "reviewer"))).sort();
    expect(live).toEqual(["agent.json", "prompt.md"]);
  });

  it("a customized VALID prompt.md is left byte-for-byte unchanged", async () => {
    await init.run({ scope: "global" });
    const prompt = path.join(globalDir, "agents", "vibe", "prompt.md");
    const custom = "# My own vibe prompt\nDo it my way.\n";
    await fs.writeFile(prompt, custom);
    const r = await init.run({ scope: "global" });
    expect(r.ok && r.value.leftAlone).toContain("agents/vibe/prompt.md");
    expect(await fs.readFile(prompt, "utf8")).toBe(custom);
  });

  it("an existing .rejected is never overwritten (oldest kept; new takes a numeric suffix)", async () => {
    await init.run({ scope: "global" });
    const cfg = path.join(globalDir, "config.json");
    // First corruption → .rejected
    await fs.writeFile(cfg, "broken-1");
    await init.run({ scope: "global" });
    expect(await fs.readFile(cfg + ".rejected", "utf8")).toBe("broken-1");
    // Second corruption → .rejected.1, the original .rejected untouched.
    await fs.writeFile(cfg, "broken-2");
    await init.run({ scope: "global" });
    expect(await fs.readFile(cfg + ".rejected", "utf8")).toBe("broken-1");
    expect(await fs.readFile(cfg + ".rejected.1", "utf8")).toBe("broken-2");
  });

  it("reset without confirmed refuses and changes nothing", async () => {
    await init.run({ scope: "global" });
    const prompt = path.join(globalDir, "agents", "planner", "prompt.md");
    const custom = "custom planner\n";
    await fs.writeFile(prompt, custom);
    const r = await init.run({ scope: "global", reset: ["planner"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
    expect(await fs.readFile(prompt, "utf8")).toBe(custom);
    expect(existsSync(prompt + ".rejected")).toBe(false);
  });

  it("reset with confirmed restores one file and moves the old into the backup tree", async () => {
    await init.run({ scope: "global" });
    const prompt = path.join(globalDir, "agents", "planner", "prompt.md");
    const seeded = await fs.readFile(prompt, "utf8");
    const custom = "custom planner\n";
    await fs.writeFile(prompt, custom);
    const r = await init.run({ scope: "global", reset: ["planner"], confirmed: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.repaired).toContain("agents/planner/prompt.md");
    expect(await readBackup(globalDir, "agents/planner/prompt.md")).toBe(custom);
    expect(existsSync(prompt + ".rejected")).toBe(false);
    expect(await fs.readFile(prompt, "utf8")).toBe(seeded);
  });

  it("reset config restores config.json with confirmation", async () => {
    await init.run({ scope: "global" });
    const cfg = path.join(globalDir, "config.json");
    await fs.writeFile(cfg, '{"models":{}}');
    const refused = await init.run({ scope: "global", reset: ["config"] });
    expect(refused.ok).toBe(false);
    const done = await init.run({ scope: "global", reset: ["config"], confirmed: true });
    expect(done.ok && done.value.repaired).toEqual(["config.json"]);
    expect(ConfigSchema.safeParse(JSON.parse(await fs.readFile(cfg, "utf8"))).success).toBe(true);
  });

  it("reset of an unknown target is INVALID_INPUT", async () => {
    await init.run({ scope: "global" });
    const r = await init.run({ scope: "global", reset: ["nope"], confirmed: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
  });

  // ── seeded skills (§12.1, §13.9.1) ──────────────────────────────────────────
  const skillFile = (name: string) => path.join(globalDir, "skills", name, "SKILL.md");

  it("fresh init creates skills/systems-thinking/SKILL.md with valid frontmatter (0600)", async () => {
    const r = await init.run({ scope: "global" });
    expect(r.ok && r.value.created).toContain("skills/systems-thinking/SKILL.md");
    const abs = skillFile("systems-thinking");
    expect(existsSync(abs)).toBe(true);
    expect(statSync(abs).mode & 0o777).toBe(0o600);
    const body = await fs.readFile(abs, "utf8");
    expect(body).toMatch(/^---\nname: systems-thinking\n/);
    expect(body).toContain("# Systems thinking");
  });

  it("a customized VALID SKILL.md is left byte-for-byte unchanged on re-init", async () => {
    await init.run({ scope: "global" });
    const abs = skillFile("systems-thinking");
    // A valid skill (name must equal the dir name) with a customized body.
    const custom = "---\nname: systems-thinking\ndescription: my own.\n---\n\n# Mine\n\nCustom body.\n";
    await fs.writeFile(abs, custom);
    const r = await init.run({ scope: "global" });
    expect(r.ok && r.value.leftAlone).toContain("skills/systems-thinking/SKILL.md");
    expect(await fs.readFile(abs, "utf8")).toBe(custom);
  });

  it("a broken-frontmatter SKILL.md is moved to the backup tree and replaced (no sibling)", async () => {
    await init.run({ scope: "global" });
    const abs = skillFile("systems-thinking");
    const broken = "no frontmatter here\njust text\n";
    await fs.writeFile(abs, broken);
    const r = await init.run({ scope: "global" });
    expect(r.ok && r.value.repaired).toContain("skills/systems-thinking/SKILL.md");
    expect(await readBackup(globalDir, "skills/systems-thinking/SKILL.md")).toBe(broken);
    expect(existsSync(abs + ".rejected")).toBe(false);
    // Replaced with the valid shipped default.
    expect(await fs.readFile(abs, "utf8")).toMatch(/^---\nname: systems-thinking\n/);
    // The live skill dir holds only its canonical file.
    expect((await fs.readdir(path.join(globalDir, "skills", "systems-thinking"))).sort()).toEqual(["SKILL.md"]);
  });

  it("init --reset systems-thinking restores after confirmation, moving the old into the backup tree", async () => {
    await init.run({ scope: "global" });
    const abs = skillFile("systems-thinking");
    const seeded = await fs.readFile(abs, "utf8");
    const custom = "---\nname: systems-thinking\ndescription: mine.\n---\n\n# Mine\n";
    await fs.writeFile(abs, custom);
    const refused = await init.run({ scope: "global", reset: ["systems-thinking"] });
    expect(refused.ok).toBe(false);
    expect(await fs.readFile(abs, "utf8")).toBe(custom);
    const done = await init.run({ scope: "global", reset: ["systems-thinking"], confirmed: true });
    expect(done.ok && done.value.repaired).toEqual(["skills/systems-thinking/SKILL.md"]);
    expect(await readBackup(globalDir, "skills/systems-thinking/SKILL.md")).toBe(custom);
    expect(existsSync(abs + ".rejected")).toBe(false);
    expect(await fs.readFile(abs, "utf8")).toBe(seeded);
  });

  it("resetNames lists config, the seeded agents, and the seeded skills", () => {
    const names = init.resetNames();
    expect(names).toContain("config");
    expect(names).toContain("planner");
    expect(names).toContain("systems-thinking");
  });

  it("previewReset of a seeded skill returns its current and default content", async () => {
    await init.run({ scope: "global" });
    const r = await init.previewReset("systems-thinking");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(1);
    expect(r.value[0]!.rel).toBe("skills/systems-thinking/SKILL.md");
    expect(r.value[0]!.def).toMatch(/name: systems-thinking/);
  });

  it("the seeded skill is discovered by the ordinary loader and load_skill returns its body", async () => {
    await init.run({ scope: "global" });
    // The ordinary skills loader over the real filesystem, rooted at the global
    // config dir (so `skills/` resolves to the seeded tree).
    const fsPort = new FilesystemAdapter(globalDir);
    const bus = new EventBus();
    for (const t of ["SKILL_LOADED", "RESOURCE_CHANGED"]) bus.register(t);
    const directory = new SkillsDirectory(fsPort, { workspace: ".voidrift/skills", global: "skills" });
    const skills = new Skills({ bus, directory, getAllowlist: () => [], toolRegistry: new ToolRegistry() });
    await skills.reindex();
    // One index line, name + description only.
    expect(skills.indexLines()).toContainEqual(
      expect.objectContaining({ name: "systems-thinking" }),
    );
    // load_skill returns the full body through the real loader.
    const loaded = skills.load("systems-thinking");
    expect(loaded.loaded).toBe(true);
    expect(skills.loadedBodies().join("\n")).toContain("# Systems thinking");
  });

  it("project form creates <dir>/.voidrift/{config.json,agents/} and no global files", async () => {
    const projectDir = path.join(scratch, "proj");
    await fs.mkdir(projectDir, { recursive: true });
    const r = await init.run({ scope: "project", dir: projectDir });
    expect(r.ok && r.value.created).toEqual(["config.json"]);
    const cfg = path.join(projectDir, ".voidrift", "config.json");
    expect(existsSync(cfg)).toBe(true);
    // Minimal valid document.
    expect(ConfigSchema.safeParse(JSON.parse(await fs.readFile(cfg, "utf8"))).success).toBe(true);
    // The empty agents/ folder exists, 0700.
    const agentsDir = path.join(projectDir, ".voidrift", "agents");
    expect(existsSync(agentsDir)).toBe(true);
    expect(statSync(agentsDir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(projectDir, ".voidrift")).mode & 0o777).toBe(0o700);
    expect(statSync(cfg).mode & 0o777).toBe(0o600);
    // The GLOBAL dir was NOT touched by the project form.
    expect(existsSync(globalDir)).toBe(false);
  });

  it("global form creates no project files", async () => {
    const projectDir = path.join(scratch, "proj2");
    await fs.mkdir(projectDir, { recursive: true });
    await init.run({ scope: "global" });
    expect(existsSync(path.join(projectDir, ".voidrift"))).toBe(false);
  });

  it("project form requires a dir", async () => {
    const r = await init.run({ scope: "project" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
  });

  // ── backup tree + retention + sweep (§13.9.1) ───────────────────────────────

  it("a repair backup lands at backups/<ts>/<rel> with private modes (dir 0700, file 0600)", async () => {
    await init.run({ scope: "global" });
    const agent = path.join(globalDir, "agents", "reviewer", "agent.json");
    await fs.writeFile(agent, "{ broken");
    await init.run({ scope: "global" });
    const backupsDir = path.join(globalDir, "backups");
    const sets = (await fs.readdir(backupsDir)).sort();
    expect(sets).toHaveLength(1);
    const setDir = path.join(backupsDir, sets[0]!);
    const copy = path.join(setDir, "agents", "reviewer", "agent.json");
    expect(existsSync(copy)).toBe(true);
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(statSync(setDir).mode & 0o777).toBe(0o700);
    expect(statSync(backupsDir).mode & 0o777).toBe(0o700);
  });

  it("six repair operations keep the newest five backup sets and prune the sixth-oldest", async () => {
    await init.run({ scope: "global" });
    const agent = path.join(globalDir, "agents", "reviewer", "agent.json");
    for (let i = 0; i < 6; i++) {
      await fs.writeFile(agent, `{ broken ${i}`);
      const r = await init.run({ scope: "global" });
      expect(r.ok && r.value.repaired).toContain("agents/reviewer/agent.json");
    }
    const sets = (await fs.readdir(path.join(globalDir, "backups"))).sort();
    expect(sets).toHaveLength(5);
  });

  it("init --sweep moves agents/ and config-root leftovers into one fresh set and is idempotent", async () => {
    await init.run({ scope: "global" });
    const reviewerDir = path.join(globalDir, "agents", "reviewer");
    const leftoverA = path.join(reviewerDir, "agent.json.bak");
    const leftoverB = path.join(globalDir, "config.json.bak-20261020");
    await fs.writeFile(leftoverA, "old agent");
    await fs.writeFile(leftoverB, "old config");

    const r = await init.sweep();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.moved).toEqual(expect.arrayContaining([leftoverA, leftoverB]));
    expect(existsSync(leftoverA)).toBe(false);
    expect(existsSync(leftoverB)).toBe(false);
    // Canonical files are untouched.
    expect((await fs.readdir(reviewerDir)).sort()).toEqual(["agent.json", "prompt.md"]);
    // Moved into the backup tree, mirroring origin.
    expect(await readBackup(globalDir, "agents/reviewer/agent.json.bak")).toBe("old agent");
    expect(await readBackup(globalDir, "config.json.bak-20261020")).toBe("old config");

    // Idempotent: a second sweep moves nothing and creates no new set.
    const setsAfterFirst = (await fs.readdir(path.join(globalDir, "backups"))).length;
    const again = await init.sweep();
    expect(again.ok && again.value.moved).toEqual([]);
    expect((await fs.readdir(path.join(globalDir, "backups"))).length).toBe(setsAfterFirst);
  });

  it("init --sweep never mistakes a skill's scripts/ assets for leftovers, and leaves ordinary files alone", async () => {
    await init.run({ scope: "global" });
    const skillDir = path.join(globalDir, "skills", "systems-thinking");
    // A legitimate asset under scripts/ and an ordinary notes file.
    await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "scripts", "run.sh"), "echo hi\n");
    await fs.writeFile(path.join(skillDir, "notes.md"), "my notes\n");
    const r = await init.sweep();
    expect(r.ok && r.value.moved).toEqual([]);
    expect(existsSync(path.join(skillDir, "scripts", "run.sh"))).toBe(true);
    expect(existsSync(path.join(skillDir, "notes.md"))).toBe(true);
  });

  // ── init --migrate (§13.9.1) ────────────────────────────────────────────────
  it("init --migrate rewrites a config with retired keys and backs the original up", async () => {
    await init.run({ scope: "global" });
    const cfg = path.join(globalDir, "config.json");
    const old = { modelPrimary: "local", modelBackground: "util", models: { local: { model: "x", protocol: "openai", baseUrl: "http://localhost:11434/v1", contextLimit: 32768 } } };
    await fs.writeFile(cfg, JSON.stringify(old, null, 2));
    const r = await init.migrate();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.migrated).toHaveLength(1);
    expect(r.value.migrated[0]!.renames.map((x) => `${x.from}->${x.to}`).sort()).toEqual([
      "modelBackground->modelUtility",
      "modelPrimary->modelSelected",
    ]);
    // The file now carries the current keys and NOT the retired ones.
    const next = JSON.parse(await fs.readFile(cfg, "utf8"));
    expect(next.modelSelected).toBe("local");
    expect(next.modelUtility).toBe("util");
    expect("modelPrimary" in next).toBe(false);
    expect("modelBackground" in next).toBe(false);
    // The original is backed up to the backup tree (not beside the live file).
    expect(JSON.parse(await readBackup(globalDir, "config.json"))).toEqual(old);
    expect(r.value.backupSet).not.toBeNull();
  });

  it("init --migrate leaves a config with no retired key untouched", async () => {
    await init.run({ scope: "global" });
    const cfg = path.join(globalDir, "config.json");
    const before = await fs.readFile(cfg, "utf8");
    const r = await init.migrate();
    expect(r.ok && r.value.migrated).toEqual([]);
    expect(r.ok && r.value.leftAlone).toEqual([cfg]);
    expect(r.ok && r.value.backupSet).toBeNull();
    expect(await fs.readFile(cfg, "utf8")).toBe(before); // byte-for-byte untouched
  });

  // ── Registry migration (stage 2): old global registry → new project registry
  describe("registry migration (§13.9.1 stage 2)", () => {
    it("init project scope migrates two plugin registry files to the right short names", async () => {
      const projectDir = path.join(scratch, "project");
      await fs.mkdir(projectDir, { recursive: true });
      // Compute the workspace key from the real project path
      const { realpathSync } = await import("node:fs");
      const realPath = realpathSync(projectDir);
      const { createHash } = await import("node:crypto");
      const wsKey = createHash("sha256")
        .update(realPath)
        .digest("hex")
        .slice(0, 16);
      const oldRegistryDir = path.join(globalDir, "registry", wsKey);
      await fs.mkdir(oldRegistryDir, { recursive: true });
      // Old file-safe plugin ids: @voidrift/plugin-plan → "_voidrift_plugin-plan.json"
      const oldPlanFile = path.join(oldRegistryDir, "_voidrift_plugin-plan.json");
      const oldBedrockFile = path.join(oldRegistryDir, "_voidrift_plugin-bedrock.json");
      const planContent = JSON.stringify({ version: 1, entries: { k1: "v1" } });
      const bedrockContent = JSON.stringify({ version: 1, entries: { k2: "v2" } });
      await fs.writeFile(oldPlanFile, planContent);
      await fs.writeFile(oldBedrockFile, bedrockContent);
      // Create init using globalDir (not project dir) so it finds the old registry
      const projInit = new ConfigInit(new NodeInitFs(), globalDir, () => SEED_AGENTS_DIR);
      const r = await projInit.run({ scope: "project", dir: projectDir });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const newPlanReg = path.join(projectDir, ".voidrift", "plugins", "plan", "registry.json");
      const newBedrockReg = path.join(projectDir, ".voidrift", "plugins", "bedrock", "registry.json");
      expect(existsSync(newPlanReg)).toBe(true);
      expect(existsSync(newBedrockReg)).toBe(true);
      expect(JSON.parse(await fs.readFile(newPlanReg, "utf8"))).toEqual(JSON.parse(planContent));
      expect(JSON.parse(await fs.readFile(newBedrockReg, "utf8"))).toEqual(JSON.parse(bedrockContent));
      expect(existsSync(oldPlanFile)).toBe(true);
      expect(existsSync(oldBedrockFile)).toBe(true);
      expect(r.value.migrated).toContain("plan");
      expect(r.value.migrated).toContain("bedrock");
    });

    it("second project init is idempotent: existing project stores untouched", async () => {
      const projectDir = path.join(scratch, "project");
      await fs.mkdir(projectDir, { recursive: true });
      const { realpathSync } = await import("node:fs");
      const realPath = realpathSync(projectDir);
      const { createHash } = await import("node:crypto");
      const wsKey = createHash("sha256")
        .update(realPath)
        .digest("hex")
        .slice(0, 16);
      const oldRegistryDir = path.join(globalDir, "registry", wsKey);
      await fs.mkdir(oldRegistryDir, { recursive: true });
      const oldPlanFile = path.join(oldRegistryDir, "_voidrift_plugin-plan.json");
      const planContent = JSON.stringify({ version: 1, entries: { k1: "v1" } });
      await fs.writeFile(oldPlanFile, planContent);
      const projInit = new ConfigInit(new NodeInitFs(), globalDir, () => SEED_AGENTS_DIR);
      await projInit.run({ scope: "project", dir: projectDir });
      const newPlanReg = path.join(projectDir, ".voidrift", "plugins", "plan", "registry.json");
      const modifiedContent = JSON.stringify({ version: 1, entries: { modified: true } });
      await fs.writeFile(newPlanReg, modifiedContent);
      const r2 = await projInit.run({ scope: "project", dir: projectDir });
      expect(r2.ok).toBe(true);
      const content = await fs.readFile(newPlanReg, "utf8");
      expect(content).toBe(modifiedContent); // untouched
    });

    it("invalid old registry file is skipped and reported", async () => {
      const projectDir = path.join(scratch, "project");
      await fs.mkdir(projectDir, { recursive: true });
      const { realpathSync } = await import("node:fs");
      const realPath = realpathSync(projectDir);
      const { createHash } = await import("node:crypto");
      const wsKey = createHash("sha256")
        .update(realPath)
        .digest("hex")
        .slice(0, 16);
      const oldRegistryDir = path.join(globalDir, "registry", wsKey);
      await fs.mkdir(oldRegistryDir, { recursive: true });
      const badFile = path.join(oldRegistryDir, "_voidrift_plugin-plan.json");
      await fs.writeFile(badFile, JSON.stringify({ entries: { k1: "v1" } })); // missing version
      const projInit = new ConfigInit(new NodeInitFs(), globalDir, () => SEED_AGENTS_DIR);
      const r = await projInit.run({ scope: "project", dir: projectDir });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const newPlanReg = path.join(projectDir, ".voidrift", "plugins", "plan", "registry.json");
      expect(existsSync(newPlanReg)).toBe(false);
      expect(r.value.skippedInvalid).toContain("plan");
    });

    it("no old global registry set → no-op", async () => {
      const projectDir = path.join(scratch, "project");
      await fs.mkdir(projectDir, { recursive: true });
      const projInit = new ConfigInit(new NodeInitFs(), globalDir, () => SEED_AGENTS_DIR);
      const r = await projInit.run({ scope: "project", dir: projectDir });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.migrated).toBeUndefined();
      expect(r.value.skippedInvalid).toBeUndefined();
    });
  });
});
