/**
 * The built-in `chat` agent, defined in code (core-blueprint.md §3.1).
 *
 * `chat` is the ONLY agent that lives in code: it is always present in
 * `agents.list` with source `builtin`, is the start/resume agent, and can never
 * be removed or disabled (there is no `disabled` field in the schema). It is
 * OVERRIDABLE by `agents/chat/` in either layer (project or global); an invalid
 * override degrades to this built-in with a warning. It is minimal and safe
 * (`unlisted: ask`, `order` 10, `workers: "all"`).
 */
import type { AgentDefinition } from "./subagents.js";

/** The built-in agent name — always present, never removable (§3.1). */
export const BUILTIN_CHAT_NAME = "chat";

/** The built-in `chat` Shift+Tab order (§3.1): first in the cycle. */
export const BUILTIN_CHAT_ORDER = 10;

/** The built-in `chat` system prompt (§3.1): a general, safe default. */
const CHAT_PROMPT = [
  "You are VoidRift's default assistant. You help with whatever the user asks —",
  "research, writing, planning, audits, operations, and code are all in scope.",
  "You read freely and make small, direct changes when asked; for larger or riskier",
  "work, or broad exploration, delegate to workers and carry the plan → execute → verify",
  "loop through. Push heavy reading, searching and verification onto workers so your own",
  "context holds the intent and the plan, and fan out as many at once as the `workers in",
  "parallel` number in the session data. To fan out, send ONE `task` call using",
  "`tasks: [{ id, worker, task, dependsOn? }]` rather than many calls; a dependent task",
  "lists its prerequisites in `dependsOn`. Split a fan-out by non-overlapping scope so",
  "two workers never read the same thing, and put facts you already know in each task's",
  "`context` so no worker rediscovers them; work from a dependency's summary and never",
  "re-ingest a result already delivered to you. Do not guess a fact — look it up or delegate,",
  "and say where it came from. Record a durable fact you learn with `save_memory`.",
  "Ask a human only when a choice is genuinely theirs.",
].join(" ");

/**
 * Build the built-in `chat` definition (§3.1). A fresh object each call so a
 * caller can never mutate the shared built-in. Source is always `builtin`.
 */
export function builtinChatAgent(): AgentDefinition {
  return {
    name: BUILTIN_CHAT_NAME,
    description: "The default assistant: reads freely, makes small direct changes, delegates larger work.",
    kind: "top-level",
    systemPrompt: CHAT_PROMPT,
    // §2.7b/§3.1 — `chat` lists `"*"` so it keeps the COMPLETE tool set (the
    // read/write built-ins + web + task + every approved MCP tool + plugin
    // tools). A tool not bound anywhere is still not bound; `"*"` means "every
    // tool the harness would otherwise offer this session".
    tools: ["*"],
    workers: "all",
    unlisted: "ask",
    order: BUILTIN_CHAT_ORDER,
    label: "Chat",
    source: "builtin",
  };
}
