/**
 * §8.2 `search_contents` — the real-regex content scan.
 *
 * `search_contents` matches a JavaScript regular expression against each line of
 * every regular file under a confined root, honouring a single-file `path`, a
 * filename glob, the backend's skipped directories, and the §8.2 walk bounds
 * (file size, directory depth). The scan runs inside a Node worker thread so a
 * catastrophically-backtracking pattern (`(a+)+$` on a long line) can be
 * TERMINATED when the wall-clock bound fires — the caller then takes the
 * existing filename fallback (builtin.ts). The worker is created from an inline
 * module (`eval: true`) so there is no separate worker file to resolve, and the
 * behaviour is byte-identical whether the core runs from `src` (vitest) or
 * `dist` (built): no new dependency, no build step, pure Node.
 *
 * Confinement is the caller's (`confineRoot`, builtin.ts): this module receives
 * an already-confined workspace-relative root and never resolves above it. It
 * does not follow directory symlinks, so a symlink cannot walk the scan out of
 * the workspace.
 */
import { Worker } from "node:worker_threads";

/** One matching line, formatted by the caller as `path:line:text`. */
export interface ContentMatch {
  /** Workspace-relative file path. */
  path: string;
  /** 1-indexed line number. */
  line: number;
  /** The matching line text. */
  text: string;
}

/** The outcome the worker reports (or the caller synthesises on timeout). */
export type SearchOutcome =
  | { kind: "ok"; matches: ContentMatch[]; capped: boolean; regexError: string | null }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

/** The directories the scan never descends into (the backend's own skip set). */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".cache",
  ".turbo",
  ".svn",
  ".hg",
]);

/** §8.2 walk bounds: a file larger than this is skipped (not read into memory). */
export const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB
/** §8.2 walk bounds: directories deeper than this are not descended. */
export const MAX_WALK_DEPTH = 32;
/** §8.2 — the 100-line match cap. */
export const MATCH_CAP = 100;

/** Parameters passed to the inline worker as its `workerData`. */
export interface SearchParams {
  /** Absolute filesystem root of the workspace (the backend's resolved cwd). */
  rootAbs: string;
  /** Already-confined workspace-relative root (a directory, or one file). */
  rootRel: string;
  /** The raw pattern (a JS regex, or literal text when it does not compile). */
  pattern: string;
  /** A filename glob (last include segment), or null for every file. */
  filenameGlob: string | null;
  /** The skip-dir set, the file-size cap, the depth cap, the match cap. */
  skipDirs: string[];
  maxFileBytes: number;
  maxDepth: number;
  matchCap: number;
}

/**
 * The inline worker module (run with `eval: true`). Self-contained: it reads
 * only `node:fs`, `node:path`, and `node:worker_threads`, compiles the regex
 * (falling back to a literal search with a named error), walks the confined
 * root WITHOUT following directory symlinks, and matches each line. A line it
 * is still matching when the caller terminates the worker is simply abandoned —
 * the process is never blocked because the catastrophic work is on this thread,
 * not the caller's. It posts exactly one {@link SearchOutcome} of kind `ok`.
 *
 * A leading `(?i)` is lifted to the `i` flag (JS has no inline-flag syntax).
 */
const WORKER_SOURCE = `
const fs = require("node:fs");
const path = require("node:path");
const { workerData, parentPort } = require("node:worker_threads");

const p = workerData;
const skip = new Set(p.skipDirs);

// Compile the pattern. A leading (?i) becomes the i flag; an invalid pattern
// falls back to a literal (escaped) search and reports the error text.
let re;
let regexError = null;
{
  let src = p.pattern;
  let flags = "";
  if (src.startsWith("(?i)")) { flags += "i"; src = src.slice(4); }
  try {
    re = new RegExp(src, flags);
  } catch (e) {
    regexError = e && e.message ? String(e.message) : String(e);
    const escaped = p.pattern.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
    re = new RegExp(escaped, flags);
  }
}

// A filename glob (no path separator): * matches within the name, ? one char.
function globToRegex(g) {
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^\${}()|[\\]\\\\]/g, "\\\\$&");
  }
  return new RegExp("^" + out + "$");
}
const nameRe = p.filenameGlob ? globToRegex(p.filenameGlob) : null;

const matches = [];
let capped = false;

function scanFile(abs, rel) {
  let content;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return;
    if (st.size > p.maxFileBytes) return;
    content = fs.readFileSync(abs, "utf8");
  } catch { return; }
  const lines = content.split(/\\r?\\n/);
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) {
      matches.push({ path: rel, line: i + 1, text: lines[i] });
      if (matches.length >= p.matchCap) { capped = true; return; }
    }
  }
}

function walk(absDir, relDir, depth) {
  if (capped) return;
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (capped) return;
    const abs = path.join(absDir, e.name);
    const rel = relDir === "." ? e.name : relDir + "/" + e.name;
    if (e.isDirectory()) {
      if (skip.has(e.name)) continue;
      if (depth + 1 > p.maxDepth) continue;
      walk(abs, rel, depth + 1);
    } else if (e.isFile()) {
      if (nameRe && !nameRe.test(e.name)) continue;
      scanFile(abs, rel);
    }
    // Symlinks and other non-regular entries are skipped (not followed).
  }
}

const startAbs = path.join(p.rootAbs, p.rootRel === "." ? "" : p.rootRel);
let startStat;
try { startStat = fs.statSync(startAbs); } catch { startStat = null; }
if (startStat && startStat.isFile()) {
  // A single-file root: match that file only (filename glob still applies).
  const name = path.basename(startAbs);
  if (!nameRe || nameRe.test(name)) scanFile(startAbs, p.rootRel);
} else if (startStat && startStat.isDirectory()) {
  walk(startAbs, p.rootRel, 0);
}

parentPort.postMessage({ kind: "ok", matches, capped, regexError });
`;

/**
 * Run the content scan with a hard wall-clock bound. On timeout the worker is
 * terminated and `{ kind: "timeout" }` is returned so the caller can take the
 * filename fallback; the terminated worker's catastrophic loop dies with it.
 */
export async function searchContentsBounded(params: SearchParams, timeoutMs: number): Promise<SearchOutcome> {
  return await new Promise<SearchOutcome>((resolve) => {
    let settled = false;
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: params });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      resolve({ kind: "timeout" });
    }, timeoutMs);
    worker.on("message", (msg: SearchOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(msg);
    });
    worker.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve({ kind: "error", message: err.message });
    });
    worker.on("exit", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ kind: "error", message: "search worker exited without a result" });
    });
  });
}
