/**
 * §8.6/§13.11 `tools.notesContentMaxBytes` + `tools.notesFileMaxBytes` — both are
 * `warn`-class registry keys: an over-cap note is ACCEPTED in full (the write
 * succeeds) with exactly ONE `LIMIT_HIT` naming the key; a configured
 * `{action:"deny"}` REFUSES the write at the bound with the same notice and
 * emits one hit too. Driven over the REAL temp-dir `FilesystemAdapter` and a
 * real `LimitsCapability` port.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { FilesystemAdapter } from "../adapters/filesystem.js";
import { buildResearchNotesTool } from "./research-notes.js";
import { EventBus } from "../entities/event-bus.js";
import { resolveLimits } from "../entities/limits-resolve.js";
import { LimitsCapability } from "../use-cases/limits-capability.js";

const FINDINGS = [".voidrift/research/"];

describe("researcher_save_notes caps — warn vs deny (§8.6, §13.11 NOTE1/NOTE1b)", () => {
  let ws: string;
  let adapter: FilesystemAdapter;
  let bus: EventBus;
  let hits: { key: string }[];
  beforeEach(() => {
    ws = hermeticTmp("notes-cap");
    adapter = new FilesystemAdapter(ws);
    bus = new EventBus();
    hits = [];
    bus.subscribe("LIMIT_HIT", (e) => hits.push(e.payload as { key: string }));
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  function toolWith(overrides: Record<string, unknown>) {
    const limits = new LimitsCapability(resolveLimits([{ layer: "project", limits: overrides }]), bus);
    return buildResearchNotesTool({ fs: adapter, getFindingsDirectories: () => [...FINDINGS], limits });
  }
  const call = (t: ReturnType<typeof buildResearchNotesTool>, args: { path: string; content: string; mode?: "create" | "append" }) =>
    t.invoke(args) as Promise<string>;

  it("content deny: over-cap write is REFUSED with the key-naming notice and ONE hit, nothing written", async () => {
    const t = toolWith({ tools: { notesContentMaxBytes: { value: 10, action: "deny" } } });
    const r = await call(t, { path: ".voidrift/research/q.md", content: "x".repeat(50) });
    expect(r).toContain("limits.tools.notesContentMaxBytes");
    expect(hits.filter((h) => h.key === "tools.notesContentMaxBytes").length).toBe(1);
    const wrote = await fs.readFile(path.join(ws, ".voidrift/research/q.md"), "utf8").then(() => true).catch(() => false);
    expect(wrote).toBe(false);
  });

  it("file deny: over-cap create is REFUSED with the key-naming notice and ONE hit", async () => {
    // content cap high so only the file cap bites.
    const t = toolWith({ tools: { notesContentMaxBytes: 1_000_000, notesFileMaxBytes: { value: 10, action: "deny" } } });
    const r = await call(t, { path: ".voidrift/research/q.md", content: "x".repeat(50) });
    expect(r).toContain("limits.tools.notesFileMaxBytes");
    expect(hits.filter((h) => h.key === "tools.notesFileMaxBytes").length).toBe(1);
    const wrote = await fs.readFile(path.join(ws, ".voidrift/research/q.md"), "utf8").then(() => true).catch(() => false);
    expect(wrote).toBe(false);
  });

  it("file warn: over-cap create is ACCEPTED in full with ONE hit", async () => {
    const t = toolWith({ tools: { notesContentMaxBytes: 1_000_000, notesFileMaxBytes: 10 } });
    const r = await call(t, { path: ".voidrift/research/q.md", content: "x".repeat(50) });
    expect(JSON.parse(r).mode).toBe("create");
    expect(await fs.readFile(path.join(ws, ".voidrift/research/q.md"), "utf8")).toBe("x".repeat(50));
    expect(hits.filter((h) => h.key === "tools.notesFileMaxBytes").length).toBe(1);
  });
});
