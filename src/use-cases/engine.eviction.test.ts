/**
 * Large-result eviction through the ENGINE's tool-call path (core-blueprint.md
 * §8.3). Drives `createCore` over a real temp workspace (real FilesystemAdapter,
 * so the atomic write + mode 0600 are real) with a tiny `contextLimit` so the
 * threshold is small and a modest tool result crosses it. Offline + deterministic:
 * a `read_file` of a prepared file is the oversized result (no shell, no network).
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import path from "node:path";
import fs from "node:fs/promises";
import { createCore } from "../boot.js";
import { InMemoryConfigStore } from "../adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "../adapters/repositories/session-repository.js";
import type { ResolvedModel } from "../entities/ports/model-port.js";
import type { ModelConfigEntry } from "../config/schema.js";
import { seededPermissionsRecord } from "../test-support/seed-rules.js";

/** A 16k window: fitFraction 0.4 of the available budget ⇒ a ~5–6k-token
 * eviction threshold, so a ~40k-char (~10k-token) result evicts and a tiny one
 * does not. */
const seed = {
  models: { t: { model: "t", protocol: "openai", contextLimit: 16_000 } },
  modelSelected: "t",
  // Seeded allow list (§13.8): read_file is free by rule, not by read-class (§9).
  permissions: seededPermissionsRecord(),
};

function factory(script: () => ReturnType<typeof fakeModel>) {
  return (_r: ResolvedModel, _e: ModelConfigEntry) => script();
}

const tracked: { session: { shutdown: () => Promise<void>; delete?: (id: string) => Promise<unknown> } }[] = [];
async function make(ws: string, script: () => ReturnType<typeof fakeModel>, cfg = seed) {
  const ready = await createCore({
    workspaceRoot: ws,
    configStore: new InMemoryConfigStore(cfg),
    sessionRepository: new InMemorySessionRepository(),
    chatModelFactory: factory(script),
  });
  tracked.push(ready.api as unknown as (typeof tracked)[number]);
  return ready.api;
}

