/**
 * ObsWriter unit tests (core-blueprint.md §10.1–10.8, §10.10).
 */
import { describe, it, expect } from "vitest";
import { EventBus } from "../entities/event-bus.js";
import { ObsWriter, maskRecord } from "./obs-writer.js";
import type { ObsLogStore } from "../entities/ports/obs-log-store.js";
import type { ObsRecord, ObsExporter } from "../entities/observability/obs-record.js";

function memStore(): ObsLogStore & { ws: Map<string, string[]>; gl: Map<string, string[]> } {
  const ws = new Map<string, string[]>();
  const gl = new Map<string, string[]>();
  return {
    ws,
    gl,
    async appendWorkspace(id, line) {
      (ws.get(id) ?? ws.set(id, []).get(id)!).push(line);
    },
    async appendGlobal(id, line) {
      (gl.get(id) ?? gl.set(id, []).get(id)!).push(line);
    },
    async readWorkspace(id) {
      return [...(ws.get(id) ?? [])].reverse();
    },
  };
}

function makeWriter(opts?: {
  exporters?: () => ObsExporter[];
  price?: (n: string) => { costPer1kInput?: number; costPer1kOutput?: number } | undefined;
  threshold?: number;
  sequenceMaxLen?: number;
  statsRecordCap?: number;
  sequencePriorSessions?: number;
  sequenceQueueCap?: number;
  sessions?: import("../entities/ports/session-repository.js").SessionRepository;
  onSequenceSignal?: (signal: unknown, examples: ObsRecord[]) => void;
  onFailureSignal?: (signal: { pattern: string; count: number; errorClass: string }, examples: ObsRecord[]) => void;
}) {
  const bus = new EventBus();
  const store = memStore();
  const writer = new ObsWriter({
    bus,
    store,
    getLevel: () => "info",
    getSuggestionThreshold: () => opts?.threshold ?? 3,
    getSequenceMaxLen: () => opts?.sequenceMaxLen ?? 6,
    ...(opts?.statsRecordCap !== undefined ? { getStatsRecordCap: () => opts.statsRecordCap! } : {}),
    ...(opts?.sequencePriorSessions !== undefined ? { getSequencePriorSessions: () => opts.sequencePriorSessions! } : {}),
    ...(opts?.sequenceQueueCap !== undefined ? { getSequenceQueueCap: () => opts.sequenceQueueCap! } : {}),
    ...(opts?.sessions ? { sessions: opts.sessions } : {}),
    ...(opts?.onSequenceSignal
      ? { onSequenceSignal: opts.onSequenceSignal as (s: import("../entities/observability/sequence-detector.js").SequencePattern, e: ObsRecord[]) => void }
      : {}),
    ...(opts?.onFailureSignal ? { onFailureSignal: opts.onFailureSignal } : {}),
    ...(opts?.price ? { getPrice: opts.price } : {}),
    ...(opts?.exporters ? { exporters: opts.exporters } : {}),
  });
  writer.start();
  return { bus, store, writer };
}

