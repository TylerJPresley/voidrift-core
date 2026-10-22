/**
 * The scoped event bus (core-blueprint.md §14.5).
 *
 * Events flow outward only (§1 rule 8): a capability emits, subscribers
 * observe; a subscriber returns nothing and never feeds control back inward.
 * Every event is an `EventEnvelope { type, scope, at, payload }`. A scoped
 * subscription receives its own scope and every scope beneath it and never a
 * sibling session's events — the multi-session guarantee (§2.1, §14.5).
 */

/** Where in the session hierarchy an event originated (§14.5). */
export interface EventScope {
  workspace?: string;
  session?: string;
  worker?: string;
}

/** Every event delivered to a subscriber (§14.5). */
export interface EventEnvelope<T = unknown> {
  type: string;
  scope: EventScope;
  at: string;
  payload: T;
}

type Handler = (event: EventEnvelope) => void;

interface Subscription {
  type: string | "*";
  handler: Handler;
  scope?: EventScope;
  isPlugin: boolean;
}

/**
 * True when `child` lies within `parent` in the hierarchy
 * (workspace ⊇ session ⊇ worker). A subscription scope is a filter: the event
 * must match the subscription scope and may be narrower.
 */
function scopeContains(parent: EventScope | undefined, child: EventScope): boolean {
  if (!parent) return true; // unscoped subscription receives everything
  if (parent.workspace !== undefined && parent.workspace !== child.workspace) return false;
  if (parent.session !== undefined && parent.session !== child.session) return false;
  if (parent.worker !== undefined && parent.worker !== child.worker) return false;
  return true;
}

/**
 * In-process observer bus. One per core instance; it holds subscriptions and
 * the set of registered custom event names. The core never shares a bus across
 * processes — events are delivered only to in-process subscribers.
 */
export class EventBus {
  private readonly subs = new Set<Subscription>();
  private readonly registered = new Set<string>();

  /** Declare a plugin event type before it may be emitted (§14.5). */
  register(name: string): void {
    this.registered.add(name);
  }

  /** True when a name is a core event or a registered plugin event. */
  isRegistered(name: string): boolean {
    return this.registered.has(name);
  }

  /**
   * Subscribe to a type (or "*") with an optional scope filter. Returns an
   * unsubscribe function. Core subscribers are added before plugin subscribers
   * so delivery order honors §14.1; `isPlugin` tags the origin.
   */
  subscribe(
    type: string | "*",
    handler: Handler,
    opts?: { scope?: EventScope; isPlugin?: boolean },
  ): () => void {
    const sub: Subscription = {
      type,
      handler,
      ...(opts?.scope ? { scope: opts.scope } : {}),
      isPlugin: opts?.isPlugin ?? false,
    };
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
    };
  }

  /**
   * Emit an event. Delivery is fire-and-forget: a throwing subscriber is
   * isolated and never stops another. Core subscribers run before plugin
   * subscribers (§14.1).
   */
  emit(type: string, payload: unknown, scope: EventScope = {}): void {
    const envelope: EventEnvelope = {
      type,
      scope,
      at: new Date().toISOString(),
      payload,
    };
    const ordered = [...this.subs].sort(
      (a, b) => Number(a.isPlugin) - Number(b.isPlugin),
    );
    for (const sub of ordered) {
      if (sub.type !== "*" && sub.type !== type) continue;
      if (!scopeContains(sub.scope, scope)) continue;
      try {
        sub.handler(envelope);
      } catch {
        // A bad subscriber is isolated (§14.1). Nothing re-enters the loop.
      }
    }
  }
}
