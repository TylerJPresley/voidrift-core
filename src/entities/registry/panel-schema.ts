/**
 * The panel declaration standard (core-blueprint.md §12.6, panels-blueprint §2, §3).
 *
 * The core is the configuration facilitator for panels: it defines the ONE
 * standard shape of a panel declaration and validates it when a plugin or client
 * registers through `register.panel` (§2.2). A declaration is pure,
 * JSON-serializable data — a title, optional columns, the registered DATASET(S)
 * its rows come from (§12.7), optional per-column formats, tab pages, a detail
 * view, and keyed hotkey actions each naming one dotted CoreAPI operation. The
 * core never renders a panel, binds its data, or calls the operations a
 * declaration names; a client owns the UI and its own bound view-model (panels §5).
 *
 * Zod is the single source of truth for the shape (AGENTS.md). The schema below
 * is the one definition the facade and the scoped CoreAPI both validate against.
 */
import { z } from "zod";

/** The fixed display renderings a column may select (§12.6). */
export const PANEL_FORMATS = ["text", "relative-time", "bytes", "count"] as const;
export type PanelFormat = (typeof PANEL_FORMATS)[number];

/** A single column in a panel (§12.6). */
export interface PanelColumn {
  /** Property name on the row object (may be a dotted path into the row). */
  key: string;
  /** Column header text. */
  label: string;
  /** Fixed character width; the renderer truncates to it (optional). */
  width?: number;
  /** Display rendering of the cell value; default "text" (§12.6). */
  format?: PanelFormat;
}

/** A keyed action a panel offers, shown as a single-char hotkey in the footer (§12.6). */
export interface PanelAction {
  label: string;
  /** The one dotted CoreAPI operation this action runs (§12.6). */
  op: string;
  /** When set, the client asks y/n before running; a string is the prompt (§12.6). */
  confirm?: string | true;
}

/** A tab page: its own data source, columns, and actions while active (§12.6). */
export interface PanelPage {
  /** Stable page id, unique within the declaration. */
  key: string;
  /** Tab label. */
  label: string;
  /** Rows for this page (dataset name(s)); falls back to the panel source when absent. */
  source?: string | string[];
  /** Replaces the panel columns while this page is active. */
  columns?: PanelColumn[];
  /** Replaces the panel actions while this page is active. */
  actions?: Record<string, PanelAction>;
}

/** A per-row detail view the client builds from the selected row alone (§12.6). */
export interface PanelDetail {
  /** Detail header; falls back to the panel title. */
  title?: string;
}

/**
 * A declarative panel: pure, JSON-serializable data (§12.6). `source` names the
 * registered DATASET(S) a client reads rows from (never a dotted op path, §12.7):
 * one dataset slug, or an ordered list of slugs for a composed panel. `columns`
 * is optional (a client defaults them from the dataset's `fields`). Actions are
 * keyed by single-character hotkeys. Row data, resolved handlers, and selection
 * are the client's own bound view-model, never part of the declaration (panels §2, §5).
 */
export interface PanelDeclaration {
  title: string;
  /** One line shown under the title (optional). */
  description?: string;
  /** Optional when the source dataset declares fields (§12.6). */
  columns?: PanelColumn[];
  source: string | string[];
  /** Tab pages; each slices rows from its own source or the panel source. */
  pages?: PanelPage[];
  /** When present, a row is selectable and Enter opens a detail view of it. */
  detail?: PanelDetail;
  actions?: Record<string, PanelAction>;
}

/** Bounds that keep a declaration small and renderable (§12.6, panels §3). */
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 200;
const DETAIL_TITLE_MAX = 120;
const CONFIRM_MAX = 200;
const OP_MAX = 120;
const SLUG_MAX = 64;
const SOURCE_MAX = 16; // composed panels name a few datasets, never an unbounded list.
const ACTIONS_MAX = 26; // single-character hotkeys — a bounded alphabet.
const PAGES_MAX = 16;

/**
 * A dataset slug: a lowercase slug `[a-z0-9-]+` (§12.7), NO dots — a `source`
 * names a registered dataset, never a dotted CoreAPI op path (§12.6). The core
 * does not check the dataset EXISTS at registration (a render-time condition).
 */
const datasetSlug = z
  .string()
  .min(1)
  .max(SLUG_MAX)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be a dataset name (a lowercase slug, no dots)");

/** One dataset slug, or a non-empty bounded ordered list of them (§12.6). */
const sourceSchema = z.union([datasetSlug, z.array(datasetSlug).min(1).max(SOURCE_MAX)]);

/**
 * A dotted CoreAPI operation path an action `op` runs: one or more dot-separated
 * identifier segments, bounded in length (§12.6). Non-identifier or empty
 * strings are rejected.
 */
const dottedOp = z
  .string()
  .min(1)
  .max(OP_MAX)
  .regex(/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/, "must be a CoreAPI operation path");

const panelColumnSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    width: z.number().int().positive().optional(),
    format: z.enum(PANEL_FORMATS).optional(),
  })
  .strict();

const panelActionSchema = z
  .object({
    label: z.string().min(1),
    op: dottedOp,
    // `confirm` is `true` or a non-empty bounded prompt string (§12.6).
    confirm: z.union([z.literal(true), z.string().min(1).max(CONFIRM_MAX)]).optional(),
  })
  .strict();

