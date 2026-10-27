/**
 * `config.doctor` — validate every resource (core-blueprint.md §13.9.2).
 *
 * Unit tests per group with crafted bad fixtures, offline, secrets, exit-code
 * mapping, and network-safety. The capability is a real `ConfigCapability` over
 * the in-memory store (§1 rule 7); every probe is a fake that records calls, so
 * the whole suite runs offline and deterministically.
 */
import { describe, it, expect } from "vitest";
import { ConfigCapability } from "../entities/config-capability.js";
import { InMemoryConfigStore } from "../adapters/repositories/in-memory-config-store.js";
import { seedConfigDocument } from "../config/seed.js";
import type { AgentDefinition } from "../entities/subagents.js";
import {
  runDoctor,
  stripUserinfo,
  type DoctorDeps,
  type DoctorReport,
  type ProbeResult,
} from "./config-doctor.js";
import { limitDefault } from "../entities/limits.js";

async function cap(layers?: Record<string, Record<string, unknown>>): Promise<ConfigCapability> {
  const store = new InMemoryConfigStore(undefined, layers as never);
  const c = new ConfigCapability(store, () => undefined);
  await c.load();
  return c;
}

const okProbe: ProbeResult = { reachable: true, status: 200, modelIds: ["local-model"] };

function baseDeps(overrides: Partial<DoctorDeps> & { config: ConfigCapability }): DoctorDeps {
  return {
    agents: { definitions: [], skipped: [] },
    knownTools: () => new Set(["read_file", "write_file", "execute_command", "task", "read_manual"]),
    mutatingTools: () => new Set(["write_file", "execute_command"]),
    skills: () => [{ name: "systems-thinking", valid: true, dir: "/cfg/skills/systems-thinking/SKILL.md" }],
    paths: {
      configDir: "/cfg",
      configFile: "/cfg/config.json",
      sessionsDir: "/ws/.voidrift/sessions",
      journalDir: "/ws/.voidrift/journal",
      seedAgentsDir: "/seed/agents",
      seedSkillsDir: "/seed/skills",
      workspaceRoot: "/ws",
    },
    envSet: () => false,
    modelListProbe: async () => okProbe,
    reachProbe: async () => ({ reachable: true, status: 200 }),
    storage: {
      modeOf: async () => 0o700,
      isSymlink: async () => false,
      freeBytes: async () => 10 * 1024 * 1024 * 1024,
      dirUsable: async () => true,
      readFile: async () => null,
      listDirs: async () => [],
      gitConfigScan: async () => [],
      isGitRepo: async () => false,
      countVoidriftRefs: async () => 0,
      dirSizeBytes: async () => 0,
      movesPerSession: async () => [],
    },
    ...overrides,
  } as DoctorDeps;
}

function statusOf(report: DoctorReport, id: string): string | undefined {
  for (const g of report.groups) for (const f of g.findings) if (f.id === id) return f.status;
  return undefined;
}

const topLevel = (over: Partial<AgentDefinition>): AgentDefinition => ({
  name: "chat",
  description: "d",
  kind: "top-level",
  systemPrompt: "p",
  tools: ["*"],
  order: 10,
  ...over,
});
const worker = (over: Partial<AgentDefinition>): AgentDefinition => ({
  name: "w",
  description: "d",
  kind: "worker",
  systemPrompt: "p",
  tools: [],
  ...over,
});

