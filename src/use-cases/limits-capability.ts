/**
 * The runtime `LimitsPort` implementation (core-blueprint.md §13.11, §14.6).
 *
 * Reads effective values from a resolved limits set (`resolveLimits`) and emits
 * `LIMIT_HIT {key, area, value, action, scope}` on the event bus at most once per key
 * per turn, returning the one-line notice and action. `resetTurn()` clears the per-turn
 * dedup (called by the engine at each turn boundary, like the chat/read lanes).
 *
 * This is the small, stable surface parallel implementers wire their area's call
 * sites onto: `limits.get(key)` for the value, `limits.hit(key, observed, ctx)`
 * when a limit actually truncates/blocks.
 */
import type { EventBus } from "../entities/event-bus.js";
import { getLimitSpec } from "../entities/limits.js";
import { effectiveLimit, type ResolvedLimits } from "../entities/limits-resolve.js";
import { limitNotice, type LimitHitContext, type LimitHitResult, type LimitsPort } from "../entities/ports/limits-port.js";

export class LimitsCapability implements LimitsPort {
  private readonly hitThisTurn = new Set<string>();

  constructor(
    private resolved: ResolvedLimits,
    private readonly bus: EventBus,
    /** The default scope (workspace/session) for emitted events. */
    private readonly baseScope: { workspace?: string; session?: string } = {},
  ) {}

  /** Replace the resolved set after a config change (§13.1 reresolve). */
  setResolved(resolved: ResolvedLimits): void {
    this.resolved = resolved;
  }

  /** Clear the per-turn LIMIT_HIT dedup (turn boundary). */
  resetTurn(): void {
    this.hitThisTurn.clear();
  }

  get(key: string): number {
    return effectiveLimit(this.resolved, key);
  }

  /** §13.11 — read the effective limit action (warn or deny) for a key.
   * Used at plugin load time to enforce the layered action on options size. */
  action(key: string): "warn" | "deny" {
    const entry = this.resolved.values.get(key);
    const spec = getLimitSpec(key);
    return entry?.action ?? (spec?.action ?? "warn");
  }

  /** §8.7 — the effective ingest fan-out cap: `limits.ingest.maxParallel` when a
   * layer set it, otherwise `turnMaxConcurrency` (the "unset = follow" default).
   * The ingest fan-out passes this to `Subagents.dispatch` so its cap is explicit
   * (the subagents batch already honours `turnMaxConcurrency`). Not part of the
   * stable `LimitsPort` — a boot-side convenience over the resolved set. */
  effectiveIngestParallel(turnMaxConcurrency: number): number {
    // §8.7 — unset ("default" source) follows turnMaxConcurrency; an explicit
    // layer value wins. Read the resolved entry for "ingest.maxParallel" live so
    // a config override reaches the ingest fan-out cap (not just the default).
    const entry = this.resolved.values.get("ingest.maxParallel");
    const value = entry && entry.source !== "default" ? entry.value : turnMaxConcurrency;
    return Math.max(1, Math.floor(value));
  }

  hit(key: string, observed?: number, ctx?: LimitHitContext): LimitHitResult {
    const spec = getLimitSpec(key);
    if (!spec) throw new Error(`unknown limit key: ${key}`);
    const value = this.get(key);
    const entry = this.resolved.values.get(key);
    const action = entry?.action ?? spec.action;
    // Always report the key exactly as it is REGISTERED (`spec.key`), never the
    // caller-supplied spelling, so the notice, the per-turn dedup and the
    // emitted LIMIT_HIT payload all carry the canonical case — a headless run's
    // stderr line names `context.defaultOutputReservation`, not a lower-cased variant.
    const canonicalKey = spec.key;
    const what = ctx?.what ?? `${spec.area} ${canonicalKey.slice(spec.area.length + 1)} limit reached`;
    const notice = limitNotice(what, canonicalKey, value);
    const first = !this.hitThisTurn.has(canonicalKey);
    if (first) {
      this.hitThisTurn.add(canonicalKey);
      const scope = {
        ...this.baseScope,
        ...(ctx?.session ? { session: ctx.session } : {}),
        ...(ctx?.worker ? { worker: ctx.worker } : {}),
      };
      this.bus.emit("LIMIT_HIT", { key: canonicalKey, area: spec.area, value, action, scope, observed, notice }, scope);
    }
    return { notice, action, first };
  }
}
