/**
 * The first-run seed document: schema validity, a bootable core, and the REAL
 * matcher proving each seeded allow rule matches its example (core-blueprint.md
 * §13.8, §13.9.1, §9.2). Also: createCore first-run seeding runs `config.init`
 * (global form) under the hermetic HOME and touches nothing outside it, the
 * runtime still ignores the package seed folder, and force-ask classes still ask
 * even with the seeded allow list.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import { createCore, voidriftConfigDir, seedAgentsDir } from "../boot.js";
import { InMemorySessionRepository } from "../adapters/repositories/session-repository.js";
import { createMemoryCheckpointer } from "../adapters/checkpointer.js";
import { ConfigSchema } from "../config/schema.js";
import { seedConfigDocument, SEED_ALLOW_EXAMPLES, seedPermissions } from "../config/seed.js";
import { Guardian } from "../entities/guardian.js";
import type { ShellLists, GuardedCall } from "../entities/guardian.js";

/** Empty shell lists so `execute_command` classification falls through to the
 * RULES — this isolates the rule→value match (`globMatch`) from the safe-list. */
const EMPTY_LISTS: ShellLists = { safe: [], forceAsk: [], equivalents: [], deny: [] };

describe("first-run seed document (§13.8)", () => {
  it("validates against the strict ConfigSchema", () => {
    const parsed = ConfigSchema.safeParse(seedConfigDocument());
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.modelSelected).toBe("local");
      expect(parsed.data.models["local"]?.baseUrl).toBe("http://localhost:11434/v1");
      expect(parsed.data.unlock).toEqual([]);
      expect(parsed.data.webSearch.provider).toBe("duckduckgo");
      expect(parsed.data.findingsDirectories).toEqual([".voidrift/research/"]);
      expect(parsed.data.worktreeInclude).toEqual([]);
      // §10.11 / §13.10 — the mutation journal level is seeded visibly at its
      // default `action` (local text before/after).
      expect(parsed.data.mutationLogLevel).toBe("action");
    }
  });

  it("seeds the in-turn memory tools in the allow list (§6.4, §13.8)", () => {
    const perms = seedPermissions();
    for (const name of ["save_memory", "list_memory", "delete_memory"]) {
      const rule = perms[`allow-${name}`];
      expect(rule, `missing allow rule for ${name}`).toBeDefined();
      expect(rule!.tool).toBe(name);
      expect(rule!.decision).toBe("allow");
      expect(rule!.source).toBe("default");
    }
  });

  it("turnMaxConcurrency defaults to 2 (§3.6)", () => {
    expect(ConfigSchema.parse({}).turnMaxConcurrency).toBe(2);
    expect(ConfigSchema.parse({ turnMaxConcurrency: 4 }).turnMaxConcurrency).toBe(4);
  });

  it("mutationLogLevel defaults to `action` and rejects an unknown value (§13.10)", () => {
    expect(ConfigSchema.parse({}).mutationLogLevel).toBe("action");
    expect(ConfigSchema.safeParse({ mutationLogLevel: "turn" }).success).toBe(true);
    expect(ConfigSchema.safeParse({ mutationLogLevel: "off" }).success).toBe(true);
    expect(ConfigSchema.safeParse({ mutationLogLevel: "verbose" }).success).toBe(false);
  });

  it("snapshotCount defaults to 50, is seeded visibly, and bounds 0–500 (§10.12/§13.10)", () => {
    // Default.
    expect(ConfigSchema.parse({}).snapshotCount).toBe(50);
    // Seeded visibly.
    expect(seedConfigDocument().snapshotCount).toBe(50);
    expect(ConfigSchema.parse(seedConfigDocument()).snapshotCount).toBe(50);
    // Bounds: 0 and 500 inclusive; a project override replaces the value.
    expect(ConfigSchema.safeParse({ snapshotCount: 0 }).success).toBe(true);
    expect(ConfigSchema.safeParse({ snapshotCount: 500 }).success).toBe(true);
    expect(ConfigSchema.parse({ snapshotCount: 10 }).snapshotCount).toBe(10);
    // Out of range / non-integer rejected.
    expect(ConfigSchema.safeParse({ snapshotCount: -1 }).success).toBe(false);
    expect(ConfigSchema.safeParse({ snapshotCount: 501 }).success).toBe(false);
    expect(ConfigSchema.safeParse({ snapshotCount: 1.5 }).success).toBe(false);
  });

  it("boots a core (modelSelected resolves)", async () => {
    const core = await createCore({
      workspaceRoot: "/ws",
      // Inject the seed document as the global layer so the configured endpoint
      // is `local`; a bootable core with the seeded selection.
      configStore: new (await import("../adapters/repositories/in-memory-config-store.js")).InMemoryConfigStore(
        seedConfigDocument(),
      ),
      sessionRepository: new InMemorySessionRepository(),
      checkpointer: createMemoryCheckpointer(),
      chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
    });
    const info = await core.api.models.list();
    expect(info.ok && info.value.some((m) => m.name === "local")).toBe(true);
    await core.api.session.shutdown?.();
  });
});

