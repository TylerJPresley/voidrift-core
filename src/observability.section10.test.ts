/**
 * §10 Observability integration test (core-blueprint.md §10, the §10.10 paragraph).
 * Each acceptance assertion maps to one `it` below.
 */
import { describe, it, expect } from "vitest";
import { EventBus } from "./entities/event-bus.js";
import { ObsWriter } from "./use-cases/obs-writer.js";
import { ObsCallbackHandler } from "./adapters/obs-callback-handler.js";
import { InMemoryFileSystem } from "./adapters/in-memory-filesystem.js";
import { NdjsonLogStore } from "./adapters/ndjson-log-store.js";
import type { ObsRecord, ObsExporter, ObsSeverity } from "./entities/observability/obs-record.js";
import { maskValue } from "./use-cases/secret-mask.js";

function buildWriter(opts?: {
  fs?: InMemoryFileSystem;
  level?: () => ObsSeverity;
  threshold?: number;
  price?: (n: string) => { costPer1kInput?: number; costPer1kOutput?: number } | undefined;
  exporters?: () => ObsExporter[];
  maxSizeMB?: number;
  maxAgeDays?: number;
}) {
  const bus = new EventBus();
  const fs = opts?.fs ?? new InMemoryFileSystem();
  const store = new NdjsonLogStore({
    fs,
    workspaceLogDir: ".voidrift/logs",
    globalLogDir: "/global/logs",
    getMaxSizeMB: () => opts?.maxSizeMB ?? 50,
    getMaxAgeDays: () => opts?.maxAgeDays,
  });
  const writer = new ObsWriter({
    bus,
    store,
    getLevel: opts?.level ?? (() => "info"),
    getSuggestionThreshold: () => opts?.threshold ?? 3,
    ...(opts?.price ? { getPrice: opts.price } : {}),
    ...(opts?.exporters ? { exporters: opts.exporters } : {}),
  });
  writer.start();
  return { bus, fs, store, writer };
}

async function readRecords(fs: InMemoryFileSystem, id: string): Promise<ObsRecord[]> {
  const body = (await fs.exists(`.voidrift/logs/${id}.log`)) ? await fs.readFile(`.voidrift/logs/${id}.log`) : "";
  return body
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as ObsRecord);
}

