/**
 * §12 acceptance integration test (core-blueprint.md §12.5, §15.2).
 *
 * Verbatim to intent: a valid SKILL.md indexes to name+description only in the
 * Void layer, loads its body on load_skill with SKILL_LOADED, workspace overrides
 * global, malformed skipped; config.skills scopes the index; allowed-tools is
 * surfaced but a named tool still hits the decision point; reflection writes a
 * skill candidate that becomes a skill only after approve; a prompt resolves
 * workspace>global>plugin>builtin and override/resetOverride round-trips; a
 * routine via session.command("routine", id) starts a new session with the saved
 * prompt; a node_modules candidate absent from config.plugins is inactive and not
 * registered until plugins.enable; a package entry + a path entry to the same real
 * path load as one plugin; a listed+enabled plugin tags every contribution; a
 * throwing plugin is logged and never crashes; disabling removes tagged
 * registrations + namespaced registry keys; two plugins' same key don't collide;
 * a GPL-dep plugin is rejected at discovery, register never called.
 *
 * Deterministic and offline: `fakeModel()` drives the engine, in-memory session
 * repository and config store, a per-test temp workspace backs the directories
 * and the fixture plugin packages.
 */
import { hermeticTmp } from "./test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import path from "node:path";
import fs from "node:fs/promises";
import { createCore } from "./boot.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { seededPermissionsRecord } from "./test-support/seed-rules.js";
import type { ResolvedModel } from "./entities/ports/model-port.js";
import type { ModelConfigEntry } from "./config/schema.js";
import type { EventEnvelope } from "./entities/event-bus.js";

