/**
 * Persist-to-project tests (core-blueprint.md §9.2, Slice C3). An interactive
 * approval's PERSIST choice writes the EXACT allow rule to the PROJECT allow
 * list only, idempotently, with core-side validation of the chosen pattern. A
 * force-ask refuses remember; a write failure falls back to approve-once with a
 * notice; existing project entries are preserved; a non-interactive/headless run
 * can never reach persist. Deterministic and offline.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createCore } from "../boot.js";
import { InMemoryConfigStore } from "../adapters/repositories/in-memory-config-store.js";
import { FilesystemConfigStore } from "../adapters/repositories/filesystem-config-store.js";
import { InMemorySessionRepository } from "../adapters/repositories/session-repository.js";
import type { ResolvedModel } from "../entities/ports/model-port.js";
import type { ModelConfigEntry } from "../config/schema.js";
import { seededPermissionsRecord } from "../test-support/seed-rules.js";

const seed = {
  models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "t",
  permissions: seededPermissionsRecord(),
};

function factory(script: () => ReturnType<typeof fakeModel>) {
  return (_r: ResolvedModel, _e: ModelConfigEntry) => script();
}

const tracked: { session: { shutdown: () => Promise<void> } }[] = [];
async function make(opts: Parameters<typeof createCore>[0]): ReturnType<typeof createCore> {
  const ready = await createCore(opts);
  tracked.push(ready.api);
  return ready;
}

describe("persist to project (§9.2, Slice C3)", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), "vr-persist-"));
  });
  afterEach(async () => {
    for (const c of tracked) await c.session.shutdown().catch(() => undefined);
    tracked.length = 0;
    await fs.rm(ws, { recursive: true, force: true }).catch(() => undefined);
  });

  it("writes the EXACT rule to the project layer and auto-approves a later identical call", async () => {
    const store = new InMemoryConfigStore(seed);
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "write_file", args: { path: "note.txt", content: "a" } }])
        .respondWithTools([{ name: "write_file", args: { path: "note.txt", content: "b" } }])
        .respond(new AIMessage("done"));
    const added: unknown[] = [];
    const { api } = await make({
      workspaceRoot: ws,
      configStore: store,
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
      onApproval: async (req) => ({ requestId: req.id, decision: "approve", remember: "project", chosenPattern: "note.txt" }),
    });
    api.events.subscribe("PERMISSION_RULE_ADDED", (e) => added.push(e.payload));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "write twice", approvalMode: "interactive" });
    expect(res.ok && res.value.status).toBe("completed");

    // The second identical write auto-approved (the project rule is in effect
    // immediately in the same session).
    expect(await fs.readFile(path.join(ws, "note.txt"), "utf8")).toBe("b");

    // The EXACT rule landed in the PROJECT layer only.
    const project = (await store.read("project")) as { permissions: Record<string, unknown> };
    const rules = Object.values(project.permissions);
    expect(rules).toContainEqual({
      tool: "write_file",
      pattern: "note.txt",
      decision: "allow",
      priority: 0,
      source: "workspace",
    });
    expect(added.length).toBeGreaterThan(0);
  });

  it("is idempotent: persisting the identical rule twice never duplicates it", async () => {
    const store = new InMemoryConfigStore(seed);
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "write_file", args: { path: "dup.txt", content: "a" } }])
        .respond(new AIMessage("one"));
    // First run persists.
    const first = await make({
      workspaceRoot: ws,
      configStore: store,
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
      onApproval: async (req) => ({ requestId: req.id, decision: "approve", remember: "project", chosenPattern: "dup.txt" }),
    });
    const c1 = await first.api.session.create({});
    await first.api.session.send(c1.ok ? c1.value.id : "", { input: "write", approvalMode: "interactive" });
    const afterFirst = (await store.read("project")) as { permissions: Record<string, unknown> };
    const keysFirst = Object.keys(afterFirst.permissions);

    // Second run would persist the same rule again — same deterministic id.
    const second = await make({
      workspaceRoot: ws,
      configStore: store,
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
      onApproval: async (req) => ({ requestId: req.id, decision: "approve", remember: "project", chosenPattern: "dup.txt" }),
    });
    const c2 = await second.api.session.create({});
    await second.api.session.send(c2.ok ? c2.value.id : "", { input: "write", approvalMode: "interactive" });
    const afterSecond = (await store.read("project")) as { permissions: Record<string, unknown> };
    expect(Object.keys(afterSecond.permissions)).toEqual(keysFirst);
  });

  it("preserves existing project permissions when adding a new persisted rule", async () => {
    const existingRule = { tool: "glob_files", decision: "allow" as const, priority: 0, source: "workspace" as const };
    const store = new InMemoryConfigStore(seed, { project: { permissions: { "keep-me": existingRule } } });
    const script = () =>
      fakeModel().respondWithTools([{ name: "write_file", args: { path: "new.txt", content: "a" } }]).respond(new AIMessage("ok"));
    const { api } = await make({
      workspaceRoot: ws,
      configStore: store,
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
      onApproval: async (req) => ({ requestId: req.id, decision: "approve", remember: "project", chosenPattern: "new.txt" }),
    });
    const c = await api.session.create({});
    await api.session.send(c.ok ? c.value.id : "", { input: "write", approvalMode: "interactive" });
    const project = (await store.read("project")) as { permissions: Record<string, unknown> };
    // The pre-existing entry is untouched; the new one is added alongside it.
    expect(project.permissions["keep-me"]).toEqual(existingRule);
    expect(Object.keys(project.permissions).length).toBe(2);
  });

  it("REJECTS a chosen pattern the core did not offer (e.g. `*`): approve-once, nothing written, notice", async () => {
    const store = new InMemoryConfigStore(seed);
    const script = () =>
      fakeModel().respondWithTools([{ name: "write_file", args: { path: "x.txt", content: "a" } }]).respond(new AIMessage("ok"));
    let rejected = false;
    const { api } = await make({
      workspaceRoot: ws,
      configStore: store,
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
      // A compromised/buggy UI tries to widen the rule to match-anything.
      onApproval: async (req) => ({ requestId: req.id, decision: "approve", remember: "project", chosenPattern: "*" }),
    });
    api.events.subscribe("PERMISSION_RULE_REJECTED", () => (rejected = true));
    const c = await api.session.create({});
    const res = await api.session.send(c.ok ? c.value.id : "", { input: "write", approvalMode: "interactive" });
    // The call still proceeded as approve-once.
    expect(res.ok && res.value.status).toBe("completed");
    expect(await fs.readFile(path.join(ws, "x.txt"), "utf8")).toBe("a");
    // Nothing was written to the project layer and a notice was surfaced.
    const project = (await store.read("project")) as { permissions?: Record<string, unknown> } | null;
    expect(project?.permissions ?? {}).toEqual({});
    expect(rejected).toBe(true);
  });

  it("a force-ask (dangerous shell) is rememberable ONLY as an exact rule (owner D2a)", async () => {
    const store = new InMemoryConfigStore(seed);
    const script = () =>
      fakeModel().respondWithTools([{ name: "execute_command", args: { command: "git push --force" } }]).respond(new AIMessage("ok"));
    let sawRule = false;
    const { api } = await make({
      workspaceRoot: ws,
      configStore: store,
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
      onApproval: async (req) => {
        // A clean (no masked secret), short force-ask value is rememberable as
        // EXACT: the dialog shows four choices and the one offered pattern is
        // the literal command.
        expect(req.rememberable).toBe(true);
        expect(req.exactOnly).toBe(true);
        expect(req.forceAskKind).toBe("shell");
        expect(req.inferredPatterns).toEqual(["git push --force"]);
        return {
          requestId: req.id,
          decision: "approve" as const,
          remember: "project" as const,
          ...(req.inferredPatterns?.[0] !== undefined ? { chosenPattern: req.inferredPatterns[0] } : {}),
        };
      },
    });
    api.events.subscribe("PERMISSION_RULE_ADDED", () => (sawRule = true));
    const c = await api.session.create({});
    await api.session.send(c.ok ? c.value.id : "", { input: "danger", approvalMode: "interactive" });
    expect(sawRule).toBe(true);
    const project = (await store.read("project")) as { permissions: Record<string, unknown> };
    expect(Object.values(project.permissions)).toContainEqual({
      tool: "execute_command",
      pattern: "git push --force",
      exact: true,
      decision: "allow",
      priority: 0,
      source: "workspace",
    });
  });

  it("a force-ask with a masked secret in the value is NOT rememberable (owner D2a)", async () => {
    const store = new InMemoryConfigStore(seed);
    // A command carrying an obvious secret so the masker changes the text; the
    // exact value would then never match the real command, so it is not offered.
    const secretCmd = "git push --force https://user:ghp_01" + "23456789abcdefghijABCDEFGHIJ0123@host/r";
    const script = () =>
      fakeModel().respondWithTools([{ name: "execute_command", args: { command: secretCmd } }]).respond(new AIMessage("ok"));
    const { api } = await make({
      workspaceRoot: ws,
      configStore: store,
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
      onApproval: async (req) => {
        expect(req.rememberable).toBe(false);
        expect(req.exactOnly).toBeFalsy();
        return { requestId: req.id, decision: "approve" as const };
      },
    });
    let sawRule = false;
    api.events.subscribe("PERMISSION_RULE_ADDED", () => (sawRule = true));
    const c = await api.session.create({});
    await api.session.send(c.ok ? c.value.id : "", { input: "danger", approvalMode: "interactive" });
    expect(sawRule).toBe(false);
    const project = (await store.read("project")) as { permissions?: Record<string, unknown> } | null;
    expect(project?.permissions ?? {}).toEqual({});
  });

  it("a force-ask rejects a forged chosenPattern not among the offered ones (owner D2a)", async () => {
    const store = new InMemoryConfigStore(seed);
    const script = () =>
      fakeModel().respondWithTools([{ name: "execute_command", args: { command: "git push --force" } }]).respond(new AIMessage("ok"));
    let rejected = false;
    const { api } = await make({
      workspaceRoot: ws,
      configStore: store,
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
      // A buggy/compromised UI tries to widen the exact rule to `*`.
      onApproval: async (req) => ({ requestId: req.id, decision: "approve", remember: "project", chosenPattern: "*" }),
    });
    api.events.subscribe("PERMISSION_RULE_REJECTED", () => (rejected = true));
    const c = await api.session.create({});
    await api.session.send(c.ok ? c.value.id : "", { input: "danger", approvalMode: "interactive" });
    expect(rejected).toBe(true);
    const project = (await store.read("project")) as { permissions?: Record<string, unknown> } | null;
    expect(project?.permissions ?? {}).toEqual({});
  });

  it("a session-remembered exact force-ask lifts a second identical call (no second prompt, owner D2a)", async () => {
    const store = new InMemoryConfigStore(seed);
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "execute_command", args: { command: "git push --force" } }])
        .respondWithTools([{ name: "execute_command", args: { command: "git push --force" } }])
        .respond(new AIMessage("done"));
    let prompts = 0;
    const { api } = await make({
      workspaceRoot: ws,
      configStore: store,
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
      onApproval: async (req) => {
        prompts += 1;
        return {
          requestId: req.id,
          decision: "approve" as const,
          remember: "session" as const,
          ...(req.inferredPatterns?.[0] !== undefined ? { chosenPattern: req.inferredPatterns[0] } : {}),
        };
      },
    });
    const c = await api.session.create({});
    const res = await api.session.send(c.ok ? c.value.id : "", { input: "push twice", approvalMode: "interactive" });
    expect(res.ok && res.value.status).toBe("completed");
    // Only the FIRST call prompted; the session exact rule lifted the second.
    expect(prompts).toBe(1);
    // Nothing was persisted to the project (session-only remember).
    const project = (await store.read("project")) as { permissions?: Record<string, unknown> } | null;
    expect(project?.permissions ?? {}).toEqual({});
  });

  it("a headless run can NEVER reach persist (it never asks; nothing is written)", async () => {
    const store = new InMemoryConfigStore(seed);
    const script = () =>
      fakeModel().respondWithTools([{ name: "write_file", args: { path: "h.txt", content: "a" } }]).respond(new AIMessage("ok"));
    let asked = false;
    let sawRule = false;
    const { api } = await make({
      workspaceRoot: ws,
      configStore: store,
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
      // The handler would try to persist — but a headless run denies-and-
      // continues before any ask, so onApproval is never invoked.
      onApproval: async (req) => {
        asked = true;
        return { requestId: req.id, decision: "approve", remember: "project", chosenPattern: "h.txt" };
      },
    });
    api.events.subscribe("PERMISSION_RULE_ADDED", () => (sawRule = true));
    const c = await api.session.create({});
    await api.session.send(c.ok ? c.value.id : "", { input: "write", approvalMode: "headless" });
    expect(asked).toBe(false);
    expect(sawRule).toBe(false);
    const project = (await store.read("project")) as { permissions?: Record<string, unknown> } | null;
    expect(project?.permissions ?? {}).toEqual({});
  });

  it("a deny rule anywhere still wins: persisting an allow never reaches a denied call (§C2)", async () => {
    // A global deny on write_file means the prompt is never reached; the call is
    // denied outright and no persist can override it.
    const store = new InMemoryConfigStore({
      ...seed,
      permissions: { ...seededPermissionsRecord(), "deny-wf": { tool: "write_file", decision: "deny", priority: 0, source: "user" } },
    });
    const script = () =>
      fakeModel().respondWithTools([{ name: "write_file", args: { path: "d.txt", content: "a" } }]).respond(new AIMessage("ok"));
    let asked = false;
    const { api } = await make({
      workspaceRoot: ws,
      configStore: store,
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
      onApproval: async (req) => {
        asked = true;
        return { requestId: req.id, decision: "approve", remember: "project", chosenPattern: "d.txt" };
      },
    });
    const c = await api.session.create({});
    await api.session.send(c.ok ? c.value.id : "", { input: "write", approvalMode: "interactive" });
    // The deny blocked the call before any ask; the file was never written.
    expect(asked).toBe(false);
    await expect(fs.readFile(path.join(ws, "d.txt"), "utf8")).rejects.toThrow();
    const project = (await store.read("project")) as { permissions?: Record<string, unknown> } | null;
    expect(project?.permissions ?? {}).toEqual({});
  });

  it("a project-write failure falls back to approve-once and surfaces a one-line notice (no values)", async () => {
    // A config store whose PROJECT write fails (read-only fs / unwritable dir):
    // the user's approval must not be lost and nothing partial is written.
    const base = new InMemoryConfigStore(seed);
    const store = {
      read: (l: Parameters<typeof base.read>[0]) => base.read(l),
      reject: (l: Parameters<typeof base.reject>[0], d: Record<string, unknown>) => base.reject(l, d),
      pathOf: (l: Parameters<typeof base.pathOf>[0]) => base.pathOf(l),
      write: async (l: Parameters<typeof base.write>[0], d: Record<string, unknown>) => {
        if (l === "project") throw new Error("EROFS: read-only file system");
        return base.write(l, d);
      },
    } as unknown as InMemoryConfigStore;
    const script = () =>
      fakeModel().respondWithTools([{ name: "write_file", args: { path: "y.txt", content: "a" } }]).respond(new AIMessage("ok"));
    let failedNotice: Record<string, unknown> | null = null;
    const { api } = await make({
      workspaceRoot: ws,
      configStore: store,
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
      onApproval: async (req) => ({ requestId: req.id, decision: "approve", remember: "project", chosenPattern: "y.txt" }),
    });
    api.events.subscribe("PERMISSION_RULE_PERSIST_FAILED", (e) => (failedNotice = e.payload as Record<string, unknown>));
    const c = await api.session.create({});
    const res = await api.session.send(c.ok ? c.value.id : "", { input: "write", approvalMode: "interactive" });
    // The call still proceeded as approve-once.
    expect(res.ok && res.value.status).toBe("completed");
    expect(await fs.readFile(path.join(ws, "y.txt"), "utf8")).toBe("a");
    // A one-line notice named the file and reason; it carries NO rule/values.
    expect(failedNotice).not.toBeNull();
    expect((failedNotice as unknown as { file: string }).file).toBe(".voidrift/config.json");
    expect(failedNotice as unknown as Record<string, unknown>).not.toHaveProperty("rule");
  });

  it("writes the project file owner-only (dir 0700, file 0600) on a real filesystem", async () => {
    const store = new FilesystemConfigStore(ws);
    // Seed the global layer via the store so boot does not re-seed.
    await store.write("global", seed);
    const script = () =>
      fakeModel().respondWithTools([{ name: "write_file", args: { path: "m.txt", content: "a" } }]).respond(new AIMessage("ok"));
    const { api } = await make({
      workspaceRoot: ws,
      configStore: store,
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
      onApproval: async (req) => ({ requestId: req.id, decision: "approve", remember: "project", chosenPattern: "m.txt" }),
    });
    const c = await api.session.create({});
    await api.session.send(c.ok ? c.value.id : "", { input: "write", approvalMode: "interactive" });
    const cfgPath = path.join(ws, ".voidrift", "config.json");
    const fileStat = await fs.stat(cfgPath);
    const dirStat = await fs.stat(path.join(ws, ".voidrift"));
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("two concurrent persists in one run both land (mutex serialises the read-modify-write)", async () => {
    // Slice C3b — the persist mutex serialises the project read-modify-write so
    // two approvals resolving close together can never read-then-overwrite and
    // lose an update. A single run makes TWO different writes, each persisted to
    // the project; both deterministic ids must survive.
    const store = new FilesystemConfigStore(ws);
    await store.write("global", seed);
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "write_file", args: { path: "one.txt", content: "a" } }])
        .respondWithTools([{ name: "write_file", args: { path: "two.txt", content: "b" } }])
        .respond(new AIMessage("done"));
    const { api } = await make({
      workspaceRoot: ws,
      configStore: store,
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
      // Persist whichever file this call is for (its own chosen pattern).
      onApproval: async (req) => ({
        requestId: req.id,
        decision: "approve" as const,
        remember: "project" as const,
        ...(req.inferredPatterns?.[0] !== undefined ? { chosenPattern: req.inferredPatterns[0] } : {}),
      }),
    });
    const c = await api.session.create({});
    const res = await api.session.send(c.ok ? c.value.id : "", { input: "write two files", approvalMode: "interactive" });
    expect(res.ok && res.value.status).toBe("completed");
    const project = (await store.read("project")) as { permissions: Record<string, unknown> };
    const patterns = Object.values(project.permissions).map((r) => (r as { pattern?: string }).pattern);
    // Neither update was lost — both rules are present.
    expect(patterns).toContain("one.txt");
    expect(patterns).toContain("two.txt");
  });

  it("persisting onto a currently-INVALID project file: the bad doc is set aside .rejected; the rule writes on last-known-good", async () => {
    // Given — a real store with a seeded global and a project config.json that
    // is a valid JSON document but fails config validation (an unknown top-level
    // key). Config load sets the broken copy aside as `.rejected` and keeps the
    // last-known-good project permissions (none), per §13.3.
    const store = new FilesystemConfigStore(ws);
    await store.write("global", seed);
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    const cfgPath = path.join(ws, ".voidrift", "config.json");
    await fs.writeFile(cfgPath, JSON.stringify({ totallyUnknownKey: true }), "utf8");

    const script = () =>
      fakeModel().respondWithTools([{ name: "write_file", args: { path: "ok.txt", content: "a" } }]).respond(new AIMessage("ok"));
    const { api } = await make({
      workspaceRoot: ws,
      configStore: store,
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
      onApproval: async (req) => ({ requestId: req.id, decision: "approve", remember: "project", chosenPattern: "ok.txt" }),
    });
    const c = await api.session.create({});
    const res = await api.session.send(c.ok ? c.value.id : "", { input: "write", approvalMode: "interactive" });
    expect(res.ok && res.value.status).toBe("completed");

    // The invalid document was set aside as a .rejected sibling…
    const rejected = await fs.readFile(cfgPath + ".rejected", "utf8");
    expect(rejected).toContain("totallyUnknownKey");
    // …and the new rule was written on top of the last-known-good (empty)
    // project permissions — the project config.json is now valid and holds it.
    const project = (await store.read("project")) as { permissions: Record<string, unknown> };
    const patterns = Object.values(project.permissions).map((r) => (r as { pattern?: string }).pattern);
    expect(patterns).toContain("ok.txt");
  });

  it("persisting onto an UNPARSEABLE project file (trailing comma): exact bytes set aside .rejected; rule writes on last-known-good; original recoverable", async () => {
    // Given — a seeded global and a project config.json that is NOT valid JSON
    // (a trailing comma). Config load must treat this EXACTLY like a
    // schema-invalid file: set the EXACT original bytes aside as `.rejected`,
    // recover to the last-known-good (none) project permissions, and never
    // mistake the file for absent (the data-loss defect).
    const store = new FilesystemConfigStore(ws);
    await store.write("global", seed);
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    const cfgPath = path.join(ws, ".voidrift", "config.json");
    const original = '{\n  "permissions": {\n    "hand-edited": { "tool": "read_file", "decision": "allow", "priority": 0, "source": "user" },\n  }\n}\n';
    await fs.writeFile(cfgPath, original, "utf8");

    const script = () =>
      fakeModel().respondWithTools([{ name: "write_file", args: { path: "ok.txt", content: "a" } }]).respond(new AIMessage("ok"));
    const { api } = await make({
      workspaceRoot: ws,
      configStore: store,
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
      onApproval: async (req) => ({ requestId: req.id, decision: "approve", remember: "project", chosenPattern: "ok.txt" }),
    });
    // The CLI startup notice reads this accessor; it must report the rejection.
    const rejected = api.config.rejections ? await api.config.rejections() : null;
    const c = await api.session.create({});
    const res = await api.session.send(c.ok ? c.value.id : "", { input: "write", approvalMode: "interactive" });
    expect(res.ok && res.value.status).toBe("completed");

    // The `.rejected` sibling holds the EXACT original bytes (recoverable).
    const rejectedBytes = await fs.readFile(cfgPath + ".rejected", "utf8");
    expect(rejectedBytes).toBe(original);

    // A rejection was recorded (naming the file) so the CLI notice can report it.
    expect(rejected && rejected.ok === true && Array.isArray(rejected.value) && rejected.value.length > 0).toBe(true);
    const rej = rejected && rejected.ok ? rejected.value[0] : undefined;
    expect(rej?.path).toBe(cfgPath);
    expect(rej?.errors?.[0]?.message).toMatch(/not valid JSON/i);

    // The new rule wrote on top of the last-known-good (empty) permissions; the
    // project config.json is now valid JSON and holds it — nothing destroyed
    // silently, and the original is still recoverable from `.rejected`.
    const project = (await store.read("project")) as { permissions: Record<string, unknown> };
    const persisted = Object.values(project.permissions).map((r) => (r as { pattern?: string }).pattern);
    expect(persisted).toContain("ok.txt");
    expect(JSON.parse(rejectedBytes.replace(/,(\s*[}\]])/g, "$1"))).toMatchObject({ permissions: { "hand-edited": { tool: "read_file" } } });
  });

  it("an UNPARSEABLE GLOBAL file is set aside .rejected and defaults are used (notice reported)", async () => {
    // Given — a global config.json that is not valid JSON. The store is pointed
    // at a temp home so the real ~/.config/voidrift is never touched.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vr-persist-home-"));
    const globalDir = path.join(home, ".config", "voidrift");
    await fs.mkdir(globalDir, { recursive: true });
    const globalPath = path.join(globalDir, "config.json");
    const original = '{ "modelSelected": "t", }'; // trailing comma — invalid JSON
    await fs.writeFile(globalPath, original, "utf8");
    const store = new FilesystemConfigStore(ws, undefined, globalDir);

    const script = () => fakeModel().respond(new AIMessage("hi"));
    const { api } = await make({
      workspaceRoot: ws,
      configStore: store,
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: factory(script),
      // Seed a usable model through the overlay so the run can proceed on
      // defaults (the rejected global contributes nothing).
      configOverrides: { models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } }, modelSelected: "t" },
    });

    // The global `.rejected` sibling holds the EXACT original bytes.
    expect(await fs.readFile(globalPath + ".rejected", "utf8")).toBe(original);
    // A rejection naming the global file was recorded; it says 'not valid JSON'.
    const rejected = await api.config.rejections();
    expect(rejected.ok).toBe(true);
    const rej = rejected.ok ? rejected.value.find((r) => r.layer === "global") : undefined;
    expect(rej?.path).toBe(globalPath);
    expect(rej?.errors?.[0]?.message).toMatch(/not valid JSON/i);

    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
  });
});