describe("§10 — ObsWriter", () => {
  it("writes an event-sourced span with traceId = session id", async () => {
    const { bus, store, writer } = makeWriter();
    bus.emit("MEMORY_SAVED", { id: "m1" }, { session: "s1" });
    await writer.flush();
    const lines = store.ws.get("s1") ?? [];
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!) as ObsRecord;
    expect(rec.traceId).toBe("s1");
    expect(rec.source).toBe("memory");
  });

  it("writes a SESSION_MODE_CHANGED audit record with {from,to} (§2.7, §14.6)", async () => {
    const { bus, store, writer } = makeWriter();
    bus.emit("SESSION_MODE_CHANGED", { from: "chat", to: "vibe" }, { session: "s1" });
    await writer.flush();
    const lines = store.ws.get("s1") ?? [];
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!) as ObsRecord;
    expect(rec.source).toBe("session");
    expect(rec.name).toBe("session.mode_changed");
    expect((rec.attributes as { from: string; to: string }).from).toBe("chat");
    expect((rec.attributes as { from: string; to: string }).to).toBe("vibe");
  });

  it("mirrors an error record to the global log", async () => {
    const { bus, store, writer } = makeWriter();
    bus.emit("ERROR_OCCURRED", { source: "engine", message: "x" }, { session: "s1" });
    await writer.flush();
    expect((store.ws.get("s1") ?? []).length).toBe(1);
    expect((store.gl.get("s1") ?? []).length).toBe(1);
  });

  it("masks a secret in the attribute bag before it persists (§10.10)", async () => {
    const { bus, store, writer } = makeWriter();
    bus.emit(
      "PERMISSION_DENIED",
      { tool: "execute_command", command: "curl -H 'Authorization: Bearer sk-liv" + "e-DEADBEEFCAFEBABE01'" },
      { session: "s1" },
    );
    await writer.flush();
    const body = (store.ws.get("s1") ?? []).join("");
    expect(body).not.toContain("sk-liv" + "e-DEADBEEFCAFEBABE01");
    expect(body).toContain("execute_command");
  });

  it("a PERMISSION_DENIED row shows the masked target instead of args: null (§9.5, §14.6)", async () => {
    const { bus, store, writer } = makeWriter();
    bus.emit(
      "PERMISSION_DENIED",
      { tool: "execute_command", reason: "blocked: …", target: "shutdown now" },
      { session: "s1" },
    );
    await writer.flush();
    const rec = JSON.parse((store.ws.get("s1") ?? [])[0]!) as ObsRecord;
    const attrs = rec.attributes as { target?: unknown; action?: { args?: unknown } };
    expect(attrs.target).toBe("shutdown now");
    // The action.args no longer defaults to null when a target is known.
    expect(attrs.action?.args).toEqual({ target: "shutdown now" });
  });

  it("a registered exporter receives each masked record; a thrower is isolated and the trail still writes (§10.8)", async () => {
    const received: ObsRecord[] = [];
    const good: ObsExporter = { export: (r) => void received.push(r) };
    const bad: ObsExporter = {
      export: () => {
        throw new Error("exporter down");
      },
    };
    const errors: string[] = [];
    const bus = new EventBus();
    const store = memStore();
    const writer = new ObsWriter({
      bus,
      store,
      getLevel: () => "info",
      getSuggestionThreshold: () => 3,
      exporters: () => [bad, good],
      onError: (m) => errors.push(m),
    });
    writer.start();
    // A record carrying a secret: the exporter must receive it MASKED (§10.10).
    bus.emit(
      "PERMISSION_DENIED",
      { tool: "execute_command", command: "curl -H 'Authorization: Bearer sk-liv" + "e-DEADBEEFCAFEBABE01'" },
      { session: "s1" },
    );
    await writer.flush();
    expect(received).toHaveLength(1);
    expect(JSON.stringify(received[0])).not.toContain("sk-liv" + "e-DEADBEEFCAFEBABE01");
    // The thrower is isolated — the local trail is written regardless.
    expect((store.ws.get("s1") ?? []).length).toBe(1);
    expect(errors.join("")).toContain("exporter threw");
  });

  it("flush drains each exporter's flush() on shutdown (§10.8)", async () => {
    let flushed = 0;
    const exp: ObsExporter = { export: () => undefined, flush: async () => void (flushed += 1) };
    const { bus, writer } = makeWriter({ exporters: () => [exp] });
    bus.emit("MEMORY_SAVED", { id: "m1" }, { session: "s1" });
    await writer.flush();
    expect(flushed).toBe(1);
  });

  it("raises ONE trace-analyzer suggestion past the threshold", async () => {
    const { bus, writer } = makeWriter({ threshold: 2 });
    const suggestions: unknown[] = [];
    bus.subscribe("WARNING_EMITTED", (e) => suggestions.push(e.payload));
    for (let i = 0; i < 3; i++) {
      writer.writeFromCallback({ traceId: "s1", spanId: `t${i}`, source: "tool", name: "write_file", status: "error" });
    }
    await writer.flush();
    const hits = suggestions.filter((s) => (s as { source?: string }).source === "trace-analyzer");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ category: "suggestion", pattern: "tool_error:write_file" });
  });

  it("queues a repeated-failure candidate and drains it to onFailureSignal (§6.7/§10.6)", async () => {
    const seen: { pattern: string; count: number; errorClass: string }[] = [];
    const { writer } = makeWriter({ threshold: 2, onFailureSignal: (s) => seen.push(s) });
    for (let i = 0; i < 3; i++) {
      writer.writeFromCallback({ traceId: "s1", spanId: `t${i}`, source: "tool", name: "write_file", status: "error", attributes: { errorClass: "ENOENT" } });
    }
    await writer.flush();
    // Recorded but NOT drafted until the session is idle/boundary (§6.7).
    expect(seen).toHaveLength(0);
    await writer.drainSequenceCandidates("s1");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ pattern: "tool_error:write_file", count: 2, errorClass: "ENOENT" });
  });

  it("adds a derived cost for a priced model, usage-only when unpriced", async () => {
    const priced = makeWriter({ price: (n) => (n === "paid" ? { costPer1kInput: 1, costPer1kOutput: 2 } : undefined) });
    priced.bus.emit("MODEL_USAGE", { name: "paid", usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 } }, { session: "s1" });
    await priced.writer.flush();
    const paidRec = JSON.parse((priced.store.ws.get("s1") ?? [])[0]!) as ObsRecord;
    expect(paidRec.attributes["cost"]).toBeCloseTo(3);
    expect(paidRec.usage?.totalTokens).toBe(2000);
    expect(priced.writer.statsFor("s1").cost).toBeCloseTo(3);

    const free = makeWriter();
    free.bus.emit("MODEL_USAGE", { name: "local", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }, { session: "s2" });
    await free.writer.flush();
    const freeRec = JSON.parse((free.store.ws.get("s2") ?? [])[0]!) as ObsRecord;
    expect(freeRec.attributes["cost"]).toBeUndefined();
    expect(freeRec.usage?.totalTokens).toBe(15);
  });

  it("tail emits each new record matching the filter", async () => {
    const { bus, writer } = makeWriter();
    const seen: ObsRecord[] = [];
    const sub = writer.tail("source:memory", (r) => seen.push(r));
    expect(sub.ok).toBe(true);
    bus.emit("MEMORY_SAVED", { id: "m1" }, { session: "s1" });
    bus.emit("SKILL_LOADED", { name: "k" }, { session: "s1" });
    await writer.flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.source).toBe("memory");
    if (sub.ok) sub.value();
  });

  it("tail returns INVALID_QUERY for a bad filter", () => {
    const { writer } = makeWriter();
    const sub = writer.tail("status:>>bad::", () => undefined);
    expect(sub.ok).toBe(false);
  });

  it("STAT1: stats.recordCap bounds the per-session evidence ring (default 4096; a tiny cap drops older records from the live report)", async () => {
    // Default: both records are retained (cap is 4096).
    const full = makeWriter();
    full.bus.emit("MODEL_USAGE", { name: "m", usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 } }, { session: "s1" });
    full.bus.emit("MODEL_USAGE", { name: "m", usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100 } }, { session: "s1" });
    const fullReport = await full.writer.statsReportFor("s1");
    expect(fullReport.totals.tokensTotal).toBe(110);

    // Override: a cap of 1 keeps only the LAST record (the ring shifts the first).
    const capped = makeWriter({ statsRecordCap: 1 });
    capped.bus.emit("MODEL_USAGE", { name: "m", usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 } }, { session: "s1" });
    capped.bus.emit("MODEL_USAGE", { name: "m", usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100 } }, { session: "s1" });
    const cappedReport = await capped.writer.statsReportFor("s1");
    expect(cappedReport.totals.tokensTotal).toBe(100);
  });

  it("maskRecord preserves correlation ids and usage", () => {
    const rec: ObsRecord = {
      traceId: "s1",
      spanId: "sp",
      timestamp: "t",
      status: "ok",
      source: "model",
      name: "model.usage",
      severity: "info",
      attributes: { token: "API_TOKEN=supersecret" },
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    };
    const masked = maskRecord(rec);
    expect(masked.traceId).toBe("s1");
    expect(masked.spanId).toBe("sp");
    expect(masked.usage).toEqual(rec.usage);
    expect(JSON.stringify(masked.attributes)).not.toContain("supersecret");
  });

  it("maps the remaining event sources (tool/skill/worker/compliance) to records", async () => {
    const { bus, store, writer } = makeWriter();
    bus.emit("TOOL_STARTED", { name: "write_file" }, { session: "s1" });
    bus.emit("SKILL_LOADED", { name: "deploy" }, { session: "s1" });
    bus.emit("WORKER_STATUS_CHANGED", { workerId: "w1", status: "running" }, { session: "s1" });
    bus.emit("COMPLIANCE_VIOLATION", { action: "write_file", args: { path: "x" } }, { session: "s1" });
    bus.emit("COMPLIANCE_BLOCKED", { action: "execute_command", args: { command: "rm" } }, { session: "s1" });
    await writer.flush();
    const sources = (store.ws.get("s1") ?? []).map((l) => JSON.parse(l) as ObsRecord).map((r) => `${r.source}/${r.status}`);
    // TOOL_STARTED now persists a pending tool START span (§10.3) AND increments
    // stats; the other four write one each.
    expect(sources).toEqual(expect.arrayContaining(["tool/pending", "skill/ok", "worker/ok", "warden/ok", "warden/error"]));
    expect(writer.statsFor("s1").toolCalls.perTool["write_file"]).toBe(1);
  });

  it("an unscoped event writes no record", async () => {
    const { bus, store, writer } = makeWriter();
    bus.emit("MEMORY_SAVED", { id: "m" }, {}); // no session scope → no trace
    await writer.flush();
    expect([...store.ws.values()].flat()).toHaveLength(0);
  });

  it("a store failure is swallowed and reported out of band, never thrown", async () => {
    const bus = new EventBus();
    const errors: string[] = [];
    const failing: ObsLogStore = {
      appendWorkspace: async () => {
        throw new Error("disk full");
      },
      appendGlobal: async () => undefined,
      readWorkspace: async () => [],
    };
    const writer = new ObsWriter({
      bus,
      store: failing,
      getLevel: () => "info",
      getSuggestionThreshold: () => 3,
      onError: (m) => errors.push(m),
    });
    writer.start();
    bus.emit("MEMORY_SAVED", { id: "m" }, { session: "s1" });
    await expect(writer.flush()).resolves.toBeUndefined();
    // The write failure is swallowed (§10.3); nothing throws across flush.
  });

  it("close()/dispose() release handles and are idempotent", async () => {
    const { bus, store, writer } = makeWriter();
    bus.emit("MEMORY_SAVED", { id: "m" }, { session: "s1" });
    await writer.close();
    await writer.dispose(); // idempotent second call
    // After close the bus subscription is detached: a later emit writes nothing.
    bus.emit("MEMORY_SAVED", { id: "m2" }, { session: "s1" });
    await new Promise((r) => setTimeout(r, 0));
    expect((store.ws.get("s1") ?? []).length).toBe(1);
  });

  it("query returns INVALID_QUERY for a bad filter and reads back records", async () => {
    const { bus, writer } = makeWriter();
    bus.emit("MEMORY_SAVED", { id: "m" }, { session: "s1" });
    await writer.flush();
    const good = await writer.query("s1");
    expect(good.ok).toBe(true);
    const bad = await writer.query("s1", "status:>>oops::");
    expect(bad.ok).toBe(false);
  });
});

