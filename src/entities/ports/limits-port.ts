/**
 * The limits runtime port (core-blueprint.md §13.11, §14.6 LIMIT_HIT).
 *
 * A small, stable surface injected into use-cases so entities stay pure. It
 * answers the effective value of a registry limit and records when a limit
 * actually truncates or blocks, emitting `LIMIT_HIT` at most once per key per
 * turn and returning the one-line model-visible notice.
 *
 * Keep this surface SMALL and STABLE: parallel implementers wire their area's
 * call sites to `get`/`hit` on top of it. Do not grow it per-area.
 */

/** Context for a `hit` (all optional; used for scope + display). */
export interface LimitHitContext {
  /** The session the hit occurred in (event scope). */
  session?: string;
  /** The worker the hit occurred in, when inside a fan-out (event scope). */
  worker?: string;
  /** A short human phrase for the notice, e.g. "command output truncated". When
   * absent the port derives one from the limit's area/name. */
  what?: string;
}

/** The result of a `hit`: the one-line notice, the action taken, and whether
 * this was the FIRST hit of this key this turn. */
export interface LimitHitResult {
  /** The one-line notice: `<what> (limits.<key> = <value>). Raise it in config:
   * limits.<key>`. Returned for the model-visible marker and the CLI line. */
  notice: string;
  /** The action taken: "warn" (run continued) or "deny" (request refused). */
  action: "warn" | "deny";
  /** True when this is the first hit of `key` in the current turn. */
  first: boolean;
}

export interface LimitsPort {
  /** The effective value of a limit key after the layered cascade + safety
   * rule. Throws on an unknown key (a programming error, never a config path). */
  get(key: string): number;
  /** Record that `key` just truncated/blocked. Emits `LIMIT_HIT {key, area,
   * value, action, scope}` at most once per key per turn and returns the notice and action.
   * Safe to call on every truncation; only the first per key per turn emits/returns
   * `first: true`. `observed` is the size the caller saw (for the event). */
  hit(key: string, observed?: number, ctx?: LimitHitContext): LimitHitResult;
  /** Clear the per-turn `LIMIT_HIT` dedup. The engine calls this at each turn
   * boundary so a key may emit once per turn (§13.11). */
  resetTurn(): void;
  /** The effective ACTION of a limit key after the layered cascade + safety
   * rule: `warn` (truncate/store and continue) or `deny` (refuse at the bound).
   * Read WITHOUT emitting a `LIMIT_HIT`, so a site can decide before anything is
   * delivered or recorded. Unknown keys fall back to the registry default. */
  action(key: string): "warn" | "deny";
}

/** Build the one-line LIMIT_HIT notice in the blueprint's wording (§13.11). */
export function limitNotice(what: string, key: string, value: number): string {
  return `${what} (limits.${key} = ${value}). Raise it in config: limits.${key}`;
}

/**
 * The short, model-visible marker a truncation site appends to the truncated
 * text so the model knows a limit cut it and which key to raise (§13.11,
 * §14.6). Kept terse (a single bracketed phrase) because it rides inline in a
 * tool result: `[truncated: limits.<key>]`, optionally naming the observed size.
 * Used by every truncation site alongside `LimitsPort.hit`.
 */
export function limitMarker(key: string, observed?: number): string {
  return observed === undefined
    ? `[truncated: limits.${key}]`
    : `[truncated at limits.${key} (${observed})]`;
}
