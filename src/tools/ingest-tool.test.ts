/**
 * The `ingest` model tool (core-blueprint.md §8.7): strict schema, exactly one
 * of path/url, returns the whole text or the rendered digest, surfaces a read
 * error as a typed tool error.
 */
import { describe, it, expect } from "vitest";
import { ToolMessage } from "@langchain/core/messages";
import { buildIngestTool, INGEST_FORM_ERROR, INGEST_TOOL_NAME } from "./ingest-tool.js";
import { Ingest } from "../use-cases/ingest.js";
import { InMemoryIngestCache } from "../adapters/ingest-cache.js";
import { BUILTIN_CHUNKERS } from "../entities/chunker.js";
import { limitDefault } from "../entities/limits.js";
import type { LimitsPort } from "../entities/ports/limits-port.js";

function fakeLimits(): LimitsPort {
  return { get: (k) => limitDefault(k), hit: () => ({ notice: "", first: false }), resetTurn: () => undefined };
}

function makeIngest(text: string, onRead?: () => Promise<never>): Ingest {
  return new Ingest({
    workspaceRoot: "/ws",
    limits: fakeLimits(),
    cache: new InMemoryIngestCache(),
    chunkers: () => [...BUILTIN_CHUNKERS],
    readSource: onRead ? (onRead as never) : async () => ({ text, source: "f.md" }),
    dispatchSummarize: async (reqs) => ({
      fanoutId: "f",
      workers: reqs.map((r) => ({ workerId: `w-${r.id}`, agent: r.agent, status: "merged" as const, summary: "S", pendingApproval: false, ...(r.id ? { taskId: r.id } : {}) })),
    }),
  });
}

async function call(toolObj: ReturnType<typeof buildIngestTool>, args: unknown): Promise<ToolMessage> {
  return (await toolObj.invoke({ name: INGEST_TOOL_NAME, args, id: "c1", type: "tool_call" } as never)) as ToolMessage;
}

describe("ingest model tool (§8.7)", () => {
  it("returns the whole text for a small source", async () => {
    const t = buildIngestTool({ ingest: makeIngest("# tiny\nhi\n"), availableTokens: () => 5000 });
    const msg = await call(t, { path: "f.md", purpose: "p" });
    expect(msg.status).toBe("success");
    expect(String(msg.content)).toContain("hi");
  });

  it("returns a rendered digest for a large source", async () => {
    const big = "# S\n" + "x".repeat(60000) + "\n";
    const t = buildIngestTool({ ingest: makeIngest(big), availableTokens: () => 5000 });
    const msg = await call(t, { path: "f.md", purpose: "p" });
    expect(msg.status).toBe("success");
    expect(String(msg.content)).toContain("Read exact lines with read_file");
  });

  it("rejects neither path nor url", async () => {
    const t = buildIngestTool({ ingest: makeIngest("x"), availableTokens: () => 5000 });
    const msg = await call(t, { purpose: "p" });
    expect(msg.status).toBe("error");
    expect(String(msg.content)).toBe(INGEST_FORM_ERROR);
  });

  it("rejects both path and url", async () => {
    const t = buildIngestTool({ ingest: makeIngest("x"), availableTokens: () => 5000 });
    const msg = await call(t, { path: "f.md", url: "http://x", purpose: "p" });
    expect(msg.status).toBe("error");
    expect(String(msg.content)).toBe(INGEST_FORM_ERROR);
  });

  it("rejects a missing purpose at the schema boundary", async () => {
    const t = buildIngestTool({ ingest: makeIngest("x"), availableTokens: () => 5000 });
    // `purpose` is required by the strict schema; LangChain rejects it upstream.
    await expect(call(t, { path: "f.md" })).rejects.toThrow(/schema|purpose/i);
  });

  it("refuses an IDENTICAL second ingest (same source AND purpose) within one turn", async () => {
    // §8.7 — a per-turn guard: an identical re-call (same source + same purpose)
    // is wasteful and refused; the earlier result already carries the digest.
    const ingest = makeIngest("# tiny\nhi\n", undefined);
    const t = buildIngestTool({ ingest, availableTokens: () => 5000 });
    const first = await call(t, { path: "f.md", purpose: "p" });
    expect(first.status).toBe("success");
    const second = await call(t, { path: "f.md", purpose: "p" });
    expect(second.status).toBe("error");
    expect(String(second.content)).toMatch(/already ingested this turn/);
    expect(String(second.content)).toMatch(/narrower purpose/);
  });

  it("allows the same source with a NEW purpose within one turn (cache is keyed by purpose)", async () => {
    const ingest = makeIngest("# tiny\nhi\n", undefined);
    const t = buildIngestTool({ ingest, availableTokens: () => 5000 });
    expect((await call(t, { path: "f.md", purpose: "p" })).status).toBe("success");
    expect((await call(t, { path: "f.md", purpose: "a different purpose" })).status).toBe("success");
  });

  it("surfaces a read error (PATH_ESCAPE) as a typed tool error", async () => {
    // A containment failure in readSource is never swallowed: it surfaces as a
    // typed error ToolMessage, not a fabricated digest.
    const ingest = makeIngest("x", async () => {
      throw new Error("PATH_ESCAPE: '../x' escapes the workspace");
    });
    const t = buildIngestTool({ ingest, availableTokens: () => 5000 });
    const msg = await call(t, { path: "../x", purpose: "p" });
    expect(msg.status).toBe("error");
    expect(String(msg.content)).toMatch(/ingest failed/);
    expect(String(msg.content)).toMatch(/PATH_ESCAPE/);
  });

  it("allows re-ingesting the same source in a NEW turn (a fresh tool instance)", async () => {
    const mk = () => buildIngestTool({ ingest: makeIngest("# tiny\nhi\n"), availableTokens: () => 5000 });
    expect((await call(mk(), { path: "f.md", purpose: "p" })).status).toBe("success");
    // A new turn builds a new tool: the guard is per-instance, so this succeeds.
    expect((await call(mk(), { path: "f.md", purpose: "p" })).status).toBe("success");
  });
});
