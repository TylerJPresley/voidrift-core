import { describe, it, expect } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import { createCore } from "./boot.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
import { createMemoryCheckpointer } from "./adapters/checkpointer.js";
import { z } from "zod";

const seed = {
  models: {
    test: { model: "test-model", protocol: "openai", contextLimit: 32_000 },
    other: { model: "other-model", protocol: "anthropic", contextLimit: 200_000 },
  },
  modelSelected: "test",
};

async function makeCore() {
  return createCore({
    workspaceRoot: "/ws",
    configStore: new InMemoryConfigStore(seed),
    sessionRepository: new InMemorySessionRepository(),
    checkpointer: createMemoryCheckpointer(),
    chatModelFactory: () => fakeModel().respond(new AIMessage("x")),
  });
}

describe("CoreAPI namespaces (§2.2)", () => {
  it("exposes every namespace", async () => {
    const { api } = await makeCore();
    for (const ns of [
      "session", "models", "agents", "subagents", "documents", "memory", "skills",
      "prompts", "mcp", "plugins", "permissions", "compliance", "observability",
      "config", "workspace", "registry", "register", "events", "datasets",
    ]) {
      expect((api as unknown as Record<string, unknown>)[ns]).toBeDefined();
    }
  });

  it("models.list and models.switch work; switch to unknown fails", async () => {
    const { api } = await makeCore();
    const list = await api.models.list();
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.value.map((m) => m.name).sort()).toEqual(["other", "test"]);
    const sw = await api.models.switch("other");
    expect(sw.ok).toBe(true);
    const bad = await api.models.switch("nope");
    expect(bad.ok).toBe(false);
  });

  it("config get/set/validate/recover/paths delegate to the capability", async () => {
    const { api } = await makeCore();
    const got = await api.config.get("turnMaxConcurrency");
    expect(got.ok).toBe(true);
    const set = await api.config.set("turnMaxConcurrency", 2, "project");
    expect(set.ok).toBe(true);
    const val = await api.config.validate({ turnMaxConcurrency: 2 });
    expect(val.ok).toBe(true);
    const paths = await api.config.paths();
    expect(paths.ok).toBe(true);
    const rec = await api.config.recover("project");
    expect(rec.ok).toBe(true);
  });

  it("workspace.root returns the root; map/inject seams respond", async () => {
    const { api } = await makeCore();
    const root = await api.workspace.root();
    expect(root.ok && root.value).toBe("/ws");
    // workspace.map returns the structural index DTO (§8.2); the /ws root has
    // no files in the test environment, so the tree is an empty dir node.
    const map = await api.workspace.map();
    expect(map.ok).toBe(true);
    if (map.ok) {
      expect(map.value.root).toBe("");
      expect(map.value.tree.kind).toBe("dir");
    }
    // inject needs a live session; create one, then inject requires (label, content).
    await api.session.create();
    expect((await api.workspace.inject("focus", "see §4")).ok).toBe(true);
    expect((await api.workspace.inject("", "x")).ok).toBe(false);
  });

  it("compliance.status reports the Warden mode", async () => {
    const { api } = await makeCore();
    const s = await api.compliance.status();
    expect(s.ok).toBe(true);
  });

  it("permissions.rules reads config rules and approvals lists pending", async () => {
    const { api } = await makeCore();
    expect((await api.permissions.rules()).ok).toBe(true);
    expect((await api.permissions.approvals()).ok).toBe(true);
  });

  it("register.tool adds to the registry; unimplemented register seams return NOT_IMPLEMENTED", async () => {
    const { api } = await makeCore();
    api.register.tool({ name: "plug", description: "d", schema: z.object({}), readOnly: true }, async () => ({
      content: "ok",
      status: "success",
    }));
    // register.command is implemented in slice 5 (§12.3/§12.4): it registers a
    // command the session.command namespace runs, returning void.
    expect(api.register.command("plug-cmd", "d", async () => "ran")).toBeUndefined();
    // register.exporter now accepts an ObsExporter and returns void (§10.8).
    expect(api.register.exporter({ export: () => undefined })).toBeUndefined();
  });

  it("register.panel validates and stores a pure-data declaration a client reads via registry.panels (§12.6)", async () => {
    const { api } = await makeCore();
    const def = {
      title: "Demo",
      columns: [{ key: "n", label: "Name", width: 12, format: "text" }],
      source: "sessions",
      actions: { a: { label: "approve", op: "memory.suggestions.approve", confirm: true } },
    };
    expect(api.register.panel("demo", def)).toBeUndefined();
    const stored = api.registry.get("panels.demo");
    expect(stored).toEqual(def);
    // A pure-data declaration round-trips through JSON unchanged (§12.6).
    expect(JSON.parse(JSON.stringify(stored))).toEqual(def);
    const panels = api.registry.panels();
    expect(panels.map((p) => p.key)).toContain("panels.demo");
  });

  it("register.panel rejects an invalid declaration with a typed CoreError naming the field (§12.6)", async () => {
    const { api } = await makeCore();
    const base = { title: "Ok", columns: [{ key: "n", label: "N" }], source: "sessions" };
    // Empty title.
    expect(api.register.panel("p", { ...base, title: "" })).toMatchObject({ code: "INVALID_INPUT", field: "title" });
    // Duplicate column key.
    expect(
      api.register.panel("p", { ...base, columns: [{ key: "n", label: "A" }, { key: "n", label: "B" }] }),
    ).toMatchObject({ code: "INVALID_INPUT", field: "columns" });
    // Multi-character hotkey.
    expect(
      api.register.panel("p", { ...base, actions: { ab: { label: "x", op: "a.b" } } }),
    ).toMatchObject({ code: "INVALID_INPUT", field: "actions" });
    // A dotted op path in `source` is rejected (a source names a dataset, §12.7).
    expect(api.register.panel("p", { ...base, source: "session.list" })).toMatchObject({ code: "INVALID_INPUT", field: "source" });
    // A function member (non-serializable) is rejected.
    expect(api.register.panel("p", { ...base, getItems: () => [] })).toMatchObject({ code: "INVALID_INPUT" });
    // None of the rejected declarations were stored.
    expect(api.registry.get("panels.p")).toBeNull();
  });

  it("register.dataset + datasets.list/rows round-trip through the real facade (§12.7)", async () => {
    const { api } = await makeCore();
    expect(
      api.register.dataset("models", {
        description: "Registered models",
        fields: [{ key: "name", label: "Name" }],
        rows: () => [{ name: "test" }, { name: "other" }],
      }),
    ).toBeUndefined();
    const listed = await api.datasets.list();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const entry = listed.value.find((d) => d.name === "models");
      expect(entry).toMatchObject({ name: "models", description: "Registered models", fields: [{ key: "name", label: "Name" }] });
    }
    const rows = await api.datasets.rows("models");
    expect(rows.ok).toBe(true);
    if (rows.ok) expect(rows.value).toEqual([{ name: "test" }, { name: "other" }]);
  });

  it("register.dataset rejects a bad name, a non-zero-arg rows, and a duplicate field key (§12.7)", async () => {
    const { api } = await makeCore();
    expect(api.register.dataset("Bad Name", { description: "x", rows: () => [] })).toMatchObject({ code: "INVALID_INPUT", field: "name" });
    expect(api.register.dataset("dotted.name", { description: "x", rows: () => [] })).toMatchObject({ code: "INVALID_INPUT", field: "name" });
    expect(api.register.dataset("d", { description: "x", rows: (n: unknown) => [n] })).toMatchObject({ code: "INVALID_INPUT", field: "rows" });
    expect(
      api.register.dataset("d", { description: "x", fields: [{ key: "k", label: "A" }, { key: "k", label: "B" }], rows: () => [] }),
    ).toMatchObject({ code: "INVALID_INPUT", field: "fields" });
  });

  it("datasets.rows masks a secret value before it leaves the core (§10.10, §12.7)", async () => {
    const { api } = await makeCore();
    api.register.dataset("secrets", {
      description: "rows with a secret",
      rows: () => [{ token: "ghp_01" + "23456789abcdefghijklmnopqrstuvwxyz" }],
    });
    const rows = await api.datasets.rows("secrets");
    expect(rows.ok).toBe(true);
    if (rows.ok) {
      const val = String((rows.value[0] as Record<string, unknown>).token);
      expect(val).not.toContain("ghp_01" + "23456789abcdefghijklmnopqrstuvwxyz");
      expect(val).toContain("«redacted");
    }
  });

  it("datasets.rows truncates an over-cap row array with a dim notice (§12.7)", async () => {
    const notices: string[] = [];
    const { api } = await createCore({
      workspaceRoot: "/ws",
      configStore: new InMemoryConfigStore({ ...seed, limits: { tools: { workspaceMaxFiles: 2 } } }),
      sessionRepository: new InMemorySessionRepository(),
      checkpointer: createMemoryCheckpointer(),
      chatModelFactory: () => fakeModel().respond(new AIMessage("x")),
      output: (t) => notices.push(t),
    });
    api.register.dataset("many", { description: "many rows", rows: () => [{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }] });
    const rows = await api.datasets.rows("many");
    expect(rows.ok).toBe(true);
    if (rows.ok) expect(rows.value.length).toBe(2);
    expect(notices.some((n) => n.includes("limits.tools.workspaceMaxFiles"))).toBe(true);
  });

  it("datasets.rows on an unregistered name is a typed NOT_FOUND error naming it (§12.7)", async () => {
    const { api } = await makeCore();
    const rows = await api.datasets.rows("nope");
    expect(rows.ok).toBe(false);
    if (!rows.ok) {
      expect(rows.error.code).toBe("NOT_FOUND");
      expect(rows.error.message).toContain("nope");
    }
  });

  it("register.modelProvider resolves a registered protocol as a peer (§11.7)", async () => {
    const { api } = await makeCore();
    // A config entry naming an unbundled protocol resolves via the registered factory.
    const added = await api.config.set(
      "models",
      {
        ...seed.models,
        bed: { model: "nova", protocol: "testbedrock", contextLimit: 32_000 },
      },
      "project",
    );
    expect(added.ok).toBe(true);
    api.register.modelProvider("testbedrock", () => fakeModel().respond(new AIMessage("peer")));
    const switched = await api.models.switch("bed");
    expect(switched.ok).toBe(true);
    if (switched.ok) expect((switched.value as { protocol: string }).protocol).toBe("testbedrock");
    // An unknown endpoint still fails MODEL_NOT_CONFIGURED.
    const bad = await api.models.switch("ghost");
    expect(bad.ok).toBe(false);
  });

  it("register.exporter feeds the live obs writer each masked record (§10.8)", async () => {
    const { api } = await makeCore();
    const seen: unknown[] = [];
    api.register.exporter({ export: (r: unknown) => void seen.push(r) });
    const created = await api.session.create({});
    expect(created.ok).toBe(true);
    if (created.ok) await api.session.send(created.value.id, { input: "hi" });
    await api.session.shutdown();
    // The turn produced at least one observability record routed to the exporter.
    expect(seen.length).toBeGreaterThan(0);
  });

  it("registry set/get/query/remove round-trips", async () => {
    const { api } = await makeCore();
    api.registry.set("a:1", { v: 1 });
    api.registry.set("a:2", { v: 2 });
    expect(api.registry.get("a:1")).toEqual({ v: 1 });
    expect(api.registry.query("a:").length).toBe(2);
    api.registry.remove("a:1");
    expect(api.registry.get("a:1")).toBeNull();
  });

  it("events: unregistered emit is dropped, registered flows, subscribe is scoped", async () => {
    const { api } = await makeCore();
    const seen: unknown[] = [];
    api.events.subscribe("CUSTOM", (e) => seen.push(e.payload));
    api.events.emit("CUSTOM", { a: 1 }); // not registered → dropped
    api.events.register("CUSTOM");
    api.events.emit("CUSTOM", { a: 2 });
    api.events.emit("CUSTOM", { a: 3 }, { session: "nope" }); // scoped elsewhere → not seen by unscoped? unscoped sees all
    expect(seen).toEqual([{ a: 2 }, { a: 3 }]);
  });

  it("agents and documents namespaces return DTOs; defaults register at boot (§3.1)", async () => {
    const { api } = await makeCore();
    // §3.1 — the built-in `chat` registers at boot (in code); with no user
    // folders it is the only agent, reporting its source/kind/class.
    const listed = await api.agents.list();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.map((a) => a.name)).toEqual(["chat"]);
      const chat = listed.value[0]!;
      expect(chat.source).toBe("builtin");
      expect(chat.kind).toBe("top-level");
      expect(chat.order).toBe(10);
      expect(chat.unlisted).toBe("ask");
    }
    // tools degrades to the first registered agent's resolved toolset.
    expect((await api.agents.tools()).ok).toBe(true);
    // No live session → documents.list is an empty list, never an error.
    expect(await api.documents.list()).toEqual({ ok: true, value: [] });
    // Validation still bites at the boundary (§2.6).
    expect((await api.agents.get("")).ok).toBe(false);
    expect((await api.agents.get("ghost")).ok).toBe(false);
    // reindex re-discovers the cascade; with no project/global dir it registers
    // only the built-in chat and skips nothing, returning a DTO.
    const re = await api.agents.reindex();
    expect(re.ok).toBe(true);
    if (re.ok) {
      expect(re.value.registered).toEqual(["chat"]);
      expect(re.value.skipped).toEqual([]);
    }
  });

  it("mcp and observability are live in slice 6 (§8.4, §10)", async () => {
    const { api } = await makeCore();
    expect((await api.mcp.list()).ok).toBe(true);
    expect((await api.mcp.listConfigs()).ok).toBe(true);
    expect((await api.observability.query("no-such-session")).ok).toBe(true);
    // A bad Liqe filter returns a structured INVALID_QUERY, not a throw (§10.5).
    const bad = await api.observability.query("some-session", "status:>>bad::");
    expect(bad.ok).toBe(false);
  });

  it("mcp/observability validate their inputs at the boundary (§2.6)", async () => {
    const { api } = await makeCore();
    expect((await api.mcp.connect("")).ok).toBe(false);
    expect((await api.mcp.saveConfig("", { transport: "stdio" })).ok).toBe(false);
    // An unknown server disconnect returns a structured error, never throws.
    expect((await api.mcp.disconnect("ghost")).ok).toBe(false);
    expect((await api.observability.query("")).ok).toBe(false);
    // observability.stats is the aggregate across stored trails (§2.4, §10.14):
    // it takes {days?,model?,agent?}, not a session id. A bad `days` is rejected;
    // a valid (or absent) opts returns a StatsReport.
    expect((await api.observability.stats({ days: -1 })).ok).toBe(false);
    const agg = await api.observability.stats();
    expect(agg.ok).toBe(true);
    if (agg.ok) expect(agg.value.scope).toBe("aggregate");
  });

  it("mcp.saveConfig validates then persists and connects; removeConfig removes (§8.4, §13)", async () => {
    const { api } = await makeCore();
    const saved = await api.mcp.saveConfig("acme", { transport: "http", url: "https://example.test" });
    // The connect itself fails offline (non-fatal), but save validates+persists.
    expect(saved.ok).toBe(true);
    const configs = await api.mcp.listConfigs();
    expect(configs.ok && Object.keys(configs.value)).toContain("acme");
    const removed = await api.mcp.removeConfig("acme");
    expect(removed.ok).toBe(true);
  });

  it("observability.tail returns an unsubscribe handle; a bad filter is INVALID_QUERY (§10.5)", async () => {
    const { api } = await makeCore();
    const sub = await api.observability.tail("source:tool", () => undefined);
    expect(sub.ok).toBe(true);
    if (sub.ok) sub.value();
    const bad = await api.observability.tail("status:>>bad::", () => undefined);
    expect(bad.ok).toBe(false);
  });

  it("skills/prompts/plugins are live in slice 5 — list returns ok (§12)", async () => {
    const { api } = await makeCore();
    expect((await api.skills.list()).ok).toBe(true);
    expect((await api.prompts.list()).ok).toBe(true);
    expect((await api.plugins.list()).ok).toBe(true);
  });

  it("memory is live in slice 4 — list returns an empty index before any write (§6)", async () => {
    const { api } = await makeCore();
    const list = await api.memory.list();
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.value).toEqual([]);
  });

  it("subagents is live in slice 3 — list returns an empty roster before any dispatch (§7.2)", async () => {
    const { api } = await makeCore();
    const list = await api.subagents.list();
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.value).toEqual([]);
  });
});