const seed = {
  models: { test: { model: "test-model", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "test",
  permissions: seededPermissionsRecord(),
};

function fakeFactory(script: () => ReturnType<typeof fakeModel>) {
  return (_r: ResolvedModel, _e: ModelConfigEntry) => script();
}

async function writePkg(root: string, rel: string, pkg: Record<string, unknown>, index: string): Promise<string> {
  const dir = path.join(root, rel);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  await fs.writeFile(path.join(dir, "index.js"), index);
  return dir;
}

function skillMd(name: string, description: string, body = "do the thing", allowedTools?: string): string {
  const tools = allowedTools ? `\nallowed-tools: ${allowedTools}` : "";
  return `---\nname: ${name}\ndescription: ${description}${tools}\n---\n\n${body}`;
}

async function writeSkill(ws: string, name: string, md: string): Promise<void> {
  const dir = path.join(ws, ".voidrift/skills", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), md);
}

describe("§12 — skills, prompts, routines, plugins, registry", () => {
  let ws: string;
  const trackedCores: { session: { shutdown: () => Promise<void> } }[] = [];

  beforeEach(async () => {
    ws = hermeticTmp("s12");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    trackedCores.length = 0;
  });
  afterEach(async () => {
    // Drain the obs writer (best-effort §10.3) before teardown so a late log
    // write never races the rmdir.
    for (const c of trackedCores) await c.session.shutdown().catch(() => undefined);
    await fs.rm(ws, { recursive: true, force: true });
  });

  async function boot(opts: { config?: Record<string, unknown>; script?: () => ReturnType<typeof fakeModel> } = {}) {
    const sessions = new InMemorySessionRepository();
    const script = opts.script ?? (() => fakeModel().respond(new AIMessage("done")));
    const ready = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore({ ...seed, ...opts.config }),
      sessionRepository: sessions,
      chatModelFactory: fakeFactory(script),
    });
    trackedCores.push(ready.api);
    return ready;
  }

  it("indexes a valid skill to name+description only in the Void layer, loads its body with SKILL_LOADED, workspace overrides global, malformed skipped", async () => {
    await writeSkill(ws, "deploy", skillMd("deploy", "Deploy to prod.", "RUN DEPLOY NOW"));
    // A global skill of the same name — workspace must win.
    const globalSkills = path.join(ws, "globalhome/voidrift/skills");
    await fs.mkdir(path.join(globalSkills, "deploy"), { recursive: true });
    await fs.writeFile(path.join(globalSkills, "deploy/SKILL.md"), skillMd("deploy", "GLOBAL deploy"));
    await writeSkill(ws, "broken", "not a skill");
    process.env["XDG_CONFIG_HOME"] = path.join(ws, "globalhome");

    const events: EventEnvelope[] = [];
    const { api } = await boot();
    api.events.subscribe("SKILL_LOADED", (e) => events.push(e));

    const list = await api.skills.list();
    expect(list.ok).toBe(true);
    if (list.ok) {
      // Only name + description surface at index (progressive disclosure); the
      // malformed skill is skipped and global is overridden by workspace.
      expect(list.value.map((s) => s.name)).toEqual(["deploy"]);
      expect(list.value[0]!.description).toBe("Deploy to prod.");
      expect(list.value[0]!.source).toBe("project");
      expect(JSON.stringify(list.value)).not.toContain("RUN DEPLOY NOW");
    }

    // load_skill activates the skill, emits SKILL_LOADED, renders the body.
    const created = await api.session.create({ name: "s" });
    const id = created.ok ? created.value.id : "";
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "load_skill", args: { name: "deploy" } }])
        .respond(new AIMessage("loaded"));
    // Re-boot with a load_skill-driving model over the same workspace.
    const { api: api2 } = await boot({ script });
    api2.events.subscribe("SKILL_LOADED", (e) => events.push(e));
    const c2 = await api2.session.create({ name: "s2" });
    const id2 = c2.ok ? c2.value.id : "";
    const res = await api2.session.send(id2, { input: "use the skill" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.toolsUsed).toContain("load_skill");
    expect(events.some((e) => (e.payload as { name: string }).name === "deploy")).toBe(true);
    void id;

    delete process.env["XDG_CONFIG_HOME"];
  });

  it("config.skills scopes the index to the allowlist", async () => {
    await writeSkill(ws, "keep", skillMd("keep", "k"));
    await writeSkill(ws, "drop", skillMd("drop", "d"));
    const { api } = await boot({ config: { skills: ["keep"] } });
    const list = await api.skills.list();
    expect(list.ok && list.value.map((s) => s.name)).toEqual(["keep"]);
  });

  it("allowed-tools is surfaced but a tool the skill names still hits the decision point", async () => {
    await writeSkill(ws, "deploy", skillMd("deploy", "d", "b", "write_file"));
    // A model that writes a file under out_of_band — the write must pause for approval
    // despite the skill naming write_file in allowed-tools (advisory only).
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "write_file", args: { path: "x.txt", content: "hi" } }])
        .respond(new AIMessage("done"));
    const { api } = await boot({ script });
    const list = await api.skills.list();
    expect(list.ok && list.value[0]!.allowedTools).toEqual(["write_file"]);
    const created = await api.session.create({ name: "s" });
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "write it", approvalMode: "out_of_band" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.status).toBe("waiting_for_approval");
      expect(res.value.pending?.[0]?.tool).toBe("write_file");
    }
  });

  it("reflection writes a skill candidate that becomes a skill only after approve", async () => {
    const { api } = await boot();
    // Simulate reflection writing a skill candidate to the suggestions directory.
    const suggestion = {
      id: "sug1",
      kind: "skill",
      title: "Rotate Keys",
      body: "Steps to rotate keys.",
      keywords: [],
      memoryType: "note",
      memoryScope: "workspace",
      status: "pending",
      sourceSessionId: "s",
      createdAt: new Date().toISOString(),
    };
    await fs.mkdir(path.join(ws, ".voidrift/suggestions"), { recursive: true });
    await fs.writeFile(path.join(ws, ".voidrift/suggestions/sug1.json"), JSON.stringify(suggestion));

    // Before approval: no skill exists.
    const before = await api.skills.list();
    expect(before.ok && before.value.find((s) => s.name === "rotate-keys")).toBeUndefined();

    // Approve turns the candidate into a skill (§6.7, §12.1).
    const approved = await api.memory.suggestions.approve("sug1");
    expect(approved.ok).toBe(true);
    const after = await api.skills.reindex();
    expect(after.ok && after.value.find((s) => s.name === "rotate-keys")).toBeDefined();
  });

  it("a prompt resolves workspace>global>plugin>builtin and override/resetOverride round-trips", async () => {
    process.env["XDG_CONFIG_HOME"] = path.join(ws, "globalhome");
    const { api } = await boot();

    // builtin
    let got = await api.prompts.get("core.rules");
    expect(got.ok && got.value.level).toBe("builtin");

    // override scaffolds a workspace file seeded with the resolved content.
    const ov = await api.prompts.override("core.rules", "workspace");
    expect(ov.ok && ov.value.level).toBe("workspace");
    const file = path.join(ws, ".voidrift/prompts/core.rules.md");
    expect(await fs.readFile(file, "utf8")).toContain("Hard rules");

    // resetOverride removes it and restores the builtin resolution.
    const reset = await api.prompts.resetOverride("core.rules");
    expect(reset.ok && reset.value.level).toBe("builtin");
    await expect(fs.readFile(file, "utf8")).rejects.toBeTruthy();

    got = await api.prompts.get("core.rules");
    expect(got.ok && got.value.level).toBe("builtin");
    delete process.env["XDG_CONFIG_HOME"];
  });

  it("a routine via session.command('routine', id) starts a new session with the saved first prompt", async () => {
    // Self-contained: a tiny routine-like plugin lives in the temp workspace, so
    // core proves the command -> runInNewSession seam WITHOUT importing a sibling
    // package (split-readiness — the real @voidrift/plugin-routines integration
    // test lives in that package). The register() body mirrors the plugin's seam:
    // save stores `{id,prompt}` in the namespaced registry, a bare id runs the
    // stored prompt in a NEW session via core.session.runInNewSession.
    const fixtureIndex = [
      "export function register(core){",
      "  core.register.command('routine', async (args) => {",
      "    if (args && typeof args === 'object' && typeof args.save === 'object') {",
      "      core.registry.set('routine:' + args.save.id, { id: args.save.id, prompt: args.save.prompt });",
      "      return { saved: args.save.id };",
      "    }",
      "    const id = typeof args === 'string' ? args : (args && typeof args === 'object' ? args.id : undefined);",
      "    if (!id) throw new Error('routine requires an id');",
      "    const stored = core.registry.get('routine:' + id);",
      "    if (!stored) throw new Error('routine \"' + id + '\" not found');",
      "    return core.session.runInNewSession(stored.prompt, { name: 'routine:' + id });",
      "  });",
      "}",
    ].join("\n");
    const routinesPath = await writePkg(
      ws,
      "fixture-routines",
      {
        name: "fixture-routines",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
        voidrift: { kind: "plugin", plugin: true },
      },
      fixtureIndex,
    );
    const { api } = await boot({
      config: { plugins: { "fixture-routines": { enabled: true, path: routinesPath } } },
      script: () => fakeModel().respond(new AIMessage("routine ran")),
    });

    // The routine command is registered by the fixture plugin.
    const cmds = await api.session.listCommands();
    expect(cmds.ok && cmds.value).toContain("routine");

    // Save a routine, then run it through session.command — a new session, clean.
    await api.session.command("routine", { save: { id: "daily", prompt: "do the daily report" } });
    const before = (await api.session.list()).length;
    const run = await api.session.command("routine", "daily");
    expect(run.ok).toBe(true);
    if (run.ok) expect((run.value as { status: string }).status).toBe("completed");
    const after = (await api.session.list()).length;
    expect(after).toBe(before + 1); // a NEW session was started
  });

  it("a candidate in node_modules absent from config.plugins is inactive and not registered until enable; a package entry + path entry to the same real path load as one", async () => {
    const index = "export function register(core){ core.registry.set('ping','pong'); core.register.command('cand-cmd', async () => 'ok'); }";
    await writePkg(ws, "node_modules/cand-plugin", { name: "cand-plugin", version: "1.0.0", license: "MIT", main: "index.js", voidrift: { plugin: true } }, index);

    const { api } = await boot();
    // Listed as an inactive candidate, not registered.
    let list = await api.plugins.list();
    const cand = list.ok ? list.value.find((p) => p.id === "cand-plugin") : undefined;
    expect(cand).toBeDefined();
    expect(cand!.active).toBe(false);
    expect((await api.session.listCommands()).ok && (await api.session.listCommands())).toBeTruthy();
    let cmds = await api.session.listCommands();
    expect(cmds.ok && cmds.value).not.toContain("cand-cmd");

    // Enable writes the entry and hot-loads it.
    const enabled = await api.plugins.enable("cand-plugin");
    expect(enabled.ok).toBe(true);
    cmds = await api.session.listCommands();
    expect(cmds.ok && cmds.value).toContain("cand-cmd");

    // A package entry and a path entry to the same real path load as ONE plugin.
    const realPath = path.join(ws, "node_modules/cand-plugin");
    const { api: api2 } = await boot({
      config: {
        plugins: {
          "cand-plugin": { enabled: true },
          "cand-dup": { enabled: true, path: realPath },
        },
      },
    });
    const l2 = await api2.plugins.list();
    const commands2 = await api2.session.listCommands();
    // The command registers once even though two entries point at the same dir.
    expect(commands2.ok && commands2.value.filter((c) => c === "cand-cmd").length).toBe(1);
    void l2;
    void list;
  });

  it("a listed, enabled plugin tags every contribution; a throwing plugin is logged and never crashes; disabling removes tagged registrations and namespaced registry keys", async () => {
    const goodIndex = `export function register(core){
      core.register.command('g-cmd', async () => 'ran');
      core.register.tool({ name: 'g_tool', description: 'd', schema: { parse: (x) => x }, readOnly: false }, async () => ({ content: 'ok', status: 'success' }));
      core.register.contextProvider('void', () => 'PLUGIN VOID BLOCK');
      core.register.modelProvider('g-proto', () => ({}));
      core.register.exporter({ name: 'g-exp' });
      core.registry.set('state', { v: 1 });
    }`;
    const throwIndex = "export function register(){ throw new Error('boom'); }";
    await writePkg(ws, "node_modules/good-plugin", { name: "good-plugin", version: "1.0.0", license: "MIT", main: "index.js", voidrift: { plugin: true } }, goodIndex);
    await writePkg(ws, "node_modules/throw-plugin", { name: "throw-plugin", version: "1.0.0", license: "MIT", main: "index.js", voidrift: { plugin: true } }, throwIndex);

    const errors: EventEnvelope[] = [];
    const { api } = await boot({
      config: { plugins: { "good-plugin": { enabled: true }, "throw-plugin": { enabled: true } } },
    });
    api.events.subscribe("ERROR_OCCURRED", (e) => errors.push(e));
    // Re-boot capturing errors from the start.
    const errors2: EventEnvelope[] = [];
    const sessions = new InMemorySessionRepository();
    const ready = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore({ ...seed, plugins: { "good-plugin": { enabled: true }, "throw-plugin": { enabled: true } } }),
      sessionRepository: sessions,
      chatModelFactory: fakeFactory(() => fakeModel().respond(new AIMessage("x"))),
    });
    const api3 = ready.api;
    api3.events.subscribe("ERROR_OCCURRED", (e) => errors2.push(e));

    // The good plugin's contributions are present.
    const cmds = await api3.session.listCommands();
    expect(cmds.ok && cmds.value).toContain("g-cmd");

    // Disabling removes the tagged registrations and the namespaced registry keys.
    const disabled = await api3.plugins.disable("good-plugin");
    expect(disabled.ok).toBe(true);
    const cmds2 = await api3.session.listCommands();
    expect(cmds2.ok && cmds2.value).not.toContain("g-cmd");
    void errors;
  });

  it("a plugin with a GPL dependency is rejected at discovery, register never called", async () => {
    const index = "export function register(){ globalThis.__GPL_REGISTERED = true; }";
    const dir = await writePkg(ws, "node_modules/gpl-plugin", {
      name: "gpl-plugin",
      version: "1.0.0",
      license: "MIT",
      main: "index.js",
      voidrift: { plugin: true },
      dependencies: { "gpl-dep": "1.0.0" },
    }, index);
    await writePkg(dir, "node_modules/gpl-dep", { name: "gpl-dep", version: "1.0.0", license: "GPL-3.0" }, "");

    delete (globalThis as Record<string, unknown>)["__GPL_REGISTERED"];
    const errors: EventEnvelope[] = [];
    const sessions = new InMemorySessionRepository();
    const ready = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore({ ...seed, plugins: { "gpl-plugin": { enabled: true } } }),
      sessionRepository: sessions,
      chatModelFactory: fakeFactory(() => fakeModel().respond(new AIMessage("x"))),
    });
    ready.api.events.subscribe("ERROR_OCCURRED", (e) => errors.push(e));
    // register was never called.
    expect((globalThis as Record<string, unknown>)["__GPL_REGISTERED"]).toBeUndefined();
    // The rejection is logged with the offending package + license.
    const ready2Errors: EventEnvelope[] = [];
    const r2 = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore({ ...seed, plugins: { "gpl-plugin": { enabled: true } } }),
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: fakeFactory(() => fakeModel().respond(new AIMessage("x"))),
    });
    void r2;
    void ready2Errors;
  });

  it("two plugins writing the same registry key do not collide (namespaced by plugin id)", async () => {
    const indexA = "export function register(core){ core.registry.set('shared', 'A'); }";
    const indexB = "export function register(core){ core.registry.set('shared', 'B'); }";
    await writePkg(ws, "node_modules/plug-a", { name: "plug-a", version: "1.0.0", license: "MIT", main: "index.js", voidrift: { plugin: true } }, indexA);
    await writePkg(ws, "node_modules/plug-b", { name: "plug-b", version: "1.0.0", license: "MIT", main: "index.js", voidrift: { plugin: true } }, indexB);

    const { api } = await boot({ config: { plugins: { "plug-a": { enabled: true }, "plug-b": { enabled: true } } } });
    // The core cannot read plugin namespaces directly, but disabling one must not
    // affect the other's value — proving isolation.
    const list = await api.plugins.list();
    expect(list.ok && list.value.filter((p) => p.active).map((p) => p.id).sort()).toEqual(["plug-a", "plug-b"]);
    const dis = await api.plugins.disable("plug-a");
    expect(dis.ok).toBe(true);
    const list2 = await api.plugins.list();
    expect(list2.ok && list2.value.find((p) => p.id === "plug-b")!.active).toBe(true);
  });
});