/**
 * §10.3/§14.3 — close() reaches quiescence and forbids writes after close.
 * These fail on the pre-fix one-shot `flush()` snapshot and the silent
 * post-stop() drop.
 */
describe("§10.3/§14.3 — ObsWriter close drains to quiescence", () => {
  /** A store whose appendWorkspace parks on a gate until released, so a write
   * can be held mid-flight across a close() call. */
  function gatedStore(): ObsLogStore & { ws: Map<string, string[]>; release: () => void; writtenAfter: () => boolean } {
    const ws = new Map<string, string[]>();
    let open: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let released = false;
    let closeResolvedAt: number | undefined;
    let lastWriteAt = 0;
    const store = {
      ws,
      async appendWorkspace(id: string, line: string) {
        await gate;
        lastWriteAt = Date.now();
        (ws.get(id) ?? ws.set(id, []).get(id)!).push(line);
      },
      async appendGlobal() {},
      async readWorkspace() {
        return [];
      },
      release: () => {
        released = true;
        open();
      },
      writtenAfter: () => closeResolvedAt !== undefined && lastWriteAt > closeResolvedAt,
      markClosed: () => (closeResolvedAt = Date.now()),
    };
    void released;
    return store;
  }

  it("close() resolves only after every record — including a follow-on scheduled mid-write — is persisted", async () => {
    const bus = new EventBus();
    const store = gatedStore();
    // An exporter that, the first time it exports, schedules ONE follow-on record
    // by emitting another mapped event. On the pre-fix one-shot snapshot this
    // follow-on is scheduled after flush() captured its set and is never awaited.
    let fired = false;
    const exporter: ObsExporter = {
      export: () => {
        if (!fired) {
          fired = true;
          bus.emit("SKILL_LOADED", { name: "follow-on" }, { session: "s1" });
        }
      },
    };
    const writer = new ObsWriter({
      bus,
      store,
      getLevel: () => "info",
      getSuggestionThreshold: () => 3,
      exporters: () => [exporter],
    });
    writer.start();
    bus.emit("MEMORY_SAVED", { id: "m1" }, { session: "s1" });

    const closed = writer.close();
    // Release the gate so the first write proceeds; its export schedules a
    // follow-on, which close() must also drain before resolving.
    store.release();
    let resolved = false;
    void closed.then(() => (resolved = true));
    await Promise.resolve();
    await closed;
    expect(resolved).toBe(true);
    // Both the original and the follow-on record are persisted.
    expect((store.ws.get("s1") ?? []).length).toBe(2);
  });

  it("a record emitted after close() resolves is NOT written (deliberate, visible drop)", async () => {
    const bus = new EventBus();
    const store = memStore();
    const writer = new ObsWriter({ bus, store, getLevel: () => "info", getSuggestionThreshold: () => 3 });
    writer.start();
    bus.emit("MEMORY_SAVED", { id: "m1" }, { session: "s1" });
    await writer.close();
    const before = (store.ws.get("s1") ?? []).length;
    bus.emit("MEMORY_SAVED", { id: "m2" }, { session: "s1" });
    await new Promise((r) => setTimeout(r, 10));
    expect((store.ws.get("s1") ?? []).length).toBe(before);
  });

  it("close() is idempotent and concurrent-safe — two simultaneous closes share one drain", async () => {
    const bus = new EventBus();
    const store = memStore();
    let appends = 0;
    const counting: ObsLogStore = {
      async appendWorkspace(id, line) {
        appends += 1;
        await store.appendWorkspace(id, line);
      },
      appendGlobal: store.appendGlobal.bind(store),
      readWorkspace: store.readWorkspace.bind(store),
    };
    const writer = new ObsWriter({ bus, store: counting, getLevel: () => "info", getSuggestionThreshold: () => 3 });
    writer.start();
    bus.emit("MEMORY_SAVED", { id: "m1" }, { session: "s1" });
    await Promise.all([writer.close(), writer.close(), writer.dispose()]);
    expect(appends).toBe(1);
    expect((store.ws.get("s1") ?? []).length).toBe(1);
  });
});

