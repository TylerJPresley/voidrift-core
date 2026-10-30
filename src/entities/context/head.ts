/**
 * The three-layer head assembly (core-blueprint.md §4.2, §4.2.1, §4.3).
 *
 * The system message is three layers ordered by stability — Agent → Void → Rift
 * — but the Rift layer is the `messages` channel, so what this builds is the
 * single leading SystemMessage: the Agent and Void layers (the protected head),
 * followed by the per-turn metadata tail. The content is an array of blocks split
 * at the layer boundaries so the prompt-caching middleware can attach cache
 * control on the Agent → Void → turn-metadata stability boundaries (§4.3).
 *
 * The head carries four tiers (§4.2.1): inline-always, digest+pointer,
 * manifest-only, and not-in-head. The head has NO cap and NO per-component
 * budget: nothing in it is silently shortened, truncated, or swapped for a
 * digest — every item renders whole, because cutting a head source breaks the
 * harness's output (§4.2.1). A head WARNING guards size instead: when the fixed
 * context (the head plus the bound tool schemas) passes `contextHeadWarnPct` of
 * the window, the engine raises one `CONTEXT_THRESHOLD_CROSSED` `head` crossing
 * carrying the largest components with their sizes (§4.8, §14.6), cutting
 * nothing. The §4.10 hard stop is the only refusal.
 */
import { renderManifestLine, type DocumentManifestLine } from "../document-registry.js";
import { estimateTokens } from "./budget.js";
import {
  type ContextSnapshot,
  type DigestPointer,
  type SkillManifestLine,
  type ReferenceMemoryLine,
  type ManualManifestLine,
} from "./snapshot.js";
import { renderMetaBlock } from "./meta-block.js";

/** A content block carrying its layer and whether it is a cache-break boundary. */
export interface ContentBlock {
  layer: "agent" | "void" | "turn";
  text: string;
  /** True on the last block of a cacheable layer — the stability boundary (§4.3). */
  cacheBoundary: boolean;
}

/** The per-tier token split for the head, surfaced in `ContextBreakdown` (§4.8). */
export interface HeadTierSplit {
  inline: number;
  digest: number;
  manifest: number;
}

/** A single head component with its token size, for the head-warning payload
 * (§4.2.1, §14.6): AGENTS.md, tool schemas, the memory index, the skill/manual
 * manifests, the plan, directive memory, the meta block, and so on. */
export interface HeadComponent {
  name: string;
  tokens: number;
}

/** The assembled head and its measurements. */
export interface AssembledHead {
  blocks: ContentBlock[];
  headTokens: number;
  agentTokens: number;
  voidTokens: number;
  tierSplit: HeadTierSplit;
  /** The head's components with their token sizes, largest first (§4.2.1). The
   * head-warning payload reports the largest of these; the head itself cuts
   * nothing. */
  components: HeadComponent[];
}

function join(parts: string[]): string {
  return parts.filter((p) => p.trim() !== "").join("\n\n");
}

/** Collapse newlines to single spaces in text to prevent header injection (§12.8). */
function collapseNewlines(text: string): string {
  return text.replace(/[\r\n\u2028\u2029\u0085]+/g, " ");
}

/** Render a digest+pointer item whole (§4.2.1 tier 2). */
function renderDigest(d: DigestPointer): string {
  return `${d.label} (full copy: ${d.pointer}):\n${d.digest}`;
}

/** Render a manifest section whole — one line per item, never truncated (§4.2.1 tier 3). */
function renderManifest(title: string, lines: string[]): string {
  if (lines.length === 0) return "";
  return `${title}:\n${lines.join("\n")}`;
}

function skillLines(skills: SkillManifestLine[]): string[] {
  return skills.map((s) => `- ${s.name}: ${s.description}`);
}

function refMemoryLines(ref: ReferenceMemoryLine[]): string[] {
  return ref.map((r) => {
    const kw = r.keywords.length > 0 ? ` [${r.keywords.join(", ")}]` : "";
    return r.summary ? `- ${r.key}: ${r.summary}${kw}` : `- ${r.key}${kw}`;
  });
}

function docLines(docs: DocumentManifestLine[]): string[] {
  return docs.map(renderManifestLine);
}

function manualLines(manuals: ManualManifestLine[]): string[] {
  return manuals.map((m) => {
    const summary = collapseNewlines(m.summary);
    const readWhen = collapseNewlines(m.readWhen);
    const contrib = m.contributed ? " [contributed]" : "";
    return `- ${m.id}: ${summary} Read when: ${readWhen}${contrib}`;
  });
}

/** Add a component with its token size when the text is non-empty (§4.2.1). */
function pushComponent(components: HeadComponent[], name: string, text: string): void {
  const t = text.trim();
  if (t === "") return;
  components.push({ name, tokens: estimateTokens(text) });
}

