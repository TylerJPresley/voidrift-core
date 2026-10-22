/**
 * Repeated-sequence detector ACCURACY tests (core-blueprint.md §10.6, updated).
 *
 * These pin the corrected counting and qualification the blueprint now mandates:
 *  - Counting: a turn counts AT MOST ONCE toward a sequence (non-overlapping,
 *    de-duplicated per turn); the reported `count` is the number of DISTINCT
 *    SESSIONS (or distinct turns within one session), never the raw match count.
 *  - Qualification: a sequence qualifies only with at least one NON-READ step
 *    (write/mutate, command exec, `task`, network mutation). A purely read-only
 *    sequence NEVER qualifies, whatever its length or recurrence.
 *  - Message: `(seen in N sessions)` across sessions / `(in N turns this
 *    session)` within one session — never `(seen N×)`.
 *  - Evidence: up to THREE redacted example argument summaries per step.
 *  - Lifecycle: a signature with a pending/approved/rejected suggestion never
 *    re-signals (the writer/memory layers persist the signature + rejected list;
 *    see obs-writer / memory tests).
 */
import { describe, it, expect } from "vitest";
import { SequenceDetector, sequenceMessage } from "./sequence-detector.js";
import type { ObsRecord } from "./obs-record.js";

function rec(partial: Partial<ObsRecord>): ObsRecord {
  return {
    traceId: "s1",
    spanId: "sp",
    timestamp: new Date().toISOString(),
    status: "ok",
    source: "tool",
    name: "n",
    severity: "info",
    attributes: {},
    ...partial,
  };
}

function observeCall(det: SequenceDetector, id: string, name: string, args: unknown) {
  det.observe(rec({ spanId: id, source: "tool", status: "pending", name, input: args }));
  det.observe(rec({ spanId: id, source: "tool", status: "ok", name }));
}

/** Run one turn: begin, run `body`, then flush and return the turn's signals. */
function turn(det: SequenceDetector, body: () => void) {
  det.beginTurn();
  body();
  return det.flushTurnSignals();
}

describe("§10.6 accuracy — the 11× Read → Map → Read reproduction", () => {
  it("AUDIT: a read-only orientation routine run many times in ONE session never qualifies and never inflates N", () => {
    // Reproduce the owner's screenshot: `Read → Map → Read`, a read-only
    // orientation routine (AGENTS.md prescribes reading files + a workspace map),
    // run repeatedly. OLD behaviour counted every overlapping sliding window and
    // every match in a turn, summing to 11 in one session, and qualified because
    // it had two distinct tools. The corrected detector: it has NO non-read step,
    // so it NEVER qualifies, whatever the recurrence.
    const det = new SequenceDetector(3, 6, "orient-1");
    const fired: unknown[] = [];
    for (let t = 0; t < 4; t++) {
      fired.push(
        ...turn(det, () => {
          for (let round = 0; round < 3; round++) {
            observeCall(det, `t${t}r${round}-1`, "read_file", { path: "AGENTS.md" });
            observeCall(det, `t${t}r${round}-2`, "workspace_map", {});
            observeCall(det, `t${t}r${round}-3`, "read_file", { path: "README.md" });
          }
        }),
      );
    }
    expect(fired).toHaveLength(0);
  });
});

describe("§10.6 accuracy — N is DISTINCT sessions, not raw matches", () => {
  it("a turn that matches the sequence several times counts ONCE; N reports distinct turns", () => {
    // A mutating procedure (read → exec → write) repeated MULTIPLE times within
    // each of three turns. Raw match count would be far above 3; the reported
    // figure must be exactly 3 (three distinct turns). Exactly one signal fires.
    const det = new SequenceDetector(3, 6, "s1");
    const all: { count: number; message: string }[] = [];
    const run = (t: number, round: number) => {
      observeCall(det, `t${t}r${round}-1`, "read_file", { path: "a" });
      observeCall(det, `t${t}r${round}-2`, "execute_command", { command: "x" });
      observeCall(det, `t${t}r${round}-3`, "write_file", { path: "a", content: "y" });
    };
    for (let t = 0; t < 3; t++) {
      all.push(...turn(det, () => { run(t, 0); run(t, 1); run(t, 2); }));
    }
    expect(all).toHaveLength(1);
    expect(all[0]!.count).toBe(3);
    expect(all[0]!.message).toContain("in 3 turns this session");
  });

  it("across sessions N reports distinct sessions and the message reads 'seen in N sessions'", () => {
    const det = new SequenceDetector(3, 6, "live");
    const steps = [
      { signature: "read_file({path:string})", outcome: "success" as const },
      { signature: "write_file({content:string,path:string})", outcome: "success" as const },
    ];
    // Seed two prior sessions, each with MANY overlapping windows (as a real
    // prior trail replay would produce). N must count the two distinct sessions,
    // not the many seeded windows.
    for (const sess of ["s0", "s2"]) {
      for (let i = 0; i < 5; i++) det.seedPrior(steps, sess);
    }
    const fired = turn(det, () => {
      observeCall(det, "l1", "read_file", { path: "a" });
      observeCall(det, "l2", "write_file", { path: "a", content: "x" });
    });
    const hit = fired.find((h) => h.steps.length === 2);
    expect(hit).toBeDefined();
    expect(hit!.count).toBe(3);
    expect(hit!.message).toContain("seen in 3 sessions");
  });
});

