/**
 * The 16 built-in datasets registered at startup (core-blueprint.md §12.7).
 *
 * Through the REAL facade (a booted test core): `datasets.list` names all 16;
 * `datasets.rows(name)` returns rows carrying the declared field keys; a
 * permissions row holding a secret is masked; a disabled-plugin dataset (`plan`)
 * is absent. (The plan plugin registering its own `plan` dataset is covered in
 * the plan plugin's own suite — the core registers only the 16 built-ins.)
 */
import { describe, it, expect } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import { createCore } from "../boot.js";
import { InMemoryConfigStore } from "../adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "../adapters/repositories/session-repository.js";
import { createMemoryCheckpointer } from "../adapters/checkpointer.js";

/** The canonical 16 built-in dataset names (§12.7). */
const BUILTIN_NAMES = [
  "sessions", "models", "agents", "tools", "mcp", "plugins", "permissions",
  "compliance", "memory", "memory-suggestions", "skills", "prompts", "stats",
  "context", "diff", "commands",
] as const;

const seed = {
  models: { test: { model: "test-model", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "test",
  // A permission rule whose pattern carries a secret, so the permissions dataset
  // row is masked on the way out (§10.10, §12.7).
  permissions: {
    "allow-secret": {
      tool: "execute_command",
      pattern: "curl -H 'Authorization: Bearer ghp_01" + "23456789abcdefghijklmnopqrstuvwxyz'",
      decision: "allow",
      priority: 0,
      source: "workspace",
    },
  },
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

describe("built-in datasets (§12.7)", () => {
  it("datasets.list names all 16 built-ins at startup", async () => {
    const { api } = await makeCore();
    const listed = await api.datasets.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const names = listed.value.map((d) => d.name).sort();
    for (const n of BUILTIN_NAMES) expect(names).toContain(n);
    // The disabled-plugin dataset is absent — the core registers only its own.
    expect(names).not.toContain("plan");
    // Every built-in carries a non-empty description.
    for (const d of listed.value) expect(d.description.length).toBeGreaterThan(0);
  });

  it("each built-in dataset's rows carry the declared field keys for a booted core", async () => {
    const { api } = await makeCore();
    const listed = await api.datasets.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const byName = new Map(listed.value.map((d) => [d.name, d]));
    // Datasets that produce rows without a live session/turn: assert the first
    // row carries every declared field key (a composed/empty dataset is skipped
    // — an empty array can't violate the shape).
    for (const name of ["models", "agents", "permissions", "skills", "prompts", "commands"]) {
      const res = await api.datasets.rows(name);
      expect(res.ok, name).toBe(true);
      if (!res.ok) continue;
      if (res.value.length === 0) continue;
      const keys = new Set(Object.keys(res.value[0] as Record<string, unknown>));
      for (const f of byName.get(name)!.fields ?? []) expect(keys.has(f.key), `${name}.${f.key}`).toBe(true);
    }
    // models always has at least the seeded endpoint.
    const models = await api.datasets.rows("models");
    expect(models.ok).toBe(true);
    if (models.ok) expect(models.value.length).toBeGreaterThan(0);
  });

  it("datasets.rows('permissions') masks a secret in a rule before it leaves the core", async () => {
    const { api } = await makeCore();
    const res = await api.datasets.rows("permissions");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const serialized = JSON.stringify(res.value);
    expect(serialized).not.toContain("ghp_01" + "23456789abcdefghijklmnopqrstuvwxyz");
    expect(serialized).toContain("«redacted");
  });

  it("the session/stats/context/diff datasets return an empty array (no live session) without throwing", async () => {
    const { api } = await makeCore();
    for (const name of ["sessions", "stats", "context", "diff", "mcp", "memory", "memory-suggestions", "compliance"]) {
      const res = await api.datasets.rows(name);
      expect(res.ok, name).toBe(true);
      if (res.ok) expect(Array.isArray(res.value), name).toBe(true);
    }
  });
});
