/**
 * Minimal, dependency-free `.gitignore` matching (retrieval-blueprint §3, §5).
 *
 * The workspace surface (use-cases/workspace-surface.ts) honours ignore rules so
 * retrieval never surfaces an ignored file (a stated invariant, FX-B). Inside a
 * git repo the hardened git runner is authoritative (`git ls-files`); OUTSIDE a
 * repo there is no git to ask, so this implements the gitignore spec directly
 * over the workspace's `.gitignore` files. No existing dependency provides
 * gitignore matching (the glob tools use a hand-rolled matcher), and the owner's
 * licence policy forbids pulling in a copyleft one, so the standard semantics are
 * implemented and tested here:
 *
 *   - comments (`#...`) and blank lines are ignored; a leading `\#`/`\!` is literal;
 *   - `!pat` negates a previous match (re-includes);
 *   - a trailing `/` matches directories only;
 *   - a `/` anywhere but the end anchors the pattern to the `.gitignore`'s dir;
 *     a pattern with no internal `/` matches at any depth (basename match);
 *   - `*` matches within a path segment, `?` a single non-`/` char, a double
 *     star spans segments (as in a-slash-star-star-slash-b, or a leading or
 *     trailing double-star);
 *   - `[...]` character classes (with `!`/`^` negation and ranges);
 *   - trailing spaces are stripped unless escaped (`\ `).
 *
 * A `.gitignore` deeper in the tree applies to its own subtree and overrides the
 * shallower file for paths beneath it, matched in root->leaf order so the nearest
 * file and later patterns win — exactly git's precedence.
 */

/** One parsed pattern from a `.gitignore` file. */
interface IgnoreRule {
  /** Matches the path EXACTLY (the pattern body, no trailing `/...`). */
  reExact: RegExp;
  /** Matches a path strictly BENEATH the matched body (a `/...` tail). */
  reUnder: RegExp;
  /** True when the rule re-includes (a leading `!`). */
  negate: boolean;
  /** True when the rule matches directories only (a trailing `/`). */
  dirOnly: boolean;
}

/** A compiled `.gitignore` rooted at a directory (relative to the workspace). */
export interface CompiledIgnoreFile {
  /** The `.gitignore`'s directory, workspace-relative POSIX, "" at the root. */
  baseDir: string;
  rules: IgnoreRule[];
}

/** Strip a trailing-space run that is not escaped with a backslash. */
function stripTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " ") {
    // An escaped space (`\ `) is literal: stop stripping before it.
    if (end >= 2 && line[end - 2] === "\\") break;
    end--;
  }
  return line.slice(0, end);
}

