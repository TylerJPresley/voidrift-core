/**
 * Repeated-sequence detector unit tests (core-blueprint.md §10.6, §15.1 invariant 12).
 *
 * The detector is mechanical code over the `info` trail: it makes no model call
 * and never enters the model's context. Signal quality (§10.6): a sequence
 * qualifies only when it contains a NON-READ step, AND its DISTINCT figure
 * (distinct sessions, or distinct turns within one session) reaches the
 * threshold across ≥3 distinct contexts. The detector buffers qualifying windows
 * per turn and emits only the MAXIMAL set at the turn boundary via
 * `flushTurnSignals()`; at most one signal per turn and three per session.
 * Differing argument VALUES (same shape) never change the signature; a sequence
 * longer than `sequenceMaxLen` is not matched as one unit; secrets never appear.
 */
import { describe, it, expect, vi } from "vitest";
import { SequenceDetector, shapeDigest, windowsFromRecords, sequenceMessage } from "./sequence-detector.js";
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

/** Observe a completed tool call (pending-with-args → ok). */
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

/** Run the same 3-tool sequence once (read → search → write) in its own turn. */
function runSeqTurn(det: SequenceDetector, round: number, args?: unknown) {
  const a = { path: "a.ts" };
  return turn(det, () => {
    observeCall(det, `r${round}-1`, "read_file", args ?? a);
    observeCall(det, `r${round}-2`, "search_contents", args ?? a);
    observeCall(det, `r${round}-3`, "write_file", args ?? a);
  });
}

const FULL_3 = "read_file({path:string}) → search_contents({path:string}) → write_file({path:string})";

describe("§10.6 — repeated-sequence detector (qualification)", () => {
  it("raises one success event with a human message when a 3-tool sequence repeats across three turns", () => {
    const det = new SequenceDetector(3, 6, "s1");
    let fullHit: { pattern: string; count: number; outcome: string; message: string } | undefined;
    for (let round = 1; round <= 3; round++) {
      const f = runSeqTurn(det, round).find((h) => h.pattern === FULL_3);
      if (f) fullHit = f;
    }
    expect(fullHit).toMatchObject({ pattern: FULL_3, count: 3, outcome: "success" });
    expect(fullHit!.message).toBe(
      "Repeated pattern: Read → Search → Write (in 3 turns this session). A skill suggestion will be drafted when the session is idle; review with /memory.",
    );
  });

  it("a two-step read-only orientation sequence seen only within one turn does NOT qualify", () => {
    const det = new SequenceDetector(3, 6, "s1");
    const fired = turn(det, () => {
      for (let round = 0; round < 4; round++) {
        observeCall(det, `r${round}-1`, "read_file", {});
        observeCall(det, `r${round}-2`, "workspace_map", {});
      }
    });
    expect(fired).toHaveLength(0);
  });

  it("a two-step WRITE sequence repeated across three turns qualifies (write lifts the 3-step floor)", () => {
    const det = new SequenceDetector(3, 2, "s1");
    let hit: { count: number; steps: string[] } | undefined;
    for (let round = 0; round < 3; round++) {
      const f = turn(det, () => {
        observeCall(det, `r${round}-1`, "read_file", {});
        observeCall(det, `r${round}-2`, "write_file", {});
      }).find((h) => h.steps.length === 2);
      if (f) hit = f;
    }
    expect(hit).toMatchObject({ count: 3, steps: ["read_file({})", "write_file({})"] });
  });

  it("requires at least three distinct sessions or turns even at the threshold", () => {
    // Threshold 3 reached WITHIN one turn (no distinct turns/sessions): no signal.
    const det = new SequenceDetector(3, 6, "s1");
    const fired = turn(det, () => {
      for (let round = 0; round < 3; round++) {
        observeCall(det, `r${round}-1`, "read_file", {});
        observeCall(det, `r${round}-2`, "search_contents", {});
        observeCall(det, `r${round}-3`, "write_file", {});
      }
    });
    expect(fired).toHaveLength(0);
  });

  it("raises a failure event for a repeatedly denied 3-step sequence across turns", () => {
    const det = new SequenceDetector(3, 6, "s1");
    const deny = (tool: string) =>
      rec({
        source: "guardian",
        status: "error",
        name: "permission_denied",
        attributes: { decision: "deny", tool, action: { args: { command: "x" } } },
      });
    let hit: { outcome: string; count: number } | undefined;
    for (let round = 0; round < 3; round++) {
      const f = turn(det, () => {
        det.observe(deny("read_file"));
        det.observe(deny("search_contents"));
        det.observe(deny("write_file"));
      }).find((h) => h.steps.length === 3);
      if (f) hit = f;
    }
    expect(hit).toMatchObject({ outcome: "failure", count: 3 });
  });
});

