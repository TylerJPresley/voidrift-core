/**
 * Structured output (core-blueprint.md §3.8).
 *
 * When a request asks for a typed result, the engine uses `responseFormat` with
 * a `toolStrategy` (portable across any tool-calling model) or a
 * `providerStrategy` (the provider's native JSON-schema output where supported).
 * This module is the boundary-validation and strategy-SELECTION part; the engine
 * owns the `createAgent({ responseFormat })` wiring and the one corrective retry.
 *
 * A caller's `responseSchema` is EITHER a Zod schema or a plain JSON Schema
 * object. Both are validated and size-capped here before they reach the agent so
 * a huge or malformed schema never reaches the model or the library.
 */
import { toolStrategy, providerStrategy, type ResponseFormat } from "langchain";
import type { InteropZodType } from "@langchain/core/utils/types";
import { limitDefault } from "./limits.js";

/** The serialized-schema byte cap DEFAULT (§3.8). The effective cap is the
 * `tools.responseSchemaMaxBytes` registry limit, injected by the caller through
 * the `LimitsPort` (a `safety` class: a project may only LOWER it). This default
 * equals the registry default so a caller that cannot pass the port (a pure
 * unit) still enforces the shipped bound. */
export const MAX_RESPONSE_SCHEMA_BYTES = limitDefault("tools.responseSchemaMaxBytes");

/** The protocols whose clients support native JSON-schema output (§3.8 / §11). */
const PROVIDER_STRATEGY_PROTOCOLS: ReadonlySet<string> = new Set(["openai", "google"]);

/** A validated, bounded response schema ready to become a `responseFormat`. The
 * `schema` is kept OPAQUE (`object`) so this type carries no LangChain type
 * across the public surface (invariant 14); the build helpers cast internally. */
export interface ValidatedResponseSchema {
  /** A Zod schema, or a plain JSON Schema object — opaque to callers. */
  readonly schema: object;
  readonly isZod: boolean;
}

function looksLikeZod(v: unknown): v is InteropZodType {
  // Zod schemas carry a `parse`/`safeParse`; the JSON-Schema branch is a plain
  // object. Accept either without importing a runtime brand check.
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { safeParse?: unknown }).safeParse === "function"
  );
}

/**
 * Validate a caller-supplied `responseSchema` at the boundary (§3.8). Returns a
 * machine-readable reason string on failure (the caller maps it to an
 * `INVALID_INPUT` result); never throws. Enforces the size cap on the
 * JSON-Schema branch and on a Zod schema's JSON form when it can be derived.
 */
export function validateResponseSchema(
  raw: unknown,
  maxBytes: number = MAX_RESPONSE_SCHEMA_BYTES,
): { ok: true; value: ValidatedResponseSchema } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) {
    return { ok: false, reason: "responseSchema is empty" };
  }
  if (looksLikeZod(raw)) {
    return { ok: true, value: { schema: raw, isZod: true } };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "responseSchema must be a Zod schema or a JSON Schema object" };
  }
  // JSON Schema object: size-cap its serialized form.
  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    return { ok: false, reason: "responseSchema is not serializable" };
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    return { ok: false, reason: "responseSchema exceeds the size cap" };
  }
  return { ok: true, value: { schema: raw as Record<string, unknown>, isZod: false } };
}

/** True when the resolved endpoint's protocol supports a native provider
 * strategy (§3.8). A router/`auto` endpoint owns reasoning and output itself, so
 * the caller defaults to the portable tool strategy for it (see `selectStrategy`
 * which only opts in to provider strategy for a KNOWN-supporting protocol). */
export function protocolSupportsProviderStrategy(protocol: string): boolean {
  return PROVIDER_STRATEGY_PROTOCOLS.has(protocol);
}

/** Build the portable tool-strategy `responseFormat` (works on any tool-calling
 * model). Used as the default and as the fallback when a provider strategy
 * fails (§3.8). */
export function buildToolStrategy(v: ValidatedResponseSchema): ResponseFormat {
  // `toolStrategy` accepts a Zod schema or a JSON Schema object; both resolve to
  // a single-strategy `responseFormat`.
  return toolStrategy(v.schema as InteropZodType)[0] as ResponseFormat;
}

/** Build the native provider-strategy `responseFormat` (native JSON-schema
 * output where supported, §3.8). */
export function buildProviderStrategy(v: ValidatedResponseSchema): ResponseFormat {
  return providerStrategy(v.schema as InteropZodType) as unknown as ResponseFormat;
}

/**
 * Select the strategy for the resolved protocol (§3.8): `providerStrategy` only
 * for a protocol KNOWN to support native JSON-schema output, defaulting to
 * `toolStrategy` otherwise. The engine applies the one-retry FALLBACK to
 * `toolStrategy` when a provider-strategy turn produces no valid structured
 * value.
 */
export function selectStrategy(
  v: ValidatedResponseSchema,
  protocol: string,
): { kind: "provider" | "tool"; format: ResponseFormat } {
  if (protocolSupportsProviderStrategy(protocol)) {
    return { kind: "provider", format: buildProviderStrategy(v) };
  }
  return { kind: "tool", format: buildToolStrategy(v) };
}

/**
 * Validate a structured value against a validated schema (§3.8). Used by the
 * engine to decide whether a corrective retry is needed. For a Zod schema this
 * runs `safeParse`; for a JSON Schema object the library already enforced the
 * shape, so a present object is accepted. Returns the parsed value on success.
 */
export function validateStructuredValue(
  v: ValidatedResponseSchema,
  value: unknown,
): { ok: true; value: unknown } | { ok: false } {
  if (value === undefined || value === null) return { ok: false };
  if (v.isZod) {
    const res = (v.schema as { safeParse(x: unknown): { success: boolean; data?: unknown } }).safeParse(value);
    return res.success ? { ok: true, value: res.data } : { ok: false };
  }
  return { ok: true, value };
}