describe("config.doctor (§13.9.2)", () => {
  it("DOC1: the default network timeout comes from the limits registry (doctor.networkTimeoutMs) and an explicit opt overrides it", async () => {
    const c = await cap({ global: seedConfigDocument() });
    const seen: number[] = [];
    const deps = baseDeps({
      config: c,
      envSet: () => true,
      reachProbe: async (_url: string, opts: { timeoutMs: number }) => {
        seen.push(opts.timeoutMs);
        return { reachable: true, status: 200 };
      },
    });
    await runDoctor(deps, {});
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((t) => t === limitDefault("doctor.networkTimeoutMs"))).toBe(true);
    seen.length = 0;
    await runDoctor(deps, { timeoutMs: 1234 });
    expect(seen.every((t) => t === 1234)).toBe(true);
  });

  it("a healthy seeded install yields exit 0 and non-ok findings carry a fix", async () => {
    const c = await cap({ global: seedConfigDocument() });
    const report = await runDoctor(baseDeps({ config: c, envSet: () => true }), { offline: true });
    expect(report.exitCode).toBe(0);
    expect(report.summary.fail).toBe(0);
    for (const g of report.groups)
      for (const f of g.findings) if (f.status !== "ok") expect(f.fix, `${f.id} needs a fix`).toBeTruthy();
  });

  it("SKILLS: a missing seeded skill warns with fix `init` and does not fail the run (in JSON)", async () => {
    const c = await cap({ global: seedConfigDocument() });
    // No skill rows discovered → the seeded systems-thinking is missing.
    // Missing is advisory (restorable with `voidrift init`), so it warns, not fails.
    const report = await runDoctor(baseDeps({ config: c, envSet: () => true, skills: () => [] }), { offline: true });
    expect(statusOf(report, "skills.seeded-missing.systems-thinking")).toBe("warn");
    const finding = report.groups
      .find((g) => g.id === "skills-prompts")!
      .findings.find((f) => f.id === "skills.seeded-missing.systems-thinking")!;
    expect(finding.fix).toBe("voidrift init");
    // A warn-only report (the sole non-ok finding) exits 0.
    expect(report.summary.fail).toBe(0);
    expect(report.exitCode).toBe(0);
  });

  it("SKILLS: a malformed seeded skill (no valid SKILL.md) fails, mirroring a skipped agent", async () => {
    const c = await cap({ global: seedConfigDocument() });
    const report = await runDoctor(
      baseDeps({
        config: c,
        envSet: () => true,
        skills: () => [{ name: "systems-thinking", valid: false, dir: "/cfg/skills/systems-thinking" }],
      }),
      { offline: true },
    );
    expect(statusOf(report, "skills.systems-thinking")).toBe("fail");
    expect(report.exitCode).toBe(1);
  });

  it("DRIFT: a drifted seeded skill is reported with fix `init --reset systems-thinking`", async () => {
    const c = await cap({ global: seedConfigDocument() });
    const tmpl = "---\nname: systems-thinking\ndescription: d\n---\n\n# Systems thinking\n";
    const onDisk = "---\nname: systems-thinking\ndescription: d\n---\n\n# Changed\n";
    const deps = baseDeps({
      config: c,
      storage: {
        modeOf: async () => 0o700,
        isSymlink: async () => false,
        freeBytes: async () => 10 * 1024 * 1024 * 1024,
        dirUsable: async () => true,
        readFile: async (p: string) => {
          if (p === "/seed/skills/systems-thinking/SKILL.md") return tmpl;
          if (p === "/cfg/skills/systems-thinking/SKILL.md") return onDisk;
          return null;
        },
        listDirs: async () => [],
        gitConfigScan: async () => [],
        isGitRepo: async () => false,
        countVoidriftRefs: async () => 0,
        dirSizeBytes: async () => 0,
        movesPerSession: async () => [],
      } as DoctorDeps["storage"],
    });
    const report = await runDoctor(deps, { offline: true });
    expect(statusOf(report, "drift.skill.systems-thinking")).toBe("warn");
    const finding = report.groups
      .find((g) => g.id === "drift")!
      .findings.find((f) => f.id === "drift.skill.systems-thinking")!;
    expect(finding.fix).toBe("voidrift init --reset systems-thinking");
  });

  it("DRIFT: a seeded agent's stale prompt.md (differing from the shipped template) is reported with fix `init --reset <agent>`", async () => {
    // The seeded research/vibe prompts changed; an existing install keeps the
    // old prompt.md on disk. Doctor compares agents/<name>/prompt.md against the
    // shipped template and reports drift even when agent.json is unchanged. (The
    // built-in `chat` prompt lives in code, not a seeded file, so it cannot drift
    // this way — only seeded prompt.md files are compared.)
    const c = await cap({ global: seedConfigDocument() });
    const agentJson = '{"name":"research","description":"d","kind":"top-level"}';
    const tmplPrompt = "# research\nYou read only.\n";
    const diskPrompt = "# research\nYou read only. STALE EDIT.\n";
    const deps = baseDeps({
      config: c,
      agents: { definitions: [topLevel({ name: "research", unlisted: "deny", order: 20 })], skipped: [] },
      storage: {
        modeOf: async () => 0o700,
        isSymlink: async () => false,
        freeBytes: async () => 10 * 1024 * 1024 * 1024,
        dirUsable: async () => true,
        readFile: async (p: string) => {
          if (p === "/seed/agents/research/agent.json") return agentJson;
          if (p === "/cfg/agents/research/agent.json") return agentJson; // agent.json UNCHANGED
          if (p === "/seed/agents/research/prompt.md") return tmplPrompt;
          if (p === "/cfg/agents/research/prompt.md") return diskPrompt; // prompt.md DRIFTED
          return null;
        },
        listDirs: async (p: string) => (p === "/cfg/agents" ? ["research"] : []),
        gitConfigScan: async () => [],
        isGitRepo: async () => false,
        countVoidriftRefs: async () => 0,
        dirSizeBytes: async () => 0,
        movesPerSession: async () => [],
      } as DoctorDeps["storage"],
    });
    const report = await runDoctor(deps, { offline: true });
    expect(statusOf(report, "drift.agent.research")).toBe("warn");
    const finding = report.groups
      .find((g) => g.id === "drift")!
      .findings.find((f) => f.id === "drift.agent.research")!;
    expect(finding.fix).toBe("voidrift init --reset research");
  });

  it("DRIFT: an OUT OF DATE (unmodified older) seeded agent prompt is reported with fix `voidrift init --update`", async () => {
    // The disk prompt matches a PREVIOUS shipped hash in the manifest → stale,
    // not customized: doctor hints the batch refresh, not a per-agent reset.
    const { createHash } = await import("node:crypto");
    const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
    const c = await cap({ global: seedConfigDocument() });
    const agentJson = '{"name":"research","description":"d","kind":"top-level"}';
    const tmplPrompt = "# research\nYou read only. v2.\n";
    const diskPrompt = "# research\nYou read only. v1.\n"; // a previous shipped version
    const manifest = JSON.stringify({
      version: 1,
      entries: { "agents/research/prompt.md": [sha(tmplPrompt), sha(diskPrompt)] },
    });
    const deps = baseDeps({
      config: c,
      agents: { definitions: [topLevel({ name: "research", unlisted: "deny", order: 20 })], skipped: [] },
      storage: {
        modeOf: async () => 0o700,
        isSymlink: async () => false,
        freeBytes: async () => 10 * 1024 * 1024 * 1024,
        dirUsable: async () => true,
        readFile: async (p: string) => {
          if (p === "/seed/shipped-hashes.json") return manifest;
          if (p === "/seed/agents/research/agent.json") return agentJson;
          if (p === "/cfg/agents/research/agent.json") return agentJson;
          if (p === "/seed/agents/research/prompt.md") return tmplPrompt;
          if (p === "/cfg/agents/research/prompt.md") return diskPrompt;
          return null;
        },
        listDirs: async (p: string) => (p === "/cfg/agents" ? ["research"] : []),
        gitConfigScan: async () => [],
        isGitRepo: async () => false,
        countVoidriftRefs: async () => 0,
        dirSizeBytes: async () => 0,
        movesPerSession: async () => [],
      } as DoctorDeps["storage"],
    });
    const report = await runDoctor(deps, { offline: true });
    const finding = report.groups
      .find((g) => g.id === "drift")!
      .findings.find((f) => f.id === "drift.agent.research")!;
    expect(finding.status).toBe("warn");
    expect(finding.message).toContain("out of date");
    expect(finding.fix).toBe("voidrift init --update");
  });

  it("report shape: the eleven groups in order, with a summary and exitCode", async () => {
    const c = await cap({ global: seedConfigDocument() });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    expect(report.groups.map((g) => g.id)).toEqual([
      "config",
      "agents",
      "allow-list",
      "models",
      "web-search",
      "mcp",
      "plugins",
      "skills-prompts",
      "storage",
      "rollback",
      "limits",
      "drift",
    ]);
    expect(report.summary).toEqual({
      ok: expect.any(Number),
      warn: expect.any(Number),
      fail: expect.any(Number),
    });
  });

  it("CONFIG: a rejected layer is a fail naming the file and the .rejected sibling", async () => {
    const c = await cap({ global: seedConfigDocument() });
    // Simulate a rejection recorded at load.
    (c as unknown as { rejections: unknown[] }).rejections = [
      { layer: "project", path: "/ws/.voidrift/config.json", rejectedPath: "/ws/.voidrift/config.json.rejected", errors: [] },
    ];
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    expect(statusOf(report, "config.rejected.project")).toBe("fail");
    expect(report.exitCode).toBe(1);
  });

  it("CONFIG: a project layer that widens the global allow list warns", async () => {
    const c = await cap({
      global: seedConfigDocument(),
      project: { permissions: { "allow-x": { tool: "read_file", decision: "allow", priority: 0, source: "workspace" } } },
    });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    expect(statusOf(report, "config.widen.project.permissions")).toBe("warn");
  });

  it("PLUGINS: an exporter enabled with no options warns it cannot work (value-free)", async () => {
    const c = await cap({
      global: { ...seedConfigDocument(), plugins: { "@voidrift/plugin-otel-exporter": { enabled: true } } },
    });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    const f = report.groups
      .find((g) => g.id === "plugins")!
      .findings.find((x) => x.id === "plugins.options.@voidrift/plugin-otel-exporter");
    expect(f?.status).toBe("warn");
    expect(f?.message).toContain("enabled but has no options configured");
  });

  it("PLUGINS: an exporter enabled WITH options does not warn about options", async () => {    const c = await cap({
      global: {
        ...seedConfigDocument(),
        plugins: { "@voidrift/plugin-otel-exporter": { enabled: true, options: { config: { endpoint: "http://127.0.0.1:4318" } } } },
      },
    });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    expect(statusOf(report, "plugins.options.@voidrift/plugin-otel-exporter")).toBeUndefined();
  });

  it("PLUGINS (security LOW): an exporter endpoint from the PROJECT layer WARNs, naming the host (value-free)", async () => {
    const c = await cap({
      global: { ...seedConfigDocument(), plugins: { "@voidrift/plugin-otel-exporter": { enabled: true } } },
      project: { plugins: { "@voidrift/plugin-otel-exporter": { enabled: true, options: { config: { endpoint: "https://collector.attacker.test:4318/v1" } } } } },
    });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    const f = report.groups
      .find((g) => g.id === "plugins")!
      .findings.find((x) => x.id === "plugins.endpoint.@voidrift/plugin-otel-exporter");
    expect(f?.status).toBe("warn");
    expect(f?.message).toContain("masked telemetry is sent there");
    expect(f?.message).toContain("collector.attacker.test");
    expect(f?.message).not.toContain("https://");
    expect(f?.message).not.toContain(":4318");
  });

  it("PLUGINS (security LOW): a global-layer exporter endpoint does NOT warn", async () => {
    const c = await cap({
      global: { ...seedConfigDocument(), plugins: { "@voidrift/plugin-otel-exporter": { enabled: true, options: { config: { endpoint: "https://collector.example.com:4318" } } } } },
    });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    expect(statusOf(report, "plugins.endpoint.@voidrift/plugin-otel-exporter")).toBeUndefined();
  });

  it("PLUGINS (FX-C2): a literal publicKey/secretKey in langfuse config FAILS (value-free)", async () => {
    const c = await cap({
      global: {
        ...seedConfigDocument(),
        plugins: {
          "@voidrift/plugin-langfuse-exporter": {
            enabled: true,
            options: { config: { publicKey: "pk-literal", secretKey: "sk-literal" } },
          },
        },
      },
    });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    const f = report.groups
      .find((g) => g.id === "plugins")!
      .findings.find((x) => x.id === "plugins.secrets.@voidrift/plugin-langfuse-exporter");
    expect(f?.status).toBe("fail");
    expect(f?.fix).toContain("publicKeyEnv/secretKeyEnv");
    // The secret value never appears in the finding.
    expect(JSON.stringify(f)).not.toContain("pk-literal");
    expect(JSON.stringify(f)).not.toContain("sk-literal");
  });

  it("PLUGINS (FX-C2): a secret-named OTel header literal WARNs to use headerEnv (value-free)", async () => {
    const c = await cap({
      global: {
        ...seedConfigDocument(),
        plugins: {
          "@voidrift/plugin-otel-exporter": {
            enabled: true,
            options: { config: { endpoint: "http://127.0.0.1:4318", headers: { Authorization: "Bearer sekret" } } },
          },
        },
      },
    });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    const f = report.groups
      .find((g) => g.id === "plugins")!
      .findings.find((x) => x.id === "plugins.secrets.@voidrift/plugin-otel-exporter.Authorization");
    expect(f?.status).toBe("warn");
    expect(f?.fix).toContain("headerEnv");
    expect(JSON.stringify(f)).not.toContain("sekret");
  });

  it("PLUGINS (FX-C2): env-name langfuse config and headerEnv OTel config raise no secret finding", async () => {
    const c = await cap({
      global: {
        ...seedConfigDocument(),
        plugins: {
          "@voidrift/plugin-langfuse-exporter": {
            enabled: true,
            options: { config: { publicKeyEnv: "LANGFUSE_PUBLIC_KEY", secretKeyEnv: "LANGFUSE_SECRET_KEY" } },
          },
          "@voidrift/plugin-otel-exporter": {
            enabled: true,
            options: { config: { endpoint: "http://127.0.0.1:4318", headerEnv: { Authorization: "OTEL_AUTH_HEADER" } } },
          },
        },
      },
    });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    expect(statusOf(report, "plugins.secrets.@voidrift/plugin-langfuse-exporter")).toBeUndefined();
    expect(statusOf(report, "plugins.secrets.@voidrift/plugin-otel-exporter.Authorization")).toBeUndefined();
  });

  it("AGENTS: an empty agents folder with a config present warns 'voidrift init'", async () => {
    const c = await cap({ global: seedConfigDocument() });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    const f = report.groups.find((g) => g.id === "agents")!.findings.find((x) => x.id === "agents.empty");
    expect(f?.status).toBe("warn");
    expect(f?.fix).toBe("voidrift init");
  });

  it("AGENTS: a worker holding 'task' fails", async () => {
    const c = await cap({ global: seedConfigDocument() });
    const deps = baseDeps({ config: c, agents: { definitions: [topLevel({}), worker({ tools: ["task"] })], skipped: [] } });
    const report = await runDoctor(deps, { offline: true });
    expect(statusOf(report, "agents.worker-task.w")).toBe("fail");
  });

  it("AGENTS: a named tool that does not exist fails", async () => {
    const c = await cap({ global: seedConfigDocument() });
    const deps = baseDeps({ config: c, agents: { definitions: [topLevel({ name: "research", tools: ["read_file", "nope"] })], skipped: [] } });
    const report = await runDoctor(deps, { offline: true });
    expect(statusOf(report, "agents.tool.research.nope")).toBe("fail");
  });

  it("AGENTS: a skipped agent is reported with its reason; a missing worker fails", async () => {
    const c = await cap({ global: seedConfigDocument() });
    const deps = baseDeps({
      config: c,
      agents: { definitions: [topLevel({ workers: ["ghost"] })], skipped: [{ name: "bad", reason: "invalid JSON" }] },
    });
    const report = await runDoctor(deps, { offline: true });
    expect(statusOf(report, "agents.skipped.bad")).toBe("fail");
    expect(statusOf(report, "agents.worker-missing.chat.ghost")).toBe("fail");
  });

  it("ALLOW LIST: a dead allow-list entry warns", async () => {
    const doc = seedConfigDocument();
    (doc.permissions as Record<string, unknown>)["allow-ghost"] = { tool: "ghost_tool", decision: "allow", priority: 0, source: "user" };
    const c = await cap({ global: doc });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    expect(statusOf(report, "allow-list.dead.allow-ghost")).toBe("warn");
  });

  it("ALLOW LIST: a missing seeded rule (researcher_save_notes) warns with the reset fix", async () => {
    const doc = seedConfigDocument();
    delete (doc.permissions as Record<string, unknown>)["allow-researcher_save_notes"];
    const c = await cap({ global: doc });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    const f = report.groups.find((g) => g.id === "allow-list")!.findings.find((x) => x.id === "allow-list.missing.allow-researcher_save_notes");
    expect(f?.status).toBe("warn");
    expect(f?.fix).toContain("voidrift init --update");
  });

  it("ALLOW LIST: read_manual is a known tool and does not flag as dead when added to permissions (§8.6)", async () => {
    const doc = seedConfigDocument();
    // read_manual is in the seeded allow list; verify the doctor knows it as a valid tool.
    // Even if we manually add read_manual to an agent, the doctor should not flag it as dead.
    const c = await cap({ global: doc });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    // read_manual should NOT be flagged as a dead allow-list entry.
    const readManualDead = report.groups
      .find((g) => g.id === "allow-list")
      ?.findings.find((x) => x.id === "allow-list.dead.allow-read_manual");
    expect(readManualDead).toBeUndefined();
  });

  it("MODELS: no model configured fails with a fix", async () => {
    const c = await cap({ global: { models: {} } });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    expect(statusOf(report, "models.none")).toBe("fail");
    expect(report.exitCode).toBe(1);
  });

  it("MODELS: an unreachable endpoint fails; an implausible contextLimit fails", async () => {
    const c = await cap({
      global: {
        models: { local: { model: "m", baseUrl: "http://localhost:1/v1", contextLimit: 99_000_000 } },
        modelSelected: "local",
      },
    });
    const deps = baseDeps({ config: c, modelListProbe: async () => ({ reachable: false, status: null, reason: "refused" }) });
    const report = await runDoctor(deps, {});
    expect(statusOf(report, "models.endpoint.local")).toBe("fail");
    expect(statusOf(report, "models.ctx.local")).toBe("fail");
  });

  it("MODELS: maxOutputTokens >= contextLimit fails naming both values (§11.2)", async () => {
    // The schema normally rejects this, so the doctor check is reached through a
    // real config capability whose get() is overridden to return the offending
    // entry (a managed/preexisting config); the finding names both values and the
    // fix. Using a real cap keeps every other doctor group working.
    const c = await cap({ global: { models: { local: { model: "m", contextLimit: 8192 } }, modelSelected: "local" } });
    const bad = {
      models: { local: { model: "m", contextLimit: 4096, maxOutputTokens: 9000 } },
      modelSelected: "local",
    };
    (c as unknown as { get: () => unknown }).get = () => bad;
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    const f = report.groups.find((g) => g.id === "models")!.findings.find((x) => x.id === "models.output.local");
    expect(f?.status).toBe("fail");
    expect(f?.message).toContain("9000");
    expect(f?.message).toContain("4096");
    expect(f?.fix).toMatch(/maxOutputTokens|contextLimit/);
  });

  it("MODELS: a router id the listing omits is a warn, not a fail", async () => {
    const c = await cap({
      global: { models: { auto: { model: "auto", baseUrl: "http://host/v1" } }, modelSelected: "auto" },
    });
    const deps = baseDeps({ config: c, modelListProbe: async () => ({ reachable: true, status: 200, modelIds: ["gpt-x"] }) });
    const report = await runDoctor(deps, {});
    expect(statusOf(report, "models.id.auto")).toBe("warn");
  });

  it("MODELS: modelUtility names a configured entry → ok; names no entry → fail; unset → no finding (§11.6)", async () => {
    const models = {
      main: { model: "mmain", baseUrl: "http://h/v1", contextLimit: 8000 },
      util: { model: "mutil", baseUrl: "http://h/v1", contextLimit: 8000 },
    };
    const okC = await cap({ global: { models, modelSelected: "main", modelUtility: "util" } });
    const okReport = await runDoctor(baseDeps({ config: okC }), { offline: true });
    expect(statusOf(okReport, "models.utility")).toBe("ok");

    const badC = await cap({ global: { models, modelSelected: "main", modelUtility: "ghost" } });
    const badReport = await runDoctor(baseDeps({ config: badC }), { offline: true });
    expect(statusOf(badReport, "models.utility")).toBe("fail");

    const unsetC = await cap({ global: { models, modelSelected: "main" } });
    const unsetReport = await runDoctor(baseDeps({ config: unsetC }), { offline: true });
    expect(unsetReport.groups.find((g) => g.id === "models")!.findings.find((x) => x.id === "models.utility")).toBeUndefined();
  });

  it("MODELS: an unset key env var warns by NAME only (never the value)", async () => {
    const c = await cap({ global: { models: { x: { model: "m", baseUrl: "http://h/v1", apiKeyEnv: "SECRET_KEY" } }, modelSelected: "x" } });
    const report = await runDoctor(baseDeps({ config: c, envSet: () => false }), { offline: true });
    const f = report.groups.find((g) => g.id === "models")!.findings.find((x) => x.id === "models.key.x");
    expect(f?.status).toBe("warn");
    expect(f?.message).toContain("SECRET_KEY");
  });

  it("STORAGE: wrong modes warn with the exact chmod fix; a symlinked file fails", async () => {
    const c = await cap({ global: seedConfigDocument() });
    const deps = baseDeps({
      config: c,
      storage: {
        modeOf: async (p) => (p.endsWith("config.json") ? 0o644 : 0o755),
        isSymlink: async (p) => p.endsWith("config.json"),
        freeBytes: async () => 10 * 1024 * 1024 * 1024,
        dirUsable: async () => true,
        readFile: async () => null,
        listDirs: async () => [],
        gitConfigScan: async () => [],
      },
    });
    const report = await runDoctor(deps, { offline: true });
    expect(statusOf(report, "storage.symlink")).toBe("fail");
    const dirF = report.groups.find((g) => g.id === "storage")!.findings.find((x) => x.id === "storage.dir-mode");
    expect(dirF?.fix).toBe("chmod 700 /cfg");
    const fileF = report.groups.find((g) => g.id === "storage")!.findings.find((x) => x.id === "storage.file-mode");
    expect(fileF?.fix).toBe("chmod 600 /cfg/config.json");
  });

  it("STORAGE: low free space fails", async () => {
    const c = await cap({ global: seedConfigDocument() });
    const deps = baseDeps({ config: c, storage: { modeOf: async () => 0o700, isSymlink: async () => false, freeBytes: async () => 1024, dirUsable: async () => true, readFile: async () => null, listDirs: async () => [], gitConfigScan: async () => [] } });
    const report = await runDoctor(deps, { offline: true });
    expect(statusOf(report, "storage.space")).toBe("fail");
  });

  it("STORAGE: a loose .voidrift / checkpoint.db mode warns with the exact chmod fix (S2)", async () => {
    const c = await cap({ global: seedConfigDocument() });
    const deps = baseDeps({
      config: c,
      storage: {
        // 0700/0600 for the global config dir/file; loose for the workspace state.
        modeOf: async (p) => {
          if (p === "/cfg") return 0o700;
          if (p === "/cfg/config.json") return 0o600;
          if (p === "/ws/.voidrift") return 0o755;
          if (p === "/ws/.voidrift/checkpoint.db") return 0o644;
          return null;
        },
        isSymlink: async () => false,
        freeBytes: async () => 10 * 1024 * 1024 * 1024,
        dirUsable: async () => true,
        readFile: async () => null,
        listDirs: async () => [],
        gitConfigScan: async () => [],
      },
    });
    const report = await runDoctor(deps, { offline: true });
    const dirF = report.groups.find((g) => g.id === "storage")!.findings.find((x) => x.id === "storage.state-dir-mode");
    expect(dirF?.status).toBe("warn");
    expect(dirF?.fix).toBe("chmod 700 /ws/.voidrift");
    const dbF = report.groups.find((g) => g.id === "storage")!.findings.find((x) => x.id === "storage.checkpoint-mode");
    expect(dbF?.status).toBe("warn");
    expect(dbF?.fix).toBe("chmod 600 /ws/.voidrift/checkpoint.db");
  });

  it("STORAGE: the registry dir mode is checked and stored routine/plan counts are reported (names only) (§12.5)", async () => {
    const c = await cap({ global: seedConfigDocument() });
    const deps = baseDeps({
      config: c,
      paths: {
        configDir: "/cfg",
        configFile: "/cfg/config.json",
        sessionsDir: "/ws/.voidrift/sessions",
        journalDir: "/ws/.voidrift/journal",
        seedAgentsDir: "/seed/agents",
        seedSkillsDir: "/seed/skills",
        registryDir: "/cfg/registry/abc123",
        workspaceRoot: "/ws",
      },
      storage: {
        modeOf: async (p) => (p === "/cfg/registry/abc123" ? 0o755 : 0o700),
        isSymlink: async () => false,
        freeBytes: async () => 10 * 1024 * 1024 * 1024,
        dirUsable: async () => true,
        readFile: async () => null,
        listDirs: async () => [],
        gitConfigScan: async () => [],
        registryCounts: async () => ({ routines: ["daily", "weekly"], plans: ["ship-it"] }),
      },
    });
    const report = await runDoctor(deps, { offline: true });
    const modeF = report.groups.find((g) => g.id === "storage")!.findings.find((x) => x.id === "storage.registry-dir-mode");
    expect(modeF?.status).toBe("warn");
    expect(modeF?.fix).toBe("chmod 700 /cfg/registry/abc123");
    const countF = report.groups.find((g) => g.id === "storage")!.findings.find((x) => x.id === "storage.registry-counts");
    expect(countF?.status).toBe("ok");
    expect(countF?.message).toContain("2 saved routine(s)");
    expect(countF?.message).toContain("1 saved plan(s)");
  });

  it("STORAGE: an absent .voidrift / checkpoint.db yields no mode finding", async () => {
    const c = await cap({ global: seedConfigDocument() });
    // baseDeps.modeOf returns 0o700 for everything, but gitConfigScan [] and the
    // workspace state paths are absent in reality → simulate absence with null.
    const deps = baseDeps({
      config: c,
      storage: {
        modeOf: async (p) => (p.startsWith("/ws/.voidrift") ? null : 0o700),
        isSymlink: async () => false,
        freeBytes: async () => 10 * 1024 * 1024 * 1024,
        dirUsable: async () => true,
        readFile: async () => null,
        listDirs: async () => [],
        gitConfigScan: async () => [],
      },
    });
    const report = await runDoctor(deps, { offline: true });
    expect(statusOf(report, "storage.state-dir-mode")).toBeUndefined();
    expect(statusOf(report, "storage.checkpoint-mode")).toBeUndefined();
  });

  it("STORAGE: executable-capable keys in the workspace .git/config warn (S2)", async () => {
    const c = await cap({ global: seedConfigDocument() });
    const deps = baseDeps({
      config: c,
      storage: {
        modeOf: async () => 0o700,
        isSymlink: async () => false,
        freeBytes: async () => 10 * 1024 * 1024 * 1024,
        dirUsable: async () => true,
        readFile: async () => null,
        listDirs: async () => [],
        gitConfigScan: async () => ["core.fsmonitor", "filter", "diff.external"],
      },
    });
    const report = await runDoctor(deps, { offline: true });
    const f = report.groups.find((g) => g.id === "storage")!.findings.find((x) => x.id === "storage.git-config-exec");
    expect(f?.status).toBe("warn");
    expect(f?.message).toContain("core.fsmonitor");
    expect(f?.fix).toBe("review .git/config");
    expect(f?.file).toBe("/ws/.git/config");
  });

  it("ROLLBACK: snapshotCount 0 is a warn naming rollback off, with the set fix and the key's layer/file", async () => {
    const c = await cap({ global: { ...seedConfigDocument(), snapshotCount: 0 } });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    const g = report.groups.find((x) => x.id === "rollback")!;
    const off = g.findings.find((f) => f.id === "rollback.off")!;
    expect(off.status).toBe("warn");
    expect(off.message).toBe("rollback is off (snapshotCount 0)");
    expect(off.fix).toBe('set "snapshotCount" to a number from 1 to 500');
    expect(off.layer).toBe("global");
    expect(g.findings.some((f) => f.id === "rollback.method")).toBe(false);
  });

  it("ROLLBACK: a non-repo workspace reports the cache method with snapshotCount and the cache dir mode", async () => {
    const c = await cap({ global: seedConfigDocument() });
    const deps = baseDeps({
      config: c,
      storage: {
        modeOf: async () => 0o700,
        isSymlink: async () => false,
        freeBytes: async () => 10 * 1024 * 1024 * 1024,
        dirUsable: async () => true,
        readFile: async () => null,
        listDirs: async () => [],
        gitConfigScan: async () => [],
        isGitRepo: async () => false,
        countVoidriftRefs: async () => 0,
        dirSizeBytes: async () => 1024,
        movesPerSession: async () => [{ sessionId: "s1", moves: 3 }],
      },
    });
    const report = await runDoctor(deps, { offline: true });
    const g = report.groups.find((x) => x.id === "rollback")!;
    const method = g.findings.find((f) => f.id === "rollback.method")!;
    expect(method.message).toBe("rollback method is cache (snapshotCount 50)");
    expect(method.layer).toBe("global");
    expect(g.findings.find((f) => f.id === "rollback.moves")!.message).toContain("3 recorded move(s)");
    expect(g.findings.some((f) => f.id === "rollback.refs")).toBe(false);
    expect(g.findings.find((f) => f.id === "rollback.cache-dir-mode")!.status).toBe("ok");
  });

  it("ROLLBACK: a git repo reports the git method and warns on an oversize cache and stale refs", async () => {
    const c = await cap({ global: { ...seedConfigDocument(), snapshotCount: 10 } });
    const deps = baseDeps({
      config: c,
      storage: {
        modeOf: async () => 0o755,
        isSymlink: async () => false,
        freeBytes: async () => 10 * 1024 * 1024 * 1024,
        dirUsable: async () => true,
        readFile: async () => null,
        listDirs: async () => [],
        gitConfigScan: async () => [],
        isGitRepo: async () => true,
        countVoidriftRefs: async () => 60,
        dirSizeBytes: async () => 300 * 1024 * 1024,
        movesPerSession: async () => [],
      },
    });
    const report = await runDoctor(deps, { offline: true });
    const g = report.groups.find((x) => x.id === "rollback")!;
    expect(g.findings.find((f) => f.id === "rollback.method")!.message).toContain("rollback method is git");
    const size = g.findings.find((f) => f.id === "rollback.cache-size")!;
    expect(size.status).toBe("warn");
    expect(size.fix).toContain("voidrift doctor does not delete");
    const stale = g.findings.find((f) => f.id === "rollback.stale-refs")!;
    expect(stale.status).toBe("warn");
    expect(stale.message).toContain("over 5x snapshotCount 10");
    const mode = g.findings.find((f) => f.id === "rollback.cache-dir-mode")!;
    expect(mode.status).toBe("warn");
    expect(mode.fix).toContain("chmod 700");
  });

  it("DRIFT: a seeded agent differing from the template warns with the per-agent reset fix", async () => {
    const c = await cap({ global: seedConfigDocument() });
    const deps = baseDeps({
      config: c,
      storage: {
        modeOf: async () => 0o700,
        isSymlink: async () => false,
        freeBytes: async () => 10 * 1024 * 1024 * 1024,
        dirUsable: async () => true,
        readFile: async (p) => {
          if (p === "/seed/agents/research/agent.json") return '{"template":true}';
          if (p === "/cfg/agents/research/agent.json") return '{"edited":true}';
          return null;
        },
        listDirs: async (p) => (p === "/cfg/agents" ? ["research"] : []),
        gitConfigScan: async () => [],
      },
    });
    const report = await runDoctor(deps, { offline: true });
    const f = report.groups.find((g) => g.id === "drift")!.findings.find((x) => x.id === "drift.agent.research");
    expect(f?.status).toBe("warn");
    expect(f?.fix).toBe("voidrift init --reset research");
  });

  it("OFFLINE: no network probe is invoked and each network check is ok 'skipped (offline)'", async () => {
    const c = await cap({ global: { models: { x: { model: "m", baseUrl: "http://h/v1" } }, modelSelected: "x", mcp: { srv: { transport: "stdio" } } } });
    let modelCalls = 0;
    let reachCalls = 0;
    const deps = baseDeps({
      config: c,
      modelListProbe: async () => {
        modelCalls++;
        return okProbe;
      },
      reachProbe: async () => {
        reachCalls++;
        return { reachable: true, status: 200 };
      },
    });
    const report = await runDoctor(deps, { offline: true });
    expect(modelCalls).toBe(0);
    expect(reachCalls).toBe(0);
    expect(statusOf(report, "models.endpoint.x")).toBe("ok");
    expect(statusOf(report, "mcp.srv")).toBe("ok");
  });

  it("MCP: a configured server is reported configuration-only; doctor never starts it", async () => {
    const c = await cap({ global: { mcp: { srv: { transport: "stdio" } } } });
    const report = await runDoctor(baseDeps({ config: c }), {});
    const f = report.groups.find((g) => g.id === "mcp")!.findings.find((x) => x.id === "mcp.srv");
    expect(f?.status).toBe("ok");
    expect(f?.message).toContain("doctor does not start servers (connect not checked)");
  });

  it("SECRETS: no secret value appears in the JSON output (env, URL userinfo)", async () => {
    process.env["DOCTOR_FAKE_SECRET"] = "s3cr3t-value";
    const c = await cap({
      global: {
        models: { x: { model: "m", baseUrl: "http://user:p4ss@host/v1", apiKeyEnv: "DOCTOR_FAKE_SECRET" } },
        modelSelected: "x",
      },
    });
    const deps = baseDeps({ config: c, envSet: (n) => process.env[n] !== undefined });
    const report = await runDoctor(deps, { offline: true });
    const json = JSON.stringify(report);
    expect(json).not.toContain("s3cr3t-value");
    expect(json).not.toContain("p4ss");
    expect(json).not.toContain("user:");
    delete process.env["DOCTOR_FAKE_SECRET"];
  });

  it("NETWORK SAFETY: a cross-host redirect is reported as a fail (not followed)", async () => {
    const c = await cap({ global: { models: { x: { model: "m", baseUrl: "http://h/v1" } }, modelSelected: "x" } });
    const deps = baseDeps({ config: c, modelListProbe: async () => ({ reachable: true, status: 302, crossHostRedirect: true }) });
    const report = await runDoctor(deps, {});
    expect(statusOf(report, "models.endpoint.x")).toBe("fail");
  });

  it("SSRF: a model baseUrl at a cloud-metadata address is NOT probed and fails", async () => {
    const c = await cap({ global: { models: { x: { model: "m", baseUrl: "http://169.254.169.254/latest/meta-data/" } }, modelSelected: "x" } });
    let modelCalls = 0;
    const deps = baseDeps({
      config: c,
      // Map nothing: assert the probe function is never invoked (zero requests).
      modelListProbe: async () => {
        modelCalls++;
        return okProbe;
      },
    });
    const report = await runDoctor(deps, {});
    expect(modelCalls).toBe(0);
    const f = report.groups.find((g) => g.id === "models")!.findings.find((x) => x.id === "models.endpoint.x");
    expect(f?.status).toBe("fail");
    expect(f?.message).toBe("model \"x\" baseUrl is a cloud-metadata address — not probed");
  });

  it("SSRF: a metadata baseUrl IS probed when 'metadata-hosts' is unlocked", async () => {
    const c = await cap({ global: { unlock: ["metadata-hosts"], models: { x: { model: "local-model", baseUrl: "http://metadata.google.internal/v1" } }, modelSelected: "x" } });
    let modelCalls = 0;
    const deps = baseDeps({
      config: c,
      modelListProbe: async () => {
        modelCalls++;
        return okProbe;
      },
    });
    const report = await runDoctor(deps, {});
    expect(modelCalls).toBe(1);
    expect(statusOf(report, "models.endpoint.x")).toBe("ok");
  });

  it("SSRF: a webSearch endpoint at a metadata address is NOT probed and fails", async () => {
    const c = await cap({ global: { webSearch: { provider: "searxng", endpoint: "http://169.254.169.254/" } } });
    let reachCalls = 0;
    const deps = baseDeps({
      config: c,
      reachProbe: async () => {
        reachCalls++;
        return { reachable: true, status: 200 };
      },
    });
    const report = await runDoctor(deps, {});
    expect(reachCalls).toBe(0);
    expect(statusOf(report, "web-search.reach")).toBe("fail");
  });

  it("PROXY: a set HTTP_PROXY/HTTPS_PROXY/ALL_PROXY warns in the web-search group, NAME only", async () => {
    const c = await cap({ global: seedConfigDocument() });
    const setVars = new Set(["HTTPS_PROXY", "all_proxy"]);
    const report = await runDoctor(baseDeps({ config: c, envSet: (n) => setVars.has(n) }), { offline: true });
    const ws = report.groups.find((g) => g.id === "web-search")!;
    const https = ws.findings.find((f) => f.id === "web-search.proxy.HTTPS_PROXY");
    const all = ws.findings.find((f) => f.id === "web-search.proxy.all_proxy");
    expect(https?.status).toBe("warn");
    expect(https?.message).toContain("HTTPS_PROXY");
    expect(https?.message).toContain("web_fetch private-address checks apply to the proxy connection");
    expect(https?.fix).toBe("unset it or route web access through a network policy you control");
    expect(all?.status).toBe("warn"); // either-case detection
    // No warning for an unset variable.
    expect(ws.findings.find((f) => f.id === "web-search.proxy.HTTP_PROXY")).toBeUndefined();
  });

  it("PROXY: no proxy env set yields no proxy findings", async () => {
    const c = await cap({ global: seedConfigDocument() });
    const report = await runDoctor(baseDeps({ config: c, envSet: () => false }), { offline: true });
    const ws = report.groups.find((g) => g.id === "web-search")!;
    expect(ws.findings.some((f) => f.id.startsWith("web-search.proxy."))).toBe(false);
  });

  it("VISIBILITY: a model baseUrl from the PROJECT layer warns, naming the file and host", async () => {
    const c = await cap({
      global: { models: { x: { model: "local-model", baseUrl: "http://localhost:11434/v1" } }, modelSelected: "x" },
      project: { models: { x: { model: "local-model", baseUrl: "http://user:pw@homelab.lan:8080/v1" } } },
    });
    const report = await runDoctor(baseDeps({ config: c }), {});
    const f = report.groups.find((g) => g.id === "models")!.findings.find((x) => x.id === "models.endpoint.project.x");
    expect(f?.status).toBe("warn");
    expect(f?.message).toContain("model endpoint 'x' comes from");
    expect(f?.message).toContain("homelab.lan");
    expect(f?.message).not.toContain("pw"); // credentials stripped
    expect(f?.fix).toBe("check that you trust this project");
  });

  it("LOCAL-FIRST: a loopback model baseUrl is still probed (the normal case)", async () => {
    const c = await cap({ global: { models: { x: { model: "local-model", baseUrl: "http://localhost:11434/v1" } }, modelSelected: "x" } });
    let modelCalls = 0;
    const deps = baseDeps({
      config: c,
      modelListProbe: async () => {
        modelCalls++;
        return okProbe;
      },
    });
    const report = await runDoctor(deps, {});
    expect(modelCalls).toBe(1);
    expect(statusOf(report, "models.endpoint.x")).toBe("ok");
  });

  it("NOISE: many missing seeded allow rules collapse to ONE allow-list finding and no drift roll-up", async () => {
    // A config with permissions present but none of the seeded ids.
    const c = await cap({ global: { permissions: { "my-rule": { tool: "read_file", decision: "allow", priority: 0, source: "workspace" } } } });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    const allowGroup = report.groups.find((g) => g.id === "allow-list")!;
    const missing = allowGroup.findings.filter((f) => f.id.startsWith("allow-list.missing"));
    expect(missing).toHaveLength(1);
    expect(missing[0]!.message).toMatch(/^\d+ seeded allow rules are missing: /);
    expect(missing[0]!.fix).toContain("voidrift init --update");
    // DRIFT no longer repeats the missing-rule roll-up.
    const driftGroup = report.groups.find((g) => g.id === "drift")!;
    expect(driftGroup.findings.find((f) => f.id === "drift.allow-rules")).toBeUndefined();
  });

  it("NOISE: only researcher_save_notes missing keeps its own distinct finding", async () => {
    const seeded = seedConfigDocument();
    const perms = { ...(seeded["permissions"] as Record<string, unknown>) };
    delete perms["allow-researcher_save_notes"];
    const c = await cap({ global: { ...seeded, permissions: perms } });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    const allowGroup = report.groups.find((g) => g.id === "allow-list")!;
    const f = allowGroup.findings.find((x) => x.id === "allow-list.missing.allow-researcher_save_notes");
    expect(f?.status).toBe("warn");
    expect(f?.message).toContain("researcher_save_notes");
  });

  it("stripUserinfo removes credentials from a URL", () => {
    expect(stripUserinfo("http://user:pass@host:11434/v1")).toBe("http://host:11434/v1");
    expect(stripUserinfo("not a url")).toBe("not a url");
  });
});

