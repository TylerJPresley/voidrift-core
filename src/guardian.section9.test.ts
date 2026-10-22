/**
 * §9 acceptance integration test (core-blueprint.md §9, §15.2).
 *
 * The one decision point, Warden then Guardian:
 *  - a gated write with no rule returns `ask` and pauses `out_of_band` with the
 *    FULL action, resolved on `confirm`;
 *  - a persisted rule auto-approves a later identical call;
 *  - `git push --force` is force-asked under a broad `git *` allow;
 *  - an edit to an unread file is blocked by the guardrail;
 *  - the Warden shim allows when no policy is configured;
 *  - reads are free.
 *
 * Plus the pure shell-classification cases (§9.3). Deterministic and offline:
 * `fakeModel()` drives the engine over a per-test temp workspace.
 */
import { hermeticTmp } from "./test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import path from "node:path";
import fs from "node:fs/promises";
import { createCore } from "./boot.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { seededPermissionsRecord } from "./test-support/seed-rules.js";
import type { ResolvedModel } from "./entities/ports/model-port.js";
import type { ModelConfigEntry } from "./config/schema.js";
import { classifyCommand } from "./entities/guardian.js";
import * as secretMask from "./use-cases/secret-mask.js";
import { DEFAULT_SHELL_SAFE, DEFAULT_SHELL_FORCE_ASK, DEFAULT_SHELL_EQUIVALENTS } from "./config/schema.js";

