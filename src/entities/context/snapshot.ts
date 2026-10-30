/**
 * Context-pipeline shared types and the per-turn snapshot (core-blueprint.md §4.1).
 *
 * Before each model call the engine resolves every asynchronous input once into
 * this synchronous snapshot, because the context providers run inside the
 * synchronous `wrapModelCall` hook (§4.1). The snapshot is rebuilt every turn, so
 * a changed document, a loaded memory, or a config edit takes effect next turn
 * without a restart. These are pure data shapes — no infrastructure imports — so
 * the pipeline logic stays in the entity layer.
 */
import type { DocumentManifestLine } from "../document-registry.js";
import type { EnvironmentFacts } from "./meta-block.js";

export type { EnvironmentFacts } from "./meta-block.js";

/** The three ordered layers plus the per-turn metadata tail (§4.2). */
export type LayerName = "agent" | "void" | "turn";

/** A manifest entry for the skills index (§12.1) — rendered one line, no body. */
export interface SkillManifestLine {
  name: string;
  description: string;
}

/** A manifest entry for the manual TOC (§12.8) — rendered one line per doc. */
export interface ManualManifestLine {
  id: string;
  summary: string;
  readWhen: string;
  /** True when the doc is contributed (not core/ or cli/). */
  contributed: boolean;
}

/** A memory-index line (§4.6, §6.2) — one line per agent-written entry carrying
 * its one-line `summary`, surfaced in full by keyword or by id. */
export interface ReferenceMemoryLine {
  key: string;
  summary: string;
  keywords: string[];
}

/**
 * A digest-plus-pointer head item (§4.2.1 tier 2): a short digest rides the head
 * with a pointer to the full copy in the session cache. The full body lives on
 * disk; only the digest and the pointer path cost head tokens.
 */
export interface DigestPointer {
  label: string;
  digest: string;
  /** Pointer under `.voidrift/cache/session/<id>/` the model reads on demand (§4.2.1). */
  pointer: string;
}

/**
 * The per-turn snapshot the context providers read (§4.1). Memory and skills
 * bodies are slices 4/5; this slice renders what exists through the provider
 * seams — identity memory inline, directive memory as a digest+pointer, the
 * reference-memory and skills indexes as manifests.
 */
export interface ContextSnapshot {
  /** The agent's static system prompt (§4.2.1 tier 1). */
  systemPrompt: string;
  /** Names of tools blocked for this agent, rendered as a notice (§4.2.1 tier 1). */
  blockedTools: string[];
  /** The hard rules digest (`core.rules`) — always inline, never a pointer (§4.2.1). */
  hardRules: string;
  /** The resolved environment (§4.4). */
  environment: EnvironmentFacts;
  /** A one-line goal-or-plan status (§4.2.1 tier 1). */
  planStatus: string;
  /** Identity memory, inline every turn (§6.2, §4.6). */
  identityMemory: string;
  /** AGENTS.md project instructions, inline every turn as a tier-1 item (§6.6,
   * §4.2.1). The whole merged content when it fits the window; an ingest digest
   * plus a notice (naming the full-copy pointer) only when the merge cannot fit
   * the window at all (§8.7). */
  projectInstructions: string;
  /** Directive-beyond-identity memory as digest+pointer (§4.2.1 tier 2). */
  digests: DigestPointer[];
  /** The document-registry manifest (§4.5, tier 3). */
  documents: DocumentManifestLine[];
  /** The skills index manifest (§12.1, tier 3). */
  skills: SkillManifestLine[];
  /** The manual table of contents manifest (§12.8, tier 3). */
  manuals: ManualManifestLine[];
  /** The reference-memory index (§6.2, tier 3). */
  referenceMemory: ReferenceMemoryLine[];
  /** Registered agent-provider content (plugins/capabilities), Agent layer. */
  agentProviderBlocks: string[];
  /** Registered void-provider content (plugins/capabilities), Void layer. */
  voidProviderBlocks: string[];
  /** Registered rift-provider content + one-shot injected context + MCP instructions (turn metadata). */
  turnMetadataBlocks: string[];
}

/** An empty snapshot with sane defaults, so a provider contributes only what it has. */
export function emptySnapshot(environment: EnvironmentFacts): ContextSnapshot {
  return {
    systemPrompt: "",
    blockedTools: [],
    hardRules: "",
    environment,
    planStatus: "",
    identityMemory: "",
    projectInstructions: "",
    digests: [],
    documents: [],
    skills: [],
    manuals: [],
    referenceMemory: [],
    agentProviderBlocks: [],
    voidProviderBlocks: [],
    turnMetadataBlocks: [],
  };
}

