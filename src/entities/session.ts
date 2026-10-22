/**
 * The Session entity (core-blueprint.md §5).
 *
 * Each session owns its state; the core holds no process-wide mutable state
 * (§1 rule 11). This holds the current values only, like a save slot: metadata,
 * the per-session config layer, the document registry (read/stale marks that
 * back the unread/stale guardrail), pending approvals, and the per-turn caches.
 * Durable mirroring to the partition is the repository's job (§5.2); this is the
 * in-memory authority.
 */
import type { PermissionRule } from "../config/schema.js";
import type { PendingApproval } from "./approvals.js";
import { LaneCounter } from "./chat-lane.js";
import { ReadLaneCounter } from "./read-lane.js";

/** The rolling-summary state mirrored in metadata (§4.9, §5.1). */
export interface RollingSummaryState {
  summary: string;
  foldedThroughTurn: number;
  updatedAt: string;
}

/**
 * How a Guardian `ask` resolves for this session (§9.5). `interactive` surfaces
 * a host callback; `out_of_band` suspends durably for a detached host;
 * `policy_only` suspends `waiting_for_approval` with no auto-answer; `headless`
 * (cli §8) NEVER suspends — an `ask` is DENIED-AND-CONTINUE (the model gets a
 * tool result saying the action needs a human and this run cannot ask), so a
 * `--prompt`/`--routine` run never ends `waiting_for_approval` and never
 * produces exit 5. The read-only (`deny`) and write (`allow`) postures of the
 * headless start agent mean an `ask` is only ever reached by a force-ask that
 * is never auto-approved (SSRF range, plugin install); those deny-and-continue.
 */
export type ApprovalMode = "interactive" | "policy_only" | "out_of_band" | "headless";

/**
 * The session's active top-level agent (core-blueprint.md §2.7) — the "mode" is
 * the name of the active top-level agent. It replaces the former closed
 * `chat | research | vibe` union: any currently loaded top-level agent name is
 * valid. It is runtime state, selected only by the host through the host-only
 * `session.setMode`, read live inside the single decision point (§9.1) and by
 * every worker/routine/new session a session starts (§9.7). It is NOT persisted
 * and NOT inherited by resume — a new or resumed session starts in `chat` unless
 * the host selected a starting agent at process start (`CoreOptions.startAgent`,
 * or the deprecated `autoApprove` alias). What the active agent controls — the
 * system-prompt overlay, the orchestrator's tool set, the dispatchable workers,
 * and the `unlisted` behaviour for calls off the allow list — is defined in
 * §2.7 and resolved live from the agent definition, never from this string.
 */
export type SessionMode = string;

/** The built-in start/resume agent name (§2.7): always `chat`. */
export const DEFAULT_MODE = "chat";

export interface SessionMetadata {
  id: string;
  name: string;
  summary: string;
  workspace: string;
  startedAt: string;
  lastActiveAt: string;
  turnCount: number;
  sizeBytes: number;
  namePinned: boolean;
  /** The rolling-summary state (§4.9, §5.1); absent until the first fold. */
  rollingSummary?: RollingSummaryState;
}

/** The trust level of a registry entry (§4.5). */
export type DocumentTrust = "live" | "snapshot" | "cached";

/**
 * A per-turn snapshot mirrored to `turns.json` (§5.1). `messageCount` is the
 * chain length after the turn; `checkpointId` is the durable LangGraph
 * checkpoint written at that turn boundary (§5.2). It is the move's
 * conversation half that the unified rollback timeline pairs with the file
 * snapshot (§5.4, §10.12).
 */
export interface TurnSnapshot {
  turn: number;
  timestamp: string;
  agentId: string;
  messageCount: number;
  /** The durable checkpoint id for this turn (§5.2, §5.4); the move's
   * conversation half (§10.12). */
  checkpointId?: string;
}

/** A document-registry entry mirrored to `documents.json` (§5.1, §4.5). */
export interface DocumentEntry {
  path: string;
  hash: string;
  stale: boolean;
  turnAdded: number;
  /** Trust level: in-workspace live, out-of-workspace snapshot, or cached data (§4.5). */
  trust: DocumentTrust;
  /** Line count, surfaced as `size` on the manifest line (§4.5). */
  lines: number;
}

