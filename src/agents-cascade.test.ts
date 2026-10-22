/**
 * §3.1/§12.1 — the agent cascade (project > global > built-in `chat`) and the
 * `agents.list` source/class reporting, wired end to end through `createCore`.
 *
 * The ONLY built-in is `chat` (in code, source "builtin"): always present, never
 * removable or disableable. EVERYTHING ELSE lives in the USER's folders — the
 * runtime reads the project `<ws>/.voidrift/agents/` and the global
 * `~/.config/voidrift/agents/`, never the package `seed/`. Tests seed temp user
 * folders from the package templates with `seedAgentsInto` (what `config.init`
 * will write in A2).
 *
 * PROJECT and in-memory cases run against an injected `InMemoryFileSystem`. The
 * GLOBAL layer sits OUTSIDE the workspace and is read through a dedicated
 * global-rooted FS, so those cases run against a REAL `FilesystemAdapter` on a
 * temp workspace with `XDG_CONFIG_HOME` pointed at a temp home.
 */
import { hermeticTmp } from "./test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import { createCore } from "./boot.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
import { createMemoryCheckpointer } from "./adapters/checkpointer.js";
import { InMemoryFileSystem } from "./adapters/in-memory-filesystem.js";
import { seedAgentsInto } from "./test-support/seed-agents.js";

const seed = {
  models: { test: { model: "test-model", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "test",
};

const json = (o: Record<string, unknown>) => JSON.stringify(o);

/**
 * Isolated EMPTY global config dir for the in-memory cases.
 *
 * The in-memory `makeCore` injects only the WORKSPACE filesystem; the GLOBAL
 * agents layer is always read through a real `AgentsDirectory` rooted at
 * `$XDG_CONFIG_HOME/voidrift/agents`. Under the shared per-run hermetic HOME
 * that dir is MUTABLE and SHARED across workers — a concurrent/earlier test
 * that first-run-seeds a core (no injected configStore) writes the six default
 * agents into it, which these "no user folders" cases would then discover,
 * making the cascade intermittently see the seeded set. Point each in-memory
 * case at its OWN empty XDG so the global layer is genuinely empty and the
 * assertion depends on this test alone, not on whatever the shared HOME holds.
 * Restored before teardown so the hermetic `afterAll` still sees the redirect.
 */
function useIsolatedEmptyGlobal(): void {
  let prevXdg: string | undefined;
  let xdg: string;
  beforeEach(() => {
    prevXdg = process.env["XDG_CONFIG_HOME"];
    xdg = hermeticTmp("agents-empty-xdg");
    process.env["XDG_CONFIG_HOME"] = xdg;
    // Guard: the global agents dir resolves inside the fresh temp and is empty.
    expect(fsSync.existsSync(path.join(xdg, "voidrift", "agents"))).toBe(false);
  });
  afterEach(async () => {
    if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = prevXdg;
    await fs.rm(xdg, { recursive: true, force: true });
  });
}

/** A core over an injected in-memory workspace FS (project/malformed cases). */
async function makeCore(fsPort: InMemoryFileSystem) {
  return createCore({
    workspaceRoot: "/ws",
    configStore: new InMemoryConfigStore(seed),
    sessionRepository: new InMemorySessionRepository(),
    checkpointer: createMemoryCheckpointer(),
    chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
    fileSystem: fsPort,
  });
}

/** A core over the REAL filesystem: a temp workspace + `XDG_CONFIG_HOME` at a
 * temp home so the global agents dir resolves there. */
async function makeRealCore(workspaceRoot: string) {
  return createCore({
    workspaceRoot,
    configStore: new InMemoryConfigStore(seed),
    sessionRepository: new InMemorySessionRepository(),
    checkpointer: createMemoryCheckpointer(),
  });
}

describe("agent cascade — built-in chat (§3.1)", () => {
  useIsolatedEmptyGlobal();
  it("chat is ALWAYS present with source=builtin, top-level, order 10, unlisted ask", async () => {
    const { api } = await makeCore(new InMemoryFileSystem());
    const got = await api.agents.get("chat");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.source).toBe("builtin");
    expect(got.value.kind).toBe("top-level");
    expect(got.value.order).toBe(10);
    expect(got.value.unlisted).toBe("ask");
    expect(got.value.file).toBeUndefined(); // builtin has no file path
  });

  it("with no user folders, chat is the only agent", async () => {
    const { api } = await makeCore(new InMemoryFileSystem());
    const list = await api.agents.list();
    expect(list.ok && list.value.map((a) => a.name)).toEqual(["chat"]);
  });

  it("chat cannot be removed by reindex — a `disabled: true` override is IGNORED (no such field)", async () => {
    const fsPort = new InMemoryFileSystem();
    // A would-be disable: an override naming `disabled` is a strict-schema error,
    // so it is SKIPPED and chat degrades to the built-in.
    fsPort.files.set(".voidrift/agents/chat/agent.json", json({ name: "chat", description: "d", kind: "top-level", prompt: "p", unlisted: "ask", disabled: true }));
    const { api } = await makeCore(fsPort);
    const re = await api.agents.reindex();
    expect(re.ok && re.value.skipped.some((s) => s.name === "chat")).toBe(true);
    const got = await api.agents.get("chat");
    expect(got.ok && got.value.source).toBe("builtin"); // fell back to built-in
  });

  it("a VALID chat override in the project layer replaces the built-in (source=project)", async () => {
    const fsPort = new InMemoryFileSystem();
    fsPort.files.set(".voidrift/agents/chat/agent.json", json({ name: "chat", description: "my chat", kind: "top-level", prompt: "p", unlisted: "ask", order: 10 }));
    const { api } = await makeCore(fsPort);
    const got = await api.agents.get("chat");
    expect(got.ok && got.value.source).toBe("project");
    expect(got.ok && got.value.description).toBe("my chat");
  });

  it("an INVALID chat override degrades to the built-in with a warning", async () => {
    const fsPort = new InMemoryFileSystem();
    fsPort.files.set(".voidrift/agents/chat/agent.json", "{ not json");
    const { api } = await makeCore(fsPort);
    const re = await api.agents.reindex();
    expect(re.ok && re.value.skipped.some((s) => s.name === "chat")).toBe(true);
    const got = await api.agents.get("chat");
    expect(got.ok && got.value.source).toBe("builtin");
  });

  it("a project TOP-LEVEL agent is accepted alongside chat", async () => {
    const fsPort = new InMemoryFileSystem();
    fsPort.files.set(".voidrift/agents/research/agent.json", json({ name: "research", description: "orc", kind: "top-level", prompt: "p", unlisted: "deny", workers: ["x"], order: 20, tools: ["task"] }));
    const { api } = await makeCore(fsPort);
    const got = await api.agents.get("research");
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.value.source).toBe("project");
      expect(got.value.kind).toBe("top-level");
      expect(got.value.unlisted).toBe("deny");
    }
  });
});