/** Translate a gitignore glob segment (already split on `/`) to a regex body. */
function segmentToRegex(seg: string): string {
  let out = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (c === "\\" && i + 1 < seg.length) {
      // An escaped character is literal (e.g. `\ ` -> a literal space).
      const next = seg[i + 1]!;
      out += /[.+*?^${}()|[\]\\]/.test(next) ? "\\" + next : next;
      i++;
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      // Character class: copy to the closing ']', translating a leading !/^.
      let j = i + 1;
      let cls = "";
      let neg = false;
      if (seg[j] === "!" || seg[j] === "^") {
        neg = true;
        j++;
      }
      // A ']' as the first class char is literal.
      if (seg[j] === "]") {
        cls += "\\]";
        j++;
      }
      while (j < seg.length && seg[j] !== "]") {
        const cc = seg[j]!;
        cls += /[\\^\]]/.test(cc) ? "\\" + cc : cc;
        j++;
      }
      if (j < seg.length) {
        out += "[" + (neg ? "^" : "") + cls + "]";
        i = j;
      } else {
        // No closing ']': treat '[' literally.
        out += "\\[";
      }
    } else if (/[.+^${}()|\\]/.test(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return out;
}

/** Compile one gitignore pattern into a path-matching regex. */
function compilePattern(raw: string): IgnoreRule | null {
  let pat = raw;
  let negate = false;
  if (pat.startsWith("!")) {
    negate = true;
    pat = pat.slice(1);
  } else if (pat.startsWith("\\#") || pat.startsWith("\\!")) {
    pat = pat.slice(1); // an escaped leading # or ! is literal
  }
  let dirOnly = false;
  if (pat.endsWith("/")) {
    dirOnly = true;
    pat = pat.slice(0, -1);
  }
  if (pat === "") return null;

  // A leading '/' anchors to the base dir; a '/' anywhere but the end also
  // anchors (git: a slash other than trailing makes the pattern rooted).
  const anchored = pat.startsWith("/") || pat.slice(0, -1).includes("/");
  if (pat.startsWith("/")) pat = pat.slice(1);

  const segs = pat.split("/");
  const parts: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (seg === "**") {
      // `**` spans zero or more segments.
      if (i === segs.length - 1) parts.push("(?:.*)?"); // trailing /**
      else parts.push("(?:[^/]+/)*"); // a/**/b or leading **/
    } else {
      parts.push(segmentToRegex(seg));
      if (i < segs.length - 1) parts.push("/");
    }
  }
  let body = parts.join("");
  // Collapse an accidental `(?:[^/]+/)*/` from a `**/x` join into the group.
  body = body.replace(/\(\?:\[\^\/\]\+\/\)\*\//g, "(?:[^/]+/)*");

  // Anchored -> match from the base; unanchored -> match at any depth (basename
  // match or deeper), i.e. allow a leading `(.../)?`.
  const prefix = anchored ? "^" : "^(?:.*/)?";
  // Two forms: an EXACT match of the body (the path IS the matched entry) and a
  // match of anything strictly BENEATH it (a `/...` tail) so a matched directory
  // excludes everything under it. A directory-only rule uses only the latter for
  // files and the exact form for directories (handled in isIgnored).
  const reExact = new RegExp(prefix + body + "$");
  const reUnder = new RegExp(prefix + body + "/.*$");
  return { reExact, reUnder, negate, dirOnly };
}

/** Compile a `.gitignore` file's text (rooted at `baseDir`). */
export function compileIgnoreFile(baseDir: string, text: string): CompiledIgnoreFile {
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split("\n")) {
    let line = rawLine.replace(/\r$/, "");
    if (line.startsWith("#")) continue; // a comment (unescaped)
    line = stripTrailingSpaces(line);
    if (line.trim() === "") continue;
    const rule = compilePattern(line);
    if (rule) rules.push(rule);
  }
  return { baseDir, rules };
}

/**
 * Decide whether a workspace-relative POSIX path is ignored by the compiled set
 * (ordered root->leaf). `isDir` indicates the path is a directory (so a
 * directory-only rule applies). Later matches win (git precedence); the last
 * matching rule's polarity is the verdict.
 */
export function isIgnored(path: string, isDir: boolean, files: CompiledIgnoreFile[]): boolean {
  let ignored = false;
  for (const file of files) {
    // A file only governs paths within its own directory.
    const rel = relativeTo(file.baseDir, path);
    if (rel === null) continue;
    for (const rule of file.rules) {
      let matched: boolean;
      if (rule.dirOnly) {
        // A dir-only rule excludes a FILE only when it lies beneath the matched
        // directory; a directory it matches exactly is excluded too.
        matched = rule.reUnder.test(rel) || (isDir && rule.reExact.test(rel));
      } else {
        matched = rule.reExact.test(rel) || rule.reUnder.test(rel);
      }
      if (matched) ignored = !rule.negate;
    }
  }
  return ignored;
}

/** The path relative to `baseDir` (POSIX), or null when it is not beneath it. */
function relativeTo(baseDir: string, path: string): string | null {
  if (baseDir === "") return path;
  if (path === baseDir) return "";
  const prefix = baseDir.endsWith("/") ? baseDir : baseDir + "/";
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}
