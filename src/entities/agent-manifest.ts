/**
 * Agent-manifest parsing and the discovery port (core-blueprint.md §3.1, §7.1,
 * §12.1).
 *
 * A filesystem agent is a DIRECTORY like a skill (§3.1): `agents/<name>/agent.json`
 * plus an optional sibling `prompt.md`. The manifest is JSON — all VoidRift
 * configuration files are JSON (§13.1); prose is Markdown. The JSON parses with
 * `JSON.parse` and validates against a Zod schema; an inline `prompt` wins over
 * `prompt.md`. A malformed manifest is SKIPPED so one bad directory never breaks
 * discovery (§12.1); the skip reason names the FILE and the field/position.
 *
 * The no-task-tool rule (§7.1) is enforced at REGISTRATION, by the subagents
 * use-case — this layer only parses and validates shape.
 *
 * Pure: no I/O here (the adapter supplies file contents) and no LangChain type
 * (§1 rule 4). The discovery port lets the filesystem adapter be swapped for an
 * in-memory fake in tests (§1 rule 7).
 */
import { z } from "zod";
import type { AgentDefinition } from "./subagents.js";

/** The three discovery sources, cascaded project > global > builtin (§3.1). */
export type AgentSource = "builtin" | "global" | "project";

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The Zod schema an `agent.json` validates against (§3.1, §7.1). `kind` splits
 * the shape: `workers`/`unlisted`/`confirm`/`order`/`label` are TOP-LEVEL ONLY,
 * so a worker that declares any of them is invalid. `confirm` MUST be `true`
 * when a top-level agent's `unlisted` is `allow`.
 */
export const AgentManifestSchema = z
  .object({
    name: z.string().min(1).regex(NAME_RE, "name must be a lowercase slug"),
    description: z.string().min(1),
    kind: z.enum(["top-level", "worker"]),
    tools: z.array(z.string()).default([]),
    model: z.string().optional(),
    /** Inline system prompt; wins over a sibling `prompt.md` (§3.1). */
    prompt: z.string().optional(),
    // ── top-level only (§3.1) ───────────────────────────────────────────────
    workers: z.union([z.array(z.string()), z.literal("all")]).optional(),
    unlisted: z.enum(["deny", "ask", "allow"]).optional(),
    confirm: z.boolean().optional(),
    order: z.number().int().optional(),
    label: z.string().optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    const topLevelOnly: (keyof typeof m)[] = ["workers", "unlisted", "confirm", "order", "label"];
    if (m.kind === "worker") {
      for (const k of topLevelOnly) {
        if (m[k] !== undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: `"${k}" is a top-level-only field; a worker cannot declare it` });
        }
      }
    }
    if (m.kind === "top-level" && m.unlisted === "allow" && m.confirm !== true) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["confirm"], message: `confirm must be true when unlisted is "allow"` });
    }
  });

export type AgentManifest = z.infer<typeof AgentManifestSchema>;

/** The default `order` for a top-level agent when none is declared (§3.1). */
export const DEFAULT_AGENT_ORDER = 100;

/** Raised when a manifest fails to parse or validate; the caller skips it. */
export class AgentManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentManifestError";
  }
}

/**
 * Parse and validate one `agent.json` into an `AgentDefinition` (§3.1). The
 * directory name is required so `name === dirName` is enforced. An optional
 * `promptMd` (the sibling `prompt.md` body) is used ONLY when no inline `prompt`
 * is given; a missing prompt from both sources is an error. Throws
 * `AgentManifestError` naming the FILE and the field/position on any failure, so
 * the caller skips the directory and discovery continues (§12.1). The
 * no-task-tool rule is NOT checked here — registration enforces it (§7.1).
 */
export function parseAgentManifest(raw: string, dirName: string, promptMd?: string): AgentDefinition {
  const file = `agents/${dirName}/agent.json`;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    // SyntaxError from JSON.parse names the position (e.g. "...at position 42").
    throw new AgentManifestError(`${file}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = AgentManifestSchema.safeParse(doc);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? first.path.join(".") : "(root)";
    throw new AgentManifestError(`${file}: ${where}: ${first ? first.message : "invalid manifest"}`);
  }
  const m = parsed.data;
  if (m.name !== dirName) {
    throw new AgentManifestError(`${file}: name "${m.name}" must equal the directory name "${dirName}"`);
  }
  const systemPrompt = m.prompt !== undefined ? m.prompt : (promptMd ?? "").trim();
  if (systemPrompt.length === 0) {
    throw new AgentManifestError(`${file}: a prompt is required (inline "prompt" or a sibling prompt.md)`);
  }
  const def: AgentDefinition = {
    name: m.name,
    description: m.description,
    kind: m.kind,
    systemPrompt,
    tools: m.tools,
    ...(m.model !== undefined ? { model: m.model } : {}),
    ...(m.kind === "top-level"
      ? {
          ...(m.workers !== undefined ? { workers: m.workers } : {}),
          ...(m.unlisted !== undefined ? { unlisted: m.unlisted } : {}),
          ...(m.confirm !== undefined ? { confirm: m.confirm } : {}),
          order: m.order ?? DEFAULT_AGENT_ORDER,
          ...(m.label !== undefined ? { label: m.label } : {}),
        }
      : {}),
  };
  return def;
}

/** One source's discovery result: valid definitions and the directories skipped. */
export interface AgentDiscoveryResult {
  definitions: AgentDefinition[];
  skipped: { name: string; reason: string }[];
}

/**
 * The agent-discovery port (§1 rule 6, §3.1). The filesystem adapter reads the
 * project `<workdir>/.voidrift/agents/` and the global `~/.config/voidrift/agents/`
 * directories, each `<name>/agent.json` (+ `prompt.md`); the built-in `chat`
 * lives in code (not discovered). A fake supplies in-memory manifests in tests.
 * The use-case cascades the sources project > global > built-in.
 */
export interface AgentDiscoveryPort {
  /** Discover and validate every agent under a source, skipping malformed. */
  discover(source: AgentSource): Promise<AgentDiscoveryResult>;
}
