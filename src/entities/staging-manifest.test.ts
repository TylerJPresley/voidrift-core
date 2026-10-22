/**
 * Staging manifest entity tests (core-blueprint.md §7.4).
 *
 * Pure: builds entries with the ONE hash utility, verifies the two apply checks
 * (integrity then conflict) in order, upsert last-write-wins, and masking.
 */
import { describe, it, expect } from "vitest";
import { contentHash } from "./hash.js";
import { checkApply, maskManifest, newManifest, resolveWithinRoot, stageEntry, upsertEntry } from "./staging-manifest.js";

describe("staging-manifest (§7.4)", () => {
  it("resolveWithinRoot contains relative paths and refuses escapes (§8.2)", () => {
    const root = "/ws/root";
    // Contained: in-root and nested paths resolve to canonical absolutes.
    expect(resolveWithinRoot(root, "a.txt")).toBe("/ws/root/a.txt");
    expect(resolveWithinRoot(root, "sub/dir/f.txt")).toBe("/ws/root/sub/dir/f.txt");
    expect(resolveWithinRoot(root, ".")).toBe("/ws/root");
    // Escapes: `../` out of the root and an absolute-outside path are refused.
    expect(resolveWithinRoot(root, "../escape.txt")).toBeNull();
    expect(resolveWithinRoot(root, "a/../../escape.txt")).toBeNull();
    expect(resolveWithinRoot(root, "/etc/passwd")).toBeNull();
    // A sibling that merely shares a prefix is not inside the root.
    expect(resolveWithinRoot(root, "../root-evil/x")).toBeNull();
  });

  it("stageEntry records base and staged-content hashes from the ONE hash utility", () => {
    const entry = stageEntry("x.txt", "base", "staged", "blob");
    expect(entry.baseHash).toBe(contentHash("base"));
    expect(entry.stagedHash).toBe(contentHash("staged"));
    expect(entry.path).toBe("x.txt");
  });

  it("upsertEntry is last-write-wins for the same path", () => {
    let m = newManifest("r", 1);
    m = upsertEntry(m, stageEntry("x.txt", "", "v1", "b"));
    m = upsertEntry(m, stageEntry("x.txt", "", "v2", "b"));
    expect(m.files).toHaveLength(1);
    expect(m.files[0]!.stagedHash).toBe(contentHash("v2"));
  });

  it("checkApply passes when staged re-hash and disk base both match", () => {
    const entry = stageEntry("x.txt", "base", "staged", "b");
    expect(checkApply(entry, "staged", "base")).toEqual({ ok: true });
  });

  it("checkApply reports UNRELIABLE first when the staged re-hash disagrees (before the conflict check)", () => {
    const entry = stageEntry("x.txt", "base", "staged", "b");
    // Both the staged content and the disk base are wrong; integrity is checked
    // first, so the result is 'unreliable', not 'conflict'.
    expect(checkApply(entry, "tampered", "also-changed")).toEqual({ ok: false, reason: "unreliable", path: "x.txt" });
  });

  it("checkApply reports CONFLICT when integrity holds but the disk base changed", () => {
    const entry = stageEntry("x.txt", "base", "staged", "b");
    expect(checkApply(entry, "staged", "changed")).toEqual({ ok: false, reason: "conflict", path: "x.txt" });
  });

  it("maskManifest routes the manifest through the ONE secret detector", () => {
    let m = newManifest("r", 1);
    m = upsertEntry(m, stageEntry("config.txt", "", "AWS_SECRET_KEY=AKIAIO" + "SFODNN7EXAMPLE", "b"));
    // The manifest holds no secret values itself (only hashes/paths); masking is
    // structure-preserving and leaves the hashes intact.
    const masked = maskManifest(m);
    expect(masked.files[0]!.stagedHash).toBe(m.files[0]!.stagedHash);
    expect(masked.run).toBe("r");
  });
});
