/**
 * The session-naming port (core-blueprint.md §5.5).
 *
 * After a completed turn the facade asks this port to propose a short session
 * name from the current name and the latest turn activity. It is a bounded,
 * passive, off-turn call: it never blocks the turn or its result, is awaited by
 * a headless exit only within a short cap, and is aborted on shutdown. The
 * production default (`boot.ts`) wraps the §5.5 primitive `suggestSessionName`
 * over a FRESH client (`ModelPort.transientChatModel`) so it never shares or
 * races the interactive turn's cached client.
 *
 * `suggest` returns the proposed name, or `null` on any failure/timeout/empty
 * answer or when naming is disabled (the caller then keeps the previous name).
 * It NEVER throws. A host/test that injects a custom `chatModelFactory` gets a
 * NO-OP default (always `null`, the first-line fallback) unless it also injects
 * a `namingPort` explicitly — so finite scripted `fakeModel` fixtures are never
 * perturbed by an extra passive model call.
 */
import { limitDefault } from "../limits.js";

export interface NamingContext {
  /** The current session name (the first-line fallback already applied). */
  current: string;
  /** A short, already-masked summary of the latest turn's activity. */
  turnSummary: string;
}

export interface NamingPort {
  suggest(ctx: NamingContext): Promise<string | null>;
}

/** The NO-OP naming port: always returns `null` so the caller keeps the
 * first-line fallback. The default when a host injected a custom
 * `chatModelFactory` but no explicit `namingPort` (§5.5). */
export const noopNamingPort: NamingPort = {
  async suggest(): Promise<string | null> {
    return null;
  },
};

/** The default cap on a session name's length (§5.5, §13.11): the
 * `session.nameMaxChars` registry limit. A facade read uses the effective value
 * (`config.effectiveLimit("session.nameMaxChars")`); this default serves the
 * standalone sanitizer path and keeps behaviour byte-identical at defaults. */
export function sessionNameMaxChars(): number {
  return limitDefault("session.nameMaxChars");
}
