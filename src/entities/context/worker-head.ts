/**
 * The worker head snapshot (core-blueprint.md §4.2.1 worker head, §7.1).
 *
 * A dispatched worker's context is assembled by the SAME head assembly as the
 * orchestrator's (`assembleHead` → `buildSystemMessage`), but from the WORKER's
 * own agent definition, so a worker and the orchestrator never drift apart on
 * what a head is. The worker variant carries: the worker's own system prompt
 * (its `AgentDefinition.systemPrompt`), the `core.rules` hard-rules digest, the
 * worker-variant meta block (§4.4, no Workers/Concurrency line, Session naming
 * the worker + parent), the skills index, and the manual TOC. It EXCLUDES
 * AGENTS.md project instructions, memory (identity/directive/index), the plan
 * status, the worker list, and the orchestrator's conversation — the project
 * facts a worker needs reach it only through its task text and `context` (§12.8).
 *
 * Pure: it builds a `ContextSnapshot` the shared `assembleHead` consumes; no
 * infrastructure imports, so the exclusion contract stays testable in the entity
 * layer.
 */
import { emptySnapshot, type ContextSnapshot, type SkillManifestLine, type ManualManifestLine } from "./snapshot.js";
import type { EnvironmentFacts } from "./meta-block.js";

/** The live inputs a worker head is assembled from (§4.2.1 worker variant). */
export interface WorkerHeadInputs {
  /** The worker's own static system prompt (`AgentDefinition.systemPrompt`). */
  systemPrompt: string;
  /** The `core.rules` hard-rules digest — inline for every agent, worker too. */
  hardRules: string;
  /** The worker-variant environment facts (§4.4): `worker` set, no sibling/plan
   * list leaks through the meta block. */
  environment: EnvironmentFacts;
  /** The skills index manifest (§12.1) — one line per skill, no bodies. */
  skills: SkillManifestLine[];
  /** The manual table of contents (§12.8) — one line per doc. */
  manuals: ManualManifestLine[];
}

/**
 * Build the per-turn snapshot for a WORKER (§4.2.1 worker head). The excluded
 * head sources (AGENTS.md, memory, plan status, worker list, orchestrator
 * conversation) are simply never populated, so the shared `assembleHead` renders
 * exactly the worker head the spec names — without a second assembly path.
 */
export function buildWorkerSnapshot(inputs: WorkerHeadInputs): ContextSnapshot {
  const snap = emptySnapshot(inputs.environment);
  snap.systemPrompt = inputs.systemPrompt;
  snap.hardRules = inputs.hardRules;
  // §4.2.1 worker variant — NO plan status for a worker (plans are an
  // orchestrator concern); leave `planStatus` empty so no "Status:" line is
  // added as a head component. The skills index and manual TOC ride the Void
  // layer exactly as the orchestrator's do.
  snap.skills = inputs.skills;
  snap.manuals = inputs.manuals;
  // Deliberately NOT set (the worker-head exclusion contract): projectInstructions
  // (AGENTS.md), identityMemory / digests / referenceMemory (memory), documents,
  // agent/void/turn provider blocks (orchestrator conversation + plugins).
  return snap;
}
