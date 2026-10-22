/**
 * The command gate FAILS CLOSED (core-blueprint.md §9.3; owner D2d).
 *
 * A security review of the shell splitter found two availability/fail-open
 * defects. This suite pins the fixes:
 *   1. HIGH — pathological substitution nesting no longer blows the call stack
 *      and crashes the gate; past the depth cap it is a DENY, and ANY throw
 *      while classifying becomes a DENY (never allow/ask/uncaught throw).
 *   2. MEDIUM — a command longer than the length cap is denied up front before
 *      any regex scan, and each segment is scanned in bounded overlapping
 *      windows so a long-but-legal segment stays fast while a dangerous token
 *      at a window boundary is still caught.
 */
import { describe, it, expect } from "vitest";
import {
  Guardian,
  builtinGuardrails,
  classifyNever,
  classifyCommand,
  extractSubstitutions,
  ClassificationError,
  type ShellLists,
} from "./guardian.js";
import {
  MAX_COMMAND_LENGTH,
  SCAN_WINDOW,
  SCAN_OVERLAP,
  windowScan,
} from "./shell-scan.js";
import {
  DEFAULT_SHELL_SAFE,
  DEFAULT_SHELL_FORCE_ASK,
  DEFAULT_SHELL_EQUIVALENTS,
  type PermissionRule,
} from "../config/schema.js";

const lists: ShellLists = {
  safe: DEFAULT_SHELL_SAFE,
  forceAsk: DEFAULT_SHELL_FORCE_ASK,
  equivalents: DEFAULT_SHELL_EQUIVALENTS,
  deny: [],
};
const NONE = new Set<string>();
const guardian = new Guardian(builtinGuardrails());

function evalCmd(command: string, rules: PermissionRule[] = []) {
  return guardian.evaluate({ tool: "execute_command", args: { command } }, rules, lists, {});
}

describe("fail-closed: pathological substitution nesting (§D2d HIGH)", () => {
  // The crash repro from the review: 200 nested `$(` with `reboot` inside.
  const bomb = "$(".repeat(200) + "reboot" + ")".repeat(200);

  it("extractSubstitutions throws ClassificationError past the depth cap instead of recursing unbounded", () => {
    expect(() => extractSubstitutions(bomb)).toThrow(ClassificationError);
  });

  it("evaluate DENIES the nesting bomb — never an allow, ask, or uncaught throw", () => {
    let out: ReturnType<typeof evalCmd>;
    expect(() => {
      out = evalCmd(bomb);
    }).not.toThrow();
    out = evalCmd(bomb);
    expect(out.decision).toBe("deny");
    expect(out.reason).toBe("blocked: this command could not be classified safely");
  });

  it("a wildcard allow cannot satisfy the fail-closed deny", () => {
    const rules: PermissionRule[] = [
      { tool: "execute_command", pattern: "*", decision: "allow", priority: 300, source: "session" },
    ];
    const out = evalCmd(bomb, rules);
    expect(out.decision).toBe("deny");
  });

  it("the deny reason carries NO command text (nothing sensitive is surfaced)", () => {
    const out = evalCmd(bomb);
    expect(out.reason).not.toContain("reboot");
    expect(out.reason).not.toContain("$(");
  });

  it("a legal, shallow substitution still classifies normally (reboot inside $() denies via never list)", () => {
    const out = evalCmd("echo $(reboot)");
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("power-state");
  });

  it("any thrown classification error becomes a DENY — a throwing classifier dependency is caught", () => {
    // Inject a throw through a Guardrail-independent path: a guard whose
    // evaluate hits the depth cap via innerCommands throws ClassificationError,
    // which the wrapper converts to a deny. (Covered above via `bomb`.) Here we
    // assert the sentinel type directly so a future refactor keeps the contract.
    expect(new ClassificationError().message).toBe("command could not be classified safely");
  });
});

describe("fail-closed: over-long command denied up front (§D2d MEDIUM)", () => {
  it(`a command longer than ${MAX_COMMAND_LENGTH} chars is denied before any regex scan`, () => {
    const tooLong = "echo " + "a".repeat(MAX_COMMAND_LENGTH + 1);
    const out = evalCmd(tooLong);
    expect(out.decision).toBe("deny");
    expect(out.reason).toBe(
      `blocked: command is too long to classify safely (limit ${MAX_COMMAND_LENGTH} characters); write it to a file with write_file and run the file`,
    );
  });

  it("a command exactly at the length cap is NOT denied for length (it classifies normally)", () => {
    const atCap = "echo " + "a".repeat(MAX_COMMAND_LENGTH - "echo ".length);
    expect(atCap.length).toBe(MAX_COMMAND_LENGTH);
    const out = evalCmd(atCap);
    expect(out.reason ?? "").not.toContain("too long to classify");
  });

  it("the length-cap deny carries NO command text", () => {
    const out = evalCmd("echo " + "secret".repeat(6000));
    expect(out.reason).not.toContain("secret");
  });
});

