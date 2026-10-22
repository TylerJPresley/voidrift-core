/**
 * Structured errors crossing the CoreAPI boundary (core-blueprint.md §2.6).
 *
 * No operation throws across the facade for a recoverable condition: it returns
 * a `Result<T>` whose error is a `CoreError` with a stable machine code.
 */

/** A stable, machine-readable error returned across the CoreAPI (§2.6). */
export interface CoreError {
  code: string;
  message: string;
  field?: string;
  details?: unknown;
}

/** The discriminated result every validated operation returns (§2.6). */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: CoreError };

/** Construct a successful result. */
export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

/** Construct a failed result from a `CoreError`. */
export function err(error: CoreError): { ok: false; error: CoreError } {
  return { ok: false, error };
}

/** The stable error codes slice 1 emits. */
export const ErrorCode = {
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
  INVALID_INPUT: "INVALID_INPUT",
  PATH_ESCAPE: "PATH_ESCAPE",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  TURN_ACTIVE: "TURN_ACTIVE",
  EMPTY_MESSAGE: "EMPTY_MESSAGE",
  MODEL_NOT_CONFIGURED: "MODEL_NOT_CONFIGURED",
  ENDPOINT_WINDOW_UNKNOWN: "ENDPOINT_WINDOW_UNKNOWN",
  NO_PENDING_APPROVAL: "NO_PENDING_APPROVAL",
  CONFIG_INVALID: "CONFIG_INVALID",
  UNKNOWN_TOOL: "UNKNOWN_TOOL",
  NOT_FOUND: "NOT_FOUND",
  MEMORY_BOUND_EXCEEDED: "MEMORY_BOUND_EXCEEDED",
  MEMORY_WRITE_UNVERIFIED: "MEMORY_WRITE_UNVERIFIED",
  /** `save_memory` was called naming `identity` or `project` — the two
   * user-/project-owned types the in-turn write tool can NEVER write (§6.2,
   * §6.4). Hard-refused regardless of any allow rule, `unlisted: allow` agent,
   * session approval or fan-out grant; nothing is persisted and the message
   * names the two writable types (`user-model`, `note`). */
  MEMORY_TYPE_FORBIDDEN: "MEMORY_TYPE_FORBIDDEN",
  /** The host asked to start in `auto_approve` but the managed layer forbids it
   * with `autoApproveAllowed: false` (§13.5). `createCore` fails before any
   * capability is wired. */
  AUTO_APPROVE_FORBIDDEN: "AUTO_APPROVE_FORBIDDEN",
  /** `session.setMode` was called while the session was not idle — a turn is
   * running or an approval is pending (§2.7). The mode is unchanged. */
  MODE_CHANGE_REFUSED: "MODE_CHANGE_REFUSED",
  /** `session.setMode` named an agent whose definition has `confirm: true` but
   * the caller did not pass `{ confirmed: true }` (§2.7). The TUI/host asks the
   * user and re-calls with the confirmation. The active agent is unchanged. */
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
  /** A host-only rollback operation (`session.undo/redo/goto`) was called while
   * the session was not idle — a turn is running (§10.12). Nothing is restored. */
  SESSION_BUSY: "SESSION_BUSY",
  /** A request asked for a typed result (`responseSchema`) but the model's
   * output could not be made to satisfy the schema, even after one corrective
   * retry (§3.8). Returned as a typed result; never thrown across the boundary. */
  STRUCTURED_OUTPUT_INVALID: "STRUCTURED_OUTPUT_INVALID",
  /** A request carried image attachments but the active model entry does not
   * declare `vision: true` (§3.3). The model is never called; the message names
   * the entry and the fix (set `vision: true` or choose a vision model). */
  IMAGE_NOT_SUPPORTED: "IMAGE_NOT_SUPPORTED",
  /** `session.export` was given an `out` destination that already exists
   * (§10.13). Nothing is written — export never overwrites. */
  EXPORT_TARGET_EXISTS: "EXPORT_TARGET_EXISTS",
  /** `session.export` `out` resolved to a protected control path (§9.4/§10.13):
   * a `.voidrift/config.json`, the journal, the plugin store, an agent/skill
   * definition, etc. Refused with no write. */
  EXPORT_TARGET_PROTECTED: "EXPORT_TARGET_PROTECTED",
  /** `session.export` could not write the `out` file (§10.13): a symlinked
   * target, an unwritable directory, or an I/O failure. An out-of-workspace
   * absolute path in the message is replaced by `<path>`; no secret is carried. */
  EXPORT_WRITE_FAILED: "EXPORT_WRITE_FAILED",
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCodeKey = keyof typeof ErrorCode;

/** Build a `CoreError` with a known code. */
export function coreError(
  code: string,
  message: string,
  extra?: { field?: string; details?: unknown },
): CoreError {
  return {
    code,
    message,
    ...(extra?.field !== undefined ? { field: extra.field } : {}),
    ...(extra?.details !== undefined ? { details: extra.details } : {}),
  };
}

/** A `CoreError` for an operation that is a seam in this slice, not yet built. */
export function notImplemented(op: string): CoreError {
  return coreError(
    ErrorCode.NOT_IMPLEMENTED,
    `${op} is not implemented in this build`,
  );
}

/** A thrown error carrying a `CoreError`, used internally before the facade maps it to a Result. */
export class CoreErrorException extends Error {
  readonly error: CoreError;
  constructor(error: CoreError) {
    super(error.message);
    this.name = "CoreErrorException";
    this.error = error;
  }
}