describe("§10.6 — non-read qualification (corrected rule)", () => {
  it("Read → Read → Read across five sessions NEVER qualifies (read-only)", () => {
    const steps = [
      { signature: "read_file({})", outcome: "success" as const },
      { signature: "read_file({})", outcome: "success" as const },
      { signature: "read_file({})", outcome: "success" as const },
    ];
    const det = new SequenceDetector(3, 6, "live");
    for (const sess of ["s0", "s1", "s2", "s3"]) {
      for (let len = 2; len <= 3; len++) det.seedPrior(steps.slice(0, len), sess);
    }
    const fired = turn(det, () => {
      observeCall(det, "l-1", "read_file", {});
      observeCall(det, "l-2", "read_file", {});
      observeCall(det, "l-3", "read_file", {});
    });
    expect(fired).toHaveLength(0);
  });

  it("Read → Grep → Read across three turns does NOT qualify (no non-read step)", () => {
    const det = new SequenceDetector(3, 6, "s1");
    const fired: unknown[] = [];
    for (let round = 0; round < 3; round++) {
      fired.push(
        ...turn(det, () => {
          observeCall(det, `r${round}-1`, "read_file", {});
          observeCall(det, `r${round}-2`, "search_contents", {});
          observeCall(det, `r${round}-3`, "read_file", {});
        }),
      );
    }
    expect(fired).toHaveLength(0);
  });

  it("Read → Read → Task across three turns does NOT qualify (task alone is not a procedure)", () => {
    // §10.6 corrected rule: a candidate must contain a MUTATING step (write /
    // edit / execute / unknown-write / network mutation). `task` is delegation,
    // not a procedure worth a skill, so a read+dispatch sequence never qualifies.
    const det = new SequenceDetector(3, 6, "s1");
    const fired: unknown[] = [];
    for (let round = 0; round < 3; round++) {
      fired.push(
        ...turn(det, () => {
          observeCall(det, `r${round}-1`, "read_file", {});
          observeCall(det, `r${round}-2`, "read_file", {});
          observeCall(det, `r${round}-3`, "task", { worker: "researcher", task: "x" });
        }),
      );
    }
    expect(fired).toHaveLength(0);
  });

  it("Read → Task → Write across three turns qualifies (the write is the mutating step)", () => {
    const det = new SequenceDetector(3, 6, "s1");
    const sig =
      "read_file({}) → task({task:string,worker:string}) → write_file({})";
    let hit: { pattern: string } | undefined;
    for (let round = 0; round < 3; round++) {
      const f = turn(det, () => {
        observeCall(det, `r${round}-1`, "read_file", {});
        observeCall(det, `r${round}-2`, "task", { worker: "w", task: "x" });
        observeCall(det, `r${round}-3`, "write_file", {});
      }).find((h) => h.pattern === sig);
      if (f) hit = f;
    }
    expect(hit).toMatchObject({ pattern: sig });
  });

  it("a single-tool WRITE repeat qualifies (a write lifts the read-only floor)", () => {
    const det = new SequenceDetector(3, 2, "s1");
    const sig = "write_file({}) → write_file({})";
    let hit: { pattern: string; outcome: string } | undefined;
    for (let round = 0; round < 3; round++) {
      const f = turn(det, () => {
        observeCall(det, `r${round}-1`, "write_file", {});
        observeCall(det, `r${round}-2`, "write_file", {});
      }).find((h) => h.pattern === sig);
      if (f) hit = f;
    }
    expect(hit).toMatchObject({ pattern: sig, outcome: "success" });
  });
});

