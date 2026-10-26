/**
 * The Manuals capability (core-blueprint.md §12.8) — the use-case layer.
 *
 * Orchestrates the builtin registration seam, the registry, and the CoreAPI
 * namespace. Programmatic registration emits nothing (like builtin skills).
 * A doc is data, not authority: it stores/returns text only.
 * Registration is append-only: duplicate ids are rejected, no shadowing.
 */
import type { EventBus } from "../entities/event-bus.js";
import { ManualRegistry, type ManualIndexLine } from "../entities/manuals/manual-registry.js";
import type { Manual } from "../entities/manuals/manual.js";
import { parseManual, ManualValidationError } from "../entities/manuals/manual.js";
import { coreError, err, ok, ErrorCode, type Result } from "../entities/errors.js";
import { readManualTool } from "./read-manual-tool.js";
import type { ToolRegistry } from "../entities/tool-registry.js";

/** A DTO view of a manual (§2, no entity crosses). */
export interface ManualDTO {
  id: string;
  summary: string;
  readWhen: string;
  type: Manual["frontmatter"]["type"];
  source: Manual["source"];
}

export interface ManualsDeps {
  bus: EventBus;
  /** Register the model-facing tools through the tool registry (§8.1). */
  toolRegistry?: ToolRegistry;
}

export class Manuals {
  private readonly registry = new ManualRegistry();
  /** Builtin manuals registered programmatically (§12.8). */
  private readonly builtins = new Map<string, Manual>();

  constructor(private readonly deps: ManualsDeps) {
    this.registerTools();
  }

  private registerTools(): void {
    if (!this.deps.toolRegistry) return;
    const { def, exec } = readManualTool(this);
    this.deps.toolRegistry.register(def, exec);
  }

  /** The model-facing tool (read_manual) for the engine to bind (§8.1, §12.8). */
  modelTools(): { def: { name: string; description: string; schema: unknown }; exec: (args: unknown, ctx: { workspaceRoot: string; sessionId: string }) => Promise<{ content: string; status: string }> }[] {
    const { def, exec } = readManualTool(this);
    return [{ def, exec }];
  }

  /**
   * Register a builtin manual programmatically (§12.8). Plugins use this seam too.
   * Duplicate ids are rejected (append-only, no shadowing).
   */
  registerBuiltin(raw: string, id: string): Result<ManualDTO> {
    try {
      const manual = parseManual(raw, id, "builtin");
      this.builtins.set(id, manual);
      this.registry.register(manual);
      return ok(this.toDTO(manual));
    } catch (e) {
      const reason =
        e instanceof ManualValidationError ? e.message : String(e);
      if (reason.includes("already registered")) {
        return err(
          coreError(ErrorCode.INVALID_INPUT, reason, {
            field: "id",
          }),
        );
      }
      return err(coreError(ErrorCode.INVALID_INPUT, reason, { field: "manual" }));
    }
  }

  // ── the index seam the engine reads (§4.6) ──────────────────────────────

  /**
   * The index manifest for TOC generation (id + summary + type only).
   */
  indexLines(): ManualIndexLine[] {
    return this.registry.indexLines();
  }

  // ── the manuals CoreAPI namespace (§2.2, §12.8) ──────────────────────────

  /** List all registered manuals. */
  list(): ManualDTO[] {
    return this.registry.list().map((m) => this.toDTO(m));
  }

  /** Get a manual by id, or null if not found. */
  get(id: string): ManualDTO | null {
    const manual = this.registry.get(id);
    return manual ? this.toDTO(manual) : null;
  }

  // ── internal access for the read_manual tool (§8.1) ────────────────────────

  /** Get the internal manual object (not DTO) for the tool layer. */
  getInternal(id: string): Manual | undefined {
    return this.registry.get(id);
  }

  private toDTO(manual: Manual): ManualDTO {
    return {
      id: manual.id,
      summary: manual.frontmatter.summary,
      readWhen: manual.frontmatter.readWhen,
      type: manual.frontmatter.type,
      source: manual.source,
    };
  }
}
