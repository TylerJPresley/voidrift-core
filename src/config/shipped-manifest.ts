/**
 * The known-shipped manifest (core-blueprint.md §13.9.1).
 *
 * The package ships `seed/shipped-hashes.json`: for every seeded relative path
 * (each agent's `agent.json`/`prompt.md`, each skill's `SKILL.md`) and the
 * synthetic `permissions` key (the seeded allow-rule set), the sha256 of every
 * RELEASED version of that content — CURRENT first, previous versions kept
 * after it. `config.init --update` (§13.9.1) and `doctor` DRIFT (§13.9.2) read
 * it to tell:
 *  - an UNMODIFIED older default (installed hash === a PREVIOUS shipped hash):
 *    safe to refresh with `voidrift init --update`;
 *  - a CUSTOMIZED file (installed hash matches NO shipped hash): never touched,
 *    reset with `voidrift init --reset <name>`.
 *
 * The manifest is appended to by `scripts/update-shipped-hashes.mjs`; the
 * completeness test (`shipped-manifest.test.ts`) fails until the current seed
 * hash is registered, so a seed change can never silently drop out of the
 * manifest.
 *
 * Pure: hashing is `node:crypto` (allowed in a use-case-free config helper, no
 * port needed — it is deterministic content hashing, not I/O).
 */
import { createHash } from "node:crypto";
import type { PermissionRule } from "./schema.js";

/** The manifest document shape. `entries` maps a seeded relative path (and the
 * synthetic `permissions` key) to its released hashes, current first. */
export interface ShippedManifest {
  version: number;
  entries: Record<string, string[]>;
}

/** sha256 of UTF-8 content — the manifest's hash function (§13.9.1). */
export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** The canonical serialization of the seeded allow-rule set the manifest hashes
 * under `permissions`. Keyed ids sorted so the fingerprint is order-stable.
 * MUST match `permissionsFingerprint` in `scripts/update-shipped-hashes.mjs`. */
export function permissionsFingerprint(perms: Record<string, PermissionRule>): string {
  const ids = Object.keys(perms).sort();
  return JSON.stringify(ids.map((id) => [id, perms[id]] as const));
}

/** How an installed file's content relates to the manifest for its path. */
export type ManifestStatus =
  | "current" // hash equals the current (first) shipped hash
  | "stale" // hash equals a PREVIOUS shipped hash — an unmodified older default
  | "customized" // hash matches no shipped hash — the user changed it
  | "unknown"; // the manifest has no entry for this path

/** Classify installed `content` for the seeded relative path `rel` against the
 * manifest (§13.9.1). `null`/empty manifest entry ⇒ `unknown`. */
export function classifyAgainstManifest(
  manifest: ShippedManifest,
  rel: string,
  content: string,
): ManifestStatus {
  const hashes = manifest.entries[rel];
  if (!hashes || hashes.length === 0) return "unknown";
  const h = sha256(content);
  if (h === hashes[0]) return "current";
  return hashes.includes(h) ? "stale" : "customized";
}