/**
 * §10.7 / §10.14 — SessionStats time/reliability fields and the stats report
 * builder surfaced by the writer (live scope "session" and the workspace
 * aggregate).
 */
describe("§10.7 / §10.14 — ObsWriter stats", () => {
  it("MODEL_USAGE sums wallMs, cache-read tokens, and msPerTurn derives from wallMs", async () => {
    const { bus, writer } = makeWriter();
    bus.emit("MODEL_USAGE", { name: "local", usage: { promptTokens: 100, completionTokens: 50, totalMs: 2000, cacheReadTokens: 10 } }, { session: "s1" });
    bus.emit("TURN_COMPLETE", { status: "completed", toolsUsed: [], usage: {} }, { session: "s1" });
    bus.emit("MODEL_USAGE", { name: "local", usage: { promptTokens: 200, completionTokens: 80, totalMs: 4000 } }, { session: "s1" });
    bus.emit("TURN_COMPLETE", { status: "completed", toolsUsed: [], usage: {} }, { session: "s1" });
    await writer.flush();
    const s = writer.statsFor("s1");
    expect(s.wallMs).toBe(6000);
    expect(s.tokensCacheRead).toBe(10);
    expect(s.turns).toBe(2);
    expect(s.averages.msPerTurn).toBe(3000);
  });

  it("a tool span that closes error bumps toolCalls.errors without inflating total", async () => {
    const { bus, writer } = makeWriter();
    bus.emit("TOOL_STARTED", { name: "write_file" }, { session: "s1" });
    bus.emit("TOOL_STARTED", { name: "write_file" }, { session: "s1" });
    // The error span arrives via the callback surface (not an event).
    writer.writeFromCallback({ traceId: "s1", spanId: "t1", source: "tool", name: "write_file", status: "error" });
    await writer.flush();
    const s = writer.statsFor("s1");
    expect(s.toolCalls.total).toBe(2);
    expect(s.toolCalls.errors).toBe(1);
  });

  it("statsReportFor builds scope session from the session's own model.usage records", async () => {
    const { bus, writer } = makeWriter({ price: (n) => (n === "cloud" ? { costPer1kInput: 1, costPer1kOutput: 2 } : undefined) });
    bus.emit("MODEL_USAGE", { name: "cloud", usage: { promptTokens: 1000, completionTokens: 500, totalMs: 1000 }, agent: "chat" }, { session: "s1" });
    bus.emit("MODEL_USAGE", { name: "local", usage: { promptTokens: 200, completionTokens: 80, totalMs: 2000 }, agent: "chat" }, { session: "s1" });
    await writer.flush();
    const r = await writer.statsReportFor("s1");
    expect(r.scope).toBe("session");
    expect(r.totals.turns).toBe(2);
    expect(r.byModel["cloud"]!.tokensIn).toBe(1000);
    expect(r.byModel["local"]!.tokensIn).toBe(200);
    // cloud priced -> cost; local unpriced -> no cost; mixed total -> no cost.
    expect(r.byModel["cloud"]!.cost).toBeCloseTo(1 + 1);
    expect(r.byModel["local"]!.cost).toBeUndefined();
    expect(r.totals.cost).toBeUndefined();
  });

  it("MODEL_USAGE carries inputSum (summed input) and genMs: stats tokensIn uses the SUM and tokensPerSecond is generation speed (§10.7, §10.14)", async () => {
    const { bus, writer } = makeWriter({ price: () => ({ costPer1kInput: 1, costPer1kOutput: 2 }) });
    // A turn whose peak prompt was 1400 but whose SUMMED input across its two
    // model calls was 2400; genMs is the summed generation time (800ms).
    bus.emit(
      "MODEL_USAGE",
      { name: "local", usage: { promptTokens: 1400, inputSum: 2400, completionTokens: 70, totalMs: 5000, genMs: 800 }, agent: "chat" },
      { session: "s1" },
    );
    await writer.flush();
    // Live SessionStats tokensIn is the SUMMED input, not the peak prompt.
    const s = writer.statsFor("s1");
    expect(s.tokensIn).toBe(2400);
    expect(s.tokensOut).toBe(70);
    const r = await writer.statsReportFor("s1");
    expect(r.totals.tokensIn).toBe(2400);
    expect(r.totals.genMs).toBe(800);
    expect(r.totals.wallMs).toBe(5000);
    // Generation speed = tokensOut ÷ (genMs/1000), NOT over wall time.
    expect(r.totals.tokensPerSecond).toBeCloseTo((70 / 800) * 1000);
    // Cost is derived from the SUMMED input (2400), not the peak prompt (1400).
    expect(r.totals.cost).toBeCloseTo((2400 / 1000) * 1 + (70 / 1000) * 2);
  });

  it("MODEL_USAGE without genMs reports genMs 0 and no tokensPerSecond (unstreamed turn), wall time still summed", async () => {
    const { bus, writer } = makeWriter();
    bus.emit(
      "MODEL_USAGE",
      { name: "local", usage: { promptTokens: 100, inputSum: 100, completionTokens: 40, totalMs: 1500 }, agent: "chat" },
      { session: "s1" },
    );
    await writer.flush();
    const r = await writer.statsReportFor("s1");
    expect(r.totals.genMs).toBe(0);
    expect(r.totals.wallMs).toBe(1500);
    expect(r.totals.tokensPerSecond).toBeUndefined();
  });

  it("aggregateStats reconciles across two stored session trails (priced/unpriced/worker)", async () => {
    const sessions = {
      async list() {
        return [
          { id: "s1", name: "a", workspace: "/w", lastActiveAt: "2026-10-19T10:00:00.000Z", sizeBytes: 0 },
          { id: "s2", name: "b", workspace: "/w", lastActiveAt: "2026-10-19T11:00:00.000Z", sizeBytes: 0 },
        ];
      },
    } as unknown as import("../entities/ports/session-repository.js").SessionRepository;
    const { bus, writer } = makeWriter({ sessions, price: (n) => (n === "cloud" ? { costPer1kInput: 1 } : undefined) });
    // s1: a priced turn + a worker turn.
    bus.emit("MODEL_USAGE", { name: "cloud", usage: { promptTokens: 1000, completionTokens: 0, totalMs: 1000 }, agent: "chat" }, { session: "s1" });
    // s2: an unpriced turn.
    bus.emit("MODEL_USAGE", { name: "local", usage: { promptTokens: 300, completionTokens: 100, totalMs: 2000 }, agent: "vibe" }, { session: "s2" });
    await writer.flush();
    const r = await writer.aggregateStats({ workspace: "/w" });
    expect(r.scope).toBe("aggregate");
    expect(r.totals.turns).toBe(2);
    expect(r.totals.tokensIn).toBe(1300);
    // byModel/byAgent/byDay reconcile to totals.
    const sum = Object.values(r.byModel).reduce((a, b) => a + b.tokensIn, 0);
    expect(sum).toBe(r.totals.tokensIn);
    expect(r.byAgent["chat"]!.tokensIn).toBe(1000);
    expect(r.byAgent["vibe"]!.tokensIn).toBe(300);
    // cloud priced -> cost; the mixed total omits cost.
    expect(r.byModel["cloud"]!.cost).toBeCloseTo(1);
    expect(r.totals.cost).toBeUndefined();
  });
});