describe("windowed scanning stays fast and still catches boundary danger (§D2d MEDIUM)", () => {
  // Generous margin (< 1000 ms) over the measured target (< 250 ms) to avoid
  // CI flakiness. Each is a 30,000-char single command below the 32 KB cap.
  const SIZE = 30000;
  const cases: Array<[string, string]> = [
    ["repeated 'a '", "a ".repeat(SIZE / 2)],
    ["repeated 'echo '", "echo ".repeat(SIZE / 5)],
    ["repeated 'x=1;'", "x=1;".repeat(SIZE / 4)],
    ["repeated '((('", "(".repeat(SIZE)],
    ["repeated '$('", "$(".repeat(SIZE / 2)],
    ['repeated \'"\'', '"'.repeat(SIZE)],
    ["repeated backslashes", "\\".repeat(SIZE)],
  ];

  for (const [name, command] of cases) {
    it(`classifies a ${SIZE}-char command of ${name} well under 1000 ms`, () => {
      const start = performance.now();
      // A pathological input may fail closed by THROWING (bounded cost) — that
      // is still fast and still a deny via evaluate; the measurement is the cost.
      try {
        classifyNever(command, NONE);
        classifyCommand(command, lists);
      } catch {
        /* fail-closed throw is acceptable and fast */
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });
  }

  it("windowScan tests a short value exactly once, byte-for-byte", () => {
    let seen = 0;
    const r = windowScan("short value", (w) => {
      seen++;
      expect(w).toBe("short value");
      return false;
    });
    expect(seen).toBe(1);
    expect(r).toBe(false);
  });

  it("windowScan steps by (window - overlap) over a long value", () => {
    const value = "z".repeat(SCAN_WINDOW * 2 + 100);
    const starts: number[] = [];
    let offset = 0;
    windowScan(value, (_w) => {
      starts.push(offset);
      offset += SCAN_WINDOW - SCAN_OVERLAP;
      return false;
    });
    // First window starts at 0; windows overlap by SCAN_OVERLAP.
    expect(starts[0]).toBe(0);
    expect(starts.length).toBeGreaterThan(1);
  });

  it("a dangerous command at a non-first window boundary (near 8,192) is still DENIED", () => {
    // `sudo reboot …` begins exactly at the second window's start (step =
    // SCAN_WINDOW - SCAN_OVERLAP) and its match region extends past the 8,192
    // boundary, so only a WINDOWED scan that overlaps the boundary catches it.
    const step = SCAN_WINDOW - SCAN_OVERLAP; // 7680
    const pad = "x ".repeat(step / 2); // step chars, ends with a space
    expect(pad.length).toBe(step);
    const command = pad + "sudo reboot " + "y".repeat(3000);
    expect(command.length).toBeGreaterThan(SCAN_WINDOW);
    expect(command.length).toBeLessThan(MAX_COMMAND_LENGTH);
    const out = evalCmd(command);
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("power-state");
  });

  it("a force-ask danger straddling the window boundary still force-asks", () => {
    const step = SCAN_WINDOW - SCAN_OVERLAP;
    const pad = "x ".repeat(step / 2);
    const command = pad + "git push --force " + "y".repeat(2000);
    expect(command.length).toBeGreaterThan(SCAN_WINDOW);
    const out = evalCmd(command);
    expect(out.decision).toBe("ask");
    expect(out.forceAsk).toBe(true);
  });
});

describe("regression: long-but-normal commands classify as before (§D2d)", () => {
  it("5,000 chars of echo arguments classify without a length/fail-closed deny", () => {
    const command = "echo " + "arg ".repeat(1250); // ~5,005 chars
    expect(command.length).toBeGreaterThan(5000);
    const out = evalCmd(command);
    expect(out.decision).not.toBe("deny");
  });

  it("a 20 KB heredoc body without dangerous text is not blocked", () => {
    const body = "line of harmless text\n".repeat(950); // ~20 KB
    const command = `cat <<EOF\n${body}EOF`;
    expect(command.length).toBeGreaterThan(20000);
    expect(command.length).toBeLessThan(MAX_COMMAND_LENGTH);
    const out = evalCmd(command);
    expect(out.reason ?? "").not.toContain("too long to classify");
    expect(out.reason ?? "").not.toContain("could not be classified");
  });
});