export class Session {
  readonly id: string;
  metadata: SessionMetadata;
  /** Session-scoped Guardian rules (§9.2) and session config overrides. */
  sessionRules: PermissionRule[] = [];
  approvalMode: ApprovalMode = "interactive";
  /**
   * The active top-level agent name (§2.7) — runtime state, read live by the
   * decision point (§9.1) and inherited live by workers/routines/new sessions
   * (§9.7). A new session starts in `chat`; a resumed session starts in `chat`
   * too (the active agent is NOT persisted) unless the host selected a starting
   * agent at process start through `CoreOptions.startAgent` (or the deprecated
   * `autoApprove` alias). Changed only through the host-only `session.setMode`
   * (§2.7).
   */
  mode: SessionMode = DEFAULT_MODE;
  /** Pending approvals awaiting a decision, resolvable by confirm (§9.5). */
  pending: PendingApproval[] = [];
  /** Paths read this session and paths marked stale — back the guardrail (§9.4). */
  readPaths = new Set<string>();
  stalePaths = new Set<string>();
  documents = new Map<string, DocumentEntry>();
  /** The latest user-message text this session received (the current turn's
   * input), for the read-only plugin workspace surface (retrieval-blueprint §5).
   * Set by the facade at the start of each `send`; "" until the first turn. Not
   * persisted — a resumed session has it reset. */
  lastUserInput = "";
  /** The last completed turn's status, for resume (§5.3). */
  lastStatus: string = "completed";
  /** Whether a turn is currently active (guards concurrent send, §2.3). */
  turnActive = false;
  /** The rolling-summary state (§4.9); absent until the first fold. */
  rollingSummary?: RollingSummaryState;
  /** The persisted usage anchor — max input_tokens seen (§4.8). */
  usageAnchor?: number;
  /** The current turn number, incremented at each user turn (§4.9). */
  turn = 0;
  /** Per-turn snapshots mirrored to `turns.json` (§5.1); each turn's conversation
   * checkpoint, the move's conversation half (§5.4, §10.12). */
  turns: TurnSnapshot[] = [];

  /**
   * The chat direct-write lane counter (§3.1). Per-session state the single
   * decision point reads for the ORCHESTRATOR: the executed direct write calls
   * and distinct targets touched this turn, and whether the one-per-turn
   * `LANE_LIMIT_REACHED` event has fired. It persists across a suspend/resume
   * within one turn (the Session is the per-session authority, not the
   * per-send Engine instance). Reset at the start of each turn (engine) and on a
   * `setMode` (facade). A worker never touches it — the lane applies only to the
   * orchestrator.
   */
  lane = new LaneCounter();

  /**
   * The read-lane counter (§3.3). Per-session state the single decision point
   * reads for the ORCHESTRATOR of a top-level agent that holds direct read tools
   * AND can delegate (the built-in `chat`): the direct read-class calls made
   * this turn and whether the one-per-turn harness note has fired. Reset at the
   * start of each turn (engine) and on a `setMode` (facade), like the write
   * lane. A worker never touches it — the read lane applies only to the
   * orchestrator, never to a worker, `research`, or `vibe`.
   */
  readLane = new ReadLaneCounter();

  constructor(metadata: SessionMetadata) {
    this.id = metadata.id;
    this.metadata = metadata;
  }

  /** Record a completed turn's snapshot — the move's conversation half (§5.1, §5.4, §10.12). */
  recordTurn(snapshot: TurnSnapshot): void {
    // One snapshot per turn; a re-run of the same turn number replaces it so the
    // mapping stays one-to-one onto the latest durable checkpoint for that turn.
    const idx = this.turns.findIndex((t) => t.turn === snapshot.turn);
    if (idx >= 0) this.turns[idx] = snapshot;
    else this.turns.push(snapshot);
  }

  /** Record a read for the unread/stale guardrail (§9.4). */
  markRead(path: string): void {
    this.readPaths.add(path);
    this.stalePaths.delete(path);
  }

  /** Mark a path stale (content changed since read). */
  markStale(path: string): void {
    this.stalePaths.add(path);
  }

  /** Register/refresh a document entry (§4.5). */
  registerDocument(entry: DocumentEntry): void {
    this.documents.set(entry.path, entry);
  }
}