/**
 * §10.6 — the repeated-sequence detector wired into the writer, beside the
 * existing failure-shape analyzer (which is covered above and unchanged).
 */
describe("§10.6 — ObsWriter wires the repeated-sequence detector", () => {
  /** Observe a completed tool call (pending-with-args → ok) through the writer's
   * callback surface so the detector sees a real completed span. */
  function toolCall(writer: ObsWriter, traceId: string, spanId: string, name: string, args: unknown, status: "ok" | "error" = "ok") {
    writer.writeFromCallback({ traceId, spanId, source: "tool", name, status: "pending", input: args });
    writer.writeFromCallback({ traceId, spanId, source: "tool", name, status });
  }

  it("emits ONE sequence-detector WARNING per signature per session, with outcome and a human message", async () => {
    const { bus, writer } = makeWriter({ threshold: 3 });
    const warnings: Record<string, unknown>[] = [];
    bus.subscribe("WARNING_EMITTED", (e) => warnings.push(e.payload as Record<string, unknown>));
    // A 3-step sequence (read → search → write) across three turns qualifies.
    for (let round = 0; round < 3; round++) {
      writer.beginSequenceTurn("s1");
      toolCall(writer, "s1", `r${round}-a`, "read_file", { path: "a.ts" });
      toolCall(writer, "s1", `r${round}-b`, "search_contents", { path: "a.ts" });
      toolCall(writer, "s1", `r${round}-c`, "write_file", { path: "a.ts" });
    }
    await writer.drainSequenceCandidates("s1"); // flush the final turn's signal
    await writer.flush();
    const seq = warnings.filter((w) => w.source === "sequence-detector");
    expect(seq).toHaveLength(1);
    expect(seq[0]).toMatchObject({ category: "suggestion", source: "sequence-detector", outcome: "success", count: 3 });
    expect(seq[0]!.pattern).toBe(
      "read_file({path:string}) → search_contents({path:string}) → write_file({path:string})",
    );
    // §14.6 — every payload carries a human message, names by display names.
    expect(seq[0]!.message).toBe(
      "Repeated pattern: Read → Search → Write (in 3 turns this session). A skill suggestion will be drafted when the session is idle; review with /memory.",
    );
  });

  it("RECORDS the candidate but does not draft it until drainSequenceCandidates (idle/boundary, §6.7)", async () => {
    const seen: { signal: { pattern: string; steps: string[]; outcome: string }; examples: ObsRecord[] }[] = [];
    const { writer } = makeWriter({
      threshold: 3,
      onSequenceSignal: (signal, examples) => seen.push({ signal: signal as never, examples }),
    });
    for (let round = 0; round < 3; round++) {
      writer.beginSequenceTurn("s1");
      toolCall(writer, "s1", `r${round}-a`, "read_file", { path: "a.ts" });
      toolCall(writer, "s1", `r${round}-b`, "search_contents", { path: "a.ts" });
      toolCall(writer, "s1", `r${round}-c`, "write_file", { path: "a.ts" });
    }
    await writer.flush();
    // The detector only RECORDED — no draft (model call) has happened yet.
    expect(seen).toHaveLength(0);
    // Draining at idle/boundary drafts the recorded candidate ONCE.
    await writer.drainSequenceCandidates("s1");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.signal.steps).toEqual([
      "read_file({path:string})",
      "search_contents({path:string})",
      "write_file({path:string})",
    ]);
    expect(seen[0]!.signal.outcome).toBe("success");
    expect(seen[0]!.examples.length).toBeGreaterThan(0);
    // A second drain is a no-op (the queue was cleared).
    await writer.drainSequenceCandidates("s1");
    expect(seen).toHaveLength(1);
  });

  it("clearSequenceCandidates drops a recorded-but-undrafted candidate (setMode/clear, §6.7)", async () => {
    const seen: unknown[] = [];
    const { writer } = makeWriter({ threshold: 3, onSequenceSignal: (s) => seen.push(s) });
    for (let round = 0; round < 3; round++) {
      writer.beginSequenceTurn("s1");
      toolCall(writer, "s1", `r${round}-a`, "read_file", { path: "a.ts" });
      toolCall(writer, "s1", `r${round}-b`, "search_contents", { path: "a.ts" });
      toolCall(writer, "s1", `r${round}-c`, "write_file", { path: "a.ts" });
    }
    await writer.flush();
    writer.clearSequenceCandidates("s1");
    await writer.drainSequenceCandidates("s1");
    expect(seen).toHaveLength(0);
  });

  it("a secret in a tool argument never reaches the sequence event or the example spans (§10.10)", async () => {
    const secret = "sk-liv" + "e-ABCDEF1234567890";
    const seen: ObsRecord[] = [];
    const { bus, writer } = makeWriter({
      threshold: 3,
      onSequenceSignal: (_s, examples) => seen.push(...examples),
    });
    const warnings: unknown[] = [];
    bus.subscribe("WARNING_EMITTED", (e) => warnings.push(e.payload));
    for (let round = 0; round < 3; round++) {
      writer.beginSequenceTurn("s1");
      toolCall(writer, "s1", `r${round}-a`, "execute_command", { command: `curl -H 'Authorization: Bearer ${secret}'` });
      toolCall(writer, "s1", `r${round}-b`, "read_file", { path: "a.ts" });
      toolCall(writer, "s1", `r${round}-c`, "write_file", { path: "a.ts" });
    }
    await writer.flush();
    await writer.drainSequenceCandidates("s1");
    expect(JSON.stringify(warnings)).not.toContain(secret);
    expect(JSON.stringify(seen)).not.toContain(secret);
  });

  it("seeds from prior sessions of the SAME workspace so a cross-session repeat qualifies", async () => {
    const bus = new EventBus();
    const store = memStore();
    const priorRecs = (sess: string): ObsRecord[] => [
      { traceId: sess, spanId: `${sess}-p1`, timestamp: "t", status: "pending", source: "tool", name: "read_file", severity: "info", attributes: {}, input: { path: "x" } },
      { traceId: sess, spanId: `${sess}-p1`, timestamp: "t", status: "ok", source: "tool", name: "read_file", severity: "info", attributes: {} },
      { traceId: sess, spanId: `${sess}-p2`, timestamp: "t", status: "pending", source: "tool", name: "write_file", severity: "info", attributes: {}, input: { path: "x" } },
      { traceId: sess, spanId: `${sess}-p2`, timestamp: "t", status: "ok", source: "tool", name: "write_file", severity: "info", attributes: {} },
    ];
    // Three prior sessions each ran read → write, so the cross-session count and
    // the ≥3-distinct-sessions qualifier are both met with one more live run.
    for (const s of ["s0", "sa", "sb"]) store.ws.set(s, priorRecs(s).map((r) => JSON.stringify(r)));
    const sessions = {
      list: async () => [
        { id: "s1", workspace: "/w" } as never,
        { id: "s0", workspace: "/w" } as never,
        { id: "sa", workspace: "/w" } as never,
        { id: "sb", workspace: "/w" } as never,
      ],
      save: async () => undefined,
      load: async () => null,
      remove: async () => undefined,
    };
    const warnings: Record<string, unknown>[] = [];
    bus.subscribe("WARNING_EMITTED", (e) => warnings.push(e.payload as Record<string, unknown>));
    const writer = new ObsWriter({
      bus,
      store,
      sessions: sessions as never,
      getLevel: () => "info",
      getSuggestionThreshold: () => 4,
      getSequenceMaxLen: () => 6,
    });
    writer.start();
    await writer.seedSequencesFromPriorSessions("s1", "/w");
    writer.beginSequenceTurn("s1");
    writer.writeFromCallback({ traceId: "s1", spanId: "l1", source: "tool", name: "read_file", status: "pending", input: { path: "y" } });
    writer.writeFromCallback({ traceId: "s1", spanId: "l1", source: "tool", name: "read_file", status: "ok" });
    writer.writeFromCallback({ traceId: "s1", spanId: "l2", source: "tool", name: "write_file", status: "pending", input: { path: "y" } });
    writer.writeFromCallback({ traceId: "s1", spanId: "l2", source: "tool", name: "write_file", status: "ok" });
    await writer.drainSequenceCandidates("s1"); // flush the final turn's signal
    await writer.flush();
    const seq = warnings.filter((w) => w.source === "sequence-detector");
    expect(seq).toHaveLength(1);
    expect(seq[0]).toMatchObject({ count: 4 });
  });

  it("one unreadable prior session does not break the boundary (best-effort, §10.6)", async () => {
    const bus = new EventBus();
    const store: ObsLogStore = {
      appendWorkspace: async () => undefined,
      appendGlobal: async () => undefined,
      readWorkspace: async (id) => {
        if (id === "bad") throw new Error("corrupt segment");
        return [];
      },
    };
    const errors: string[] = [];
    const sessions = {
      list: async () => [
        { id: "bad", workspace: "/w" } as never,
        { id: "good", workspace: "/w" } as never,
      ],
      save: async () => undefined,
      load: async () => null,
      remove: async () => undefined,
    };
    const writer = new ObsWriter({
      bus,
      store,
      sessions: sessions as never,
      getLevel: () => "info",
      getSuggestionThreshold: () => 2,
      getSequenceMaxLen: () => 6,
      onError: (m) => errors.push(m),
    });
    writer.start();
    await expect(writer.seedSequencesFromPriorSessions("s1", "/w")).resolves.toBeUndefined();
    expect(errors.join("")).toContain("unreadable");
  });

  it("persists every WARNING_EMITTED to the info trail (auditable from disk, §10.6/§14.6)", async () => {
    const { bus, store, writer } = makeWriter();
    bus.emit(
      "WARNING_EMITTED",
      { category: "suggestion", source: "sequence-detector", pattern: "a → b", count: 3, message: "Repeated pattern: A → B (seen 3×)." },
      { session: "s1" },
    );
    await writer.flush();
    const lines = store.ws.get("s1") ?? [];
    const warn = lines.map((l) => JSON.parse(l) as ObsRecord).find((r) => r.name === "warning");
    expect(warn).toBeDefined();
    expect(warn!.attributes).toMatchObject({ category: "suggestion", source: "sequence-detector", message: "Repeated pattern: A → B (seen 3×)." });
  });
});