/** A non-empty array of columns with unique `key`s (§12.6). */
const columnsSchema = z
  .array(panelColumnSchema)
  .min(1)
  .superRefine((cols, ctx) => {
    const seen = new Set<string>();
    for (const c of cols) {
      if (seen.has(c.key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate column key "${c.key}"`, path: ["columns"] });
      }
      seen.add(c.key);
    }
  });

/** Actions keyed by single, unique characters, bounded in count (§12.6). */
const actionsSchema = z
  .record(z.string(), panelActionSchema)
  .superRefine((actions, ctx) => {
    if (!actions) return;
    const keys = Object.keys(actions);
    if (keys.length > ACTIONS_MAX) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `too many actions (max ${ACTIONS_MAX})`, path: ["actions"] });
    }
    for (const k of keys) {
      if ([...k].length !== 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `action hotkey "${k}" must be a single character`, path: ["actions"] });
      }
    }
  });

const panelPageSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    source: sourceSchema.optional(),
    columns: columnsSchema.optional(),
    actions: actionsSchema.optional(),
  })
  .strict();

const panelDetailSchema = z
  .object({
    title: z.string().min(1).max(DETAIL_TITLE_MAX).optional(),
  })
  .strict();

/**
 * The one Zod schema for a `PanelDeclaration` (§12.6, panels §3):
 * - `title` non-empty and length-bounded;
 * - `description`, when present, a non-empty single-line length-bounded string;
 * - `columns` OPTIONAL — when present, non-empty with unique `key`s and
 *   positive-integer widths (a client defaults them from the dataset's fields);
 * - `source` a dataset slug or a bounded ordered list of slugs (NOT a dotted op);
 * - `pages`, when present, a bounded non-empty array with unique `key`s, each
 *   with a non-empty label and its per-page `source`/`columns`/`actions`;
 * - `detail`, when present, an object whose optional `title` is a bounded string;
 * - `actions` keyed by single, unique characters, each a non-empty label, a
 *   dotted bounded `op`, and an optional `confirm` (true | non-empty string);
 * - hotkey uniqueness per EFFECTIVE action set (a page replaces panel actions);
 * - `.strict()` throughout so an unknown (non-serializable) member is rejected.
 *
 * A JSON round-trip equality check (below) rejects any function/symbol member
 * the structural schema cannot see.
 */
export const panelDeclarationSchema = z
  .object({
    title: z.string().min(1).max(TITLE_MAX),
    description: z
      .string()
      .min(1)
      .max(DESCRIPTION_MAX)
      .refine((s) => !/[\r\n]/.test(s), { message: "description must be a single line" })
      .optional(),
    columns: columnsSchema.optional(),
    source: sourceSchema,
    pages: z
      .array(panelPageSchema)
      .min(1)
      .max(PAGES_MAX)
      .optional()
      .superRefine((pages, ctx) => {
        if (!pages) return;
        const seen = new Set<string>();
        for (const p of pages) {
          if (seen.has(p.key)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate page key "${p.key}"`, path: ["pages"] });
          }
          seen.add(p.key);
        }
      }),
    detail: panelDetailSchema.optional(),
    actions: actionsSchema.optional(),
  })
  .strict();

/** The field a validation failure points at, for a typed registration error. */
export interface PanelValidationFailure {
  field: string;
  message: string;
}

/**
 * Validate a candidate declaration against the standard (§12.6). Returns the
 * typed declaration on success, or a `PanelValidationFailure` naming the
 * offending field. A non-serializable member (a function, a symbol, a value that
 * does not survive a JSON round-trip) is rejected even where the structural
 * schema cannot see it: the parsed value must be deep-equal to its own
 * JSON round-trip of the ORIGINAL input.
 */
export function validatePanelDeclaration(
  candidate: unknown,
): { ok: true; value: PanelDeclaration } | { ok: false; error: PanelValidationFailure } {
  const parsed = panelDeclarationSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path.length ? String(first.path[0]) : "panel";
    return { ok: false, error: { field, message: first?.message ?? "invalid panel declaration" } };
  }
  // JSON round-trip equality: the input must carry no member that a JSON
  // serialization would drop or change (a function, a symbol, undefined). The
  // schema already rejects unknown keys via `.strict()`; this catches a function
  // supplied where a serializable value is expected but structurally typed as a
  // record (defensive, §12.6 "reject functions ... including via JSON round-trip").
  let roundTripped: unknown;
  try {
    roundTripped = JSON.parse(JSON.stringify(candidate));
  } catch {
    return { ok: false, error: { field: "panel", message: "declaration is not JSON-serializable" } };
  }
  if (!deepEqual(candidate, roundTripped)) {
    return { ok: false, error: { field: "panel", message: "declaration carries a non-serializable member" } };
  }
  return { ok: true, value: parsed.data as PanelDeclaration };
}

/** Structural deep equality for JSON-shaped values (no functions, no cycles). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  // A primitive that is not strictly equal (e.g. a function vs its dropped
  // round-trip, or NaN) is unequal.
  return false;
}
