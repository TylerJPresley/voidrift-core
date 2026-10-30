/**
 * The central tool-argument coercion + invalid-argument formatting (§8.1).
 * `coerceStringArrays` is schema-driven and touches string-array fields only;
 * `validateToolArgs` formats the field+issue message from the Zod issues (zod
 * v4), capped and stack-free.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { coerceStringArrays, validateToolArgs, INVALID_ARGS_MAX_CHARS } from "./tool-args.js";

const SAVE_MEMORY = z.object({
  title: z.string(),
  keywords: z.array(z.string()).optional(),
});
// A second string-array tool: a required top-level string[] plus a non-string array.
const LABELS = z.object({
  labels: z.array(z.string()),
  counts: z.array(z.number()).optional(),
  name: z.string().optional(),
});

describe("coerceStringArrays (§8.1) — string → string[] from the tool's own schema", () => {
  it("splits a comma string into a trimmed, empty-dropped array for a string-array field", () => {
    const out = coerceStringArrays({ title: "t", keywords: "a, b ,,c" }, SAVE_MEMORY);
    expect(out.keywords).toEqual(["a", "b", "c"]);
    expect(out.title).toBe("t"); // a plain string field is untouched
  });

  it("coerces for a second string-array tool too (generic, not per-tool)", () => {
    const out = coerceStringArrays({ labels: "x,y" }, LABELS);
    expect(out.labels).toEqual(["x", "y"]);
  });

  it("leaves a NON-string value untouched (number, object, already-an-array)", () => {
    const already = coerceStringArrays({ title: "t", keywords: ["a", "b"] }, SAVE_MEMORY);
    expect(already.keywords).toEqual(["a", "b"]);
    const num = coerceStringArrays({ labels: 5 as unknown as string }, LABELS);
    expect(num.labels).toBe(5); // not a string, not an array-of-strings → untouched
  });

  it("does not coerce a non-string-array field (array of numbers stays a string)", () => {
    const out = coerceStringArrays({ labels: "x", counts: "1,2" }, LABELS);
    expect(out.labels).toEqual(["x"]);
    expect(out.counts).toBe("1,2"); // counts is number[] → never split
  });

  it("returns a shallow copy; the input is never mutated", () => {
    const input = { title: "t", keywords: "a,b" };
    const out = coerceStringArrays(input, SAVE_MEMORY);
    expect(input.keywords).toBe("a,b"); // original unchanged
    expect(out).not.toBe(input);
  });
});

describe("validateToolArgs (§8.1) — invalid-argument message from Zod issues", () => {
  it("formats `invalid arguments for <tool>: <field>: <issue>` on a bad field", () => {
    const r = validateToolArgs("read_file", { path: 123 }, z.object({ path: z.string() }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/^invalid arguments for read_file: path: /);
      expect(r.message).not.toMatch(/\n|at .*\(|\.ts:|\.js:/); // no stack, no paths
      expect(r.message.length).toBeLessThanOrEqual(INVALID_ARGS_MAX_CHARS);
    }
  });

  it("passes valid (coerced) args", () => {
    const coerced = coerceStringArrays({ title: "t", keywords: "a,b" }, SAVE_MEMORY);
    expect(validateToolArgs("save_memory", coerced, SAVE_MEMORY).ok).toBe(true);
  });

  it("caps an over-long issue message at ~500 chars", () => {
    const schema = z.object({ v: z.string().regex(/^x$/, "m".repeat(2000)) });
    const r = validateToolArgs("t", { v: "no" }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message.length).toBe(INVALID_ARGS_MAX_CHARS);
  });

  it("passes through a schema that is not a real Zod schema (no safeParse) — e.g. an exotic adapter shim", () => {
    const shim = { parse: (v: unknown) => v } as unknown as Parameters<typeof validateToolArgs>[2];
    expect(validateToolArgs("mcp_x", { anything: 1 }, shim)).toEqual({ ok: true });
    // coercion also leaves args untouched for a non-object schema
    expect(coerceStringArrays({ anything: "a,b" }, shim)).toEqual({ anything: "a,b" });
  });
});
