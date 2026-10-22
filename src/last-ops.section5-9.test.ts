import { describe, it, expect } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import { createCore } from "./boot.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
import { createMemoryCheckpointer } from "./adapters/checkpointer.js";
import { InMemoryFileSystem } from "./adapters/in-memory-filesystem.js";

const seed = {
  models: { test: { model: "test-model", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "test",
};

async function makeCore(fs?: InMemoryFileSystem) {
  return createCore({
    workspaceRoot: "/ws",
    configStore: new InMemoryConfigStore(seed),
    sessionRepository: new InMemorySessionRepository(),
    checkpointer: createMemoryCheckpointer(),
    chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
    ...(fs ? { fileSystem: fs } : {}),
  });
}

/** §10.12 — the unified move timeline: /undo, /redo, /goto over host ops. */
describe("session rollback traversal (§10.12)", () => {
  it("records a move per turn and undo/redo step the conversation; unknown id and no-session error", async () => {
    // A REAL temp workspace: rollback writes cache snapshots to disk, so the
    // in-memory `/ws` of makeCore cannot back it.
    const { hermeticTmp } = await import("./test-hermetic.js");
    const nodeFs = await import("node:fs/promises");
    const nodePath = await import("node:path");
    const ws = hermeticTmp("rb-trav");
    await nodeFs.mkdir(nodePath.join(ws, ".voidrift"), { recursive: true });
    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore({ ...seed, snapshotCount: 50 }),
      sessionRepository: new InMemorySessionRepository(),
      checkpointer: createMemoryCheckpointer(),
      chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
    });
    const created = await api.session.create();
    const id = created.ok ? created.value.id : "";
    await api.session.send(id, { input: "turn one", approvalMode: "policy_only" });
    await api.session.send(id, { input: "turn two", approvalMode: "policy_only" });

    const report = await api.session.moves(id);
    expect(report.ok).toBe(true);
    if (report.ok && report.value.enabled) {
      expect(report.value.moves!.length).toBe(2);
      expect(report.value.pointer).toBe(2);
    }

    const undo = await api.session.undo(id);
    expect(undo.ok).toBe(true);
    if (undo.ok) expect(undo.value.toPointer).toBe(1);

    const redo = await api.session.redo(id);
    expect(redo.ok).toBe(true);
    if (redo.ok) expect(redo.value.toPointer).toBe(2);

    // An unknown goto id → NOT_FOUND naming the valid range.
    const unknown = await api.session.goto(id, 42);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("NOT_FOUND");

    // An unknown session id → SESSION_NOT_FOUND.
    const noSession = await api.session.undo("zzzzzzzz");
    expect(noSession.ok).toBe(false);
    if (!noSession.ok) expect(noSession.error.code).toBe("SESSION_NOT_FOUND");
    await api.session.shutdown().catch(() => undefined);
    await nodeFs.rm(ws, { recursive: true, force: true });
  });

  it("rewind is removed from the session namespace", async () => {
    const { api } = await makeCore();
    expect("rewind" in api.session).toBe(false);
  });
});

/** §3.1/§7.1 — agents.reindex discovers the filesystem cascade. */
describe("agents.reindex (§3.1, §7.1)", () => {
  it("registers valid manifests, skips malformed, and enforces the no-task-tool rule", async () => {
    const fs = new InMemoryFileSystem();
    const json = (o: Record<string, unknown>) => JSON.stringify(o);
    fs.files.set(".voidrift/agents/helper/agent.json", json({ name: "helper", description: "d", kind: "worker", tools: ["read_file"], prompt: "p" }));
    fs.files.set(".voidrift/agents/broken/agent.json", json({ name: "Bad!" })); // malformed → skipped
    fs.files.set(".voidrift/agents/dispatcher/agent.json", json({ name: "dispatcher", description: "d", kind: "worker", tools: ["task"], prompt: "p" })); // no-task-tool → rejected
    const { api } = await makeCore(fs);
    const re = await api.agents.reindex();
    expect(re.ok).toBe(true);
    if (re.ok) {
      expect(re.value.registered).toContain("helper");
      const skippedNames = re.value.skipped.map((s) => s.name);
      expect(skippedNames).toContain("broken");
      expect(skippedNames).toContain("dispatcher");
    }
    // The valid agent is now registered and discoverable.
    const list = await api.agents.list();
    expect(list.ok && list.value.some((a) => a.name === "helper")).toBe(true);
  });
});

