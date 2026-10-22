/**
 * Shutdown-drain regression (core-blueprint.md §5.2, §10.3, §14.3, §15.1#2,#3).
 *
 * The defect: `ObsWriter.flush()` took a one-shot snapshot and the writer stopped
 * accepting records before every in-flight write (and its follow-ons) was
 * persisted, so a late observability write landed AFTER `session.shutdown()` and
 * after the test's `fs.rm(ws)` — re-creating the deleted workspace with a lone
 * `.voidrift/logs/<id>.log`, and losing the last turn's audit records. These
 * tests run the PRODUCTION filesystem log store over a REAL temp dir and fail on
 * the pre-fix code (the workspace reappears / records are missing).
 */
import { hermeticTmp } from "./test-hermetic.js";
import { describe, it, expect } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import path from "node:path";
import fs from "node:fs/promises";
import { createCore, voidriftConfigDir } from "./boot.js";
import { createMemoryCheckpointer } from "./adapters/checkpointer.js";
import { InMemoryConfigStore } from "./adapters/repositories/in-memory-config-store.js";
import { InMemorySessionRepository } from "./adapters/repositories/session-repository.js";

const seed = { models: { t: { model: "t", protocol: "openai", contextLimit: 32_000 } }, modelSelected: "t" };

// A real temp workspace with the DEFAULT (real) FilesystemAdapter → the
// production NdjsonLogStore writes `.voidrift/logs/<id>.log` under it.
async function coreInWorkspace(ws: string) {
  return createCore({
    workspaceRoot: ws,
    configStore: new InMemoryConfigStore(seed),
    sessionRepository: new InMemorySessionRepository(),
    checkpointer: createMemoryCheckpointer(),
    chatModelFactory: () => fakeModel().respond(new AIMessage("done")),
  });
}

describe("§14.3 — shutdown drains obs writes so a deleted workspace never re-appears", () => {
  // ROOT CAUSE of the intermittent 5 s timeout: this is a LEAK DETECTOR, not a
  // unit test. Each of the 25 cycles boots a full core, runs a turn, shuts down,
  // deletes the workspace, and then waits a REAL 150 ms interval — the window in
  // which a late fire-and-forget obs write would re-create the deleted tree. The
  // real wait is the detector itself (shortening or faking it removes the thing
  // being detected), so 25 × 150 ms ≈ 3.75 s of mandatory real time is inherent
  // BEFORE the 25 core boots. Under full-suite CPU contention that floor drifts
  // past vitest's default 5 s. The real work is bounded (25 fixed cycles), so the
  // correct fix is a generous per-test timeout, not weakening the detector.
  it("25 cycles: run a turn, shutdown, rm(ws), wait — the workspace stays gone (leak detector)", async () => {
    for (let i = 0; i < 25; i += 1) {
      const ws = hermeticTmp("drain");
      await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
      const { api } = await coreInWorkspace(ws);
      const created = await api.session.create({});
      const id = created.ok ? created.value.id : "";
      const sent = await api.session.send(id, { input: "hello" });
      expect(sent.ok).toBe(true);
      // Shutdown must drain every obs write to quiescence before it resolves.
      await api.session.shutdown();
      // The test teardown pattern that leaked: delete the workspace, then wait a
      // real interval during which a late fire-and-forget write would land.
      await fs.rm(ws, { recursive: true, force: true });
      await new Promise((r) => setTimeout(r, 150));
      // Pre-fix (under load): a late obs write re-created `ws/.voidrift/logs/<id>.log`.
      await expect(fs.access(ws)).rejects.toThrow();
    }
  }, 30_000); // 30 s ceiling: the 3.75 s of real waits + 25 boots exceed the 5 s default under load.
});

describe("§15.1#2,#3 — the last turn's audit records survive shutdown", () => {
  it("after shutdown, the session log holds the turn's spans (audit-trail-not-lost)", async () => {
    const ws = hermeticTmp("drain");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    const { api } = await coreInWorkspace(ws);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    expect((await api.session.send(id, { input: "hello" })).ok).toBe(true);
    await api.session.shutdown();
    // Read the persisted trail straight off disk (the writer is closed).
    const logPath = path.join(ws, ".voidrift", "logs", `${id}.log`);
    const body = await fs.readFile(logPath, "utf8");
    const records = body
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { name: string; source: string });
    // The turn's completion span is present — the last-turn record is not lost.
    expect(records.some((r) => r.name === "turn.complete" && r.source === "session")).toBe(true);
    expect(records.length).toBeGreaterThan(0);
    await fs.rm(ws, { recursive: true, force: true });
  });
});

describe("§10.3/§14.3 — a write attempted AFTER shutdown never reaches the global dir", () => {
  it("the global error log for a post-shutdown error is NOT created (late write dropped)", async () => {
    // The leak reproduced in the field: a `status:error` record emitted after
    // teardown reached the global `~/.config/voidrift/logs` via the obs writer's
    // best-effort global append. The hermetic env points the global dir at a
    // temp tree; this test proves that AFTER `session.shutdown()` the writer
    // refuses the record outright, so no global log file is minted for it.
    const globalLogs = path.join(voidriftConfigDir(), "logs");
    const ws = hermeticTmp("drain");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    const { api } = await coreInWorkspace(ws);
    const created = await api.session.create({});
    const id = created.ok ? created.value.id : "";
    // A pre-shutdown error IS written to the global dir (the live path works).
    api.events.register("ERROR_OCCURRED");
    api.events.emit("ERROR_OCCURRED", { source: "model", message: "boom" }, { session: id });
    await api.session.shutdown();
    const liveGlobal = path.join(globalLogs, `${id}.log`);
    expect(await fs.readFile(liveGlobal, "utf8")).toContain("boom");

    // Now emit a SECOND error AFTER shutdown, scoped to a fresh session id that
    // has no global file yet. The writer is closed and must drop it: no file.
    const lateId = "deadbeef";
    api.events.emit("ERROR_OCCURRED", { source: "model", message: "late-boom" }, { session: lateId });
    await new Promise((r) => setTimeout(r, 150));
    await expect(fs.access(path.join(globalLogs, `${lateId}.log`))).rejects.toThrow();

    // Cleanup the live global log this test created so the hermetic fingerprint
    // check sees no residue (it lives under the hermetic temp dir regardless).
    await fs.rm(liveGlobal, { force: true });
    await fs.rm(ws, { recursive: true, force: true });
  });
});
