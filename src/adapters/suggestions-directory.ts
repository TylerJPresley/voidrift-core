/**
 * Suggestions-directory store (core-blueprint.md §6.7).
 *
 * Reflection writes candidates to `.voidrift/suggestions/`; this adapter owns
 * that directory's filesystem access through `FileSystemPort` (§1 rule 3). Each
 * suggestion is one JSON file named `<id>.json`, so a pending candidate survives
 * across session boundaries and the dedup check can read the pending set.
 */
import path from "node:path";
import type { FileSystemPort } from "../entities/ports/host.js";
import type { Suggestion, SuggestionKind } from "../entities/memory/suggestion.js";

/** The kinds this build understands (§6.7); `"script"` was removed. */
const KNOWN_KINDS: ReadonlySet<SuggestionKind> = new Set<SuggestionKind>(["memory-note", "skill"]);

/** The per-workspace rejected-signature list file (§10.6 Lifecycle). Owner-only. */
const REJECTED_SIGNATURES_FILE = "rejected-signatures.json";
/** Bounded ring of remembered rejected signatures (§10.6): oldest dropped first
 * so a long-lived workspace never grows this file without bound. */
const MAX_REJECTED_SIGNATURES = 256;
/** Owner-only mode for the rejected-signature list (§10.6, like checkpoint.db). */
const OWNER_ONLY = 0o600;

export class SuggestionsDirectory {
  constructor(
    private readonly fs: FileSystemPort,
    /** The suggestions dir, e.g. `<workspace>/.voidrift/suggestions`. */
    private readonly dir: string,
    /** One-line warning sink for a skipped file (unknown kind, malformed). */
    private readonly warn: (message: string) => void = () => {},
  ) {}

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private rejectedFile(): string {
    return path.join(this.dir, REJECTED_SIGNATURES_FILE);
  }

  async save(s: Suggestion): Promise<void> {
    await this.fs.writeFile(this.file(s.id), JSON.stringify(s, null, 2));
  }

  async get(id: string): Promise<Suggestion | null> {
    const file = this.file(id);
    if (!(await this.fs.exists(file))) return null;
    try {
      const s = JSON.parse(await this.fs.readFile(file)) as Suggestion;
      if (!KNOWN_KINDS.has(s.kind)) {
        this.warn(`suggestion ${file} has unknown kind '${s.kind}'; skipped`);
        return null;
      }
      return s;
    } catch {
      return null;
    }
  }

  async list(): Promise<Suggestion[]> {
    const matches = await this.fs.glob(path.join(this.dir, "*.json")).catch(() => [] as string[]);
    const out: Suggestion[] = [];
    for (const rel of matches) {
      try {
        const s = JSON.parse(await this.fs.readFile(rel)) as Suggestion;
        // §6.7 — a file with an unknown kind (e.g. an old `script`) is skipped
        // with a one-line warning naming it; it never crashes listing.
        if (!KNOWN_KINDS.has(s.kind)) {
          this.warn(`suggestion ${rel} has unknown kind '${s.kind}'; skipped`);
          continue;
        }
        out.push(s);
      } catch {
        // A malformed suggestion file is skipped, never fatal.
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listPending(): Promise<Suggestion[]> {
    return (await this.list()).filter((s) => s.status === "pending");
  }

  // ── repeated-sequence lifecycle (§10.6) ──────────────────────────────────────

  /** The remembered rejected sequence signatures for this workspace (§10.6),
   * oldest-first. A missing or malformed list reads as empty. */
  async rejectedSignatures(): Promise<string[]> {
    const file = this.rejectedFile();
    if (!(await this.fs.exists(file))) return [];
    try {
      const parsed = JSON.parse(await this.fs.readFile(file)) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((x): x is string => typeof x === "string");
    } catch {
      return [];
    }
  }

  /** Remember a rejected sequence signature (§10.6 Lifecycle) so the procedure
   * the user declined never re-surfaces. Idempotent (a signature is stored once),
   * bounded (oldest dropped past the cap), and written owner-only + atomically. */
  async rememberRejectedSignature(signature: string): Promise<void> {
    if (!signature) return;
    const current = await this.rejectedSignatures();
    if (current.includes(signature)) return;
    current.push(signature);
    while (current.length > MAX_REJECTED_SIGNATURES) current.shift();
    await this.fs.writeFileAtomic(this.rejectedFile(), JSON.stringify(current, null, 2), { mode: OWNER_ONLY });
  }

  /**
   * Every sequence signature the detector must NOT signal again (§10.6
   * Lifecycle): the signatures of every PENDING or APPROVED suggestion plus the
   * remembered REJECTED list. Seeded into a session's detector at the boundary so
   * a procedure already surfaced (or declined) never re-signals, within or across
   * sessions.
   */
  async suppressedSignatures(): Promise<string[]> {
    const out = new Set<string>(await this.rejectedSignatures());
    for (const s of await this.list()) {
      if ((s.status === "pending" || s.status === "approved") && s.signature) out.add(s.signature);
    }
    return [...out];
  }
}
