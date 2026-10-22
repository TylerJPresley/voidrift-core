import { describe, it, expect } from "vitest";
import { ok, err, coreError, notImplemented, CoreErrorException, ErrorCode } from "./errors.js";

describe("errors (§2.6)", () => {
  it("ok and err build discriminated results", () => {
    expect(ok(5)).toEqual({ ok: true, value: 5 });
    const e = err(coreError("X", "msg"));
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.error.code).toBe("X");
  });

  it("coreError includes field and details only when provided", () => {
    expect(coreError("A", "m")).toEqual({ code: "A", message: "m" });
    expect(coreError("A", "m", { field: "f", details: { n: 1 } })).toEqual({
      code: "A",
      message: "m",
      field: "f",
      details: { n: 1 },
    });
  });

  it("notImplemented uses the NOT_IMPLEMENTED code", () => {
    const e = notImplemented("foo");
    expect(e.code).toBe(ErrorCode.NOT_IMPLEMENTED);
    expect(e.message).toContain("foo");
  });

  it("CoreErrorException carries the CoreError", () => {
    const ex = new CoreErrorException(coreError("Z", "zz"));
    expect(ex.error.code).toBe("Z");
    expect(ex.message).toBe("zz");
    expect(ex.name).toBe("CoreErrorException");
  });
});
