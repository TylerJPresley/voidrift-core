/**
 * Decision-point mutation-journal integration tests (core-blueprint.md §10.11).
 *
 * A write action produces exactly ONE journal entry at the moment it executes,
 * with metadata at every level; `action` carries before/after blobs for a file
 * write in order; a denied/rejected call produces NO entry; a failing append
 * blocks the write; reads never journal. Drives the SAME shared
 * `createDecisionMiddleware` the engine uses (§15.1#4).
 */
import { describe, it, expect } from "vitest";
import { ToolMessage } from "@langchain/core/messages";
import { z } from "zod";
import { createDecisionMiddleware, type DecisionPointDeps, type CallerContext, type AskResolver } from "./decision-point.js";
import { JournalRecorder } from "./journal-recorder.js";
import { InMemoryJournalStore } from "../adapters/repositories/in-memory-journal-store.js";
import { ToolRegistry } from "../entities/tool-registry.js";
import { EventBus } from "../entities/event-bus.js";
import { Guardian, builtinGuardrails } from "../entities/guardian.js";
import { Warden } from "../entities/warden.js";
import { ConfigSchema, type Config, type PermissionRule } from "../config/schema.js";
import { blobHash, type MutationLogLevel } from "../entities/journal.js";

function cfg(over: Partial<Config> = {}): Config {
  return ConfigSchema.parse({ ...over });
}
const ctx: CallerContext = { sessionId: "s1", approvalMode: "interactive" };

/** Allow everything so the gate never prompts; journaling is what we assert. */
const ALLOW_ALL: PermissionRule[] = [{ tool: "*", decision: "allow", priority: 100, source: "user" }];

function makeDeps(opts: {
  store: InMemoryJournalStore;
  level?: MutationLogLevel;
  before?: Map<string, Buffer>;
  failAppend?: boolean;
  registry?: ToolRegistry;
}): DecisionPointDeps {
  const registry = opts.registry ?? new ToolRegistry();
  const store = opts.store;
  const journal = new JournalRecorder({ store, getLevel: () => opts.level ?? "action" });
  // Optionally wrap the store append to fail (disk-full simulation).
  if (opts.failAppend) {
    const orig = store.append.bind(store);
    store.append = async () => {
      void orig;
      throw new Error("ENOSPC");
    };
  }
  return {
    guardian: new Guardian(builtinGuardrails()),
    warden: new Warden({ mode: "off" }),
    bus: new EventBus(),
    registry,
    getConfig: () => cfg(),
    tempDir: "/no/such",
    window: 32_000,
    getSessionRules: () => ALLOW_ALL,
    guardrailState: () => ({ readPaths: new Set(["a.txt"]), stalePaths: new Set() }),
    journal,
    getTurn: () => 3,
    readTargetBytes: async (p) => opts.before?.get(p) ?? null,
  };
}

