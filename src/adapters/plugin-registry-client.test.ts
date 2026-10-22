import { describe, it, expect, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { PluginRegistryClient } from "./plugin-registry-client.js";

const OPTS = { timeoutMs: 2000, maxBytes: 1_000_000 };

describe("PluginRegistryClient redirect pinning (L1)", () => {
  const original = getGlobalDispatcher();
  afterEach(() => setGlobalDispatcher(original));

  it("follows a same-origin redirect and returns the final body", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    const pool = agent.get("https://registry.example");
    pool
      .intercept({ path: "/pkg" })
      .reply(302, "", { headers: { location: "https://registry.example/pkg/final" } });
    pool.intercept({ path: "/pkg/final" }).reply(200, '{"ok":true}');

    const client = new PluginRegistryClient();
    const res = await client.get("https://registry.example/pkg", OPTS);
    expect(res.errored).toBe(false);
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"ok":true}');
  });

  it("refuses a cross-origin redirect (errored, no body)", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    const pool = agent.get("https://registry.example");
    pool
      .intercept({ path: "/pkg" })
      .reply(302, "", { headers: { location: "https://evil.example/pkg" } });

    const client = new PluginRegistryClient();
    const res = await client.get("https://registry.example/pkg", OPTS);
    expect(res.errored).toBe(true);
    expect(res.body).toBe("");
  });

  it("returns a 2xx body with no redirect", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    agent.get("https://registry.example").intercept({ path: "/plain" }).reply(200, "hello");

    const client = new PluginRegistryClient();
    const res = await client.get("https://registry.example/plain", OPTS);
    expect(res.status).toBe(200);
    expect(res.body).toBe("hello");
  });
});
