/**
 * VoidRift-owned command runner (core-blueprint.md §8.2, §3.3/§5.2).
 *
 * `execute_command` (and the worker execute path) run through this instead of
 * deepagents' `LocalShellBackend.execute`, which owns its spawned child and
 * exposes no signal or process handle. The observable behaviour is IDENTICAL to
 * the backend — same shell, same argv shape (`spawn(command, { shell: true })`),
 * same env/cwd, same combined stdout + `[stderr]`-prefixed stderr output, the
 * same `<no output>` placeholder, the
 * same `Error: Command timed out after N.0 seconds.` / exit 124 on timeout, the same
 * `Error executing command: …` / exit 1 on spawn error, and the same trailing
 * `Exit code: N` line on a non-zero exit — so the §8.2 result strings and the
 * existing tests are unchanged for output WITHIN the cap.
 *
 * Oversized output (§8.2/§8.7): output over `tools.commandOutputMaxBytes` is no
 * longer cut mid-stream. With a run cache the FULL output is stored by reference
 * (`command-output` blob, capped at `run.entryMaxBytes`) and the model receives a
 * HEAD (`tools.commandHeadLines`) + TAIL (`tools.commandTailLines`) plus a
 * `[full output: <handle> …]` pointer readable in ranges with `read_file`; one
 * `LIMIT_HIT` and one `BY_REFERENCE` fire. Without a run cache the former inline
 * truncation marker is used (byte-identical fallback).
 *
 * What it adds: the child is spawned in its OWN process group (`detached: true`
 * → `setsid`-equivalent on Linux/macOS), so on abort or timeout the WHOLE group
 * is killed (`process.kill(-pid, …)`): SIGTERM first, then SIGKILL after a
 * bounded grace. A command's background grandchildren die with it, and no child
 * outlives the returned promise. An abort BEFORE spawn spawns nothing. (Windows:
 * the code targets Linux/macOS process groups; a Windows port would kill the
 * tree with `taskkill /T /F`.)
 */
import child_process from "node:child_process";
import { buildCommandEnv } from "../entities/command-env.js";
import { limitDefault } from "../entities/limits.js";
import { limitMarker, limitNotice, type LimitsPort } from "../entities/ports/limits-port.js";
import type { RunCache } from "../entities/ports/run-cache.js";
import { maskText } from "../use-cases/secret-mask.js";

/** Mirrors deepagents' `ExecuteResponse` so callers need no format change. */
export interface CommandResult {
  output: string;
  exitCode: number;
  truncated: boolean;
}

export interface RunCommandOptions {
  cwd: string;
  /** Child environment. Default (§8.2 "The environment is explicit state too"):
   * the host-variable allowlist `buildCommandEnv(process.env)` — PATH, HOME,
   * USER, LOGNAME, SHELL, LANG, LC_*, TERM, TMPDIR, TZ only, so no host secret
   * reaches a model-run command. An explicit value still wins. */
  env?: NodeJS.ProcessEnv;
  /** Hard timeout; the registry default `tools.commandTimeoutMs` (120 s) when
   * unset, byte-identical to deepagents' backend 120 s. An explicit value wins;
   * otherwise the limits port's effective value, else the registry default. */
  timeoutMs?: number;
  /** Output byte cap; deepagents' backend default is 100000. */
  maxOutputBytes?: number;
  /** The turn's shared AbortSignal (`session.cancel`). */
  signal?: AbortSignal;
  /** Grace between SIGTERM and SIGKILL when killing the group (default 500 ms). */
  killGraceMs?: number;
  /** §13.11 — the limits port. When present, the output byte cap and kill-grace
   * default come from the registry (`tools.commandOutputMaxBytes`,
   * `tools.commandKillGraceMs`) and a truncation emits one `LIMIT_HIT`. Absent,
   * the registry DEFAULTS are used (byte-identical to the old constants). */
  limits?: LimitsPort;
  /** §8.7/§7.2 — the run cache. When present, output OVER
   * `tools.commandOutputMaxBytes` is stored IN FULL (up to `run.entryMaxBytes`)
   * as a `command-output` blob and the model-facing result carries a HEAD
   * (`tools.commandHeadLines`) + TAIL (`tools.commandTailLines`) plus a
   * `[full output: <handle> …]` pointer read with `read_file`, never a mid-stream
   * cut. Absent → the inline truncation marker (byte-identical to before). */
  runCache?: RunCache;
  /** §7.2/§14.6 — report one `BY_REFERENCE` event when oversized output is stored
   * by reference. Optional; boot wires it to the event bus. Never any content. */
  onByReference?: (info: { what: string; bytes: number; key: string }) => void;
}

