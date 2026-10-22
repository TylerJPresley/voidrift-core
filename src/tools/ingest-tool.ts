/**
 * The model-callable `ingest` tool (core-blueprint.md §8.7).
 *
 * `ingest {path?, url?, purpose}` — EXACTLY ONE of `path`/`url`, a required
 * bounded `purpose` — measures a source against the available budget and returns
 * either the WHOLE text (it fits) or a line-anchored DIGEST (it is summarized by
 * a read-only `summarizer` fan-out). The tool is READ-class and allow-listed
 * (§13.8), so it never prompts; it is bound ONLY to a top-level agent that holds
 * `task` AND has workers (chat, vibe, research) — the agents that delegate — so a
 * non-delegating agent cannot reach it.
 *
 * The schema is strict (`additionalProperties: false`); `purpose` is bounded; the
 * "exactly one of path/url" rule is enforced at runtime (a flat object, no
 * top-level `anyOf`, matching the `task` tool's parser-safe shape). The tool
 * returns the rendered digest or the whole text; a read error (containment/secret)
 * surfaces as a typed tool error — the ingest never swallows it.
 */
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { Ingest, IngestSource } from "../use-cases/ingest.js";

export const INGEST_TOOL_NAME = "ingest";

/** Max chars of the model-supplied `purpose` (bounded so it cannot be a runaway
 * string; the digest entity bounds it again at build time). */
const MAX_PURPOSE = 1024;
/** Max chars of a source path/url the model may pass. */
const MAX_SOURCE = 2048;

/** The strict, flat argument schema (§8.7). Both source fields are optional at
 * the schema level; "exactly one" is enforced at runtime so the JSON schema has
 * no top-level `anyOf` (parser-safe on OpenAI-compatible/vLLM servers, like
 * `task`). */
export const INGEST_SCHEMA = z
  .object({
    path: z.string().max(MAX_SOURCE).optional().describe("A workspace-relative file path to ingest (use path OR url, not both)."),
    url: z.string().max(MAX_SOURCE).optional().describe("A URL to ingest via the web_fetch cache (use path OR url, not both)."),
    purpose: z.string().min(1).max(MAX_PURPOSE).describe("Why you need this content — guides what the summaries keep."),
  })
  .strict();

export const INGEST_FORM_ERROR =
  "Error: pass EXACTLY ONE of { path } or { url }, plus a non-empty `purpose`.";

export interface IngestToolDeps {
  /** The Ingest use-case instance (constructed by boot over the real seams). */
  ingest: Ingest;
  /** The caller's available token budget for this turn (`availableBudget`),
   * resolved live by the engine when it builds the tool. */
  availableTokens: () => number;
  /** The turn's AbortSignal, when the engine wires one (cancel reaches workers). */
  signal?: () => AbortSignal | undefined;
}

/** Build the model-callable `ingest` tool. */
export function buildIngestTool(deps: IngestToolDeps): StructuredToolInterface {
  // §8.7 — a per-turn (per tool-instance) guard against an IDENTICAL re-ingest
  // (same source AND same purpose) this turn. The engine rebuilds this tool each
  // turn, so the set lives exactly one turn. The digest cache is keyed by purpose
  // (ingest.ts digestKey), so the same source with a NEW purpose is a genuinely
  // different ingest and is allowed; only an identical re-call is wasteful and
  // refused. A different source or a new turn is unaffected.
  const seen = new Set<string>();
  return tool(
    async (args, config) => {
      const callId = (config as { toolCall?: { id?: string } } | undefined)?.toolCall?.id ?? "";
      const turnSignal = (config as { signal?: AbortSignal } | undefined)?.signal ?? deps.signal?.();
      const err = (content: string): ToolMessage =>
        new ToolMessage({ content, tool_call_id: callId, status: "error" });

      const parsed = INGEST_SCHEMA.safeParse(args);
      if (!parsed.success) return err(INGEST_FORM_ERROR);
      const { path, url, purpose } = parsed.data;
      const hasPath = path !== undefined && path !== "";
      const hasUrl = url !== undefined && url !== "";
      if (hasPath === hasUrl) return err(INGEST_FORM_ERROR); // neither or both
      const source: IngestSource = hasPath ? { path: path! } : { url: url! };

      const sourceKey = (hasPath ? `path:${path!}` : `url:${url!}`) + `\n${purpose}`;
      if (seen.has(sourceKey)) {
        return err(
          `Error: '${hasPath ? path! : url!}' was already ingested this turn for that purpose. ` +
            "To look closer at a delivered result, call ingest again with a narrower purpose, or dispatch a worker; do not repeat an identical ingest.",
        );
      }

      try {
        const result = await deps.ingest.run({
          source,
          purpose,
          availableTokens: deps.availableTokens(),
          ...(turnSignal ? { signal: turnSignal } : {}),
        });
        // Mark as seen only after a successful ingest, so a failed read can be
        // retried this turn.
        seen.add(sourceKey);
        const content = result.mode === "whole" ? result.text : result.rendered;
        return new ToolMessage({ content, tool_call_id: callId, status: "success" });
      } catch (e) {
        // A read error (containment/secret/url-cache miss) surfaces as a typed
        // tool error — never swallowed, never a fabricated digest.
        return err(`Error: ingest failed — ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    {
      name: INGEST_TOOL_NAME,
      description:
        "Ingest a file or URL that is too big to read whole. Reads it, and if it exceeds the budget, " +
        "summarizes it in parallel into one line-anchored digest. " +
        "Pass exactly one of { path } or { url } and a `purpose`. " +
        "Do NOT ingest a result a worker already delivered by reference (it already carries a digest/summary). " +
        "To look closer, call ingest again with a narrower purpose, or dispatch a worker; do not repeat an identical ingest.",
      schema: INGEST_SCHEMA,
    },
  );
}
