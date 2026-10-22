/**
 * The `researcher_save_notes` built-in tool (core-blueprint.md §8.6, Slice D3).
 *
 * The ONE write a research-role agent may do: it writes UTF-8 Markdown ONLY into
 * one of the directories listed in the LIVE resolved `findingsDirectories`
 * config, under the REAL workspace root of the session (never a worker's
 * throwaway worktree — research notes must land in the user's tree). The
 * `researcher_` prefix tells the user the tool belongs to the research role.
 *
 * It is confined four ways, each refused BEFORE any write:
 *  1. lexical: `path` must be workspace-relative, end in `.md`, carry no NUL, no
 *     backslash, no drive letter, no absolute prefix, and no `..` segment;
 *  2. membership: after lexical normalization the path must sit inside one of
 *     the configured findings directories (also normalized);
 *  3. protected-location: neither the matched findings directory nor the final
 *     target may be, be inside, or contain (be an ancestor of) a protected
 *     location (`.git`, `.github`, `.kiro`, `.voidrift/agents`, the control
 *     files, …), and the target basename may not be an agent/skill control file
 *     (`AGENTS.md`, `SKILL.md`, `prompt.md`, …) — so a project `findingsDirectories`
 *     of `["."]` or `[".voidrift/agents"]` cannot aim the one write at the
 *     harness's own control surface (`notesPathRefusal`, pure, no I/O);
 *  4. real-path: the FileSystemPort containment chokepoint (`writeFileAtomic`)
 *     resolves symlinks on the deepest existing ancestor and rejects anything
 *     that leaves the workspace root — so an in-workspace symlink pointing
 *     outside is refused. This module does NO lstat of its own: symlink safety
 *     comes entirely from that chokepoint (a symlinked findings dir or a
 *     symlinked target file that resolves outside the root fails there).
 *
 * `create` (the default) fails if the file already exists — the tool can NEVER
 * overwrite or truncate. `append` extends an existing file or creates it. Each
 * call is capped at 256 KB of content; a file after append is capped at 5 MB.
 * Writes reuse the SAME modes and atomicity `write_file`'s durable write uses
 * (0600 files, 0700 dirs, temp-then-rename) via `FileSystemPort.writeFileAtomic`.
 *
 * The model's research text is NOT altered (it is the model's own content), but
 * the tool result and events never echo the content — only `{ path, bytes, mode }`.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { FileSystemPort } from "../entities/ports/host.js";
import { limitDefault } from "../entities/limits.js";
import type { LimitsPort } from "../entities/ports/limits-port.js";

/** The §8.6 argument schema — the single source for binding and validation.
 * `strict()` rejects any extra field. `mode` defaults to `create`. */
export const RESEARCHER_SAVE_NOTES_SCHEMA = z
  .object({
    path: z.string(),
    content: z.string(),
    mode: z.enum(["create", "append"]).optional(),
  })
  .strict();

/** The config key whose value confines every write; named in the empty-list
 * error so the user knows exactly what to set. */
export const FINDINGS_DIRECTORIES_KEY = "findingsDirectories";

/** 256 KB per call (§8.6, §13.11 `tools.notesContentMaxBytes`); 5 MB per file
 * after append (§8.6 — no separate registry key). The content cap's effective
 * value is read from the limits port at use; this export is the registry
 * default. */
export const MAX_NOTES_CONTENT_BYTES = limitDefault("tools.notesContentMaxBytes");
export const MAX_NOTES_FILE_BYTES = limitDefault("tools.notesFileMaxBytes");

/** Normalize a workspace-relative directory/path to forward-slash segments with
 * no trailing slash, collapsing `./` and `//`. The input is already proven free
 * of `..`, backslashes, and absolute/drive prefixes by `validateNotesPath`. */
function normalizeRel(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    out.push(seg);
  }
  return out.join("/");
}

/** Normalize a findings DIRECTORY from config. Unlike the target `path` arg,
 * a findings dir is not lexically pre-checked, so this also collapses `..` —
 * `a/..` and `.` both resolve to the workspace root (""), which the protected
 * guard then refuses. A `..` that climbs above the root is clamped to "". */
