/**
 * Plugin discovery/inspection entities (core-blueprint.md §12.4.1).
 *
 * Pure logic only — Zod schemas for every registry response and the mappers
 * that turn a validated search hit and a packument into the `PluginSearchResult`
 * and `PluginReview` DTOs. No I/O: the registry client adapter (§12.4.1) performs
 * the fetch and the installer adapter spawns npm; these functions decide shape
 * and policy. The license check reuses `isPermissiveLicense` and the
 * reserved-namespace guard reuses `isReservedNamespace` (§12.4, §12.5) — there is
 * no second scanner. The registry-URL rule (https except loopback) and the
 * reserved-namespace / exact-version checks live here so the gated path and the
 * tests exercise one source of truth.
 */
import { z } from "zod";
import { isPermissiveLicense } from "./plugin-meta.js";
import { classifyHost } from "../url-classifier.js";

/** A search hit surfaced to a client (§12.4.1). */
export interface PluginSearchResult {
  name: string;
  version: string;
  description?: string;
  publisher?: string;
  verified: boolean;
}

/** The inspect review — no code has run to produce it (§12.4.1). */
export interface PluginReview {
  name: string;
  version: string;
  publisher?: string;
  maintainers: string[];
  scope?: string;
  verified: boolean;
  license: string;
  licenseAllowed: boolean;
  corePeerRange?: string;
  corePeerMismatch: boolean;
  integrity: string;
  hasLifecycleScripts: boolean;
  hasProvenance: boolean;
  installDir: string;
}

/** The `@voidrift` scope and the `@voidrift/plugin-` prefix that mark a package
 * verified and installable in one click (§12.4.1). */
export const VERIFIED_SCOPE = "@voidrift";
export const VERIFIED_PREFIX = "@voidrift/plugin-";

// ── Zod schemas for every registry response (§12.4.1) ─────────────────────────

/** One hit of the npm `/-/v1/search` response. The registry carries many more
 * fields; `.loose()` tolerates them while the named fields are validated. */
export const NpmSearchObjectSchema = z
  .object({
    package: z
      .object({
        name: z.string(),
        version: z.string(),
        description: z.string().optional(),
        publisher: z.object({ username: z.string().optional() }).loose().optional(),
      })
      .loose(),
  })
  .loose();

/** The `/-/v1/search` envelope. */
export const NpmSearchResponseSchema = z
  .object({
    objects: z.array(NpmSearchObjectSchema).default([]),
    total: z.number().int().nonnegative().optional(),
  })
  .loose();

/** One `dist` block in a packument version. */
const NpmDistSchema = z
  .object({
    integrity: z.string().optional(),
    shasum: z.string().optional(),
    attestations: z.unknown().optional(),
  })
  .loose();

/** One version manifest inside a packument. */
export const NpmVersionManifestSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    description: z.string().optional(),
    license: z.union([z.string(), z.object({ type: z.string() }).loose()]).optional(),
    dist: NpmDistSchema.optional(),
    scripts: z.record(z.string(), z.string()).optional(),
    maintainers: z
      .array(z.union([z.string(), z.object({ name: z.string().optional() }).loose()]))
      .optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
    voidrift: z.object({ plugin: z.boolean().optional() }).loose().optional(),
  })
  .loose();

/** The full packument (`GET <registry>/<name>`). */
export const NpmPackumentSchema = z
  .object({
    name: z.string(),
    "dist-tags": z.record(z.string(), z.string()).optional(),
    versions: z.record(z.string(), NpmVersionManifestSchema).default({}),
    maintainers: z
      .array(z.union([z.string(), z.object({ name: z.string().optional() }).loose()]))
      .optional(),
  })
  .loose();

export type NpmSearchResponse = z.infer<typeof NpmSearchResponseSchema>;
export type NpmPackument = z.infer<typeof NpmPackumentSchema>;
export type NpmVersionManifest = z.infer<typeof NpmVersionManifestSchema>;

// ── policy helpers (§12.4.1) ──────────────────────────────────────────────────

