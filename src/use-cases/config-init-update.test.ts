/**
 * `config.init --update` — bring an existing install's seeded defaults up to
 * the current shipped set against the known-shipped manifest (§13.9.1).
 *
 * The REAL `NodeInitFs` against a scratch dir. A CONTROLLED temp seed dir with
 * its own `shipped-hashes.json` lets the test fix "previous" vs "current"
 * content deterministically (no git, hermetic): an install seeded with a
 * previously shipped hash is detected UNMODIFIED and refreshed; a customized
 * file is left alone; missing seeded allow rules are added without touching the
 * others or the model settings.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigInit } from "./config-init.js";
import { NodeInitFs } from "../adapters/init-fs.js";
import { seedPermissions } from "../config/seed.js";
import { permissionsFingerprint } from "../config/shipped-manifest.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** The seeded agent names the controlled seed dir provides (top-level + one
 * worker is enough to exercise stale/customized/missing). */
const AGENTS = ["research", "vibe", "researcher", "planner", "implementer", "reviewer", "summarizer"] as const;
const SKILLS = ["systems-thinking"] as const;

/** Build a minimal valid agent.json for `name`. */
function agentJson(name: string, extra = ""): string {
  const top = name === "research" || name === "vibe";
  const base: Record<string, unknown> = {
    name,
    description: `${name} agent`,
    kind: top ? "top-level" : "worker",
    tools: ["read_file"],
  };
  if (name === "vibe") Object.assign(base, { unlisted: "allow", confirm: true, workers: "all", order: 30 });
  if (name === "research") Object.assign(base, { unlisted: "deny", workers: ["researcher"], order: 20 });
  return JSON.stringify(base, null, 2) + extra + "\n";
}

const promptMd = (name: string, v: string) => `# ${name}\n\nVersion ${v}.\n`;
const skillMd = (name: string, v: string) =>
  `---\nname: ${name}\ndescription: ${name} skill.\n---\n\n# ${name}\n\nVersion ${v}.\n`;

/** Read the single backup-tree copy of `rel` under `<globalDir>/backups/<ts>/`
 * (§13.9.1); throws unless exactly one set holds it. */