describe("§10.6 — maximal-only reporting and caps", () => {
  it("reports only the maximal sequence; the contained shorter window is dropped", () => {
    const det = new SequenceDetector(3, 6, "s1");
    const all: { pattern: string; steps: string[] }[] = [];
    for (let round = 0; round < 3; round++) all.push(...runSeqTurn(det, round));
    expect(all.map((h) => h.pattern)).toContain(FULL_3);
    expect(all.some((h) => h.steps.length === 2)).toBe(false);
  });

  it("caps at one signal per turn", () => {
    const det = new SequenceDetector(3, 6, "s1");
    const seqA = (r: number) => {
      observeCall(det, `a${r}-1`, "read_file", {});
      observeCall(det, `a${r}-2`, "glob_files", {});
      observeCall(det, `a${r}-3`, "write_file", {});
    };
    const seqB = (r: number) => {
      observeCall(det, `b${r}-1`, "search_contents", {});
      observeCall(det, `b${r}-2`, "workspace_map", {});
      observeCall(det, `b${r}-3`, "execute_command", {});
    };
    for (let round = 0; round < 2; round++) turn(det, () => { seqA(round); seqB(round); });
    const hits = turn(det, () => { seqA(99); seqB(99); });
    expect(hits).toHaveLength(1);
  });

  it("caps at three signals per session", () => {
    const det = new SequenceDetector(3, 6, "s1");
    let total = 0;
    const sequences = [
      ["read_file", "glob_files", "write_file"],
      ["glob_files", "read_file", "edit_file"],
      ["search_contents", "read_file", "execute_command"],
      ["workspace_map", "glob_files", "write_file"],
    ];
    for (const seq of sequences) {
      for (let round = 0; round < 3; round++) {
        total += turn(det, () => {
          observeCall(det, `${seq.join()}-${round}-1`, seq[0]!, {});
          observeCall(det, `${seq.join()}-${round}-2`, seq[1]!, {});
          observeCall(det, `${seq.join()}-${round}-3`, seq[2]!, {});
        }).length;
      }
    }
    expect(total).toBe(3);
  });
});

describe("§10.6 — signature invariants", () => {
  it("differing argument VALUES with the same shape do not change the signature", () => {
    const det = new SequenceDetector(3, 6, "s1");
    let fullHit: { pattern: string; count: number } | undefined;
    for (let round = 1; round <= 3; round++) {
      const f = runSeqTurn(det, round, { path: `file-${round}-${Math.random()}.ts` }).find((h) => h.pattern === FULL_3);
      if (f) fullHit = f;
    }
    expect(fullHit).toMatchObject({ pattern: FULL_3, count: 3 });
  });

  it("a sequence longer than sequenceMaxLen is not matched as one unit", () => {
    const det = new SequenceDetector(2, 2, "s1"); // maxLen 2
    const longSig = "a({}) → b({}) → c({})";
    const seen: string[] = [];
    for (let round = 0; round < 3; round++) {
      seen.push(
        ...turn(det, () => {
          for (const [i, name] of ["a", "b", "c"].entries()) {
            observeCall(det, `r${round}-${i}`, name, {});
          }
        }).map((h) => h.pattern),
      );
    }
    expect(seen).not.toContain(longSig);
    expect(seen.every((p) => p.split(" → ").length <= 2)).toBe(true);
  });

  it("makes no model call (the detector takes no model/port)", () => {
    const model = { invoke: vi.fn() };
    const det = new SequenceDetector(2, 6, "s1");
    for (let round = 0; round < 3; round++) {
      turn(det, () => {
        observeCall(det, `r${round}-1`, "read_file", {});
        observeCall(det, `r${round}-2`, "write_file", {});
      });
    }
    expect(model.invoke).not.toHaveBeenCalled();
  });

  it("counts across sessions: three prior-session seeds plus one live run qualify", () => {
    const det = new SequenceDetector(4, 6, "s1");
    const steps = [
      { signature: "read_file({})", outcome: "success" as const },
      { signature: "write_file({})", outcome: "success" as const },
    ];
    det.seedPrior(steps, "s0");
    det.seedPrior(steps, "s2");
    det.seedPrior(steps, "s3");
    const fired = turn(det, () => {
      observeCall(det, "l-1", "read_file", {});
      observeCall(det, "l-2", "write_file", {});
    });
    const combined = fired.find((h) => h.steps.length === 2);
    // Four distinct sessions (s0,s1,s2,s3): the figure is 4 and the split reports
    // 1 distinct turn this session + 3 prior sessions.
    expect(combined).toMatchObject({ count: 4, split: { within: 1, across: 3 } });
    expect(combined && combined.sessionIds.sort()).toEqual(["s0", "s1", "s2", "s3"]);
  });

  it("fires once per sequence signature per session", () => {
    const det = new SequenceDetector(3, 2, "s1");
    const twoStep = "read_file({}) → write_file({})";
    const allHits: string[] = [];
    for (let round = 0; round < 6; round++) {
      allHits.push(
        ...turn(det, () => {
          observeCall(det, `r${round}-1`, "read_file", {});
          observeCall(det, `r${round}-2`, "write_file", {});
        }).map((h) => h.pattern),
      );
    }
    expect(allHits.filter((p) => p === twoStep)).toHaveLength(1);
  });

  it("a secret in a tool argument never appears in any signature or event", () => {
    const det = new SequenceDetector(3, 6, "s1");
    const secret = "sk-liv" + "e-ABCDEF1234567890";
    const all: unknown[] = [];
    for (let round = 0; round < 3; round++) {
      all.push(
        ...turn(det, () => {
          observeCall(det, `q${round}-1`, "execute_command", { command: `curl -H 'Authorization: Bearer ${secret}'` });
          observeCall(det, `q${round}-2`, "write_file", { path: `/home/u/.env-${secret}`, content: secret });
          observeCall(det, `q${round}-3`, "read_file", { path: `/x-${secret}` });
        }),
      );
    }
    const blob = JSON.stringify(all);
    expect(all.length).toBeGreaterThan(0);
    expect(blob).not.toContain(secret);
    expect(blob).toContain("execute_command({command:string})");
    expect(blob).toContain("write_file({content:string,path:string})");
  });
});