/** §9.2/§13.5 — permissions.revoke; a managed rule is unrevocable. */
describe("permissions.revoke (§9.2, §13.5)", () => {
  it("requires a rule id and reports NOT_FOUND for an unknown workspace rule", async () => {
    const { api } = await makeCore();
    expect((await api.permissions.revoke()).ok).toBe(false);
    const res = await api.permissions.revoke("ghost", "workspace");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
  });

  it("revokes a session-scoped rule from the active session, NOT_FOUND when absent", async () => {
    const { api } = await makeCore();
    await api.session.create();
    // No session rule matches → NOT_FOUND, never a crash.
    const miss = await api.permissions.revoke("write_file src/**", "session");
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.error.code).toBe("NOT_FOUND");
  });

  it("removes a matching session-scoped rule from the active session", async () => {
    const repo = new InMemorySessionRepository();
    const { api } = await createCore({
      workspaceRoot: "/ws",
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: repo,
      checkpointer: createMemoryCheckpointer(),
      chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
    });
    const created = await api.session.create();
    const id = created.ok ? created.value.id : "";
    // Seed a session-scoped rule through the repository, then resume so it is live.
    const persisted = await repo.load(id);
    persisted!.sessionRules = [{ tool: "write_file", pattern: "src/**", decision: "allow", priority: 300, source: "session" }];
    await repo.save(persisted!);
    await api.session.resume(id);
    const res = await api.permissions.revoke("write_file src/**", "session");
    expect(res.ok).toBe(true);
  });

  it("defaults the layer to workspace when none is given", async () => {
    const { api } = await makeCore();
    const res = await api.permissions.revoke("nope");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
  });

  it("maps the user layer to the global config layer (NOT_FOUND when absent)", async () => {
    const { api } = await makeCore();
    const res = await api.permissions.revoke("nope", "user");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
  });

  it("revokes a persisted workspace rule written through config", async () => {
    const { api } = await makeCore();
    // Seed a workspace (project-layer) rule, then revoke it by id.
    const rule = { tool: "write_file", pattern: "src/**", decision: "allow", priority: 200, source: "workspace" };
    const set = await api.config.set("permissions", { r1: rule }, "project");
    expect(set.ok).toBe(true);
    const before = await api.permissions.rules();
    expect(before.ok && before.value.length).toBe(1);
    const res = await api.permissions.revoke("r1", "workspace");
    expect(res.ok).toBe(true);
    const after = await api.permissions.rules();
    expect(after.ok && after.value.length).toBe(0);
  });
});

/** §8.2 — workspace.map DTO: validation branches at the boundary. */
describe("workspace.map (§8.2)", () => {
  it("validates path and depth, then returns the structural index DTO", async () => {
    const { api } = await makeCore();
    expect((await api.workspace.map(42 as unknown as string)).ok).toBe(false);
    expect((await api.workspace.map(undefined, 0)).ok).toBe(false);
    expect((await api.workspace.map(undefined, 1.5)).ok).toBe(false);
    const ok = await api.workspace.map(undefined, 3);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.depth).toBe(3);
  });

  it("maps a glob failure to an INTERNAL error, never a crash", async () => {
    const fs = new InMemoryFileSystem();
    fs.glob = async () => {
      throw new Error("disk gone");
    };
    const { api } = await makeCore(fs);
    const res = await api.workspace.map();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INTERNAL");
  });

  it("surfaces a PATH_ESCAPE from the FileSystemPort as a typed error", async () => {
    const fs = new InMemoryFileSystem();
    const { CoreErrorException, coreError, ErrorCode } = await import("./entities/errors.js");
    fs.glob = async () => {
      throw new CoreErrorException(coreError(ErrorCode.PATH_ESCAPE, "escapes", { field: "path" }));
    };
    const { api } = await makeCore(fs);
    const res = await api.workspace.map("../outside");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PATH_ESCAPE");
  });
});

/** §3.1 — agents.reindex error path: a discovery failure is logged, not fatal. */
describe("agents.reindex failure path (§3.1)", () => {
  it("logs a discovery failure and still emits RESOURCE_CHANGED", async () => {
    const fs = new InMemoryFileSystem();
    const origGlob = fs.glob.bind(fs);
    fs.glob = async (p: string) => {
      if (p.includes(".voidrift/agents")) throw new Error("boom");
      return origGlob(p);
    };
    const { api } = await makeCore(fs);
    let resourceChanged = false;
    api.events.subscribe("RESOURCE_CHANGED", (e) => {
      if ((e.payload as { type?: string }).type === "agent") resourceChanged = true;
    });
    // AgentsDirectory.discover catches glob errors, so reindex still succeeds
    // with nothing registered; the event always fires.
    const re = await api.agents.reindex();
    expect(re.ok).toBe(true);
    expect(resourceChanged).toBe(true);
  });
});