async function readBackup(globalDir: string, rel: string): Promise<string> {
  const backupsDir = path.join(globalDir, "backups");
  const sets = (await fs.readdir(backupsDir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const hits: string[] = [];
  for (const s of sets) {
    const abs = path.join(backupsDir, s, rel);
    if (existsSync(abs)) hits.push(await fs.readFile(abs, "utf8"));
  }
  if (hits.length !== 1) throw new Error(`expected one backup of ${rel}, found ${hits.length}`);
  return hits[0]!;
}

describe("config.init --update (§13.9.1)", () => {
  let scratch: string;
  let globalDir: string;
  let seedDir: string;
  let seedAgentsDir: string;
  let init: ConfigInit;

  // Per-file CURRENT content (v2) and a PREVIOUS content (v1) whose hash the
  // manifest also lists, so v1 reads as `stale`.
  const curPrompt = (n: string) => promptMd(n, "2");
  const prevPrompt = (n: string) => promptMd(n, "1");
  const curSkill = (n: string) => skillMd(n, "2");
  const prevSkill = (n: string) => skillMd(n, "1");

  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "vr-update-"));
    globalDir = path.join(scratch, "home");
    seedDir = path.join(scratch, "seed");
    seedAgentsDir = path.join(seedDir, "agents");

    // Write the controlled seed templates (current = v2).
    for (const name of AGENTS) {
      const dir = path.join(seedAgentsDir, name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "agent.json"), agentJson(name));
      await fs.writeFile(path.join(dir, "prompt.md"), curPrompt(name));
    }
    for (const name of SKILLS) {
      const dir = path.join(seedDir, "skills", name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "SKILL.md"), curSkill(name));
    }

    // Manifest: current hash first, previous hash kept after it.
    const entries: Record<string, string[]> = {
      permissions: [sha(permissionsFingerprint(seedPermissions()))],
    };
    for (const name of AGENTS) {
      entries[`agents/${name}/agent.json`] = [sha(agentJson(name))];
      entries[`agents/${name}/prompt.md`] = [sha(curPrompt(name)), sha(prevPrompt(name))];
    }
    for (const name of SKILLS) {
      entries[`skills/${name}/SKILL.md`] = [sha(curSkill(name)), sha(prevSkill(name))];
    }
    await fs.writeFile(path.join(seedDir, "shipped-hashes.json"), JSON.stringify({ version: 1, entries }, null, 2));

    init = new ConfigInit(new NodeInitFs(), globalDir, () => seedAgentsDir);
    // SEED_AGENTS/SEED_SKILLS drive globalTargets; our controlled names match.
    await init.run({ scope: "global" }); // seed the install at CURRENT content
  });
  afterEach(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it("an install seeded with an OLD (unmodified) default is refreshed, old moved to the backup tree", async () => {
    const researchPrompt = path.join(globalDir, "agents", "research", "prompt.md");
    const vibePrompt = path.join(globalDir, "agents", "vibe", "prompt.md");
    await fs.writeFile(researchPrompt, prevPrompt("research"));
    await fs.writeFile(vibePrompt, prevPrompt("vibe"));

    const plan = await init.previewUpdate();
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const stale = plan.value.files.filter((f) => f.status === "stale").map((f) => f.rel).sort();
    expect(stale).toEqual(["agents/research/prompt.md", "agents/vibe/prompt.md"]);

    const r = await init.applyUpdate(true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.updated).toEqual(["agents/research/prompt.md", "agents/vibe/prompt.md"]);
    // Refreshed to current; old content moved into the backup tree (no sibling).
    expect(await fs.readFile(researchPrompt, "utf8")).toBe(curPrompt("research"));
    expect(await readBackup(globalDir, "agents/research/prompt.md")).toBe(prevPrompt("research"));
    expect(await readBackup(globalDir, "agents/vibe/prompt.md")).toBe(prevPrompt("vibe"));
    expect(existsSync(researchPrompt + ".previous")).toBe(false);
  });

  it("a customized file is left alone and listed with its reset name", async () => {
    const researchPrompt = path.join(globalDir, "agents", "research", "prompt.md");
    const custom = promptMd("research", "MINE-999");
    await fs.writeFile(researchPrompt, custom);

    const plan = await init.previewUpdate();
    expect(plan.ok && plan.value.files.find((f) => f.rel === "agents/research/prompt.md")?.status).toBe(
      "customized",
    );

    const r = await init.applyUpdate(true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.leftAloneCustomized).toContainEqual({ rel: "agents/research/prompt.md", resetName: "research" });
    expect(r.value.updated).not.toContain("agents/research/prompt.md");
    expect(await fs.readFile(researchPrompt, "utf8")).toBe(custom);
    expect(existsSync(researchPrompt + ".previous")).toBe(false);
  });

  it("missing seeded allow rules are added without touching other rules or model settings", async () => {
    const cfgPath = path.join(globalDir, "config.json");
    const cfg = JSON.parse(await fs.readFile(cfgPath, "utf8")) as Record<string, unknown>;
    // Remove two seeded allow rules and add a user rule; record the model block.
    const perms = cfg.permissions as Record<string, unknown>;
    delete perms["allow-read_file"];
    delete perms["allow-web_fetch"];
    perms["user-custom"] = { tool: "read_file", decision: "allow", priority: 5, source: "workspace" };
    const modelBefore = JSON.stringify(cfg.models);
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2) + "\n");

    const plan = await init.previewUpdate();
    expect(plan.ok && plan.value.missingAllowRules.sort()).toEqual(["allow-read_file", "allow-web_fetch"]);

    const r = await init.applyUpdate(true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.added).toContain("permissions:allow-read_file");
    expect(r.value.added).toContain("permissions:allow-web_fetch");

    const after = JSON.parse(await fs.readFile(cfgPath, "utf8")) as Record<string, unknown>;
    const afterPerms = after.permissions as Record<string, unknown>;
    expect(afterPerms["allow-read_file"]).toBeDefined();
    expect(afterPerms["allow-web_fetch"]).toBeDefined();
    // The user rule is untouched; model settings are byte-identical.
    expect(afterPerms["user-custom"]).toEqual({ tool: "read_file", decision: "allow", priority: 5, source: "workspace" });
    expect(JSON.stringify(after.models)).toBe(modelBefore);
  });

  it("a user rule carrying a seeded id is left untouched", async () => {
    const cfgPath = path.join(globalDir, "config.json");
    const cfg = JSON.parse(await fs.readFile(cfgPath, "utf8")) as Record<string, unknown>;
    const perms = cfg.permissions as Record<string, Record<string, unknown>>;
    perms["allow-read_file"] = { tool: "read_file", decision: "deny", priority: 9, source: "workspace" };
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2) + "\n");

    const plan = await init.previewUpdate();
    expect(plan.ok && plan.value.missingAllowRules).not.toContain("allow-read_file");
    await init.applyUpdate(true);
    const after = JSON.parse(await fs.readFile(cfgPath, "utf8")) as Record<string, unknown>;
    expect((after.permissions as Record<string, unknown>)["allow-read_file"]).toEqual({
      tool: "read_file",
      decision: "deny",
      priority: 9,
      source: "workspace",
    });
  });

  it("applyUpdate without confirmation refuses and changes nothing", async () => {
    const researchPrompt = path.join(globalDir, "agents", "research", "prompt.md");
    await fs.writeFile(researchPrompt, prevPrompt("research"));
    const r = await init.applyUpdate(false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
    expect(await fs.readFile(researchPrompt, "utf8")).toBe(prevPrompt("research"));
    expect(existsSync(researchPrompt + ".previous")).toBe(false);
  });

  it("a missing seeded agent file is created", async () => {
    const abs = path.join(globalDir, "agents", "planner", "prompt.md");
    await fs.rm(abs);
    const r = await init.applyUpdate(true);
    expect(r.ok && r.value.added).toContain("agents/planner/prompt.md");
    expect(await fs.readFile(abs, "utf8")).toBe(curPrompt("planner"));
  });

  it("a second update is idempotent (nothing stale, nothing added)", async () => {
    await init.applyUpdate(true); // bring everything current (already is)
    const plan = await init.previewUpdate();
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.files.filter((f) => f.status !== "customized")).toEqual([]);
    expect(plan.value.missingAllowRules).toEqual([]);
    const r = await init.applyUpdate(true);
    expect(r.ok && r.value.updated).toEqual([]);
    expect(r.ok && r.value.added).toEqual([]);
  });

  it("--update writes the replaced content to the backup tree, never a .previous sibling", async () => {
    const researchPrompt = path.join(globalDir, "agents", "research", "prompt.md");
    await fs.writeFile(researchPrompt, prevPrompt("research"));
    await init.applyUpdate(true);
    expect(await readBackup(globalDir, "agents/research/prompt.md")).toBe(prevPrompt("research"));
    expect(existsSync(researchPrompt + ".previous")).toBe(false);
    // The live dir keeps only its canonical files.
    expect((await fs.readdir(path.join(globalDir, "agents", "research"))).sort()).toEqual([
      "agent.json",
      "prompt.md",
    ]);
  });
});
