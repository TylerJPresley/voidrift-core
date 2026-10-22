/**
 * Shell adapter (core-blueprint.md §8.2).
 *
 * Runs a command rooted at `cwd` with a timeout, capturing combined output and
 * stripping ANSI escapes. The only place `node:child_process` is touched.
 */
import { spawn } from "node:child_process";
import type { ShellPort, ShellResult } from "../entities/ports/host.js";

const ANSI = /\u001b\[[0-9;]*m/g;

export class ShellAdapter implements ShellPort {
  async execute(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<ShellResult> {
    return new Promise<ShellResult>((resolve) => {
      const child = spawn(command, {
        shell: true,
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      });
      let output = "";
      const timeoutMs = opts?.timeoutMs ?? 30_000;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve({ exitCode: 124, output: output.replace(ANSI, "") });
      }, timeoutMs);
      child.stdout?.on("data", (d) => (output += String(d)));
      child.stderr?.on("data", (d) => (output += String(d)));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? 0, output: output.replace(ANSI, "") });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ exitCode: 1, output: String(e) });
      });
    });
  }
}