describe("§8.3 — large-result eviction in the engine tool-call path", () => {
  let ws: string;
  beforeEach(async () => {
    ws = hermeticTmp("evict");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
  });
  afterEach(async () => {
    for (const c of tracked) await c.session.shutdown().catch(() => undefined);
    tracked.length = 0;
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("a SMALL read result is returned UNCHANGED (zero behavior change below threshold)", async () => {
    await fs.writeFile(path.join(ws, "small.txt"), "a tiny readable file");
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "read_file", args: { path: "small.txt" } }])
        .respond(new AIMessage("done"));
    const api = await make(ws, script);
    const evictions: unknown[] = [];
    api.events.subscribe("TOOL_RESULT_EVICTED", (e) => evictions.push(e.payload));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "read small" });
    expect(res.ok).toBe(true);
    expect(evictions).toHaveLength(0);
    // No session cache tool-*.txt file was written.
    const cacheDir = path.join(ws, ".voidrift", "cache", "session", id);
    const files = await fs.readdir(cacheDir).catch(() => [] as string[]);
    expect(files.filter((f) => f.startsWith("tool-"))).toHaveLength(0);
  });

  it("a LARGE result is evicted: handle to the model, FULL masked body cached mode 0600, artifact off-model, removed by session.delete", async () => {
    // One ~40k-char line (far over the ~1600-char threshold, well under the 2000
    // line read limit so read_file returns it whole).
    const big = "X".repeat(40_000);
    await fs.writeFile(path.join(ws, "big.txt"), big);
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "read_file", args: { path: "big.txt" } }])
        .respond(new AIMessage("read it"));
    const api = await make(ws, script);
    const evictions: { path: string; size: number; excerpt: string }[] = [];
    api.events.subscribe("TOOL_RESULT_EVICTED", (e) => evictions.push(e.payload as never));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "read big" });
    expect(res.ok).toBe(true);

    // §10.2 — exactly one eviction recorded, carrying the handle excerpt.
    expect(evictions).toHaveLength(1);
    expect(evictions[0]!.excerpt).toContain("evicted");
    expect(evictions[0]!.path).toContain(`.voidrift/cache/session/${id}/tool-`);

    // The cached file holds the FULL body on disk and is mode 0600.
    const cacheDir = path.join(ws, ".voidrift", "cache", "session", id);
    const files = (await fs.readdir(cacheDir)).filter((f) => f.startsWith("tool-"));
    expect(files).toHaveLength(1);
    const cacheFile = path.join(cacheDir, files[0]!);
    const onDisk = await fs.readFile(cacheFile, "utf8");
    expect(onDisk).toContain("X".repeat(40_000)); // full result survived
    const mode = (await fs.stat(cacheFile)).mode & 0o777;
    expect(mode).toBe(0o600);

    // No stray temp file was left in the cache dir.
    expect((await fs.readdir(cacheDir)).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);

    // session.delete removes the whole session cache dir (§5.8) — the evicted
    // file goes with it.
    const del = await (api.session as unknown as { delete: (id: string) => Promise<{ ok: boolean }> }).delete(id);
    expect(del.ok).toBe(true);
    expect(await fs.readdir(cacheDir).then(() => true, () => false)).toBe(false);
  });

  it("a secret in a large result is MASKED in both the handle excerpt and the cached file (§10.10)", async () => {
    const secretLine = "Authorization: Bearer sk-liv" + "e-SECRETVALUE0123456789abcdef";
    const big = secretLine + "\n" + "Z".repeat(40_000);
    await fs.writeFile(path.join(ws, "secret.txt"), big);
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "read_file", args: { path: "secret.txt" } }])
        .respond(new AIMessage("ok"));
    const api = await make(ws, script);
    const evictions: { excerpt: string }[] = [];
    api.events.subscribe("TOOL_RESULT_EVICTED", (e) => evictions.push(e.payload as never));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.send(id, { input: "read secret" });

    const cacheDir = path.join(ws, ".voidrift", "cache", "session", id);
    const files = (await fs.readdir(cacheDir)).filter((f) => f.startsWith("tool-"));
    const onDisk = await fs.readFile(path.join(cacheDir, files[0]!), "utf8");
    // The raw bearer value is NOWHERE: not the persisted file, not the handle.
    expect(onDisk).not.toContain("sk-liv" + "e-SECRETVALUE0123456789abcdef");
    expect(onDisk).toContain("«redacted:");
    expect(evictions[0]!.excerpt).not.toContain("sk-liv" + "e-SECRETVALUE0123456789abcdef");
  });

  it("an EVICTED large result still reports its real tool name in toolsUsed (not an empty name) (§8.3, §14.6)", async () => {
    // Regression: the eviction path rebuilt the ToolMessage WITHOUT its `name`,
    // so engine `toolsUsed` (built from ToolMessage.name) showed an empty entry
    // for any tool whose result was large enough to evict.
    //
    // This case checks the turn's RETURNED `toolsUsed`, so the turn must run to
    // completion — unlike the eviction/cache cases above, which assert only the
    // off-model artifact. The window is chosen so the 40k single-line result
    // does NOT fit the available budget (the `limits.ingest.fitFraction` fit
    // test, 0.4 of ~16k available ⇒ a ~6400-token threshold < the result's ~10k
    // tokens, so it evicts) while the small handle still fits the follow-up call.
    const bigSeed = { ...seed, models: { t: { model: "t", protocol: "openai", contextLimit: 16_000 } } };
    const big = "Y".repeat(40_000);
    await fs.writeFile(path.join(ws, "huge.txt"), big);
    const script = () =>
      fakeModel()
        .respondWithTools([{ name: "read_file", args: { path: "huge.txt" } }])
        .respond(new AIMessage("done"));
    const api = await make(ws, script, bigSeed);
    const evictions: unknown[] = [];
    api.events.subscribe("TOOL_RESULT_EVICTED", (e) => evictions.push(e.payload));
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    const res = await api.session.send(id, { input: "read huge" });
    expect(res.ok).toBe(true);
    expect(res.ok && res.value.status).toBe("completed"); // ran to completion, not overflow
    expect(evictions).toHaveLength(1); // it really was evicted
    if (res.ok) {
      expect(res.value.toolsUsed).toContain("read_file");
      expect(res.value.toolsUsed).not.toContain(""); // no empty name
    }
  });

  it("the per-result eviction cap (contextToolResultPct) is GONE — one delivery rule via ingest.fitFraction (§8.3/§8.7)", async () => {
    const { ConfigSchema } = await import("../config/schema.js");
    // The former per-result share cap is removed: the key is now unknown and
    // rejected by the strict schema; eviction is the one fit test
    // (`limits.ingest.fitFraction` of the available budget), not a separate key.
    expect(ConfigSchema.safeParse({ ...seed, contextToolResultPct: 10 }).success).toBe(false);
    // The trim keys that shape the eviction handle still resolve to their defaults.
    const ok = ConfigSchema.parse({ ...seed });
    expect(ok.toolsTrimHeadLines).toBe(30);
    expect(ok.toolsTrimTailLines).toBe(20);
  });
});