/** Assemble the combined stdout + `[stderr]`-prefixed stderr body exactly as
 * deepagents' `LocalShellBackend.execute` does, WITHOUT any size cap applied
 * (the cap is handled by the caller — inline truncation when there is no run
 * cache, by-reference storage when there is). */
function assembleBody(stdout: string, stderr: string): string {
  const outputParts: string[] = [];
  if (stdout) outputParts.push(stdout);
  if (stderr) {
    const stderrLines = stderr.trim().split("\n");
    outputParts.push(...stderrLines.map((line) => `[stderr] ${line}`));
  }
  return outputParts.length > 0 ? outputParts.join("\n") : "<no output>";
}

/** Inline truncation (the no-run-cache fallback): keep the backend-identical
 * marker, then name the key and how to get the rest the cut dropped (the dropped
 * tail is NOT returned). Byte-identical to the former behaviour. */
function truncateInline(body: string, maxOutputBytes: number): string {
  return (
    body.slice(0, maxOutputBytes) +
    `\n\n... Output truncated at ${maxOutputBytes} bytes. ${limitMarker("tools.commandOutputMaxBytes", maxOutputBytes)} The rest was not returned; raise limits.tools.commandOutputMaxBytes, or redirect to a file and read it by chunks (read_file with offset/limit).`
  );
}

/** The §8.2/§8.7 by-reference head+tail: the first `headLines` and last
 * `tailLines` of the FULL body plus a `[full output: <handle> …]` pointer. When
 * the stored blob was itself capped at `run.entryMaxBytes`, the marker says so
 * and names that key too (the full output exceeded even the per-blob cap). */
function headTailWithHandle(
  body: string,
  handle: { handle: string; bytes: number; lines: number },
  headLines: number,
  tailLines: number,
  storedWholeBytes: number,
): string {
  const lines = body.split("\n");
  const total = lines.length;
  const head = lines.slice(0, headLines).join("\n");
  const tail = lines.slice(Math.max(headLines, total - tailLines)).join("\n");
  const omitted = Math.max(0, total - headLines - tailLines);
  const capped =
    handle.bytes < storedWholeBytes
      ? ` The stored copy was itself capped at ${limitMarker("run.entryMaxBytes", handle.bytes)}.`
      : "";
  const sep = omitted > 0 ? `\n\n… ${omitted} line(s) omitted …\n\n` : "\n\n";
  return (
    `${head}${sep}${tail}` +
    `\n\n[full output: ${handle.handle} (${handle.lines} lines, ${handle.bytes} bytes) - read ranges with read_file]${capped}`
  );
}

/** Resolve the effective command timeout (§13.11, TOOL6): an explicit option
 * wins; otherwise the limits port's effective value; otherwise the registry
 * default (`tools.commandTimeoutMs`, 120 s). Exported so the registry default
 * and the runner's effective default cannot drift (one source). */
export function resolveCommandTimeoutMs(explicit: number | undefined, limits?: LimitsPort): number {
  return explicit ?? limits?.get("tools.commandTimeoutMs") ?? limitDefault("tools.commandTimeoutMs");
}