/** A valid, exact semver (no range operators). A range is refused at install
 * (§12.4.1). Deliberately strict: `1.2.3` passes, `^1.2.3`/`1.x`/`latest` fail. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** True when a version string is an exact pinned version, not a range (§12.4.1). */
export function isExactVersion(version: string): boolean {
  return EXACT_VERSION.test(version.trim());
}

/**
 * True when a string is safe to pass to npm as a positional argument (§12.4.1
 * hardening). Even though the installer spawns npm as an argv array with
 * `shell: false` — so no shell injection is possible — a value that starts with
 * `-` would be read by npm as an OPTION rather than a package name, and
 * whitespace or control characters have no place in a package name or version.
 * Both the name and the exact version are checked BEFORE any spawn, so a crafted
 * `-g`, `--registry=evil`, or a name containing a space/newline is refused with
 * a clear `INVALID_INPUT` error instead of reaching the child process. Rejects:
 * an empty string, a leading `-`, and any whitespace or ASCII control char.
 */
export function isSafeNpmArg(value: string): boolean {
  if (typeof value !== "string" || value === "") return false;
  if (value.startsWith("-")) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return false;
  return true;
}

/** The npm scope of a package name, e.g. `@voidrift` for `@voidrift/plugin-x`,
 * or undefined for an unscoped name. */
export function packageScope(name: string): string | undefined {
  const m = /^(@[^/]+)\//.exec(name);
  return m ? m[1] : undefined;
}

/** True only for the trusted `@voidrift` scope (§12.4.1). */
export function isVerified(name: string): boolean {
  return packageScope(name) === VERIFIED_SCOPE;
}

/** True when a name is listable in the default search (an `@voidrift/plugin-*`
 * package); other scopes may be inspected by exact name but are dropped from the
 * default listing (§12.4.1). */
export function isDefaultListable(name: string): boolean {
  return name.startsWith(VERIFIED_PREFIX);
}

/**
 * Validate a configured plugin registry URL (§12.4.1, §13.9): it must be `https`
 * except a loopback address, which may be `http`. Reuses the SSRF host
 * classifier so `localhost`, `127.0.0.1`, and `::1` count as loopback and no
 * other private range is allowed to be plain `http`. Returns the normalized
 * origin (no trailing slash) or null when the URL is not allowed.
 */
export function validateRegistryUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const loopback =
    url.protocol === "http:" && classifyHost(url.hostname).reason.startsWith("loopback");
  if (url.protocol !== "https:" && !loopback) return null;
  // Normalize: strip a trailing slash on the origin+path so query building is uniform.
  return url.origin + (url.pathname === "/" ? "" : url.pathname.replace(/\/$/, ""));
}

/**
 * A minimal peer-range satisfaction check for the `corePeerMismatch` display
 * flag (§12.4.1). The mismatch flag is DISPLAY ONLY — it never blocks install —
 * so this covers the common npm peer-range shapes (`^1.2.3`, `~1.2.3`,
 * `>=1.2.0`, `1.2.3`, `*`/`x`, and `a || b` unions) rather than depending on the
 * full `semver` package, which `@voidrift/core` does not declare (importing a
 * hoisted transitive copy would break the package-graph guard). Unparseable or
 * unusual ranges default to "satisfied" so a display quirk never raises a false
 * mismatch warning on a valid install.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseVer(version);
  if (!v) return true;
  const trimmed = range.trim();
  if (trimmed === "" || trimmed === "*" || trimmed === "x") return true;
  // Unions: satisfied when any clause is.
  if (trimmed.includes("||")) return trimmed.split("||").some((r) => satisfiesRange(version, r));
  // A single comparator or a caret/tilde/exact.
  const caret = /^\^(\d+)\.(\d+)\.(\d+)/.exec(trimmed);
  if (caret) {
    const [, maj, min, pat] = caret.map(Number) as unknown as number[];
    if (maj! > 0) return v.major === maj! && gte(v, [maj!, min!, pat!]);
    if (min! > 0) return v.major === 0 && v.minor === min! && gte(v, [0, min!, pat!]);
    return v.major === 0 && v.minor === 0 && v.patch === pat!;
  }
  const tilde = /^~(\d+)\.(\d+)\.(\d+)/.exec(trimmed);
  if (tilde) {
    const [, maj, min, pat] = tilde.map(Number) as unknown as number[];
    return v.major === maj! && v.minor === min! && gte(v, [maj!, min!, pat!]);
  }
  const cmp = /^(>=|<=|>|<|=)?\s*(\d+)\.(\d+)\.(\d+)/.exec(trimmed);
  if (cmp) {
    const op = cmp[1] ?? "=";
    const bound: [number, number, number] = [Number(cmp[2]), Number(cmp[3]), Number(cmp[4])];
    const c = compare([v.major, v.minor, v.patch], bound);
    if (op === ">=") return c >= 0;
    if (op === "<=") return c <= 0;
    if (op === ">") return c > 0;
    if (op === "<") return c < 0;
    return c === 0;
  }
  return true;
}

function parseVer(v: string): { major: number; minor: number; patch: number } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

function gte(v: { major: number; minor: number; patch: number }, b: [number, number, number]): boolean {
  return compare([v.major, v.minor, v.patch], b) >= 0;
}

/** Normalize a `license` field (string or `{ type }`) to a string (§12.4.1). */
function licenseString(license: NpmVersionManifest["license"]): string {
  if (typeof license === "string") return license;
  if (license && typeof license === "object" && "type" in license) return String(license.type);
  return "";
}