describe("session lifecycle ops (§5)", () => {
  it("create, rename, list, delete, clear, housekeeping, shutdown", async () => {
    const sessions = new InMemorySessionRepository();
    const { api, housekeeping, managed } = await createCore({
      workspaceRoot: "/ws",
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: sessions,
      checkpointer: createMemoryCheckpointer(),
      chatModelFactory: () => fakeModel().respond(new AIMessage("x")),
    });
    expect(housekeeping.idleDays).toBe(30);
    expect(managed.status).toBe("none");

    const created = await api.session.create({ name: "First" });
    expect(created.ok).toBe(true);
    const id = created.ok ? created.value.id : "";

    const renamed = await api.session.rename(id, "Renamed");
    expect(renamed.ok && renamed.value.name).toBe("Renamed");

    const list = await api.session.list();
    expect(list.find((s) => s.id === id)?.name).toBe("Renamed");

    const cleared = await api.session.clear(id);
    expect(cleared.ok).toBe(true);

    const del = await api.session.delete(id);
    expect(del.ok).toBe(true);

    const hk = await api.session.housekeeping();
    expect(hk.idleDays).toBe(30);

    await api.session.shutdown();

    // Unknown-session guards.
    expect((await api.session.rename("zzzzzzzz", "x")).ok).toBe(false);
    expect((await api.session.resume("zzzzzzzz")).ok).toBe(false);
    expect((await api.session.send("zzzzzzzz", { input: "hi" })).ok).toBe(false);
  });

  it("send rejects an empty message and model-unconfigured turns", async () => {
    const { api } = await createCore({
      workspaceRoot: "/ws",
      configStore: new InMemoryConfigStore({ models: {}, modelSelected: "missing" }),
      sessionRepository: new InMemorySessionRepository(),
      checkpointer: createMemoryCheckpointer(),
      chatModelFactory: () => fakeModel().respond(new AIMessage("x")),
    });
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    expect((await api.session.send(id, { input: "   " })).ok).toBe(false);
    const noModel = await api.session.send(id, { input: "hi" });
    expect(noModel.ok).toBe(false);
    if (!noModel.ok) expect(noModel.error.code).toBe("MODEL_NOT_CONFIGURED");
  });

  it("confirm with no pending approval fails", async () => {
    const { api } = await makeCore();
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const r = await api.session.confirm(id, { requestId: "x", decision: "approve" });
    expect(r.ok).toBe(false);
  });

  it("session.command and listCommands seams", async () => {
    const { api } = await makeCore();
    expect((await api.session.command("routine")).ok).toBe(false);
    expect((await api.session.listCommands()).ok).toBe(true);
  });
});

describe("subagents namespace (§7.2)", () => {
  it("dispatch rejects an empty request list and status reports not-found", async () => {
    const { api } = await makeCore();
    const empty = await api.subagents.dispatch([]);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe("INVALID_INPUT");

    const missing = await api.subagents.status("ghost");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("NOT_FOUND");

    const stream = await api.subagents.stream("ghost");
    expect(stream.ok).toBe(true);
    if (stream.ok) expect(stream.value).toEqual([]);

    const cancel = await api.subagents.cancel("fanout-x");
    expect(cancel.ok).toBe(true);
  });

  it("register.agent rejects a worker that declares the task tool and accepts a clean one", async () => {
    const { api } = await makeCore();
    const bad = api.register.agent({
      name: "bad",
      description: "d",
      systemPrompt: "p",
      tools: ["read_file", "task"],
    });
    expect(bad).toBeDefined();
    expect((bad as { code: string }).code).toBe("INVALID_INPUT");

    const good = api.register.agent({
      name: "good",
      description: "d",
      systemPrompt: "p",
      tools: ["read_file"],
    });
    expect(good).toBeUndefined();
  });
});
