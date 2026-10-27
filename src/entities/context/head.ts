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
 * manifest-only, and not-in-head. It is bounded by `contextHeadBudgetPct`
 * (a share of the window); when assembled head content exceeds the cap, lower
 * tiers degrade first — a digest shortens, a manifest truncates with a note — so
 * the inline-always tier and the hard rules are never dropped.
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

/** The assembled head and its measurements. */
export interface AssembledHead {
  blocks: ContentBlock[];
  headTokens: number;
  agentTokens: number;
  voidTokens: number;
  tierSplit: HeadTierSplit;
  /** True when degradation ran because content exceeded the cap. */
  degraded: boolean;
}

function join(parts: string[]): string {
  return parts.filter((p) => p.trim() !== "").join("\n\n");
}

/** Render the inline-always Agent content (§4.2.1 tier 1). Never dropped. */
function renderInlineAgent(
  snapshot: ContextSnapshot,
): string {
  const parts: string[] = [];
  if (snapshot.systemPrompt) parts.push(snapshot.systemPrompt);
  if (snapshot.blockedTools.length > 0) {
    parts.push(`Blocked tools: ${snapshot.blockedTools.join(", ")}`);
  }
  const meta = renderMetaBlock(snapshot.environment);
  parts.push(meta.text);
  for (const b of snapshot.agentProviderBlocks) parts.push(b);
  if (snapshot.hardRules) parts.push(snapshot.hardRules);
  if (snapshot.identityMemory) parts.push(`Identity:\n${snapshot.identityMemory}`);
  parts.push(`Status: ${snapshot.planStatus || "no active plan"}`);
  return join(parts);
}

/** Render a digest+pointer item (§4.2.1 tier 2). `shorten` degrades the digest. */
function renderDigest(d: DigestPointer, shorten: boolean): string {
  const digest = shorten ? d.digest.slice(0, Math.ceil(d.digest.length / 2)).trimEnd() + "…" : d.digest;
  return `${d.label} (full copy: ${d.pointer}):\n${digest}`;
}

/** Render a manifest section, truncating with a note when `limit` is set (§4.2.1 tier 3). */
function renderManifest(
  title: string,
  lines: string[],
  limit: number | null,
): string {
  if (lines.length === 0) return "";
  let shown = lines;
  let note = "";
  if (limit !== null && lines.length > limit) {
    shown = lines.slice(0, limit);
    note = `\n… (${lines.length - limit} more truncated to fit the head budget)`;
  }
  return `${title}:\n${shown.join("\n")}${note}`;
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

/** Collapse newlines to single spaces in text to prevent header injection (§12.8). */
function collapseNewlines(text: string): string {
  return text.replace(/[\r\n\u2028\u2029\u0085]+/g, " ");
}

function manualLines(manuals: ManualManifestLine[]): string[] {
  return manuals.map((m) => {
    const summary = collapseNewlines(m.summary);
    const readWhen = collapseNewlines(m.readWhen);
    const contrib = m.contributed ? " [contributed]" : "";
    return `- ${m.id}: ${summary} Read when: ${readWhen}${contrib}`;
  });
}

/**
 * Assemble the head within `headCap` tokens (§4.2.1). Builds the Agent and Void
 * layers, measures them, and if over the cap degrades lower tiers first: shorten
 * digests, then truncate manifests — never the inline-always tier or hard rules.
 */
export function assembleHead(
  snapshot: ContextSnapshot,
  headCap: number,
): AssembledHead {
  const inlineAgent = renderInlineAgent(snapshot);
  const inlineTokens = estimateTokens(inlineAgent);

  const build = (shortenDigests: boolean, manifestLimit: number | null): {
    agentText: string;
    voidText: string;
    digestTokens: number;
    manifestTokens: number;
  } => {
    const digestText = join(snapshot.digests.map((d) => renderDigest(d, shortenDigests)));
    const voidParts: string[] = [];
    const docM = renderManifest("Documents", docLines(snapshot.documents), manifestLimit);
    const skillM = renderManifest("Skills", skillLines(snapshot.skills), manifestLimit);
    const manualM = renderManifest("Manual", manualLines(snapshot.manuals), manifestLimit);
    const refM = renderManifest("Memory index", refMemoryLines(snapshot.referenceMemory), manifestLimit);
    for (const m of [docM, skillM, manualM, refM]) if (m) voidParts.push(m);
    for (const b of snapshot.voidProviderBlocks) voidParts.push(b);
    const voidText = join(voidParts);
    // Digests ride the Agent layer in tier order; keep them with the agent block.
    const agentText = join([inlineAgent, digestText]);
    return {
      agentText,
      voidText,
      digestTokens: estimateTokens(digestText),
      manifestTokens: estimateTokens(voidText),
    };
  };

  let degraded = false;
  let attempt = build(false, null);
  let headTokens = estimateTokens(attempt.agentText) + estimateTokens(attempt.voidText);

  if (headTokens > headCap) {
    // Degrade step 1: shorten digests.
    degraded = true;
    attempt = build(true, null);
    headTokens = estimateTokens(attempt.agentText) + estimateTokens(attempt.voidText);
  }
  if (headTokens > headCap) {
    // Degrade step 2: truncate manifests, scaling the limit to the remaining room.
    const room = Math.max(0, headCap - inlineTokens);
    // A coarse per-line budget; at least show nothing but the note when desperate.
    const limit = Math.max(0, Math.floor(room / 40));
    attempt = build(true, limit);
    headTokens = estimateTokens(attempt.agentText) + estimateTokens(attempt.voidText);
  }

  const blocks: ContentBlock[] = [];
  if (attempt.agentText.trim() !== "") {
    blocks.push({ layer: "agent", text: attempt.agentText, cacheBoundary: true });
  }
  if (attempt.voidText.trim() !== "") {
    blocks.push({ layer: "void", text: attempt.voidText, cacheBoundary: true });
  }

  const agentTokens = estimateTokens(attempt.agentText);
  const voidTokens = estimateTokens(attempt.voidText);
  return {
    blocks,
    headTokens: agentTokens + voidTokens,
    agentTokens,
    voidTokens,
    tierSplit: {
      inline: inlineTokens,
      digest: attempt.digestTokens,
      manifest: attempt.manifestTokens,
    },
    degraded,
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