/**
 * Assemble the head (§4.2.1). Builds the Agent and Void layers with every item
 * rendered WHOLE — no cap, no degradation — and measures them, surfacing the
 * per-component token sizes so the engine can raise the head warning (§4.8)
 * without ever shortening a head source.
 */
export function assembleHead(snapshot: ContextSnapshot): AssembledHead {
  const components: HeadComponent[] = [];

  // --- Agent layer: inline-always (tier 1) + digest+pointer (tier 2) ---
  const inlineParts: string[] = [];
  if (snapshot.systemPrompt) {
    inlineParts.push(snapshot.systemPrompt);
    pushComponent(components, "system prompt", snapshot.systemPrompt);
  }
  if (snapshot.blockedTools.length > 0) {
    inlineParts.push(`Blocked tools: ${snapshot.blockedTools.join(", ")}`);
  }
  const meta = renderMetaBlock(snapshot.environment);
  inlineParts.push(meta.text);
  pushComponent(components, "meta block", meta.text);
  for (const b of snapshot.agentProviderBlocks) inlineParts.push(b);
  if (snapshot.agentProviderBlocks.length > 0) {
    pushComponent(components, "agent provider blocks", snapshot.agentProviderBlocks.join("\n\n"));
  }
  if (snapshot.hardRules) {
    inlineParts.push(snapshot.hardRules);
    pushComponent(components, "hard rules", snapshot.hardRules);
  }
  if (snapshot.identityMemory) {
    inlineParts.push(`Identity:\n${snapshot.identityMemory}`);
    pushComponent(components, "identity memory", snapshot.identityMemory);
  }
  if (snapshot.projectInstructions) {
    inlineParts.push(`AGENTS.md (project instructions):\n${snapshot.projectInstructions}`);
    pushComponent(components, "AGENTS.md", snapshot.projectInstructions);
  }
  // §4.2.1 — the plan status is an orchestrator head item; a worker head carries
  // none (its `planStatus` is empty), so the "Status:" line and its component
  // render only when a plan status is present. The orchestrator always sets
  // `planStatus` ("no active plan" when idle), so its line is unchanged.
  if (snapshot.planStatus) {
    inlineParts.push(`Status: ${snapshot.planStatus}`);
    pushComponent(components, "plan status", snapshot.planStatus);
  }
  const inlineAgent = join(inlineParts);
  const inlineTokens = estimateTokens(inlineAgent);

  const digestText = join(snapshot.digests.map(renderDigest));
  for (const d of snapshot.digests) pushComponent(components, d.label, `${d.digest}`);

  const agentText = join([inlineAgent, digestText]);

  // --- Void layer: manifest-only (tier 3) + void provider blocks ---
  const docM = renderManifest("Documents", docLines(snapshot.documents));
  const skillM = renderManifest("Skills", skillLines(snapshot.skills));
  const manualM = renderManifest("Manual", manualLines(snapshot.manuals));
  const refM = renderManifest("Memory index", refMemoryLines(snapshot.referenceMemory));
  pushComponent(components, "document manifest", docM);
  pushComponent(components, "skills manifest", skillM);
  pushComponent(components, "manual manifest", manualM);
  pushComponent(components, "memory index", refM);
  const voidParts: string[] = [];
  for (const m of [docM, skillM, manualM, refM]) if (m) voidParts.push(m);
  for (const b of snapshot.voidProviderBlocks) voidParts.push(b);
  if (snapshot.voidProviderBlocks.length > 0) {
    pushComponent(components, "void provider blocks", snapshot.voidProviderBlocks.join("\n\n"));
  }
  const voidText = join(voidParts);

  const blocks: ContentBlock[] = [];
  if (agentText.trim() !== "") blocks.push({ layer: "agent", text: agentText, cacheBoundary: true });
  if (voidText.trim() !== "") blocks.push({ layer: "void", text: voidText, cacheBoundary: true });

  const agentTokens = estimateTokens(agentText);
  const voidTokens = estimateTokens(voidText);
  components.sort((a, b) => b.tokens - a.tokens);
  return {
    blocks,
    headTokens: agentTokens + voidTokens,
    agentTokens,
    voidTokens,
    tierSplit: {
      inline: inlineTokens,
      digest: estimateTokens(digestText),
      manifest: estimateTokens(voidText),
    },
    components,
  };
}

/**
 * Append the per-turn metadata tail after the head (§4.2). Turn metadata is not
 * a layer: it is per-turn, never cached, and placed after the Agent and Void
 * layers. All harness-to-model injection rides this one leading system message;
 * nothing is sent as a second system message (§4.2).
 */
export function appendTurnMetadata(head: AssembledHead, snapshot: ContextSnapshot): ContentBlock[] {
  const blocks = [...head.blocks];
  const turnText = join(snapshot.turnMetadataBlocks);
  if (turnText.trim() !== "") {
    blocks.push({ layer: "turn", text: turnText, cacheBoundary: false });
  }
  return blocks;
}