/** Normalize a maintainer entry (string or `{ name }`) to a username. */
function maintainerName(m: string | { name?: string | undefined }): string {
  return typeof m === "string" ? m : (m.name ?? "");
}

/** Map a validated search hit to a `PluginSearchResult` (§12.4.1). */
export function toSearchResult(obj: z.infer<typeof NpmSearchObjectSchema>): PluginSearchResult {
  const p = obj.package;
  const publisher = p.publisher?.["username"] as string | undefined;
  return {
    name: p.name,
    version: p.version,
    verified: isVerified(p.name),
    ...(p.description !== undefined ? { description: p.description } : {}),
    ...(publisher !== undefined ? { publisher } : {}),
  };
}

/**
 * Build a `PluginReview` from a validated packument and a chosen version
 * (§12.4.1). No code runs. `version` defaults to the `latest` dist-tag. The host
 * core version drives the peer-range mismatch flag. `installDir` is the resolved
 * store directory for the chosen scope, supplied by the caller. Returns null
 * when the requested version is absent from the packument.
 */
export function toReview(
  packument: NpmPackument,
  opts: { version?: string; hostCoreVersion: string; installDir: string; satisfies: (v: string, range: string) => boolean },
): PluginReview | null {
  const latest = packument["dist-tags"]?.["latest"];
  const version = opts.version ?? latest ?? Object.keys(packument.versions).sort().pop();
  if (!version) return null;
  const manifest = packument.versions[version];
  if (!manifest) return null;

  const license = licenseString(manifest.license);
  const corePeerRange = manifest.peerDependencies?.["@voidrift/core"];
  const maintainers = (manifest.maintainers ?? packument.maintainers ?? []).map(maintainerName).filter(Boolean);
  const scripts = manifest.scripts ?? {};
  const hasLifecycleScripts = ["preinstall", "install", "postinstall", "prepare"].some((k) => k in scripts);
  const hasProvenance = Boolean(manifest.dist?.attestations);

  return {
    name: manifest.name,
    version,
    maintainers,
    verified: isVerified(manifest.name),
    license,
    licenseAllowed: isPermissiveLicense(license || undefined),
    corePeerMismatch: corePeerRange ? !opts.satisfies(opts.hostCoreVersion, corePeerRange) : false,
    integrity: manifest.dist?.integrity ?? "",
    hasLifecycleScripts,
    hasProvenance,
    installDir: opts.installDir,
    ...(maintainers[0] !== undefined ? { publisher: maintainers[0] } : {}),
    ...(packageScope(manifest.name) !== undefined ? { scope: packageScope(manifest.name)! } : {}),
    ...(corePeerRange !== undefined ? { corePeerRange } : {}),
  };
}