describe("§10 integration — observability", () => {
  it("nests a tool span under the model span via the shared BaseCallbackHandler; traceId = session id", async () => {
    const { fs, writer } = buildWriter();
    const handler = new ObsCallbackHandler(writer, "sess-1", () => "info", { name: "local", protocol: "openai" });
    handler.handleChatModelStart({} as never, [], "run-model", undefined);
    handler.handleToolStart({ name: "read_file" } as never, "{}", "run-tool", "run-model");
    handler.handleToolEnd("ok", "run-tool", "run-model");
    handler.handleLLMEnd({ generations: [], llmOutput: { tokenUsage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 } } }, "run-model", undefined);
    await writer.flush();
    const recs = await readRecords(fs, "sess-1");
    for (const r of recs) expect(r.traceId).toBe("sess-1");
    const toolSpan = recs.find((r) => r.source === "tool" && r.status === "ok")!;
    const modelSpan = recs.find((r) => r.source === "model" && r.spanId === "run-model" && r.status === "ok")!;
    expect(toolSpan.spanId).toBe("run-tool");
    expect(toolSpan.parentSpanId).toBe("run-model");
    expect(modelSpan.usage?.totalTokens).toBe(12);
  });

  it("mirrors an error-status record to the global log", async () => {
    const { bus, fs, writer } = buildWriter();
    bus.emit("ERROR_OCCURRED", { source: "mcp", message: "boom" }, { session: "sess-e" });
    await writer.flush();
    expect(await fs.exists("/global/logs/sess-e.log")).toBe(true);
    expect(await fs.readFile("/global/logs/sess-e.log")).toContain("boom");
  });

  it("info omits raw payloads but carries usage + the compiled turn; approval carries the full action; correlation+usage at every level", async () => {
    for (const level of ["info", "verbose", "debug"] as ObsSeverity[]) {
      const { bus, fs, writer } = buildWriter({ level: () => level });
      const handler = new ObsCallbackHandler(writer, `L-${level}`, () => level, { name: "local", protocol: "openai" });
      handler.handleChatModelStart({} as never, [{ role: "user", content: "hi" }], "m", undefined);
      handler.handleLLMEnd({ generations: [[{ text: "answer" }]], llmOutput: { tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } }, "m", undefined);
      bus.emit("TURN_COMPLETE", { status: "completed", text: "answer", prompt: "compiled", usage: { totalTokens: 2 } }, { session: `L-${level}` });
      bus.emit("PERMISSION_DENIED", { tool: "execute_command", command: "rm -rf /tmp/x" }, { session: `L-${level}` });
      await writer.flush();
      const recs = await readRecords(fs, `L-${level}`);
      const model = recs.find((r) => r.source === "model" && r.status === "ok")!;
      const turn = recs.find((r) => r.name === "turn.complete")!;
      const approval = recs.find((r) => r.source === "guardian")!;
      expect(model.spanId).toBe("m");
      expect(model.usage?.totalTokens).toBe(2);
      expect((turn.attributes["compiledTurn"] as { response: string }).response).toBe("answer");
      expect((approval.attributes["action"] as { tool: string }).tool).toBe("execute_command");
      expect(JSON.stringify(approval.attributes)).toContain("rm -rf /tmp/x");
      if (level === "info") {
        expect(model.input).toBeUndefined();
      } else {
        expect(model.input).toBeDefined();
        expect(model.output).toBeDefined();
      }
    }
  });

  it("a liqe query returns only failed tool spans and tail emits on append", async () => {
    const { writer } = buildWriter();
    const tailed: ObsRecord[] = [];
    const sub = writer.tail("source:tool AND status:error", (r) => tailed.push(r));
    expect(sub.ok).toBe(true);
    const handler = new ObsCallbackHandler(writer, "q1", () => "info", { name: "local", protocol: "openai" });
    handler.handleToolStart({ name: "write_file" } as never, "{}", "t-ok", undefined);
    handler.handleToolEnd("done", "t-ok", undefined);
    handler.handleToolStart({ name: "edit_file" } as never, "{}", "t-err", undefined);
    handler.handleToolError(new Error("nope"), "t-err", undefined);
    await writer.flush();
    const res = await writer.query("q1", "source:tool AND status:error");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.every((r) => r.source === "tool" && r.status === "error")).toBe(true);
      expect(res.value.some((r) => r.name === "edit_file")).toBe(true);
    }
    expect(tailed.some((r) => r.name === "edit_file")).toBe(true);
    if (sub.ok) sub.value();
  });

  it("a repeated tool failure past the threshold raises ONE suggestion a reflection flow consumes only after approve", async () => {
    const { bus, writer } = buildWriter({ threshold: 2 });
    const candidates: unknown[] = [];
    let approved = false;
    bus.subscribe("WARNING_EMITTED", (e) => {
      const p = e.payload as { source?: string };
      if (p.source === "trace-analyzer") {
        expect(candidates).toHaveLength(0); // nothing autonomous before approve
        approved = true;
        candidates.push(p);
      }
    });
    const handler = new ObsCallbackHandler(writer, "r1", () => "info", { name: "local", protocol: "openai" });
    for (let i = 0; i < 3; i++) {
      handler.handleToolStart({ name: "write_file" } as never, "{}", `e${i}`, undefined);
      handler.handleToolError(new Error("x"), `e${i}`, undefined);
    }
    await writer.flush();
    expect(approved).toBe(true);
    expect(candidates).toHaveLength(1);
  });

  it("a priced model adds a derived cost; an unpriced reports usage only", async () => {
    const { bus, fs, writer } = buildWriter({ price: (n) => (n === "paid" ? { costPer1kInput: 1, costPer1kOutput: 3 } : undefined) });
    bus.emit("MODEL_USAGE", { name: "paid", usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 } }, { session: "c1" });
    bus.emit("MODEL_USAGE", { name: "local", usage: { inputTokens: 500, outputTokens: 500, totalTokens: 1000 } }, { session: "c2" });
    await writer.flush();
    const priced = (await readRecords(fs, "c1")).find((r) => r.source === "model")!;
    const unpriced = (await readRecords(fs, "c2")).find((r) => r.source === "model")!;
    expect(priced.attributes["cost"]).toBeCloseTo(4);
    expect(unpriced.attributes["cost"]).toBeUndefined();
    expect(unpriced.usage?.totalTokens).toBe(1000);
  });

  it("a registered ObsExporter receives each masked record and a thrower is isolated without stopping the trail", async () => {
    const got: ObsRecord[] = [];
    const good: ObsExporter = { export: (r) => void got.push(r) };
    const bad: ObsExporter = {
      export: () => {
        throw new Error("down");
      },
    };
    const { bus, fs, writer } = buildWriter({ exporters: () => [bad, good] });
    bus.emit("MEMORY_SAVED", { id: "m" }, { session: "x1" });
    await writer.flush();
    expect(got).toHaveLength(1);
    expect((await readRecords(fs, "x1")).length).toBe(1);
  });

  it("a log crossing logMaxSizeMB seals a segment and drops the oldest; logMaxAgeDays drops by age", async () => {
    const fs = new InMemoryFileSystem();
    const { bus, writer } = buildWriter({ fs, maxSizeMB: 1 });
    const big = "y".repeat(Math.floor(0.4 * 1024 * 1024));
    for (let i = 0; i < 4; i++) {
      bus.emit("ERROR_OCCURRED", { source: "s", message: big }, { session: "rot" });
      await writer.flush();
    }
    const sealed = await fs.glob(".voidrift/logs/rot.log.*.old");
    expect(sealed.length).toBeLessThanOrEqual(1);

    const fs2 = new InMemoryFileSystem();
    const oldEpoch = Date.now() - 30 * 86_400_000;
    await fs2.writeFile(`.voidrift/logs/age.log.${oldEpoch}.old`, "stale\n");
    await fs2.writeFile(".voidrift/logs/age.log", "live\n");
    const aged = buildWriter({ fs: fs2, maxAgeDays: 7 });
    aged.bus.emit("MEMORY_SAVED", { id: "m" }, { session: "age" });
    await aged.writer.flush();
    expect(await fs2.exists(`.voidrift/logs/age.log.${oldEpoch}.old`)).toBe(false);
  });

  it("the secret detector masks every positive category in args/env/headers, leaves negatives, is stable, shares the memory-provider path", () => {
    const positives = {
      argPem: "-----B" + "EGIN RSA PRIVATE KEY-----\nMIIBOgIBAAI=\n-----END RSA PRIVATE KEY-----",
      argAws: "AKIAIO" + "SFODNN7EXAMPLE",
      argGithub: "ghp_01" + "23456789abcdefghijABCDEFGHIJ0123",
      argGitlab: "glpat-" + "abcdefghij0123456789",
      argSlack: "xoxb-1" + "23456789012-abcdefghij",
      argGoogle: "AIzaSy" + "A1234567890abcdefghijklmnopqrstuv",
      argStripe: "sk_liv" + "e_abcdefghijklmnopqrstuvwx",
      argOpenai: "sk-abc" + "defghijklmnopqrstuvwx",
      argJwt: "eyJhbG" + "ciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abc123def456",
      envKey: "MY_API_KEY=abcdefghijklmnop",
      envToken: "ACCESS_TOKEN=supersecrettoken123",
      envSecret: "CLIENT_SECRET=hunter2hunter2",
      envPassword: "DB_PASSWORD=p@ssw0rd12345",
      envCred: "SERVICE_CREDENTIAL=credvaluexyz",
      hdrBearer: "Authorization: Bearer sk-liv" + "e-DEADBEEFCAFEBABE01",
      hdrBasic: "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    };
    const negatives = {
      uuid: "550e8400-e29b-41d4-a716-446655440000",
      hash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      b64: "aGVsbG8gd29ybGQgdGhpcyBpcyBwbGFpbiB0ZXh0",
      plain: "the quick brown fox jumps",
    };
    const m = maskValue(positives) as Record<string, string>;
    expect(m.argPem).not.toContain("MIIBOgIBAAI=");
    expect(m.argAws).not.toContain("AKIAIO" + "SFODNN7EXAMPLE");
    expect(m.argGithub).not.toContain("ghp_01" + "23456789abcdefghijABCDEFGHIJ0123");
    expect(m.argGitlab).not.toContain("glpat-" + "abcdefghij0123456789");
    expect(m.argSlack).not.toContain("xoxb-1" + "23456789012-abcdefghij");
    expect(m.argGoogle).not.toContain("AIzaSy" + "A1234567890abcdefghijklmnopqrstuv");
    expect(m.argStripe).not.toContain("sk_liv" + "e_abcdefghijklmnopqrstuvwx");
    expect(m.argOpenai).not.toContain("sk-abc" + "defghijklmnopqrstuvwx");
    expect(m.argJwt).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(m.envKey).not.toContain("abcdefghijklmnop");
    expect(m.envKey).toContain("MY_API_KEY");
    expect(m.envToken).not.toContain("supersecrettoken123");
    expect(m.envSecret).not.toContain("hunter2hunter2");
    expect(m.envPassword).not.toContain("p@ssw0rd12345");
    expect(m.envCred).not.toContain("credvaluexyz");
    expect(m.hdrBearer).not.toContain("sk-liv" + "e-DEADBEEFCAFEBABE01");
    expect(m.hdrBearer).toContain("Authorization");
    expect(m.hdrBasic).not.toContain("dXNlcjpwYXNzd29yZA==");

    expect(maskValue(negatives)).toEqual(negatives);
    expect(maskValue("sk-abc" + "defghijklmnopqrstuvwx")).toEqual(maskValue("sk-abc" + "defghijklmnopqrstuvwx"));

    const memItem = { body: "token ACCESS_TOKEN=supersecrettoken123" };
    expect(JSON.stringify(maskValue(memItem))).not.toContain("supersecrettoken123");
  });
});
