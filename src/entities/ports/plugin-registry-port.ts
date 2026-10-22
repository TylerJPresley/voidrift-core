/**
 * The plugin discovery ports (core-blueprint.md §12.4.1).
 *
 * Two seams keep the Plugins capability pure and testable OFFLINE:
 *
 * - `PluginRegistryPort` — the npm registry HTTP boundary. Its one method does a
 *   single GET and returns the raw status/body text; the use-case validates the
 *   body with Zod and never trusts the shape. An injected fake drives every
 *   search/inspect test with no network. A `429`, an oversized body, or an
 *   offline error are surfaced as data (`status`, `tooLarge`, `errored`), never
 *   thrown, so the use-case degrades to the last cached page (§12.4.1).
 * - `PluginInstallerPort` — the `npm install` boundary. It spawns npm as an argv
 *   array (no shell), under a scrubbed environment, with a timeout and a size
 *   cap, into the target store dir, and rolls back what it wrote on failure. A
 *   fake installer drives the refusal/verification unit tests; the real adapter
 *   is exercised by the one end-to-end test against a local fake registry.
 */

/** One registry GET result. The body is text; the use-case parses + validates
 * it. `tooLarge` marks a response that exceeded the byte cap; `errored` marks a
 * transport failure (offline, DNS, timeout). Both degrade, never throw. */
export interface RegistryFetchResult {
  status: number;
  body: string;
  tooLarge: boolean;
  errored: boolean;
}

export interface PluginRegistryPort {
  /** GET an absolute registry URL with a timeout and a response byte cap. Never
   * throws: a transport failure returns `{ errored: true }`. */
  get(url: string, opts: { timeoutMs: number; maxBytes: number }): Promise<RegistryFetchResult>;
}

/** The request the capability hands the installer after every policy check has
 * passed (exact version, integrity bound, license, name, confirm). */
export interface PluginInstallRequest {
  name: string;
  version: string;
  installDir: string;
  registry: string;
  timeoutMs: number;
  maxBytes: number;
}

/** The outcome of an install attempt. On success `packageDir` is the resolved
 * installed package directory for post-install verification; on failure the
 * installer has already rolled back what it wrote. */
export interface PluginInstallResult {
  ok: boolean;
  packageDir?: string;
  reason?: string;
}

export interface PluginInstallerPort {
  /** Spawn `npm install <name>@<version> --prefix <dir> --ignore-scripts
   * --no-audit --no-fund --save-exact --registry <registry>` as argv under a
   * scrubbed env, with a timeout and a size cap; roll back on any failure. */
  install(req: PluginInstallRequest): Promise<PluginInstallResult>;
  /** Remove an installed package directory (rollback on verification failure). */
  rollback(installDir: string, name: string): Promise<void>;
}