describe("§10.6 accuracy — qualification requires a non-read step", () => {
  it("Read → Map → Read (two distinct read tools) does NOT qualify (no non-read step)", () => {
    const det = new SequenceDetector(3, 6, "s1");
    const fired: unknown[] = [];
    for (let t = 0; t < 4; t++) {
      fired.push(
        ...turn(det, () => {
          observeCall(det, `t${t}-1`, "read_file", {});
          observeCall(det, `t${t}-2`, "workspace_map", {});
          observeCall(det, `t${t}-3`, "read_file", {});
        }),
      );
    }
    expect(fired).toHaveLength(0);
  });

  it("a Read → Task → Read sequence does NOT qualify (task delegation is not a procedure)", () => {
    // §10.6 corrected rule: a candidate must contain a MUTATING step (write /
    // edit / execute / unknown-write). `task` is delegation, not a repeatable
    // procedure worth a skill, so read+dispatch sequences never qualify.
    const det = new SequenceDetector(3, 6, "s1");
    const all: { pattern: string; count: number }[] = [];
    for (let t = 0; t < 3; t++) {
      all.push(
        ...turn(det, () => {
          observeCall(det, `t${t}-1`, "read_file", {});
          observeCall(det, `t${t}-2`, "task", {});
          observeCall(det, `t${t}-3`, "read_file", {});
        }),
      );
    }
    expect(all).toHaveLength(0);
  });

  it("a Task → Write sequence DOES qualify (the write is the mutating step)", () => {
    const det = new SequenceDetector(3, 2, "s1");
    const all: { pattern: string; count: number }[] = [];
    for (let t = 0; t < 3; t++) {
      all.push(
        ...turn(det, () => {
          observeCall(det, `t${t}-1`, "task", {});
          observeCall(det, `t${t}-2`, "write_file", {});
        }),
      );
    }
    expect(all).toHaveLength(1);
    expect(all[0]!.pattern).toContain("write_file({})");
    expect(all[0]!.count).toBe(3);
  });
});

describe("§10.6 accuracy — message wording", () => {
  it("within one session reads 'in N turns this session'", () => {
    expect(
      sequenceMessage(
        [
          { signature: "read_file({path:string})", outcome: "success" },
          { signature: "write_file({path:string})", outcome: "success" },
        ],
        3,
        "turns",
      ),
    ).toBe(
      "Repeated pattern: Read → Write (in 3 turns this session). A skill suggestion will be drafted when the session is idle; review with /memory.",
    );
  });

  it("across sessions reads 'seen in N sessions'", () => {
    expect(
      sequenceMessage(
        [
          { signature: "read_file({path:string})", outcome: "success" },
          { signature: "write_file({path:string})", outcome: "success" },
        ],
        3,
        "sessions",
      ),
    ).toBe(
      "Repeated pattern: Read → Write (seen in 3 sessions). A skill suggestion will be drafted when the session is idle; review with /memory.",
    );
  });
});

describe("§10.6 Lifecycle — a suppressed signature never re-signals", () => {
  it("suppressSignature(sig) stops the matching sequence from re-signalling", () => {
    const sig = "read_file({}) → write_file({})";
    const run = (det: SequenceDetector) => {
      const fired: string[] = [];
      for (let t = 0; t < 4; t++) {
        fired.push(
          ...turn(det, () => {
            observeCall(det, `t${t}-1`, "read_file", {});
            observeCall(det, `t${t}-2`, "write_file", {});
          }).map((h) => h.pattern),
        );
      }
      return fired;
    };
    // Baseline: without suppression the signature fires.
    expect(run(new SequenceDetector(3, 2, "s1"))).toContain(sig);
    // With the signature suppressed (a pending/approved/rejected suggestion
    // exists for it), it never re-signals.
    const det = new SequenceDetector(3, 2, "s1");
    det.suppressSignature(sig);
    expect(run(det)).not.toContain(sig);
  });
});
