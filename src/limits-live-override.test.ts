/**
 * LIVE-override wiring (§13.11, "no hidden limits"): a `limits.<key>` override
 * reaches the real consumer, not just /config + doctor. These keys were formerly
 * read ONLY through the registry DEFAULT (`limitDefault`) — a module constant or
 * default parameter — so an override changed nothing. Each test threads a live
 * value the SAME way boot does (through the limits port / an injected getter) and
 * asserts the computed behaviour changes; the default-branch is asserted
 * byte-identical to the former constant.
 */
import { describe, it, expect } from "vitest";
import {
  effectiveOutputReservation,
  preflightEstimate,
  summaryBudgetTokens,
  DEFAULT_OUTPUT_RESERVATION,
  ESTIMATE_MARGIN_TOKENS,
} from "./entities/context/budget.js";
import { estimateRequestTokens } from "./entities/context/model-guard.js";
import { assembleProjectHead } from "./entities/memory/project-context.js";
import { buildSequenceEvidence, SEQUENCE_EVIDENCE_MAX_ARGS_PER_STEP, type SequenceSignal, type SequenceExampleSpan } from "./entities/memory/suggestion.js";
import { extractReadable, runWebFetch, WEB_FETCH_MIN_EXTRACT, WEB_FETCH_MAX_HOPS, type WebFetchDeps } from "./use-cases/web-fetch.js";
import { LimitsCapability } from "./use-cases/limits-capability.js";
import { resolveLimits } from "./entities/limits-resolve.js";
import { EventBus } from "./entities/event-bus.js";
import type { HttpPort, HttpResponse } from "./entities/ports/http-port.js";
import { limitDefault } from "./entities/limits.js";
import { Plugins } from "./use-cases/plugins.js";
import { RegistryStore } from "./entities/registry/registry-store.js";
import type { PluginRegistryPort } from "./entities/ports/plugin-registry-port.js";

describe("context.* budget limits are live (§13.11)", () => {
  it("context.defaultOutputReservation: an override changes the effective reservation; default byte-identical", () => {
    // Default (no live value) equals the former constant.
    expect(effectiveOutputReservation(null)).toBe(DEFAULT_OUTPUT_RESERVATION);
    expect(effectiveOutputReservation(null)).toBe(limitDefault("context.defaultOutputReservation"));
    // A live override changes the reservation used for budget/guard math.
    expect(effectiveOutputReservation(null, 4096)).toBe(4096);
    // A model-set positive value still wins over the default.
    expect(effectiveOutputReservation(512, 4096)).toBe(512);
  });

  it("context.estimateMarginTokens: an override changes the pre-flight estimate; default byte-identical", () => {
    const parts = { systemText: "a".repeat(400), toolSchemaText: "", chainText: "", newMessage: "" };
    expect(preflightEstimate(parts)).toBe(100 + ESTIMATE_MARGIN_TOKENS);
    expect(preflightEstimate(parts, 9000)).toBe(100 + 9000);
    // The overflow-guard estimate uses the same margin.
    expect(estimateRequestTokens({ systemText: "a".repeat(400), messagesText: "" }, 9000)).toBe(100 + 9000);
    expect(estimateRequestTokens({ systemText: "a".repeat(400), messagesText: "" })).toBe(100 + ESTIMATE_MARGIN_TOKENS);
  });

  it("context.summaryBudgetFloor: an override raises the compaction-summary floor; default byte-identical", () => {
    // Default floor (2000) — a small fold floors at 2000.
    expect(summaryBudgetTokens(1000, 100_000)).toBe(limitDefault("context.summaryBudgetFloor"));
    expect(summaryBudgetTokens(1000, 100_000)).toBe(2000);
    // A higher floor raises the budget (ceiling = max(floor, min(5% window, 12000))).
    expect(summaryBudgetTokens(1000, 100_000, 6000)).toBe(6000);
  });
});

describe("sequence.evidenceExamplesPerStep is live (§10.6, §13.11)", () => {
  function signal(): SequenceSignal {
    return { pattern: "write_file → write_file", steps: ["write_file({path})", "write_file({path})"], count: 3, split: { within: 3, across: 0 }, outcome: "success", sessionIds: ["s"] };
  }
  function spans(n: number): SequenceExampleSpan[] {
    return Array.from({ length: n }, (_, i) => ({ source: "tool", name: "write_file", status: "ok", argSummary: `{"path":"f${i}"}` }));
  }

  it("default caps arg examples per step at the registry default", () => {
    const ev = buildSequenceEvidence(signal(), spans(6), 100_000);
    expect(SEQUENCE_EVIDENCE_MAX_ARGS_PER_STEP).toBe(limitDefault("sequence.evidenceExamplesPerStep"));
    expect(ev.stepArgExamples[0]!.length).toBe(SEQUENCE_EVIDENCE_MAX_ARGS_PER_STEP); // 3
  });

  it("a live override changes how many arg examples per step are collected", () => {
    const ev = buildSequenceEvidence(signal(), spans(6), 100_000, 1);
    expect(ev.stepArgExamples[0]!.length).toBe(1);
    const ev5 = buildSequenceEvidence(signal(), spans(6), 100_000, 5);
    expect(ev5.stepArgExamples[0]!.length).toBe(5);
  });
});

