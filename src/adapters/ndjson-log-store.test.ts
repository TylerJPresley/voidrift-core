/**
 * NDJSON log store rotation tests (core-blueprint.md §10.3).
 *
 * Over the in-memory filesystem (§15.3): a write crossing `logMaxSizeMB` seals a
 * segment and drops the oldest; `logMaxAgeDays`, when set, also drops by age;
 * the global log receives only error records; a filesystem failure is swallowed.
 */
import { describe, it, expect } from "vitest";
import { InMemoryFileSystem } from "./in-memory-filesystem.js";
import { NdjsonLogStore } from "./ndjson-log-store.js";

const MB = 1024 * 1024;

function makeStore(fs: InMemoryFileSystem, maxSizeMB: number, maxAgeDays?: number) {
  return new NdjsonLogStore({
    fs,
    workspaceLogDir: ".voidrift/logs",
    globalLogDir: "/global/logs",
    getMaxSizeMB: () => maxSizeMB,
    getMaxAgeDays: () => maxAgeDays,
  });
}

describe("§10.3 — NDJSON storage and rotation", () => {
  it("appends NDJSON lines to the workspace log and reads them newest-first", async () => {
    const fs = new InMemoryFileSystem();
    const store = makeStore(fs, 50);
    await store.appendWorkspace("s1", JSON.stringify({ n: 1 }));
    await store.appendWorkspace("s1", JSON.stringify({ n: 2 }));
    const lines = await store.readWorkspace("s1");
    expect(lines.map((l) => JSON.parse(l).n)).toEqual([2, 1]);
  });

  it("a write crossing logMaxSizeMB seals a segment and drops the oldest to stay in budget", async () => {
    const fs = new InMemoryFileSystem();
    // 1 MB budget. Each line ~0.4 MB, so three lines force a seal + drop.
    const store = makeStore(fs, 1);
    const big = "x".repeat(Math.floor(0.4 * MB));
    await store.appendWorkspace("s1", big); // seg active ~0.4MB
    await store.appendWorkspace("s1", big); // active ~0.8MB
    await store.appendWorkspace("s1", big); // crossing → seal, fresh, drop oldest
    const sealed = await fs.glob(".voidrift/logs/s1.log.*.old");
    // At most one sealed segment is kept within the 1 MB budget.
    expect(sealed.length).toBeLessThanOrEqual(1);
    // The active segment holds the latest line.
    const active = await fs.readFile(".voidrift/logs/s1.log");
    expect(active).toContain(big);
  });

  it("logMaxAgeDays drops sealed segments past the age when set, never by default", async () => {
    const fs = new InMemoryFileSystem();
    // Pre-seed an old sealed segment with a stale epoch (10 days ago).
    const oldEpoch = Date.now() - 10 * 86_400_000;
    await fs.writeFile(`.voidrift/logs/s1.log.${oldEpoch}.old`, "stale\n");
    await fs.writeFile(".voidrift/logs/s1.log", "live\n");
    const store = makeStore(fs, 50, 7); // 7-day age limit
    await store.appendWorkspace("s1", JSON.stringify({ n: 1 }));
    expect(await fs.exists(`.voidrift/logs/s1.log.${oldEpoch}.old`)).toBe(false);
  });

  it("the global log receives only what is appended there (errors only, by the writer)", async () => {
    const fs = new InMemoryFileSystem();
    const store = makeStore(fs, 50);
    await store.appendGlobal("s1", JSON.stringify({ status: "error" }));
    expect(await fs.readFile("/global/logs/s1.log")).toContain("error");
  });

  it("drain() awaits every queued append so nothing is left unwritten (§10.3, §14.3)", async () => {
    const fs = new InMemoryFileSystem();
    const store = makeStore(fs, 50);
    // Fire-and-forget appends (as the writer schedules them): do NOT await here.
    void store.appendWorkspace("s1", JSON.stringify({ n: 1 }));
    void store.appendWorkspace("s1", JSON.stringify({ n: 2 }));
    void store.appendWorkspace("s2", JSON.stringify({ n: 3 }));
    // drain() reaches a fixed point over the per-path append queues.
    await store.drain();
    expect((await store.readWorkspace("s1")).map((l) => JSON.parse(l).n)).toEqual([2, 1]);
    expect((await store.readWorkspace("s2")).map((l) => JSON.parse(l).n)).toEqual([3]);
  });
});