describe("doctor: limits group (§13.11)", () => {
  function limitsGroup(report: DoctorReport) {
    return report.groups.find((g) => g.id === "limits")!;
  }

  it("reports one ok summary per area, all at defaults when unset", async () => {
    const c = await cap({ global: seedConfigDocument() });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    const g = limitsGroup(report);
    const mem = g.findings.find((f) => f.id === "limits.memory");
    expect(mem?.status).toBe("ok");
    expect(mem?.message).toContain("all at defaults");
    // No safety-raise warnings for a clean seed.
    expect(g.findings.some((f) => f.status === "warn")).toBe(false);
  });

  it("marks an area customized when a layer sets a tunable limit", async () => {
    const c = await cap({ global: seedConfigDocument(), project: { limits: { memory: { projectChars: 4000 } } } });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    const mem = limitsGroup(report).findings.find((f) => f.id === "limits.memory");
    expect(mem?.message).toContain("customized");
  });

  it("WARNs naming the key, layer and file when a project layer tries to RAISE a safety limit", async () => {
    const c = await cap({
      global: { ...seedConfigDocument(), limits: { plugins: { optionsMaxBytes: 65536 } } },
      project: { limits: { plugins: { optionsMaxBytes: 1_000_000 } } },
    });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    const w = limitsGroup(report).findings.find((f) => f.id === "limits.safety-raise.plugins.optionsMaxBytes");
    expect(w?.status).toBe("warn");
    expect(w?.layer).toBe("project");
    expect(w?.file).toBe("memory://project");
    expect(w?.fix).toBeTruthy();
  });

  it("(a) WARNs when a download-class limit is set to action warn", async () => {
    const c = await cap({
      global: seedConfigDocument(),
      project: { limits: { tools: { webFetchBodyMaxBytes: { value: 5242880, action: "warn" } } } },
    });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    const f = limitsGroup(report).findings.find((x) => x.id === "limits.action-warn.tools.webFetchBodyMaxBytes");
    expect(f?.status).toBe("warn");
    expect(f?.message).toContain("webFetchBodyMaxBytes");
  });

  it("(a-deny) NO warn for download-class limit with action deny", async () => {
    const c = await cap({
      global: seedConfigDocument(),
      project: { limits: { tools: { webFetchBodyMaxBytes: { value: 5242880, action: "deny" } } } },
    });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    const f = limitsGroup(report).findings.find((x) => x.id === "limits.action-warn.tools.webFetchBodyMaxBytes");
    expect(f).toBeUndefined();
  });

  it("(b) NO warn for plan.maxTouches (tunable, not download-class)", async () => {
    const c = await cap({
      global: seedConfigDocument(),
      project: { limits: { plan: { maxTouches: 100 } } },
    });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    const g = limitsGroup(report);
    const w = g.findings.find((f) => f.id === "limits.action-warn.plan.maxTouches");
    expect(w).toBeUndefined();
  });

  it("(c) Lists each customized limit with value/action/class/source", async () => {
    const c = await cap({
      global: seedConfigDocument(),
      project: { limits: { tools: { webFetchBodyMaxBytes: 5242880 } } },
    });
    const report = await runDoctor(baseDeps({ config: c }), { offline: true });
    const g = limitsGroup(report);
    const f = g.findings.find((f) => f.id === "limits.customized.tools.webFetchBodyMaxBytes");
    expect(f?.status).toBe("ok");
    expect(f?.message).toContain("webFetchBodyMaxBytes");
    expect(f?.message).toContain("5242880");
    expect(f?.message).toContain("safety");
    expect(f?.message).toContain("project");
  });
});