describe("§10.6 — sequenceMessage (human wording, display names, no values)", () => {
  it("names the pattern by display names and the figure, exactly as the blueprint pins", () => {
    const msg = sequenceMessage(
      [
        { signature: "read_file({path:string})", outcome: "success" },
        { signature: "workspace_map({})", outcome: "success" },
      ],
      4,
    );
    expect(msg).toBe(
      "Repeated pattern: Read → Map (seen in 4 sessions). A skill suggestion will be drafted when the session is idle; review with /memory.",
    );
  });
});

describe("§10.6 — shapeDigest (values never leak)", () => {
  it("digests keys and value kinds, never literal values; keys sorted", () => {
    expect(shapeDigest({ b: "x", a: 1, c: true })).toBe("{a:number,b:string,c:boolean}");
    expect(shapeDigest({ path: "/secret/path" })).toBe(shapeDigest({ path: "/other" }));
  });

  it("digests primitives, arrays and null by kind", () => {
    expect(shapeDigest(null)).toBe("null");
    expect(shapeDigest("literal-secret")).toBe("string");
    expect(shapeDigest(42)).toBe("number");
    expect(shapeDigest([{ a: 1 }])).toBe("[object]");
    expect(shapeDigest([])).toBe("[]");
    expect(shapeDigest(undefined)).toBe("");
  });
});

describe("§10.6 — windowsFromRecords (prior-trail replay for cross-session seeding)", () => {
  it("extracts every 2..maxLen window of completed steps in trail order, values stripped", () => {
    const recs: ObsRecord[] = [
      rec({ spanId: "1", source: "tool", status: "pending", name: "read_file", input: { path: "a" } }),
      rec({ spanId: "1", source: "tool", status: "ok", name: "read_file" }),
      rec({ spanId: "2", source: "tool", status: "pending", name: "write_file", input: { path: "b" } }),
      rec({ spanId: "2", source: "tool", status: "ok", name: "write_file" }),
    ];
    const windows = windowsFromRecords(recs, 6);
    const sigs = windows.map((w) => w.map((s) => s.signature).join(" → "));
    expect(sigs).toContain("read_file({path:string}) → write_file({path:string})");
    const det = new SequenceDetector(4, 6, "s1");
    for (const sess of ["s0", "s2", "s3"]) for (const w of windows) det.seedPrior(w, sess);
    const fired = turn(det, () => {
      observeCall(det, "l1", "read_file", { path: "x" });
      observeCall(det, "l2", "write_file", { path: "x" });
    });
    expect(fired.find((h) => h.steps.length === 2)).toMatchObject({ count: 4, split: { within: 1, across: 3 } });
  });

  it("never forms a window longer than maxLen", () => {
    const names = ["a", "b", "c", "d"];
    const recs: ObsRecord[] = [];
    names.forEach((n, i) => {
      recs.push(rec({ spanId: `${i}`, source: "tool", status: "pending", name: n, input: {} }));
      recs.push(rec({ spanId: `${i}`, source: "tool", status: "ok", name: n }));
    });
    const windows = windowsFromRecords(recs, 2);
    expect(windows.every((w) => w.length <= 2)).toBe(true);
  });
});
