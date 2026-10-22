#!/usr/bin/env node
/**
 * Append the CURRENT seed hashes to the known-shipped manifest
 * (`seed/shipped-hashes.json`, core-blueprint.md §13.9.1).
 *
 * The manifest lists, for every seeded relative path, the sha256 of every
 * released version of that file — CURRENT first, each previous version kept
 * after it — plus a synthetic `permissions` entry for the seeded allow-rule
 * set. `config.init --update` and `doctor` DRIFT read it to tell an unmodified
 * older default (its hash matches SOME shipped version) from a customization
 * (its hash matches NONE), §13.9.1/§13.9.2.
 *
 * This script is the one way a future seed change registers itself: run it
 * after editing a seed file so the new hash is prepended and the previous ones
 * are kept. The manifest-completeness test (`shipped-manifest.test.ts`) FAILS
 * until the current hash is present, so every seed change must be registered.
 *
 * No dependency: it imports the already-built core to reach `seedPermissions`
 * and hashes the seed files with `node:crypto`. Run with
 * `npm run manifest:update -w @voidrift/core` (documented in package.json).
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const seedDir = path.join(pkgRoot, "seed");
const manifestPath = path.join(seedDir, "shipped-hashes.json");

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** The canonical serialization of the seeded allow-rule set — the one the
 * manifest hashes under `permissions`. Must match `permissionsFingerprint`
 * in `src/config/shipped-manifest.ts`. */
function permissionsFingerprint(perms) {
  const ids = Object.keys(perms).sort();
  return JSON.stringify(ids.map((id) => [id, perms[id]]));
}

/** Enumerate the seeded relative paths under `seed/` (agents + skills). */
async function seedPaths() {
  const out = [];
  for (const kind of ["agents", "skills"]) {
    const base = path.join(seedDir, kind);
    if (!existsSync(base)) continue;
    for (const name of (await readdir(base)).sort()) {
      const dir = path.join(base, name);
      for (const file of (await readdir(dir)).sort()) {
        out.push(path.posix.join(kind, name, file));
      }
    }
  }
  return out;
}

async function main() {
  // Load the built core to reach seedPermissions (its only use here).
  const core = await import(path.join(pkgRoot, "dist", "index.js")).catch(() => null);
  if (!core || typeof core.seedPermissions !== "function") {
    console.error("manifest:update needs a built core (run `npm run build -w @voidrift/core` first)");
    process.exit(1);
  }

  const manifest = existsSync(manifestPath)
    ? JSON.parse(await readFile(manifestPath, "utf8"))
    : { version: 1, entries: {} };
  manifest.entries ??= {};

  const prepend = (rel, hash) => {
    const list = manifest.entries[rel] ?? [];
    if (list[0] === hash) return; // already current
    manifest.entries[rel] = [hash, ...list.filter((h) => h !== hash)];
  };

  for (const rel of await seedPaths()) {
    prepend(rel, sha256(await readFile(path.join(seedDir, rel), "utf8")));
  }
  prepend("permissions", sha256(permissionsFingerprint(core.seedPermissions())));

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`updated ${path.relative(pkgRoot, manifestPath)} (${Object.keys(manifest.entries).length} entries)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
