/**
 * The document registry (core-blueprint.md §4.5) — trust, hash, turn-added,
 * staleness, and the one-line manifest with no body.
 */
import { describe, it, expect } from "vitest";
import { DocumentRegistry, renderManifestLine } from "./document-registry.js";
import { Session, type SessionMetadata } from "./session.js";

function session(): Session {
  const meta: SessionMetadata = {
    id: "s1",
    name: "n",
    summary: "",
    workspace: "/ws",
    startedAt: "t",
    lastActiveAt: "t",
    turnCount: 0,
    sizeBytes: 0,
    namePinned: false,
  };
  return new Session(meta);
}

describe("DocumentRegistry (§4.5)", () => {
  it("records a live document and emits DOCUMENT_REGISTRY_CHANGED added", () => {
    // Given a session and a captured event
    const s = session();
    const events: { type: string; payload: unknown }[] = [];
    const reg = new DocumentRegistry(s, (type, payload) => events.push({ type, payload }));
    // When a file is read into context
    reg.add({ path: "a.ts", content: "line1\nline2", trust: "live", turn: 1 });
    // Then the entry carries hash, trust, turnAdded and lines, and emits added
    const entry = s.documents.get("a.ts")!;
    expect(entry.trust).toBe("live");
    expect(entry.turnAdded).toBe(1);
    expect(entry.lines).toBe(2);
    expect(entry.stale).toBe(false);
    expect(events).toContainEqual({ type: "DOCUMENT_REGISTRY_CHANGED", payload: { path: "a.ts", action: "added" } });
  });

  it("marks stale on a disk-change (hash drift) and emits stale", () => {
    const s = session();
    const events: { type: string; payload: unknown }[] = [];
    const reg = new DocumentRegistry(s, (type, payload) => events.push({ type, payload }));
    reg.add({ path: "a.ts", content: "v1", trust: "live", turn: 1 });
    // When the on-disk content changes
    const transitioned = reg.checkStale("a.ts", "v2");
    // Then it goes stale once
    expect(transitioned).toBe(true);
    expect(s.documents.get("a.ts")!.stale).toBe(true);
    expect(events).toContainEqual({ type: "DOCUMENT_REGISTRY_CHANGED", payload: { path: "a.ts", action: "stale" } });
  });

  it("marks folded turns' documents stale (§4.9)", () => {
    const s = session();
    const reg = new DocumentRegistry(s, () => {});
    reg.add({ path: "old.ts", content: "x", trust: "live", turn: 1 });
    reg.add({ path: "new.ts", content: "y", trust: "live", turn: 5 });
    // When turns 1..3 are folded
    const marked = reg.markFoldedStale(3);
    // Then only the folded turn's document goes stale
    expect(marked).toEqual(["old.ts"]);
    expect(s.documents.get("old.ts")!.stale).toBe(true);
    expect(s.documents.get("new.ts")!.stale).toBe(false);
  });

  it("renders a one-line manifest with name/path/size/trust/stale, no body", () => {
    const line = renderManifestLine({ name: "a.ts", path: "src/a.ts", size: 10, trust: "cached", stale: true });
    expect(line).toBe("- a.ts (src/a.ts, 10 lines, cached) [STALE]");
    expect(line).not.toContain("line1");
  });
});
