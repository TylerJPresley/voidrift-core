/**
 * The in-turn, model-facing memory tools (core-blueprint.md §6.2, §6.4, §8.2):
 * `save_memory`, `list_memory`, `delete_memory`.
 *
 * `save_memory` is the ONE model-facing write for the two agent-owned memory
 * types, so a lesson learned mid-run is persisted the moment it is learned
 * rather than waiting for a session-boundary suggestion (§6.2). It writes only
 * `user-model` and `note`; a call naming `identity` or `project` is HARD-REFUSED
 * with `MEMORY_TYPE_FORBIDDEN` and nothing is persisted — regardless of any
 * allow rule, `unlisted: allow` agent, session approval or fan-out grant (the
 * refusal is in the capability, upstream of the gate). Body and summary are
 * secret-scrubbed by the shared detector (§10.10) before write, the write is
 * bounded (§6.3), deduplicated by normalized body (§6.7), verified by read-back
 * (§6.4), and carries `sourceSessionId` (§6.2).
 *
 * These three are allow-listed by default (§6.4, §13.8) so the agent curates its
 * own memory without a prompt, like the read-class built-ins. They are bound to
 * the model only when the active agent lists them (the engine's per-agent filter).
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { Result } from "../entities/errors.js";
import type { MemoryEntryDTO } from "../use-cases/memory.js";
import type { MemoryScope } from "../entities/memory/memory-entry.js";

/** `save_memory` arguments (§6.2/§8.2). `strict()` rejects any extra field.
 * `type` is accepted as a free STRING at the boundary (not a Zod enum): the
 * capability (`saveInTurn`) is the single source of truth for which types are
 * writable, so a non-writable or malformed type (`identity`, `project`, `'Note'`,
 * `' note'`, `'bogus'`) returns the documented typed `MEMORY_TYPE_FORBIDDEN`
 * failure naming the two writable types, rather than a generic Zod schema error.
 * `scope` stays enum-restricted. Size caps still apply via `.strict()` + the
 * capability's bounds (§6.3). */
export const SAVE_MEMORY_SCHEMA = z
  .object({
    title: z.string(),
    body: z.string().optional(),
    summary: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    type: z.string().optional(),
    scope: z.enum(["workspace", "global"]).optional(),
  })
  .strict();

/** `list_memory` takes no arguments (§8.2). `strict()` rejects extras. */
export const LIST_MEMORY_SCHEMA = z.object({}).strict();

/** `delete_memory { id }` (§8.2). */
export const DELETE_MEMORY_SCHEMA = z.object({ id: z.string() }).strict();

/** The narrow write/read surface the tools need — the `Memory` use-case
 * satisfies it. Decoupled so the tool module never imports the capability's
 * whole dependency graph. */
export interface MemoryToolBackend {
  saveInTurn(input: {
    title: string;
    body?: string;
    summary?: string;
    keywords?: string[];
    type?: string;
    scope?: MemoryScope;
    sourceSessionId?: string;
  }): Promise<Result<MemoryEntryDTO>>;
  list(): MemoryEntryDTO[];
  delete(id: string): Promise<Result<{ id: string }>>;
}

/**
 * Build the three memory tools bound to the active session (`sourceSessionId`).
 * Each returns a plain string: a human line on success, or `Error: <CODE> …` on
 * failure (surfaced as a tool error line like the other built-ins). The forbidden
 * type is refused by the capability with `MEMORY_TYPE_FORBIDDEN` BEFORE any write.
 */
export function buildMemoryTools(
  backend: MemoryToolBackend,
  sessionId: string,
): StructuredToolInterface[] {
  const saveMemory = tool(
    async (args: {
      title: string;
      body?: string;
      summary?: string;
      keywords?: string[];
      type?: string;
      scope?: "workspace" | "global";
    }) => {
      const res = await backend.saveInTurn({ ...args, sourceSessionId: sessionId });
      if (!res.ok) return `Error: ${res.error.code}: ${res.error.message}`;
      const e = res.value;
      return `Saved memory [${e.id}] (${e.type}/${e.scope}): ${e.summary}`;
    },
    {
      name: "save_memory",
      description:
        "Record a durable fact you learned this turn as agent-owned memory. " +
        "type 'note' (default) is a learned decision/convention/lesson; 'user-model' is a user preference or working style. " +
        "Cannot write identity or project memory. Body and summary are secret-masked and bounded before saving.",
      schema: SAVE_MEMORY_SCHEMA,
    },
  );

  const listMemory = tool(
    async () => {
      const entries = backend.list();
      if (entries.length === 0) return "No memory entries.";
      return entries
        .map((e) => `- [${e.id}] (${e.type}/${e.scope}) ${e.title}: ${e.summary}`)
        .join("\n");
    },
    { name: "list_memory", description: "List all memory entries with their id, type, scope, title and summary.", schema: LIST_MEMORY_SCHEMA },
  );

  const deleteMemory = tool(
    async ({ id }: { id: string }) => {
      const res = await backend.delete(id);
      if (!res.ok) return `Error: ${res.error.code}: ${res.error.message}`;
      return `Deleted memory [${id}].`;
    },
    { name: "delete_memory", description: "Delete a memory entry by its id.", schema: DELETE_MEMORY_SCHEMA },
  );

  return [saveMemory, listMemory, deleteMemory];
}
