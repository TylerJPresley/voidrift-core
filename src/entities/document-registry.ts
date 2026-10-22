/**
 * The document registry (core-blueprint.md §4.5).
 *
 * Tracks every file read into working context: trust level, content hash, the
 * turn it was added, and a staleness flag. It renders as a one-line manifest per
 * entry in the Void layer (§4.2.1 tier 3) — name, path, size, trust, stale — with
 * no file body. A hash is computed by the ONE shared diff/hash utility (§8.2), so
 * a staleness check never diverges from the workspace-map cache key or an
 * approval diff. Storage is the session's `documents` map (§5.1); this entity is
 * the behavior over it and the emitter of `DOCUMENT_REGISTRY_CHANGED`.
 */
import { contentHash } from "./hash.js";
import type { DocumentEntry, DocumentTrust, Session } from "./session.js";

/** The one-line manifest shape for an entry (§4.5). No body. */
export interface DocumentManifestLine {
  name: string;
  path: string;
  size: number;
  trust: DocumentTrust;
  stale: boolean;
}

type Emit = (type: string, payload: unknown) => void;

export class DocumentRegistry {
  constructor(
    private readonly session: Session,
    private readonly emit: Emit,
  ) {}

  /**
   * Record (or refresh) a document the agent read into context (§4.5). The hash
   * is the shared utility's hash of the content; `turnAdded` is the turn that
   * read it. Re-adding an unchanged path refreshes trust/lines without a churn
   * event; adding a new path (or re-adding changed content) emits `added`.
   */
  add(args: {
    path: string;
    content: string;
    trust: DocumentTrust;
    turn: number;
    lines?: number;
  }): DocumentEntry {
    const hash = contentHash(args.content);
    const lines = args.lines ?? (args.content === "" ? 0 : args.content.split("\n").length);
    const existing = this.session.documents.get(args.path);
    const entry: DocumentEntry = {
      path: args.path,
      hash,
      stale: false,
      turnAdded: existing ? existing.turnAdded : args.turn,
      trust: args.trust,
      lines,
    };
    this.session.registerDocument(entry);
    this.session.markRead(args.path);
    if (!existing || existing.hash !== hash) {
      this.emit("DOCUMENT_REGISTRY_CHANGED", { path: args.path, action: "added" });
    }
    return entry;
  }

  /**
   * Re-check a path against its current on-disk content and mark it stale when
   * the hash drifted (§4.5). Returns true when the entry transitioned to stale.
   */
  checkStale(path: string, currentContent: string): boolean {
    const entry = this.session.documents.get(path);
    if (!entry) return false;
    const changed = entry.hash !== contentHash(currentContent);
    if (changed && !entry.stale) {
      this.markStale(path);
      return true;
    }
    return false;
  }

  /** Mark a path stale and emit the change (§4.5). Idempotent on the event. */
  markStale(path: string): void {
    const entry = this.session.documents.get(path);
    if (!entry || entry.stale) return;
    entry.stale = true;
    this.session.markStale(path);
    this.emit("DOCUMENT_REGISTRY_CHANGED", { path, action: "stale" });
  }

  /**
   * Mark every document added on or before `turn` stale (§4.5, §4.9) — called
   * when compaction folds a turn, so a folded turn's documents re-read rather
   * than vanish. Returns the paths newly marked.
   */
  markFoldedStale(foldedThroughTurn: number): string[] {
    const marked: string[] = [];
    for (const entry of this.session.documents.values()) {
      if (!entry.stale && entry.turnAdded <= foldedThroughTurn) {
        this.markStale(entry.path);
        marked.push(entry.path);
      }
    }
    return marked;
  }

  /** The manifest lines for the Void layer (§4.2.1 tier 3), stable path order. */
  manifest(): DocumentManifestLine[] {
    return [...this.session.documents.values()]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((e) => ({
        name: e.path.split("/").pop() ?? e.path,
        path: e.path,
        size: e.lines,
        trust: e.trust,
        stale: e.stale,
      }));
  }
}

/** Render a manifest line to its one-line text form (§4.5). */
export function renderManifestLine(line: DocumentManifestLine): string {
  const staleMark = line.stale ? " [STALE]" : "";
  return `- ${line.name} (${line.path}, ${line.size} lines, ${line.trust})${staleMark}`;
}
