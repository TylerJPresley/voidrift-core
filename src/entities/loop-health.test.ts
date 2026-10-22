/**
 * loop-health entity tests (core-blueprint.md §3.4) — each detector, the nudge
 * wording, the `wait` exemption, per-turn reset, and config-override honouring.
 * Pure, deterministic, offline.
 */
import { describe, it, expect } from "vitest";
import {
  LoopHealth,
  fingerprintCall,
  loopNudge,
  LOOP_EXEMPT_TOOLS,
  type LoopHealthLimits,
} from "./loop-health.js";

const DEFAULTS: LoopHealthLimits = {
  maxConsecutiveErrors: 3,
  maxIdenticalCalls: 4,
  fingerprintRepeats: 3,
  fingerprintWindow: 20,
};

const lh = (over: Partial<LoopHealthLimits> = {}): LoopHealth =>
  new LoopHealth(() => ({ ...DEFAULTS, ...over }));

describe("fingerprintCall (§3.4)", () => {
  it("is stable under argument key order (canonicalized)", () => {
    expect(fingerprintCall("read_file", { a: 1, b: 2 })).toBe(
      fingerprintCall("read_file", { b: 2, a: 1 }),
    );
  });
  it("differs by tool name and by argument value", () => {
    expect(fingerprintCall("read_file", { path: "x" })).not.toBe(fingerprintCall("read_file", { path: "y" }));
    expect(fingerprintCall("read_file", { path: "x" })).not.toBe(fingerprintCall("edit_file", { path: "x" }));
  });
});

describe("detector (a) — identical consecutive calls (§3.4)", () => {
  it("trips at maxIdenticalCalls (4) identical calls, not before", () => {
    // Raise the repeat threshold out of the way so identical-consecutive is the
    // detector under test (for purely identical calls the windowed-repeat
    // detector would otherwise fire first at its lower threshold).
    const h = lh({ fingerprintRepeats: 99 });
    const call = (): ReturnType<LoopHealth["observe"]> => h.observe("read_file", { path: "a" }, false);
    expect(call()).toBeNull(); // 1
    expect(call()).toBeNull(); // 2
    expect(call()).toBeNull(); // 3
    const d = call(); // 4 → trip
    expect(d?.detector).toBe("identical_calls");
    expect(d?.nudge).toBe(loopNudge("identical_calls"));
  });
  it("a differing call in between resets the identical run", () => {
    const h = lh({ fingerprintRepeats: 99 });
    h.observe("read_file", { path: "a" }, false);
    h.observe("read_file", { path: "a" }, false);
    h.observe("read_file", { path: "b" }, false); // breaks the run
    expect(h.observe("read_file", { path: "a" }, false)).toBeNull();
  });
});

describe("detector (b) — windowed fingerprint repeats (§3.4)", () => {
  it("trips at fingerprintRepeats (3) within the window when interleaved", () => {
    const h = lh();
    // Interleave so the identical-consecutive detector never fires first.
    expect(h.observe("search_contents", { q: "x" }, false)).toBeNull(); // x #1
    expect(h.observe("read_file", { path: "p" }, false)).toBeNull();
    expect(h.observe("search_contents", { q: "x" }, false)).toBeNull(); // x #2
    expect(h.observe("read_file", { path: "p2" }, false)).toBeNull();
    const d = h.observe("search_contents", { q: "x" }, false); // x #3 → trip
    expect(d?.detector).toBe("fingerprint_repeats");
  });
  it("respects a tightened fingerprintWindow override (recency bound)", () => {
    const h = lh({ fingerprintWindow: 2, fingerprintRepeats: 3 });
    // With a window of 2 the oldest occurrence falls out, so 3 repeats never
    // coexist in-window and the detector cannot trip on spaced repeats.
    h.observe("glob_files", { p: "x" }, false);
    h.observe("read_file", { p: "a" }, false);
    h.observe("glob_files", { p: "x" }, false);
    h.observe("read_file", { p: "b" }, false);
    expect(h.observe("glob_files", { p: "x" }, false)).toBeNull();
  });
});

describe("detector (c) — consecutive tool errors (§3.4)", () => {
  it("trips at maxConsecutiveErrors (3) consecutive errors", () => {
    const h = lh();
    expect(h.observe("execute_command", { command: "a" }, true)).toBeNull(); // err 1
    expect(h.observe("execute_command", { command: "b" }, true)).toBeNull(); // err 2
    const d = h.observe("execute_command", { command: "c" }, true); // err 3 → trip
    expect(d?.detector).toBe("consecutive_errors");
  });
  it("a success resets the consecutive-error run", () => {
    const h = lh();
    h.observe("execute_command", { command: "a" }, true);
    h.observe("execute_command", { command: "b" }, true);
    h.observe("execute_command", { command: "c" }, false); // success resets
    expect(h.observe("execute_command", { command: "d" }, true)).toBeNull(); // err 1 again
  });
});

describe("exemption — `wait` never trips (§3.4)", () => {
  it("wait is in the exempt set", () => {
    expect(LOOP_EXEMPT_TOOLS.has("wait")).toBe(true);
  });
  it("repeated identical wait polls never trip and clear the error run", () => {
    const h = lh();
    for (let i = 0; i < 10; i++) {
      expect(h.observe("wait", { check: "test -f ready" }, false)).toBeNull();
    }
    // A wait after two real errors clears the error run, so the next error is #1.
    h.observe("execute_command", { command: "x1" }, true);
    h.observe("execute_command", { command: "x2" }, true);
    h.observe("wait", { check: "poll" }, false); // clears the consecutive-error run
    expect(h.observe("execute_command", { command: "x3" }, true)).toBeNull();
  });
});

describe("reset per turn (§3.4)", () => {
  it("reset clears every counter so a new turn starts fresh", () => {
    const h = lh({ fingerprintRepeats: 99 }); // isolate the identical detector
    h.observe("read_file", { path: "a" }, false);
    h.observe("read_file", { path: "a" }, false);
    h.observe("read_file", { path: "a" }, false);
    h.reset();
    // After reset, four fresh identical calls are needed to trip again.
    expect(h.observe("read_file", { path: "a" }, false)).toBeNull();
    expect(h.observe("read_file", { path: "a" }, false)).toBeNull();
    expect(h.observe("read_file", { path: "a" }, false)).toBeNull();
    expect(h.observe("read_file", { path: "a" }, false)?.detector).toBe("identical_calls");
  });
});

describe("config overrides honoured (§3.6)", () => {
  it("a tightened maxIdenticalCalls (2) trips sooner", () => {
    const h = lh({ maxIdenticalCalls: 2, fingerprintRepeats: 99 });
    expect(h.observe("read_file", { path: "a" }, false)).toBeNull(); // 1
    expect(h.observe("read_file", { path: "a" }, false)?.detector).toBe("identical_calls"); // 2 → trip
  });
  it("a tightened maxConsecutiveErrors (1) trips on the first error", () => {
    const h = lh({ maxConsecutiveErrors: 1 });
    expect(h.observe("execute_command", { command: "a" }, true)?.detector).toBe("consecutive_errors");
  });
});

describe("rearm — a tripped detector does not fire on every subsequent call (§3.4)", () => {
  it("after an identical-calls trip, the next identical call does not immediately re-trip", () => {
    const h = lh({ fingerprintRepeats: 99 });
    for (let i = 0; i < 4; i++) h.observe("read_file", { path: "a" }, false); // trips on the 4th
    // The detector rearmed (counter reset); one more call starts a fresh run.
    expect(h.observe("read_file", { path: "a" }, false)).toBeNull();
  });
});
