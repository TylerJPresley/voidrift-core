/**
 * Plugin metadata and the license allowlist (core-blueprint.md §12.4).
 *
 * `PluginMeta` is derived from a resolved package's `package.json`. The license
 * check is enforced at discovery: a plugin whose own license, or any dependency
 * license, is not on the permissive allowlist is rejected — its `register` is
 * never called (§1, §12.4). Pure logic; the loader adapter reads the files and
 * walks the dependency tree.
 */

/** The metadata surfaced by `plugins.list` and used for enable/disable (§12.4). */
export interface PluginMeta {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  license?: string;
  homepage?: string;
  /** True when the plugin is listed and enabled; a bare candidate is false (§12.4). */
  active: boolean;
  /** The config layer that enabled the plugin (§12.4.1); absent for a bare
   * node_modules candidate not enabled by any layer. */
  source?: "managed" | "global" | "project" | "session";
  /** True when the enabled entry supplied a non-empty `options` object (§12.4).
   * Value-free: it says WHETHER options were provided, never what they are, so
   * `plugins.list`/`access`/`doctor` can flag an exporter with no config. */
  hasOptions?: boolean;
}

/** A plugin package's `package.json`, the fields the loader reads (§12.4). */
export interface PackageManifest {
  name?: string;
  version?: string;
  description?: string;
  author?: unknown;
  license?: string;
  homepage?: string;
  voidrift?: { kind?: string; plugin?: boolean; description?: string };
  dependencies?: Record<string, string>;
}

/**
 * The permissive license allowlist (§12.4, §1). SPDX identifiers normalized to
 * upper-case. Copyleft (GPL/AGPL/LGPL) is rejected. The allowlist is the set of
 * families; `isPermissiveLicense` matches an SPDX expression against it.
 */
export const PERMISSIVE_LICENSES = new Set([
  "APACHE-2.0",
  "MIT",
  "MIT-0",
  "BSD",
  "BSD-2-CLAUSE",
  "BSD-3-CLAUSE",
  "0BSD",
  "ISC",
  "UNLICENSE",
  "CC0-1.0",
  "WTFPL",
  "BLUEOAK-1.0.0",
  "PYTHON-2.0",
  "ZLIB",
]);

/**
 * True when every license token in an SPDX expression is on the permissive
 * allowlist (§12.4). An expression like `(MIT OR Apache-2.0)` passes when any
 * leaf passes; a conjunction `A AND B` passes only when all pass. A missing or
 * unparseable license fails closed.
 */
export function isPermissiveLicense(license: string | undefined): boolean {
  if (!license || license.trim() === "") return false;
  const expr = license.trim().toUpperCase();
  // Handle the common SPDX shapes: OR means "pick a compatible one", AND means all.
  if (expr.includes(" OR ")) {
    return expr.split(" OR ").some((part) => isPermissiveLicense(part.replace(/[()]/g, "").trim()));
  }
  if (expr.includes(" AND ")) {
    return expr.split(" AND ").every((part) => isPermissiveLicense(part.replace(/[()]/g, "").trim()));
  }
  const token = expr.replace(/[()]/g, "").replace(/\+$/, "").trim();
  return PERMISSIVE_LICENSES.has(token);
}

/** True when a license is explicitly copyleft and must be rejected (§12.4). */
export function isCopyleftLicense(license: string | undefined): boolean {
  if (!license) return false;
  const expr = license.trim().toUpperCase();
  return /\b([AL]?GPL)(-|\b)/.test(expr);
}

/** True when a package.json declares the `voidrift.plugin` flag (§12.4). */
export function isPluginManifest(pkg: PackageManifest): boolean {
  return pkg.voidrift?.plugin === true;
}

/** Build a `PluginMeta` from a resolved package manifest (§12.4). */
export function toPluginMeta(pkg: PackageManifest, active: boolean): PluginMeta {
  const author =
    typeof pkg.author === "string"
      ? pkg.author
      : pkg.author && typeof pkg.author === "object" && "name" in pkg.author
        ? String((pkg.author as { name: unknown }).name)
        : undefined;
  return {
    id: pkg.name ?? "unknown",
    name: pkg.name ?? "unknown",
    version: pkg.version ?? "0.0.0",
    description: pkg.voidrift?.description ?? pkg.description ?? "",
    active,
    ...(author !== undefined ? { author } : {}),
    ...(pkg.license !== undefined ? { license: pkg.license } : {}),
    ...(pkg.homepage !== undefined ? { homepage: pkg.homepage } : {}),
  };
}
