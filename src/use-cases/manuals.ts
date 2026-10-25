/**
 * The Manuals capability (core-blueprint.md §12.8) — the use-case layer.
 *
 * Orchestrates the builtin registration seam, the registry, and the CoreAPI
 * namespace. Programmatic registration emits nothing (like builtin skills).
 * A doc is data, not authority: it stores/returns text only.
 * Re-indexing from disk replaces only the user/ and project/ namespaces,
 * leaving builtins and plugins untouched (append-only, no shadowing).
 *
 * The filesystem watcher (§14.2) monitors the configured docs directories
 * (project .voidrift/docs and global ~/.config/voidrift/docs) and triggers
 * reindex on changes, emitting RESOURCE_CHANGED {type:"manual"} for hot-reload.
 */
import { type FSWatcher } from "chokidar";
import chokidar from "chokidar";
import type { EventBus } from "../entities/event-bus.js";
import { ManualRegistry, type ManualIndexLine } from "../entities/manuals/manual-registry.js";
import type { Manual } from "../entities/manuals/manual.js";
import { parseManual, ManualValidationError } from "../entities/manuals/manual.js";
import { coreError, err, ok, ErrorCode, type Result } from "../entities/errors.js";
import { readManualTool } from "./read-manual-tool.js";
import type { ToolRegistry } from "../entities/tool-registry.js";
import type { ManualsDirectory } from "../adapters/manuals-directory.js";

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
  /** The directory adapter to load filesystem-sourced docs (§12.8). */
  directory?: ManualsDirectory;
}

export class Manuals {
  private readonly registry = new ManualRegistry();
  /** Builtin manuals registered programmatically (§12.8). */
  private readonly builtins = new Map<string, Manual>();
  /** Filesystem-sourced docs loaded from disk (user/ and project/ namespace). */
  private readonly filesystem = new Map<string, Manual>();
  /** Filesystem watcher for hot-reload (§14.2). */
  private watcher: FSWatcher | null = null;

  constructor(private readonly deps: ManualsDeps) {
    this.registerTools();
  }

  private registerTools(): void {
    if (!this.deps.toolRegistry) return;
    const { def, exec } = readManualTool(this);
    this.deps.toolRegistry.register(def, exec);
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
   * Re-index from both filesystem sources (§12.8). Replaces only the
   * user/ and project/ namespaces, leaving builtins and plugins untouched
   * (append-only, no shadowing, no duplicates). Emits RESOURCE_CHANGED.
   */
  async reindex(): Promise<void> {
    if (!this.deps.directory) return;

    // Clear only filesystem-sourced docs (user/ and project/ namespaces).
    // Builtins and plugin docs remain untouched.
    const oldIds = [...this.filesystem.keys()];
    this.filesystem.clear();
    for (const id of oldIds) {
      this.registry.remove(id);
    }

    // Load from both sources and re-register.
    const project = await this.deps.directory.load("project").catch(() => ({ manuals: [], skipped: [] as { name: string; reason: string }[] }));
    const global = await this.deps.directory.load("global").catch(() => ({ manuals: [], skipped: [] as { name: string; reason: string }[] }));

    for (const manual of project.manuals) {
      this.filesystem.set(manual.id, manual);
      this.registry.register(manual);
    }
    for (const manual of global.manuals) {
      this.filesystem.set(manual.id, manual);
      this.registry.register(manual);
    }

    // Emit RESOURCE_CHANGED for hot reload (§14.2, §14.6).
    this.deps.bus.emit("RESOURCE_CHANGED", { type: "manual" }, {});
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

  // ── filesystem watcher (§14.2, §14.6) ────────────────────────────────────

  /**
   * Start watching the docs directories for changes and trigger reindex on
   * add/change/unlink. The watcher emits RESOURCE_CHANGED {type:"manual"}
   * via reindex (§14.2, §14.6). No-op if no directory adapter.
   */
  async startWatch(projectPath: string, globalPath: string): Promise<void> {
    if (this.watcher || !this.deps.directory) return;

    const { existsSync } = await import("node:fs");

    const paths: string[] = [];
    if (existsSync(projectPath)) paths.push(projectPath);
    if (existsSync(globalPath)) paths.push(globalPath);

    // If neither path exists, chokidar can still watch them (they may appear later),
    // but guard against empty watch list.
    if (paths.length === 0) {
      paths.push(projectPath, globalPath);
    }

    // Poll at 50ms interval, matching vcs.ts pattern (§14.2).
    const w = chokidar.watch(paths, { ignoreInitial: true, usePolling: true, interval: 50 });
    this.watcher = w;

    const onChange = (): void => {
      void this.reindex().catch(() => {
        // Reindex errors are emitted by the caller; here we silently continue
        // so a watcher error does not crash the session.
      });
    };

    w.on("add", onChange).on("change", onChange).on("unlink", onChange);

    // Await ready so changes after startWatch are caught.
    await new Promise<void>((resolve) => {
      w.once("ready", () => resolve());
    });
  }

  /**
   * Stop the filesystem watcher and clean up the handle.
   * Matching vcs.ts stopBranchWatch() pattern (§14.2).
   */
  async stopWatch(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
