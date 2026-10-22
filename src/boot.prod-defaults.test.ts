/**
 * Production default-path tests (core-blueprint.md §13.1, §13.3, §13.8, §3.6,
 * §11.9) — the paths NO existing test exercised because every one injects its
 * own in-memory fakes. These construct `createCore` with NO injected
 * `configStore` so the real `FilesystemConfigStore` and first-run bootstrap run,
 * each against an isolated temp HOME/XDG + temp workspace, restored on teardown.
 *
 * Deterministic and offline: the model never resolves except in the
 * refused-connection test, which points the OpenAI-protocol default at a
 * bind-then-closed localhost port (a guaranteed-refused connect, no network).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import net from "node:net";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import { createCore } from "./boot.js";
import { createMemoryCheckpointer } from "./adapters/checkpointer.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";
import type { EventEnvelope } from "./entities/event-bus.js";
import { ConfigSchema } from "./config/schema.js";

describe("production default config store (§13 on-disk, no injected configStore)", () => {
  let ws: string;
  let home: string;
  let prevXdg: string | undefined;
  let globalConfig: string;

  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), "vr-prod-ws-"));
    home = await fs.mkdtemp(path.join(os.tmpdir(), "vr-prod-xdg-"));
    prevXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = home;
    globalConfig = path.join(home, "voidrift", "config.json");
  });

  afterEach(async () => {
    if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = prevXdg;
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  const boot = () =>
    createCore({
      workspaceRoot: ws,
      sessionRepository: new InMemorySessionRepository(),
      checkpointer: createMemoryCheckpointer(),
      chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
    });

  it("(a) seeds a valid global config on first run and a second createCore reads it back (§13.8)", async () => {
    const first = await boot();
    // The seed was written to the real global path under the temp XDG home.
    const raw = JSON.parse(await fs.readFile(globalConfig, "utf8")) as {
      models: Record<string, { baseUrl?: string; protocol?: string }>;
      modelSelected: string;
    };
    expect(raw.modelSelected).toBe("local");
    expect(raw.models["local"]?.baseUrl).toBe("http://localhost:11434/v1");
    expect(raw.models["local"]?.protocol).toBe("openai");
    const sel1 = await first.api.config.get("modelSelected");
    expect(sel1.ok && sel1.value).toBe("local");

    // A second boot reads the seeded file back (no re-seed needed).
    const second = await boot();
    const sel2 = await second.api.config.get("modelSelected");
    expect(sel2.ok && sel2.value).toBe("local");
  });

  it("(b) a project .voidrift/config.json overrides global (§13.1)", async () => {
    await boot(); // seed global
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    await fs.writeFile(
      path.join(ws, ".voidrift", "config.json"),
      JSON.stringify({ turnMaxConcurrency: 9 }),
    );
    const { api } = await boot();
    const got = await api.config.get("turnMaxConcurrency");
    expect(got.ok && got.value).toBe(9);
  });

  it("(c) config.set persists to disk and survives a fresh createCore (§13.4)", async () => {
    const { api } = await boot();
    const set = await api.config.set("turnMaxConcurrency", 5, "project");
    expect(set.ok).toBe(true);
    // Written to the project file on disk.
    const onDisk = JSON.parse(
      await fs.readFile(path.join(ws, ".voidrift", "config.json"), "utf8"),
    ) as { turnMaxConcurrency?: number };
    expect(onDisk.turnMaxConcurrency).toBe(5);
    // A fresh core reads it back.
    const { api: api2 } = await boot();
    const got = await api2.config.get("turnMaxConcurrency");
    expect(got.ok && got.value).toBe(5);
  });

  it("(d) an invalid on-disk config is set aside as .rejected and last-known-good stays (§13.3)", async () => {
    await boot(); // seed global
    // Write a valid project config first, then corrupt it with a bad value.
    const projFile = path.join(ws, ".voidrift", "config.json");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    await fs.writeFile(projFile, JSON.stringify({ turnMaxConcurrency: -5 })); // invalid: must be positive

    const invalidEvents: EventEnvelope[] = [];
    const { api } = await createCore({
      workspaceRoot: ws,
      sessionRepository: new InMemorySessionRepository(),
      checkpointer: createMemoryCheckpointer(),
      chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
    });
    api.events.subscribe("CONFIG_INVALID", (e) => invalidEvents.push(e));
    // The invalid project layer was set aside: a .rejected sibling exists.
    const rejected = await fs
      .readFile(projFile + ".rejected", "utf8")
      .then(() => true)
      .catch(() => false);
    expect(rejected).toBe(true);
    // The resolved config stays on the schema default (the invalid value never applied).
    const got = await api.config.get("turnMaxConcurrency");
    const schemaDefault = ConfigSchema.parse({}).turnMaxConcurrency;
    expect(got.ok && got.value).toBe(schemaDefault);
  });

  it("(e) an unwritable global config dir does not crash boot (§2.1/§13.3)", async () => {
    // Point XDG at a FILE so creating the `voidrift` dir under it fails: an
    // unwritable config dir is a recoverable condition, not a construction error.
    const blocker = path.join(os.tmpdir(), `vr-blocker-${Date.now()}`);
    await fs.writeFile(blocker, "not a dir");
    process.env["XDG_CONFIG_HOME"] = blocker;
    try {
      const { api } = await boot();
      // Boot succeeded; the seed stayed in memory so the endpoint still resolves.
      const sel = await api.config.get("modelSelected");
      expect(sel.ok && sel.value).toBe("local");
    } finally {
      await fs.rm(blocker, { force: true });
    }
  });
});

describe("production model path — refused connection fails fast (§3.6, §11.9)", () => {
  let ws: string;
  let home: string;
  let prevXdg: string | undefined;

  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), "vr-refuse-ws-"));
    home = await fs.mkdtemp(path.join(os.tmpdir(), "vr-refuse-xdg-"));
    prevXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = home;
  });

  afterEach(async () => {
    if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = prevXdg;
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  /** Bind then close a port to get a guaranteed-refused localhost port offline. */
  async function refusedPort(): Promise<number> {
    const srv = net.createServer();
    const port = await new Promise<number>((resolve) => {
      srv.listen(0, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port));
    });
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    return port;
  }

  it("a turn against a closed OpenAI-protocol port fails with MODEL_ERROR + ERROR_OCCURRED within seconds (default factory)", async () => {
    const port = await refusedPort();
    // Seed a project config pointing the production OpenAI-protocol path at the
    // refused port; NO chatModelFactory injected, so the real default factory
    // builds a ChatOpenAI client (the production code path).
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    await fs.writeFile(
      path.join(ws, ".voidrift", "config.json"),
      JSON.stringify({
        models: {
          local: { model: "m", protocol: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, contextLimit: 8000 },
        },
        modelSelected: "local",
      }),
    );

    const { api } = await createCore({
      workspaceRoot: ws,
      sessionRepository: new InMemorySessionRepository(),
      checkpointer: createMemoryCheckpointer(),
    });
    const modelErrors: EventEnvelope[] = [];
    const errors: EventEnvelope[] = [];
    const created = await api.session.create();
    expect(created.ok).toBe(true);
    const sessionId = created.ok ? created.value.id : "";
    api.events.subscribe("MODEL_ERROR", (e) => modelErrors.push(e), { scope: { session: sessionId } });
    api.events.subscribe("ERROR_OCCURRED", (e) => errors.push(e), { scope: { session: sessionId } });

    const start = Date.now();
    const res = await api.session.send(sessionId, { input: "say hi" });
    const elapsed = Date.now() - start;

    expect(res.ok).toBe(true);
    expect(res.ok && res.value.status).toBe("failed");
    expect(modelErrors.length).toBeGreaterThanOrEqual(1);
    expect((modelErrors[0]!.payload as { code: string }).code).toBe("network");
    expect((modelErrors[0]!.payload as { retryable: boolean }).retryable).toBe(false);
    // The retry budget rides on the event so a client can show `attempt/total`
    // without reading config (§3.6). The config sets no override, so it is the
    // schema default of 3.
    expect((modelErrors[0]!.payload as { maxRetries?: number }).maxRetries).toBe(3);
    expect(errors.some((e) => (e.payload as { source: string }).source === "model")).toBe(true);
    // Fails fast: a refused connect must give up in seconds, not minutes (§3.6).
    expect(elapsed).toBeLessThan(10_000);

    await api.session.shutdown();
  }, 15_000);
});
