/**
 * Hermetic global setup (per-package; carried by this package so it stays
 * independently publishable — NO shared cross-package file).
 *
 * This is a vitest `globalSetup`: it runs ONCE in the MAIN process BEFORE any
 * worker starts, and its returned teardown runs ONCE in the MAIN process AFTER
 * every worker has finished. vitest's teardown ALWAYS runs (unlike a worker
 * `process.on('exit')` handler, which thread/fork workers are terminated
 * without ever invoking — the source of the `/tmp/vr-hermetic-*` leak this
 * owns the lifetime of the temp root to fix).
 *
 * It owns the ONE temp root for the whole run:
 *   1. Capture a fingerprint of the REAL `~/.config/voidrift` from the ORIGINAL
 *      environment, BEFORE any redirection.
 *   2. Create a single `mkdtemp` root (`/tmp/vr-hermetic-XXXXXX`) with `home/`,
 *      `xdg/` (and on win32 `appdata/`) subdirs and point `process.env.HOME`,
 *      `XDG_CONFIG_HOME` (and `APPDATA`) at them. The main process forks/spawns
 *      its workers AFTER this runs, so every worker inherits the redirected
 *      environment (vitest's default `forks`/`threads` pools both pass
 *      `process.env` to workers at creation). The per-worker setup
 *      (`test-hermetic.ts`) only ASSERTS the redirect is in place; it never
 *      creates a directory, which is why the leak is gone.
 *   3. On teardown: re-read the real dir and THROW (failing the run with a
 *      non-zero exit) if anything was added, removed, or touched — the late
 *      write a fire-and-forget `ObsWriter` append could cause after a worker's
 *      own `afterAll` already passed. THEN remove the temp root recursively
 *      (tolerant of a late recreate, which is harmless — it lives inside the
 *      temp tree, never the real dir).
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** Resolve the real `~/.config/voidrift` the way the core's resolver does, from
 * the ORIGINAL environment captured before any redirection. */
function realConfigDir(env: { xdg?: string | undefined; home?: string | undefined }): string {
  const home = env.home ?? os.homedir();
  const base = env.xdg ?? path.join(home, ".config");
  return path.join(base, "voidrift");
}

/** Map of relative path -> mtimeMs for every file under `dir`. */
function fingerprint(dir: string): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        try {
          out.set(path.relative(dir, full), fs.statSync(full).mtimeMs);
        } catch {
          /* a vanished file does not count */
        }
      }
    }
  };
  walk(dir);
  return out;
}

export default function setup(): () => void {
  // Capture the real dir and its fingerprint from the ORIGINAL environment,
  // BEFORE redirecting — this is the only place the real environment is still
  // visible.
  const realDir = realConfigDir({
    xdg: process.env["XDG_CONFIG_HOME"],
    home: process.env["HOME"],
  });
  const before = fingerprint(realDir);

  // Create the ONE temp root for the whole run and redirect the environment at
  // its subdirectories. Workers fork/spawn after this and inherit the change.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vr-hermetic-"));
  const xdg = path.join(tmp, "xdg");
  const home = path.join(tmp, "home");
  fs.mkdirSync(xdg, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  process.env["XDG_CONFIG_HOME"] = xdg;
  process.env["HOME"] = home;
  if (process.platform === "win32") {
    const appdata = path.join(tmp, "appdata");
    fs.mkdirSync(appdata, { recursive: true });
    process.env["APPDATA"] = appdata;
  }

  // The teardown runs in the MAIN process after all workers exit, and vitest
  // always runs it — the guarantee the per-worker `process.on('exit')` handler
  // never gave.
  return () => {
    const after = fingerprint(realDir);
    const changed: string[] = [];
    for (const [p, m] of after) {
      const prev = before.get(p);
      if (prev === undefined) changed.push(`added:   ${p}`);
      else if (prev !== m) changed.push(`touched: ${p}`);
    }
    for (const p of before.keys()) {
      if (!after.has(p)) changed.push(`removed: ${p}`);
    }
    // Check the real dir FIRST, then remove the temp root — recursive and
    // tolerant of a late recreate.
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort; a late write recreating it is harmless (inside temp tree) */
    }
    if (changed.length > 0) {
      throw new Error(
        `hermetic late-write leak: the real config dir ${realDir} changed during the test run ` +
          `(a worker wrote to the user's real ~/.config/voidrift after its afterAll check passed). ` +
          `Offending paths:\n  ${changed.join("\n  ")}`,
      );
    }
  };
}