async function run(
  d: DecisionPointDeps,
  name: string,
  args: Record<string, unknown>,
  resolver: AskResolver = async () => ({ decision: "allow" }),
  handlerResult?: ToolMessage,
) {
  const mw = createDecisionMiddleware(d, ctx, resolver);
  const request = { toolCall: { name, args, id: `${name}-1` } };
  const handler = async () =>
    handlerResult ?? new ToolMessage({ content: "ok", tool_call_id: `${name}-1`, status: "success" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mw as any).wrapToolCall(request, handler) as Promise<ToolMessage>;
}

function registryWith(defs: { name: string; origin?: "builtin" | "mcp" | "plugin"; readOnly?: boolean }[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const d of defs) {
    r.register(
      { name: d.name, description: "d", schema: z.object({}).passthrough(), readOnly: d.readOnly ?? false, ...(d.origin ? { origin: d.origin } : {}) },
      async () => ({ content: "ok", status: "success" }),
    );
  }
  return r;
}

describe("§10.11 — a write action produces exactly one journal entry", () => {
  it("write_file at `action` carries before+after blobs in order; one entry", async () => {
    const store = new InMemoryJournalStore();
    const registry = registryWith([{ name: "write_file" }]);
    const before = new Map([["a.txt", Buffer.from("old")]]);
    const d = makeDeps({ store, level: "action", before, registry });
    const res = await run(d, "write_file", { path: "a.txt", content: "fresh" });
    expect(res.status).toBe("success");
    const entries = await store.list("s1");
    expect(entries.length).toBe(1);
    const e = entries[0]!;
    expect(e.tool).toBe("write_file");
    expect(e.turn).toBe(3);
    expect(e.target).toBe("a.txt");
    expect(e.blobs?.before).toBe(blobHash(Buffer.from("old")));
    expect(e.blobs?.after).toBe(blobHash(Buffer.from("fresh")));
    // Content is NEVER in the entry call — only byte length + sha.
    expect(e.call["content"]).toEqual({ bytes: 5, sha256: blobHash(Buffer.from("fresh")) });
  });

  it("at `off` a write_file still records metadata (no blobs)", async () => {
    const store = new InMemoryJournalStore();
    const registry = registryWith([{ name: "write_file" }]);
    const d = makeDeps({ store, level: "off", registry });
    await run(d, "write_file", { path: "new.txt", content: "x" });
    const [e] = await store.list("s1");
    expect(e!.blobs).toBeUndefined();
    expect(e!.undoHint).toBe("file did not exist");
  });

  it("a non-safe execute_command produces one metadata entry", async () => {
    const store = new InMemoryJournalStore();
    const registry = registryWith([{ name: "execute_command" }]);
    const d = makeDeps({ store, registry });
    await run(d, "execute_command", { command: "touch z" });
    const entries = await store.list("s1");
    expect(entries.length).toBe(1);
    expect(entries[0]!.tool).toBe("execute_command");
  });

  it("an MCP and a plugin tool each journal one entry (treated as mutating)", async () => {
    const store = new InMemoryJournalStore();
    const registry = registryWith([
      { name: "mcp_x", origin: "mcp" },
      { name: "plug_y", origin: "plugin" },
    ]);
    const d = makeDeps({ store, registry });
    await run(d, "mcp_x", { a: 1 });
    await run(d, "plug_y", { b: 2 });
    const entries = await store.list("s1");
    expect(entries.map((e) => e.tool).sort()).toEqual(["mcp_x", "plug_y"]);
  });

  it("a READ never journals (read_file, and a safe execute_command)", async () => {
    const store = new InMemoryJournalStore();
    const registry = registryWith([{ name: "read_file", readOnly: true }, { name: "execute_command" }]);
    const d = makeDeps({ store, registry });
    await run(d, "read_file", { path: "a.txt" });
    await run(d, "execute_command", { command: "git status" }); // safe → read
    expect((await store.list("s1")).length).toBe(0);
  });

  it("a REJECTED write produces NO entry", async () => {
    const store = new InMemoryJournalStore();
    const registry = registryWith([{ name: "write_file" }]);
    // No allow rule → the gate asks; the resolver rejects.
    const d = { ...makeDeps({ store, registry }), getSessionRules: () => [] as PermissionRule[] };
    const res = await run(d, "write_file", { path: "a.txt", content: "x" }, async () => ({ decision: "reject" }));
    expect(res.status).toBe("error");
    expect((await store.list("s1")).length).toBe(0);
  });

  it("a failing journal append BLOCKS the write with a loud error naming the target", async () => {
    const store = new InMemoryJournalStore();
    const registry = registryWith([{ name: "write_file" }]);
    const d = makeDeps({ store, registry, failAppend: true, before: new Map([["a.txt", Buffer.from("old")]]) });
    const res = await run(d, "write_file", { path: "a.txt", content: "x" });
    expect(res.status).toBe("error");
    expect(String(res.content)).toContain("mutation journal incomplete");
    expect(String(res.content)).toContain("a.txt");
  });

  it("a worker (workerId on ctx) journals into the session with its workerId", async () => {
    const store = new InMemoryJournalStore();
    const registry = registryWith([{ name: "write_file" }]);
    const d = makeDeps({ store, level: "off", registry });
    const mw = createDecisionMiddleware(d, { sessionId: "s1", workerId: "w9", approvalMode: "policy_only" }, async () => ({ decision: "allow" }));
    const request = { toolCall: { name: "write_file", args: { path: "w.txt", content: "y" }, id: "wf" } };
    const handler = async () => new ToolMessage({ content: "ok", tool_call_id: "wf", status: "success" as const });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (mw as any).wrapToolCall(request, handler);
    const [e] = await store.list("s1");
    expect(e!.workerId).toBe("w9");
  });
});

describe("§10.11 — edit_file after-state unavailability and error-text hardening", () => {
  it("a failed edit_file after-read sets afterUnavailable + note and emits a WARNING", async () => {
    const store = new InMemoryJournalStore();
    const registry = registryWith([{ name: "edit_file" }]);
    const bus = new EventBus();
    const warnings: unknown[] = [];
    bus.subscribe("WARNING_EMITTED", (e) => warnings.push(e.payload));
    const journal = new JournalRecorder({ store, getLevel: () => "action" });
    // before-read returns bytes; the SECOND read (the post-write after-state) throws.
    let reads = 0;
    const d: DecisionPointDeps = {
      guardian: new Guardian(builtinGuardrails()),
      warden: new Warden({ mode: "off" }),
      bus,
      registry,
      getConfig: () => cfg(),
      tempDir: "/no/such",
      workspaceRoot: "/ws",
      window: 32_000,
      getSessionRules: () => ALLOW_ALL,
      guardrailState: () => ({ readPaths: new Set(["a.txt"]), stalePaths: new Set() }),
      journal,
      getTurn: () => 3,
      readTargetBytes: async () => {
        reads += 1;
        if (reads >= 2) throw new Error("EACCES: open '/etc/shadow'");
        return Buffer.from("old");
      },
    };
    const mw = createDecisionMiddleware(d, ctx, async () => ({ decision: "allow" }));
    const request = { toolCall: { name: "edit_file", args: { path: "a.txt", search: "a", replace: "b" }, id: "ef" } };
    const res = (await (mw as unknown as { wrapToolCall: (r: unknown, h: () => Promise<ToolMessage>) => Promise<ToolMessage> }).wrapToolCall(
      request,
      async () => new ToolMessage({ content: "ok", tool_call_id: "ef", status: "success" }),
    )) as ToolMessage;
    expect(res.status).toBe("success"); // a failed after-read does NOT fail the write
    const [e] = await store.list("s1");
    expect(e!.afterUnavailable).toBe(true);
    expect(e!.note).toContain("after-state unavailable");
    // The WARNING carries a sanitized path — never the raw /etc/shadow.
    const w = warnings.find((x) => (x as { source?: string }).source === "after-read") as { pattern?: string };
    expect(w).toBeDefined();
    expect(w!.pattern).not.toContain("/etc/shadow");
    expect(w!.pattern).toContain("<path>");
  });

  it("a failing append's model-visible error does NOT echo an out-of-workspace path", async () => {
    const store = new InMemoryJournalStore();
    const registry = registryWith([{ name: "write_file" }]);
    store.append = async () => {
      throw new Error("ENOSPC writing /etc/shadow-ish/path");
    };
    const d = makeDeps({ store, registry, before: new Map([["a.txt", Buffer.from("old")]]) });
    (d as { workspaceRoot?: string }).workspaceRoot = "/ws";
    const res = await run(d, "write_file", { path: "a.txt", content: "x" });
    expect(res.status).toBe("error");
    expect(String(res.content)).toContain("mutation journal incomplete");
    expect(String(res.content)).toContain("a.txt"); // the in-workspace target IS named
    expect(String(res.content)).not.toContain("/etc/shadow-ish"); // the stray path is NOT
  });
});