describe("seeded allow rules match their examples under the real matcher (§9.2)", () => {
  const guardian = new Guardian([]);
  const rules = Object.values(seedPermissions());

  for (const ex of SEED_ALLOW_EXAMPLES) {
    it(`${ex.id} → ${ex.tool}${ex.value ? ` "${ex.value}"` : ""} allows`, () => {
      const call: GuardedCall =
        ex.tool === "execute_command"
          ? { tool: "execute_command", args: { command: ex.value } }
          : { tool: ex.tool, args: {} };
      const outcome = guardian.evaluate(call, rules, EMPTY_LISTS);
      expect(outcome.decision, `${ex.id}: ${JSON.stringify(outcome)}`).toBe("allow");
    });
  }

  it("force-ask classes still ASK even with the seeded allow list", () => {
    const seeded = Object.values(seedPermissions());
    // Also throw in a blanket wildcard allow to prove force-ask is immune.
    const withWildcard = [...seeded, { tool: "*", decision: "allow" as const, priority: 0, source: "default" as const }];
    const lists: ShellLists = {
      safe: [],
      // Minimal force-ask: git force-push.
      forceAsk: ["git push .*--force.*"],
      equivalents: [],
      deny: [],
    };
    const push = guardian.evaluate(
      { tool: "execute_command", args: { command: "git push origin main --force" } },
      withWildcard,
      lists,
    );
    expect(push.decision).toBe("ask");
    expect(push.forceAsk).toBe(true);
    // web_fetch to a private/loopback address is an SSRF force-ask.
    const fetchPriv = guardian.evaluate(
      { tool: "web_fetch", args: { url: "http://127.0.0.1:8080/" } },
      withWildcard,
      lists,
    );
    expect(fetchPriv.decision).toBe("ask");
    expect(fetchPriv.forceAsk).toBe(true);
    expect(fetchPriv.forceAskKind).toBe("ssrf");
  });
});

describe("createCore first-run seeding via config.init (§13.9.1)", () => {
  it("seeds the global install via the production default store (isolated XDG)", async () => {
    // Use a PRIVATE XDG dir so this test neither reads nor deletes the shared
    // hermetic config dir (concurrent tests in other workers may be seeding it),
    // and never asserts about the ambient HOME/XDG. Restored before teardown so
    // the hermetic afterAll still sees the hermetic redirect.
    const prevXdg = process.env["XDG_CONFIG_HOME"];
    const xdg = await fs.mkdtemp(path.join(os.tmpdir(), "vr-init-xdg-"));
    process.env["XDG_CONFIG_HOME"] = xdg;
    try {
      const configDir = voidriftConfigDir();
      expect(configDir).toBe(path.join(xdg, "voidrift"));
      expect(existsSync(configDir)).toBe(false);

      // No injected configStore → production default → first-run seeding runs.
      const ws = await fs.mkdtemp(path.join(os.tmpdir(), "vr-init-ws-"));
      const core = await createCore({
        workspaceRoot: ws,
        sessionRepository: new InMemorySessionRepository(),
        checkpointer: createMemoryCheckpointer(),
        chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
      });
      // The seeded install is present under the ISOLATED dir.
      expect(existsSync(path.join(configDir, "config.json"))).toBe(true);
      expect(existsSync(path.join(configDir, "agents", "research", "agent.json"))).toBe(true);
      // The six seeded agents + builtin chat are discoverable; the runtime reads
      // the USER's folders, never the package seed folder.
      const listed = await core.api.agents.list();
      const names = listed.ok ? listed.value.map((a) => a.name).sort() : [];
      expect(names).toEqual(["chat", "implementer", "planner", "research", "researcher", "reviewer", "summarizer", "vibe"]);

      await core.api.session.shutdown?.();
      await fs.rm(ws, { recursive: true, force: true });
      await fs.rm(xdg, { recursive: true, force: true });
    } finally {
      if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = prevXdg;
    }
  });

  it("the runtime ignores the package seed folder (seed templates exist but are not read as agents)", async () => {
    // The seed folder ships six agent dirs; it is a TEMPLATE source only.
    const dir = seedAgentsDir();
    expect(existsSync(path.join(dir, "research", "agent.json"))).toBe(true);
    // ROOT-CAUSE isolation (§13.9.1): the agents-directory loader reads the
    // GLOBAL agents dir at `$XDG_CONFIG_HOME/voidrift/agents`. Under the SHARED
    // per-run hermetic HOME, a concurrent/earlier test that boots a core with no
    // injected configStore first-run-seeds the six agents INTO that shared dir,
    // which this core would then discover — making `names` intermittently carry
    // the seeded agents. Point this test at its OWN empty XDG (no agents on disk)
    // so the "only builtin chat" assertion depends on this test alone, not on
    // whatever the shared HOME happens to hold. Restored before teardown so the
    // hermetic afterAll still sees the hermetic redirect.
    const prevXdg = process.env["XDG_CONFIG_HOME"];
    const xdg = await fs.mkdtemp(path.join(os.tmpdir(), "vr-noseed-xdg-"));
    process.env["XDG_CONFIG_HOME"] = xdg;
    try {
      // A core with an INJECTED empty config store lists only the builtin chat
      // (no user folders, so the package seed folder is never read at runtime).
      const noseedWs = await fs.mkdtemp(path.join(os.tmpdir(), "vr-init-noseed-"));
      const core = await createCore({
        workspaceRoot: noseedWs,
        configStore: new (await import("../adapters/repositories/in-memory-config-store.js")).InMemoryConfigStore({
          models: { test: { model: "t", protocol: "openai", contextLimit: 32_000 } },
          modelSelected: "test",
        }),
        sessionRepository: new InMemorySessionRepository(),
        checkpointer: createMemoryCheckpointer(),
        chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
      });
      const listed = await core.api.agents.list();
      const names = listed.ok ? listed.value.map((a) => a.name) : [];
      expect(names).toEqual(["chat"]);
      await core.api.session.shutdown?.();
      await fs.rm(noseedWs, { recursive: true, force: true });
      await fs.rm(xdg, { recursive: true, force: true });
    } finally {
      if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = prevXdg;
    }
  });
});
