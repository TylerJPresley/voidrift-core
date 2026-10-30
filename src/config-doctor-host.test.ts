/**
 * Host-level `config.doctor` (core-blueprint.md §13.9.2): the exported
 * `doctorConfigHome` usable WITHOUT a core — no model, no network, no engine.
 * The CLI's `voidrift doctor` binds to it directly (CLI §2.1).
 *
 * Each test points `XDG_CONFIG_HOME` at its OWN private temp dir, like the
 * config-init host tests, and restores the environment before teardown.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { doctorConfigHome, initConfigHome, voidriftConfigDir } from "./boot.js";

let prevXdg: string | undefined;
const scratches: string[] = [];

async function isolate(): Promise<{ configDir: string; workspace: string }> {
  prevXdg = process.env["XDG_CONFIG_HOME"];
  const xdg = await fs.mkdtemp(path.join(os.tmpdir(), "vr-doctor-host-"));
  scratches.push(xdg);
  process.env["XDG_CONFIG_HOME"] = xdg;
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "vr-doctor-ws-"));
  scratches.push(workspace);
  return { configDir: voidriftConfigDir(), workspace };
}

/** A recursive snapshot of a directory tree: relative path → bytes. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else out.set(path.relative(root, abs), await fs.readFile(abs, "utf8"));
    }
  }
  await walk(root);
  return out;
}

afterEach(async () => {
  if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = prevXdg;
  while (scratches.length) await fs.rm(scratches.pop()!, { recursive: true, force: true });
});

describe("host-level config.doctor (§13.9.2)", () => {
  it("a seeded install reports groups and exits 0 offline, writing NOTHING", async () => {
    const { configDir, workspace } = await isolate();
    await initConfigHome({ scope: "global" });
    const before = await snapshot(configDir);
    const report = await doctorConfigHome({ offline: true, workspaceRoot: workspace });
    expect(report.groups.map((g) => g.id)).toContain("config");
    expect(report.exitCode).toBe(0);
    // READ-ONLY: the config tree is byte-for-byte unchanged.
    const after = await snapshot(configDir);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
  });

  it("works on a BROKEN config: the rejection is a finding, not a crash", async () => {
    const { configDir, workspace } = await isolate();
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, "config.json"), "{ not valid json", "utf8");
    const report = await doctorConfigHome({ offline: true, workspaceRoot: workspace });
    // The run completes and flags a config failure (exit 1), never throws.
    expect(report.exitCode).toBe(1);
    const configGroup = report.groups.find((g) => g.id === "config")!;
    expect(configGroup.findings.some((f) => f.status === "fail")).toBe(true);
  });

  it("offline skips every network check", async () => {
    const { workspace, configDir } = await isolate();
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ models: { x: { model: "m", baseUrl: "http://127.0.0.1:1/v1" } }, modelSelected: "x" }),
      "utf8",
    );
    const report = await doctorConfigHome({ offline: true, workspaceRoot: workspace });
    const ep = report.groups.find((g) => g.id === "models")!.findings.find((f) => f.id === "models.endpoint.x");
    expect(ep?.message).toContain("skipped (offline)");
  });

  it("warns on a legacy checkpoint store (auto_vacuum=0) and leaves the file BYTE-IDENTICAL (§5.2, §13.9.2)", async () => {
    const { workspace } = await isolate();
    const { DatabaseSync } = await import("node:sqlite");
    const stateDir = path.join(workspace, ".voidrift");
    await fs.mkdir(stateDir, { recursive: true });
    const dbPath = path.join(stateDir, "checkpoint.db");
    // A real legacy store: auto_vacuum=0 with a table and rows.
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA auto_vacuum=NONE");
    db.exec("CREATE TABLE checkpoints (thread_id TEXT, blob BLOB)");
    const stmt = db.prepare("INSERT INTO checkpoints VALUES (?, ?)");
    for (let i = 0; i < 20; i++) stmt.run(`t${i}`, "x".repeat(512));
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    db.close();
    await fs.chmod(dbPath, 0o600);

    const before = await fs.readFile(dbPath);
    const report = await doctorConfigHome({ offline: true, workspaceRoot: workspace });
    const vac = report.groups
      .find((g) => g.id === "storage")!
      .findings.find((f) => f.id === "storage.checkpoint-vacuum");
    expect(vac?.status).toBe("warn");
    expect(vac?.fix).toBe("voidrift init --vacuum");
    // READ-ONLY: doctor leaves the checkpoint store byte-for-byte unchanged.
    expect((await fs.readFile(dbPath)).equals(before)).toBe(true);
  });
});
