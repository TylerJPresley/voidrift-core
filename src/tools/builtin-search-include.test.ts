/**
 * `search_contents {include}` path-style handling (core-blueprint.md §8.2).
 * The harness is LIBERAL: a path-style include is taken apart into a path
 * restriction (literal leading dirs, `**` ignored) plus the filename glob (the
 * last segment); a glob in the directory part is rejected. The derived
 * directory folds into `path` or the workspace root (confinement by the backend
 * is tested in the filesystem adapter; here we assert the derived root string).
 */
import { describe, it, expect } from "vitest";
import { parseSearchInclude, SEARCH_INCLUDE_BAD_DIR } from "./builtin.js";

describe("parseSearchInclude (§8.2)", () => {
  it("`src/**/*.ts` with no path → root `src`, filename glob `*.ts` (** ignored)", () => {
    expect(parseSearchInclude("src/**/*.ts", undefined)).toEqual({ root: "src", include: "*.ts" });
  });

  it("`src/**/*.ts` with path `pkg` → root `pkg/src` (folded into path)", () => {
    expect(parseSearchInclude("src/**/*.ts", "pkg")).toEqual({ root: "pkg/src", include: "*.ts" });
  });

  it("`*.ts` (no separator) is unchanged — root stays the path/default", () => {
    expect(parseSearchInclude("*.ts", undefined)).toEqual({ root: ".", include: "*.ts" });
    expect(parseSearchInclude("*.ts", "pkg")).toEqual({ root: "pkg", include: "*.ts" });
  });

  it("`src/app/*.ts` → root `src/app`, filename glob `*.ts`", () => {
    expect(parseSearchInclude("src/app/*.ts", undefined)).toEqual({ root: "src/app", include: "*.ts" });
  });

  it("`sr*/*.ts` (a glob in the directory part) is rejected", () => {
    expect(parseSearchInclude("sr*/*.ts", undefined)).toEqual({ error: SEARCH_INCLUDE_BAD_DIR });
  });

  it("a derived directory that escapes the workspace is denied (confined like a path)", () => {
    expect(parseSearchInclude("../outside/*.ts", undefined)).toEqual({ error: "Error: path escapes the workspace" });
    expect(parseSearchInclude("*.ts", "../up")).toEqual({ error: "Error: path escapes the workspace" });
  });

  it("a `.`/redundant segment normalizes without escaping", () => {
    expect(parseSearchInclude("./src/*.ts", undefined)).toEqual({ root: "src", include: "*.ts" });
    expect(parseSearchInclude("src/../app/*.ts", undefined)).toEqual({ root: "app", include: "*.ts" });
  });

  it("no include → root is the path or `.`, include null", () => {
    expect(parseSearchInclude(undefined, undefined)).toEqual({ root: ".", include: null });
    expect(parseSearchInclude(undefined, "pkg")).toEqual({ root: "pkg", include: null });
  });
});
