/**
 * The Manuals capability (core-blueprint.md §12.8) — the use-case layer.
 *
 * Orchestrates the programmatic registration seam (registerDir for directories,
 * registerBuiltin for individual docs), the registry, and the CoreAPI namespace.
 * Programmatic registration emits nothing (like builtin skills).
 * A doc is data, not authority: it stores/returns text only.
 * Registration is append-only: duplicate ids are rejected, no shadowing.
 */
import type { EventBus } from "../entities/event-bus.js";
import { ManualRegistry, type ManualIndexLine } from "../entities/manuals/manual-registry.js";
import type { Manual } from "../entities/manuals/manual.js";
import { parseManual, ManualValidationError } from "../entities/manuals/manual.js";
import { coreError, err, ok, ErrorCode, type Result, type CoreError } from "../entities/errors.js";
import { readManualTool } from "./read-manual-tool.js";
import type { ToolRegistry } from "../entities/tool-registry.js";
import { readDocsDir } from "../adapters/docs-dir-reader.js";
import type { LimitsPort } from "../entities/ports/limits-port.js";

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
  /** Reader function for docs directories. Defaults to readDocsDir. */
  readDocsDir?: typeof readDocsDir;
  /** Limits port for enforcing caps on doc file reading (§13.11). */
  limits?: LimitsPort;
}

export class Manuals {
  private readonly registry = new ManualRegistry();
  /** Builtin manuals registered programmatically (§12.8). */
  private readonly builtins = new Map<string, Manual>();
  /** Plugin-contributed docs, keyed by plugin id for teardown (§12.8). */
  private readonly pluginDocs = new Map<string, Set<string>>();

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

  /**
   * Register all *.md files from a directory recursively (§12.8).
   * @param dir the root directory to scan
   * @param source lowercase-hyphen slug identifying the source (e.g., "core", "plugin-foo")
   * @returns CoreError if source slug is invalid or a duplicate id is found, void on success
   */
  async registerDir(dir: string, source: string): Promise<CoreError | void> {
    // Validate source is a lowercase-hyphen slug
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(source)) {
      return coreError(ErrorCode.INVALID_INPUT, `source must be a lowercase-hyphen slug, got: ${source}`, {
        field: "source",
      });
    }

    // Get the reader function (default to the real implementation)
    const reader = this.deps.readDocsDir ?? readDocsDir;

    // Track ids registered in this batch for duplicate detection
    const batchIds = new Set<string>();
    let skipReported = false;

    try {
      const docs = await reader(dir, this.deps.limits, (reason) => {
        if (!skipReported) {
          this.deps.bus.emit(
            "ERROR_OCCURRED",
            {
              source: "manuals",
              message: `Skipped docs during directory read: ${reason}`,
            },
            {},
          );
          skipReported = true;
        }
      });

      for (const doc of docs) {
        const id = `${source}/${doc.slug}`;

        // Check for duplicate within this batch
        if (batchIds.has(id)) {
          this.deps.bus.emit(
            "ERROR_OCCURRED",
            {
              source: "manuals",
              message: `Duplicate manual id "${id}" in batch from ${source}`,
            },
            {},
          );
          continue;
        }

        // Check for duplicate already registered
        if (this.registry.get(id)) {
          this.deps.bus.emit(
            "ERROR_OCCURRED",
            {
              source: "manuals",
              message: `Manual id "${id}" already registered`,
            },
            {},
          );
          continue;
        }

        try {
          const manual = parseManual(doc.raw, id, "builtin");
          batchIds.add(id);
          this.builtins.set(id, manual);
          this.registry.register(manual);
          
          // Record plugin-contributed docs for teardown on unload
          if (source !== "builtin") {
            if (!this.pluginDocs.has(source)) {
              this.pluginDocs.set(source, new Set());
            }
            this.pluginDocs.get(source)!.add(id);
          }
        } catch (e) {
          const reason = e instanceof ManualValidationError ? e.message : String(e);
          this.deps.bus.emit(
            "ERROR_OCCURRED",
            {
              source: "manuals",
              message: `Failed to register manual ${id}: ${reason}`,
            },
            {},
          );
        }
      }
      return undefined; // success
    } catch (e) {
      this.deps.bus.emit(
        "ERROR_OCCURRED",
        {
          source: "manuals",
          message: `Failed to scan directory ${dir}: ${String(e)}`,
        },
        {},
      );
      return coreError(ErrorCode.INVALID_INPUT, String(e), { field: "dir" });
    }
  }

  /**
   * Unregister all docs contributed by a plugin (§12.4 teardown).
   * Called when a plugin is disabled or unloaded.
   */
  unregisterPluginDocs(pluginId: string): void {
    const ids = this.pluginDocs.get(pluginId);
    if (!ids) return;

    for (const id of ids) {
      this.registry.remove(id);
      this.builtins.delete(id);
    }
    this.pluginDocs.delete(pluginId);
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
