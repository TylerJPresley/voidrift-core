/**
 * The session repository port (core-blueprint.md §5.1, §1 rule 6).
 *
 * Mirrors the VoidRift session state the checkpointer does not hold — metadata,
 * the document registry (stale marks), pending approvals, session rules, and
 * the approval mode — so a resume in any process restores the whole session,
 * not only the conversation (§5.3). The checkpointer owns the message chain.
 */
import type { SessionMetadata, DocumentEntry, TurnSnapshot, ApprovalMode } from "../session.js";
import type { PermissionRule } from "../../config/schema.js";
import type { PendingApproval } from "../approvals.js";

/** The persisted shape of a session beyond its message chain (§5.1). */
export interface PersistedSession {
  metadata: SessionMetadata;
  documents: DocumentEntry[];
  pending: PendingApproval[];
  sessionRules: PermissionRule[];
  approvalMode: ApprovalMode;
  lastStatus: string;
  /** Per-turn snapshots mirrored to `turns.json` (§5.1); the move conversation halves (§5.4, §10.12). */
  turns?: TurnSnapshot[];
}

export interface SessionRepository {
  /** Persist a session's current state (mirrored on every mutation, §5.2). */
  save(state: PersistedSession): Promise<void>;
  /** Load a session's persisted state, or null when the id is unknown. */
  load(id: string): Promise<PersistedSession | null>;
  /** List all sessions' metadata, newest-active first (§2.4). */
  list(): Promise<SessionMetadata[]>;
  /** Delete a session's persisted state (§5.8). */
  remove(id: string): Promise<void>;
  /** Await every accepted-but-unfinished write so a clean shutdown drains the
   * mirror before exit (§5.2). Concurrent `save()`s to the same partition are
   * serialized per session; a SIGTERM mid-write must leave either the old or the
   * new file, never a torn one. Optional: an in-memory store writes synchronously
   * and needs no drain. */
  drain?(): Promise<void>;
}