describe("project head digest default is unchanged (§4.8/§8.7)", () => {
  it("assembleProjectHead first-turn marked head is budget-bound (byte-identical default)", () => {
    const files = [{ path: "AGENTS.md", content: "x".repeat(500), depth: 0, scope: "workspace" as const }];
    const ctx = assembleProjectHead(files, 100);
    expect(ctx.overflow).toBe(true);
    // The head is bound by the budget (100), NOT shrunk by the digest default —
    // memory.projectDigestMaxChars is 'default only' (noLiveOverride): the real
    // head digest is the §8.7 ingest digest, so the former behaviour is kept.
    expect(ctx.digest.length).toBeGreaterThan(100);
    expect(ctx.digest).toContain("x");
  });
});

describe("tools.webFetch* limits are live (§8.2, §13.11)", () => {
  it("tools.webFetchMinExtract: an override changes the readability fallback threshold; default byte-identical", () => {
    expect(WEB_FETCH_MIN_EXTRACT).toBe(limitDefault("tools.webFetchMinExtract"));
    // HTML whose tag-stripped form (nav + article) is LONGER than whatever the
    // readability parse yields. A threshold of 0 never forces the fallback; a
    // huge threshold always does — so the two paths MUST differ in length,
    // proving the live `minExtract` value selects the path.
    const html =
      "<html><head><title>t</title></head><body>" +
      "<nav>home about contact products services blog careers press legal privacy</nav>" +
      "<article><p>main</p></article>" +
      "<footer>copyright all rights reserved worldwide forever and ever amen</footer>" +
      "</body></html>";
    const noFallback = extractReadable(html, "http://x", 0); // threshold 0 → keep parsed
    const forceFallback = extractReadable(html, "http://x", 1_000_000); // → tag-stripper
    // The tag-stripper keeps the nav/footer text the readability parse drops.
    expect(forceFallback).toContain("privacy");
    expect(forceFallback.length).toBeGreaterThan(noFallback.length);
  });

  it("tools.webFetchMaxHops: a lowered override refuses after fewer redirects", async () => {
    // A fake HttpPort that redirects forever.
    const http: HttpPort = {
      async resolve() {
        return [{ address: "93.184.216.34", family: 4 }];
      },
      async fetchOnce(): Promise<HttpResponse> {
        return {
          status: 302,
          location: "https://example.com/next",
          contentType: "text/html",
          readBodyCapped: async () => ({ bytes: new Uint8Array(), truncated: false }),
        };
      },
    };
    const bus = new EventBus();
    const limits = new LimitsCapability(resolveLimits([{ layer: "project", limits: { tools: { webFetchMaxHops: 1 } } }]), bus);
    const base: WebFetchDeps = {
      http,
      timeoutMs: 1000,
      writeCache: async () => "/cache/x.md",
      mask: (t) => t,
      allowHost: () => true,
      limits,
    };
    const res = await runWebFetch("https://example.com/", base);
    expect(res.status).toBe("error");
    // The lowered cap (1) is named in the message, proving the override is live
    // (the default is 5 — WEB_FETCH_MAX_HOPS).
    expect(res.content).toContain("too many redirects (> 1)");
    expect(WEB_FETCH_MAX_HOPS).toBe(limitDefault("tools.webFetchMaxHops"));
  });
});

describe("plugins.listPageDefault is live (§12.4.1, §13.11)", () => {
  function makePlugins(getLimit?: (k: string) => number) {
    const bus = new EventBus();
    const urls: string[] = [];
    const registryClient: PluginRegistryPort = {
      async get(url) {
        urls.push(url);
        return { status: 200, body: JSON.stringify({ objects: [] }), tooLarge: false, errored: false };
      },
    };
    const plugins = new Plugins({
      bus,
      loader: { resolve: () => null, licenseScan: () => ({ ok: true }), importRegister: async () => () => {}, scanCandidates: () => [] } as never,
      services: {} as never,
      registryStore: new RegistryStore(),
      getPlugins: () => ({}),
      setPlugins: async (n) => ({ ok: true as const, value: n }),
      ...(getLimit ? { getLimit } : {}),
      discovery: {
        registryClient,
        installer: { install: async () => ({ ok: false }), rollback: async () => {} },
        getRegistryUrl: () => "https://registry.npmjs.org",
        hostCoreVersion: "0.0.0",
        installDirFor: () => "/tmp/x",
        gate: async () => ({ decision: "allow" as const }),
        networkTimeoutMs: 1000,
        searchMaxBytes: 1_000_000,
        installTimeoutMs: 1000,
        installMaxBytes: 1_000_000,
      },
    });
    return { plugins, urls };
  }

  it("uses the registry default page size when no override is wired", async () => {
    const { plugins, urls } = makePlugins();
    await plugins.search("x");
    expect(urls[0]).toContain(`&size=${limitDefault("plugins.listPageDefault")}`); // 20
  });

  it("a live getLimit override changes the search page size", async () => {
    const { plugins, urls } = makePlugins((k) => (k === "plugins.listPageDefault" ? 7 : limitDefault(k)));
    await plugins.search("x");
    expect(urls[0]).toContain("&size=7");
  });
});

