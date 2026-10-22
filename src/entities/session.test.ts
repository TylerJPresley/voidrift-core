import { describe, it, expect } from "vitest";
import { Session, type SessionMetadata, type TurnSnapshot } from "./session.js";

function meta(): SessionMetadata {
  return {
    id: "abc12345",
    name: "n",
    summary: "idle",
    workspace: "/ws",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:00:00.000Z",
    turnCount: 0,
    sizeBytes: 0,
    namePinned: false,
  };
}

/** §5.1/§5.4 — the per-turn snapshot mapping, the rewind boundary. */
describe("Session.recordTurn (§5.1, §5.4)", () => {
  const snap = (turn: number, cp: string): TurnSnapshot => ({
    turn,
    timestamp: "2026-01-01T00:00:01.000Z",
    agentId: "orchestrator",
    messageCount: turn * 2,
    checkpointId: cp,
  });

  it("appends a new turn snapshot", () => {
    const s = new Session(meta());
    s.recordTurn(snap(1, "cp1"));
    s.recordTurn(snap(2, "cp2"));
    expect(s.turns.map((t) => t.turn)).toEqual([1, 2]);
    expect(s.turns[1]!.checkpointId).toBe("cp2");
  });

  it("replaces a re-run of the same turn number (one-to-one onto the latest checkpoint)", () => {
    const s = new Session(meta());
    s.recordTurn(snap(1, "cp1"));
    s.recordTurn(snap(1, "cp1b"));
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]!.checkpointId).toBe("cp1b");
  });
});