function normalizeFindingsDir(p: string): string {
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/** True when `rel` is inside (or equal to) the normalized directory `dir`. */
function relInsideDir(rel: string, dir: string): boolean {
  if (dir === "") return true; // a findings dir of "." / "" is the whole workspace
  return rel === dir || rel.startsWith(dir + "/");
}

/**
 * The protected locations `researcher_save_notes` must never target, contain,
 * or sit inside — the harness's own control surface (§8.4, §9.4, §13.5) plus
 * the version-control, CI, editor, and agent-steering trees a prompt-injection
 * through the one research write could poison. The SINGLE source of truth for
 * the notes tool's list (the Guardian's `isProtectedControlFile` covers a
 * narrower `write_file`/`edit_file` set and is deliberately NOT widened here, so
 * existing write_file behaviour is unchanged). All comparisons are
 * case-insensitive on lower-cased segments.
 *
 * Each entry is a normalized, lower-cased relative path. A `*` suffix marks a
 * prefix family: `.voidrift/checkpoint.db*` matches `checkpoint.db`,
 * `checkpoint.db-wal`, etc.
 */
export const NOTES_PROTECTED_LOCATIONS = [
  ".git",
  ".github",
  ".husky",
  ".vscode",
  ".kiro",
  ".claude",
  "node_modules",
  ".voidrift/agents",
  ".voidrift/skills",
  ".voidrift/plugins",
  ".voidrift/config.json",
  ".voidrift/managed.json",
  ".voidrift/mcp-pins.json",
  ".voidrift/sessions",
  ".voidrift/logs",
  ".voidrift/checkpoint.db*",
] as const;

/**
 * Target basenames (case-insensitive) a note may never use — the agent/skill
 * steering and model-context control files a `.md`-only write could still land
 * on. `.md` (a dot-only basename) and the empty stem are refused too.
 */
const NOTES_PROTECTED_BASENAMES = new Set([
  "agents.md",
  "claude.md",
  "gemini.md",
  "skill.md",
  "prompt.md",
  ".md",
]);

/** Lower-case the slash-separated segments of an already-normalized rel path. */
function lowerSegments(normRel: string): string[] {
  return normRel === "" ? [] : normRel.toLowerCase().split("/");
}

/** True when path `a`'s segments are a prefix of (or equal to) path `b`'s
 * segments — i.e. `a` is `b` or an ancestor of `b`. Both are segment arrays. */
function segmentsCover(a: string[], b: string[]): boolean {
  if (a.length > b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Pure protected-location guard applied on EVERY call to BOTH the matched
 * findings directory and the final normalized target path. Returns a clear
 * refusal string naming the rule, or `null` when the path is clear.
 *
 * `relPath` is the normalized workspace-relative candidate (a findings dir or a
 * target); `kind` tailors the message. Refuses when the candidate IS, is INSIDE,
 * or CONTAINS (is an ancestor of) any `NOTES_PROTECTED_LOCATIONS` entry — so
 * `.` and `.voidrift` are refused as findings dirs (they contain protected
 * trees) while `.voidrift/research`, `docs`, `notes` are fine. For a target it
 * also refuses a protected basename (`AGENTS.md`, `prompt.md`, …). No I/O.
 */
export function notesPathRefusal(relPath: string, kind: "findings-dir" | "target"): string | null {
  const segs = lowerSegments(relPath);

  // The workspace root itself (`.`, `./`, `.//`, `a/..` — all normalize to "")
  // contains every protected location, so it is never a valid findings dir.
  if (kind === "findings-dir" && segs.length === 0) {
    return `findingsDirectories entry "${relPath || "."}" is refused because it contains protected location ${NOTES_PROTECTED_LOCATIONS[0]}; choose a dedicated notes folder such as .voidrift/research`;
  }

  for (const rawLoc of NOTES_PROTECTED_LOCATIONS) {
    const prefix = rawLoc.endsWith("*");
    const loc = prefix ? rawLoc.slice(0, -1) : rawLoc;
    const locSegs = loc.split("/");
    if (prefix) {
      // A prefix family (e.g. `.voidrift/checkpoint.db*`): the candidate hits it
      // when all but the last protected segment match and the candidate's
      // segment at that depth STARTS WITH the last protected stem — this covers
      // the file itself, its siblings (`…-wal`), and any descendant.
      const head = locSegs.slice(0, -1);
      const stem = locSegs[locSegs.length - 1]!;
      if (segmentsCover(head, segs) && segs.length > head.length && segs[head.length]!.startsWith(stem)) {
        return refusalMessage(relPath, rawLoc, kind, "contains/is");
      }
      continue;
    }
    // candidate is inside (or equal to) the protected location
    if (segmentsCover(locSegs, segs)) return refusalMessage(relPath, loc, kind, "is inside");
    // candidate is an ancestor of the protected location (it CONTAINS it)
    if (segs.length > 0 && segmentsCover(segs, locSegs)) return refusalMessage(relPath, loc, kind, "contains");
  }

  if (kind === "target") {
    const base = segs.length ? segs[segs.length - 1]! : "";
    if (NOTES_PROTECTED_BASENAMES.has(base)) {
      return `researcher_save_notes refuses ${relPath}: "${base}" is a protected control-file name`;
    }
  }
  return null;
}

/** Build the refusal message for a protected-location hit, naming the rule. */
function refusalMessage(
  relPath: string,
  loc: string,
  kind: "findings-dir" | "target",
  relation: "is inside" | "contains" | "contains/is",
): string {
  if (kind === "findings-dir") {
    const verb = relation === "is inside" ? "is inside" : relation === "contains" ? "contains" : "contains/is";
    return `findingsDirectories entry "${relPath}" is refused because it ${verb} protected location ${loc}; choose a dedicated notes folder such as .voidrift/research`;
  }
  const verb = relation === "contains" ? "contains" : "is inside";
  return `researcher_save_notes refuses ${relPath}: it ${verb} the protected location ${loc}`;
}

/** The outcome of lexical+membership validation: an error message, or the
 * normalized relative path safe to hand the FileSystemPort. */
export type NotesPathCheck = { error: string } | { rel: string };

/**
 * Validate `path` lexically and prove it lands inside one of the configured
 * findings directories (§8.6). Pure — no I/O; the FileSystemPort's realpath
 * containment is the final (symlink-safe) gate, applied by the caller.
 */
export function validateNotesPath(path: string, findingsDirectories: string[]): NotesPathCheck {
  if (findingsDirectories.length === 0) {
    return { error: `Error: ${FINDINGS_DIRECTORIES_KEY} is empty — set it in config to a notes folder (e.g. ".voidrift/research/") before saving a note.` };
  }
  if (path.includes("\0")) return { error: "Error: invalid 'path': contains NUL" };
  if (path.includes("\\")) return { error: "Error: invalid 'path': backslashes are not allowed (use '/')" };
  if (/^[A-Za-z]:/.test(path)) return { error: "Error: invalid 'path': drive letters are not allowed" };
  if (path.startsWith("/")) return { error: "Error: invalid 'path': must be relative to the workspace root" };
  if (path.split("/").some((seg) => seg === "..")) return { error: "Error: invalid 'path': '..' segments are not allowed" };
  if (!path.toLowerCase().endsWith(".md")) return { error: "Error: invalid 'path': a note must be a Markdown file ('.md')" };
  const rel = normalizeRel(path);
  if (rel === "" || rel.endsWith("/")) return { error: "Error: invalid 'path': names a directory, not a '.md' file" };
  const dirs = findingsDirectories.map(normalizeFindingsDir);
  // Find the findings directory the target lands in (the matched entry).
  const matchIndex = dirs.findIndex((d) => relInsideDir(rel, d));
  if (matchIndex === -1) {
    // LEAD with the allowed directories (§8.6): a width-truncated TUI line must
    // still carry them — the key info, not trailing prose.
    return { error: `Error: save the note inside a configured findings directory (${FINDINGS_DIRECTORIES_KEY}: ${findingsDirectories.join(", ")}) — '${path}' is outside it.` };
  }
  // Protected-location guard (§8.4/§9.4), applied to the MATCHED findings dir and
  // the final target — refuse a project `findingsDirectories` that points at the
  // harness's own control surface, and refuse a target on a protected location
  // or control-file basename. The findings-dir message names the raw entry.
  const dirRefusal = notesPathRefusal(dirs[matchIndex]!, "findings-dir");
  if (dirRefusal) return { error: `Error: ${dirRefusal}` };
  const targetRefusal = notesPathRefusal(rel, "target");
  if (targetRefusal) return { error: `Error: ${targetRefusal}` };
  return { rel };
}

/** UTF-8 byte length without materializing a Buffer copy per call site. */
function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** The deps the tool builder reads (§8.6). */
export interface NotesToolDeps {
  /**
   * A `FileSystemPort` rooted at the REAL session workspace root (NOT a worker
   * worktree): the SAME containment chokepoint `write_file`'s durable write uses
   * (realpath-on-ancestor symlink safety, `PATH_ESCAPE` on escape) and the SAME
   * atomic `writeFileAtomic` (temp-then-rename, mode 0600 files / 0700 dirs).
   */
  fs: FileSystemPort;
  /** The LIVE resolved `findingsDirectories` — read on EVERY call so a project's
   * added directory works the moment it is configured (§8.6, §13.8). */
  getFindingsDirectories: () => string[];
  /** §13.11 — the limits port; the per-call content cap comes from
   * `tools.notesContentMaxBytes` and an over-size refusal emits `LIMIT_HIT`.
   * Omitted → the registry default. */
  limits?: LimitsPort;
}

/**
 * Build the `researcher_save_notes` tool. The result/content is NEVER echoed;
 * success returns `{ path, bytes, mode }` only. A failure returns an `Error: …`
 * string (surfaced as a tool error line, like the other built-ins).
 */
export function buildResearchNotesTool(deps: NotesToolDeps): StructuredToolInterface {
  // Per-path serialization (§8.6): a `create`/`append` is a read-modify-write, so
  // two concurrent appends to the SAME file could interleave and corrupt it even
  // though each `writeFileAtomic` is atomic. We chain writes per normalized path
  // through a promise so same-file operations run strictly one after another;
  // different files still run concurrently. The chain entry is dropped once the
  // queue drains so the map does not grow unbounded.
  const locks = new Map<string, Promise<void>>();
  const withLock = async <T,>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prior = locks.get(key) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    // Chain a settled marker so the next caller waits for us regardless of outcome.
    const marker = run.then(
      () => undefined,
      () => undefined,
    );
    locks.set(key, marker);
    try {
      return await run;
    } finally {
      // Drop the key only when we are the tail of the chain (no later write queued).
      if (locks.get(key) === marker) locks.delete(key);
    }
  };

  const write = async ({ path, content, mode }: { path: string; content: string; mode?: "create" | "append" }): Promise<string> => {
    const effectiveMode = mode ?? "create";
    const check = validateNotesPath(path, deps.getFindingsDirectories());
    if ("error" in check) return check.error;
    const rel = check.rel;

    const contentBytes = byteLength(content);
    const contentCap = deps.limits?.get("tools.notesContentMaxBytes") ?? MAX_NOTES_CONTENT_BYTES;
    const fileCap = deps.limits?.get("tools.notesFileMaxBytes") ?? MAX_NOTES_FILE_BYTES;
    if (contentBytes > contentCap) {
      deps.limits?.hit("tools.notesContentMaxBytes", contentBytes, { what: "research note content too large" });
      return `Error: content too large (${contentBytes} bytes; max ${contentCap})`;
    }

    // Serialize the read-modify-write per target so concurrent appends to the
    // same file never interleave (different files still run concurrently).
    return withLock(rel, async () => {
      try {
        const exists = await deps.fs.exists(rel);
        if (effectiveMode === "create") {
          if (exists) return `Error: ${rel} already exists — 'create' never overwrites; use mode 'append' to extend it, or choose a new name.`;
          if (contentBytes > fileCap) {
            deps.limits?.hit("tools.notesFileMaxBytes", contentBytes, { what: "research note file too large" });
            return `Error: file too large after write (${contentBytes} bytes; max ${fileCap})`;
          }
          await deps.fs.writeFileAtomic(rel, content, { mode: 0o600 });
          return JSON.stringify({ path: rel, bytes: contentBytes, mode: "create" });
        }
        // append: read existing (if any), concatenate, cap the TOTAL, atomic write.
        const prior = exists ? await deps.fs.readFile(rel) : "";
        const next = prior + content;
        const nextBytes = byteLength(next);
        if (nextBytes > fileCap) {
          deps.limits?.hit("tools.notesFileMaxBytes", nextBytes, { what: "research note file too large" });
          return `Error: file too large after append (${nextBytes} bytes; max ${fileCap})`;
        }
        await deps.fs.writeFileAtomic(rel, next, { mode: 0o600 });
        return JSON.stringify({ path: rel, bytes: contentBytes, mode: "append" });
      } catch (e) {
        // A PATH_ESCAPE (symlink leaving the root) or any FS error: refuse, naming
        // no content. The containment chokepoint is the final symlink-safe gate.
        const msg = e instanceof Error ? e.message : String(e);
        return `Error: ${msg}`;
      }
    });
  };

  const dirsHint = (() => {
    try {
      const dirs = deps.getFindingsDirectories();
      return dirs.length ? dirs.join(", ") : `(none configured — set ${FINDINGS_DIRECTORIES_KEY})`;
    } catch {
      return `(set ${FINDINGS_DIRECTORIES_KEY})`;
    }
  })();

  return tool(write, {
    name: "researcher_save_notes",
    description:
      "Save research notes as a Markdown file. The `path` is WORKSPACE-RELATIVE and must sit INSIDE a configured findings directory " +
      `(${FINDINGS_DIRECTORIES_KEY}: ${dirsHint}) — e.g. '.voidrift/research/q1.md', NOT 'research/q1.md' or a bare 'q1.md'. ` +
      "It must end in .md. mode 'create' (default) writes a NEW file and FAILS if it already exists; mode 'append' extends an existing file or creates it. " +
      "Use one note per question: 'create' the first time, then 'append', or pick a new name.",
    schema: RESEARCHER_SAVE_NOTES_SCHEMA,
  }) as StructuredToolInterface;
}
