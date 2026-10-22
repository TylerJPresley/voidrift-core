/**
 * Regression (core-blueprint.md §10.6): the cross-session sequence seed has a
 * PRODUCTION call site. Before this, `seedSequencesFromPriorSessions` was only
 * called from its unit test, so the "across sessions" count was always 0 in a
 * real run. A `send` must seed the session's detector from prior sessions at the
 * session-start boundary, before the live turn.
 */
import { describe, it, expect, vi } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import { createCore } from "./boot.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
import { createMemoryCheckpointer } from "./adapters/checkpointer.js";
import { ObsWriter } from "./use-cases/obs-writer.js";

const seed = {
  models: { test: { model: "test-model", protocol: "openai", contextLimit: 32_000 } },
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

describe("§10.6 — cross-session sequence seed is wired in production", () => {
  it("send() seeds the detector from prior sessions at the boundary", async () => {
    const spy = vi.spyOn(ObsWriter.prototype, "seedSequencesFromPriorSessions");
    try {
      const { api } = await makeCore();
      const created = await api.session.create({ name: "t" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const sent = await api.session.send(created.value.id, { input: "hello" });
      expect(sent.ok).toBe(true);
      expect(spy).toHaveBeenCalledWith(created.value.id, "/ws");
    } finally {
      spy.mockRestore();
    }
  });
});
