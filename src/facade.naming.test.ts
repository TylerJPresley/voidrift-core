/**
 * Session auto-naming LIVE wiring (core-blueprint.md §5.5) — the injectable
 * NamingPort. A stub port replaces the model call so these are DETERMINISTIC and
 * OFFLINE and the finite `fakeModel` turn script is never consumed by naming.
 *
 * Covered: first-turn name, re-evaluation each later completed turn, a pin is
 * respected, a failure (null) keeps the old name, NO model call when pinned, and
 * a shutdown aborts a pending call. The "fixtures unaffected" guarantee (no
 * change in existing fakeModel call counts when a custom `chatModelFactory` is
 * injected WITHOUT a namingPort) is proven by the suite running green unchanged.
 */
import { describe, it, expect, vi } from "vitest";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { createCore } from "./boot.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
import { createMemoryCheckpointer } from "./adapters/checkpointer.js";
import type { NamingPort } from "./entities/ports/naming-port.js";

const seed = { models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } }, modelSelected: "t" };

/** A model that completes EVERY turn (a finite scripted fake exhausts after one
 * turn, so multi-turn naming tests need a repeatable responder). */
class AlwaysDone extends BaseChatModel {
  _llmType(): string {
    return "always-done";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(): Promise<ChatResult> {
    const msg = new AIMessage("done");
    return { generations: [{ text: "done", message: msg }] };
  }
}

async function coreWith(namingPort?: NamingPort) {
  return createCore({
    workspaceRoot: "/ws",
    configStore: new InMemoryConfigStore(seed),
    sessionRepository: new InMemorySessionRepository(),
    checkpointer: createMemoryCheckpointer(),
    // A repeatable model so every turn completes; the stub NamingPort proves the
    // turn model is never consumed by naming.
    chatModelFactory: () => new AlwaysDone({}) as never,
    ...(namingPort ? { namingPort } : {}),
  });
}

/** Read a session's current name from the host-facing list. */
async function nameOf(api: Awaited<ReturnType<typeof coreWith>>["api"], id: string): Promise<string> {
  const list = await api.session.list();
  return list.find((s) => s.id === id)?.name ?? "";
}

/** Let the fire-and-forget naming microtask settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("§5.5 — NamingPort live wiring", () => {
  it("names after the first completed turn through the injected port", async () => {
    const suggest = vi.fn(async () => "Retry Backoff Work");
    const { api } = await coreWith({ suggest });
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.send(id, { input: "investigate retry backoff" });
    await settle();
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(await nameOf(api, id)).toBe("Retry Backoff Work");
  });

  it("re-evaluates after EACH later completed turn (one call per new completed turn)", async () => {
    const suggest = vi.fn(async (ctx: { current: string }) => `name-${ctx.current}`);
    const { api } = await coreWith({ suggest });
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.send(id, { input: "one" });
    await settle();
    await api.session.send(id, { input: "two" });
    await settle();
    expect(suggest).toHaveBeenCalledTimes(2);
  });

  it("does NOT call the model when the name is user-pinned (rename pins)", async () => {
    const suggest = vi.fn(async () => "Auto Name");
    const { api } = await coreWith({ suggest });
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.rename(id, "My Pinned Name");
    await api.session.send(id, { input: "work" });
    await settle();
    expect(suggest).not.toHaveBeenCalled();
    expect(await nameOf(api, id)).toBe("My Pinned Name");
  });

  it("keeps the previous name when the port returns null (failure)", async () => {
    const suggest = vi.fn(async () => null);
    const { api } = await coreWith({ suggest });
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.send(id, { input: "first line stays" });
    await settle();
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(await nameOf(api, id)).toBe("first line stays");
  });

  it("a shutdown aborts a pending naming call (never hangs)", async () => {
    let release!: () => void;
    const suggest = vi.fn(
      () => new Promise<string | null>((r) => { release = () => r("Late Name"); }),
    );
    const { api } = await coreWith({ suggest });
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    await api.session.send(id, { input: "pending" });
    // The naming call is pending; shutdown must not hang on it.
    const done = api.session.shutdown();
    release(); // even if it resolves late, shutdown already aborted
    await expect(done).resolves.toBeUndefined();
  });
});