describe("agent cascade — project overrides a project-only agent (§3.1)", () => {
  useIsolatedEmptyGlobal();
  it("a project worker is read from .voidrift/agents and tagged source=project", async () => {
    const fsPort = new InMemoryFileSystem();
    fsPort.files.set(".voidrift/agents/implementer/agent.json", json({ name: "implementer", description: "impl", kind: "worker", tools: ["read_file"], prompt: "p" }));
    const { api } = await makeCore(fsPort);
    const got = await api.agents.get("implementer");
    expect(got.ok && got.value.source).toBe("project");
    expect(got.ok && got.value.class).toBe("read"); // only read_file declared
  });

  it("a MALFORMED project agent is skipped; chat stays (§12.1)", async () => {
    const fsPort = new InMemoryFileSystem();
    fsPort.files.set(".voidrift/agents/bad/agent.json", json({ name: "Bad!" }));
    const { api } = await makeCore(fsPort);
    const re = await api.agents.reindex();
    expect(re.ok && re.value.skipped.some((s) => s.name === "bad")).toBe(true);
    const list = await api.agents.list();
    expect(list.ok && list.value.some((a) => a.name === "chat")).toBe(true);
  });
});

/**
 * Regression (§3.1/§12.1): the GLOBAL layer must be functional through the REAL
 * filesystem — the dedicated global-rooted FS, NOT the workspace-confined port.
 * Seeded from the package templates, exactly what `config.init` will write.
 */
describe("agent cascade — real filesystem, seeded user folders (§3.1)", () => {
  let home: string;
  let ws: string;
  let prevXdg: string | undefined;

  async function setup(): Promise<void> {
    home = hermeticTmp("agents-xdg");
    ws = hermeticTmp("agents-ws");
    prevXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = home;
  }

  afterEach(async () => {
    if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = prevXdg;
    await Promise.all([
      home ? fs.rm(home, { recursive: true, force: true }) : Promise.resolve(),
      ws ? fs.rm(ws, { recursive: true, force: true }) : Promise.resolve(),
    ]);
  });

  it("seeding the GLOBAL folder makes the six default agents available (source=global)", async () => {
    await setup();
    seedAgentsInto(path.join(home, "voidrift", "agents"));
    const { api } = await makeRealCore(ws);
    const list = await api.agents.list();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const byName = new Map(list.value.map((a) => [a.name, a]));
    expect([...byName.keys()].sort()).toEqual(["chat", "implementer", "planner", "research", "researcher", "reviewer", "summarizer", "vibe"]);
    expect(byName.get("chat")!.source).toBe("builtin");
    expect(byName.get("research")!.source).toBe("global");
    expect(byName.get("implementer")!.source).toBe("global");
    expect(byName.get("implementer")!.class).toBe("write");
    expect(byName.get("reviewer")!.class).toBe("read");
  });

  it("a PROJECT agent wins over a GLOBAL one of the same name", async () => {
    await setup();
    seedAgentsInto(path.join(home, "voidrift", "agents"));
    const projDir = path.join(ws, ".voidrift", "agents", "planner");
    await fs.mkdir(projDir, { recursive: true });
    await fs.writeFile(path.join(projDir, "agent.json"), json({ name: "planner", description: "from-project", kind: "worker", tools: ["read_file"], prompt: "p" }));
    const { api } = await makeRealCore(ws);
    const planner = await api.agents.get("planner");
    expect(planner.ok && planner.value.source).toBe("project");
    expect(planner.ok && planner.value.description).toBe("from-project");
  });

  it("DELETING a seeded global agent removes it on reindex", async () => {
    await setup();
    const globalAgents = path.join(home, "voidrift", "agents");
    seedAgentsInto(globalAgents);
    const { api } = await makeRealCore(ws);
    expect((await api.agents.get("vibe")).ok).toBe(true);
    await fs.rm(path.join(globalAgents, "vibe"), { recursive: true, force: true });
    await api.agents.reindex();
    expect((await api.agents.get("vibe")).ok).toBe(false);
    // chat is never removable.
    expect((await api.agents.get("chat")).ok).toBe(true);
  });
});
