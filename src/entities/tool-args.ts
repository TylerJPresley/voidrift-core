/**
 * The central, schema-driven tool-argument pre-processing the ONE decision
 * point applies before Zod validation (core-blueprint.md §8.1, §9.1 step 1).
 *
 * Two PURE pieces, no I/O and no events:
 *   1. {@link coerceStringArrays} — "liberal in what it accepts": for every
 *      top-level schema field that declares an ARRAY OF STRINGS, a value the
 *      model sent as a single STRING is split on commas (each part trimmed,
 *      empty parts dropped) into the array the schema expects. Driven from the
 *      tool's OWN schema (string arrays only); there is no per-tool code and the
 *      schema the model is bound to is NEVER mutated — a shallow copy is
 *      returned. A non-string / non-array value (a number, an object, an
 *      already-correct array) is left untouched.
 *   2. {@link validateToolArgs} — Zod-validate the (coerced) args against the
 *      tool's schema and, on failure, format the ONE `invalid arguments for
 *      <tool>: <field>: <issue>` message — the offending field name and the
 *      issue only, from the Zod issues (never a stack slice), capped at ~500
 *      characters, with no stack trace and no file paths. The raw validation
 *      exception never reaches the model.
 *
 * This replaces the pre-existing failure where an argument-validation throw
 * (`DynamicStructuredTool.call` → `ToolInputParsingException`) escaped the
 * handler and LangChain's `ToolNode` turned it into a `ToolMessage` carrying the
 * raw stack with a `TOOL_STARTED` but no `TOOL_FINISHED`.
 */
import type { ZodType } from "zod";

/** The ~500-character cap on the formatted invalid-arguments message (§8.1). */
export const INVALID_ARGS_MAX_CHARS = 500;

interface ZodNode {
  def?: { type?: string; element?: unknown; shape?: Record<string, unknown> };
  shape?: Record<string, unknown>;
  unwrap?: () => ZodNode;
  element?: ZodNode;
}

/** Peel `optional`/`default`/`nullable`/`readonly` wrappers to the core node. */
function unwrap(node: ZodNode): ZodNode {
  let cur = node;
  for (let i = 0; i < 6; i++) {
    const t = cur?.def?.type;
    if ((t === "optional" || t === "default" || t === "nullable" || t === "readonly") && typeof cur.unwrap === "function") {
      cur = cur.unwrap();
    } else break;
  }
  return cur;
}

/** True when the schema node is an ARRAY whose element is a STRING. */
function isStringArray(node: ZodNode): boolean {
  const core = unwrap(node);
  if (core?.def?.type !== "array") return false;
  const el = (core.def?.element ?? core.element) as ZodNode | undefined;
  return el?.def?.type === "string";
}

/** The top-level object shape of a schema, or null when it is not an object. */
function objectShape(schema: ZodType): Record<string, ZodNode> | null {
  const node = schema as unknown as ZodNode;
  const shape = node.def?.shape ?? node.shape;
  return shape ? (shape as Record<string, ZodNode>) : null;
}

/** Split a single comma string into the trimmed, non-empty parts (§8.1). */
function splitCommaList(value: string): string[] {
  return value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Coerce single-string values into string arrays for every top-level string-array
 * field of `schema` (§8.1). Returns a SHALLOW COPY; the input args and the schema
 * are never mutated. A field absent from the args, or whose value is not a plain
 * string, is left exactly as given (an existing array, number, object — untouched).
 */
export function coerceStringArrays(args: Record<string, unknown>, schema: ZodType): Record<string, unknown> {
  const shape = objectShape(schema);
  if (!shape) return { ...args };
  const out: Record<string, unknown> = { ...args };
  for (const [field, fieldSchema] of Object.entries(shape)) {
    if (!(field in out)) continue;
    const value = out[field];
    if (typeof value !== "string") continue; // only a plain string is split
    if (!isStringArray(fieldSchema)) continue; // only string-array fields
    out[field] = splitCommaList(value);
  }
  return out;
}

/**
 * Validate `args` against the tool's `schema`. On success returns `{ ok: true }`;
 * on failure returns `{ ok: false, message }` where `message` is the §8.1
 * `invalid arguments for <tool>: <field>: <issue>` text — field name + issue
 * only (from the first Zod issue), no stack, no path, capped at
 * {@link INVALID_ARGS_MAX_CHARS}. PURE.
 */
export function validateToolArgs(
  tool: string,
  args: Record<string, unknown>,
  schema: ZodType,
): { ok: true } | { ok: false; message: string } {
  // A schema that is not a real Zod schema (no `safeParse`) cannot be validated
  // here — pass it through (the executor still validates with whatever it has).
  // Every built-in and the MCP/plugin adapters produce real Zod schemas; this
  // guard only tolerates a test shim or an exotic adapter schema.
  if (typeof (schema as { safeParse?: unknown }).safeParse !== "function") return { ok: true };
  const parsed = schema.safeParse(args);
  if (parsed.success) return { ok: true };
  const issue = parsed.error.issues[0];
  const field = issue && issue.path.length > 0 ? issue.path.map(String).join(".") : "(arguments)";
  const reason = issue ? issue.message : "invalid arguments";
  const full = `invalid arguments for ${tool}: ${field}: ${reason}`;
  return { ok: false, message: full.slice(0, INVALID_ARGS_MAX_CHARS) };
}
