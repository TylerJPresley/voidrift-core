import { describe, it, expect } from "vitest";
import {
  isExactVersion,
  isSafeNpmArg,
  packageScope,
  isVerified,
  isDefaultListable,
  validateRegistryUrl,
  satisfiesRange,
  toSearchResult,
  toReview,
  NpmSearchResponseSchema,
  NpmPackumentSchema,
} from "./plugin-registry.js";

describe("plugin-registry entity (§12.4.1)", () => {
  describe("isSafeNpmArg — a flag-like or whitespace/control value is refused before spawn", () => {
    it("accepts ordinary names and versions", () => {
      for (const s of ["@voidrift/plugin-x", "lodash", "1.2.3", "2.0.0-beta.1", "a_b.c"]) {
        expect(isSafeNpmArg(s)).toBe(true);
      }
    });
    it("rejects a leading dash so a crafted value can never be read as an npm flag", () => {
      for (const s of ["-g", "-x", "--registry=evil", "--force", "-"]) {
        expect(isSafeNpmArg(s)).toBe(false);
      }
    });
    it("rejects whitespace and control characters", () => {
      for (const s of ["foo bar", "foo\tbar", "foo\nbar", "foo\rbar", "foo\x00bar", "foo\x1bbar", " leading", "trailing "]) {
        expect(isSafeNpmArg(s)).toBe(false);
      }
    });
    it("rejects an empty string", () => {
      expect(isSafeNpmArg("")).toBe(false);
    });
  });

  describe("isExactVersion — a range is refused", () => {
    it("accepts exact pins and rejects ranges", () => {
      for (const v of ["1.2.3", "0.0.0", "2.0.0-beta.1", "1.2.3+build"]) {
        expect(isExactVersion(v)).toBe(true);
      }
      for (const v of ["^1.2.3", "~1.2.3", ">=1.0.0", "1.x", "1.2", "latest", "*", ""]) {
        expect(isExactVersion(v)).toBe(false);
      }
    });
  });

  describe("scope and verified flags", () => {
    it("marks only the @voidrift scope verified", () => {
      expect(packageScope("@voidrift/plugin-x")).toBe("@voidrift");
      expect(packageScope("some-pkg")).toBeUndefined();
      expect(isVerified("@voidrift/plugin-x")).toBe(true);
      expect(isVerified("@acme/plugin-x")).toBe(false);
      expect(isVerified("plugin-x")).toBe(false);
    });
    it("lists only @voidrift/plugin-* by default", () => {
      expect(isDefaultListable("@voidrift/plugin-foo")).toBe(true);
      expect(isDefaultListable("@voidrift/core")).toBe(false);
      expect(isDefaultListable("@acme/plugin-foo")).toBe(false);
    });
  });

  describe("validateRegistryUrl — https except loopback", () => {
    it("allows https anywhere", () => {
      expect(validateRegistryUrl("https://registry.npmjs.org")).toBe("https://registry.npmjs.org");
      expect(validateRegistryUrl("https://mirror.corp.example/npm")).toBe("https://mirror.corp.example/npm");
    });
    it("allows http only for loopback", () => {
      expect(validateRegistryUrl("http://127.0.0.1:4873")).toBe("http://127.0.0.1:4873");
      expect(validateRegistryUrl("http://localhost:4873")).toBe("http://localhost:4873");
      expect(validateRegistryUrl("http://[::1]:4873")).toBe("http://[::1]:4873");
    });
    it("rejects http on a non-loopback host and a private LAN IP", () => {
      expect(validateRegistryUrl("http://registry.npmjs.org")).toBeNull();
      expect(validateRegistryUrl("http://10.0.0.5:4873")).toBeNull();
      expect(validateRegistryUrl("http://192.168.1.9")).toBeNull();
      expect(validateRegistryUrl("ftp://x")).toBeNull();
      expect(validateRegistryUrl("not a url")).toBeNull();
    });
  });

  describe("satisfiesRange — display-only peer mismatch flag", () => {
    it("handles caret/tilde/exact/comparators/unions", () => {
      expect(satisfiesRange("1.4.0", "^1.2.0")).toBe(true);
      expect(satisfiesRange("2.0.0", "^1.2.0")).toBe(false);
      expect(satisfiesRange("1.2.9", "~1.2.0")).toBe(true);
      expect(satisfiesRange("1.3.0", "~1.2.0")).toBe(false);
      expect(satisfiesRange("1.2.3", "1.2.3")).toBe(true);
      expect(satisfiesRange("1.2.0", ">=1.0.0")).toBe(true);
      expect(satisfiesRange("0.9.0", ">=1.0.0")).toBe(false);
      expect(satisfiesRange("2.0.0", "^1.0.0 || ^2.0.0")).toBe(true);
      expect(satisfiesRange("1.0.0", "*")).toBe(true);
    });
    it("defaults to satisfied on an unparseable range", () => {
      expect(satisfiesRange("1.0.0", "workspace:*")).toBe(true);
    });
  });

  describe("toSearchResult", () => {
    it("maps a validated hit and flags verification", () => {
      const parsed = NpmSearchResponseSchema.parse({
        objects: [
          { package: { name: "@voidrift/plugin-x", version: "1.0.0", description: "d", publisher: { username: "alice" } } },
        ],
      });
      const r = toSearchResult(parsed.objects[0]!);
      expect(r).toEqual({ name: "@voidrift/plugin-x", version: "1.0.0", description: "d", publisher: "alice", verified: true });
    });
  });

  describe("toReview — no code runs", () => {
    const packument = NpmPackumentSchema.parse({
      name: "@voidrift/plugin-x",
      "dist-tags": { latest: "1.0.0" },
      versions: {
        "1.0.0": {
          name: "@voidrift/plugin-x",
          version: "1.0.0",
          license: "Apache-2.0",
          dist: { integrity: "sha512-abc" },
          scripts: { postinstall: "node evil.js" },
          maintainers: [{ name: "alice" }],
          peerDependencies: { "@voidrift/core": "^1.0.0" },
          voidrift: { plugin: true },
        },
      },
    });
    it("reports license, integrity, scripts, peer range + mismatch, provenance", () => {
      const review = toReview(packument, {
        hostCoreVersion: "1.4.0",
        installDir: "/store",
        satisfies: satisfiesRange,
      });
      expect(review).toMatchObject({
        name: "@voidrift/plugin-x",
        version: "1.0.0",
        verified: true,
        license: "Apache-2.0",
        licenseAllowed: true,
        integrity: "sha512-abc",
        hasLifecycleScripts: true,
        hasProvenance: false,
        corePeerRange: "^1.0.0",
        corePeerMismatch: false,
        scope: "@voidrift",
        installDir: "/store",
      });
    });
    it("flags a copyleft license as not allowed and a peer mismatch", () => {
      const gpl = NpmPackumentSchema.parse({
        name: "@voidrift/plugin-g",
        "dist-tags": { latest: "2.0.0" },
        versions: {
          "2.0.0": {
            name: "@voidrift/plugin-g",
            version: "2.0.0",
            license: "GPL-3.0",
            dist: { integrity: "sha512-g" },
            peerDependencies: { "@voidrift/core": "^9.0.0" },
          },
        },
      });
      const review = toReview(gpl, { hostCoreVersion: "1.4.0", installDir: "/s", satisfies: satisfiesRange })!;
      expect(review.licenseAllowed).toBe(false);
      expect(review.corePeerMismatch).toBe(true);
    });
    it("returns null for an absent version", () => {
      expect(toReview(packument, { version: "9.9.9", hostCoreVersion: "1.0.0", installDir: "/s", satisfies: satisfiesRange })).toBeNull();
    });
  });
});
