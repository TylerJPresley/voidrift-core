/**
 * The dataset declaration standard (core-blueprint.md §12.7).
 *
 * A dataset is the ONE read-only data seam behind every panel. It is registered
 * through `register.dataset(name, decl)` and is pure, JSON-serializable data
 * plus ONE pure reader: `rows()` takes ZERO arguments, performs no mutation, and
 * returns an array of plain JSON-serializable objects. Only a registered dataset
 * can be a panel `source`, so a panel can never read through a mutating
 * operation (§12.7).
 *
 * Zod is the single source of truth for the shape (AGENTS.md). The schema below
 * validates the DATA members (`description`, `fields`); `rows` is a function and
 * is validated structurally here (a function taking zero formal args).
 */
import { z } from "zod";
import { PANEL_FORMATS, type PanelFormat } from "./panel-schema.js";

/** A default-column descriptor on a dataset (§12.7). */
export interface DatasetField {
  /** Property name on a row; may be a dotted path into the row. */
  key: string;
  /** Default column header. */
  label: string;
  /** Default cell rendering (§12.6); default "text". */
  format?: PanelFormat;
}

/** One dataset row — a plain JSON-serializable object (§12.7). */
export type Row = Record<string, unknown>;

/**
 * A named, read-only dataset (§12.7). `rows` is a ZERO-argument reader (sync or
 * async) returning plain JSON-serializable objects; it lives ONLY here, never in
 * a `PanelDeclaration` (which is pure data).
 */
export interface DatasetDeclaration {
  /** One line describing the dataset. */
  description: string;
  /** Optional default columns; a panel's `columns` may default from them. */
  fields?: DatasetField[];
  /** Zero-argument, read-only reader; plain JSON-serializable rows. */
  rows: () => Row[] | Promise<Row[]>;
}

/** Bounds that keep a dataset declaration small (§12.7). */
const DESCRIPTION_MAX = 200;
const LABEL_MAX = 120;
const KEY_MAX = 120;
const FIELDS_MAX = 64;

/** A non-empty, single-line, length-bounded description (§12.7). */
const descriptionSchema = z
  .string()
  .min(1)
  .max(DESCRIPTION_MAX)
  .refine((s) => !/[\r\n]/.test(s), { message: "description must be a single line" });

const datasetFieldSchema = z
  .object({
    key: z.string().min(1).max(KEY_MAX),
    label: z.string().min(1).max(LABEL_MAX),
    format: z.enum(PANEL_FORMATS).optional(),
  })
  .strict();

/**
 * The one Zod schema for the DATA members of a `DatasetDeclaration` (§12.7):
 * - `description` non-empty, single-line, length-bounded;
 * - `fields` optional; when present a bounded array with unique `key`s, each
 *   `label` non-empty and each `format` a fixed `PanelFormat` member;
 * - `.strict()` so an unknown member is rejected.
 * `rows` is validated separately (a function; it cannot be a Zod data member).
 */
export const datasetDataSchema = z
  .object({
    description: descriptionSchema,
    fields: z
      .array(datasetFieldSchema)
      .max(FIELDS_MAX)
      .optional()
      .superRefine((fields, ctx) => {
        if (!fields) return;
        const seen = new Set<string>();
        for (const f of fields) {
          if (seen.has(f.key)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate field key "${f.key}"`, path: ["fields"] });
          }
          seen.add(f.key);
        }
      }),
  })
  .strict();

/** The field a dataset validation failure points at, for a typed error. */
export interface DatasetValidationFailure {
  field: string;
  message: string;
}

/**
 * Validate a candidate dataset declaration against the standard (§12.7). The
 * DATA members are checked by `datasetDataSchema`; `rows` is checked here: it
 * must be a function taking ZERO formal arguments (`rows.length === 0`) — a
 * reader that declares a parameter is rejected (it would imply an input the
 * read-only seam does not accept). Returns the typed declaration on success, or
 * a `DatasetValidationFailure` naming the offending field.
 */
export function validateDatasetDeclaration(
  candidate: unknown,
): { ok: true; value: DatasetDeclaration } | { ok: false; error: DatasetValidationFailure } {
  if (candidate === null || typeof candidate !== "object") {
    return { ok: false, error: { field: "dataset", message: "declaration must be an object" } };
  }
  const rows = (candidate as { rows?: unknown }).rows;
  if (typeof rows !== "function") {
    return { ok: false, error: { field: "rows", message: "rows must be a zero-argument function" } };
  }
  if (rows.length > 0) {
    return { ok: false, error: { field: "rows", message: "rows must take zero arguments" } };
  }
  // Validate the DATA members only (`rows` is a function, not a data member).
  const { rows: _rows, ...data } = candidate as Record<string, unknown>;
  const parsed = datasetDataSchema.safeParse(data);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path.length ? String(first.path[0]) : "dataset";
    return { ok: false, error: { field, message: first?.message ?? "invalid dataset declaration" } };
  }
  return {
    ok: true,
    value: {
      description: parsed.data.description,
      ...(parsed.data.fields ? { fields: parsed.data.fields } : {}),
      rows: rows as () => Row[] | Promise<Row[]>,
    } as DatasetDeclaration,
  };
}
