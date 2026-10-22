import { describe, it, expect } from "vitest";
import {
  defaultChatModelFactory,
  networkClientOptions,
  type NetworkSettings,
} from "./model-provider.js";
import type { ResolvedModel } from "../entities/ports/model-port.js";

/**
 * §11 integration paragraph / §11.5: the network boundary applies
 * `networkModelTimeout` and `networkModelMaxRetries` UNIFORMLY to every bundled
 * provider — OpenAI, Anthropic and Google alike — and the provider SDK's own
 * internal retry is DISABLED (`maxRetries: 0`) because VoidRift owns the retry
 * loop at the engine seam (§3.6, §11.9). The uniform options come from one
 * shared helper so no provider can diverge; these tests pin that invariant.
 */
describe("uniform network options across bundled providers (§11, §11.5)", () => {
  it("builds one identical options object regardless of provider — timeout set, SDK retry pinned to 0", () => {
    const net: NetworkSettings = { timeout: 120_000, maxRetries: 3 };
    const opts = networkClientOptions(net);
    // The SDK retry is always 0 (engine owns the retry loop); the per-request
    // timeout is the configured value, and the budget (3) is NOT leaked onto the
    // client — it lives in the engine middleware.
    expect(opts).toEqual({ maxRetries: 0, timeout: 120_000 });
  });

  it("still pins maxRetries to 0 with no timeout supplied (test seam / absent config)", () => {
    expect(networkClientOptions()).toEqual({ maxRetries: 0 });
    expect(networkClientOptions({ timeout: 55_000, maxRetries: 9 })).toEqual({
      maxRetries: 0,
      timeout: 55_000,
    });
  });

  it("the SAME options reach OpenAI, Anthropic and Google (openai exposes `timeout`), and all three build", () => {
    const net: NetworkSettings = { timeout: 120_000, maxRetries: 3 };
    for (const p of ["openai", "anthropic", "google"] as const) {
      const resolved: ResolvedModel = {
        name: p,
        model: "m",
        protocol: p,
        contextLimit: 8000,
        vision: false,
      };
      const client = defaultChatModelFactory(resolved, { model: "m", protocol: p }, net);
      expect(client).toBeDefined();
    }
    // ChatOpenAI surfaces the per-request timeout as an own field; use it as the
    // observable witness that the uniform timeout actually reached the client.
    const openai = defaultChatModelFactory(
      { name: "openai", model: "m", protocol: "openai", contextLimit: 8000, vision: false },
      { model: "m", protocol: "openai" },
      net,
    ) as unknown as Record<string, unknown>;
    expect(openai["timeout"]).toBe(120_000);
  });
});
