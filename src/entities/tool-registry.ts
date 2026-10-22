/**
 * The tool registry (core-blueprint.md §8.1).
 *
 * Every tool schema is defined once in Zod and is the single source for both
 * binding and validation (§1 rule 5). Execution routes through a registry keyed
 * by name, never a switch. The read-only classification is the one `readOnly`
 * flag, from which the gate's auto-approve set is derived.
 */
import type { ZodType } from "zod";

export interface ToolDefinition {
  name: string;
  description: string;
  schema: ZodType;
  readOnly: boolean;
  /**
   * Where the tool came from (§8.4). Absent/`builtin` and `plugin` keep the
   * current semantics (a read-only tool is free at the gate — plugins are
   * trusted code, §12.4). `mcp` means the managed-layer gate, Warden, masking,
   * events and the record ALWAYS run and only Guardian's ask is skipped when
   * `readOnly` is true: a server's content is never invisible to compliance.
   */
  origin?: "builtin" | "mcp" | "plugin";
}

export interface ToolResult {
  content: string;
  status: "success" | "error";
  artifact?: unknown;
}

/** Context passed to an executor: the resolved workspace root and per-turn caches. */
export interface ToolContext {
  workspaceRoot: string;
  sessionId: string;
}

export type ToolExecutor = (args: unknown, ctx: ToolContext) => Promise<ToolResult>;

interface Entry {
  def: ToolDefinition;
  exec: ToolExecutor;
  /** True only for an APPROVED MCP tool the engine binds to the model (§8.4).
   * A pending/quarantined MCP guard stub is registered (so a hallucinated call
   * is denied in-process) but NOT bindable. */
  bindable?: boolean;
}

export class ToolRegistry {
  private readonly entries = new Map<string, Entry>();

  register(def: ToolDefinition, exec: ToolExecutor, bindable = false): void {
    // §8.4 defense in depth — a name already held by a DIFFERENT origin must
    // never be silently overwritten: that is the shadow/spoof vector a hostile
    // MCP server (tool names are server-controlled) would use to displace an
    // approved tool or a built-in. Re-registration within the same origin (an
    // MCP refresh, a plugin reload) is legitimate and allowed.
    const existing = this.entries.get(def.name);
    if (existing && (existing.def.origin ?? "builtin") !== (def.origin ?? "builtin")) {
      throw new Error(
        `tool name collision: ${def.name} is already registered as origin ${existing.def.origin ?? "builtin"}, refusing to overwrite with origin ${def.origin ?? "builtin"}`,
      );
    }
    this.entries.set(def.name, { def, exec, bindable });
  }

  /** Remove a tool by name — a plugin's tool on disable (§12.4). */
  unregister(name: string): void {
    this.entries.delete(name);
  }

  get(name: string): ToolDefinition | null {
    return this.entries.get(name)?.def ?? null;
  }

  getExecutor(name: string): ToolExecutor | null {
    return this.entries.get(name)?.exec ?? null;
  }

  list(): ToolDefinition[] {
    return [...this.entries.values()].map((e) => e.def);
  }

  /** The read-only tool names, derived from `def.readOnly` (§8.1). INTERNAL
   * CLASSIFICATION only (isolation, worker binding, display) — NEVER a
   * permission input (§9): the allow list decides what prompts, not read-class. */
  readOnlyNames(): string[] {
    return this.list().filter((d) => d.readOnly).map((d) => d.name);
  }

  /**
   * The APPROVED, bindable MCP tools (§8.4) the engine and workers bind to the
   * model. Pending/quarantined guard stubs are excluded — they are present in
   * the registry only so an in-flight/hallucinated call is denied in-process
   * and never reaches the server. This is the single source for MCP binding;
   * the engine never consults the McpClient directly.
   */
  mcpModelEntries(): { def: ToolDefinition; exec: ToolExecutor }[] {
    return [...this.entries.values()]
      .filter((e) => e.def.origin === "mcp" && e.bindable)
      .map((e) => ({ def: e.def, exec: e.exec }));
  }

  /**
   * The plugin-contributed tools (origin `plugin`) the engine binds to the model
   * (§8.1, §12.4). A plugin is trusted in-process code, so unlike MCP there is no
   * bindable/quarantine lifecycle: every registered plugin tool binds. The
   * engine filters the bound set by the active agent's `tools` list exactly as it
   * does for built-ins, and each call still passes the one decision point (a
   * plugin tool ASKS until allow-listed, §9). This is the single source for
   * plugin tool binding; the engine never reaches into the loader.
   */
  pluginModelEntries(): { def: ToolDefinition; exec: ToolExecutor }[] {
    return [...this.entries.values()]
      .filter((e) => e.def.origin === "plugin")
      .map((e) => ({ def: e.def, exec: e.exec }));
  }
}