/**
 * I1b §10.3 — the `info` trail persists tool start/finish spans and model
 * request (retry) spans, so a run is reconstructable from disk; the stats
 * builder still parses the trail and never double-counts tokens from them.
 */
describe("§10.3 — ObsWriter persists tool and model-request spans in the trail", () => {
  it("a scripted turn with 3 tool calls lands start+finish records with names and statuses, no secret", async () => {
    const { bus, store, writer } = makeWriter();
    const secret = "ghp_AB" + "CDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const calls: { id: string; name: string; status: "success" | "error"; args: Record<string, unknown> }[] = [
      { id: "c1", name: "read_file", status: "success", args: { path: "a.ts" } },
      // Plant an API-key-shaped argument on a command call.
      { id: "c2", name: "execute_command", status: "success", args: { command: `deploy --token=${secret}` } },
      { id: "c3", name: "write_file", status: "error", args: { path: "b.ts", content: "x" } },
    ];
    for (const c of calls) {
      bus.emit("TOOL_STARTED", { id: c.id, name: c.name, args: c.args }, { session: "s1" });
      bus.emit("TOOL_FINISHED", { id: c.id, name: c.name, status: c.status, durationMs: 12, summary: "done" }, { session: "s1" });
    }
    await writer.flush();
    const recs = (store.ws.get("s1") ?? []).map((l) => JSON.parse(l) as ObsRecord);
    const tool = recs.filter((r) => r.source === "tool");
    // 3 start (pending) + 3 finish (ok/error) = 6 tool spans.
    expect(tool.filter((r) => r.status === "pending")).toHaveLength(3);
    expect(tool.filter((r) => r.status === "ok")).toHaveLength(2);
    expect(tool.filter((r) => r.status === "error")).toHaveLength(1);
    // Names are present on every tool span.
    expect(new Set(tool.map((r) => r.name))).toEqual(new Set(["read_file", "execute_command", "write_file"]));
    // Correlation ids ride the attributes so start/finish pair up.
    expect(tool.every((r) => typeof (r.attributes as { toolCallId?: unknown }).toolCallId === "string")).toBe(true);
    // The planted secret is masked before it reaches disk (§10.10).
    const body = (store.ws.get("s1") ?? []).join("");
    expect(body).not.toContain(secret);
    expect(body).toContain("execute_command");
  });

  it("a 5000-char argument is bounded in the persisted start span (never full file content)", async () => {
    const { bus, store, writer } = makeWriter();
    const big = "a".repeat(5000);
    bus.emit("TOOL_STARTED", { id: "c1", name: "write_file", args: { path: "p.ts", content: big } }, { session: "s1" });
    await writer.flush();
    const rec = (store.ws.get("s1") ?? []).map((l) => JSON.parse(l) as ObsRecord).find((r) => r.source === "tool")!;
    const content = (rec.attributes as { args: { content: string } }).args.content;
    // Bounded well under the original 5000 chars; the truncation is marked.
    expect(content.length).toBeLessThan(1200);
    expect(content).toContain("[+");
    // The whole serialized line is bounded too (no unbounded growth per record).
    expect(JSON.stringify(rec).length).toBeLessThan(2000);
  });

  it("a model request (retry) span is persisted per failed attempt with model/attempt/retryable", async () => {
    const { bus, store, writer } = makeWriter();
    bus.emit("MODEL_ERROR", { name: "local", code: "server", message: "500", retryable: true, attempt: 1, willRetry: true, maxRetries: 3 }, { session: "s1" });
    bus.emit("MODEL_ERROR", { name: "local", code: "server", message: "500", retryable: true, attempt: 2, willRetry: false, maxRetries: 3 }, { session: "s1" });
    await writer.flush();
    const recs = (store.ws.get("s1") ?? []).map((l) => JSON.parse(l) as ObsRecord).filter((r) => r.name === "model.request");
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ source: "model", status: "pending" });
    expect(recs[0]!.model).toEqual({ name: "local", protocol: "openai" });
    expect((recs[0]!.attributes as { attempt: number }).attempt).toBe(1);
    expect((recs[0]!.attributes as { willRetry: boolean }).willRetry).toBe(true);
    // The terminal (non-retried) attempt is an error span.
    expect(recs[1]).toMatchObject({ status: "error" });
    expect((recs[1]!.attributes as { willRetry: boolean }).willRetry).toBe(false);
  });

  it("the stats readers still parse the new records and tokens are NOT double-counted (model.usage is the source)", async () => {
    // A trail WITH the new tool + model-request records.
    const withSpans = makeWriter();
    withSpans.bus.emit("TOOL_STARTED", { id: "c1", name: "read_file", args: { path: "a" } }, { session: "s1" });
    withSpans.bus.emit("MODEL_ERROR", { name: "local", code: "server", retryable: true, attempt: 1, willRetry: true }, { session: "s1" });
    withSpans.bus.emit("MODEL_USAGE", { name: "local", usage: { promptTokens: 100, inputSum: 100, completionTokens: 40, totalMs: 1000 }, agent: "chat" }, { session: "s1" });
    withSpans.bus.emit("TOOL_FINISHED", { id: "c1", name: "read_file", status: "success", durationMs: 5, summary: "ok" }, { session: "s1" });
    await withSpans.writer.flush();

    // An "old" trail: ONLY the model.usage record (what the pre-fix trail held
    // for token accounting).
    const old = makeWriter();
    old.bus.emit("MODEL_USAGE", { name: "local", usage: { promptTokens: 100, inputSum: 100, completionTokens: 40, totalMs: 1000 }, agent: "chat" }, { session: "s1" });
    await old.writer.flush();

    const withR = await withSpans.writer.query("s1");
    const oldR = await old.writer.query("s1");
    expect(withR.ok && oldR.ok).toBe(true);

    // Build stats over the FULL trails read back from disk (the reader skips
    // nothing and parses every new record), then compare TOKENS.
    const { buildStatsReport, parseTrailLines } = await import("../entities/observability/stats-report.js");
    const withStats = buildStatsReport(parseTrailLines(withSpans.store.ws.get("s1") ?? []), { scope: "aggregate" });
    const oldStats = buildStatsReport(parseTrailLines(old.store.ws.get("s1") ?? []), { scope: "aggregate" });
    // model.usage remains the single source for tokens: identical across both.
    expect(withStats.totals.tokensIn).toBe(oldStats.totals.tokensIn);
    expect(withStats.totals.tokensOut).toBe(oldStats.totals.tokensOut);
    expect(withStats.totals.tokensTotal).toBe(oldStats.totals.tokensTotal);
    expect(withStats.totals.turns).toBe(oldStats.totals.turns); // model.request adds no turn
    // The model.request span carries no usage, so it cannot add tokens.
    expect(withStats.totals.tokensIn).toBe(100);
  });
});