const seed = {
  models: { test: { model: "test-model", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "test",
  permissions: seededPermissionsRecord(),
};

function fakeFactory(script: () => ReturnType<typeof fakeModel>) {
  return (_r: ResolvedModel, _e: ModelConfigEntry) => script();
}

const lists = {
  safe: DEFAULT_SHELL_SAFE,
  forceAsk: DEFAULT_SHELL_FORCE_ASK,
  equivalents: DEFAULT_SHELL_EQUIVALENTS,
  deny: [] as string[],
};

describe("§9 — Guardian and Warden: one decision point", () => {
  let ws: string;
  let dbPath: string;
  const trackedCores: { session: { shutdown: () => Promise<void> } }[] = [];

  beforeEach(async () => {
    ws = hermeticTmp("s9");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    dbPath = path.join(ws, ".voidrift", "checkpoint.db");
    await fs.writeFile(path.join(ws, "read-me.txt"), "readable");
    trackedCores.length = 0;
  });

  afterEach(async () => {
    // Drain the obs writer (best-effort §10.3) before teardown.
    for (const c of trackedCores) await c.session.shutdown().catch(() => undefined);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("a gated write with no rule asks, pauses out_of_band with the full action, and resolves on confirm; reads are free", async () => {
    const sessions = new InMemorySessionRepository();
    const saver = SqliteSaver.fromConnString(dbPath);
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "read_file", args: { path: "read-me.txt" } }]) // free read
        .respondWithTools([{ name: "write_file", args: { path: "out.txt", content: "x" } }]) // gated
        .respond(new AIMessage("done"));

    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: sessions,
      chatModelFactory: fakeFactory(script),
      checkpointer: saver,
    });
        trackedCores.push(api);

    const created = await api.session.create({ name: "s9" });
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "do it", approvalMode: "out_of_band" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // The free read ran, then the gated write paused with the FULL action.
      expect(res.value.status).toBe("waiting_for_approval");
      expect(res.value.pending?.[0]?.tool).toBe("write_file");
      expect(res.value.pending?.[0]?.args).toMatchObject({ path: "out.txt", content: "x" });
    }
    const requestId = res.ok ? res.value.pending![0]!.id : "";
    const done = await api.session.confirm(id, { requestId, decision: "approve" });
    expect(done.ok).toBe(true);
    if (done.ok) expect(done.value.status).toBe("completed");
    expect(await fs.readFile(path.join(ws, "out.txt"), "utf8")).toBe("x");
    saver.db.close();
  });

  it("a persisted rule auto-approves a later identical call", async () => {
    const sessions = new InMemorySessionRepository();
    const saver = SqliteSaver.fromConnString(dbPath);
    // A config permissions rule allowing write_file to out.txt (persisted trust).
    const store = new InMemoryConfigStore({
      ...seed,
      permissions: {
        "allow-out": { tool: "write_file", pattern: "out.txt", decision: "allow", priority: 200, source: "workspace" },
      },
    });
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "write_file", args: { path: "out.txt", content: "y" } }])
        .respond(new AIMessage("auto done"));

    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: store,
      sessionRepository: sessions,
      chatModelFactory: fakeFactory(script),
      checkpointer: saver,
    });
        trackedCores.push(api);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    // interactive mode with NO onApproval: an auto-approving rule means no ask fires.
    const res = await api.session.send(id, { input: "write", approvalMode: "interactive" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // The rule auto-approved: the turn completed without pausing.
      expect(res.value.status).toBe("completed");
      expect(res.value.text).toBe("auto done");
    }
    expect(await fs.readFile(path.join(ws, "out.txt"), "utf8")).toBe("y");
    saver.db.close();
  });

  it("git push --force is force-asked even under a broad `git *` allow", async () => {
    const sessions = new InMemorySessionRepository();
    const saver = SqliteSaver.fromConnString(dbPath);
    const store = new InMemoryConfigStore({
      ...seed,
      permissions: {
        "git-all": { tool: "execute_command", pattern: "git *", decision: "allow", priority: 100, source: "user" },
      },
    });
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "execute_command", args: { command: "git push --force origin main" } }])
        .respond(new AIMessage("after"));

    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: store,
      sessionRepository: sessions,
      chatModelFactory: fakeFactory(script),
      checkpointer: saver,
    });
        trackedCores.push(api);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "push", approvalMode: "out_of_band" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // The broad allow does NOT satisfy a force-ask: the call pauses for approval.
      expect(res.value.status).toBe("waiting_for_approval");
      expect(res.value.pending?.[0]?.tool).toBe("execute_command");
      expect(res.value.pending?.[0]?.args).toMatchObject({ command: "git push --force origin main" });
    }
    saver.db.close();
  });

  it("an edit to an unread file is blocked by the guardrail even after approval", async () => {
    const sessions = new InMemorySessionRepository();
    const saver = SqliteSaver.fromConnString(dbPath);
    await fs.writeFile(path.join(ws, "unread.txt"), "original content here");
    // Allow edit_file by rule so the only thing standing is the guardrail.
    const store = new InMemoryConfigStore({
      ...seed,
      permissions: {
        "allow-edit": { tool: "edit_file", pattern: "*", decision: "allow", priority: 200, source: "workspace" },
      },
    });
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "edit_file", args: { path: "unread.txt", search: "original", replace: "changed" } }])
        .respond(new AIMessage("edit attempt done"));

    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: store,
      sessionRepository: sessions,
      chatModelFactory: fakeFactory(script),
      checkpointer: saver,
    });
        trackedCores.push(api);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    let denied = false;
    api.events.register("PERMISSION_DENIED");
    const res = await api.session.send(id, { input: "edit", approvalMode: "policy_only" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // The turn completes (the tool returned an error result the loop fed back),
      // but the file is unchanged — the guardrail blocked the write.
      expect(res.value.status).toBe("completed");
    }
    expect(await fs.readFile(path.join(ws, "unread.txt"), "utf8")).toBe("original content here");
    void denied;
    saver.db.close();
  });

  it("the Warden shim allows when no policy is configured", async () => {
    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: fakeFactory(() => fakeModel().respond(new AIMessage("x"))),
    });
        trackedCores.push(api);
    const status = await api.compliance.status();
    expect(status.ok).toBe(true);
    if (status.ok) {
      const s = status.value as { mode: string };
      expect(s.mode).toBe("off"); // no policy configured → allow shim
    }
  });

  it("shell classification resolves safe, unknown, dangerous-in-compound, has-equivalent, and redirect-as-write", () => {
    expect(classifyCommand("ls -la", lists).cls).toBe("safe");
    expect(classifyCommand('git commit -m "x"', lists).cls).toBe("unknown");
    expect(classifyCommand("a && rm -rf b", lists).cls).toBe("dangerous");
    expect(classifyCommand("cat f", lists).cls).toBe("has-equivalent");
    // `echo x > f` writes a file: the redirect escapes the safe pattern.
    expect(classifyCommand("echo x > f", lists).cls).not.toBe("safe");
  });

  it("command substitution danger is classified: $(...), backtick, and nesting force-ask; benign stays unknown/safe", () => {
    // Dangerous command hidden in a `$(...)` substitution is classified dangerous.
    expect(classifyCommand("echo $(rm -rf /)", lists).cls).toBe("dangerous");
    // Backtick substitution is extracted too.
    expect(classifyCommand("echo `sudo x`", lists).cls).toBe("dangerous");
    // Nested substitution: the danger is at the deepest level.
    expect(classifyCommand("echo $( foo $(git push --force) bar )", lists).cls).toBe("dangerous");
    // Benign substitution: `date` is unknown → the whole command is unknown, not safe.
    expect(classifyCommand("echo $(date)", lists).cls).toBe("unknown");
    // A plain safe command with no substitution stays safe.
    expect(classifyCommand("ls", lists).cls).toBe("safe");
  });

  it("whitespace evasions (${IFS}, tab, newline) still force-ask at top level and inside substitutions", () => {
    // ${IFS} word-splitting at top level.
    expect(classifyCommand("rm${IFS}-rf${IFS}/", lists).cls).toBe("dangerous");
    // ${IFS} inside a substitution.
    expect(classifyCommand("echo $(rm${IFS}-rf${IFS}/)", lists).cls).toBe("dangerous");
    // Tab-separated arguments inside a substitution.
    expect(classifyCommand("echo $(rm\t-rf\t/)", lists).cls).toBe("dangerous");
    // Newline-separated argument inside a substitution.
    expect(classifyCommand("echo $(rm -rf\n/)", lists).cls).toBe("dangerous");
    // $IFS (unbraced) form at top level.
    expect(classifyCommand("sudo$IFS-i", lists).cls).toBe("dangerous");
    // Backslash-escape obfuscation of word chars is collapsed before matching.
    expect(classifyCommand("r\\m -rf /", lists).cls).toBe("dangerous");
    expect(classifyCommand("s\\udo -i", lists).cls).toBe("dangerous");
    // Backslash-escape combined with ${IFS} word-splitting, inside a substitution.
    expect(classifyCommand("echo $(r\\m${IFS}-rf${IFS}/)", lists).cls).toBe("dangerous");
    // Benign whitespace-normalized command stays safe.
    expect(classifyCommand("ls${IFS}-la", lists).cls).toBe("safe");
  });

  it("a dangerous command substitution force-asks even under a broad `execute *` allow", async () => {
    const sessions = new InMemorySessionRepository();
    const saver = SqliteSaver.fromConnString(dbPath);
    const store = new InMemoryConfigStore({
      ...seed,
      permissions: {
        "exec-all": { tool: "execute_command", pattern: "*", decision: "allow", priority: 100, source: "user" },
      },
    });
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "execute_command", args: { command: "echo $(git push --force)" } }])
        .respond(new AIMessage("after"));

    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: store,
      sessionRepository: sessions,
      chatModelFactory: fakeFactory(script),
      checkpointer: saver,
    });
        trackedCores.push(api);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "run", approvalMode: "out_of_band" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // The broad `execute *` allow does NOT auto-approve the embedded force-ask
      // (`git push --force`); a never-list command inside a substitution would
      // instead deny outright (covered in the never-list suite).
      expect(res.value.status).toBe("waiting_for_approval");
      expect(res.value.pending?.[0]?.tool).toBe("execute_command");
    }
    saver.db.close();
  });

  it("a whitespace-evaded dangerous substitution force-asks even under a broad `execute *` allow", async () => {
    const sessions = new InMemorySessionRepository();
    const saver = SqliteSaver.fromConnString(dbPath);
    const store = new InMemoryConfigStore({
      ...seed,
      permissions: {
        "exec-all": { tool: "execute_command", pattern: "*", decision: "allow", priority: 100, source: "user" },
      },
    });
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "execute_command", args: { command: "echo $(git${IFS}push${IFS}--force)" } }])
        .respond(new AIMessage("after"));

    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: store,
      sessionRepository: sessions,
      chatModelFactory: fakeFactory(script),
      checkpointer: saver,
    });
        trackedCores.push(api);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "run", approvalMode: "out_of_band" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // The ${IFS} word-split force-ask is normalized and still force-asks under
      // a broad allow (a never-list command would deny outright instead).
      expect(res.value.status).toBe("waiting_for_approval");
      expect(res.value.pending?.[0]?.tool).toBe("execute_command");
    }
    saver.db.close();
  });

  it("the secret-mask seam is invoked on the ask path (§10.10)", async () => {
    const spy = vi.spyOn(secretMask, "maskSecrets");
    const sessions = new InMemorySessionRepository();
    const saver = SqliteSaver.fromConnString(dbPath);
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "execute_command", args: { command: "git push --force origin main" } }])
        .respond(new AIMessage("after"));

    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: sessions,
      chatModelFactory: fakeFactory(script),
      checkpointer: saver,
    });
        trackedCores.push(api);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.send(id, { input: "push", approvalMode: "out_of_band" });

    // The force-ask routes call.args through the mask seam before it leaves the process.
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ command: "git push --force origin main" }),
    );
    spy.mockRestore();
    saver.db.close();
  });

  it("masks a secret in inferredPatterns on the normal ask path (§10.10)", async () => {
    const sessions = new InMemorySessionRepository();
    const saver = SqliteSaver.fromConnString(dbPath);
    const secret = "sk-ABC" + "DEF0123456789ABCDEF0123456789";
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "execute_command", args: { command: `git push --force --token=${secret}` } }])
        .respond(new AIMessage("after"));

    const { api } = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore(seed),
      sessionRepository: sessions,
      chatModelFactory: fakeFactory(script),
      checkpointer: saver,
    });
    trackedCores.push(api);
    const patternSets: string[][] = [];
    api.events.subscribe("PERMISSION_REQUESTED", (e) => {
      patternSets.push(((e.payload as { inferredPatterns?: string[] }).inferredPatterns ?? []));
    });
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.send(id, { input: "push", approvalMode: "out_of_band" });

    expect(patternSets.length).toBeGreaterThan(0);
    for (const set of patternSets) for (const p of set) expect(p).not.toContain(secret);
    saver.db.close();
  });
});