export function runCommand(command: string, opts: RunCommandOptions): Promise<CommandResult> {
  if (!command || typeof command !== "string") {
    return Promise.resolve({ output: "Error: Command must be a non-empty string.", exitCode: 1, truncated: false });
  }
  // §13.11 (TOOL6) — the timeout default comes from the registry
  // (`tools.commandTimeoutMs`, 120 s). An explicit option wins; else the port's
  // effective value, else the registry default (byte-identical to the former
  // hardcoded 120000). The output cap and kill-grace come from the registry too
  // (TOOL5/TOOL7).
  const timeoutMs = resolveCommandTimeoutMs(opts.timeoutMs, opts.limits);
  // §13.11 — the output cap and kill-grace come from the registry (TOOL5/TOOL7).
  // An explicit option still wins; otherwise the port's effective value, else the
  // registry default (byte-identical to the former 100000 / 500 constants).
  const maxOutputBytes = opts.maxOutputBytes ?? opts.limits?.get("tools.commandOutputMaxBytes") ?? limitDefault("tools.commandOutputMaxBytes");
  const graceMs = opts.killGraceMs ?? opts.limits?.get("tools.commandKillGraceMs") ?? limitDefault("tools.commandKillGraceMs");
  // §13.11 — the effective ACTION for the output cap (TOOL5). `warn` (the
  // default) never blocks: oversized output is truncated or stored by reference
  // and the run continues. `deny` refuses AT THE BOUND: as soon as the output
  // crosses `maxOutputBytes` the process group is killed through the existing
  // kill path (`tools.commandKillGraceMs`) and the tool returns its normal error
  // result whose one-line message is the notice (key, value, raise path); the
  // output past the bound is NEVER delivered. The limits port exposes `action`
  // directly; absent (no port wired) the registry default `warn` stands.
  const outputAction = opts.limits?.action("tools.commandOutputMaxBytes") ?? "warn";
  const { signal } = opts;

  // Abort BEFORE spawn: never launch a child (§3.3).
  if (signal?.aborted) {
    return Promise.resolve({ output: "Command cancelled.", exitCode: 1, truncated: false });
  }

  return new Promise<CommandResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let deniedOverCap = false;
    let killTimer: NodeJS.Timeout | undefined;

    const child = child_process.spawn(command, {
      shell: true,
      detached: true, // own process group so the WHOLE tree can be signalled
      // §8.2 ("The environment is explicit state too") — a model-run command
      // gets ONLY the host-variable allowlist (`buildCommandEnv`), never the
      // full inherited env, so a host secret (OPENAI_API_KEY, AWS_*, …) is never
      // visible to it. An explicit `opts.env` still wins (the git/MCP paths and
      // any caller that must set its own env). This ONE default covers
      // execute_command, the `wait` `check`, and a worker's command — all route
      // through here with no `env`.
      env: opts.env ?? buildCommandEnv(process.env),
      cwd: opts.cwd,
    });

    // Kill the whole process group (negative pid). Fall back to the child alone
    // if the group signal fails (e.g. the group is already gone).
    const killGroup = (sig: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already dead */
        }
      }
    };

    const scheduleHardKill = (): void => {
      if (killTimer) return;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), graceMs);
      killTimer.unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      scheduleHardKill();
    }, timeoutMs);

    const onAbort = (): void => {
      cancelled = true;
      scheduleHardKill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = (): void => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
    };

    // §13.11 deny — once the accumulated output crosses the byte cap, refuse at
    // the bound: trip the flag ONCE and kill the group through the existing path
    // (SIGTERM then SIGKILL after the grace). Further data is ignored; the close
    // handler turns `deniedOverCap` into the error result + one LIMIT_HIT.
    const enforceDeny = (): void => {
      if (deniedOverCap) return;
      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > maxOutputBytes) {
        deniedOverCap = true;
        scheduleHardKill();
      }
    };

    child.stdout.on("data", (data) => {
      stdout += String(data);
      if (outputAction === "deny") enforceDeny();
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
      if (outputAction === "deny") enforceDeny();
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ output: `Error executing command: ${err.message}`, exitCode: 1, truncated: false });
    });

    child.on("close", (code, sig) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (cancelled) {
        resolve({ output: "Command cancelled.", exitCode: 1, truncated: false });
        return;
      }
      // §13.11 deny — the output crossed the cap and the group was killed at the
      // bound. Return the NORMAL error result shape whose one-line message is the
      // notice (key, value, raise path); the output past the bound is NOT
      // delivered. Exactly one LIMIT_HIT fires with action `deny` (the port dedups
      // per key per turn). Checked before the timeout branch because the deny kill
      // also surfaces as `sig === "SIGTERM"`.
      if (deniedOverCap) {
        const value = opts.limits?.get("tools.commandOutputMaxBytes") ?? maxOutputBytes;
        opts.limits?.hit("tools.commandOutputMaxBytes", value, { what: "command output over deny cap" });
        const notice = `Error: ${limitNotice("command output refused", "tools.commandOutputMaxBytes", value)}`;
        resolve({ output: notice, exitCode: 1, truncated: true });
        return;
      }
      if (timedOut || sig === "SIGTERM") {
        // §13.11 (TOOL6, owner 2026-10-29) — the command timeout STAYS `deny` (a
        // command that never times out hangs the run), but a FIRED timeout emits
        // exactly ONE `LIMIT_HIT {key,area,value,action,observed}` naming the key
        // and the raise path, so the kill is discoverable in the trail. The port
        // dedups per key per turn; absent (no port wired) nothing is emitted.
        opts.limits?.hit("tools.commandTimeoutMs", timeoutMs, { what: "command timed out — process group killed" });
        resolve({ output: `Error: Command timed out after ${(timeoutMs / 1000).toFixed(1)} seconds.`, exitCode: 124, truncated: false });
        return;
      }
      const body = assembleBody(stdout, stderr);
      const exitCode = code ?? 1;
      const over = Buffer.byteLength(body, "utf8") > maxOutputBytes;
      let rendered = body;
      let truncated = false;

      if (over) {
        truncated = true;
        if (opts.runCache) {
          // §8.7/§7.2 — store the FULL output by reference (the run cache caps it
          // at `run.entryMaxBytes` itself) and hand the model a HEAD+TAIL plus a
          // `read_file` handle, never a mid-stream cut.
          const headLines = opts.limits?.get("tools.commandHeadLines") ?? limitDefault("tools.commandHeadLines");
          const tailLines = opts.limits?.get("tools.commandTailLines") ?? limitDefault("tools.commandTailLines");
          // §10.10 (MED) — the blob persists in the run cache and is re-readable
          // by `read_file`, so MASK secrets before it is stored (the same shared
          // `maskText` the task text already uses). The inline HEAD/TAIL below keep
          // today's behaviour (a bounded sample of the raw body); only the stored
          // blob is masked. The handle's byte/line counts reflect the stored
          // (masked) copy.
          const masked = maskText(body);
          const wholeBytes = Buffer.byteLength(masked, "utf8");
          const handle = opts.runCache.store("command-output", masked);
          rendered = headTailWithHandle(body, handle, headLines, tailLines, wholeBytes);
          opts.onByReference?.({ what: "command output", bytes: handle.bytes, key: "tools.commandOutputMaxBytes" });
        } else {
          // No run cache (e.g. a worker without one) — the inline truncation
          // marker, byte-identical to the former behaviour.
          rendered = truncateInline(body, maxOutputBytes);
        }
        // §13.11 — one LIMIT_HIT naming the cap; the notice is the CLI's dim line.
        opts.limits?.hit("tools.commandOutputMaxBytes", maxOutputBytes, { what: "command output over inline cap" });
      }

      const output = exitCode !== 0 ? `${rendered.trimEnd()}\n\nExit code: ${exitCode}` : rendered;
      resolve({ output, exitCode, truncated });
    });
  });
}
