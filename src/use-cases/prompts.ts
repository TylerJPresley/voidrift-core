/**
 * The Prompts capability (core-blueprint.md §12.2) — the use-case layer.
 *
 * Wires the four-level prompt cascade (entity) to the override-file directory
 * (adapter) and the watcher invalidation. `override` scaffolds a file seeded
 * with the resolved content; `resetOverride` removes both override levels. The
 * plugin seams `register`/`overridePrompt`/`extendPrompt` route through the
 * registry entity. A file change invalidates the per-key cache and emits
 * `RESOURCE_CHANGED` (§14.2) — the capability does not emit on an API mutation,
 * the watcher does.
 */
import { PromptRegistry, BUILTIN_PROMPTS } from "../entities/prompts/prompt-registry.js";
import type { PromptResolution } from "../entities/prompts/prompt-registry.js";
import type { PromptsDirectory } from "../adapters/prompts-directory.js";
import type { EventBus } from "../entities/event-bus.js";
import { ok, type Result } from "../entities/errors.js";

export interface PromptDTO {
  key: string;
  content: string;
  level: PromptResolution["level"];
}

export interface PromptsDeps {
  bus: EventBus;
  directory: PromptsDirectory;
}

export class Prompts {
  private readonly registry: PromptRegistry;
  /** Cached per-key on-disk overrides, re-read on invalidation to stay sync (§12.2). */
  private readonly overrideCache = new Map<string, { workspace?: string; global?: string }>();

  constructor(private readonly deps: PromptsDeps) {
    this.registry = new PromptRegistry((key) => this.overrideCache.get(key) ?? {});
  }

  /** Warm the override cache for every known key at boot (§12.2). */
  async init(): Promise<void> {
    for (const key of this.registry.keys()) {
      this.overrideCache.set(key, await this.deps.directory.readOverrides(key));
    }
    this.registry.invalidate();
  }

  list(): PromptDTO[] {
    return this.registry.keys().map((key) => this.toDTO(this.registry.resolve(key)));
  }

  get(key: string): PromptDTO {
    return this.toDTO(this.registry.resolve(key));
  }

  /** Scaffold an override seeded with the resolved content (§12.2 override). */
  async override(key: string, scope: "workspace" | "global"): Promise<Result<PromptDTO>> {
    const resolved = this.registry.resolve(key);
    await this.deps.directory.write(key, scope, resolved.content);
    await this.refresh(key);
    return ok(this.get(key));
  }

  /** Remove both override files and return the restored resolution (§12.2). */
  async resetOverride(key: string): Promise<Result<PromptDTO>> {
    await this.deps.directory.remove(key);
    await this.refresh(key);
    return ok(this.get(key));
  }

  // ── plugin seams (§2.2, §12.4) ────────────────────────────────────────────

  register(key: string, content: string): void {
    this.registry.register(key, content);
  }

  overridePrompt(key: string, content: string): void {
    this.registry.override(key, content);
  }

  extendPrompt(key: string, content: string): void {
    this.registry.extend(key, content);
  }

  /** Remove a plugin's prompt registrations (on disable, §12.4). */
  removePlugin(key: string): void {
    this.registry.removePlugin(key);
  }

  // ── watcher invalidation (§14.2) ──────────────────────────────────────────

  /** A watched override-file change: re-read the key and invalidate the cache. */
  async onWatchedChange(key: string): Promise<void> {
    await this.refresh(key);
    this.deps.bus.emit("RESOURCE_CHANGED", { type: "prompt" }, {});
  }

  /** Re-read a key's overrides and invalidate its cached resolution (§12.2). */
  private async refresh(key: string): Promise<void> {
    this.overrideCache.set(key, await this.deps.directory.readOverrides(key));
    this.registry.invalidate(key);
  }

  private toDTO(r: PromptResolution): PromptDTO {
    return { key: r.key, content: r.content, level: r.level };
  }
}

export { BUILTIN_PROMPTS };