describe("§8.7/§14.6 — INGEST and BY_REFERENCE reach the trail", () => {
  it("persists an INGEST span naming the source, chunks, cacheHit and limit key", async () => {
    const { bus, store, writer } = makeWriter();
    bus.emit(
      "INGEST",
      { source: "README.md", kind: "file", inputTokens: 20000, available: 5000, chunks: 7, cacheHit: false, key: "ingest.fitFraction" },
      { session: "s1" },
    );
    await writer.flush();
    const lines = store.ws.get("s1") ?? [];
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!) as ObsRecord;
    expect(rec.source).toBe("session");
    expect(rec.name).toBe("ingest");
    const a = rec.attributes as Record<string, unknown>;
    expect(a["source"]).toBe("README.md");
    expect(a["chunks"]).toBe(7);
    expect(a["cacheHit"]).toBe(false);
    expect(a["key"]).toBe("ingest.fitFraction");
  });

  it("persists a BY_REFERENCE span naming what, bytes and the limit key, never content", async () => {
    const { bus, store, writer } = makeWriter();
    bus.emit("BY_REFERENCE", { what: "brief", bytes: 123456, key: "task.briefMaxBytes" }, { session: "s1", worker: "w1" });
    await writer.flush();
    const lines = store.ws.get("s1") ?? [];
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!) as ObsRecord;
    expect(rec.name).toBe("by_reference");
    const a = rec.attributes as Record<string, unknown>;
    expect(a["what"]).toBe("brief");
    expect(a["bytes"]).toBe(123456);
    expect(a["key"]).toBe("task.briefMaxBytes");
  });

  it("getSequencePriorSessions caps how many prior session trails are seeded (§10.6, §13.11)", async () => {
    const reads: string[] = [];
    const store = memStore();
    const origRead = store.readWorkspace.bind(store);
    store.readWorkspace = async (id: string) => {
      reads.push(id);
      return origRead(id);
    };
    const metas = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `p${i}`, workspace: "/w", lastActiveAt: "", createdAt: "" }));
    const sessions = { list: async () => metas, save: async () => undefined, load: async () => null, remove: async () => undefined } as never;
    const bus = new EventBus();
    const writer = new ObsWriter({
      bus,
      store,
      sessions,
      getLevel: () => "info",
      getSuggestionThreshold: () => 2,
      getSequenceMaxLen: () => 6,
      getSequencePriorSessions: () => 2, // live override: seed only 2 prior sessions
    });
    writer.start();
    await writer.seedSequencesFromPriorSessions("s1", "/w");
    // Only the first 2 prior sessions' trails were read (the cap took effect).
    expect(reads.sort()).toEqual(["p0", "p1"]);
  });
});
