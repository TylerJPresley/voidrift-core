/**
 * The first-run seed `config.json` document (core-blueprint.md §13.8).
 *
 * This is the EXACT document `config.init` writes on a first run (§13.9.1): the
 * single `local` model entry, `modelSelected: "local"`, the visible populated
 * allow list under `permissions`, an empty `unlock`, the default `webSearch`,
 * `findingsDirectories`, and an empty `worktreeInclude`. It is a complete, valid document — a first run is
 * never a boot failure for want of config — and it validates against the strict
 * `ConfigSchema` (asserted by a test).
 *
 * The allow list is written in the EXISTING persisted-permission-rule format
 * (§9.2): each entry is a `{ tool, pattern?, decision: "allow", priority, source
 * }` record keyed by a stable id under `permissions`. `source` is `"default"`
 * (the seeded, shipped layer — NOT a rename of the enum) and `priority` is `0`
 * (the default-layer priority, §9.2). These allow rules make the listed tools
 * and `execute_command` patterns run WITHOUT prompting in chat; force-ask
 * families (dangerous shell, SSRF ranges, plugin install) still ask because an
 * allow rule can never satisfy a force-ask (§9.3, §9.5).
 */
import type { PermissionRule } from "./schema.js";

/** The seeded allow-listed built-in tool names (§13.8). Includes
 * `researcher_save_notes` (§8.6): it WRITES (so it is gated like every write),
 * but its writes are confined to the configured `findingsDirectories`, so the
 * read-only `research` agent runs it without a prompt via this allow rule. */
const ALLOW_TOOLS: string[] = [
  "read_file",
  "glob_files",
  "search_contents",
  "workspace_map",
  "query_logs",
  "list_skills",
  "load_skill",
  "web_fetch",
  "web_search",
  "wait",
  "ingest",
  "researcher_save_notes",
  "save_memory",
  "list_memory",
  "delete_memory",
  "task",
];

/**
 * The seeded `execute_command` allow patterns (§13.8). Each is a command glob in
 * the shared matcher's semantics (§9.2): no path separator, `*` = match-anything.
 *
 * TODO(@voidrift/plugin-software-dev, handoff §0.5): the last three entries
 * (`npm test*`, `npm run test*`, `npx vitest*`) are development-flavoured and
 * will move to `@voidrift/plugin-software-dev`, contributed only when that plugin
 * is enabled. They are seeded in the base config for now.
 */
const ALLOW_EXECUTE_PATTERNS: string[] = [
  "git status*",
  "git log*",
  "git branch*",
  "git diff*",
  "ls*",
  "pwd",
  "echo*",
  "node --version",
  "npm test*",
  "npm run test*",
  "npx vitest*",
];

/** Build the seeded `permissions` record of allow rules (§9.2, §13.8). Each id
 * is stable and human-legible so `/access` and `doctor` can name it. */
export function seedPermissions(): Record<string, PermissionRule> {
  const out: Record<string, PermissionRule> = {};
  for (const tool of ALLOW_TOOLS) {
    out[`allow-${tool}`] = { tool, decision: "allow", priority: 0, source: "default" };
  }
  let n = 0;
  for (const pattern of ALLOW_EXECUTE_PATTERNS) {
    out[`allow-exec-${n++}`] = {
      tool: "execute_command",
      pattern,
      decision: "allow",
      priority: 0,
      source: "default",
    };
  }
  return out;
}

/** The exact first-run seed `config.json` document (§13.8). */
export function seedConfigDocument(): Record<string, unknown> {
  return {
    models: {
      local: {
        model: "local-model",
        protocol: "openai",
        baseUrl: "http://localhost:11434/v1",
        // A concrete context window so a first-run core fully resolves its model
        // for the orchestrator AND dispatched workers (the model provider
        // requires a window for an unknown model id, §11.2). 32768 is a safe
        // default for a local OpenAI-compatible server; the user edits it.
        contextLimit: 32768,
      },
    },
    modelSelected: "local",
    permissions: seedPermissions(),
    unlock: [],
    webSearch: { provider: "duckduckgo" },
    findingsDirectories: [".voidrift/research/"],
    worktreeInclude: [],
    // The mutation journal content-capture level (§10.11, §13.10). Seeded
    // visibly at its default so a first run records before/after content of
    // every write; set to `turn` or `off` to capture less.
    mutationLogLevel: "action",
    // Rollback: how many recent moves are tracked (§10.12, §13.10). Seeded
    // visibly at its default so a first run keeps up to 50 undoable moves; set
    // to 0 to disable rollback, or raise/lower it (0–500) to taste.
    snapshotCount: 50,
  };
}

/** The example command/tool each seeded allow rule should satisfy under the real
 * matcher (§9.2) — the source of truth for the rule→example proof test. */
export const SEED_ALLOW_EXAMPLES: { id: string; tool: string; value: string }[] = [
  ...ALLOW_TOOLS.map((tool) => ({ id: `allow-${tool}`, tool, value: "" })),
  { id: "allow-exec-0", tool: "execute_command", value: "git status" },
  { id: "allow-exec-1", tool: "execute_command", value: "git log --oneline -3" },
  { id: "allow-exec-2", tool: "execute_command", value: "git branch" },
  { id: "allow-exec-3", tool: "execute_command", value: "git diff HEAD~1" },
  { id: "allow-exec-4", tool: "execute_command", value: "ls -la" },
  { id: "allow-exec-5", tool: "execute_command", value: "pwd" },
  { id: "allow-exec-6", tool: "execute_command", value: "echo hello" },
  { id: "allow-exec-7", tool: "execute_command", value: "node --version" },
  { id: "allow-exec-8", tool: "execute_command", value: "npm test -- --run" },
  { id: "allow-exec-9", tool: "execute_command", value: "npm run test:unit" },
  { id: "allow-exec-10", tool: "execute_command", value: "npx vitest --run" },
];
